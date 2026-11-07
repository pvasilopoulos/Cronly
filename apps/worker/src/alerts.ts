import { createHmac } from 'node:crypto';
import { getPrisma, jsonArray } from '@cronapp/database';
import { renderFields, type TemplateChannel, type TemplateContext } from '@cronapp/templating';
import { safeFetch } from './net-guard';
import { sendMail } from './mailer';
import { notifyTenant } from './notifications';
import { renderFromRows, type TemplateRow } from './templates';

// Failure alerting. When a run reaches a terminal failure the worker evaluates
// the tenant's alert rules and delivers to the matching notification channels.
// Delivery uses the SSRF guard, so a channel URL cannot be pointed at internal
// infrastructure.

export type TerminalStatus = 'FAILED' | 'TIMEOUT' | 'DEAD_LETTER';
/** Statuses an alert rule may fire on: terminal failures + completed outcomes. */
export type AlertableStatus = TerminalStatus | 'WARNING' | 'SUCCESS';

const FAILURE = new Set<string>(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);
const TRANSIENT = new Set<string>(['QUEUED', 'RUNNING']);

const EVENT_FOR: Record<AlertableStatus, string> = {
  FAILED: 'job.failed',
  TIMEOUT: 'job.timeout',
  DEAD_LETTER: 'job.dead_letter',
  WARNING: 'job.warning',
  SUCCESS: 'job.success',
};
const SEVERITY_FOR: Record<AlertableStatus, string> = {
  FAILED: 'CRITICAL',
  TIMEOUT: 'CRITICAL',
  DEAD_LETTER: 'CRITICAL',
  WARNING: 'WARNING',
  SUCCESS: 'INFO',
};

export async function maybeAlert(
  tenantId: string,
  jobId: string,
  runId: string,
  status: AlertableStatus,
): Promise<void> {
  const prisma = getPrisma();

  const ctx = await prisma.$transaction(async (tx) => {
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

  const event = EVENT_FOR[status];
  const isFailure = FAILURE.has(status);

  // Per-rule streak: the most-recent *completed* runs whose status the rule
  // watches, counted back from the latest run (ignoring transient QUEUED/RUNNING
  // rows). The current run is recent[0] — it was stamped just before this call —
  // so a streak of N is this run plus N-1 like-statused runs right before it.
  // This generalises the old "consecutive failures" count to any status set, so
  // a SUCCESS rule with threshold 3 fires on three clean runs in a row, etc.
  const streakFor = (onStatuses: Set<string>): number => {
    let n = 0;
    for (const r of ctx.recent) {
      if (TRANSIENT.has(r.status)) continue;
      if (onStatuses.has(r.status)) n++;
      else break;
    }
    return n;
  };

  // One mutable context drives every channel's template for this event; the
  // consecutive count is set per rule just before each delivery.
  const tctx: TemplateContext = {
    event,
    severity: SEVERITY_FOR[status],
    job: {
      name: ctx.job.name,
      id: ctx.job.id,
      handler: ctx.job.handler,
      runbookUrl: ctx.job.runbookUrl,
      description: ctx.job.description,
    },
    run: { id: runId, status, error: ctx.run?.error, attempt: ctx.run?.attempt, durationMs: ctx.run?.durationMs },
    consecutive: streakFor(FAILURE),
    tenant: { name: ctx.tenant?.name },
    time: new Date().toISOString(),
  };

  // In-app live notifications fan out per-user by policy, independent of the
  // tenant's channel alert rules — a member still sees a failure in their bell
  // even when no Slack/email/webhook channel is configured. Only failures fan
  // out here; success/warning notifications would be too noisy per-run and are
  // delivered solely through the explicit alert rules evaluated below.
  if (isFailure) {
    const inapp = renderFromRows(ctx.templates, event, 'INAPP', tctx);
    await notifyTenant(tenantId, event, {
      title: inapp.subject || `Job "${ctx.job.name}" ${status}`,
      body: inapp.body,
      jobId: ctx.job.id,
      runId,
    });
  }

  if (ctx.rules.length === 0) return;

  for (const rule of ctx.rules) {
    const onStatuses = new Set(jsonArray(rule.onStatuses).map(String));
    if (!onStatuses.has(status as string)) continue;
    const streak = streakFor(onStatuses);
    // Failures fire ONCE, exactly when the streak reaches the threshold, so a
    // persistent outage doesn't re-alert on every subsequent run. Success /
    // warning are recurring notifications, so they fire on EVERY matching run
    // once the streak is long enough — with threshold 1 that means "every time".
    const fire = isFailure ? streak === rule.threshold : streak >= rule.threshold;
    if (!fire) continue;
    tctx.consecutive = streak;
    await deliver(rule.channel, {
      tenantId,
      event,
      templates: ctx.templates,
      tctx,
      job: ctx.job,
      runId,
      status,
      consecutive: streak,
      custom: rule.body ? { subject: rule.subject ?? null, body: rule.body } : null,
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
  status: AlertableStatus;
  consecutive: number;
  /** Per-rule message override (AlertRule.subject/body); null → use templates. */
  custom?: { subject: string | null; body: string } | null;
}

async function deliver(channel: any, ev: AlertEvent): Promise<void> {
  // A rule may carry its own message (per-job custom text). When it does, render
  // that with the same engine as the shared templates (JSON-escaped for WEBHOOK);
  // otherwise fall back to the tenant override or the built-in default copy. The
  // channel type maps 1:1 to a template channel key.
  const rendered = ev.custom
    ? renderFields(
        { subject: ev.custom.subject, body: ev.custom.body },
        ev.tctx,
        channel.type as TemplateChannel,
      )
    : renderFromRows(ev.templates, ev.event, channel.type, ev.tctx);
  await deliverToChannel(channel, { subject: rendered.subject ?? null, body: rendered.body });
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

  if (channel.type === 'TELEGRAM') {
    // target = chat id, signingSecret = bot token. Telegram's Bot API is a public
    // host, so the SSRF guard permits it; the token stays server-side.
    const token = channel.signingSecret;
    if (!token) {
      console.error(`[alert:telegram→${channel.target}] no bot token configured on channel`);
      return;
    }
    const text = (rendered.subject ? `${rendered.subject}\n` : '') + rendered.body;
    const res = await safeFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel.target, text, disable_web_page_preview: true }),
    });
    // Telegram answers 2xx with {ok:true}, or 4xx with {ok:false, description}.
    // fetch doesn't throw on 4xx, so a wrong chat id or bot token would fail
    // silently — surface it to the caller's catch (and the worker log) instead.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage failed (${res.status}): ${detail.slice(0, 300)}`);
    }
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
