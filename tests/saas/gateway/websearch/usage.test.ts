import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NormalSuccessObservedUsage } from '../../../../src/saas/gateway/dispatch-usage-settlement.js';
import {
  createSearchMediaUsageExtractor,
  createSearchUsageUpperBoundEstimator,
  observedSearchCallUsage,
  SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
} from '../../../../src/saas/gateway/websearch/usage.js';
import { createSearchMediaUsagePlan } from '../../../../src/saas/gateway/websearch/usage-plan.js';

/**
 * §4.3 (task #17): the search billing seam — per-call hold estimate and the
 * settlement-side usage extractor.
 */

test('4.3 search: the estimator bounds one call at exactly one unit, no tier', () => {
  const estimator = createSearchUsageUpperBoundEstimator();
  assert.equal(estimator.version, SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION);
  for (const operation of ['web_search', 'x_search'] as const) {
    const estimate = estimator.estimate({
      normalizedRequest: { providerOperation: operation, body: { query: 'q' } },
    } as never) as {
      perUnitUnitsUpperBound: string;
      sizeTier?: string;
      inputTotalUpperBound: string;
      outputTotalUpperBound: string;
      feasibleInputBuckets: readonly string[];
    };
    assert.equal(estimate.perUnitUnitsUpperBound, '1');
    assert.equal(estimate.sizeTier, undefined);
    assert.equal(estimate.inputTotalUpperBound, '0');
    assert.equal(estimate.outputTotalUpperBound, '0');
    assert.deepEqual(estimate.feasibleInputBuckets, ['input']);
  }
  // Miscomposition is a closed failure, never a silently wrong bound.
  assert.throws(
    () =>
      estimator.estimate({
        normalizedRequest: { providerOperation: 'responses' as never, body: {} },
      } as never),
    /web_search\/x_search/,
  );
});

test('4.3 search: the extractor reports one per_request unit for a usable envelope', () => {
  const extractor = createSearchMediaUsageExtractor();
  assert.ok(extractor.operations.has('web_search'));
  assert.ok(extractor.operations.has('x_search'));
  const usage = extractor.extract({
    id: 'resp_1',
    output: [{ type: 'message', content: [] }],
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  assert.ok(usage);
  assert.equal(usage.billingMode, 'per_request');
  assert.equal(usage.units, 1);
  assert.equal(usage.sizeTier, null);
  assert.equal(usage.status, 'reported');
  // Token counters are the search model's internal cost, not the customer's.
  assert.equal(usage.inputTotal, null);
  assert.equal(usage.outputTotal, null);

  // Unusable bodies extract nothing (unknown usage, never zero billing).
  assert.equal(extractor.extract({ error: { message: 'boom' } }), null);
  assert.equal(extractor.extract({ id: 'resp_1' }), null);
  assert.equal(extractor.extract({}), null);
  assert.equal(extractor.extract(null as never), null);
});

test('4.3 search: the observed settlement usage is a complete upstream report', () => {
  const usage: NormalSuccessObservedUsage = observedSearchCallUsage();
  assert.equal(usage.billingMode, 'per_request');
  assert.equal(usage.units, 1);
  assert.equal(usage.status, 'reported');
  assert.equal(usage.source, 'upstream');
});

test('4.3 search: the media usage plan binds only the search operations', () => {
  const plan = createSearchMediaUsagePlan({
    providerOperation: 'web_search',
    payloadBytes: new TextEncoder().encode('{"input": "x"}'),
  });
  assert.ok(plan);
  assert.ok(plan.extractor);
  assert.equal(plan.serviceTier, null);
  const usage = plan.extractor!.extract({ output: [] });
  assert.equal(usage?.units, 1);

  assert.equal(createSearchMediaUsagePlan({ providerOperation: 'responses', payloadBytes: new Uint8Array() }), null);
  assert.equal(createSearchMediaUsagePlan({ providerOperation: undefined, payloadBytes: new Uint8Array() }), null);
  assert.equal(
    createSearchMediaUsagePlan({ providerOperation: 'images.generations', payloadBytes: new Uint8Array() }),
    null,
  );
});
