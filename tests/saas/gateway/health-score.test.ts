import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  effectiveWeight,
  HALF_OPEN_BASE_BACKOFF_MS,
  HALF_OPEN_MAX_BACKOFF_MS,
  HALF_OPEN_PROBE_LEASE_MS,
  HEALTH_SCORE_ALPHA,
  HealthScoreError,
  halfOpenBackoffMs,
  isHalfOpenProbeAllowed,
  parseHealthScoreColumn,
  recordOutcomeEma,
  shouldHalfOpenProbe,
} from '../../../src/saas/gateway/health-score.js';

const T0 = new Date('2026-10-10T00:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function emaSequence(start: number | null, outcomes: readonly ('success' | 'failure')[]): number[] {
  const scores: number[] = [];
  let current = start;
  for (const outcome of outcomes) {
    current = recordOutcomeEma(current, outcome);
    scores.push(current);
  }
  return scores;
}

test('EMA seeds a NULL score optimistically: first success stays 1, first failure lands at 0.800', () => {
  assert.equal(HEALTH_SCORE_ALPHA, 0.2, 'the default alpha matches the authoritative SQL writer');
  assert.equal(recordOutcomeEma(null, 'success'), 1);
  assert.equal(recordOutcomeEma(null, 'failure'), 0.8);
});

test('EMA converges toward 0 on consecutive failures along the exact numeric(4,3) grid', () => {
  const scores = emaSequence(null, Array<'failure'>(30).fill('failure'));
  assert.deepEqual(
    scores.slice(0, 12),
    [0.8, 0.64, 0.512, 0.41, 0.328, 0.262, 0.21, 0.168, 0.134, 0.107, 0.086, 0.069],
  );
  assert.deepEqual(
    scores.slice(12, 24),
    [0.055, 0.044, 0.035, 0.028, 0.022, 0.018, 0.014, 0.011, 0.009, 0.007, 0.006, 0.005],
  );
  assert.deepEqual(scores.slice(24), [0.004, 0.003, 0.002, 0.002, 0.002, 0.002]);
  for (const score of scores) {
    assert.ok(score >= 0 && score <= 1, 'score stays inside [0, 1]');
    assert.equal(score, Math.round(score * 1000) / 1000, 'score stays on the three-decimal grid');
  }
});

test('EMA converges toward 1 on consecutive successes and saturates just below the grid top', () => {
  const scores = emaSequence(0, Array<'success'>(32).fill('success'));
  assert.deepEqual(scores.slice(0, 8), [0.2, 0.36, 0.488, 0.59, 0.672, 0.738, 0.79, 0.832]);
  assert.equal(scores.at(-1), 0.998, 'milli-grid EMA has a fixed point at 0.998, never overshooting 1');
  const ordered = [...scores].sort((a, b) => a - b);
  assert.deepEqual(scores, ordered, 'successes are strictly monotone upward until the fixed point');
});

test('EMA mixes outcomes symmetrically around the grid', () => {
  assert.equal(recordOutcomeEma(0.8, 'success'), 0.84);
  assert.equal(recordOutcomeEma(0.84, 'failure'), 0.672);
  assert.equal(recordOutcomeEma(0, 'success'), 0.2);
  assert.equal(recordOutcomeEma(1, 'failure'), 0.8);
  // The last milli cannot move: 0.2 of a one-milli delta rounds back.
  assert.equal(recordOutcomeEma(0.999, 'success'), 0.999);
  assert.equal(recordOutcomeEma(0.001, 'failure'), 0.001);
});

test('EMA alpha=1 jumps straight to the target and invalid alpha or outcome throws', () => {
  assert.equal(recordOutcomeEma(0.3, 'success', 1), 1);
  assert.equal(recordOutcomeEma(0.3, 'failure', 1), 0);
  assert.equal(recordOutcomeEma(0.5, 'success', 0.5), 0.75);
  for (const alpha of [0, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => recordOutcomeEma(0.5, 'success', alpha),
      (error: unknown) => error instanceof HealthScoreError && error.code === 'MALFORMED_INPUT',
    );
  }
  assert.throws(
    () => recordOutcomeEma(0.5, 'timeout' as never),
    (error: unknown) => error instanceof HealthScoreError && error.code === 'MALFORMED_INPUT',
  );
});

