'use client';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { fmtAgo, initials } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';

// Group filter chips → an action prefix the API matches with startsWith().
const GROUPS: { label: string; prefix: string | null }[] = [
  { label: 'All', prefix: null },
  { label: 'Jobs', prefix: 'job.' },
  { label: 'Secrets', prefix: 'secret.' },
  { label: 'Alerts', prefix: 'alert.' },
  { label: 'API keys', prefix: 'apikey.' },
  { label: 'Roles', prefix: 'role.' },
  { label: 'Members', prefix: 'member.' },
  { label: 'Logins', prefix: 'user.login' },
];

// Color tone per action verb — green for additive, red for destructive.
function actionTone(action: string): string {
  if (/created|invited|login/.test(action)) return 'text-ok';
  if (/deleted|removed|revoked|disabled/.test(action)) return 'text-err';
  if (/updated|set|run|enabled/.test(action)) return 'text-accent-fg';
  return 'text-muted';
}

function summarizeMeta(meta: Record<string, unknown> | null): string {
  if (!meta || typeof meta !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    if (!val) continue;
    parts.push(`${k}: ${val.length > 60 ? val.slice(0, 57) + '…' : val}`);
  }
  return parts.join(' · ');
}

const PAGE_SIZE = 25;

export default function AuditPage() {
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [actor, setActor] = useState('');
  const [range, setRange] = useState<'all' | '24h' | '7d' | '30d'>('all');
  const [shown, setShown] = useState(PAGE_SIZE);

  const key = group ? `/audit?limit=200&action=${encodeURIComponent(group)}` : '/audit?limit=200';
  const { data: entries, isLoading } = useSWR<AuditEntry[]>(key, () => fetcher<AuditEntry[]>(key));

  // Distinct actors present in the current result set, for the actor dropdown.
  const actorOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries ?? []) {
      if (e.actor) m.set(e.actor.id, e.actor.name ?? e.actor.email ?? e.actor.id);
    }
    return [...m.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [entries]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const win = range === '24h' ? 8.64e7 : range === '7d' ? 6.048e8 : range === '30d' ? 2.592e9 : Infinity;
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter((e) => {
      if (actor && e.actor?.id !== actor) return false;
      if (now - new Date(e.createdAt).getTime() > win) return false;
      if (q) {
        const who = (e.actor?.name ?? e.actor?.email ?? 'system').toLowerCase();
        const hay = `${e.action} ${who} ${summarizeMeta(e.meta)} ${e.target ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, actor, range, query]);

  const total = entries?.length ?? 0;
  const hasFilters = !!query || !!actor || range !== 'all' || !!group;

  // Reset paging whenever the result set changes (new filter/search/fetch).
  useEffect(() => {
    setShown(PAGE_SIZE);
  }, [query, actor, range, group, entries]);

  const visible = filtered.slice(0, shown);

  function clearAll() {
    setQuery('');
    setActor('');
    setRange('all');
    setGroup(null);
  }

  const selectCls =
    'rounded-lg border border-line bg-surface2 px-2.5 py-2 text-sm outline-none focus:border-accent';

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold md:text-2xl">Audit Log</h1>
        <p className="text-sm text-muted">Every change in this workspace — who did what, and when</p>
      </header>

      {/* Group filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {GROUPS.map((g) => {
          const active = group === g.prefix;
          return (
            <button
              key={g.label}
              onClick={() => setGroup(g.prefix)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                active ? 'bg-accent text-white' : 'border border-line text-muted hover:border-faint'
              }`}
            >
              {g.label}
            </button>
          );
        })}
      </div>

      {/* Search + actor + range toolbar */}
      <div className="mb-4 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
          <div className="relative min-w-0 flex-1 md:min-w-[220px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search action, actor or details…"
              className="w-full rounded-lg border border-line bg-surface2 py-2 pl-8 pr-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <select value={actor} onChange={(e) => setActor(e.target.value)} className={selectCls} title="Actor">
            <option value="">All actors</option>
            {actorOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as typeof range)}
            className={selectCls}
            title="Time range"
          >
            <option value="all">All time</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <div className="flex items-center gap-3 md:ml-auto">
            <span className="text-xs text-muted">
              Showing {visible.length} of {filtered.length}
              {filtered.length !== total && <span className="text-faint"> · {total} total</span>}
            </span>
            {hasFilters && (
              <button onClick={clearAll} className="text-xs font-medium text-accent-fg hover:underline">
                Clear filters
              </button>
            )}
          </div>
        </div>
      </div>

      {isLoading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No activity"
          hint={hasFilters ? 'No events match these filters.' : 'Actions appear here as your team works.'}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-4 py-3 font-semibold">When</th>
                  <th className="px-4 py-3 font-semibold">Actor</th>
                  <th className="px-4 py-3 font-semibold">Action</th>
                  <th className="px-4 py-3 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => {
                  const tone = actionTone(e.action);
                  const who = e.actor?.name ?? e.actor?.email ?? 'System';
                  return (
                    <tr key={e.id} className="border-b border-line last:border-0 align-top">
                      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap" title={new Date(e.createdAt).toLocaleString()}>
                        {fmtAgo(e.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="grid h-6 w-6 flex-none place-items-center rounded-full border border-line bg-surface2 text-[10px] font-semibold">
                            {e.actor ? initials(who) : '⚙'}
                          </span>
                          <span className="text-sm font-medium">{who}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-mono text-xs font-semibold ${tone}`}>{e.action}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted">
                        {summarizeMeta(e.meta) || <span className="text-faint">—</span>}
                        {e.target && (
                          <code className="ml-1 font-mono text-[11px] text-faint">#{e.target.slice(-8)}</code>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {visible.map((e) => {
              const tone = actionTone(e.action);
              const who = e.actor?.name ?? e.actor?.email ?? 'System';
              const details = summarizeMeta(e.meta);
              return (
                <div key={e.id} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-mono text-xs font-semibold ${tone}`}>{e.action}</span>
                    <span className="text-[11px] text-faint whitespace-nowrap">{fmtAgo(e.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="grid h-5 w-5 flex-none place-items-center rounded-full border border-line bg-surface2 text-[9px] font-semibold">
                      {e.actor ? initials(who) : '⚙'}
                    </span>
                    <span className="font-medium">{who}</span>
                  </div>
                  {details && <p className="text-[13px] text-muted">{details}</p>}
                </div>
              );
            })}
          </div>

          {/* Pagination — incremental "show more" */}
          {visible.length < filtered.length && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => setShown((n) => n + PAGE_SIZE)}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-faint"
              >
                Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
              </button>
              {filtered.length - visible.length > PAGE_SIZE && (
                <button
                  onClick={() => setShown(filtered.length)}
                  className="text-xs font-medium text-accent-fg hover:underline"
                >
                  Show all {filtered.length}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
