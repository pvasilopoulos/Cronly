'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtAgo, fmtMs } from '@/lib/format';
import type { Job, JobDetail, Run, RunStatus, Heartbeat, NotificationChannel } from '@/lib/types';
import { Cron, JobPill, RunPill, Spinner, Toggle, EmptyState } from '@/components/ui';
import { ResponseViewer } from '@/components/ResponseViewer';
import { CronBuilder } from '@/components/CronBuilder';
import { SearchableSelect } from '@/components/SearchableSelect';
import { isValidCron, describeCron } from '@/lib/cron';
import { HANDLER_CATALOG, getHandler, validatePayload, type HandlerDef } from '@cronapp/handlers';

type StatusFilter = 'all' | 'active' | 'paused';
type SortKey = 'name' | 'next' | 'handler';

const UNGROUPED_KEY = '__ungrouped';

function isActive(j: Job): boolean {
  return j.enabled && j.status === 'ACTIVE';
}

/** Group jobs by their group tag. Named groups come first (alphabetical),
 *  with ungrouped jobs collected last under a null key. */
function groupJobs(jobs: Job[]): { group: string | null; jobs: Job[] }[] {
  const map = new Map<string, Job[]>();
  for (const j of jobs) {
    const key = j.group?.trim() || '';
    (map.get(key) ?? map.set(key, []).get(key)!).push(j);
  }
  const named = [...map.entries()]
    .filter(([k]) => k !== '')
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, js]) => ({ group, jobs: js }));
  const ungrouped = map.get('');
  return ungrouped && ungrouped.length ? [...named, { group: null, jobs: ungrouped }] : named;
}

