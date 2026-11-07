import { gzipSync } from 'node:zlib';
import { Worker, Queue, Job as BullJob } from 'bullmq';
import { getPrisma } from '@cronapp/database';
import { getStorage, INLINE_MAX_BYTES, responseKey } from '@cronapp/storage';
import { isUnlimited, quotaForPlan } from '@cronapp/rbac';
import { HANDLERS } from './handlers';
import { resolvePayloadSecrets } from './secrets';
import { maybeAlert } from './alerts';
import { monitorHeartbeatsOnce } from './heartbeat';
import { logJson } from './logger';

const HEARTBEAT_MONITOR_MS = parseInt(process.env.HEARTBEAT_MONITOR_MS ?? '30000', 10);
// How long to defer a run when its tenant is already at its concurrency cap.
const CONCURRENCY_DEFER_MS = parseInt(process.env.CONCURRENCY_DEFER_MS ?? '1500', 10);

const connection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '10', 10);

const retryQueue = new Queue('executions', { connection });

interface Data {
  runId: string;
  jobId: string;
  tenantId: string;
  attempt: number;
}

async function persistResponse(
  tenantId: string,
  runId: string,
  result: { contentType: string; body: Buffer },
) {
  const size = result.body.byteLength;
  const gz = gzipSync(result.body);
  const preview = result.body.subarray(0, 2048).toString('utf8');

  // Small payloads stay inline in Postgres; large ones go to object storage.
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
// re-read the Tenant row on every message. A plan change takes effect within the
// TTL; -1 means unlimited.
const planCache = new Map<string, { limit: number; at: number }>();
const PLAN_CACHE_TTL_MS = 60_000;

async function tenantConcurrencyLimit(tenantId: string): Promise<number> {
  const hit = planCache.get(tenantId);
  if (hit && Date.now() - hit.at < PLAN_CACHE_TTL_MS) return hit.limit;
  const prisma = getPrisma();
  const tenant = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, settings: true } });
  });
  const base = quotaForPlan(tenant?.plan ?? 'STARTER').maxConcurrency;
  // A per-tenant override (settings.quotas.maxConcurrency) wins when it is a
  // valid integer >= -1; otherwise fall back to the plan default.
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const q = settings.quotas as Record<string, unknown> | undefined;
  const ov = q?.maxConcurrency;
  const limit =
    typeof ov === 'number' && Number.isInteger(ov) && ov >= -1 ? ov : base;
  planCache.set(tenantId, { limit, at: Date.now() });
  return limit;
}

async function processRun(bull: BullJob<Data>) {
  const { runId, jobId, tenantId, attempt } = bull.data;
  const prisma = getPrisma();

  // Per-tenant concurrency cap (plan quota). The gate (count RUNNING) and the
  // claim (mark this run RUNNING) must be atomic, otherwise two messages that
  // arrive together both count 0 and both start. We serialize the critical
  // section per tenant with a transaction-scoped advisory lock: only one worker
  // evaluates+claims for a given tenant at a time, so RUNNING never exceeds the
  // limit. The lock is released at commit (a few ms later). Other tenants are
  // unaffected because the lock key is derived from the tenant id.
  //
  // updateMany (not update) so a missing JobRun returns count 0 instead of
  // throwing: a stale/poison message (e.g. a run whose creating transaction
  // rolled back) is dropped quietly rather than failing and retrying forever.
  const concLimit = await tenantConcurrencyLimit(tenantId);
  const gate = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    if (!isUnlimited(concLimit)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;
      const running = await tx.jobRun.count({ where: { tenantId, status: 'RUNNING' } });
      if (running >= concLimit) return { defer: true as const };
    }
    const j = await tx.job.findUnique({ where: { id: jobId } });
    const marked = await tx.jobRun.updateMany({
      where: { id: runId },
      data: { status: 'RUNNING', attempt, startedAt: new Date() },
    });
    return { defer: false as const, job: j, runFound: marked.count > 0 };
  });

  if (gate.defer) {
    // Tenant is at its concurrency cap — requeue this same message (no attempt
    // bump; it is a reschedule, not a retry) and leave the run QUEUED.
    await retryQueue.add(
      'execute',
      bull.data,
      {
        jobId: `${runId}:defer:${Date.now()}`,
        delay: CONCURRENCY_DEFER_MS,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    logJson({ level: 'info', msg: 'run_deferred', runId, jobId, tenantId, reason: 'concurrency_cap' });
    return;
  }

  const { job, runFound } = gate;
  if (!runFound) {
    console.warn(`run ${runId}: JobRun missing — dropping stale queue message`);
    return;
  }
  if (!job) return;

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
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
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
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = err?.name === 'AbortError';
    const canRetry = attempt < job.maxRetries;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.jobRun.update({
        where: { id: runId },
        data: {
          status: canRetry ? 'FAILED' : isTimeout ? 'TIMEOUT' : 'DEAD_LETTER',
          finishedAt: new Date(),
          durationMs,
          error: String(err?.message ?? err).slice(0, 2000),
        },
      });
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
      // Exponential backoff: 2^attempt seconds.
      const delay = Math.min(2 ** attempt, 60) * 1000;
      const retryRun = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return tx.jobRun.create({
          data: { jobId, tenantId, status: 'QUEUED', scheduledAt: new Date(), attempt: attempt + 1 },
        });
      });
      await retryQueue.add(
        'execute',
        { runId: retryRun.id, jobId, tenantId, attempt: attempt + 1 },
        { jobId: retryRun.id, delay, removeOnComplete: 1000, removeOnFail: 5000 },
      );
    } else {
      // Terminal failure (retries exhausted) → evaluate alert rules.
      await maybeAlert(tenantId, jobId, runId, isTimeout ? 'TIMEOUT' : 'DEAD_LETTER').catch((e) =>
        console.error('[alert] evaluation failed', e?.message ?? e),
      );
    }
  }
}

const worker = new Worker<Data>('executions', processRun, { connection, concurrency: CONCURRENCY });

worker.on('ready', () => console.log(`CronApp worker ready — concurrency ${CONCURRENCY}`));
worker.on('failed', (job, err) => console.error(`run ${job?.data.runId} failed:`, err?.message));

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
const heartbeatTimer = setInterval(monitorHeartbeats, HEARTBEAT_MONITOR_MS);
setTimeout(monitorHeartbeats, 5000);
console.log(`CronApp worker — heartbeat monitor every ${HEARTBEAT_MONITOR_MS}ms`);

const shutdown = async () => {
  clearInterval(heartbeatTimer);
  await worker.close();
  await retryQueue.close();
  await getPrisma().$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
