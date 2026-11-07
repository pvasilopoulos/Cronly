'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api, ApiError, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { pushSupported, currentSubscription, enablePush, disablePush } from '@/lib/push';
import type { NotificationPrefs } from '@/lib/types';

// A short, friendly list of common IANA zones; the user can also type any zone.
const TZ_SUGGESTIONS = [
  'Europe/Athens',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'UTC',
];

/**
 * Per-user notification policy: which events reach me, whether desktop popups
 * are on, and a quiet-hours window during which in-app notifications are
 * suppressed. These are personal to each member within the active workspace.
 */
export function NotificationPrefPanel() {
  const { activeTenant } = useAuth();
  const { data, mutate } = useSWR<NotificationPrefs>(
    activeTenant ? ['/notifications/prefs', activeTenant.id] : null,
    ([p]: [string]) => fetcher<NotificationPrefs>(p),
  );

  const [events, setEvents] = useState<string[]>([]);
  const [browser, setBrowser] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [quietTz, setQuietTz] = useState('Europe/Athens');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  // Web Push (mobile/desktop push even when the app is closed) — per device.
  const [pushReady, setPushReady] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!pushSupported()) {
        if (active) setPushReady(true);
        return;
      }
      const sub = await currentSubscription();
      if (active) {
        setPushOn(!!sub);
        setPushReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function togglePush() {
    setPushBusy(true);
    setPushErr(null);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
      } else {
        await enablePush();
        setPushOn(true);
      }
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : 'Could not change push notifications');
    } finally {
      setPushBusy(false);
    }
  }

  useEffect(() => {
    if (!data) return;
    setEvents(data.events);
    setBrowser(data.browser);
    setQuiet(!!(data.quietStart && data.quietEnd));
    if (data.quietStart) setQuietStart(data.quietStart);
    if (data.quietEnd) setQuietEnd(data.quietEnd);
    setQuietTz(data.quietTz || 'Europe/Athens');
  }, [data]);

  if (!data) return null;

  function toggleEvent(key: string) {
    setEvents((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api('/notifications/prefs', {
        method: 'PUT',
        body: {
          events,
          browser,
          quietStart: quiet ? quietStart : null,
          quietEnd: quiet ? quietEnd : null,
          quietTz,
        },
      });
      mutate();
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save your notification policy');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setErr(null);
    try {
      await api('/notifications/test', { method: 'POST' });
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send a test notification');
    } finally {
      setTesting(false);
    }
  }

  const sevTone: Record<string, string> = {
    CRITICAL: 'text-err',
    WARNING: 'text-warn',
    INFO: 'text-accent',
  };

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">My notifications</h2>
        <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] font-medium text-muted">
          Personal
        </span>
      </div>
      <p className="mb-4 text-xs text-muted">
        Choose which events reach you in this workspace, whether to show desktop popups, and a
        quiet-hours window to mute them. These settings are yours alone.
      </p>

      {/* Which events */}
      <h3 className="mb-2 text-xs font-semibold text-fg">Notify me when…</h3>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {data.catalog.map((c) => {
          const checked = events.includes(c.key);
          return (
            <label
              key={c.key}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${
                checked ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface2/50'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleEvent(c.key)}
                className="h-4 w-4 accent-accent"
              />
              <span className="flex-1">{c.label}</span>
              <span className={`text-[10px] font-semibold uppercase ${sevTone[c.severity] ?? 'text-faint'}`}>
                {c.severity}
              </span>
            </label>
          );
        })}
      </div>

      {/* Desktop popups */}
      <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface2/50 px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={browser}
          onChange={(e) => setBrowser(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        <span className="flex-1">
          Show desktop popups
          <span className="block text-[11px] text-faint">
            Native browser notifications when the app is open (you&apos;ll be asked to allow them once).
          </span>
        </span>
      </label>

      {/* Mobile / desktop push — per device, works even when the app is closed */}
      <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-line bg-surface2/50 px-3 py-2 text-sm">
        <span className="flex-1">
          Push to this device
          <span className="block text-[11px] text-faint">
            {pushSupported()
              ? 'Get notifications on this device even when CronApp is closed (mobile & desktop).'
              : 'This browser does not support push notifications.'}
          </span>
          {pushErr && <span className="mt-1 block text-[11px] text-err">{pushErr}</span>}
        </span>
        {pushReady && pushSupported() && (
          <button
            type="button"
            onClick={togglePush}
            disabled={pushBusy}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
              pushOn ? 'border border-line text-muted hover:bg-surface2' : 'bg-accent text-white'
            }`}
          >
            {pushBusy ? '…' : pushOn ? 'Disable' : 'Enable push'}
          </button>
        )}
      </div>

      {/* Quiet hours */}
      <label className="mt-2 flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface2/50 px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={quiet}
          onChange={(e) => setQuiet(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        <span className="flex-1">
          Quiet hours
          <span className="block text-[11px] text-faint">
            Suppress notifications during a daily window (overnight windows are supported).
          </span>
        </span>
      </label>

      {quiet && (
        <div className="mt-2 grid gap-3 rounded-lg border border-line bg-surface2/30 p-3 sm:grid-cols-3">
          <label className="text-xs">
            <span className="mb-1 block text-faint">From</span>
            <input
              type="time"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-faint">To</span>
            <input
              type="time"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-faint">Timezone</span>
            <input
              list="cronapp-tz-list"
              value={quietTz}
              onChange={(e) => setQuietTz(e.target.value)}
              className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <datalist id="cronapp-tz-list">
              {TZ_SUGGESTIONS.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </label>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
        <button
          type="button"
          disabled={testing}
          onClick={sendTest}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-surface2 disabled:opacity-50"
        >
          {testing ? 'Sending…' : 'Send test notification'}
        </button>
        {err && <span className="text-sm text-err">{err}</span>}
        {savedAt > 0 && !err && !saving && !testing && <span className="text-sm text-ok">Saved</span>}
      </div>
    </section>
  );
}
