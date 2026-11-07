import { getPrisma, jsonArray } from '@cronapp/database';
import { sendPush, type PushSub } from './push';

// Per-user notification fan-out. When an event fires, every ACTIVE member of the
// tenant whose policy (NotificationPref) includes that event — and who is not in
// their quiet-hours window — gets an in-app Notification row. A member with no
// policy row uses the defaults (all events on, no quiet hours). The console
// polls these and raises browser popups client-side.

const DEFAULT_EVENTS = ['job.failed', 'job.timeout', 'job.dead_letter', 'heartbeat.missed'];
const SEVERITY: Record<string, string> = {
  'job.failed': 'CRITICAL',
  'job.timeout': 'CRITICAL',
  'job.dead_letter': 'CRITICAL',
  'heartbeat.missed': 'WARNING',
  'response.2xx': 'INFO',
  'response.3xx': 'INFO',
  'response.4xx': 'WARNING',
  'response.5xx': 'CRITICAL',
};

export interface NotifyPayload {
  title: string;
  body?: string;
  jobId?: string;
  runId?: string;
}

export interface NotifyOptions {
  /** Deliver to every active member regardless of their event policy / quiet
   *  hours. Used for the daily digest, which is an explicit opt-in per tenant. */
  ignorePolicy?: boolean;
  /** Override the stored severity for this notification. */
  severity?: string;
}

/** HH:MM in the given IANA timezone. */
function nowHHMM(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  }
}

function inQuietHours(start: string | null, end: string | null, tz: string | null): boolean {
  if (!start || !end) return false;
  const cur = nowHHMM(tz || 'Europe/Athens');
  // Inclusive of start, exclusive of end; handles overnight windows (e.g. 22:00→07:00).
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

export async function notifyTenant(
  tenantId: string,
  event: string,
  payload: NotifyPayload,
  opts: NotifyOptions = {},
): Promise<void> {
  const prisma = getPrisma();
  try {
    // Phase 1 (atomic): decide recipients by policy, write the in-app rows, and
    // collect those users' push subscriptions — all under RLS bypass.
    const subs = await prisma.$transaction(async (tx): Promise<PushSub[]> => {
      const [members, prefs] = await Promise.all([
        tx.membership.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { userId: true } }),
        tx.notificationPref.findMany({ where: { tenantId } }),
      ]);
      const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

      const notified = members.filter((m) => {
        if (opts.ignorePolicy) return true;
        const pref = prefByUser.get(m.userId);
        const events = pref ? jsonArray(pref.events) : DEFAULT_EVENTS;
        if (!events.includes(event)) return false;
        if (pref && inQuietHours(pref.quietStart, pref.quietEnd, pref.quietTz)) return false;
        return true;
      });
      if (notified.length === 0) return [];

      await tx.notification.createMany({
        data: notified.map((m) => ({
          tenantId,
          userId: m.userId,
          type: event,
          severity: opts.severity ?? SEVERITY[event] ?? 'WARNING',
          title: payload.title,
          body: payload.body ?? null,
          jobId: payload.jobId ?? null,
          runId: payload.runId ?? null,
        })),
      });

      const devices = await tx.pushSubscription.findMany({
        where: { userId: { in: notified.map((m) => m.userId) } },
        select: { endpoint: true, p256dh: true, auth: true },
      });
      return devices;
    });

    // Phase 2 (network): deliver Web Push outside the transaction.
    if (subs.length > 0) {
      await sendPush(subs, { title: payload.title, body: payload.body ?? '', tag: event, url: '/' });
    }
  } catch (err: any) {
    console.error(`[notify] fan-out failed (${event}):`, err?.message ?? err);
  }
}
