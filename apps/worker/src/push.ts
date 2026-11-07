import webpush from 'web-push';
import { getPrisma } from '@cronapp/database';

// Web Push delivery. VAPID keys come from the environment; when they are not
// configured, push is simply skipped (in-app notifications still work). A push
// endpoint the service rejects as gone (404/410) is pruned so we stop trying it.

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@cronapp.local';
  if (pub && priv) {
    try {
      webpush.setVapidDetails(subject, pub, priv);
      configured = true;
    } catch (e: any) {
      console.error('[push] invalid VAPID config:', e?.message ?? e);
      configured = false;
    }
  } else {
    configured = false;
  }
  return configured;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  url?: string;
  tag?: string;
}

/** Fire a Web Push to each subscription; prune any that are gone. */
export async function sendPush(subs: PushSub[], payload: PushPayload): Promise<void> {
  if (subs.length === 0 || !ensureConfigured()) return;
  const data = JSON.stringify({
    title: payload.title,
    body: payload.body ?? '',
    url: payload.url ?? '/',
    tag: payload.tag,
  });
  const stale: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
      } catch (err: any) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) stale.push(s.endpoint);
        else console.error(`[push] send failed (${code ?? '?'}):`, err?.body ?? err?.message ?? err);
      }
    }),
  );
  if (stale.length) {
    try {
      const prisma = getPrisma();
      await prisma.pushSubscription.deleteMany({ where: { endpoint: { in: stale } } });
    } catch (e: any) {
      console.error('[push] prune failed:', e?.message ?? e);
    }
  }
}
