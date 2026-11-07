import { BadRequestException, Injectable } from '@nestjs/common';
import { encryptSecret, decryptSecret } from '@cronapp/database';
import { sendMail, type MailConfig, type MailProvider } from '@cronapp/mailer';
import { PrismaService } from '../prisma/prisma.service';

const SINGLETON_ID = 'smtp';
const PROVIDERS: MailProvider[] = ['smtp', 'microsoft365', 'gmail'];

export interface SmtpView {
  enabled: boolean;
  provider: MailProvider;
  // SMTP
  host: string | null;
  port: number;
  secure: boolean;
  username: string | null;
  fromAddr: string | null;
  hasPassword: boolean;
  // Microsoft 365
  msTenantId: string | null;
  msClientId: string | null;
  hasMsSecret: boolean;
  // Gmail
  gmailClientEmail: string | null;
  hasGmailKey: boolean;
  // Status
  envFallback: boolean;
  effectiveConfigured: boolean;
}

export interface SmtpPatch {
  enabled?: boolean;
  provider?: string;
  host?: string | null;
  port?: number;
  secure?: boolean;
  username?: string | null;
  fromAddr?: string | null;
  password?: string;
  clearPassword?: boolean;
  // Microsoft 365
  msTenantId?: string | null;
  msClientId?: string | null;
  msClientSecret?: string;
  clearMsSecret?: boolean;
  // Gmail — the full service-account JSON (parsed server-side), or clear.
  gmailServiceAccount?: string;
  clearGmailKey?: boolean;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['smtpConfig']['findUnique']>>>;

/**
 * Instance email-delivery settings (super-admin managed). Supports classic SMTP
 * plus native Microsoft 365 (Graph) and Gmail (service-account) connectors. All
 * secrets are encrypted at rest and never returned; sending is delegated to the
 * shared @cronapp/mailer so the console test and the worker behave identically.
 */
@Injectable()
export class SmtpService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SmtpView> {
    const row = await this.prisma.client.smtpConfig.findUnique({ where: { id: SINGLETON_ID } });
    const provider = this.normProvider(row?.provider);
    const envFallback = !!process.env.SMTP_HOST;
    return {
      enabled: row?.enabled ?? false,
      provider,
      host: row?.host ?? null,
      port: row?.port ?? 587,
      secure: row?.secure ?? false,
      username: row?.username ?? null,
      fromAddr: row?.fromAddr ?? null,
      hasPassword: !!row?.passwordCiphertext,
      msTenantId: row?.msTenantId ?? null,
      msClientId: row?.msClientId ?? null,
      hasMsSecret: !!row?.msClientSecretCiphertext,
      gmailClientEmail: row?.gmailClientEmail ?? null,
      hasGmailKey: !!row?.gmailKeyCiphertext,
      envFallback,
      effectiveConfigured: !!this.toMailConfig(row ?? null) || (provider === 'smtp' && envFallback),
    };
  }

