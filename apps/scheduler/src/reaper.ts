import { Queue } from 'bullmq';
import { getPrisma, Prisma } from '@cronapp/database';
import { getStorage } from '@cronapp/storage';

// Reliability sweeper. Runs in the scheduler process on its own cadence and
// recovers the two states normal operation can leave behind:
//   (a) orphan QUEUED runs — committed to the DB but never enqueued (e.g. an
//       enqueue that failed after commit), and
//   (b) stuck RUNNING runs — a worker crashed mid-execution, so the row would
//       otherwise stay RUNNING forever.
// It also purges runs past the retention window so storage never grows unbounded.

const QUEUED_GRACE_MS = parseInt(process.env.REAPER_QUEUED_GRACE_MS ?? '60000', 10);
const RUNNING_GRACE_MS = parseInt(process.env.REAPER_RUNNING_GRACE_MS ?? '30000', 10);
const RETENTION_DAYS = parseInt(process.env.RESPONSE_RETENTION_DAYS ?? '30', 10);
const PURGE_BATCH = 500;

interface OrphanRow {
  id: string;
  jobId: string;
  tenantId: string;
  attempt: number;
}

export async function reapOnce(queue: Queue, instance: string): Promise<void> {
  const prisma = getPrisma();

  // (a) Re-enqueue orphan QUEUED runs older than the grace window. Enqueue with
  //     jobId = run.id so a message already in the queue is deduplicated.
  const orphans = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.$queryRaw<OrphanRow[]>(Prisma.sql`
      SELECT id, "jobId", "tenantId", attempt
      FROM "JobRun"
      WHERE status = 'QUEUED'
        AND "scheduledAt" < now() - (${`${QUEUED_GRACE_MS} milliseconds`}::interval)
      ORDER BY "scheduledAt" ASC
      LIMIT 200
    `);
  });

  for (const r of orphans) {
    try {
      await queue.add(
        'execute',
        { runId: r.id, jobId: r.jobId, tenantId: r.tenantId, attempt: r.attempt },
        { jobId: r.id, removeOnComplete: 1000, removeOnFail: 5000 } as any,
      );
    } catch (err) {
      console.error(`[${instance}] reaper: requeue failed for run ${r.id}`, err);
    }
  }

  // (b) Fail runs stuck in RUNNING past their own deadline (timeoutMs + grace).
  const stuck = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.$executeRaw(Prisma.sql`
      UPDATE "JobRun" jr
      SET status = 'TIMEOUT',
          "finishedAt" = now(),
          "durationMs" = round(extract(epoch FROM (now() - jr."startedAt")) * 1000),
          error = 'reaped: run exceeded its deadline or the worker died'
      FROM "Job" j
      WHERE jr."jobId" = j.id
        AND jr.status = 'RUNNING'
        AND jr."startedAt" IS NOT NULL
        AND jr."startedAt" < now() - (((j."timeoutMs" + ${RUNNING_GRACE_MS})::text || ' milliseconds')::interval)
    `);
  });

  if (orphans.length > 0 || stuck > 0) {
    console.log(`[${instance}] reaper: requeued ${orphans.length} orphan(s), reaped ${stuck} stuck run(s)`);
  }
}

export async function purgeOnce(instance: string): Promise<void> {
  const prisma = getPrisma();
  const storage = getStorage();
  let deleted = 0;

  for (;;) {
    const old = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return tx.$queryRaw<{ id: string; storageKey: string | null }[]>(Prisma.sql`
        SELECT id, "storageKey"
        FROM "JobRun"
        WHERE "scheduledAt" < now() - (${`${RETENTION_DAYS} days`}::interval)
        ORDER BY "scheduledAt" ASC
        LIMIT ${PURGE_BATCH}
      `);
    });
    if (old.length === 0) break;

    // Best-effort removal of offloaded response objects before dropping rows.
    for (const r of old) {
      if (r.storageKey) {
        try {
          await storage.delete(r.storageKey);
        } catch (err) {
          console.error(`[${instance}] purge: storage delete failed for ${r.storageKey}`, err);
        }
      }
    }

    const ids = old.map((o) => o.id);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.jobRun.deleteMany({ where: { id: { in: ids } } });
    });
    deleted += old.length;
    if (old.length < PURGE_BATCH) break;
  }

  if (deleted > 0) {
    console.log(`[${instance}] purge: deleted ${deleted} run(s) older than ${RETENTION_DAYS}d`);
  }
}
