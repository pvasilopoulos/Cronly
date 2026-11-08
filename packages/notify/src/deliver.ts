import { createHmac } from 'node:crypto';
import { safeFetch } from './net-guard';
import { sendMail } from './mailer';

// Deliver one already-rendered message to a notification channel. Shared by the
// worker (run-failure + heartbeat alerts) and the API (the "send test" button),
// so both honour the same SSRF guard and webhook signing, and both see the same
// errors. For SLACK/EMAIL `body` is the text; for WEBHOOK `body` is the full
// JSON payload string (HMAC-signed with the channel's signing secret when set);
// `subject` is the email subject line (and a prefixed first line for Telegram).

export interface DeliverChannel {
  type: string;
  target: string;
  signingSecret?: string | null;
}

export interface RenderedMessage {
  subject: string | null;
  body: string;
}

/** A human-readable note about the delivery (e.g. an email dry-run). */
export interface DeliverResult {
  info?: string;
}

async function errBody(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).slice(0, 300);
}

export async function deliverToChannel(
  channel: DeliverChannel,
  rendered: RenderedMessage,
): Promise<DeliverResult> {
  if (channel.type === 'SLACK') {
    const res = await safeFetch(channel.target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: rendered.body }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed (${res.status}): ${await errBody(res)}`);
    return {};
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
    const res = await safeFetch(channel.target, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`Webhook failed (${res.status}): ${await errBody(res)}`);
    return {};
  }

  if (channel.type === 'TELEGRAM') {
    // target = chat id, signingSecret = bot token. Telegram's Bot API is a fixed
    // public host, so the SSRF guard permits it; the token stays server-side.
    const token = channel.signingSecret;
    if (!token) throw new Error('No bot token configured on this Telegram channel');
    const text = (rendered.subject ? `${rendered.subject}\n` : '') + rendered.body;
    const res = await safeFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel.target, text, disable_web_page_preview: true }),
    });
    // Telegram answers 2xx with {ok:true}, or 4xx with {ok:false, description}.
    // fetch doesn't throw on 4xx, so a wrong chat id or bot token would fail
    // silently — surface the description instead.
    if (!res.ok) throw new Error(`Telegram sendMessage failed (${res.status}): ${await errBody(res)}`);
    return {};
  }

  if (channel.type === 'EMAIL') {
    // Deliver through the shared SMTP transport. Without a mail config this is a
    // dry-run (composed, not sent) so alerting works end-to-end in dev.
    const res = await sendMail({
      to: channel.target,
      subject: rendered.subject || 'CronApp alert',
      text: rendered.body,
    });
    return {
      info:
        res.mode === 'sent'
          ? `sent (${res.messageId})`
          : 'composed but not sent — no mail transport configured (SmtpConfig / SMTP_HOST)',
    };
  }

  throw new Error(`Unknown channel type: ${channel.type}`);
}
