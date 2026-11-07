import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, isValidCron, describeCron, nextRuns } from '../src/lib/cron';

const TZ = 'Europe/Athens';

test('rejects expressions without exactly 5 fields', () => {
  assert.ok(!isValidCron('* * *'));
  assert.ok(!isValidCron('* * * * * *'));
  assert.ok(!isValidCron('nonsense'));
  assert.ok(isValidCron('* * * * *'));
});

test('rejects out-of-range values', () => {
  assert.ok(!isValidCron('60 * * * *'), 'minute 60 invalid');
  assert.ok(!isValidCron('* 24 * * *'), 'hour 24 invalid');
  assert.ok(!isValidCron('* * 0 * *'), 'day-of-month 0 invalid');
  assert.ok(!isValidCron('* * * 13 *'), 'month 13 invalid');
});

test('expands *, steps, ranges and lists', () => {
  assert.equal(parseCron('* * * * *').minute.length, 60);
  assert.deepEqual(parseCron('*/15 * * * *').minute, [0, 15, 30, 45]);
  assert.deepEqual(parseCron('0 9-11 * * *').hour, [9, 10, 11]);
  assert.deepEqual(parseCron('0 0 * * 1,3,5').dow, [1, 3, 5]);
});

test('accepts month and weekday names, normalises Sunday 7 to 0', () => {
  assert.deepEqual(parseCron('0 0 * jan *').month, [1]);
  assert.deepEqual(parseCron('0 0 * * mon-fri').dow, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron('0 0 * * 7').dow, [0], 'Sunday as 7 becomes 0');
});

test('tracks whether day-of-month / day-of-week are restricted', () => {
  const p = parseCron('0 0 1 * *');
  assert.equal(p.domRestricted, true);
  assert.equal(p.dowRestricted, false);
});

test('describeCron produces readable summaries', () => {
  assert.equal(describeCron('* * * * *'), 'Every minute');
  assert.equal(describeCron('*/5 * * * *'), 'Every 5 minutes');
  assert.match(describeCron('30 9 * * *'), /09:30/);
  assert.match(describeCron('0 8 * * 1-5'), /Monday.*Friday/);
  assert.match(describeCron('0 0 1 1 *'), /January/);
});

test('describeCron flags an invalid expression instead of throwing', () => {
  assert.match(describeCron('99 * * * *'), /^Invalid/);
});

test('nextRuns returns the requested count, strictly increasing, on the minute', () => {
  const from = new Date('2026-06-01T10:00:30Z');
  const runs = nextRuns('*/5 * * * *', TZ, 4, from);
  assert.equal(runs.length, 4);
  for (let i = 1; i < runs.length; i++) {
    assert.ok(runs[i].getTime() > runs[i - 1].getTime(), 'strictly increasing');
  }
  assert.ok(runs.every((d) => d.getSeconds() === 0), 'aligned to the minute');
});

test('nextRuns respects the target timezone (09:30 Athens = 06:30 UTC in June/DST)', () => {
  const from = new Date('2026-06-01T00:00:00Z');
  const [first] = nextRuns('30 9 * * *', TZ, 1, from);
  // Athens is UTC+3 in June (DST), so 09:30 local == 06:30 UTC.
  assert.equal(first.getUTCHours(), 6);
  assert.equal(first.getUTCMinutes(), 30);
});

test('nextRuns skips the weekend for a weekdays-only schedule', () => {
  // 2026-06-05 is a Friday; next weekday 08:00 run after Fri evening is Monday 08:00.
  const fridayEvening = new Date('2026-06-05T20:00:00Z');
  const [first] = nextRuns('0 8 * * 1-5', TZ, 1, fridayEvening);
  const localDow = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(first);
  assert.equal(localDow, 'Mon', 'rolls over the weekend to Monday');
});

test('day-of-month and day-of-week combine with OR (standard cron)', () => {
  // "on the 1st OR on Monday": a Monday that is not the 1st still matches.
  const p = parseCron('0 0 1 * 1');
  assert.ok(p.domRestricted && p.dowRestricted);
  const runs = nextRuns('0 0 1 * 1', TZ, 6, new Date('2026-06-01T00:00:00Z'));
  assert.ok(runs.length > 0);
});
