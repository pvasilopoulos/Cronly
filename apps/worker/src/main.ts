import { gzipSync } from 'node:zlib';
import { getPrisma, Prisma } from '@cronapp/database';
import { getStorage, INLINE_MAX_BYTES, responseKey } from '@cronapp/storage';
import { isUnlimited, quotaForPlan } from '@cronapp/rbac';
import { HANDLERS } from './handlers';
import { resolvePayloadSecrets } from './secrets';
import { maybeAlert } from './alerts';
import { notifyTenant } from './notifications';
import { monitorHeartbeatsOnce } from './heartbeat';
import { logJson } from './logger';

const HEARTBEAT_MONITOR_MS = parseInt(process.env.HEARTBEAT_MONITOR_MS ?? '30000', 10);
// How many runs this worker process may execute concurrently.
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '10', 10);
// How often to poll the DB queue (QUEUED JobRuns whose scheduledAt has arrived).
const POLL_MS = parseInt(process.env.WORKER_POLL_MS ?? '1000', 10);

interface Data {
  runId: string;
  jobId: string;
  tenantId: string;
  attempt: number;
  concurrencyKey: string | null;
}

async function persistResponse(
  tenantId: string,
  runId: string,
  result: { contentType: string; body: Buffer },
) {
  const size = result.body.byteLength;
  const gz = gzipSync(result.body);
  const preview = result.body.subarray(0, 2048).toString('utf8');

  // Small payloads stay inline in the database; large ones go to object storage.
  if (gz.byteLength <= INLINE_MAX_BYTES) {
    return {
      contentType: result.contentType,
      responseSize: BigInt(size),
      responseInline: gz,
      storageKey: null as string | null,
      preview,
      truncated: size > 2048,
    };
  }
  const key = responseKey(tenantId, runId);
  await getStorage().put(key, gz, 'application/gzip');
  return {
    contentType: result.contentType,
    responseSize: BigInt(size),
    responseInline: null,
    storageKey: key,
    preview,
    truncated: size > 2048,
  };
}

// Per-tenant plan → concurrency limit, cached briefly so the gate below does not
// re-read the Tenant row on every claim. A plan change takes effect within the
// TTL; -1 means unlimited.
const planCache = new Map<string, { limit: number; at: number }>();
const PLAN_CACHE_TTL_MS = 60_000;

async function tenantConcurrencyLimit(tenantId: string): Promise<number> {
  const hit = planCache.get(tenantId);
  if (hit && Date.now() - hit.at < PLAN_CACHE_TTL_MS) return hit.limit;
  const tenant = await getPrisma().tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, settings: true },
  });
  const base = quotaForPlan(tenant?.plan ?? 'STARTER').maxConcurrency;
  // A per-tenant override (settings.quotas.maxConcurrency) wins when it is a
  // valid integer >= -1; otherwise fall back to the plan default.
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const q = settings.quotas as Record<string, unknown> | undefined;
  const ov = q?.maxConcurrency;
  const limit = typeof ov === 'number' && Number.isInteger(ov) && ov >= -1 ? ov : base;
  planCache.set(tenantId, { limit, at: Date.now() });
  return limit;
}

let inFlight = 0;

/**
 * Atomically move a QUEUED run to RUNNING, respecting the tenant's concurrency
 * cap and any per-(tenant, concurrencyKey) serialization. Returns true if this
 * worker claimed the run (and must now execute it), false if it was deferred
 * (cap reached / key busy) or already taken by another worker.
 *
 * The gate + claim are serialized per tenant by locking the Tenant row FOR
 * UPDATE (released at commit) — the MariaDB stand-in for the old Postgres
 * advisory lock. A tenant with an unlimited plan and no concurrency key needs no
 * gate, so the claim is a single conditional UPDATE (status QUEUED → RUNNING).
 */