export default function JobsPage() {
  const { can } = usePermissions();
  const { data: jobs, isLoading } = useSWR<Job[]>('/jobs', () => fetcher<Job[]>('/jobs'));
  const [openJob, setOpenJob] = useState<Job | null>(null);
  const [creating, setCreating] = useState(false);
  const [clone, setClone] = useState<JobDetail | null>(null);

  // ── Filters / sort (the console-side toolbar) ──
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [groupFilter, setGroupFilter] = useState('');
  const [handlerFilter, setHandlerFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Jobs currently being queued, and jobs just queued (brief "✓" confirmation).
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<Set<string>>(new Set());

  async function toggle(job: Job) {
    await api(`/jobs/${job.id}/toggle`, { method: 'POST' });
    globalMutate('/jobs');
  }
  async function runNow(job: Job) {
    if (running.has(job.id)) return;
    setRunning((s) => new Set(s).add(job.id));
    try {
      await api(`/jobs/${job.id}/run`, { method: 'POST' });
      // Refresh this job's run history if its drawer is open.
      globalMutate(`/jobs/${job.id}/runs`);
      setQueued((s) => new Set(s).add(job.id));
      setTimeout(() => setQueued((s) => {
        const next = new Set(s);
        next.delete(job.id);
        return next;
      }), 2500);
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(job.id);
        return next;
      });
    }
  }

  const all = jobs ?? [];
  const active = all.filter(isActive).length;
  const allGroupNames = useMemo(
    () => [...new Set(all.map((j) => j.group?.trim()).filter((g): g is string => !!g))].sort(),
    [all],
  );
  const allHandlers = useMemo(() => [...new Set(all.map((j) => j.handler))].sort(), [all]);

  // Apply search + status + group + handler filters, then sort.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = all.filter((j) => {
      if (status === 'active' && !isActive(j)) return false;
      if (status === 'paused' && isActive(j)) return false;
      if (handlerFilter && j.handler !== handlerFilter) return false;
      if (groupFilter) {
        const g = j.group?.trim() || '';
        if (groupFilter === UNGROUPED_KEY ? g !== '' : g !== groupFilter) return false;
      }
      if (q) {
        const hay = `${j.name} ${j.handler} ${j.group ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const cmp: Record<SortKey, (a: Job, b: Job) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      handler: (a, b) => a.handler.localeCompare(b.handler) || a.name.localeCompare(b.name),
      next: (a, b) => {
        const ta = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
        const tb = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
        return ta - tb || a.name.localeCompare(b.name);
      },
    };
    return out.sort(cmp[sortKey]);
  }, [all, query, status, groupFilter, handlerFilter, sortKey]);

  const grouped = groupJobs(filtered);
  const groupCount = new Set(all.map((j) => j.group?.trim()).filter(Boolean)).size;
  const showGroupHeaders = grouped.some((g) => g.group !== null) && grouped.length > 0;
  const filtersActive = !!query || status !== 'all' || !!groupFilter || !!handlerFilter;

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function clearFilters() {
    setQuery('');
    setStatus('all');
    setGroupFilter('');
    setHandlerFilter('');
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold md:text-2xl">Cron Jobs</h1>
          <p className="text-sm text-muted">Scheduled tasks for this workspace</p>
        </div>
        {can('jobs:create') && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            ＋ New Job
          </button>
        )}
      </header>

      {isLoading ? (
        <Spinner />
      ) : !jobs || jobs.length === 0 ? (
        <EmptyState title="No jobs yet" hint={can('jobs:create') ? 'Create your first cron job.' : undefined} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat k="Active" v={`${active}/${jobs.length}`} />
            <Stat k="Paused" v={`${jobs.length - active}`} />
            <Stat k="Handlers" v={`${allHandlers.length}`} />
            <Stat k="Groups" v={`${groupCount}`} />
          </div>

          {/* ── Filter toolbar ── */}
          <JobsToolbar
            query={query}
            onQuery={setQuery}
            status={status}
            onStatus={setStatus}
            groupFilter={groupFilter}
            onGroupFilter={setGroupFilter}
            groups={allGroupNames}
            handlerFilter={handlerFilter}
            onHandlerFilter={setHandlerFilter}
            handlers={allHandlers}
            sortKey={sortKey}
            onSortKey={setSortKey}
            filtersActive={filtersActive}
            onClear={clearFilters}
            shown={filtered.length}
            total={jobs.length}
          />

          {filtered.length === 0 ? (
            <EmptyState title="No jobs match your filters" hint="Try clearing the search or filters." />
          ) : (
          <>
          {/* Desktop/tablet table */}
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-4 py-3 font-semibold">Job</th>
                  <th className="px-4 py-3 font-semibold">Schedule</th>
                  <th className="px-4 py-3 font-semibold">Next run</th>
                  <th className="px-4 py-3 font-semibold">On</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {grouped.map((grp) => (
                  <GroupRows
                    key={grp.group ?? UNGROUPED_KEY}
                    grp={grp}
                    show={showGroupHeaders}
                    collapsed={collapsed.has(grp.group ?? UNGROUPED_KEY)}
                    onToggle={() => toggleCollapse(grp.group ?? UNGROUPED_KEY)}
                  >
                {grp.jobs.map((j) => (
                  <tr key={j.id} className="border-b border-line last:border-0 hover:bg-surface2">
                    <td className="cursor-pointer px-4 py-3" onClick={() => setOpenJob(j)}>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{j.name}</span>
                        {j.heartbeatState === 'MISSING' && (
                          <span className="rounded-full bg-err/15 px-1.5 py-0.5 text-[10px] font-semibold text-err">
                            ♥ missed
                          </span>
                        )}
                      </div>
                      <code className="font-mono text-xs text-muted">{j.handler}</code>
                    </td>
                    <td className="px-4 py-3">
                      <Cron>{j.cronExpr}</Cron>
                      <div className="mt-1 text-[11px] text-faint">{j.timezone}</div>
                    </td>
                    <td className="px-4 py-3">
                      <JobPill status={j.status} enabled={j.enabled} />
                      <div className="mt-1 text-[11px] text-faint">{fmtAgo(j.nextRunAt)}</div>
                    </td>
                    <td className="px-4 py-3">
                      {can('jobs:toggle') ? (
                        <Toggle on={j.enabled} onClick={() => toggle(j)} />
                      ) : (
                        <span className="text-xs text-faint">{j.enabled ? 'on' : 'off'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {can('jobs:run') && (
                        <button
                          onClick={() => runNow(j)}
                          disabled={running.has(j.id)}
                          className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60 ${
                            queued.has(j.id)
                              ? 'border-ok/40 text-ok'
                              : 'border-line hover:border-faint'
                          }`}
                        >
                          {running.has(j.id) ? '…' : queued.has(j.id) ? '✓ Queued' : '▶ Run'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                  </GroupRows>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-4 md:hidden">
            {grouped.map((grp) => {
              const key = grp.group ?? UNGROUPED_KEY;
              const isCollapsed = collapsed.has(key);
              return (
              <div key={key} className="flex flex-col gap-3">
                {showGroupHeaders && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(key)}
                    className="flex items-center gap-2 px-0.5 text-left"
                  >
                    <span className="text-accent">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="text-xs font-semibold uppercase tracking-wide text-faint">
                      {grp.group ?? 'Ungrouped'}
                    </span>
                    <span className="text-[11px] text-faint">· {grp.jobs.length}</span>
                  </button>
                )}
            {!isCollapsed && grp.jobs.map((j) => (
              <div key={j.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-2" onClick={() => setOpenJob(j)}>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{j.name}</span>
                      {j.heartbeatState === 'MISSING' && (
                        <span className="rounded-full bg-err/15 px-1.5 py-0.5 text-[10px] font-semibold text-err">
                          ♥ missed
                        </span>
                      )}
                    </div>
                    <code className="font-mono text-xs text-muted">{j.handler}</code>
                  </div>
                  <JobPill status={j.status} enabled={j.enabled} />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Cron>{j.cronExpr}</Cron>
                  <span className="text-[11px] text-faint">{fmtAgo(j.nextRunAt)}</span>
                  <div className="ml-auto flex items-center gap-2">
                    {can('jobs:run') && (
                      <button
                        onClick={() => runNow(j)}
                        disabled={running.has(j.id)}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60 ${
                          queued.has(j.id) ? 'border-ok/40 text-ok' : 'border-line'
                        }`}
                      >
                        {running.has(j.id) ? '…' : queued.has(j.id) ? '✓' : '▶'}
                      </button>
                    )}
                    {can('jobs:toggle') && <Toggle on={j.enabled} onClick={() => toggle(j)} />}
                  </div>
                </div>
              </div>
            ))}
              </div>
              );
            })}
          </div>
          </>
          )}
        </>
      )}

      {openJob && (
        <JobDrawer
          job={openJob}
          onClose={() => setOpenJob(null)}
          onClone={(detail) => {
            setOpenJob(null);
            setClone(detail);
          }}
        />
      )}
      {(creating || clone) && (
        <CreateJobModal
          knownGroups={grouped.filter((g) => g.group !== null).map((g) => g.group as string)}
          template={clone}
          onClose={() => {
            setCreating(false);
            setClone(null);
          }}
        />
      )}
    </div>
  );
}

/** A group header row plus the job rows beneath it, for the desktop table. The
 *  header is hidden when there are no named groups (nothing to divide), and
 *  clicking it collapses/expands the group. */
function GroupRows({
  grp,
  show,
  collapsed,
  onToggle,
  children,
}: {
  grp: { group: string | null; jobs: Job[] };
  show: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      {show && (
        <tr className="border-b border-line bg-surface2/50">
          <td colSpan={5} className="px-0 py-0">
            <button
              type="button"
              onClick={onToggle}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface2"
            >
              <span className="text-accent transition-transform">{collapsed ? '▸' : '▾'}</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-faint">
                {grp.group ?? 'Ungrouped'}
              </span>
              <span className="rounded-full bg-surface px-1.5 text-[11px] text-faint">{grp.jobs.length}</span>
            </button>
          </td>
        </tr>
      )}
      {!collapsed && children}
    </>
  );
}

/** The filter/search/sort toolbar above the jobs list. */
function JobsToolbar({
  query,
  onQuery,
  status,
  onStatus,
  groupFilter,
  onGroupFilter,
  groups,
  handlerFilter,
  onHandlerFilter,
  handlers,
  sortKey,
  onSortKey,
  filtersActive,
  onClear,
  shown,
  total,
}: {
  query: string;
  onQuery: (v: string) => void;
  status: StatusFilter;
  onStatus: (v: StatusFilter) => void;
  groupFilter: string;
  onGroupFilter: (v: string) => void;
  groups: string[];
  handlerFilter: string;
  onHandlerFilter: (v: string) => void;
  handlers: string[];
  sortKey: SortKey;
  onSortKey: (v: SortKey) => void;
  filtersActive: boolean;
  onClear: () => void;
  shown: number;
  total: number;
}) {
  const statusOpts: { k: StatusFilter; label: string }[] = [
    { k: 'all', label: 'All' },
    { k: 'active', label: 'Active' },
    { k: 'paused', label: 'Paused' },
  ];
  const selectCls =
    'rounded-lg border border-line bg-surface2 px-2.5 py-2 text-sm outline-none focus:border-accent';

  return (
    <div className="mb-4 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
        {/* Search */}
        <div className="relative min-w-0 flex-1 md:min-w-[220px]">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">⌕</span>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search name, handler or group…"
            className="w-full rounded-lg border border-line bg-surface2 py-2 pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-faint hover:text-err"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Status segmented control */}
        <div className="flex flex-none items-center rounded-lg border border-line bg-surface2 p-0.5">
          {statusOpts.map((o) => (
            <button
              key={o.k}
              type="button"
              onClick={() => onStatus(o.k)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                status === o.k ? 'bg-accent text-white' : 'text-muted hover:text-fg'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Group filter (only when groups exist) */}
        {groups.length > 0 && (
          <div className="w-full md:w-48">
            <SearchableSelect
              value={groupFilter}
              onChange={onGroupFilter}
              options={[
                { value: UNGROUPED_KEY, label: 'Ungrouped' },
                ...groups.map((g) => ({ value: g, label: g })),
              ]}
              placeholder="All groups"
              searchPlaceholder="Filter groups…"
              clearLabel="All groups"
            />
          </div>
        )}

        {/* Handler filter */}
        {handlers.length > 1 && (
          <select
            value={handlerFilter}
            onChange={(e) => onHandlerFilter(e.target.value)}
            className={selectCls}
            title="Filter by handler"
          >
            <option value="">All handlers</option>
            {handlers.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        )}

        {/* Sort */}
        <select
          value={sortKey}
          onChange={(e) => onSortKey(e.target.value as SortKey)}
          className={selectCls}
          title="Sort by"
        >
          <option value="name">Sort: Name</option>
          <option value="next">Sort: Next run</option>
          <option value="handler">Sort: Handler</option>
        </select>
      </div>

      <div className="mt-2 flex items-center justify-between px-0.5">
        <span className="text-[11px] text-faint">
          Showing {shown} of {total} job{total === 1 ? '' : 's'}
        </span>
        {filtersActive && (
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] font-medium text-accent hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs text-muted">{k}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{v}</div>
    </div>
  );
}

// ───────────────────────── Recent runs (job drawer) ─────────────────────────

const RUN_OK: ReadonlySet<RunStatus> = new Set<RunStatus>(['SUCCESS']);
const RUN_BAD: ReadonlySet<RunStatus> = new Set<RunStatus>(['FAILED', 'TIMEOUT', 'DEAD_LETTER']);
type RunFilter = 'all' | 'ok' | 'warning' | 'failed';
const RUN_PAGE = 8;

function matchesRunFilter(r: Run, f: RunFilter): boolean {
  if (f === 'all') return true;
  if (f === 'ok') return RUN_OK.has(r.status);
  if (f === 'warning') return r.status === 'WARNING';
  return RUN_BAD.has(r.status);
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'err' }) {
  const color = tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-fg';
  return (
    <div className="rounded-lg border border-line bg-surface2/60 px-2.5 py-1.5">
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
    </div>
  );
}

/**
 * A job's run history inside the drawer: a compact KPI strip, status filter
 * chips with live counts, and a paged list. Each row opens the response viewer.
 */
function RecentRuns({
  job,
  runs,
  onOpen,
}: {
  job: Job;
  runs: Run[] | undefined;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<RunFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [range, setRange] = useState<'all' | '1h' | '24h' | '7d'>('all');
  const [sort, setSort] = useState<'new' | 'old' | 'slow'>('new');

  const stats = useMemo(() => {
    const all = runs ?? [];
    const total = all.length;
    const ok = all.filter((r) => RUN_OK.has(r.status)).length;
    const warn = all.filter((r) => r.status === 'WARNING').length;
    const bad = all.filter((r) => RUN_BAD.has(r.status)).length;
    const durs = all.map((r) => r.durationMs).filter((n): n is number => typeof n === 'number');
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    return { total, ok, warn, bad, avg, successRate: total ? Math.round((ok / total) * 100) : null };
  }, [runs]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const windowMs = range === '1h' ? 3.6e6 : range === '24h' ? 8.64e7 : range === '7d' ? 6.048e8 : Infinity;
    const out = (runs ?? []).filter(
      (r) => matchesRunFilter(r, filter) && now - new Date(r.scheduledAt).getTime() <= windowMs,
    );
    out.sort((a, b) => {
      if (sort === 'slow') return (b.durationMs ?? 0) - (a.durationMs ?? 0);
      const ta = new Date(a.scheduledAt).getTime();
      const tb = new Date(b.scheduledAt).getTime();
      return sort === 'old' ? ta - tb : tb - ta;
    });
    return out;
  }, [runs, filter, range, sort]);
  const visible = showAll ? filtered : filtered.slice(0, RUN_PAGE);

  const chips: { key: RunFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'ok', label: 'OK', count: stats.ok },
    { key: 'warning', label: 'Warnings', count: stats.warn },
    { key: 'failed', label: 'Failed', count: stats.bad },
  ];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-faint">Recent runs</p>
        <Link href="/runs" className="text-xs font-medium text-accent-fg hover:underline">
          View all →
        </Link>
      </div>

      {!runs ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <EmptyState title="No runs yet" />
      ) : (
        <>
          {/* KPI strip */}
          <div className="mb-3 grid grid-cols-4 gap-1.5">
            <MiniStat label="Runs" value={`${stats.total}`} />
            <MiniStat
              label="Success"
              value={stats.successRate === null ? '—' : `${stats.successRate}%`}
              tone={stats.successRate !== null && stats.successRate < 80 ? 'warn' : 'ok'}
            />
            <MiniStat label="Warnings" value={`${stats.warn}`} tone={stats.warn > 0 ? 'warn' : undefined} />
            <MiniStat label="Avg" value={stats.avg === null ? '—' : fmtMs(stats.avg)} />
          </div>

          {/* Status filter chips */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {chips.map((c) => {
              const on = filter === c.key;
              const disabled = c.count === 0 && c.key !== 'all';
              return (
                <button
                  key={c.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setFilter(c.key);
                    setShowAll(false);
                  }}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                    on ? 'bg-accent text-white' : 'border border-line bg-surface2 text-muted hover:border-faint'
                  }`}
                >
                  {c.label}
                  <span className={`ml-1 ${on ? 'text-white/80' : 'text-faint'}`}>{c.count}</span>
                </button>
              );
            })}
          </div>

          {/* Time range + sort */}
          <div className="mb-3 flex items-center gap-2">
            <select
              value={range}
              onChange={(e) => {
                setRange(e.target.value as typeof range);
                setShowAll(false);
              }}
              className="rounded-md border border-line bg-surface2 px-2 py-1 text-xs outline-none focus:border-accent"
              title="Time range"
            >
              <option value="all">All time</option>
              <option value="1h">Last hour</option>
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7 days</option>
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="rounded-md border border-line bg-surface2 px-2 py-1 text-xs outline-none focus:border-accent"
              title="Sort order"
            >
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="slow">Slowest first</option>
            </select>
            <span className="ml-auto text-[11px] text-faint">{filtered.length} shown</span>
          </div>

          {/* Run list */}
          <div className="flex flex-col gap-2">
            {filtered.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                No runs match these filters.
              </p>
            ) : (
              visible.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface2 px-3 py-2 text-left hover:border-faint"
                >
                  <RunPill status={r.status} />
                  <span className="text-xs text-muted">{fmtAgo(r.scheduledAt)}</span>
                  {r.attempt > 1 && (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn">
                      try {r.attempt}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[11px] text-faint">{fmtMs(r.durationMs)}</span>
                  <span className="text-faint">›</span>
                </button>
              ))
            )}
          </div>

          {filtered.length > RUN_PAGE && (
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              className="mt-2 w-full rounded-lg border border-line py-1.5 text-xs font-medium text-muted hover:border-faint"
            >
              {showAll ? 'Show less' : `Show ${filtered.length - RUN_PAGE} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function JobDrawer({
  job,
  onClose,
  onClone,
}: {
  job: Job;
  onClose: () => void;
  onClone?: (detail: JobDetail) => void;
}) {
  const { can } = usePermissions();
  const canUpdate = can('jobs:update');
  const canDelete = can('jobs:delete');
  const canCreate = can('jobs:create');
  const canToggle = can('jobs:toggle');

  const { data: runs } = useSWR<Run[]>(`/jobs/${job.id}/runs`, () =>
    fetcher<Run[]>(`/jobs/${job.id}/runs`),
  );
  // Full row (incl. payload) so every setting is editable, not just the schedule.
  const { data: detail, mutate: mutateDetail } = useSWR<JobDetail>(`/jobs/${job.id}`, () =>
    fetcher<JobDetail>(`/jobs/${job.id}`),
  );
  const def = getHandler(job.handler);

  const [openRun, setOpenRun] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Editor state, seeded from the authoritative detail row.
  const [name, setName] = useState(job.name);
  const [group, setGroup] = useState(job.group ?? '');
  const [cronExpr, setCronExpr] = useState(job.cronExpr);
  const [timezone, setTimezone] = useState(job.timezone);
  const [tags, setTags] = useState('');
  const [maxRetries, setMaxRetries] = useState('3');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [description, setDescription] = useState('');
  const [runbookUrl, setRunbookUrl] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  // Reseed the editor whenever fresh detail arrives and we're not mid-edit.
  useEffect(() => {
    if (!detail || editing) return;
    setName(detail.name);
    setGroup(detail.group ?? '');
    setCronExpr(detail.cronExpr);
    setTimezone(detail.timezone);
    setTags((detail.tags ?? []).join(', '));
    setMaxRetries(String(detail.maxRetries));
    setTimeoutMs(String(detail.timeoutMs));
    setDescription(detail.description ?? '');
    setRunbookUrl(detail.runbookUrl ?? '');
    setStartsAt(isoToLocal(detail.startsAt));
    setEndsAt(isoToLocal(detail.endsAt));
    if (def) setValues(payloadToValues(def, detail.payload));
  }, [detail, editing, def]);

  const enabled = detail?.enabled ?? job.enabled;
  const cronOk = isValidCron(cronExpr);
  const tagList = tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const dirty =
    !!detail &&
    (name !== detail.name ||
      group.trim() !== (detail.group ?? '') ||
      cronExpr !== detail.cronExpr ||
      timezone !== detail.timezone ||
      tagList.join(',') !== (detail.tags ?? []).join(',') ||
      maxRetries !== String(detail.maxRetries) ||
      timeoutMs !== String(detail.timeoutMs) ||
      description !== (detail.description ?? '') ||
      runbookUrl !== (detail.runbookUrl ?? '') ||
      startsAt !== isoToLocal(detail.startsAt) ||
      endsAt !== isoToLocal(detail.endsAt) ||
      (def ? JSON.stringify(buildPayload(def, values)) !== JSON.stringify(detail.payload ?? {}) : false));

  function setField(n: string, v: string) {
    setValues((s) => ({ ...s, [n]: v }));
  }

  async function save() {
    if (!cronOk) {
      setError('Fix the schedule before saving.');
      return;
    }
    const mr = Number(maxRetries);
    const to = Number(timeoutMs);
    if (!Number.isInteger(mr) || mr < 0 || mr > 10) {
      setError('Max retries must be an integer between 0 and 10.');
      return;
    }
    if (!Number.isInteger(to) || to < 1000 || to > 600000) {
      setError('Timeout must be between 1000 and 600000 ms.');
      return;
    }
    const payload = def ? buildPayload(def, values) : undefined;
    if (def) {
      const vErr = validatePayload(job.handler, payload!);
      if (vErr) {
        setError(vErr);
        return;
      }
    }
    const startIso = localToIso(startsAt);
    const endIso = localToIso(endsAt);
    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      setError('Schedule window end must be after its start.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/jobs/${job.id}`, {
        method: 'PATCH',
        body: {
          name,
          group: group.trim(),
          cronExpr,
          timezone,
          payload,
          tags: tagList,
          maxRetries: mr,
          timeoutMs: to,
          description: description.trim(),
          runbookUrl: runbookUrl.trim(),
          startsAt: startsAt ? startIso : '',
          endsAt: endsAt ? endIso : '',
        },
      });
      globalMutate('/jobs');
      await mutateDetail();
      job.name = name;
      job.group = group.trim() || null;
      job.cronExpr = cronExpr;
      job.timezone = timezone;
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    if (!detail) return;
    setName(detail.name);
    setGroup(detail.group ?? '');
    setCronExpr(detail.cronExpr);
    setTimezone(detail.timezone);
    setTags((detail.tags ?? []).join(', '));
    setMaxRetries(String(detail.maxRetries));
    setTimeoutMs(String(detail.timeoutMs));
    setDescription(detail.description ?? '');
    setRunbookUrl(detail.runbookUrl ?? '');
    setStartsAt(isoToLocal(detail.startsAt));
    setEndsAt(isoToLocal(detail.endsAt));
    if (def) setValues(payloadToValues(def, detail.payload));
  }

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api(`/jobs/${job.id}/toggle`, { method: 'POST' });
      globalMutate('/jobs');
      await mutateDetail();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/jobs/${job.id}`, { method: 'DELETE' });
      globalMutate('/jobs');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{name}</h2>
              {group.trim() && (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-fg">
                  {group.trim()}
                </span>
              )}
            </div>
            <code className="font-mono text-xs text-muted">{cronExpr} · {timezone}</code>
            <div className="mt-1">
              <Link href={`/jobs/${job.id}`} className="text-xs font-medium text-accent-fg hover:underline">
                ↗ Open dashboard
              </Link>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-xl text-faint hover:bg-surface2">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-5 rounded-xl border border-line bg-surface2/40 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-faint">Settings</p>
              <div className="flex items-center gap-2">
                {saved && <span className="text-[11px] font-medium text-ok">✓ saved</span>}
                {canUpdate && !editing && (
                  <button
                    onClick={() => setEditing(true)}
                    className="text-xs font-medium text-accent-fg hover:underline"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            {!editing ? (
              <dl className="mt-2 flex flex-col gap-2 text-sm">
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-faint">Schedule</dt>
                  <dd className="text-muted">{describeCron(cronExpr)}</dd>
                </div>
                <div className="flex gap-6">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Handler</dt>
                    <dd className="font-mono text-xs">{job.handler}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Timezone</dt>
                    <dd className="text-muted">{timezone}</dd>
                  </div>
                </div>
                <div className="flex gap-6">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Max retries</dt>
                    <dd className="text-muted">{detail?.maxRetries ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Timeout</dt>
                    <dd className="text-muted">{detail ? `${Math.round(detail.timeoutMs / 1000)}s` : '—'}</dd>
                  </div>
                </div>
                {detail?.tags && detail.tags.length > 0 && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Tags</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {detail.tags.map((t) => (
                        <span key={t} className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] text-muted">
                          {t}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {(detail?.startsAt || detail?.endsAt) && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Schedule window</dt>
                    <dd className="text-muted">
                      {detail?.startsAt ? new Date(detail.startsAt).toLocaleString() : 'always'}
                      {' → '}
                      {detail?.endsAt ? new Date(detail.endsAt).toLocaleString() : 'always'}
                    </dd>
                  </div>
                )}
                {detail?.description && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Description</dt>
                    <dd className="whitespace-pre-wrap text-muted">{detail.description}</dd>
                  </div>
                )}
                {detail?.runbookUrl && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-faint">Runbook</dt>
                    <dd>
                      <a
                        href={detail.runbookUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-accent-fg hover:underline"
                      >
                        {detail.runbookUrl}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-muted">Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-muted">Group</span>
                  <input
                    value={group}
                    onChange={(e) => setGroup(e.target.value)}
                    maxLength={40}
                    placeholder="Ungrouped"
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
                  />
                </label>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted">Timezone</span>
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
                  >
                    {[timezone, ...TIMEZONES.filter((t) => t !== timezone)].map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>
                <CronBuilder value={cronExpr} onChange={setCronExpr} timezone={timezone} />

                {/* Handler is fixed after creation (payload contract); its fields stay editable. */}
                <div className="rounded-lg border border-line bg-surface/60 p-2.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted">Handler config</span>
                    <span className="font-mono text-[11px] text-faint">{job.handler}</span>
                  </div>
                  {def ? (
                    <div className="flex flex-col gap-3">
                      {def.fields.map((f) => (
                        <HandlerFieldInput
                          key={f.name}
                          field={f}
                          value={values[f.name] ?? ''}
                          onChange={(v) => setField(f.name, v)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-faint">Unknown handler — payload not editable here.</p>
                  )}
                </div>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-muted">Tags</span>
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="comma or space separated"
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-muted">Max retries</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={maxRetries}
                      onChange={(e) => setMaxRetries(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-muted">Timeout (ms)</span>
                    <input
                      type="number"
                      min={1000}
                      max={600000}
                      step={1000}
                      value={timeoutMs}
                      onChange={(e) => setTimeoutMs(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-muted">Description</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    maxLength={1000}
                    placeholder="What this job does"
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-muted">Runbook URL</span>
                  <input
                    type="url"
                    value={runbookUrl}
                    onChange={(e) => setRunbookUrl(e.target.value)}
                    maxLength={500}
                    placeholder="https://…"
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-muted">Window start</span>
                    <input
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-muted">Window end</span>
                    <input
                      type="datetime-local"
                      value={endsAt}
                      onChange={(e) => setEndsAt(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                    />
                  </label>
                </div>

                {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={cancelEdit}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={save}
                    disabled={busy || !cronOk || !dirty}
                    className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                  >
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <HeartbeatPanel jobId={job.id} />

          <RecentRuns job={job} runs={runs} onOpen={setOpenRun} />

          {(canToggle || canDelete || canCreate) && (
            <div className="mt-6 rounded-xl border border-line p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Actions</p>
              {!editing && error && (
                <p className="mb-2 rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {canCreate && onClone && (
                  <button
                    onClick={() => detail && onClone(detail)}
                    disabled={!detail}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-faint disabled:opacity-60"
                    title="Create a new job pre-filled from this one"
                  >
                    ⧉ Duplicate
                  </button>
                )}
                {canToggle && (
                  <button
                    onClick={toggle}
                    disabled={busy}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-faint disabled:opacity-60"
                  >
                    {enabled ? '⏸ Pause' : '▶ Resume'}
                  </button>
                )}
                {canDelete &&
                  (confirmDelete ? (
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-sm text-muted">Delete this job?</span>
                      <button
                        onClick={remove}
                        disabled={busy}
                        className="rounded-lg bg-err px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                      >
                        {busy ? 'Deleting…' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="ml-auto rounded-lg border border-err/40 px-3 py-1.5 text-sm font-medium text-err hover:bg-err/10"
                    >
                      Delete job
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </aside>
      {openRun && <ResponseViewer runId={openRun} onClose={() => setOpenRun(null)} />}
    </div>
  );
}

function HeartbeatPanel({ jobId }: { jobId: string }) {
  const { can } = usePermissions();
  const manage = can('jobs:update');
  const { data: hb, mutate } = useSWR<Heartbeat>(`/jobs/${jobId}/heartbeat`, () =>
    fetcher<Heartbeat>(`/jobs/${jobId}/heartbeat`),
  );
  const [editing, setEditing] = useState(false);
  const [interval, setIntervalVal] = useState(3600);
  const [grace, setGrace] = useState(60);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await mutate();
      globalMutate('/jobs');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const PRESETS = [
    { label: '5 min', v: 300 }, { label: '15 min', v: 900 }, { label: '1 hour', v: 3600 },
    { label: '6 hours', v: 21600 }, { label: 'Daily', v: 86400 },
  ];

  return (
    <div className="mb-5 rounded-xl border border-line bg-surface2/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-faint">Heartbeat</p>
        {hb?.enabled && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              hb.state === 'MISSING' ? 'bg-err/15 text-err' : 'bg-ok/15 text-ok'
            }`}
          >
            {hb.state === 'MISSING' ? '● Missing' : '● Live'}
          </span>
        )}
      </div>

      {!hb ? (
        <p className="mt-2 text-sm text-faint">Loading…</p>
      ) : !hb.enabled && !editing ? (
        <div className="mt-2">
          <p className="text-sm text-muted">
            Get alerted if this job stops running. We watch for an inbound ping or a successful run.
          </p>
          {manage && (
            <button
              onClick={() => setEditing(true)}
              className="mt-2 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-accent hover:text-accent-fg"
            >
              Enable heartbeat
            </button>
          )}
        </div>
      ) : editing ? (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <span className="text-sm font-medium text-muted">Expected at least every</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.v}
                  onClick={() => setIntervalVal(p.v)}
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    interval === p.v ? 'bg-accent text-white' : 'border border-line text-muted hover:border-faint'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between text-sm">
            <span className="font-medium text-muted">Grace period (sec)</span>
            <input
              type="number"
              min={0}
              value={grace}
              onChange={(e) => setGrace(Math.max(0, parseInt(e.target.value || '0', 10)))}
              className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm outline-none focus:border-accent"
            />
          </label>
          {err && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{err}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setEditing(false); setErr(null); }}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              onClick={() =>
                act(() =>
                  api(`/jobs/${jobId}/heartbeat`, {
                    method: 'POST',
                    body: { intervalSec: interval, graceSec: grace },
                  }),
                ).then(() => setEditing(false))
              }
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Enable'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-sm text-muted">
            Expected every <b className="text-fg">{fmtEvery(hb.intervalSec)}</b> (+{hb.graceSec}s grace).
            Last ping {fmtAgo(hb.lastPingAt)}.
          </p>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Ping URL</span>
            <div className="mt-1 flex items-stretch gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-muted">
                {hb.pingUrl}
              </code>
              <button
                onClick={() => hb.pingUrl && copy(hb.pingUrl)}
                className="flex-none rounded-md border border-line px-2 text-xs font-medium hover:border-accent hover:text-accent-fg"
              >
                {copied ? '✓' : 'Copy'}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-faint">
              Curl this from the end of your job: <code className="font-mono">curl -fsS {hb.pingUrl}</code>
            </p>
          </div>
          {err && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{err}</p>}
          {manage && (
            <div className="flex gap-2">
              <button
                onClick={() => act(() => api(`/jobs/${jobId}/heartbeat/rotate`, { method: 'POST' }))}
                disabled={busy}
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-faint disabled:opacity-60"
              >
                Rotate URL
              </button>
              <button
                onClick={() => act(() => api(`/jobs/${jobId}/heartbeat`, { method: 'DELETE' }))}
                disabled={busy}
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-err hover:border-err disabled:opacity-60"
              >
                Disable
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtEvery(sec: number | null): string {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} d`;
}

const TIMEZONES = [
  'Europe/Athens', 'Europe/London', 'Europe/Berlin', 'UTC',
  'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore',
];

// Parse a "Key: Value" (one per line) block into an object for keyval fields.
function parseKeyVal(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function buildPayload(def: HandlerDef, values: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = (values[f.name] ?? '').trim();
    if (!v) continue;
    if (f.type === 'int') payload[f.name] = Number(v);
    else if (f.type === 'keyval') payload[f.name] = parseKeyVal(values[f.name] ?? '');
    else payload[f.name] = v;
  }
  return payload;
}

/** Inverse of buildPayload: seed the string-based form fields from a stored payload. */
function payloadToValues(def: HandlerDef, payload: Record<string, unknown> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  const p = payload ?? {};
  for (const f of def.fields) {
    const v = p[f.name];
    if (v === undefined || v === null) {
      values[f.name] = '';
    } else if (f.type === 'keyval' && typeof v === 'object') {
      values[f.name] = Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${k}: ${val}`)
        .join('\n');
    } else if (f.type === 'int') {
      values[f.name] = String(v);
    } else {
      values[f.name] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return values;
}

function HandlerFieldInput({
  field,
  value,
  onChange,
}: {
  field: HandlerDef['fields'][number];
  value: string;
  onChange: (v: string) => void;
}) {
  const cls = 'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';
  return (
    <Field label={field.label + (field.required ? ' *' : '')}>
      {field.type === 'select' ? (
        <select value={value || String(field.default ?? '')} onChange={(e) => onChange(e.target.value)} className={cls}>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      ) : field.type === 'text' || field.type === 'sql' || field.type === 'keyval' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.type === 'keyval' ? 'Authorization: Bearer {{secret:TOKEN}}' : field.placeholder}
          rows={field.type === 'sql' ? 3 : 2}
          className={`${cls} font-mono`}
        />
      ) : (
        <input
          type={field.type === 'int' ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={cls}
        />
      )}
      {field.help && <span className="mt-1 block text-[11px] text-faint">{field.help}</span>}
    </Field>
  );
}

