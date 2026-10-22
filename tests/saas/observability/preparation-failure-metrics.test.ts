import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Registry } from 'prom-client';
import {
  type PreparationFailureObservation,
  withPreparationFailureObserver,
} from '../../../src/saas/gateway/preparation-failure-observer.js';
import type {
  RequestPreparationInput,
  RequestPreparationPreparedResult,
  RequestPreparationResult,
} from '../../../src/saas/gateway/request-preparation-service.js';
import {
  createPreparationFailureMetricsObserver,
  SAAS_GATEWAY_PREPARATION_FAILURES_TOTAL,
} from '../../../src/saas/observability/preparation-failure-metrics.js';

const input = {} as RequestPreparationInput;

test('failure observer receives only the fixed three-field projection once', async () => {
  const privateValue = randomUUID();
  const result: RequestPreparationResult = {
    outcome: 'blocked',
    stage: 'admission',
    code: 'storage_failure',
    reason: privateValue,
    requestId: privateValue,
    attemptId: privateValue,
    evidence: null,
  };
  const observations: PreparationFailureObservation[] = [];
  let calls = 0;
  const port = withPreparationFailureObserver(
    {
      async prepare(received) {
        assert.equal(received, input);
        calls += 1;
        return result;
      },
    },
    (observation) => {
      observations.push(observation);
    },
  );
  assert.equal(await port.prepare(input), result);
  assert.equal(calls, 1);
  assert.deepEqual(observations, [{ outcome: 'blocked', stage: 'admission', code: 'storage_failure' }]);
  assert.equal(Object.isFrozen(observations[0]), true);
  assert.ok(!JSON.stringify(observations).includes(privateValue));
});

test('throwing observer preserves the original failure result', async () => {
  const result: RequestPreparationResult = {
    outcome: 'rejected',
    stage: 'authority',
    code: 'account_denied',
    reason: '',
    evidence: null,
  };
  const port = withPreparationFailureObserver(
    {
      async prepare() {
        return result;
      },
    },
    () => {
      throw new Error('observer unavailable');
    },
  );
  assert.equal(await port.prepare(input), result);
});

test('prepared results and service exceptions preserve their identity and order', async () => {
  const result = { outcome: 'prepared' } as RequestPreparationPreparedResult;
  let observed = 0;
  const port = withPreparationFailureObserver(
    {
      async prepare() {
        return result;
      },
    },
    () => {
      observed += 1;
    },
  );
  assert.equal(await port.prepare(input), result);
  assert.equal(observed, 0);
  const original = new Error('preparation unavailable');
  const throwing = withPreparationFailureObserver(
    {
      async prepare() {
        throw original;
      },
    },
    () => {
      observed += 1;
    },
  );
  await assert.rejects(throwing.prepare(input), (error) => error === original);
  assert.equal(observed, 0);
});

test('absent observer returns the same preparation port', () => {
  const port = {
    async prepare(): Promise<RequestPreparationResult> {
      throw new Error('unused');
    },
  };
  assert.equal(withPreparationFailureObserver(port), port);
});

test('failure counter registers once and retains fixed outcome/stage/code labels only', async () => {
  const registry = new Registry();
  const observe = createPreparationFailureMetricsObserver(registry);
  assert.equal(observe, createPreparationFailureMetricsObserver(registry));
  observe({ outcome: 'blocked', stage: 'payload', code: 'payload_bounds_unavailable' });
  observe({ outcome: 'blocked', stage: 'payload', code: 'payload_bounds_unavailable' });
  observe({ outcome: 'rejected', stage: 'authority', code: 'account_denied' });
  const metrics = await registry.metrics();
  assert.match(
    metrics,
    /saas_gateway_preparation_failures_total\{outcome="blocked",stage="payload",code="payload_bounds_unavailable"\} 2/,
  );
  assert.match(
    metrics,
    /saas_gateway_preparation_failures_total\{outcome="rejected",stage="authority",code="account_denied"\} 1/,
  );
  assert.equal(registry.getMetricsAsArray().length, 1);
  assert.ok(registry.getSingleMetric(SAAS_GATEWAY_PREPARATION_FAILURES_TOTAL));
});

test('invalid observations cannot turn private values into metric labels', async () => {
  const registry = new Registry();
  const observe = createPreparationFailureMetricsObserver(registry);
  const privateValue = randomUUID();
  for (const invalid of [
    { outcome: privateValue, stage: 'authority', code: 'storage_failure' },
    { outcome: 'blocked', stage: privateValue, code: 'storage_failure' },
    { outcome: 'blocked', stage: 'authority', code: privateValue },
  ])
    observe(invalid as unknown as PreparationFailureObservation);
  const metrics = await registry.metrics();
  assert.ok(!metrics.includes(privateValue));
  assert.ok(!metrics.includes(`${SAAS_GATEWAY_PREPARATION_FAILURES_TOTAL}{`));
});
