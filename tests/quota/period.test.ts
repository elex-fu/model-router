import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaPeriod } from '../../src/quota/period.js';

test('Asia/Shanghai day is not tied to UTC midnight', () => {
  const period = quotaPeriod(Date.parse('2026-09-22T17:00:00Z'), 'Asia/Shanghai');
  assert.equal(period.id, '2026-09-23');
  assert.equal(new Date(period.startMs).toISOString(), '2026-09-22T16:00:00.000Z');
  assert.equal(new Date(period.endMs).toISOString(), '2026-09-23T16:00:00.000Z');
});

test('DST days can be 23 or 25 hours', () => {
  const spring = quotaPeriod(Date.parse('2026-03-08T16:00:00Z'), 'America/New_York');
  const fall = quotaPeriod(Date.parse('2026-11-01T16:00:00Z'), 'America/New_York');
  assert.equal(spring.endMs - spring.startMs, 23 * 60 * 60 * 1000);
  assert.equal(fall.endMs - fall.startMs, 25 * 60 * 60 * 1000);
});

test('period version prefix keeps same local day distinct across timezone revisions', () => {
  const atMs = Date.parse('2026-09-23T12:00:00Z');
  const before = quotaPeriod(atMs, 'UTC', 4);
  const after = quotaPeriod(atMs, 'UTC', 5);
  assert.notEqual(before.id, after.id);
  assert.match(before.id, /^v4:2026-09-23$/);
  assert.match(after.id, /^v5:2026-09-23$/);
});

test('DST transition periods retain versioned IDs and calendar boundaries', () => {
  const spring = quotaPeriod(Date.parse('2026-03-08T16:00:00Z'), 'America/New_York', 'spring');
  const fall = quotaPeriod(Date.parse('2026-11-01T16:00:00Z'), 'America/New_York', 'fall');
  assert.match(spring.id, /^vspring:2026-03-08$/);
  assert.match(fall.id, /^vfall:2026-11-01$/);
  assert.equal(spring.endMs - spring.startMs, 23 * 60 * 60 * 1000);
  assert.equal(fall.endMs - fall.startMs, 25 * 60 * 60 * 1000);
});
