import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCron, isValidCron, nextRun, nextRuns } from '../src/index';

const TZ = 'Europe/Athens';

test('validateCron accepts a standard 5-field expression', () => {
  assert.equal(validateCron('*/5 * * * *'), null);
  assert.equal(validateCron('0 3 * * 1-5', TZ), null);
});

test('validateCron rejects anything that is not exactly 5 fields', () => {
  // Too few, too many (incl. the 6-field seconds form cron-parser would accept),
  // and empty all fail with a clear message.
  for (const bad of ['', '   ', '* * *', '* * * *', '* * * * * *', '0 0 * * * *']) {
    const err = validateCron(bad);
    assert.ok(err, `expected error for "${bad}"`);
    assert.match(err!, /Expected 5 fields/);
  }
});

test('validateCron rejects out-of-range fields via the parser', () => {
  assert.ok(validateCron('60 * * * *'));
  assert.ok(validateCron('* 24 * * *'));
  assert.ok(validateCron('* * 0 * *'));
  assert.ok(validateCron('* * * 13 *'));
});

test('isValidCron mirrors validateCron', () => {
  assert.equal(isValidCron('* * * * *'), true);
  assert.equal(isValidCron('* * * * * *'), false);
  assert.equal(isValidCron('nonsense'), false);
});

test('nextRun throws on a non-5-field expression', () => {
  assert.throws(() => nextRun('* * * * * *', TZ), /Expected 5 fields/);
});

test('nextRun returns the next aligned fire time', () => {
  const from = new Date('2026-06-01T10:02:30Z');
  const d = nextRun('*/5 * * * *', 'UTC', from);
  assert.equal(d.getUTCSeconds(), 0);
  assert.equal(d.getUTCMinutes(), 5);
  assert.ok(d.getTime() > from.getTime());
});

test('nextRuns returns [] for an invalid expression and N times for a valid one', () => {
  assert.deepEqual(nextRuns('* * * * * *', TZ, 3), []);
  assert.deepEqual(nextRuns('99 * * * *', TZ, 3), []);
  const runs = nextRuns('0 * * * *', 'UTC', 3, new Date('2026-06-01T10:30:00Z'));
  assert.equal(runs.length, 3);
  assert.ok(runs.every((d) => d.getUTCMinutes() === 0));
});

test('nextRun honours the target timezone across DST (Athens is UTC+3 in June)', () => {
  const from = new Date('2026-06-01T00:00:00Z');
  const d = nextRun('30 9 * * *', TZ, from);
  assert.equal(d.getUTCHours(), 6);
  assert.equal(d.getUTCMinutes(), 30);
});
