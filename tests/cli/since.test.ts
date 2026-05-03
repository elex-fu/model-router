import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSinceRange } from '../../src/cli/since.js';

test('resolveSinceRange: "7d" returns range from 7 days ago through today', () => {
  const today = '2026-05-03';
  const r = resolveSinceRange('7d', today);
  assert.equal(r.fromDate, '2026-04-26');
  assert.equal(r.toDate, '2026-05-03');
});

test('resolveSinceRange: "1d" returns yesterday through today', () => {
  const today = '2026-05-03';
  const r = resolveSinceRange('1d', today);
  assert.equal(r.fromDate, '2026-05-02');
  assert.equal(r.toDate, '2026-05-03');
});

test('resolveSinceRange: "0d" returns just today', () => {
  const today = '2026-05-03';
  const r = resolveSinceRange('0d', today);
  assert.equal(r.fromDate, '2026-05-03');
  assert.equal(r.toDate, '2026-05-03');
});

test('resolveSinceRange: ISO date string passes through', () => {
  const today = '2026-05-03';
  const r = resolveSinceRange('2026-04-01', today);
  assert.equal(r.fromDate, '2026-04-01');
  assert.equal(r.toDate, '2026-05-03');
});

test('resolveSinceRange: undefined defaults to today', () => {
  const today = '2026-05-03';
  const r = resolveSinceRange(undefined, today);
  assert.equal(r.fromDate, '2026-05-03');
  assert.equal(r.toDate, '2026-05-03');
});

test('resolveSinceRange: rejects invalid format', () => {
  assert.throws(() => resolveSinceRange('garbage', '2026-05-03'), /since/);
  assert.throws(() => resolveSinceRange('5x', '2026-05-03'), /since/);
  assert.throws(() => resolveSinceRange('2026-13-01', '2026-05-03'), /since/);
});

test('resolveSinceRange: month boundary "30d" goes back across months', () => {
  const today = '2026-05-03';
  const r = resolveSinceRange('30d', today);
  assert.equal(r.fromDate, '2026-04-03');
});
