// Job handlers. A handler receives the (secret-resolved) job payload and returns
// a response the platform records. The payload *contract* for each handler lives
// in @cronapp/handlers (shared with the API and web); the implementations live
// here, in the trusted worker.

import { createHmac } from 'node:crypto';
import { getPrisma } from '@cronapp/database';
import { safeFetch } from './net-guard';
import { sendMail } from './mailer';

export interface HandlerResult {
  contentType: string;
  body: Buffer;
  /** Soft warning (run succeeds but is flagged), e.g. non-2xx that you tolerate. */
  warning?: string;
}

export interface HandlerCtx {
  timeoutMs: number;
  tenantId: string;
}

export type Handler = (payload: any, ctx: HandlerCtx) => Promise<HandlerResult>;

function bigintSafe(_k: string, v: unknown) {
  return typeof v === 'bigint' ? Number(v) : v;
}

// ─────────────────────────── http.request ───────────────────────────
const httpRequest: Handler = async (payload, ctx) => {
  const url: string = payload?.url;
  if (!url) throw new Error('http.request: payload.url is required');
  const method: string = (payload?.method ?? 'GET').toUpperCase();
  const rawBody = payload?.body;
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    // safeFetch enforces the SSRF guard on the URL and every redirect hop.
    const res = await safeFetch(url, { method, headers: payload?.headers, body, signal: controller.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { contentType, body: buf, warning: res.ok ? undefined : `Upstream responded ${res.status}` };
  } finally {
    clearTimeout(timer);
  }
};

// ─────────────────────────── webhook (signed) ───────────────────────────
const webhook: Handler = async (payload, ctx) => {
  const url: string = payload?.url;
  if (!url) throw new Error('webhook: payload.url is required');
  const secret = payload?.secret;
  if (!secret) throw new Error('webhook: payload.secret is required');
  const raw = payload?.body;
  const body = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  const signature = 'sha256=' + createHmac('sha256', String(secret)).update(body).digest('hex');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cronapp-signature': signature },
      body,
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { contentType, body: buf, warning: res.ok ? undefined : `Upstream responded ${res.status}` };
  } finally {
    clearTimeout(timer);
  }
};

// ─────────────────────────── email (SMTP) ───────────────────────────
// The SMTP transport itself lives in ./mailer and is shared with alert delivery.

const email: Handler = async (payload) => {
  const to = payload?.to;
  const subject = payload?.subject;
  if (!to) throw new Error('email: payload.to is required');
  if (!subject) throw new Error('email: payload.subject is required');
  if (!payload?.text && !payload?.html) throw new Error('email: provide a text or html body');

  const res = await sendMail({ to, subject, text: payload?.text, html: payload?.html });
  const dryRun = res.mode !== 'sent';
  const out = {
    mode: dryRun ? 'dry-run (no SMTP configured)' : 'sent',
    messageId: res.messageId,
    accepted: res.accepted,
    rejected: res.rejected,
  };
  return {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(out, null, 2)),
    warning: dryRun ? 'SMTP not configured — email composed but not delivered' : undefined,
  };
};

// ─────────────────────────── db.query (read-only) ───────────────────────────
// Runs a single SELECT fenced to the tenant by RLS AND restricted to the
// read-only `cronapp_query` role (which may only SELECT Job & JobRun). The
// transaction is read-only with a statement timeout, so even a crafted query
// can neither write, escalate, nor run away.
const dbQuery: Handler = async (payload, ctx) => {
  const sql = String(payload?.sql ?? '').trim();
  if (!sql) throw new Error('db.query: payload.sql is required');
  const withoutTrailing = sql.replace(/;\s*$/, '');
  if (/;/.test(withoutTrailing)) throw new Error('db.query: only a single statement is allowed');
  if (!/^(select|with)\b/i.test(withoutTrailing)) {
    throw new Error('db.query: only read-only SELECT queries are allowed');
  }

  const prisma = getPrisma();
  const budget = Math.max(1000, Math.min(ctx.timeoutMs, 60000));
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE cronapp_query');
    await tx.$executeRawUnsafe('SET LOCAL transaction_read_only = on');
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${budget}`);
    return tx.$queryRawUnsafe(withoutTrailing);
  });

  const arr = rows as unknown[];
  return {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(arr, bigintSafe, 2)),
    warning: Array.isArray(arr) && arr.length === 0 ? 'Query returned no rows' : undefined,
  };
};

export const HANDLERS: Record<string, Handler> = {
  'http.request': httpRequest,
  webhook,
  email,
  'db.query': dbQuery,
};
