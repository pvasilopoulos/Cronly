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
   * Per-job run metrics for a dashboard: one bucket per UTC day over the last
   * `days`, plus headline totals. Raw SQL carries its own tenant predicate (raw
   * queries are not auto-fenced).
   */
  async metricsForJob(p: Principal, jobId: string, days = 7) {
    const span = Math.min(Math.max(days, 1), 90);
    const since = new Date(Date.now() - span * 24 * 3600 * 1000);
    const rows = await this.prisma.client.$queryRaw<
      { day: string; status: string; c: bigint; avgMs: number | null }[]
    >(Prisma.sql`
      SELECT DATE(scheduledAt) AS day, status, COUNT(*) AS c, AVG(durationMs) AS avgMs
      FROM JobRun
      WHERE tenantId = ${p.tenantId} AND jobId = ${jobId} AND scheduledAt >= ${since}
      GROUP BY day, status
      ORDER BY day ASC
    `);

    const FAIL = new Set(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);
    const byDay = new Map<string, { total: number; success: number; warning: number; failed: number; durSum: number; durN: number }>();
    for (const r of rows) {
      const key = typeof r.day === 'string' ? r.day : new Date(r.day as any).toISOString().slice(0, 10);
      const b = byDay.get(key) ?? { total: 0, success: 0, warning: 0, failed: 0, durSum: 0, durN: 0 };
      const n = Number(r.c);
      b.total += n;
      if (r.status === 'SUCCESS') b.success += n;
      else if (r.status === 'WARNING') b.warning += n;
      else if (FAIL.has(r.status)) b.failed += n;
      if (r.avgMs != null) {
        b.durSum += Number(r.avgMs) * n;
        b.durN += n;
      }
      byDay.set(key, b);
    }

    // Emit a contiguous series (zero-filled) so the chart has no gaps.
    const buckets: {
      day: string;
      total: number;
      success: number;
      warning: number;
      failed: number;
      avgMs: number | null;
    }[] = [];
    const cursor = new Date(since);
    cursor.setUTCHours(0, 0, 0, 0);
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      const b = byDay.get(key);
      buckets.push({
        day: key,
        total: b?.total ?? 0,
        success: b?.success ?? 0,
        warning: b?.warning ?? 0,
        failed: b?.failed ?? 0,
        avgMs: b && b.durN > 0 ? Math.round(b.durSum / b.durN) : null,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const totals = buckets.reduce(
      (a, b) => ({
        total: a.total + b.total,
        success: a.success + b.success,
        warning: a.warning + b.warning,
        failed: a.failed + b.failed,
      }),
      { total: 0, success: 0, warning: 0, failed: 0 },
    );
    const successRate = totals.total > 0 ? Math.round((totals.success / totals.total) * 100) : null;

    return { days: span, totals: { ...totals, successRate }, buckets };
  }

  /**
   * A flat list of runs for export (CSV/JSON). Honours the same filters as the
   * runs list, capped so an export can never be unbounded.
   */
  async exportRuns(
    p: Principal,
    opts: { jobId?: string; statuses?: RunStatusKey[]; days?: number; limit?: number },
  ) {
    const where: Prisma.JobRunWhereInput = {};
    if (opts.jobId) where.jobId = opts.jobId;
    if (opts.statuses && opts.statuses.length > 0) where.status = { in: opts.statuses };
    if (opts.days && opts.days > 0) {
      where.scheduledAt = { gte: new Date(Date.now() - opts.days * 24 * 3600 * 1000) };
    }
    const runs = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.findMany({
        where,
        select: {
          id: true,
          jobId: true,
          status: true,
          attempt: true,
          scheduledAt: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          responseSize: true,
          error: true,
          job: { select: { name: true } },
        },
        orderBy: { scheduledAt: 'desc' },
        take: Math.min(opts.limit ?? 5000, 20000),
      }),
    );
    return runs.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      jobName: r.job?.name ?? '',
      status: r.status,
      attempt: r.attempt,
      scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : '',
      startedAt: r.startedAt ? r.startedAt.toISOString() : '',
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : '',
      durationMs: r.durationMs ?? '',
      responseSize: r.responseSize != null ? Number(r.responseSize) : '',
      error: r.error ?? '',
    }));
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
