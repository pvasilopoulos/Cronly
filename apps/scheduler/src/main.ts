import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { getPrisma, Prisma } from '@cronapp/database';
import { nextRun } from '@cronapp/cron';
import { reapOnce, purgeOnce } from './reaper';
import { logJson } from './logger';

// The scheduler is a trusted backend process that must see all tenants, so it
// runs with RLS bypassed. It NEVER executes jobs itself — it only claims the
// due ones (atomically, via SKIP LOCKED) and pushes them to the queue.

const INSTANCE = `sched-${process.pid}-${randomUUID().slice(0, 8)}`;
const TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS ?? '15000', 10);
const REAPER_MS = parseInt(process.env.REAPER_INTERVAL_MS ?? '60000', 10);
const PURGE_MS = parseInt(process.env.PURGE_INTERVAL_MS ?? '3600000', 10);
const BATCH = 200;

const queue = new Queue('executions', {
  connection: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
});

interface ClaimedJob {
  id: string;
  tenantId: string;
  cronExpr: string;
  timezone: string;
  concurrencyKey: string | null;
}

async function tick() {
  const prisma = getPrisma();
  try {
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      // Atomically grab a batch of due jobs; other scheduler instances skip
      // rows this transaction has locked.
      return tx.$queryRaw<ClaimedJob[]>(Prisma.sql`
        UPDATE "Job" AS j
        SET "lockedAt" = now(), "lockedBy" = ${INSTANCE}
        WHERE j.id IN (
          SELECT id FROM "Job"
          WHERE enabled = true
            AND status = 'ACTIVE'
            AND "nextRunAt" IS NOT NULL
            AND "nextRunAt" <= now()
            -- Respect an optional schedule window: never fire before it opens or
            -- after it closes, even while the job stays ACTIVE.
            AND ("startsAt" IS NULL OR "startsAt" <= now())
            AND ("endsAt" IS NULL OR "endsAt" >= now())
            AND ("lockedAt" IS NULL OR "lockedAt" < now() - interval '5 minutes')
          ORDER BY "nextRunAt" ASC
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING j.id, j."tenantId", j."cronExpr", j.timezone, j."concurrencyKey";
      `);
    });

    if (claimed.length === 0) return;

    for (const job of claimed) {
      const scheduledAt = new Date();
      // 1) Durably commit the run + advance the schedule FIRST. The enqueue is
      //    deliberately kept OUT of this transaction: Redis latency must never
      //    be able to expire the DB transaction (a 5s interactive-tx timeout).
      //    Otherwise a slow/unavailable Redis rolls back the JobRun while the
      //    enqueue still lands, poisoning the queue with a runId that has no row.
      const run = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        const created = await tx.jobRun.create({
          data: { jobId: job.id, tenantId: job.tenantId, status: 'QUEUED', scheduledAt },
        });
        // Advance the schedule and release the claim.
        await tx.job.update({
          where: { id: job.id },
          data: {
            lastRunAt: scheduledAt,
            nextRunAt: nextRun(job.cronExpr, job.timezone),
            lockedAt: null,
            lockedBy: null,
          },
        });
        return created;
      });

      // 2) Enqueue AFTER commit. If this throws, the run stays persisted as
      //    QUEUED and can be recovered — far better than a poisoned queue.
      try {
        await queue.add(
          'execute',
          { runId: run.id, jobId: job.id, tenantId: job.tenantId, attempt: 1 },
          {
            jobId: run.id,
            removeOnComplete: 1000,
            removeOnFail: 5000,
            ...(job.concurrencyKey ? { group: { id: `${job.tenantId}:${job.concurrencyKey}` } } : {}),
          } as any,
        );
      } catch (err) {
        console.error(`[${INSTANCE}] enqueue failed for run ${run.id} (left as QUEUED)`, err);
      }
    }
    logJson({ level: 'info', msg: 'tick_claimed', instance: INSTANCE, claimed: claimed.length });
  } catch (err) {
    console.error(`[${INSTANCE}] tick error`, err);
  }
}

async function reap() {
  try {
    await reapOnce(queue, INSTANCE);
  } catch (err) {
    console.error(`[${INSTANCE}] reaper error`, err);
  }
}

async function purge() {
  try {
    await purgeOnce(INSTANCE);
  } catch (err) {
    console.error(`[${INSTANCE}] purge error`, err);
  }
}

async function main() {
  console.log(
    `CronApp scheduler ${INSTANCE} — tick ${TICK_MS}ms, reaper ${REAPER_MS}ms, purge ${PURGE_MS}ms`,
  );
  await tick();
  const timer = setInterval(tick, TICK_MS);
  const reaperTimer = setInterval(reap, REAPER_MS);
  const purgeTimer = setInterval(purge, PURGE_MS);
  // First reap/purge shortly after boot, not only after a full interval.
  setTimeout(reap, 5000);
  setTimeout(purge, 10000);

  const shutdown = async () => {
    clearInterval(timer);
    clearInterval(reaperTimer);
    clearInterval(purgeTimer);
    await queue.close();
    await getPrisma().$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
