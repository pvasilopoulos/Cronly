import { createHmac } from 'node:crypto';
import { getPrisma } from '@cronapp/database';
import type { TemplateContext } from '@cronapp/templating';
import { safeFetch } from './net-guard';
import { sendMail } from './mailer';
import { notifyTenant } from './notifications';
import { renderFromRows, type TemplateRow } from './templates';

// Failure alerting. When a run reaches a terminal failure the worker evaluates
// the tenant's alert rules and delivers to the matching notification channels.
// Delivery uses the SSRF guard, so a channel URL cannot be pointed at internal
// infrastructure.

export type TerminalStatus = 'FAILED' | 'TIMEOUT' | 'DEAD_LETTER';
const TERMINAL = new Set<string>(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);

export async function maybeAlert(
  tenantId: string,
  jobId: string,
  runId: string,
  status: TerminalStatus,
): Promise<void> {
  const prisma = getPrisma();

  const ctx = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const job = await tx.job.findUnique({ where: { id: jobId } });
    const rules = await tx.alertRule.findMany({
      where: {
        tenantId,
        enabled: true,
        OR: [{ jobId }, { jobId: null }],
        channel: { is: { enabled: true } },
      },
      include: { channel: true },
    });
    const recent = await tx.jobRun.findMany({
      where: { jobId },
      orderBy: { scheduledAt: 'desc' },
      take: 50,
      select: { status: true },
    });
    // For template variables: this run's details, the workspace name, and the
    // tenant's message-text overrides (if any).
    const run = await tx.jobRun.findUnique({
      where: { id: runId },
      select: { error: true, attempt: true, durationMs: true },
    });
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const templates = (await tx.messageTemplate.findMany({ where: { tenantId } })) as TemplateRow[];
    return { job, rules, recent, run, tenant, templates };
  });

  if (!ctx.job) return;

  // Consecutive terminal failures counting back from the latest run.
  let consecutive = 0;
  for (const r of ctx.recent) {
    if (TERMINAL.has(r.status)) consecutive++;
    else break;
  }

  const event =
    status === 'TIMEOUT' ? 'job.timeout' : status === 'DEAD_LETTER' ? 'job.dead_letter' : 'job.failed';

  // One context drives every channel's template for this failure.
  const tctx: TemplateContext = {
    event,
    severity: 'CRITICAL',
    job: {
      name: ctx.job.name,
      id: ctx.job.id,
      handler: ctx.job.handler,
      runbookUrl: ctx.job.runbookUrl,
      description: ctx.job.description,
    },
    run: { id: runId, status, error: ctx.run?.error, attempt: ctx.run?.attempt, durationMs: ctx.run?.durationMs },
    consecutive,
    tenant: { name: ctx.tenant?.name },
    time: new Date().toISOString(),
  };

  // In-app live notifications fan out per-user by policy, independent of the
  // tenant's channel alert rules — a member still sees a failure in their bell
  // even when no Slack/email/webhook channel is configured. The INAPP template
  // (override or default) supplies the title + body.
  const inapp = renderFromRows(ctx.templates, event, 'INAPP', tctx);
  await notifyTenant(tenantId, event, {
    title: inapp.subject || `Job "${ctx.job.name}" ${status}`,
    body: inapp.body,
    jobId: ctx.job.id,
    runId,
  });

  if (ctx.rules.length === 0) return;

  for (const rule of ctx.rules) {
    if (!rule.onStatuses.includes(status as never)) continue;
    // Fire exactly when the streak crosses the threshold (avoids repeat spam).
    if (consecutive !== rule.threshold) continue;
    await deliver(rule.channel, {
      tenantId,
      event,
      templates: ctx.templates,
      tctx,
      job: ctx.job,
      runId,
      status,
      consecutive,
    }).catch((e) =>
      console.error(`[alert] delivery failed (channel ${rule.channelId}):`, e?.message ?? e),
    );
  }
}

interface AlertEvent {
  tenantId: string;
  event: string;
  templates: TemplateRow[];
  tctx: TemplateContext;
  job: { id: string; name: string; runbookUrl?: string | null; description?: string | null };
  runId: string;
  status: TerminalStatus;
  consecutive: number;
}

async function deliver(channel: any, ev: AlertEvent): Promise<void> {
  // Render the per-channel template (override or default) for this failure and
  // deliver it. The channel type (EMAIL/SLACK/WEBHOOK) maps 1:1 to a template
  // channel key.
  const rendered = renderFromRows(ev.templates, ev.event, channel.type, ev.tctx);
  await deliverToChannel(channel, rendered);
}

/**
 * Deliver one already-rendered message to a notification channel. Shared by
 * run-failure alerts and heartbeat-miss alerts so both honour the same SSRF
 * guard and webhook signing. For SLACK/EMAIL `body` is the text; for WEBHOOK
 * `body` is the full JSON payload string (HMAC-signed with the channel's signing
 * secret when set). `subject` is the email subject line.
 */
export async function deliverToChannel(
  channel: any,
  rendered: { subject: string | null; body: string },
): Promise<void> {
  if (channel.type === 'SLACK') {
    await safeFetch(channel.target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: rendered.body }),
    });
    return;
  }

  if (channel.type === 'WEBHOOK') {
    // The webhook body is the tenant's own JSON template, rendered. Sign the
    // exact bytes we send so a receiver can verify integrity.
    const body = rendered.body;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (channel.signingSecret) {
      headers['x-cronapp-signature'] =
        'sha256=' + createHmac('sha256', channel.signingSecret).update(body).digest('hex');
    }
    await safeFetch(channel.target, { method: 'POST', headers, body });
    return;
  }

  if (channel.type === 'EMAIL') {
    // Deliver through the shared SMTP transport. Without SMTP_HOST configured
    // this is a dry-run (composed, logged, not sent) so alerting still works
    // end-to-end in dev without a mail server.
    const res = await sendMail({
      to: channel.target,
      subject: rendered.subject || 'CronApp alert',
      text: rendered.body,
    });
    console.log(
      res.mode === 'sent'
        ? `[alert:email→${channel.target}] sent (${res.messageId})`
        : `[alert:email→${channel.target}] dry-run (no SMTP configured): ${rendered.body}`,
    );
    return;
  }
}
