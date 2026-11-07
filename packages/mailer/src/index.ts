import { createSign } from 'node:crypto';
import nodemailer from 'nodemailer';

// Provider-agnostic email sending for CronApp. Callers resolve a MailConfig from
// storage (decrypting any secrets) and hand it here; this package owns the wire
// protocol for each provider so the API (test button) and worker (alerts + email
// handler) share exactly one implementation.
//
//  - smtp         classic SMTP via nodemailer
//  - microsoft365 Microsoft Graph sendMail, app-only (client-credentials) OAuth
//  - gmail        Gmail API, service-account (domain-wide delegation) OAuth
//
// A null/unconfigured config degrades to a dry-run (composed + logged, not sent)
// so dev and tests never hang on a socket or hit a provider.

export type MailProvider = 'smtp' | 'microsoft365' | 'gmail';

export interface SmtpConfig {
  provider: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface Microsoft365Config {
  provider: 'microsoft365';
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox to send as (also the From address). */
  from: string;
}

export interface GmailConfig {
  provider: 'gmail';
  /** Service-account client_email. */
  clientEmail: string;
  /** Service-account private_key (PEM). */
  privateKey: string;
  /** The Workspace user to impersonate / send as (also the From address). */
  from: string;
}

export type MailConfig = SmtpConfig | Microsoft365Config | GmailConfig;

export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface SendResult {
  mode: 'sent' | 'dry-run';
  provider: MailProvider | 'none';
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
}

/** Send a message with the given config. A null config is a dry-run. */
export async function sendMail(cfg: MailConfig | null, msg: MailMessage): Promise<SendResult> {
  if (!cfg) return dryRun(msg, 'none');
  switch (cfg.provider) {
    case 'smtp':
      return sendSmtp(cfg, msg);
    case 'microsoft365':
      return sendGraph(cfg, msg);
    case 'gmail':
      return sendGmail(cfg, msg);
    default:
      return dryRun(msg, 'none');
  }
}

async function dryRun(msg: MailMessage, provider: MailProvider | 'none'): Promise<SendResult> {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const info = await transport.sendMail({ from: 'cronapp@localhost', ...msg });
  return { mode: 'dry-run', provider, messageId: info.messageId };
}

// ─────────────────────────── SMTP ───────────────────────────

const smtpCache = new Map<string, nodemailer.Transporter>();

async function sendSmtp(cfg: SmtpConfig, msg: MailMessage): Promise<SendResult> {
  const sig = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user ?? ''}:${cfg.pass ?? ''}`;
  let transport = smtpCache.get(sig);
  if (!transport) {
    transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
    });
    smtpCache.set(sig, transport);
  }
  const info = await transport.sendMail({ from: cfg.from, ...msg });
  return {
    mode: 'sent',
    provider: 'smtp',
    messageId: info.messageId,
    accepted: (info.accepted ?? []) as string[],
    rejected: (info.rejected ?? []) as string[],
  };
}

// ───────────────────── OAuth token cache ─────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedToken>();

async function cachedToken(key: string, fetchToken: () => Promise<{ token: string; ttlSec: number }>): Promise<string> {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;
  const { token, ttlSec } = await fetchToken();
  tokenCache.set(key, { token, expiresAt: Date.now() + ttlSec * 1000 });
  return token;
}

// ─────────────────── Microsoft 365 (Graph) ───────────────────

async function sendGraph(cfg: Microsoft365Config, msg: MailMessage): Promise<SendResult> {
  const token = await cachedToken(`ms:${cfg.tenantId}:${cfg.clientId}`, async () => {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Microsoft 365 auth failed: ${String(data.error_description ?? data.error ?? res.status)}`);
    }
    return { token: String(data.access_token), ttlSec: Number(data.expires_in ?? 3600) };
  });

  const body = {
    message: {
      subject: msg.subject,
      body: { contentType: msg.html ? 'HTML' : 'Text', content: msg.html ?? msg.text ?? '' },
      toRecipients: [{ emailAddress: { address: msg.to } }],
    },
    saveToSentItems: false,
  };
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 202) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Microsoft 365 sendMail failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return { mode: 'sent', provider: 'microsoft365', messageId: res.headers.get('request-id') ?? undefined, accepted: [msg.to] };
}

// ─────────────────────── Gmail API ───────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendGmail(cfg: GmailConfig, msg: MailMessage): Promise<SendResult> {
  const token = await cachedToken(`gmail:${cfg.clientEmail}:${cfg.from}`, async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: cfg.clientEmail,
        sub: cfg.from, // impersonate the sender (domain-wide delegation)
        scope: 'https://www.googleapis.com/auth/gmail.send',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = base64url(signer.sign(cfg.privateKey.replace(/\\n/g, '\n')));
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Gmail auth failed: ${String(data.error_description ?? data.error ?? res.status)}`);
    }
    return { token: String(data.access_token), ttlSec: Number(data.expires_in ?? 3600) };
  });

  // Build a minimal RFC 822 message.
  const headers = [
    `From: ${cfg.from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: text/${msg.html ? 'html' : 'plain'}; charset=UTF-8`,
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n');
  const raw = base64url(`${headers}\r\n\r\n${msg.html ?? msg.text ?? ''}`);

  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(cfg.from)}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Gmail send failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { mode: 'sent', provider: 'gmail', messageId: String(data.id ?? ''), accepted: [msg.to] };
}

/** RFC 2047 encode a header value when it contains non-ASCII (e.g. emoji subjects). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
