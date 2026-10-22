import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from 'prom-client';
import {
  observePreparedEvidenceDispatchStage,
  type PreparedEvidenceDispatchObservation,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-observer.js';
import {
  createPreparedEvidenceDispatchMetricsObserver,
  SAAS_GATEWAY_DISPATCH_STAGE_DURATION_SECONDS,
} from '../../../src/saas/observability/dispatch-metrics.js';

test('dispatch metric callbacks register once and keep body delivery separate from settlement', async () => {
  const registry = new Registry();
  const observe = createPreparedEvidenceDispatchMetricsObserver(registry);
  assert.equal(createPreparedEvidenceDispatchMetricsObserver(registry), observe);
  observe({ stage: 'response-delivery', durationMs: 25, outcome: 'ok' });
  observe({ stage: 'settlement', durationMs: 50, outcome: 'error' });
  const text = await registry.metrics();
  assert.match(text, /_sum\{stage="response-delivery",outcome="ok"\} 0\.025/);
  assert.match(text, /_sum\{stage="settlement",outcome="error"\} 0\.05/);
  assert.equal(registry.getMetricsAsArray().length, 1);
  assert.ok(registry.getSingleMetric(SAAS_GATEWAY_DISPATCH_STAGE_DURATION_SECONDS));
});

test('unknown or invalid dispatch metric observations never create identity labels', async () => {
  const registry = new Registry();
  const observe = createPreparedEvidenceDispatchMetricsObserver(registry);
  const base = { stage: 'claim', durationMs: 1, outcome: 'ok' } as const;
  for (let index = 0; index < 1000; index += 1) {
    observe({ ...base, stage: `private-request-${index}` } as unknown as PreparedEvidenceDispatchObservation);
  }
  for (const invalid of [
    { durationMs: Number.NaN },
    { durationMs: Infinity },
    { durationMs: -1 },
    { outcome: 'private' },
  ])
    observe({ ...base, ...invalid } as PreparedEvidenceDispatchObservation);
  assert.doesNotMatch(await registry.metrics(), /_count\{|private|NaN|Infinity/);
});

test('timing preserves values and original errors when the observer throws', async () => {
  const observer = () => {
    throw new Error('diagnostics failed');
  };
  assert.equal(await observePreparedEvidenceDispatchStage('preflight', observer, async () => 42), 42);
  const failure = new Error('original storage failure');
  await assert.rejects(
    observePreparedEvidenceDispatchStage('claim', observer, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
