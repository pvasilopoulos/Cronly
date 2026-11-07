import { randomUUID } from 'node:crypto';
import { getPrisma, Prisma } from '@cronapp/database';
import { nextRun } from '@cronapp/cron';
import { reapOnce, purgeOnce } from './reaper';
import { logJson } from './logger';

// The scheduler is a trusted backend process that must see all tenants. It NEVER
// executes jobs itself — it only claims the due ones (atomically, via FOR UPDATE
// SKIP LOCKED) and commits a QUEUED JobRun for each. That row IS the work queue:
// the workers poll for QUEUED runs, so there is no Redis/broker — MariaDB is the
// single source of truth.

const INSTANCE = `sched-${process.pid}-${randomUUID().slice(0, 8)}`;
const TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS ?? '15000', 10);
const REAPER_MS = parseInt(process.env.REAPER_INTERVAL_MS ?? '60000', 10);
const PURGE_MS = parseInt(process.env.PURGE_INTERVAL_MS ?? '3600000', 10);
const BATCH = 200;

interface ClaimedJob {
  id: string;
  tenantId: string;
  cronExpr: string;
  timezone: string;
}

async function tick() {
  const prisma = getPrisma();
  try {
    // Atomically grab a batch of due jobs; other scheduler instances skip the
    // rows this transaction has locked (SKIP LOCKED). MariaDB has no
    // UPDATE ... RETURNING, so we SELECT ... FOR UPDATE then stamp the claim in
    // the same transaction. All time math uses UTC_TIMESTAMP(): Prisma stores
    // DateTimes as UTC, so comparing against UTC keeps schedules correct
    // regardless of the server's OS timezone.
    const claimed = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedJob[]>(Prisma.sql`
        SELECT id, tenantId, cronExpr, timezone
        FROM Job
        WHERE enabled = true
          AND status = 'ACTIVE'
          AND nextRunAt IS NOT NULL
          AND nextRunAt <= UTC_TIMESTAMP()
          -- Respect an optional schedule window: never fire before it opens or
          -- after it closes, even while the job stays ACTIVE.
          AND (startsAt IS NULL OR startsAt <= UTC_TIMESTAMP())
          AND (endsAt IS NULL OR endsAt >= UTC_TIMESTAMP())
          AND (lockedAt IS NULL OR lockedAt < UTC_TIMESTAMP() - INTERVAL 5 MINUTE)
        ORDER BY nextRunAt ASC
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      `);
      if (rows.length > 0) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE Job SET lockedAt = UTC_TIMESTAMP(), lockedBy = ${INSTANCE}
          WHERE id IN (${Prisma.join(rows.map((r) => r.id))})
        `);
      }
      return rows;
    });

    if (claimed.length === 0) return;

    for (const job of claimed) {
      const scheduledAt = new Date();
      // Commit the QUEUED run AND advance the schedule in one transaction. The
      // run row is the queue entry — a worker picks it up on its next poll.
      await prisma.$transaction(async (tx) => {
        await tx.jobRun.create({
          data: { jobId: job.id, tenantId: job.tenantId, status: 'QUEUED', scheduledAt },
        });
        await tx.job.update({
          where: { id: job.id },
          data: {
            lastRunAt: scheduledAt,
            nextRunAt: nextRun(job.cronExpr, job.timezone),
            lockedAt: null,
            lockedBy: null,
          },
        });
      });
    }
    logJson({ level: 'info', msg: 'tick_claimed', instance: INSTANCE, claimed: claimed.length });
  } catch (err) {
    console.error(`[${INSTANCE}] tick error`, err);
  }
}

async function reap() {
  try {
    await reapOnce(INSTANCE);
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
    await getPrisma().$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