  async update(patch: SmtpPatch): Promise<SmtpView> {
    const data: Record<string, unknown> = {};
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.provider !== undefined) data.provider = this.normProvider(patch.provider);
    if (patch.host !== undefined) data.host = patch.host?.trim() || null;
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
        throw new BadRequestException('Port must be between 1 and 65535.');
      }
      data.port = patch.port;
    }
    if (patch.secure !== undefined) data.secure = patch.secure;
    if (patch.username !== undefined) data.username = patch.username?.trim() || null;
    if (patch.fromAddr !== undefined) data.fromAddr = patch.fromAddr?.trim() || null;

    // SMTP password
    if (patch.clearPassword) {
      data.passwordCiphertext = null;
      data.passwordIv = null;
      data.passwordAuthTag = null;
    } else if (patch.password) {
      const b = encryptSecret(patch.password);
      data.passwordCiphertext = b.ciphertext;
      data.passwordIv = b.iv;
      data.passwordAuthTag = b.authTag;
    }

    // Microsoft 365
    if (patch.msTenantId !== undefined) data.msTenantId = patch.msTenantId?.trim() || null;
    if (patch.msClientId !== undefined) data.msClientId = patch.msClientId?.trim() || null;
    if (patch.clearMsSecret) {
      data.msClientSecretCiphertext = null;
      data.msClientSecretIv = null;
      data.msClientSecretAuthTag = null;
    } else if (patch.msClientSecret) {
      const b = encryptSecret(patch.msClientSecret);
      data.msClientSecretCiphertext = b.ciphertext;
      data.msClientSecretIv = b.iv;
      data.msClientSecretAuthTag = b.authTag;
    }

    // Gmail — accept the service-account JSON and extract client_email + private_key.
    if (patch.clearGmailKey) {
      data.gmailClientEmail = null;
      data.gmailKeyCiphertext = null;
      data.gmailKeyIv = null;
      data.gmailKeyAuthTag = null;
    } else if (patch.gmailServiceAccount && patch.gmailServiceAccount.trim()) {
      const { clientEmail, privateKey } = this.parseServiceAccount(patch.gmailServiceAccount);
      const b = encryptSecret(privateKey);
      data.gmailClientEmail = clientEmail;
      data.gmailKeyCiphertext = b.ciphertext;
      data.gmailKeyIv = b.iv;
      data.gmailKeyAuthTag = b.authTag;
    }

    await this.prisma.client.smtpConfig.upsert({
      where: { id: SINGLETON_ID },
      update: data,
      create: { id: SINGLETON_ID, ...data },
    });
    return this.get();
  }

  /** Send a test email with the current settings; returns the delivery mode. */
  async sendTest(to: string): Promise<{ mode: 'sent' | 'dry-run'; provider: string; messageId?: string; to: string }> {
    const addr = to?.trim();
    if (!addr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      throw new BadRequestException('Enter a valid destination email address.');
    }
    const row = await this.prisma.client.smtpConfig.findUnique({ where: { id: SINGLETON_ID } });
    const cfg = this.toMailConfig(row ?? null);
    try {
      const res = await sendMail(cfg, {
        to: addr,
        subject: 'CronApp email test',
        text: 'This is a test email from CronApp. If you received it, email delivery is configured correctly.',
      });
      return { mode: res.mode, provider: res.provider, messageId: res.messageId, to: addr };
    } catch (err: any) {
      throw new BadRequestException(`Email send failed: ${err?.message ?? String(err)}`);
    }
  }

  // ── Helpers ──

  private normProvider(p: string | null | undefined): MailProvider {
    return PROVIDERS.includes(p as MailProvider) ? (p as MailProvider) : 'smtp';
  }

  private parseServiceAccount(json: string): { clientEmail: string; privateKey: string } {
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new BadRequestException('Gmail service account must be valid JSON.');
    }
    const clientEmail = parsed.client_email;
    const privateKey = parsed.private_key;
    if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
      throw new BadRequestException('Service account JSON must contain client_email and private_key.');
    }
    return { clientEmail, privateKey };
  }

  private decrypt(ct?: Uint8Array | null, iv?: Uint8Array | null, tag?: Uint8Array | null): string | undefined {
    if (!ct || !iv || !tag) return undefined;
    try {
      return decryptSecret({ ciphertext: Buffer.from(ct), iv: Buffer.from(iv), authTag: Buffer.from(tag) });
    } catch {
      return undefined;
    }
  }

  /**
   * Build the effective MailConfig for @cronapp/mailer, or null for a dry-run.
   * Only the SMTP provider falls back to SMTP_* env vars; the OAuth connectors
   * require a complete, enabled DB row.
   */
  private toMailConfig(row: Row | null): MailConfig | null {
    const provider = this.normProvider(row?.provider);

    if (provider === 'microsoft365') {
      if (!row?.enabled || !row.msTenantId || !row.msClientId || !row.fromAddr) return null;
      const secret = this.decrypt(row.msClientSecretCiphertext, row.msClientSecretIv, row.msClientSecretAuthTag);
      if (!secret) return null;
      return { provider: 'microsoft365', tenantId: row.msTenantId, clientId: row.msClientId, clientSecret: secret, from: row.fromAddr };
    }

    if (provider === 'gmail') {
      if (!row?.enabled || !row.gmailClientEmail || !row.fromAddr) return null;
      const key = this.decrypt(row.gmailKeyCiphertext, row.gmailKeyIv, row.gmailKeyAuthTag);
      if (!key) return null;
      return { provider: 'gmail', clientEmail: row.gmailClientEmail, privateKey: key, from: row.fromAddr };
    }

    // SMTP (DB first, then env).
    if (row?.enabled && row.host) {
      const pass = this.decrypt(row.passwordCiphertext, row.passwordIv, row.passwordAuthTag);
      return {
        provider: 'smtp',
        host: row.host,
        port: row.port,
        secure: row.secure,
        user: row.username ?? undefined,
        pass,
        from: row.fromAddr || 'cronapp@localhost',
      };
    }
    if (process.env.SMTP_HOST) {
      return {
        provider: 'smtp',
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT ?? '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM ?? 'cronapp@localhost',
      };
    }
    return null;
  }
}