async function claimRun(c: Data): Promise<boolean> {
  const concLimit = await tenantConcurrencyLimit(c.tenantId);
  const needGate = !isUnlimited(concLimit) || !!c.concurrencyKey;
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    if (needGate) {
      // Serialize concurrency evaluation for this tenant (released on commit).
      await tx.$executeRaw(Prisma.sql`SELECT id FROM Tenant WHERE id = ${c.tenantId} FOR UPDATE`);
      if (!isUnlimited(concLimit)) {
        const running = await tx.jobRun.count({ where: { tenantId: c.tenantId, status: 'RUNNING' } });
        if (running >= concLimit) return false;
      }
      if (c.concurrencyKey) {
        // Jobs sharing a concurrencyKey never run in parallel within a tenant.
        const busy = await tx.$queryRaw<{ one: number }[]>(Prisma.sql`
          SELECT 1 AS one
          FROM JobRun jr JOIN Job j ON jr.jobId = j.id
          WHERE jr.status = 'RUNNING'
            AND j.tenantId = ${c.tenantId}
            AND j.concurrencyKey = ${c.concurrencyKey}
          LIMIT 1
        `);
        if (busy.length > 0) return false;
      }
    }
    // The conditional UPDATE is the atomic claim: only one worker's update can
    // match while status is still QUEUED.
    const marked = await tx.jobRun.updateMany({
      where: { id: c.runId, status: 'QUEUED' },
      data: { status: 'RUNNING', attempt: c.attempt, startedAt: new Date() },
    });
    return marked.count > 0;
  });
}

async function processRun(d: Data): Promise<void> {
  const { runId, jobId, tenantId, attempt } = d;
  const prisma = getPrisma();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    // The job was deleted after this run was queued — close the run out so it
    // does not linger in RUNNING forever.
    await prisma.jobRun.updateMany({
      where: { id: runId },
      data: { status: 'DEAD_LETTER', finishedAt: new Date(), error: 'job no longer exists' },
    });
    return;
  }

  const handler = HANDLERS[job.handler];
  const startedAt = Date.now();

  try {
    if (!handler) throw new Error(`No handler registered for "${job.handler}"`);
    // Resolve {{secret:NAME}} references just before execution (never persisted).
    const resolvedPayload = await resolvePayloadSecrets(tenantId, job.payload);
    const result = await handler(resolvedPayload, { timeoutMs: job.timeoutMs, tenantId });
    const stored = await persistResponse(tenantId, runId, result);
    const durationMs = Date.now() - startedAt;

    await prisma.$transaction(async (tx) => {
      await tx.jobRun.update({
        where: { id: runId },
        data: {
          status: result.warning ? 'WARNING' : 'SUCCESS',
          finishedAt: new Date(),
          durationMs,
          error: result.warning ?? null,
          ...stored,
        },
      });
      // A successful run counts as a heartbeat: reset the window and clear any
      // prior miss, so a job that runs on schedule never needs an external ping.
      await tx.job.updateMany({
        where: { id: jobId, heartbeatEnabled: true },
        data: { lastPingAt: new Date(), heartbeatState: 'OK', heartbeatAlertedAt: null },
      });
    });
    logJson({
      level: 'info',
      msg: 'run_complete',
      runId,
      jobId,
      tenantId,
      handler: job.handler,
      status: result.warning ? 'WARNING' : 'SUCCESS',
      durationMs,
      attempt,
    });

    // HTTP response-status notifications (opt-in per user): when the handler made
    // an upstream HTTP call, emit response.<class> so a member can be alerted on
    // 2xx / 3xx / 4xx / 5xx outcomes. notifyTenant applies each user's policy, so
    // nobody is notified unless they explicitly enabled that class.
    if (typeof result.status === 'number') {
      const cls = Math.floor(result.status / 100);
      const event =
        cls === 2 ? 'response.2xx' : cls === 3 ? 'response.3xx' : cls === 4 ? 'response.4xx' : cls === 5 ? 'response.5xx' : null;
      if (event) {
        await notifyTenant(tenantId, event, {
          title: `${job.name}: HTTP ${result.status}`,
          body: `${job.handler} returned HTTP ${result.status}.`,
          jobId,
          runId,
        }).catch((e: any) => console.error('[notify] response-status fan-out failed', e?.message ?? e));
      }
    }
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = err?.name === 'AbortError';
    const canRetry = attempt < job.maxRetries;

    await prisma.jobRun.update({
      where: { id: runId },
      data: {
        status: canRetry ? 'FAILED' : isTimeout ? 'TIMEOUT' : 'DEAD_LETTER',
        finishedAt: new Date(),
        durationMs,
        error: String(err?.message ?? err).slice(0, 2000),
      },
    });
    logJson({
      level: 'error',
      msg: 'run_failed',
      runId,
      jobId,
      tenantId,
      handler: job.handler,
      status: canRetry ? 'FAILED' : isTimeout ? 'TIMEOUT' : 'DEAD_LETTER',
      durationMs,
      attempt,
      willRetry: canRetry,
      error: String(err?.message ?? err).slice(0, 500),
    });

    if (canRetry) {
      // Exponential backoff: 2^attempt seconds, expressed as a FUTURE
      // scheduledAt. The poll loop only claims runs whose scheduledAt has
      // arrived, so the row simply waits in QUEUED until then.
      const delayMs = Math.min(2 ** attempt, 60) * 1000;
      await prisma.jobRun.create({
        data: {
          jobId,
          tenantId,
          status: 'QUEUED',
          scheduledAt: new Date(Date.now() + delayMs),
          attempt: attempt + 1,
        },
      });
    } else {
      // Terminal failure (retries exhausted) → evaluate alert rules.
      await maybeAlert(tenantId, jobId, runId, isTimeout ? 'TIMEOUT' : 'DEAD_LETTER').catch((e) =>
        console.error('[alert] evaluation failed', e?.message ?? e),
      );
    }
  }
}

