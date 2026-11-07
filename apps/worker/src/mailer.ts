import { getPrisma, decryptSecret } from '@cronapp/database';
import { sendMail as send, type MailConfig, type MailProvider, type SendResult } from '@cronapp/mailer';

// Email delivery for the worker (the `email` job handler and EMAIL notification
// channels). The effective config comes from the DB (SmtpConfig, super-admin
// managed) — classic SMTP, Microsoft 365 (Graph) or Gmail (service account) —
// then falls back to SMTP_* env vars, then to a dry-run (composed + logged,
// never sent) so dev and tests never hang on a socket or hit a provider.

export type { SendResult } from '@cronapp/mailer';

const PROVIDERS: MailProvider[] = ['smtp', 'microsoft365', 'gmail'];
function normProvider(p: string | null | undefined): MailProvider {
  return PROVIDERS.includes(p as MailProvider) ? (p as MailProvider) : 'smtp';
}

function dec(ct?: Uint8Array | null, iv?: Uint8Array | null, tag?: Uint8Array | null): string | undefined {
  if (!ct || !iv || !tag) return undefined;
  try {
    return decryptSecret({ ciphertext: Buffer.from(ct), iv: Buffer.from(iv), authTag: Buffer.from(tag) });
  } catch {
    return undefined;
  }
}

async function resolveConfig(): Promise<MailConfig | null> {
  let row: Awaited<ReturnType<ReturnType<typeof getPrisma>['smtpConfig']['findUnique']>> | null = null;
  try {
    row = await getPrisma().smtpConfig.findUnique({ where: { id: 'smtp' } });
  } catch {
    /* table missing or DB hiccup — fall through to env */
  }

  const provider = normProvider(row?.provider);

  if (provider === 'microsoft365') {
    if (!row?.enabled || !row.msTenantId || !row.msClientId || !row.fromAddr) return null;
    const secret = dec(row.msClientSecretCiphertext, row.msClientSecretIv, row.msClientSecretAuthTag);
    if (!secret) return null;
    return { provider: 'microsoft365', tenantId: row.msTenantId, clientId: row.msClientId, clientSecret: secret, from: row.fromAddr };
  }

  if (provider === 'gmail') {
    if (!row?.enabled || !row.gmailClientEmail || !row.fromAddr) return null;
    const key = dec(row.gmailKeyCiphertext, row.gmailKeyIv, row.gmailKeyAuthTag);
    if (!key) return null;
    return { provider: 'gmail', clientEmail: row.gmailClientEmail, privateKey: key, from: row.fromAddr };
  }

  // SMTP (DB first, then env).
  if (row?.enabled && row.host) {
    return {
      provider: 'smtp',
      host: row.host,
      port: row.port,
      secure: row.secure,
      user: row.username ?? undefined,
      pass: dec(row.passwordCiphertext, row.passwordIv, row.passwordAuthTag),
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

export async function sendMail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<SendResult> {
  const cfg = await resolveConfig();
  return send(cfg, opts);
}
