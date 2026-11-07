'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { fmtMs } from '@/lib/format';
import type { JobDetail } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';

interface Bucket {
  day: string;
  total: number;
  success: number;
  warning: number;
  failed: number;
  avgMs: number | null;
}
interface Metrics {
  days: number;
  totals: { total: number; success: number; warning: number; failed: number; successRate: number | null };
  buckets: Bucket[];
}

const RANGES = [7, 14, 30];

export default function JobDashboardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [days, setDays] = useState(7);

  const { data: job } = useSWR<JobDetail>(id ? `/jobs/${id}` : null, () => fetcher<JobDetail>(`/jobs/${id}`));
  const { data: metrics, isLoading } = useSWR<Metrics>(
    id ? `/jobs/${id}/metrics?days=${days}` : null,
    () => fetcher<Metrics>(`/jobs/${id}/metrics?days=${days}`),
  );

  const t = metrics?.totals;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5">
        <Link href="/jobs" className="text-xs font-medium text-accent-fg hover:underline">
          ← Back to jobs
        </Link>
        <h1 className="mt-1 text-xl font-bold md:text-2xl">{job?.name ?? 'Job'}</h1>
        {job && (
          <code className="font-mono text-xs text-muted">
            {job.handler} · {job.cronExpr} · {job.timezone}
          </code>
        )}
      </header>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Metrics</h2>
        <div className="flex items-center rounded-lg border border-line bg-surface2 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                days === r ? 'bg-accent text-white' : 'text-muted hover:text-fg'
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {isLoading || !metrics ? (
        <Spinner />
      ) : t && t.total === 0 ? (
        <EmptyState title="No runs in this period" hint="Metrics appear once this job runs." />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi k="Runs" v={`${t!.total}`} />
            <Kpi
              k="Success rate"
              v={t!.successRate === null ? '—' : `${t!.successRate}%`}
              tone={t!.successRate !== null && t!.successRate < 80 ? 'warn' : 'ok'}
            />
            <Kpi k="Warnings" v={`${t!.warning}`} tone={t!.warning > 0 ? 'warn' : undefined} />
            <Kpi k="Failed" v={`${t!.failed}`} tone={t!.failed > 0 ? 'err' : undefined} />
          </div>

          <section className="mb-5 rounded-xl border border-line bg-surface p-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Runs per day</h3>
            <RunsChart buckets={metrics.buckets} />
            <Legend />
          </section>

          <section className="rounded-xl border border-line bg-surface p-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Average duration per day</h3>
            <DurationChart buckets={metrics.buckets} />
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'warn' | 'err' }) {
  const cls = tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-fg';
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs text-muted">{k}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${cls}`}>{v}</div>
    </div>
  );
}

function shortDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(d);
}

/** Stacked success/warning/failed bars, one column per day. Pure CSS/flex. */
function RunsChart({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div className="flex h-44 items-end gap-1">
      {buckets.map((b) => {
        const h = (n: number) => (n / max) * 100;
        return (
          <div key={b.day} className="group relative flex flex-1 flex-col items-center">
            <div className="flex h-40 w-full max-w-[28px] flex-col justify-end overflow-hidden rounded-t">
              {b.failed > 0 && <div className="w-full bg-err" style={{ height: `${h(b.failed)}%` }} />}
              {b.warning > 0 && <div className="w-full bg-warn" style={{ height: `${h(b.warning)}%` }} />}
              {b.success > 0 && <div className="w-full bg-ok" style={{ height: `${h(b.success)}%` }} />}
              {b.total === 0 && <div className="w-full bg-surface2" style={{ height: '2px' }} />}
            </div>
            <span className="mt-1 whitespace-nowrap text-[9px] text-faint">{shortDay(b.day)}</span>
            {/* tooltip */}
            <div className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded bg-fg px-2 py-1 text-[10px] text-surface group-hover:block">
              {b.total} runs · {b.success}✓ {b.warning}! {b.failed}✕
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DurationChart({ buckets }: { buckets: Bucket[] }) {
  const vals = buckets.map((b) => b.avgMs ?? 0);
  const max = Math.max(1, ...vals);
  return (
    <div className="flex h-32 items-end gap-1">
      {buckets.map((b) => {
        const pct = b.avgMs ? (b.avgMs / max) * 100 : 0;
        return (
          <div key={b.day} className="group relative flex flex-1 flex-col items-center">
            <div className="flex h-28 w-full max-w-[28px] items-end">
              <div
                className="w-full rounded-t bg-accent"
                style={{ height: b.avgMs ? `${Math.max(pct, 3)}%` : '2px' }}
              />
            </div>
            <span className="mt-1 whitespace-nowrap text-[9px] text-faint">{shortDay(b.day)}</span>
            <div className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded bg-fg px-2 py-1 text-[10px] text-surface group-hover:block">
              {b.avgMs === null ? 'no runs' : fmtMs(b.avgMs)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex items-center gap-4 text-[11px] text-muted">
      <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-ok" /> Success</span>
      <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-warn" /> Warning</span>
      <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-err" /> Failed</span>
    </div>
  );
}