/** datetime-local <-> ISO helpers for the optional schedule window. */
function isoToLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Render in the browser's local time, trimmed to minutes for the input.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function CreateJobModal({
  knownGroups,
  template,
  onClose,
}: {
  knownGroups: string[];
  template?: JobDetail | null;
  onClose: () => void;
}) {
  const { can } = usePermissions();
  const tplHandler = template ? getHandler(template.handler) : null;
  const [name, setName] = useState(template ? `${template.name} (copy)` : '');
  const [group, setGroup] = useState(template?.group ?? '');
  const [cronExpr, setCronExpr] = useState(template?.cronExpr ?? '*/5 * * * *');
  const [timezone, setTimezone] = useState(template?.timezone ?? 'Europe/Athens');
  const [handlerKey, setHandlerKey] = useState(template?.handler ?? HANDLER_CATALOG[0].key);
  const [values, setValues] = useState<Record<string, string>>(
    template && tplHandler ? payloadToValues(tplHandler, template.payload) : {},
  );
  const [description, setDescription] = useState(template?.description ?? '');
  const [runbookUrl, setRunbookUrl] = useState(template?.runbookUrl ?? '');
  const [startsAt, setStartsAt] = useState(isoToLocal(template?.startsAt));
  const [endsAt, setEndsAt] = useState(isoToLocal(template?.endsAt));
  const [alertChannelId, setAlertChannelId] = useState('');
  // Advanced options (collapsed by default) — exposed on create, not just edit.
  const [tags, setTags] = useState((template?.tags ?? []).join(', '));
  const [maxRetries, setMaxRetries] = useState(String(template?.maxRetries ?? 3));
  const [timeoutMs, setTimeoutMs] = useState(String(template?.timeoutMs ?? 30000));
  const [concurrencyKey, setConcurrencyKey] = useState(template?.concurrencyKey ?? '');
  const [startPaused, setStartPaused] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cronOk = isValidCron(cronExpr);
  const def = getHandler(handlerKey)!;

  // Existing notification channels, to optionally wire a failure alert on create.
  const { data: channels } = useSWR<NotificationChannel[]>(
    can('alerts:read') ? '/alerts/channels' : null,
    () => fetcher<NotificationChannel[]>('/alerts/channels'),
  );

  function setField(n: string, v: string) {
    setValues((s) => ({ ...s, [n]: v }));
  }

  async function doCreate(runAfter: boolean) {
    if (!cronOk) {
      setError('Please fix the schedule before saving.');
      return;
    }
    const startIso = localToIso(startsAt);
    const endIso = localToIso(endsAt);
    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      setError('Schedule window end must be after its start.');
      return;
    }
    const mr = Number(maxRetries);
    const to = Number(timeoutMs);
    if (!Number.isInteger(mr) || mr < 0 || mr > 10) {
      setError('Max retries must be an integer between 0 and 10.');
      return;
    }
    if (!Number.isInteger(to) || to < 1000 || to > 600000) {
      setError('Timeout must be between 1000 and 600000 ms.');
      return;
    }
    const payload = buildPayload(def, values);
    const vErr = validatePayload(handlerKey, payload);
    if (vErr) {
      setError(vErr);
      return;
    }
    const tagList = tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      const created = await api<Job>('/jobs', {
        method: 'POST',
        body: {
          name,
          group: group.trim() || undefined,
          handler: handlerKey,
          cronExpr,
          timezone,
          payload,
          tags: tagList,
          maxRetries: mr,
          timeoutMs: to,
          concurrencyKey: concurrencyKey.trim() || undefined,
          enabled: startPaused ? false : undefined,
          description: description.trim() || undefined,
          runbookUrl: runbookUrl.trim() || undefined,
          startsAt: startIso ?? undefined,
          endsAt: endIso ?? undefined,
          alertChannelId: alertChannelId || undefined,
        },
      });
      if (runAfter && created?.id) {
        await api(`/jobs/${created.id}/run`, { method: 'POST' });
      }
      globalMutate('/jobs');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void doCreate(false);
  }

  const windowCls =
    'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative my-auto w-full max-w-xl rounded-2xl border border-line bg-surface p-6 shadow-2xl"
      >
        <h2 className="mb-4 text-lg font-semibold">{template ? 'Duplicate Job' : 'New Job'}</h2>
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Nightly report sync"
              className="w-full rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
            />
          </Field>

          <Field label="Group">
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              list="job-group-suggestions"
              maxLength={40}
              placeholder="Optional — e.g. ETL, Billing"
              className="w-full rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
            />
            <datalist id="job-group-suggestions">
              {knownGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <span className="mt-1 block text-[11px] text-faint">
              Groups organise the job list. Leave blank for “Ungrouped”.
            </span>
          </Field>

          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium text-muted">Schedule</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="rounded-md border border-line bg-surface2 px-2 py-1 text-xs outline-none focus:border-accent"
                title="Timezone"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <CronBuilder value={cronExpr} onChange={setCronExpr} timezone={timezone} />
          </div>

          {/* Handler picker */}
          <Field label="Handler">
            <select
              value={handlerKey}
              onChange={(e) => {
                setHandlerKey(e.target.value);
                setValues({});
                setError(null);
              }}
              className="w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {HANDLER_CATALOG.map((h) => (
                <option key={h.key} value={h.key}>{h.label}</option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-faint">{def.description}</span>
          </Field>

          {/* Per-handler dynamic fields */}
          {def.fields.map((f) => (
            <HandlerFieldInput key={f.name} field={f} value={values[f.name] ?? ''} onChange={(v) => setField(f.name, v)} />
          ))}

          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Optional — what this job does, for teammates and alerts"
              className={windowCls}
            />
          </Field>

          <Field label="Runbook URL">
            <input
              type="url"
              value={runbookUrl}
              onChange={(e) => setRunbookUrl(e.target.value)}
              maxLength={500}
              placeholder="https://wiki.example.com/runbooks/…"
              className={windowCls}
            />
            <span className="mt-1 block text-[11px] text-faint">
              Linked from the job and included in failure alerts, for on-call.
            </span>
          </Field>

          {/* Optional schedule window */}
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">Schedule window</span>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-faint">
                Starts
                <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={windowCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-faint">
                Ends
                <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={windowCls} />
              </label>
            </div>
            <span className="text-[11px] text-faint">
              Optional — the job only runs between these times. Leave blank for always-on.
            </span>
          </div>

          {/* Attach a failure alert on create */}
          {can('alerts:read') && (
            <Field label="Failure alert">
              <select
                value={alertChannelId}
                onChange={(e) => setAlertChannelId(e.target.value)}
                className={windowCls}
                disabled={!channels || channels.length === 0}
              >
                <option value="">No alert</option>
                {(channels ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.type.toLowerCase()})
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-faint">
                {channels && channels.length === 0
                  ? 'No channels yet — create one under Alerts to notify on failures.'
                  : 'Notify this channel when the job fails, times out or dead-letters.'}
              </span>
            </Field>
          )}

          {/* Advanced options (collapsed) */}
          <div className="rounded-lg border border-line bg-surface2/40">
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-muted"
            >
              <span>Advanced options</span>
              <span className="text-accent">{showAdvanced ? '▾' : '▸'}</span>
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-3 border-t border-line p-3">
                <Field label="Tags">
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="comma or space separated"
                    className={windowCls}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Max retries">
                    <input type="number" min={0} max={10} value={maxRetries} onChange={(e) => setMaxRetries(e.target.value)} className={windowCls} />
                  </Field>
                  <Field label="Timeout (ms)">
                    <input type="number" min={1000} max={600000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} className={windowCls} />
                  </Field>
                </div>
                <Field label="Concurrency key">
                  <input
                    value={concurrencyKey}
                    onChange={(e) => setConcurrencyKey(e.target.value)}
                    placeholder="Jobs sharing a key never run at the same time"
                    className={windowCls}
                  />
                </Field>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface2/50 px-3 py-2.5 text-sm">
                  <input type="checkbox" checked={startPaused} onChange={(e) => setStartPaused(e.target.checked)} className="h-4 w-4 accent-accent" />
                  <span>Create paused (don’t schedule until resumed)</span>
                </label>
              </div>
            )}
          </div>

          {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doCreate(true)}
              disabled={busy || !cronOk || startPaused}
              title={startPaused ? 'Uncheck “Create paused” to run on create' : 'Create and run once immediately'}
              className="rounded-lg border border-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-soft disabled:opacity-50"
            >
              Create &amp; run
            </button>
            <button
              type="submit"
              disabled={busy || !cronOk}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
