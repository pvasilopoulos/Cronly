import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

/**
 * Prometheus metrics for the whole stack, exposed from one endpoint on the API.
 *
 * Two kinds of metric live here:
 *  • In-process counters/histograms for the API's own HTTP traffic. These are
 *    cumulative and reset when the API restarts (standard Prometheus counters).
 *  • Cross-process gauges derived from the sources of truth at scrape time —
 *    BullMQ (queue depth) and Postgres (runs, durations, scheduler lag, …). The
 *    worker and scheduler are separate processes, so rather than invent fragile
 *    IPC we read the state they already persist. This also means these numbers
 *    survive a restart of any process and are always consistent.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  // ── In-process HTTP metrics ──
  private readonly httpRequests: Counter<string>;
  private readonly httpDuration: Histogram<string>;

  // ── Scrape-time gauges (set on every /metrics call) ──
  private readonly gUp: Gauge<string>;
  private readonly gJobs: Gauge<string>;
  private readonly gJobsEnabled: Gauge<string>;
  private readonly gRunsByStatus: Gauge<string>;
  private readonly gRunsRunning: Gauge<string>;
  private readonly gRunsLastMinute: Gauge<string>;
  private readonly gRunDuration: Gauge<string>;
  private readonly gHeartbeatMissing: Gauge<string>;
  private readonly gSchedulerLag: Gauge<string>;
  private readonly gQueue: Gauge<string>;
  private readonly gTenants: Gauge<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {
    this.registry.setDefaultLabels({ app: 'cronapp' });
    collectDefaultMetrics({ register: this.registry, prefix: 'cronapp_api_' });

    this.httpRequests = new Counter({
      name: 'cronapp_http_requests_total',
      help: 'Total HTTP requests handled by the API',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'cronapp_http_request_duration_seconds',
      help: 'API request latency in seconds',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.gUp = new Gauge({ name: 'cronapp_up', help: '1 if the API is serving', registers: [this.registry] });
    this.gJobs = new Gauge({ name: 'cronapp_jobs', help: 'Jobs by status', labelNames: ['status'], registers: [this.registry] });
    this.gJobsEnabled = new Gauge({ name: 'cronapp_jobs_enabled', help: 'Enabled jobs', registers: [this.registry] });
    this.gRunsByStatus = new Gauge({ name: 'cronapp_runs_by_status', help: 'All-time job runs by terminal status', labelNames: ['status'], registers: [this.registry] });
    this.gRunsRunning = new Gauge({ name: 'cronapp_runs_running', help: 'Currently RUNNING executions', registers: [this.registry] });
    this.gRunsLastMinute = new Gauge({ name: 'cronapp_runs_last_minute', help: 'Runs scheduled in the last 60s', registers: [this.registry] });
    this.gRunDuration = new Gauge({ name: 'cronapp_run_duration_milliseconds', help: 'Run duration percentiles over the last 5 minutes', labelNames: ['quantile'], registers: [this.registry] });
    this.gHeartbeatMissing = new Gauge({ name: 'cronapp_heartbeat_missing', help: 'Jobs whose heartbeat is MISSING', registers: [this.registry] });
    this.gSchedulerLag = new Gauge({ name: 'cronapp_scheduler_lag_seconds', help: 'How overdue the most-overdue due job is (0 if none due)', registers: [this.registry] });
    this.gQueue = new Gauge({ name: 'cronapp_queue_jobs', help: 'Execution queue depth by state', labelNames: ['state'], registers: [this.registry] });
    this.gTenants = new Gauge({ name: 'cronapp_tenants', help: 'Number of tenants', registers: [this.registry] });
  }

  /** Record one handled HTTP request. */
  observeHttp(method: string, route: string, status: number, seconds: number) {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  /** Refresh dynamic gauges, then render the registry in Prometheus text format. */
  async scrape(): Promise<string> {
    try {
      await this.collectDynamic();
      this.gUp.set(1);
    } catch {
      // A metrics scrape must never 500 the endpoint; report down and move on.
      this.gUp.set(0);
    }
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private async collectDynamic() {
    const [db, counts] = await Promise.all([this.collectFromDb(), this.queue.counts()]);

    // Jobs
    this.gJobs.reset();
    for (const row of db.jobs) this.gJobs.set({ status: row.status }, row.n);
    this.gJobsEnabled.set(db.jobsEnabled);

    // Runs
    this.gRunsByStatus.reset();
    for (const row of db.runs) this.gRunsByStatus.set({ status: row.status }, row.n);
    this.gRunsRunning.set(db.running);
    this.gRunsLastMinute.set(db.lastMinute);

    // Durations
    this.gRunDuration.set({ quantile: '0.5' }, db.p50);
    this.gRunDuration.set({ quantile: '0.95' }, db.p95);
    this.gRunDuration.set({ quantile: '0.99' }, db.p99);

    this.gHeartbeatMissing.set(db.heartbeatMissing);
    this.gSchedulerLag.set(db.schedulerLagSeconds);
    this.gTenants.set(db.tenants);

    // Queue depth
    this.gQueue.reset();
    for (const [state, n] of Object.entries(counts)) this.gQueue.set({ state }, Number(n) || 0);
  }

  private async collectFromDb() {
    // Cross-tenant aggregates: bypass RLS (trusted platform-level read).
    return this.prisma.asSuperAdmin(async (tx) => {
      const n = (v: unknown) => Number(v ?? 0);

      const jobsRows = await tx.$queryRaw<{ status: string; n: bigint }[]>`
        SELECT status AS status, count(*) AS n FROM Job GROUP BY status`;
      const jobsEnabled = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM Job WHERE enabled = true`;
      const runsRows = await tx.$queryRaw<{ status: string; n: bigint }[]>`
        SELECT status AS status, count(*) AS n FROM JobRun GROUP BY status`;
      const lastMinute = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM JobRun WHERE scheduledAt > UTC_TIMESTAMP() - INTERVAL 60 SECOND`;
      const dur = await tx.$queryRaw<{ p50: number | null; p95: number | null; p99: number | null }[]>`
        SELECT
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY durationMs) OVER () AS p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY durationMs) OVER () AS p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY durationMs) OVER () AS p99
        FROM JobRun
        WHERE finishedAt > UTC_TIMESTAMP() - INTERVAL 5 MINUTE AND durationMs IS NOT NULL
        LIMIT 1`;
      const hb = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM Job WHERE heartbeatEnabled = true AND heartbeatState = 'MISSING'`;
      const lag = await tx.$queryRaw<{ secs: number | null }[]>`
        SELECT TIMESTAMPDIFF(SECOND, min(nextRunAt), UTC_TIMESTAMP()) AS secs
        FROM Job WHERE enabled = true AND status = 'ACTIVE' AND nextRunAt IS NOT NULL AND nextRunAt < UTC_TIMESTAMP()`;
      const tenants = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM Tenant`;

      const running = runsRows.find((r) => r.status === 'RUNNING');
      return {
        jobs: jobsRows.map((r) => ({ status: r.status, n: n(r.n) })),
        jobsEnabled: n(jobsEnabled[0]?.n),
        runs: runsRows.map((r) => ({ status: r.status, n: n(r.n) })),
        running: n(running?.n),
        lastMinute: n(lastMinute[0]?.n),
        p50: n(dur[0]?.p50),
        p95: n(dur[0]?.p95),
        p99: n(dur[0]?.p99),
        heartbeatMissing: n(hb[0]?.n),
        schedulerLagSeconds: Math.max(0, n(lag[0]?.secs)),
        tenants: n(tenants[0]?.n),
      };
    });
  }
}
