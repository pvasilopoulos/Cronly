'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { fmtAgo, fmtMs, fmtSize } from '@/lib/format';
import type { Run, RunStatus } from '@/lib/types';
import { usePermissions } from '@/lib/permissions';
import { RunPill, Spinner, EmptyState } from '@/components/ui';
import { ResponseViewer } from '@/components/ResponseViewer';
import { SearchableSelect } from '@/components/SearchableSelect';

const REPLAYABLE: ReadonlySet<RunStatus> = new Set(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);
const OK_STATUSES: ReadonlySet<RunStatus> = new Set(['SUCCESS']);

// Filter chips → the `status` query value (comma-separated), or null for all.
const FILTERS: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'Failures', value: 'FAILED,TIMEOUT,DEAD_LETTER' },
  { label: 'Dead-letter', value: 'DEAD_LETTER' },
  { label: 'Timeout', value: 'TIMEOUT' },
  { label: 'Success', value: 'SUCCESS' },
];

export default function RunsPage() {
  const { can } = usePermissions();
  const canReplay = can('jobs:run');
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [jobFilter, setJobFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const key = filter ? `/runs?limit=100&status=${encodeURIComponent(filter)}` : '/runs?limit=100';
  const { data: runs, isLoading, mutate } = useSWR<Run[]>(key, () => fetcher<Run[]>(key));

  const all = runs ?? [];

  // Distinct jobs present in the current window, for the job filter.
  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of all) if (r.job?.name && !seen.has(r.jobId)) seen.set(r.jobId, r.job.name);
    return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [all]);

  // Client-side search + job filter on top of the server status filter.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (jobFilter && r.jobId !== jobFilter) return false;
      if (q) {
        const hay = `${r.job?.name ?? ''} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, query, jobFilter]);

  // Summary stats over the current status window (not just the visible page).
  const stats = useMemo(() => {
    const total = all.length;
    const ok = all.filter((r) => OK_STATUSES.has(r.status)).length;
    const bad = all.filter((r) => REPLAYABLE.has(r.status)).length;
    const durs = all.map((r) => r.durationMs).filter((d): d is number => typeof d === 'number');
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    return { total, ok, bad, avg, successRate: total ? Math.round((ok / total) * 100) : null };
  }, [all]);

  const filtersActive = !!query || !!jobFilter;
  const selectableOnScreen = useMemo(
    () => filtered.filter((r) => REPLAYABLE.has(r.status)).map((r) => r.id),
    [filtered],
  );

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function replayOne(id: string) {
    setBusy(true);
    setNote(null);
    try {
      await api(`/runs/${id}/replay`, { method: 'POST' });
      setNote('Replayed — a fresh run was queued.');
      setSelected((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      mutate();
    } catch (err: any) {
      setNote(`Replay failed: ${String(err?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function replaySelected() {
    if (selected.size === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await api<{ replayed: string[]; failed: { id: string; error: string }[] }>(
        '/runs/replay',
        { method: 'POST', body: { runIds: [...selected] } },
      );
      const msg = `Queued ${res.replayed.length} run(s)`;
      setNote(res.failed.length ? `${msg}, ${res.failed.length} failed.` : `${msg}.`);
      setSelected(new Set());
      mutate();
    } catch (err: any) {
      setNote(`Bulk replay failed: ${String(err?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }

  const allSelected = selectableOnScreen.length > 0 && selectableOnScreen.every((id) => selected.has(id));

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold md:text-2xl">Executions</h1>
        <p className="text-sm text-muted">Recent runs across all jobs — filter failures and replay them</p>
      </header>

      {/* KPI summary over the current status window */}
      {!isLoading && all.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <RunStat k="Runs" v={`${stats.total}`} />
          <RunStat k="Success rate" v={stats.successRate === null ? '—' : `${stats.successRate}%`} tone={stats.successRate !== null && stats.successRate < 80 ? 'warn' : 'ok'} />
          <RunStat k="Need replay" v={`${stats.bad}`} tone={stats.bad > 0 ? 'err' : undefined} />
          <RunStat k="Avg duration" v={stats.avg === null ? '—' : fmtMs(stats.avg)} />
        </div>
      )}

      {/* Toolbar: status chips + search + job filter */}
      <div className="mb-4 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            return (
              <button
                key={f.label}
                onClick={() => {
                  setFilter(f.value);
                  setSelected(new Set());
                }}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  active ? 'bg-accent text-white' : 'border border-line text-muted hover:border-faint'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by job name or run id…"
              className="w-full rounded-lg border border-line bg-surface2 py-2 pl-8 pr-3 text-sm outline-none focus:border-accent"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-faint hover:text-err"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          {jobOptions.length > 1 && (
            <div className="w-full md:w-56">
              <SearchableSelect
                value={jobFilter}
                onChange={setJobFilter}
                options={jobOptions}
                placeholder="All jobs"
                searchPlaceholder="Filter by job…"
                clearLabel="All jobs"
              />
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between px-0.5">
          <span className="text-[11px] text-faint">
            Showing {filtered.length} of {all.length} run{all.length === 1 ? '' : 's'}
          </span>
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setJobFilter('');
              }}
              className="text-[11px] font-medium text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {note && (
        <div className="mb-4 rounded-lg border border-line bg-surface2 px-3 py-2 text-sm text-muted">{note}</div>
      )}

      {/* Bulk action bar */}
      {canReplay && selected.size > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-soft/60 p-3">
          <span className="text-sm font-medium text-accent-fg">{selected.size} selected</span>
          <div className="flex gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium"
            >
              Clear
            </button>
            <button
              onClick={replaySelected}
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Replaying…' : `Replay ${selected.size}`}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : !runs || runs.length === 0 ? (
        <EmptyState
          title="No executions"
          hint={filter ? 'No runs match this filter.' : 'Runs appear here once jobs start firing.'}
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No runs match your filters" hint="Try clearing the search or job filter." />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-faint">
                  {canReplay && (
                    <th className="px-4 py-3">
                      {selectableOnScreen.length > 0 && (
                        <input
                          type="checkbox"
                          aria-label="Select all replayable"
                          checked={allSelected}
                          onChange={() =>
                            setSelected(allSelected ? new Set() : new Set(selectableOnScreen))
                          }
                          className="h-4 w-4 accent-accent"
                        />
                      )}
                    </th>
                  )}
                  <th className="px-4 py-3 font-semibold">Job</th>
                  <th className="px-4 py-3 font-semibold">Started</th>
                  <th className="px-4 py-3 font-semibold">Duration</th>
                  <th className="px-4 py-3 font-semibold">Response</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  {canReplay && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const replayable = REPLAYABLE.has(r.status);
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setOpenRun(r.id)}
                      className="cursor-pointer border-b border-line last:border-0 hover:bg-surface2"
                    >
                      {canReplay && (
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          {replayable && (
                            <input
                              type="checkbox"
                              aria-label="Select run"
                              checked={selected.has(r.id)}
                              onChange={() => toggle(r.id)}
                              className="h-4 w-4 accent-accent"
                            />
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <div className="font-semibold">{r.job?.name ?? '—'}</div>
                        <code className="font-mono text-[11px] text-muted">#{r.id.slice(-8)}</code>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted">{fmtAgo(r.scheduledAt)}</td>
                      <td className="px-4 py-3 font-mono text-sm tabular-nums">{fmtMs(r.durationMs)}</td>
                      <td className="px-4 py-3 text-sm">
                        <span className="font-mono text-muted">{fmtSize(r.responseSize)}</span>
                        {r.contentType && (
                          <span className="ml-1 text-[11px] text-faint">· {r.contentType.split('/')[1]}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <RunPill status={r.status} />
                      </td>
                      {canReplay && (
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          {replayable && (
                            <button
                              onClick={() => replayOne(r.id)}
                              disabled={busy}
                              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:border-accent hover:text-accent-fg disabled:opacity-60"
                            >
                              ↻ Replay
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 md:hidden">
            {filtered.map((r) => {
              const replayable = REPLAYABLE.has(r.status);
              return (
                <div key={r.id} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
                  <button onClick={() => setOpenRun(r.id)} className="flex flex-col gap-2 text-left">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{r.job?.name ?? '—'}</span>
                      <RunPill status={r.status} />
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-faint">
                      <span>{fmtAgo(r.scheduledAt)}</span>
                      <span className="font-mono">{fmtMs(r.durationMs)}</span>
                      <span className="font-mono">{fmtSize(r.responseSize)}</span>
                    </div>
                  </button>
                  {canReplay && replayable && (
                    <button
                      onClick={() => replayOne(r.id)}
                      disabled={busy}
                      className="self-start rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:border-accent hover:text-accent-fg disabled:opacity-60"
                    >
                      ↻ Replay
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {openRun && <ResponseViewer runId={openRun} onClose={() => setOpenRun(null)} />}
    </div>
  );
}

function RunStat({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'warn' | 'err' }) {
  const toneCls = tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-fg';
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs text-muted">{k}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneCls}`}>{v}</div>
    </div>
  );
}
