import { getPrisma, Prisma } from '@cronapp/database';
import { notifyTenant } from './notifications';

// Daily digest. Once per day, at each tenant's configured local hour, send a
// one-shot summary of the last 24h of runs to every active member (in-app +
// push). Opt-in per tenant via settings.digest. The send is claimed atomically
// (a conditional JSON update) so it fires exactly once even with several worker
// instances racing.

interface TenantRow {
  id: string;
  timezone: string;
  settings: unknown;
}

function parts(tz: string): { date: string; hour: number } {
  // en-CA renders YYYY-MM-DD; a separate 24h hour formatter avoids locale noise.
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return { date, hour: parseInt(hourStr, 10) || 0 };
}

interface DigestCfg {
  enabled: boolean;
  hour: number;
  lastSentOn?: string;
}

function readCfg(settings: unknown): DigestCfg {
  let s: Record<string, any> = {};
  if (typeof settings === 'string') {
    try {
      s = JSON.parse(settings) ?? {};
    } catch {
      s = {};
    }
  } else if (settings && typeof settings === 'object') {
    s = settings as Record<string, any>;
  }
  const d = (s.digest ?? {}) as Record<string, any>;
  const hour = Number.isInteger(d.hour) && d.hour >= 0 && d.hour <= 23 ? d.hour : 8;
  return { enabled: d.enabled === true, hour, lastSentOn: d.lastSentOn };
}

const FAILED = new Set(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);

async function buildSummary(tenantId: string): Promise<{ title: string; body: string }> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.$queryRaw<{ status: string; c: bigint }[]>(Prisma.sql`
    SELECT status, COUNT(*) AS c
    FROM JobRun
    WHERE tenantId = ${tenantId} AND scheduledAt >= ${since}
    GROUP BY status
  `);
  let total = 0;
  let success = 0;
  let warning = 0;
  let failed = 0;
  for (const r of rows) {
    const n = Number(r.c);
    total += n;
    if (r.status === 'SUCCESS') success += n;
    else if (r.status === 'WARNING') warning += n;
    else if (FAILED.has(r.status)) failed += n;
  }
  const rate = total > 0 ? Math.round((success / total) * 100) : 100;
  const title = `Daily digest — ${total} run${total === 1 ? '' : 's'}, ${failed} failed`;
  const body =
    total === 0
      ? 'No runs in the last 24 hours.'
      : `Last 24h: ${total} runs · ${success} succeeded · ${warning} warnings · ${failed} failed · ${rate}% success rate.`;
  return { title, body };
}

/** Try to claim and send today's digest for one tenant. Returns true if sent. */
async function sendForTenant(t: TenantRow): Promise<boolean> {
  const prisma = getPrisma();
  const cfg = readCfg(t.settings);
  if (!cfg.enabled) return false;

  const { date, hour } = parts(t.timezone || 'Europe/Athens');
  if (hour !== cfg.hour) return false;
  if (cfg.lastSentOn === date) return false;

  // Atomic claim: only the instance whose UPDATE matches a row (lastSentOn not
  // yet today) proceeds to send.
  const claimed = await prisma.$executeRaw(Prisma.sql`
    UPDATE Tenant
    SET settings = JSON_SET(COALESCE(settings, '{}'), '$.digest.lastSentOn', ${date})
    WHERE id = ${t.id}
      AND (
        JSON_EXTRACT(settings, '$.digest.lastSentOn') IS NULL
        OR JSON_UNQUOTE(JSON_EXTRACT(settings, '$.digest.lastSentOn')) <> ${date}
      )
  `);
  if (claimed !== 1) return false;

  const { title, body } = await buildSummary(t.id);
  await notifyTenant(t.id, 'digest.daily', { title, body }, { ignorePolicy: true, severity: 'INFO' });
  return true;
}

export async function digestSweepOnce(): Promise<void> {
  const prisma = getPrisma();
  const tenants = await prisma.$queryRaw<TenantRow[]>(Prisma.sql`
    SELECT id, timezone, settings FROM Tenant WHERE status <> 'SUSPENDED'
  `);
  for (const t of tenants) {
    try {
      const sent = await sendForTenant(t);
      if (sent) console.log(`[digest] sent daily digest for tenant ${t.id}`);
    } catch (err: any) {
      console.error(`[digest] failed for tenant ${t.id}:`, err?.message ?? err);
    }
  }
}
