import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../rbac/principal.service';
import { CreateApiKeyDto } from './apikeys.dto';

export interface VerifiedKey {
  id: string;
  tenantId: string;
  scopes: string[];
  createdBy: string | null;
}

// Never return hash. The plaintext token is only ever returned once, from create().
const SAFE_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  createdBy: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const TOKEN_PREFIX = 'cak_';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.apiKey.findMany({ orderBy: { createdAt: 'desc' }, select: SAFE_SELECT }),
    );
  }

  async create(p: Principal, dto: CreateApiKeyDto) {
    // A key can never be granted a scope its creator does not currently hold —
    // otherwise an admin could mint a key more powerful than themselves.
    const allowed = p.keys;
    const invalid = dto.scopes.filter((s) => !allowed.has(s));
    if (invalid.length > 0) {
      throw new ForbiddenException(`Cannot grant scope(s) you do not hold: ${invalid.join(', ')}`);
    }

    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      const d = new Date(dto.expiresAt);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('expiresAt is not a valid date');
      if (d.getTime() <= Date.now()) throw new BadRequestException('expiresAt must be in the future');
      expiresAt = d;
    }

    // 32 random bytes, url-safe. Full token = cak_<43 chars>.
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const prefix = token.slice(0, 12); // cak_ + 8 chars, safe to display
    const hash = sha256(token);

    const created = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.apiKey.create({
        data: {
          tenantId: p.tenantId,
          name: dto.name,
          prefix,
          hash,
          scopes: dto.scopes,
          createdBy: p.userId,
          expiresAt,
        },
        select: SAFE_SELECT,
      }),
    );

    await this.audit.record_for(p, 'apikey.created', created.id, {
      name: created.name,
      prefix: created.prefix,
      scopes: created.scopes,
    });
    // The one and only time the plaintext token is exposed.
    return { ...created, token };
  }

  async revoke(p: Principal, id: string) {
    const res = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
    if (res.count === 0) throw new NotFoundException('API key not found or already revoked');
    await this.audit.record_for(p, 'apikey.revoked', id);
    return { ok: true };
  }

  async remove(p: Principal, id: string) {
    await this.prisma.forTenant(p.tenantId, (tx) => tx.apiKey.deleteMany({ where: { id } }));
    await this.audit.record_for(p, 'apikey.deleted', id);
    return { ok: true };
  }

  /**
   * Resolve a raw bearer token to its tenant + scopes, or return null when the
   * token is unknown, revoked or expired. Runs RLS-bypassed because the lookup
   * is keyed by a secret hash, before any tenant context exists.
   */
  async verify(token: string): Promise<VerifiedKey | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const hash = sha256(token);
    const key = await this.prisma.asSuperAdmin((tx) =>
      tx.apiKey.findUnique({
        where: { hash },
        select: { id: true, tenantId: true, scopes: true, createdBy: true, revokedAt: true, expiresAt: true },
      }),
    );
    if (!key) return null;
    if (key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

    // Best-effort last-used stamp; never block or fail the request on it.
    this.prisma
      .asSuperAdmin((tx) => tx.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }))
      .catch(() => undefined);

    return { id: key.id, tenantId: key.tenantId, scopes: key.scopes, createdBy: key.createdBy };
  }
}
