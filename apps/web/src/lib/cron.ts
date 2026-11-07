// Cron helpers for the visual CronBuilder. Validation and next-run previews come
// from the shared @cronapp/cron engine (the same cron-parser the scheduler and
// API use), so a preview can never disagree with what actually fires. The custom
// parser below is used ONLY to humanize an expression (describeCron) and to let
// the builder read individual fields — never to compute fire times.
import { nextRuns as engineNextRuns, isValidCron as engineIsValid } from '@cronapp/cron';

export interface CronParsed {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

const BOUNDS: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6], // 0 = Sunday
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ALIASES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
export const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_ALIASES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function expandField(raw: string, key: string): number[] {
  const [min, max] = BOUNDS[key];
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`Empty term in "${key}"`);

    let range = token;
    let step = 1;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      range = token.slice(0, slash);
      const s = Number(token.slice(slash + 1));
      if (!Number.isInteger(s) || s < 1) throw new Error(`Bad step "/${token.slice(slash + 1)}" in "${key}"`);
      step = s;
    }

    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf('-');
      if (dash > 0) {
        lo = resolveValue(range.slice(0, dash), key);
        hi = resolveValue(range.slice(dash + 1), key);
      } else {
        lo = resolveValue(range, key);
        hi = slash !== -1 ? max : lo; // "5/10" means 5,15,25... up to max
      }
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${token}" out of range for ${key} (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && key === 'dow' ? 0 : v);
  }
  return [...out].sort((a, b) => a - b);
}

function resolveValue(v: string, key: string): number {
  const t = v.trim().toLowerCase();
  if (key === 'month' && t in MONTH_ALIASES) return MONTH_ALIASES[t];
  if (key === 'dow' && t in DOW_ALIASES) return DOW_ALIASES[t];
  const n = Number(t);
  if (!Number.isInteger(n)) throw new Error(`"${v}" is not valid for ${key}`);
  return n === 7 && key === 'dow' ? 0 : n;
}

export function parseCron(expr: string): CronParsed {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Expected 5 fields (min hour day month weekday), got ${fields.length}`);
  }
  const [m, h, dom, mon, dow] = fields;
  return {
    minute: expandField(m, 'minute'),
    hour: expandField(h, 'hour'),
    dom: expandField(dom, 'dom'),
    month: expandField(mon, 'month'),
    dow: expandField(dow, 'dow'),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** Validate via the shared engine so the builder accepts exactly what fires. */
export function isValidCron(expr: string): boolean {
  return engineIsValid(expr);
}

/** Next `count` fire times at/after `from` in `tz`, from the shared engine. */
export function nextRuns(expr: string, tz: string, count = 5, from = new Date()): Date[] {
  return engineNextRuns(expr, tz, count, from);
}

function listText(nums: number[], full: number, singular: string): string {
  if (nums.length === full) return `every ${singular}`;
  if (nums.length === 1) return `${singular} ${nums[0]}`;
  return `${singular}s ${nums.join(', ')}`;
}

function detectStep(nums: number[], full: number, min: number): number | null {
  if (nums.length < 2 || nums.length === full) return null;
  if (nums[0] !== min) return null;
  const step = nums[1] - nums[0];
  for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] !== step) return null;
  return step;
}

/** Plain-English description of a cron expression. */
export function describeCron(expr: string): string {
  // Authoritative validity comes from the shared engine. If it won't fire, say so
  // plainly rather than inventing a schedule.
  if (!engineIsValid(expr)) return 'Invalid cron expression';

  let p: CronParsed;
  try {
    p = parseCron(expr);
  } catch {
    // Valid per the engine but using syntax this humanizer doesn't model — don't
    // claim it's invalid, just stay vague.
    return 'Runs on a custom schedule';
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const everyMinute = p.minute.length === 60;
  const everyHour = p.hour.length === 24;

  let time: string;
  const minStep = detectStep(p.minute, 60, 0);
  const hrStep = detectStep(p.hour, 24, 0);

  if (everyMinute && everyHour) {
    time = 'every minute';
  } else if (minStep && everyHour) {
    time = `every ${minStep} minutes`;
  } else if (everyMinute && p.hour.length < 24) {
    time = `every minute during ${listText(p.hour, 24, 'hour')}`;
  } else if (p.minute.length === 1 && everyHour) {
    time = `at ${p.minute[0]} minute(s) past every hour`;
  } else if (p.minute.length === 1 && hrStep) {
    time = `every ${hrStep} hours at :${pad(p.minute[0])}`;
  } else if (p.minute.length === 1 && p.hour.length <= 6) {
    time = `at ${p.hour.map((h) => `${pad(h)}:${pad(p.minute[0])}`).join(', ')}`;
  } else {
    time = `at ${listText(p.minute, 60, 'minute')} past ${listText(p.hour, 24, 'hour')}`;
  }

  const clauses: string[] = [];
  if (p.dowRestricted) {
    const days = p.dow.map((d) => DOW_NAMES[d]);
    clauses.push(days.length === 1 ? `on ${days[0]}` : `on ${days.join(', ')}`);
  }
  if (p.domRestricted) {
    const conj = p.dowRestricted ? 'or on day' : 'on day';
    clauses.push(p.dom.length === 1 ? `${conj} ${p.dom[0]} of the month` : `${conj}s ${p.dom.join(', ')} of the month`);
  }
  if (p.month.length < 12) {
    clauses.push(`in ${p.month.map((m) => MONTH_NAMES[m - 1]).join(', ')}`);
  }

  return [time, ...clauses].join(', ').replace(/^./, (c) => c.toUpperCase());
}