/**
 * Poll the DB queue for due QUEUED runs and dispatch as many as spare capacity
 * allows. FOR UPDATE SKIP LOCKED keeps two worker processes from fighting over
 * the same candidates; the per-run claimRun() makes the final hand-off atomic.
 */
async function poll(): Promise<void> {
  try {
    const capacity = CONCURRENCY - inFlight;
    if (capacity <= 0) return;
    const prisma = getPrisma();
    const candidates = await prisma.$transaction((tx) =>
      tx.$queryRaw<Data[]>(Prisma.sql`
        SELECT jr.id AS runId, jr.jobId AS jobId, jr.tenantId AS tenantId,
               jr.attempt AS attempt, j.concurrencyKey AS concurrencyKey
        FROM JobRun jr JOIN Job j ON jr.jobId = j.id
        WHERE jr.status = 'QUEUED' AND jr.scheduledAt <= UTC_TIMESTAMP()
        ORDER BY jr.scheduledAt ASC
        LIMIT ${capacity}
        FOR UPDATE SKIP LOCKED
      `),
    );
    for (const c of candidates) {
      const ok = await claimRun(c);
      if (!ok) continue; // deferred (cap/key) or already taken — re-polled later
      inFlight++;
      void processRun(c)
        .catch((e) => console.error(`run ${c.runId} crashed`, e?.message ?? e))
        .finally(() => {
          inFlight--;
        });
    }
  } catch (err) {
    console.error('[worker] poll error', err);
  }
}

// Heartbeat / dead-man's-switch monitor: periodically flip jobs whose ping or
// success window lapsed to MISSING and alert. Atomic claim → safe to run in
// every worker instance.
async function monitorHeartbeats() {
  try {
    await monitorHeartbeatsOnce();
  } catch (err: any) {
    console.error('[heartbeat] monitor error', err?.message ?? err);
  }
}

console.log(`CronApp worker — polling every ${POLL_MS}ms, concurrency ${CONCURRENCY}`);
const pollTimer = setInterval(poll, POLL_MS);
void poll();

const heartbeatTimer = setInterval(monitorHeartbeats, HEARTBEAT_MONITOR_MS);
setTimeout(monitorHeartbeats, 5000);
console.log(`CronApp worker — heartbeat monitor every ${HEARTBEAT_MONITOR_MS}ms`);

const shutdown = async () => {
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  await getPrisma().$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
