// The one and only cron engine, shared by the scheduler, the API and the web
// console so a schedule preview can never disagree with what actually fires.
// Wraps `cron-parser` (which handles IANA timezones + DST correctly).
//
// Expressions are standard 5-field: minute hour day-of-month month day-of-week.

import parser from 'cron-parser';

/**
 * CronApp schedules are standard 5-field (minute hour day-of-month month
 * day-of-week). cron-parser also accepts a 6-field form with a leading seconds
 * column, but the scheduler ticks on a coarse interval and can't honour
 * sub-minute precision — so a seconds field would be a silent lie. We reject
 * anything that isn't exactly 5 fields before handing it to the parser.
 */
function fieldCountError(cronExpr: string): string | null {
  const trimmed = cronExpr.trim();
  const n = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  return n === 5 ? null : `Expected 5 fields (minute hour day month weekday), got ${n}`;
}

/** Validate a cron expression in a timezone; returns an error message or null. */
export function validateCron(cronExpr: string, timezone = 'UTC'): string | null {
  const fieldErr = fieldCountError(cronExpr);
  if (fieldErr) return fieldErr;
  try {
    parser.parseExpression(cronExpr, { tz: timezone });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** True when the expression parses. */
export function isValidCron(cronExpr: string, timezone = 'UTC'): boolean {
  return validateCron(cronExpr, timezone) === null;
}

/** Next fire time at/after `from`, evaluated in `timezone`. Throws on an
 *  expression that isn't a valid 5-field cron. */
export function nextRun(cronExpr: string, timezone: string, from: Date = new Date()): Date {
  const fieldErr = fieldCountError(cronExpr);
  if (fieldErr) throw new Error(fieldErr);
  return parser.parseExpression(cronExpr, { currentDate: from, tz: timezone }).next().toDate();
}

/**
 * The next `count` fire times at/after `from`, in `timezone`. Returns an empty
 * array for an invalid expression (callers render previews, not errors).
 */
export function nextRuns(
  cronExpr: string,
  timezone: string,
  count = 5,
  from: Date = new Date(),
): Date[] {
  if (fieldCountError(cronExpr)) return [];
  try {
    const it = parser.parseExpression(cronExpr, { currentDate: from, tz: timezone });
    const out: Date[] = [];
    for (let i = 0; i < count; i++) out.push(it.next().toDate());
    return out;
  } catch {
    return [];
  }
}
