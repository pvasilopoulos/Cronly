'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtAgo } from '@/lib/format';
import type { NotificationList, NotificationPrefs, Notification } from '@/lib/types';

const SEV_DOT: Record<string, string> = {
  CRITICAL: 'bg-red-500',
  WARNING: 'bg-amber-500',
  INFO: 'bg-sky-500',
};

/**
 * Live notification bell. Polls the per-user feed, shows an unread badge, and
 * raises native browser popups for newly-arrived unread items (when the user
 * granted permission and left browser notifications on in their policy). The
 * server has already applied the WHEN/WHICH policy, so the client only gates on
 * browser permission + the browser toggle.
 */
export function NotificationBell() {
  const { activeTenant } = useAuth();
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('unsupported');

  // Feed — polled every 15s, re-keyed per tenant so a switch refetches cleanly.
  const { data, mutate } = useSWR<NotificationList>(
    activeTenant ? ['/notifications', activeTenant.id] : null,
    ([p]: [string]) => fetcher<NotificationList>(p),
    { refreshInterval: 15000, revalidateOnFocus: true },
  );
  // Policy — only need the browser toggle here.
  const { data: prefs } = useSWR<NotificationPrefs>(
    activeTenant ? ['/notifications/prefs', activeTenant.id] : null,
    ([p]: [string]) => fetcher<NotificationPrefs>(p),
  );

  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) setPerm(Notification.permission);
  }, []);

  // Browser popups for newly-seen unread notifications. The first load seeds the
  // "seen" set without popping, so a page refresh never fires a burst.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const unreadItems = items.filter((n) => !n.readAt);
    if (seen.current === null) {
      seen.current = new Set(unreadItems.map((n) => n.id));
      return;
    }
    const canPopup =
      perm === 'granted' && prefs?.browser !== false && typeof window !== 'undefined' && 'Notification' in window;
    for (const n of unreadItems) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (canPopup) {
        try {
          new Notification(n.title, { body: n.body ?? undefined, tag: n.id });
        } catch {
          /* ignore */
        }
      }
    }
    // Drop ids that are no longer unread so re-firing can't happen after re-read.
    const live = new Set(unreadItems.map((n) => n.id));
    for (const id of seen.current) if (!live.has(id)) seen.current.delete(id);
  }, [data, items, perm, prefs?.browser]);

  async function enablePopups() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const res = await Notification.requestPermission();
    setPerm(res);
  }

  async function markRead(n: Notification) {
    if (n.readAt) return;
    await api('/notifications/read', { method: 'POST', body: { ids: [n.id] } });
    mutate();
  }
  async function markAll() {
    await api('/notifications/read-all', { method: 'POST' });
    mutate();
  }

  const badge = useMemo(() => (unread > 99 ? '99+' : String(unread)), [unread]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        className="relative rounded-md p-1.5 text-lg leading-none hover:bg-surface2"
      >
        <span aria-hidden>◔</span>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+6px)] z-40 flex w-80 max-w-[88vw] flex-col rounded-lg border border-line bg-surface shadow-xl lg:left-0 lg:right-auto">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <b className="text-sm">Notifications</b>
              {unread > 0 && (
                <button onClick={markAll} className="text-[11px] text-accent hover:underline">
                  Mark all read
                </button>
              )}
            </div>

            {perm === 'default' && (
              <button
                onClick={enablePopups}
                className="border-b border-line bg-accent-soft px-3 py-2 text-left text-[11px] text-accent-fg hover:brightness-95"
              >
                🔔 Enable desktop notifications for failures &amp; missed heartbeats
              </button>
            )}

            <div className="flex max-h-96 flex-col overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-3 py-10 text-center text-xs text-faint">You&apos;re all caught up.</div>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markRead(n)}
                    className={`flex items-start gap-2.5 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-surface2 ${
                      n.readAt ? 'opacity-60' : ''
                    }`}
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 flex-none rounded-full ${SEV_DOT[n.severity] ?? 'bg-faint'} ${
                        n.readAt ? 'opacity-0' : ''
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-snug">{n.title}</span>
                      {n.body && (
                        <span className="mt-0.5 block whitespace-pre-line text-[11px] leading-snug text-muted">
                          {n.body}
                        </span>
                      )}
                      <span className="mt-1 block text-[10px] text-faint">{fmtAgo(n.createdAt)}</span>
                    </span>
                  </button>
                ))
              )}
            </div>

            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="border-t border-line px-3 py-2 text-center text-[11px] text-muted hover:text-fg"
            >
              Notification settings
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
