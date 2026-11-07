import { Injectable } from '@nestjs/common';
import { getPrisma } from '@cronapp/database';

export const EXECUTION_QUEUE = 'executions';

export interface ExecutionJobData {
  runId: string;
  jobId: string;
  tenantId: string;
  attempt: number;
}

/**
 * The execution "queue" is just the set of JobRun rows in status QUEUED: the
 * workers poll them directly (SELECT ... FOR UPDATE SKIP LOCKED), so there is no
 * Redis/BullMQ broker. A caller enqueues simply by committing a QUEUED JobRun;
 * `enqueue()` is kept as a no-op so the run-now / replay flows read naturally and
 * stay broker-agnostic.
 */
@Injectable()
export class QueueService {
  /** Execution-queue depth by state, for metrics (QUEUED → waiting, RUNNING → active). */
  async counts(): Promise<Record<string, number>> {
    const rows = await getPrisma().jobRun.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
    });
    const out: Record<string, number> = { waiting: 0, active: 0 };
    for (const r of rows) {
      if (r.status === 'QUEUED') out.waiting = r._count._all;
      else if (r.status === 'RUNNING') out.active = r._count._all;
    }
    return out;
  }

  /**
   * No-op: the QUEUED JobRun the caller already committed IS the queue entry, so
   * there is nothing more to push. Kept for call-site compatibility.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async enqueue(_data: ExecutionJobData, _opts?: { perTenantKey?: string }): Promise<void> {
    /* intentionally empty — DB-backed queue */
  }
}
