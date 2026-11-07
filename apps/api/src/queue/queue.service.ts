import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { env } from '../config/env';

export const EXECUTION_QUEUE = 'executions';

export interface ExecutionJobData {
  runId: string;
  jobId: string;
  tenantId: string;
  attempt: number;
}

/** Owns the BullMQ queue the API pushes ad-hoc ("run now") executions onto.
 *  The scheduler pushes scheduled executions onto the same queue; workers
 *  consume both. */
@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly executions = new Queue<ExecutionJobData>(EXECUTION_QUEUE, {
    connection: { host: env.redis.host, port: env.redis.port, password: env.redis.password },
    defaultJobOptions: {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 1, // retries are managed explicitly via JobRun.attempt
    },
  });

  /** Execution-queue depth by state, for metrics. */
  counts(): Promise<Record<string, number>> {
    return this.executions.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
  }

  enqueue(data: ExecutionJobData, opts?: { perTenantKey?: string }) {
    return this.executions.add('execute', data, {
      // group by tenant so one noisy tenant can be rate-limited independently
      jobId: `${data.runId}`,
      ...(opts?.perTenantKey ? { group: { id: opts.perTenantKey } } : {}),
    } as any);
  }

  async onModuleDestroy() {
    await this.executions.close();
  }
}
