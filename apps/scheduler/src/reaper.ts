import { getPrisma, Prisma } from '@cronapp/database';
import { getStorage } from '@cronapp/storage';

// Reliability sweeper. Runs in the scheduler process on its own cadence and
// recovers runs stuck in RUNNING (a worker crashed mid-execution, so the row
// would otherwise stay RUNNING forever). It also purges runs past the retention
// window so storage never grows unbounded.
//
// Orphan QUEUED runs need no special handling here: a QUEUED JobRun IS the queue
// entry, so the workers pick it up on their next poll — there is no separate
// enqueue step that could fail.

const RUNNING_GRACE_MS = parseInt(process.env.REAPER_RUNNING_GRACE_MS ?? '30000', 10);
const RETENTION_DAYS = parseInt(process.env.RESPONSE_RETENTION_DAYS ?? '30', 10);
const PURGE_BATCH = 500;

export async function reapOnce(instance: string): Promise<void> {
  const prisma = getPrisma();

  // Fail runs stuck in RUNNING past their own deadline (timeoutMs + grace).
  // MariaDB multi-table UPDATE joins JobRun to its Job for the per-job deadline.
  const stuck = await prisma.$executeRaw(Prisma.sql`
    UPDATE JobRun jr
    JOIN Job j ON jr.jobId = j.id
    SET jr.status = 'TIMEOUT',
        jr.finishedAt = UTC_TIMESTAMP(),
        jr.durationMs = ROUND(TIMESTAMPDIFF(MICROSECOND, jr.startedAt, UTC_TIMESTAMP()) / 1000),
        jr.error = 'reaped: run exceeded its deadline or the worker died'
    WHERE jr.status = 'RUNNING'
      AND jr.startedAt IS NOT NULL
      AND TIMESTAMPADD(
            MICROSECOND,
            (j.timeoutMs + ${Prisma.raw(String(RUNNING_GRACE_MS))}) * 1000,
            jr.startedAt
          ) < UTC_TIMESTAMP()
  `);

  if (stuck > 0) {
    console.log(`[${instance}] reaper: reaped ${stuck} stuck run(s)`);
  }
}

export async function purgeOnce(instance: string): Promise<void> {
  const prisma = getPrisma();
  const storage = getStorage();
  let deleted = 0;

  for (;;) {
    // Compute the cutoff in JS and pass it as a bound DateTime — portable and
    // timezone-safe (Prisma sends it as UTC, matching how rows are stored).
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    const old = await prisma.$queryRaw<{ id: string; storageKey: string | null }[]>(Prisma.sql`
      SELECT id, storageKey
      FROM JobRun
      WHERE scheduledAt < ${cutoff}
      ORDER BY scheduledAt ASC
      LIMIT ${PURGE_BATCH}
    `);
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
    await prisma.jobRun.deleteMany({ where: { id: { in: ids } } });
    deleted += old.length;
    if (old.length < PURGE_BATCH) break;
  }

  if (deleted > 0) {
    console.log(`[${instance}] purge: deleted ${deleted} run(s) older than ${RETENTION_DAYS}d`);
  }
}
