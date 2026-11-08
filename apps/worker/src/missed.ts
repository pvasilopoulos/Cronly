import { getPrisma, Prisma } from '@cronapp/database';
import type { TemplateContext } from '@cronapp/templating';
import { deliverToChannel } from '@cronapp/notify';
import { notifyTenant } from './notifications';
import { renderFromRows, type TemplateRow } from './templates';

// Missed-schedule monitor. A job's nextRunAt is advanced by the scheduler the
// instant it fires, so a nextRunAt that is well in the past means the scheduler
// NEVER claimed it — the process was down, or a lock was stuck. This runs in the
// worker (which already owns alert delivery: SSRF guard + webhook signing) and
// raises exactly one alert per lapse.
//
// Safe across multiple worker instances: the "flag as alerted" step is a single
// atomic UPDATE guarded by `missedAlertedAt IS NULL` and FOR UPDATE SKIP LOCKED,
// so exactly one instance claims each newly-missed job and alerts once. The flag
// is cleared by the scheduler the moment the job fires again, so a later miss
// re-alerts.

// How overdue (seconds) a run must be before it counts as missed. The default of
// 5 minutes is well clear of the scheduler's 15s tick, so normal operation never
// trips it — only real downtime does.
const MISSED_GRACE_SEC = parseInt(process.env.MISSED_GRACE_SEC ?? '300', 10);

interface MissedJob {
  id: string;
  tenantId: string;
  name: string;
  cronExpr: string;
  nextRunAt: Date;
}

export async function monitorMissedSchedulesOnce(): Promise<void> {
  const prisma = getPrisma();

  // 1) Atomically claim every enabled, active job whose nextRunAt is overdue past
  //    the grace and that we haven't already flagged. Exclude jobs inside a
  //    maintenance window (their runs are intentionally skipped) and jobs outside
  //    their schedule window. All time math uses UTC_TIMESTAMP() because Prisma
  //    stores DateTimes as UTC.
  const missed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<MissedJob[]>(Prisma.sql`
      SELECT id, tenantId, name, cronExpr, nextRunAt
      FROM Job j
      WHERE enabled = true
        AND status = 'ACTIVE'
        AND missedAlertEnabled = true
        AND missedAlertedAt IS NULL
        AND nextRunAt IS NOT NULL
        AND nextRunAt < UTC_TIMESTAMP() - INTERVAL ${MISSED_GRACE_SEC} SECOND
        AND (startsAt IS NULL OR startsAt <= UTC_TIMESTAMP())
        AND (endsAt IS NULL OR endsAt >= UTC_TIMESTAMP())
        AND NOT EXISTS (
          SELECT 1 FROM MaintenanceWindow mw
          WHERE mw.tenantId = j.tenantId
            AND mw.startsAt <= UTC_TIMESTAMP()
            AND mw.endsAt >= UTC_TIMESTAMP()
        )
      ORDER BY nextRunAt ASC
      LIMIT 200
      FOR UPDATE SKIP LOCKED
    `);
    if (rows.length > 0) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE Job SET missedAlertedAt = UTC_TIMESTAMP()
        WHERE id IN (${Prisma.join(rows.map((r) => r.id))})
      `);
    }
    return rows;
  });

  if (missed.length === 0) return;

  for (const job of missed) {
    try {
      await alertMissed(job);
    } catch (e: any) {
      console.error(`[missed] alert failed for job ${job.id}:`, e?.message ?? e);
    }
  }
  console.log(`[missed] ${missed.length} job(s) flagged as missed`);
}

async function alertMissed(job: MissedJob): Promise<void> {
  const prisma = getPrisma();

  // Deliver to the channels this job already wires up for alerts (job-specific +
  // tenant-wide rules), ignoring run-status filters — a missed schedule is its own
  // event, not a run status. Record an audit entry (system actor) too.
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
        action: 'job.schedule.missed',
        target: job.id,
        meta: {
          name: job.name,
          cronExpr: job.cronExpr,
          expectedAt: job.nextRunAt,
        } as Prisma.InputJsonValue,
      },
    });
    const fullJob = await tx.job.findUnique({
      where: { id: job.id },
      select: { handler: true, runbookUrl: true, description: true },
    });
    const tenant = await tx.tenant.findUnique({ where: { id: job.tenantId }, select: { name: true } });
    const templates = (await tx.messageTemplate.findMany({ where: { tenantId: job.tenantId } })) as TemplateRow[];
    const byId = new Map<string, any>();
    for (const r of rules) byId.set(r.channel.id, r.channel);
    return { channels: [...byId.values()], templates, fullJob, tenant };
  });

  const expectedAt = new Date(job.nextRunAt);
  const overdueSec = Math.max(0, Math.round((Date.now() - expectedAt.getTime()) / 1000));

  const tctx: TemplateContext = {
    event: 'job.missed',
    severity: 'WARNING',
    job: {
      name: job.name,
      id: job.id,
      handler: fullJob?.handler,
      runbookUrl: fullJob?.runbookUrl,
      description: fullJob?.description,
    },
    schedule: { expectedAt: expectedAt.toISOString(), overdueSec, cronExpr: job.cronExpr },
    tenant: { name: tenant?.name },
    time: new Date().toISOString(),
  };

  // In-app live notification, per-user by policy and independent of channels.
  const inapp = renderFromRows(templates, 'job.missed', 'INAPP', tctx);
  await notifyTenant(job.tenantId, 'job.missed', {
    title: inapp.subject || `Job "${job.name}" missed its schedule`,
    body: inapp.body,
    jobId: job.id,
  });

  if (channels.length === 0) return;

  for (const channel of channels) {
    const rendered = renderFromRows(templates, 'job.missed', channel.type, tctx);
    await deliverToChannel(channel, rendered).catch((e) =>
      console.error(`[missed] delivery failed (channel ${channel.id}):`, e?.message ?? e),
    );
  }
}
