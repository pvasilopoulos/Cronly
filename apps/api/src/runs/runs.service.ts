import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { getStorage } from '@cronapp/storage';
import { Prisma } from '@cronapp/database';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { Principal } from '../rbac/principal.service';

export const RUN_STATUSES = [
  'QUEUED', 'RUNNING', 'SUCCESS', 'WARNING', 'FAILED', 'TIMEOUT', 'DEAD_LETTER',
] as const;
export type RunStatusKey = (typeof RUN_STATUSES)[number];
// Terminal failures that make sense to replay.
const REPLAYABLE = new Set<RunStatusKey>(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);

// Only lightweight, list-friendly fields — never the full payload.
const LIST_SELECT = {
  id: true,
  jobId: true,
  status: true,
  attempt: true,
  scheduledAt: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  contentType: true,
  responseSize: true,
  preview: true,
  truncated: true,
  error: true,
} as const;

function serialize(run: any) {
  // responseSize is BigInt — make it JSON-safe.
  return { ...run, responseSize: run.responseSize != null ? Number(run.responseSize) : null };
}

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async listRecent(p: Principal, limit = 50, statuses?: RunStatusKey[]) {
    const where: Prisma.JobRunWhereInput =
      statuses && statuses.length > 0 ? { status: { in: statuses } } : {};
    const runs = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.findMany({
        where,
        select: { ...LIST_SELECT, job: { select: { name: true } } },
        orderBy: { scheduledAt: 'desc' },
        take: Math.min(limit, 200),
      }),
    );
    return runs.map(serialize);
  }

  /**
   * Re-run a past execution: creates a fresh QUEUED run for the same job and
   * pushes it onto the execution queue (attempt 1, as a brand-new attempt).
   * Only terminal-failure runs may be replayed.
   */
  async replay(p: Principal, runId: string) {
    const run = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.findUnique({ where: { id: runId }, select: { id: true, jobId: true, status: true } }),
    );
    if (!run) throw new NotFoundException('Run not found');
    if (!REPLAYABLE.has(run.status as RunStatusKey)) {
      throw new BadRequestException(`Only failed runs can be replayed (this one is ${run.status})`);
    }
    // Make sure the job still exists before enqueuing.
    const job = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.findUnique({ where: { id: run.jobId }, select: { id: true } }),
    );
    if (!job) throw new NotFoundException('The job for this run no longer exists');

    const fresh = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.create({
        data: { jobId: run.jobId, tenantId: p.tenantId, status: 'QUEUED', scheduledAt: new Date() },
        select: LIST_SELECT,
      }),
    );
    // Enqueue AFTER the row is committed, so a Redis hiccup can never orphan it
    // (the scheduler's reaper re-enqueues any QUEUED run left behind).
    await this.queue.enqueue(
      { runId: fresh.id, jobId: run.jobId, tenantId: p.tenantId, attempt: 1 },
      { perTenantKey: p.tenantId },
    );
    return serialize(fresh);
  }

  /** Replay several runs; best-effort, reporting which succeeded. */
  async replayMany(p: Principal, runIds: string[]) {
    const replayed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of runIds) {
      try {
        const fresh = await this.replay(p, id);
        replayed.push(fresh.id);
      } catch (err: any) {
        failed.push({ id, error: String(err?.message ?? err) });
      }
    }
    return { replayed, failed };
  }

  async listForJob(p: Principal, jobId: string, limit = 50) {
    const runs = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.findMany({
        where: { jobId },
        select: LIST_SELECT,
        orderBy: { scheduledAt: 'desc' },
        take: Math.min(limit, 200),
      }),
    );
    return runs.map(serialize);
  }

  async get(p: Principal, id: string) {
    const run = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.findUnique({ where: { id }, select: LIST_SELECT }),
    );
    if (!run) throw new NotFoundException('Run not found');
    return serialize(run);
  }

  /**
   * Load the full response body. Small payloads are inline (gzipped) in
   * Postgres; larger ones live in object storage and are streamed through.
   * Returns a Buffer here for simplicity — the controller streams it.
   */
  async getResponseBody(p: Principal, id: string): Promise<{ contentType: string; body: Buffer }> {
    const run = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.findUnique({
        where: { id },
        select: { contentType: true, responseInline: true, storageKey: true },
      }),
    );
    if (!run) throw new NotFoundException('Run not found');
    const contentType = run.contentType ?? 'application/octet-stream';

    if (run.responseInline) {
      return { contentType, body: gunzipSync(Buffer.from(run.responseInline)) };
    }
    if (run.storageKey) {
      // The body was offloaded to object storage. If the backing object is gone
      // (pruned by retention, or never written for demo/seed rows) a raw read
      // throws ENOENT — surface a clean 404 instead of a 500 so the console can
      // show a helpful message rather than "Internal server error".
      try {
        const gz = await getStorage().getBuffer(run.storageKey);
        return { contentType, body: gunzipSync(gz) };
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new NotFoundException(
            'Response body is no longer available — it was pruned by retention or never stored.',
          );
        }
        throw err;
      }
    }
    return { contentType: 'text/plain', body: Buffer.from('(no response recorded)') };
  }
}