test('EMA rejects malformed scores at both boundaries', () => {
  for (const score of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => recordOutcomeEma(score, 'success'),
      (error: unknown) => error instanceof HealthScoreError && error.code === 'MALFORMED_SCORE',
    );
  }
  assert.equal(recordOutcomeEma(0, 'failure'), 0);
  assert.equal(recordOutcomeEma(1, 'success'), 1);
});

test('effectiveWeight keeps the static weight for NULL scores (pre-R7 binary behavior)', () => {
  assert.equal(effectiveWeight(10, null), 10);
  assert.equal(effectiveWeight(1, null), 1);
});

test('effectiveWeight applies the score multiplier with the 5% floor and integer lower bound 1', () => {
  assert.equal(effectiveWeight(10, 0.5), 5);
  assert.equal(effectiveWeight(10, 1), 10);
  assert.equal(effectiveWeight(100, 0.999), 99);
  assert.equal(effectiveWeight(3, 0.5), 1, 'floor(1.5) = 1');
  assert.equal(effectiveWeight(10, 0), 1, '0.05 floor × 10 = 0.5 → floored to 0 → bounded to 1');
  assert.equal(effectiveWeight(10, 0.04), 1, 'scores below 0.05 clamp to the same 5% floor');
  assert.equal(effectiveWeight(1, 0.002), 1);
});

test('effectiveWeight throws on malformed weights and scores for fail-closed mapping', () => {
  for (const weight of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => effectiveWeight(weight, 0.5),
      (error: unknown) => error instanceof HealthScoreError && error.code === 'MALFORMED_WEIGHT',
    );
  }
  for (const score of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => effectiveWeight(10, score),
      (error: unknown) => error instanceof HealthScoreError && error.code === 'MALFORMED_SCORE',
    );
  }
});

test('half-open backoff doubles from one second and caps at fifteen minutes', () => {
  assert.equal(halfOpenBackoffMs(1), 1_000);
  assert.equal(halfOpenBackoffMs(2), 2_000);
  assert.equal(halfOpenBackoffMs(3), 4_000);
  assert.equal(halfOpenBackoffMs(8), 128_000);
  assert.equal(halfOpenBackoffMs(10), 512_000);
  assert.equal(halfOpenBackoffMs(11), HALF_OPEN_MAX_BACKOFF_MS);
  assert.equal(halfOpenBackoffMs(64), HALF_OPEN_MAX_BACKOFF_MS);
  assert.equal(HALF_OPEN_MAX_BACKOFF_MS, 15 * 60 * 1_000);
  assert.equal(HALF_OPEN_BASE_BACKOFF_MS, 1_000);
});

test('half-open backoff degrades malformed counts to the most conservative ceiling', () => {
  for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(halfOpenBackoffMs(count), HALF_OPEN_MAX_BACKOFF_MS);
  }
});

test('shouldHalfOpenProbe gates on cooldown expiry and the probe crash-recovery lease', () => {
  const expired = at(-1);
  const future = at(1_000);
  assert.equal(shouldHalfOpenProbe(null, null, T0), false, 'no cooldown row is never probe-eligible');
  assert.equal(shouldHalfOpenProbe(future, null, T0), false, 'active cooldown is not probe-eligible');
  assert.equal(shouldHalfOpenProbe(expired, null, T0), true, 'expired cooldown admits the first probe');
  assert.equal(
    shouldHalfOpenProbe(expired, at(-HALF_OPEN_PROBE_LEASE_MS + 1), T0),
    false,
    'a live probe admission blocks further probes',
  );
  assert.equal(
    shouldHalfOpenProbe(expired, at(-HALF_OPEN_PROBE_LEASE_MS), T0),
    true,
    'an admission older than the lease is considered abandoned',
  );
  assert.equal(shouldHalfOpenProbe(expired, null, new Date(Number.NaN)), false);
  assert.equal(shouldHalfOpenProbe(new Date(Number.NaN), null, T0), false);
  assert.equal(shouldHalfOpenProbe(expired, new Date(Number.NaN), T0), false);
});

