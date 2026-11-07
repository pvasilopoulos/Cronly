'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeCron, isValidCron, nextRuns, DOW_NAMES } from '@/lib/cron';

type Mode = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

const MODES: { id: Mode; label: string }[] = [
  { id: 'minutes', label: 'Interval' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'custom', label: 'Custom' },
];

const PRESETS: { label: string; expr: string }[] = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every 5 min', expr: '*/5 * * * *' },
  { label: 'Every 15 min', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 00:00', expr: '0 0 * * *' },
  { label: 'Weekdays 09:00', expr: '0 9 * * 1-5' },
  { label: 'Mondays 08:00', expr: '0 8 * * 1' },
  { label: '1st of month', expr: '0 0 1 * *' },
];

/** Best-effort: map an expression to a builder mode + its controls. */
function inferMode(expr: string): Mode {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return 'custom';
  const [m, h, dom, , dow] = f;
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && dow === '*') return 'minutes';
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && dow === '*') return 'hourly';
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && dow === '*') return 'daily';
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && dow !== '*') return 'weekly';
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom !== '*' && dow === '*') return 'monthly';
  return 'custom';
}

export function CronBuilder({
  value,
  onChange,
  timezone,
}: {
  value: string;
  onChange: (expr: string) => void;
  timezone: string;
}) {
  const [mode, setMode] = useState<Mode>(() => inferMode(value));

  // Structured state for the visual modes.
  const [interval, setInterval] = useState(5);
  const [minute, setMinute] = useState(0);
  const [hour, setHour] = useState(9);
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [domDay, setDomDay] = useState(1);
  const [raw, setRaw] = useState(value);

  // When a visual control changes, rebuild the expression and emit it.
  useEffect(() => {
    if (mode === 'custom') return;
    let expr = value;
    if (mode === 'minutes') expr = `*/${interval} * * * *`;
    else if (mode === 'hourly') expr = `${minute} * * * *`;
    else if (mode === 'daily') expr = `${minute} ${hour} * * *`;
    else if (mode === 'weekly') {
      const dow = weekdays.length ? [...weekdays].sort((a, b) => a - b).join(',') : '*';
      expr = `${minute} ${hour} * * ${dow}`;
    } else if (mode === 'monthly') expr = `${minute} ${hour} ${domDay} * *`;
    onChange(expr);
    setRaw(expr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, interval, minute, hour, weekdays, domDay]);

  function pickMode(m: Mode) {
    setMode(m);
    if (m === 'custom') setRaw(value);
  }

  function applyPreset(expr: string) {
    onChange(expr);
    setRaw(expr);
    const m = inferMode(expr);
    setMode(m);
    hydrateFromExpr(expr, m);
  }

  // Pull structured controls out of a preset so the visual UI reflects it.
  function hydrateFromExpr(expr: string, m: Mode) {
    const f = expr.trim().split(/\s+/);
    if (f.length !== 5) return;
    const [mm, hh, dom, , dow] = f;
    if (m === 'minutes') setInterval(Number(mm.replace('*/', '')) || 5);
    if (m === 'hourly') setMinute(Number(mm) || 0);
    if (m === 'daily' || m === 'weekly' || m === 'monthly') {
      setMinute(Number(mm) || 0);
      setHour(Number(hh) || 0);
    }
    if (m === 'weekly' && dow !== '*') {
      setWeekdays(dow.split(',').map(Number).filter((n) => !Number.isNaN(n)));
    }
    if (m === 'monthly') setDomDay(Number(dom) || 1);
  }

  function setRawExpr(v: string) {
    setRaw(v);
    onChange(v);
  }

  const valid = isValidCron(value);

  return (
    <div className="rounded-xl border border-line bg-surface2/50">
      {/* Mode tabs */}
      <div className="flex flex-wrap gap-1 border-b border-line p-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => pickMode(m.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === m.id ? 'bg-accent text-white' : 'text-muted hover:bg-surface2'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="p-3">
        {mode === 'minutes' && (
          <Row label="Run every">
            <NumSelect value={interval} onChange={setInterval} options={[1, 2, 3, 5, 10, 15, 20, 30]} />
            <span className="text-sm text-muted">minute(s)</span>
          </Row>
        )}

        {mode === 'hourly' && (
          <Row label="At minute">
            <NumSelect value={minute} onChange={setMinute} options={range(0, 59)} pad />
            <span className="text-sm text-muted">past every hour</span>
          </Row>
        )}

        {mode === 'daily' && (
          <Row label="Every day at">
            <TimePicker hour={hour} minute={minute} onHour={setHour} onMinute={setMinute} />
          </Row>
        )}

        {mode === 'weekly' && (
          <div className="flex flex-col gap-3">
            <Row label="On">
              <div className="flex flex-wrap gap-1">
                {DOW_NAMES.map((d, i) => {
                  const on = weekdays.includes(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        setWeekdays((w) =>
                          w.includes(i) ? w.filter((x) => x !== i) : [...w, i],
                        )
                      }
                      className={`h-9 w-9 rounded-md text-xs font-semibold transition-colors ${
                        on ? 'bg-accent text-white' : 'border border-line text-muted hover:border-faint'
                      }`}
                    >
                      {d.slice(0, 2)}
                    </button>
                  );
                })}
              </div>
            </Row>
            <Row label="At">
              <TimePicker hour={hour} minute={minute} onHour={setHour} onMinute={setMinute} />
            </Row>
          </div>
        )}

        {mode === 'monthly' && (
          <div className="flex flex-col gap-3">
            <Row label="On day">
              <NumSelect value={domDay} onChange={setDomDay} options={range(1, 31)} />
              <span className="text-sm text-muted">of the month</span>
            </Row>
            <Row label="At">
              <TimePicker hour={hour} minute={minute} onHour={setHour} onMinute={setMinute} />
            </Row>
          </div>
        )}

        {mode === 'custom' && (
          <div>
            <input
              value={raw}
              onChange={(e) => setRawExpr(e.target.value)}
              spellCheck={false}
              placeholder="* * * * *"
              className={`w-full rounded-lg border bg-surface px-3 py-2 font-mono text-sm outline-none ${
                valid ? 'border-line focus:border-accent' : 'border-err focus:border-err'
              }`}
            />
            <p className="mt-1.5 text-[11px] text-faint">
              <span className="font-mono">minute hour day-of-month month day-of-week</span>
              {' · '}supports <span className="font-mono">* , - /</span> and names (mon, jan…)
            </p>
          </div>
        )}

        {/* Preset chips */}
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
          {PRESETS.map((p) => (
            <button
              key={p.expr}
              type="button"
              onClick={() => applyPreset(p.expr)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                value.trim() === p.expr
                  ? 'border-accent bg-accent-soft text-accent-fg'
                  : 'border-line text-muted hover:border-faint'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary: expression + description + preview */}
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2">
          <code
            className={`rounded-md border px-2 py-1 font-mono text-sm ${
              valid ? 'border-line bg-surface text-fg' : 'border-err bg-err/10 text-err'
            }`}
          >
            {value || '—'}
          </code>
          <span className="text-sm text-muted">{valid ? describeCron(value) : 'Invalid expression'}</span>
        </div>
        {valid && <NextRuns expr={value} timezone={timezone} />}
      </div>
    </div>
  );
}

function NextRuns({ expr, timezone }: { expr: string; timezone: string }) {
  const runs = useMemo(() => nextRuns(expr, timezone, 5), [expr, timezone]);
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: timezone,
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }),
    [timezone],
  );
  if (runs.length === 0) {
    return <p className="mt-2 text-[11px] text-faint">No upcoming runs within the next year.</p>;
  }
  return (
    <div className="mt-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
        Next runs · {timezone}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {runs.map((d, i) => (
          <span
            key={i}
            className="rounded-md bg-surface2 px-2 py-0.5 font-mono text-[11px] text-muted"
          >
            {fmt.format(d)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 flex-none text-sm font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

function TimePicker({
  hour, minute, onHour, onMinute,
}: {
  hour: number; minute: number; onHour: (n: number) => void; onMinute: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <NumSelect value={hour} onChange={onHour} options={range(0, 23)} pad />
      <span className="font-mono text-muted">:</span>
      <NumSelect value={minute} onChange={onMinute} options={range(0, 59)} pad />
    </div>
  );
}

function NumSelect({
  value, onChange, options, pad,
}: {
  value: number; onChange: (n: number) => void; options: number[]; pad?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-accent"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {pad ? String(o).padStart(2, '0') : o}
        </option>
      ))}
    </select>
  );
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
