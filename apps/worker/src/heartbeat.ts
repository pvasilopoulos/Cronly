import { getPrisma, Prisma } from '@cronapp/database';
import type { TemplateContext } from '@cronapp/templating';
import { deliverToChannel } from '@cronapp/notify';
import { notifyTenant } from './notifications';
import { renderFromRows, type TemplateRow } from './templates';

// Heartbeat (dead-man's-switch) monitor. Runs periodically in the worker — the
// process that already owns alert delivery (SSRF guard + webhook signing). It
// flips a job to MISSING the first time its ping/success window lapses and
// raises one alert per matching channel.
//
// Safe across multiple worker instances: the state transition OK → MISSING is a
// single atomic UPDATE guarded by `heartbeatState = 'OK'` and FOR UPDATE SKIP
// LOCKED, so exactly one instance claims each newly-missed job and alerts once.

interface MissedJob {
  id: string;
  tenantId: string;
  name: string;
  heartbeatIntervalSec: number;
  heartbeatGraceSec: number;
  lastPingAt: Date;
}

export async function monitorHeartbeatsOnce(): Promise<void> {
  const prisma = getPrisma();

  // 1) Atomically claim every job whose window has lapsed, flipping OK → MISSING.
  //    MariaDB has no UPDATE ... RETURNING, so SELECT ... FOR UPDATE SKIP LOCKED
  //    the due jobs, then stamp them in the same transaction. All time math uses
  //    UTC_TIMESTAMP() because lastPingAt is stored UTC (Prisma writes Dates as
  //    UTC); comparing against UTC keeps windows correct on any server timezone.
  const missed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<MissedJob[]>(Prisma.sql`
      SELECT id, tenantId, name, heartbeatIntervalSec, heartbeatGraceSec, lastPingAt
      FROM Job
      WHERE heartbeatEnabled = true
        AND heartbeatState = 'OK'
        AND lastPingAt IS NOT NULL
        AND lastPingAt < UTC_TIMESTAMP() - INTERVAL (heartbeatIntervalSec + heartbeatGraceSec) SECOND
      ORDER BY lastPingAt ASC
      LIMIT 200
      FOR UPDATE SKIP LOCKED
    `);
    if (rows.length > 0) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE Job SET heartbeatState = 'MISSING', heartbeatAlertedAt = UTC_TIMESTAMP()
        WHERE id IN (${Prisma.join(rows.map((r) => r.id))})
      `);
    }
    return rows;
  });

  if (missed.length === 0) return;

  for (const job of missed) {
    try {
      await alertHeartbeatMiss(job);
    } catch (e: any) {
      console.error(`[heartbeat] alert failed for job ${job.id}:`, e?.message ?? e);
    }
  }
  console.log(`[heartbeat] ${missed.length} job(s) flipped to MISSING`);
}

async function alertHeartbeatMiss(job: MissedJob): Promise<void> {
  const prisma = getPrisma();

  // Deliver to the channels the tenant already wired up for this job's alerts
  // (job-specific rules + tenant-wide rules), ignoring run-status filters — a
  // missed heartbeat is its own event, not a run status. Also record an audit
  // entry (system actor) so the miss shows up in the audit log.
  const { channels, templates, fullJob, tenant } = await prisma.$transaction(async (tx) => {
    const rules = await tx.alertRule.findMany({
      where: {
        tenantId: job.tenantId,
        enabled: true,
        OR: [{ jobId: job.id }, { jobId: null }],
        channel: { is: { enabled: true } },
      },
      include: { channel: true },
    });
    await tx.auditLog.create({
      data: {
        tenantId: job.tenantId,
        actorUserId: null,
        action: 'job.heartbeat.missed',
        target: job.id,
        meta: {
          name: job.name,
          intervalSec: job.heartbeatIntervalSec,
          graceSec: job.heartbeatGraceSec,
          lastPingAt: job.lastPingAt,
        } as Prisma.InputJsonValue,
      },
    });
    const fullJob = await tx.job.findUnique({
      where: { id: job.id },
      select: { handler: true, runbookUrl: true, description: true },
    });
    const tenant = await tx.tenant.findUnique({ where: { id: job.tenantId }, select: { name: true } });
    const templates = (await tx.messageTemplate.findMany({ where: { tenantId: job.tenantId } })) as TemplateRow[];
    // Distinct channels (a channel may back several matching rules).
    const byId = new Map<string, any>();
    for (const r of rules) byId.set(r.channel.id, r.channel);
    return { channels: [...byId.values()], templates, fullJob, tenant };
  });

  const overdue = job.heartbeatIntervalSec + job.heartbeatGraceSec;

  const tctx: TemplateContext = {
    event: 'heartbeat.missed',
    severity: 'WARNING',
    job: {
      name: job.name,
      id: job.id,
      handler: fullJob?.handler,
      runbookUrl: fullJob?.runbookUrl,
      description: fullJob?.description,
    },
    heartbeat: { overdueSec: overdue, lastPingAt: job.lastPingAt ? new Date(job.lastPingAt).toISOString() : null },
    tenant: { name: tenant?.name },
    time: new Date().toISOString(),
  };

  // In-app live notification, per-user by policy and independent of channels.
  const inapp = renderFromRows(templates, 'heartbeat.missed', 'INAPP', tctx);
  await notifyTenant(job.tenantId, 'heartbeat.missed', {
    title: inapp.subject || `Job "${job.name}" missed its heartbeat`,
    body: inapp.body,
    jobId: job.id,
  });

  if (channels.length === 0) return;

  for (const channel of channels) {
    const rendered = renderFromRows(templates, 'heartbeat.missed', channel.type, tctx);
    await deliverToChannel(channel, rendered).catch((e) =>
      console.error(`[heartbeat] delivery failed (channel ${channel.id}):`, e?.message ?? e),
    );
  }
}