test('isHalfOpenProbeAllowed mirrors the authoritative concluded-vs-in-flight admission gate', () => {
  const expired = at(-60_000);
  const observed = at(-10_000);
  // No prior probe admission: immediately eligible once the cooldown expired.
  assert.equal(
    isHalfOpenProbeAllowed({ cooldownUntil: expired, halfOpenProbeAt: null, observedAt: observed, now: T0 }),
    true,
  );
  // A concluded probe (outcome recorded at or after its admission) never blocks.
  assert.equal(
    isHalfOpenProbeAllowed({ cooldownUntil: expired, halfOpenProbeAt: at(-20_000), observedAt: observed, now: T0 }),
    true,
  );
  assert.equal(
    isHalfOpenProbeAllowed({ cooldownUntil: expired, halfOpenProbeAt: observed, observedAt: observed, now: T0 }),
    true,
  );
  // An in-flight probe (admission newer than the last outcome) blocks until the lease expires.
  const inflight = at(-5_000);
  assert.equal(
    isHalfOpenProbeAllowed({ cooldownUntil: expired, halfOpenProbeAt: inflight, observedAt: observed, now: T0 }),
    false,
  );
  assert.equal(
    isHalfOpenProbeAllowed({
      cooldownUntil: expired,
      halfOpenProbeAt: inflight,
      observedAt: observed,
      now: at(25_000),
    }),
    true,
    'an admission older than the crash-recovery lease is considered abandoned',
  );
  // NULL or future cooldown: never eligible.
  assert.equal(
    isHalfOpenProbeAllowed({ cooldownUntil: null, halfOpenProbeAt: null, observedAt: observed, now: T0 }),
    false,
  );
  assert.equal(
    isHalfOpenProbeAllowed({ cooldownUntil: at(1_000), halfOpenProbeAt: null, observedAt: observed, now: T0 }),
    false,
  );
  // Malformed inputs fail closed.
  assert.equal(
    isHalfOpenProbeAllowed({
      cooldownUntil: expired,
      halfOpenProbeAt: null,
      observedAt: new Date(Number.NaN),
      now: T0,
    }),
    false,
  );
  assert.equal(
    isHalfOpenProbeAllowed({
      cooldownUntil: expired,
      halfOpenProbeAt: new Date(Number.NaN),
      observedAt: observed,
      now: T0,
    }),
    false,
  );
});

test('parseHealthScoreColumn accepts driver strings and numbers, NULL stays NULL', () => {
  assert.equal(parseHealthScoreColumn(null), null);
  assert.equal(parseHealthScoreColumn(undefined), null);
  assert.equal(parseHealthScoreColumn('0.800'), 0.8);
  assert.equal(parseHealthScoreColumn('1.000'), 1);
  assert.equal(parseHealthScoreColumn('0.000'), 0);
  assert.equal(parseHealthScoreColumn(' 0.500 '), 0.5);
  assert.equal(parseHealthScoreColumn(0.5), 0.5);
  assert.equal(parseHealthScoreColumn(0), 0);
  assert.equal(parseHealthScoreColumn(1), 1);
});

test('parseHealthScoreColumn throws on malformed representations for fail-closed mapping', () => {
  for (const value of ['', 'abc', '1.001', '-0.1', '0.0001', '2', 'NaN', 1.5, -0.5, {}, [], 1n]) {
    assert.throws(
      () => parseHealthScoreColumn(value),
      (error: unknown) => error instanceof HealthScoreError && error.code === 'MALFORMED_SCORE',
      `rejects ${String(value)}`,
    );
  }
});
