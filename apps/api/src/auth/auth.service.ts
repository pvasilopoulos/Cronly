import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import { hashPassword, verifyPassword } from './password';
import { JwtPayload } from './jwt.strategy';
import { opaqueToken, sha256 } from './tokens';
import {
  generateBackupCodes,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp';

export interface AuthContext {
  userAgent?: string;
  ip?: string;
}

type UserWithTenants = {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  status: string;
  passwordHash: string;
  totpEnabled: boolean;
  totpSecret: string | null;
  totpPendingSecret: string | null;
  backupCodes: string[];
  memberships: { tenant: { id: string; name: string; slug: string; plan: string } }[];
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Login ─────────────────────────

  async login(email: string, password: string, ctx: AuthContext = {}) {
    const user = await this.loadUser({ email: email.toLowerCase() });
    if (!user || user.status === 'DISABLED' || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Password is correct. If the account has 2FA, do not issue tokens yet —
    // return a short-lived interim token that only /auth/login/mfa accepts.
    if (user.totpEnabled) {
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, mfa: true },
        { secret: env.jwt.accessSecret, expiresIn: env.jwt.mfaTtl },
      );
      return { mfaRequired: true as const, mfaToken };
    }

    await this.recordLogin(user);
    return this.issueSession(user, ctx);
  }

  /** Second factor: exchange the interim MFA token + a TOTP/backup code for a session. */
  async loginMfa(mfaToken: string, code: string, ctx: AuthContext = {}) {
    let sub: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; mfa?: boolean }>(mfaToken, {
        secret: env.jwt.accessSecret,
      });
      if (!payload.mfa) throw new Error('not an mfa token');
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA session');
    }

    const user = await this.loadUser({ id: sub });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException('Invalid MFA session');
    }

    const ok = verifyTotp(user.totpSecret, code) || (await this.consumeBackupCode(user, code));
    if (!ok) throw new UnauthorizedException('Invalid authentication code');

    await this.recordLogin(user);
    return this.issueSession(user, ctx);
  }

  // ───────────────────── Refresh rotation ─────────────────────

  /**
   * Rotate a refresh token: the presented token is revoked and a fresh one
   * issued in the same family. Replaying an already-revoked token is treated as
   * theft — the whole family is revoked so neither the attacker nor the victim
   * can continue, forcing a fresh login.
   */
  async refresh(refreshToken: string, ctx: AuthContext = {}) {
    const tokenHash = sha256(refreshToken);
    const existing = await this.prisma.asSuperAdmin((tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash } }),
    );
    if (!existing) throw new UnauthorizedException('Invalid refresh token');

    if (existing.revokedAt) {
      // Reuse of a rotated/revoked token → kill the session family.
      await this.prisma.asSuperAdmin((tx) =>
        tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      await this.auditAllTenants(existing.userId, 'auth.refresh.reuse_detected', {
        familyId: existing.familyId,
      });
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.loadUser({ id: existing.userId });
    if (!user || user.status === 'DISABLED') throw new UnauthorizedException();

    // Issue the replacement in the same family, then revoke the old one.
    const next = await this.createRefreshToken(user.id, existing.familyId, ctx);
    await this.prisma.asSuperAdmin((tx) =>
      tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedById: next.id },
      }),
    );

    return { accessToken: await this.signAccess(user), refreshToken: next.raw };
  }

  // ───────────────────────── Logout ─────────────────────────

  /** Revoke the session family behind one refresh token (logout this device). */
  async logout(refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    const existing = await this.prisma.asSuperAdmin((tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash } }),
    );
    if (existing) {
      await this.prisma.asSuperAdmin((tx) =>
        tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
    }
    return { ok: true };
  }

  /** Revoke every active session for a user (logout everywhere). */
  async logoutAll(userId: string) {
    const res = await this.prisma.asSuperAdmin((tx) =>
      tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    await this.auditAllTenants(userId, 'auth.logout_all', { sessions: res.count });
    return { ok: true, revoked: res.count };
  }

  // ────────────────────── Password reset ──────────────────────

  /**
   * Begin a password reset. Always succeeds (never reveals whether an address is
   * registered). When the account exists, a single-use token is created and
   * delivered; with no mailer configured (dev) it is logged and returned.
   */
  async forgotPassword(email: string) {
    const user = await this.loadUser({ email: email.toLowerCase() });
    const generic = { ok: true as const };
    if (!user || user.status === 'DISABLED') return generic;

    const raw = opaqueToken('prt');
    await this.prisma.asSuperAdmin((tx) =>
      tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + env.resetTtlSec * 1000),
        },
      }),
    );

    const link = `${env.appUrl}/reset-password?token=${raw}`;
    // TODO: deliver via the configured mailer. Until then, log it in dev.
    console.log(`[auth] password reset for ${user.email}: ${link}`);

    return env.devExposeTokens ? { ...generic, devToken: raw, devLink: link } : generic;
  }

  /**
   * Complete a password reset: set the new password, consume the token, and
   * revoke every existing session so a leaked token cannot outlive the change.
   */
  async resetPassword(token: string, newPassword: string) {
    const row = await this.prisma.asSuperAdmin((tx) =>
      tx.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } }),
    );
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.prisma.asSuperAdmin(async (tx) => {
      await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash: hashPassword(newPassword), status: 'ACTIVE' },
      });
      await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      // Invalidate all other outstanding reset tokens + every refresh session.
      await tx.passwordResetToken.updateMany({
        where: { userId: row.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    await this.auditAllTenants(row.userId, 'user.password.reset', {});
    return { ok: true };
  }

  // ─────────────────────────── 2FA ───────────────────────────

  async twoFactorStatus(userId: string) {
    const user = await this.loadUser({ id: userId });
    if (!user) throw new UnauthorizedException();
    return { enabled: user.totpEnabled, pending: !!user.totpPendingSecret };
  }

  /** Start enrolment: store a pending secret and return the otpauth URI to scan. */
  async setupTwoFactor(userId: string) {
    const user = await this.loadUser({ id: userId });
    if (!user) throw new UnauthorizedException();
    if (user.totpEnabled) throw new BadRequestException('Two-factor is already enabled');

    const secret = generateTotpSecret();
    await this.prisma.asSuperAdmin((tx) =>
      tx.user.update({ where: { id: userId }, data: { totpPendingSecret: secret } }),
    );
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /** Confirm enrolment with a code; returns one-time backup codes (shown once). */
  async enableTwoFactor(userId: string, code: string) {
    const user = await this.loadUser({ id: userId });
    if (!user) throw new UnauthorizedException();
    if (user.totpEnabled) throw new BadRequestException('Two-factor is already enabled');
    if (!user.totpPendingSecret) throw new BadRequestException('Start setup first');
    if (!verifyTotp(user.totpPendingSecret, code)) {
      throw new BadRequestException('Invalid authentication code');
    }

    const backupCodes = generateBackupCodes();
    await this.prisma.asSuperAdmin((tx) =>
      tx.user.update({
        where: { id: userId },
        data: {
          totpEnabled: true,
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          backupCodes: backupCodes.map((c) => sha256(c)),
        },
      }),
    );
    await this.auditAllTenants(userId, 'user.mfa.enabled', {});
    return { ok: true, backupCodes };
  }

  /** Turn off 2FA after re-verifying with a current code (or a backup code). */
  async disableTwoFactor(userId: string, code: string) {
    const user = await this.loadUser({ id: userId });
    if (!user) throw new UnauthorizedException();
    if (!user.totpEnabled || !user.totpSecret) throw new BadRequestException('Two-factor is not enabled');

    const ok = verifyTotp(user.totpSecret, code) || (await this.consumeBackupCode(user, code));
    if (!ok) throw new BadRequestException('Invalid authentication code');

    await this.prisma.asSuperAdmin((tx) =>
      tx.user.update({
        where: { id: userId },
        data: { totpEnabled: false, totpSecret: null, totpPendingSecret: null, backupCodes: [] },
      }),
    );
    await this.auditAllTenants(userId, 'user.mfa.disabled', {});
    return { ok: true };
  }

  // ───────────────────────── Internals ─────────────────────────

  private async loadUser(where: { id: string } | { email: string }): Promise<UserWithTenants | null> {
    return this.prisma.asSuperAdmin((tx) =>
      tx.user.findUnique({
        where: where as any,
        select: {
          id: true,
          email: true,
          name: true,
          isSuperAdmin: true,
          status: true,
          passwordHash: true,
          totpEnabled: true,
          totpSecret: true,
          totpPendingSecret: true,
          backupCodes: true,
          memberships: {
            where: { status: 'ACTIVE' },
            select: { tenant: { select: { id: true, name: true, slug: true, plan: true } } },
          },
        },
      }),
    ) as Promise<UserWithTenants | null>;
  }

  private async signAccess(user: UserWithTenants): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, email: user.email, sa: user.isSuperAdmin } satisfies JwtPayload,
      { secret: env.jwt.accessSecret, expiresIn: env.jwt.accessTtl },
    );
  }

  private async createRefreshToken(userId: string, familyId: string, ctx: AuthContext) {
    const raw = opaqueToken('rt');
    const row = await this.prisma.asSuperAdmin((tx) =>
      tx.refreshToken.create({
        data: {
          userId,
          familyId,
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + env.jwt.refreshTtl * 1000),
          userAgent: ctx.userAgent?.slice(0, 300),
          ip: ctx.ip,
        },
      }),
    );
    return { id: row.id, raw };
  }

  /** Issue a brand-new session (new family) — used after a successful login. */
  private async issueSession(user: UserWithTenants, ctx: AuthContext) {
    const familyId = randomUUID();
    const refresh = await this.createRefreshToken(user.id, familyId, ctx);
    return {
      accessToken: await this.signAccess(user),
      refreshToken: refresh.raw,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSuperAdmin: user.isSuperAdmin,
      },
      // Super-admins can act in any workspace (their memberships first); regular
      // users see only the tenants they belong to.
      tenants: await this.tenantsFor(user),
    };
  }

  /** Membership tenants, plus every tenant when the user is a super-admin. */
  private async tenantsFor(user: UserWithTenants) {
    const memberTenants = user.memberships.map((m) => m.tenant);
    if (!user.isSuperAdmin) return memberTenants;
    const all = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findMany({
        select: { id: true, name: true, slug: true, plan: true },
        orderBy: { name: 'asc' },
      }),
    );
    const seen = new Set(memberTenants.map((t) => t.id));
    return [...memberTenants, ...all.filter((t) => !seen.has(t.id))];
  }

  /** Check a backup code, removing it (single use) if it matches. */
  private async consumeBackupCode(user: UserWithTenants, code: string): Promise<boolean> {
    const normalized = (code ?? '').trim().toLowerCase();
    if (!normalized) return false;
    const hash = sha256(normalized);
    if (!user.backupCodes.includes(hash)) return false;
    await this.prisma.asSuperAdmin((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { backupCodes: user.backupCodes.filter((c) => c !== hash) },
      }),
    );
    return true;
  }

  private async recordLogin(user: UserWithTenants) {
    for (const m of user.memberships) {
      void this.audit.record({
        tenantId: m.tenant.id,
        actorUserId: user.id,
        action: 'user.login',
        target: user.id,
        meta: { email: user.email },
      });
    }
  }

  /** Record a security event in every tenant the user belongs to. */
  private async auditAllTenants(userId: string, action: string, meta: Record<string, unknown>) {
    const user = await this.loadUser({ id: userId });
    if (!user) return;
    for (const m of user.memberships) {
      void this.audit.record({
        tenantId: m.tenant.id,
        actorUserId: userId,
        action,
        target: userId,
        meta: { email: user.email, ...meta },
      });
    }
  }
}
