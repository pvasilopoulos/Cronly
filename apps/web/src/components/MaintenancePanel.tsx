'use client';
import { useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, ApiError, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { Spinner } from '@/components/ui';

interface MaintenanceWindow {
  id: string;
  label: string | null;
  startsAt: string;
  endsAt: string;
}

const KEY = '/maintenance/windows';

// datetime-local <-> ISO helpers (local wall-clock in the browser's timezone).
function toLocal(iso: string): string {
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}
function toIso(local: string): string {
  return new Date(local).toISOString();
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function MaintenancePanel() {
  const { can } = usePermissions();
  const canView = can('jobs:read');
  const canManage = can('jobs:toggle');
  const { data, isLoading } = useSWR<MaintenanceWindow[]>(canView ? KEY : null, () =>
    fetcher<MaintenanceWindow[]>(KEY),
  );

  const [label, setLabel] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canView) return null;

  const now = Date.now();
  const windows = data ?? [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!startsAt || !endsAt) {
      setError('Pick a start and end time.');
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      setError('The end must be after the start.');
      return;
    }
    setBusy(true);
    try {
      await api(KEY, {
        method: 'POST',
        body: { label: label.trim() || undefined, startsAt: toIso(startsAt), endsAt: toIso(endsAt) },
      });
      setLabel('');
      setStartsAt('');
      setEndsAt('');
      globalMutate(KEY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the window');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`${KEY}/${id}`, { method: 'DELETE' });
    globalMutate(KEY);
  }

  function state(w: MaintenanceWindow): { label: string; cls: string } {
    const s = new Date(w.startsAt).getTime();
    const e = new Date(w.endsAt).getTime();
    if (now >= s && now <= e) return { label: 'Active', cls: 'bg-warn/15 text-warn' };
    if (now < s) return { label: 'Scheduled', cls: 'bg-accent-soft text-accent-fg' };
    return { label: 'Past', cls: 'bg-surface2 text-faint' };
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-faint">Maintenance windows</h2>
      <p className="mb-4 text-xs text-muted">
        During a window, every job in this workspace is paused — the scheduler skips those runs and never fires a
        backlog when the window ends. Pause or resume a single job from its own ▶/⏸ control instead.
      </p>

      {isLoading ? (
        <Spinner />
      ) : windows.length === 0 ? (
        <p className="mb-4 rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-faint">
          No maintenance windows scheduled.
        </p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {windows.map((w) => {
            const st = state(w);
            return (
              <li
                key={w.id}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface2/50 px-3 py-2 text-sm"
              >
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
                <div className="min-w-0 flex-1">
                  {w.label && <div className="truncate font-medium">{w.label}</div>}
                  <div className="text-xs text-muted">
                    {fmt(w.startsAt)} → {fmt(w.endsAt)}
                  </div>
                </div>
                {canManage && (
                  <button onClick={() => remove(w.id)} className="flex-none text-xs font-medium text-err hover:underline">
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <form onSubmit={create} className="border-t border-line pt-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="text-xs font-medium text-muted">Label (optional)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                placeholder="e.g. Database upgrade"
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted">Start</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted">End</span>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
          </div>
          {error && <p className="mt-2 rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !startsAt || !endsAt}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Scheduling…' : 'Schedule window'}
            </button>
            <button
              type="button"
              onClick={() => {
                const s = new Date();
                const e = new Date(Date.now() + 2 * 3600 * 1000);
                setStartsAt(toLocal(s.toISOString()));
                setEndsAt(toLocal(e.toISOString()));
              }}
              className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-muted hover:border-faint"
            >
              Next 2 hours
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
