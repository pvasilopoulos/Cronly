'use client';
import type { RunStatus, JobStatus } from '@/lib/types';

const RUN_STYLE: Record<RunStatus, string> = {
  QUEUED: 'bg-surface2 text-faint',
  RUNNING: 'bg-run/15 text-run',
  SUCCESS: 'bg-ok/15 text-ok',
  WARNING: 'bg-warn/15 text-warn',
  FAILED: 'bg-err/15 text-err',
  TIMEOUT: 'bg-warn/15 text-warn',
  DEAD_LETTER: 'bg-err/15 text-err',
};

export function RunPill({ status }: { status: RunStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${RUN_STYLE[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}

export function JobPill({ status, enabled }: { status: JobStatus; enabled: boolean }) {
  const on = enabled && status === 'ACTIVE';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        on ? 'bg-ok/15 text-ok' : 'bg-surface2 text-faint'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {on ? 'active' : 'paused'}
    </span>
  );
}

export function Toggle({ on, onClick }: { on: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`relative h-5 w-9 flex-none rounded-full transition-colors ${on ? 'bg-ok' : 'bg-line'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center p-10 text-faint">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface p-10 text-center">
      <p className="font-medium text-fg">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Cron({ children }: { children: React.ReactNode }) {
  return (
    <code className="inline-block rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}
