// Web Push enrolment for the current browser/device. Registers the service
// worker, subscribes with the server's VAPID public key, and records the
// subscription server-side so the worker can deliver pushes even when the app
// is closed. All calls are no-ops / throw clear errors when push is unsupported.
import { api } from './api';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js');
}

/** Is this device currently subscribed to push? */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Request permission, subscribe, and register the subscription with the server. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Push is not supported in this browser.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted.');

  const { publicKey } = await api<{ publicKey: string | null }>('/notifications/vapid', { tenant: false });
  if (!publicKey) throw new Error('Push is not configured on the server.');

  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  await api('/notifications/push/subscribe', {
    method: 'POST',
    tenant: false,
    body: { endpoint: sub.endpoint, keys: json.keys, ua: navigator.userAgent },
  });
}

/** Unsubscribe this device and drop the server-side record. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/notifications/push/unsubscribe', {
    method: 'POST',
    tenant: false,
    body: { endpoint: sub.endpoint },
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
