import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALPHA_SEARCH_PROVIDER_OPERATION,
  ALPHA_SEARCH_PROVIDER_OPERATIONS,
  ALPHA_SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
  alphaSearchBilling,
  CODEX_ALPHA_SEARCH_URL,
  createAlphaSearchMediaUsagePlan,
  createAlphaSearchUsageUpperBoundEstimator,
  isSuccessfulAlphaSearchStatus,
  observedAlphaSearchCallUsage,
  sanitizeAlphaSearchBody,
} from '../../../../src/saas/gateway/codex/alpha-search.js';
import type {
  ProviderNormalizedRequest,
  ProviderUsageUpperBoundEstimatorInput,
} from '../../../../src/saas/gateway/provider-payload-compiler.js';

test('P2-a: the alpha search target is the pinned ChatGPT codex alpha URL', () => {
  assert.equal(CODEX_ALPHA_SEARCH_URL, 'https://chatgpt.com/backend-api/codex/alpha/search');
  assert.equal(ALPHA_SEARCH_PROVIDER_OPERATION, 'alpha_search');
  assert.deepEqual([...ALPHA_SEARCH_PROVIDER_OPERATIONS], ['alpha_search']);
});

test('P2-a: sanitize strips exactly the sub2api-documented Responses-only fields', () => {
  const body = {
    model: 'gpt-5.2-codex',
    commands: [{ type: 'web_search_run', query: 'model-router' }],
    settings: { search_context_size: 'medium' },
    prompt_cache_key: 'pc-key',
    prompt_cache_retention: '24h',
    store: false,
  };
  const sanitized = sanitizeAlphaSearchBody(body);
  assert.equal(sanitized.prompt_cache_key, undefined);
  assert.equal(sanitized.prompt_cache_retention, undefined);
  assert.equal(sanitized.store, undefined);
  // Everything else rides opaque passthrough, nested values included.
  assert.equal(sanitized.model, 'gpt-5.2-codex');
  assert.deepEqual(sanitized.commands, body.commands);
  assert.deepEqual(sanitized.settings, body.settings);
});

test('P2-a: an already-clean body is returned by reference so payload bytes stay identical', () => {
  const body = { model: 'gpt-5.2-codex', commands: [] };
  const sanitized = sanitizeAlphaSearchBody(body);
  assert.equal(sanitized, body);
});

test('P2-a: only a 2xx upstream response is a billable search call', () => {
  assert.equal(isSuccessfulAlphaSearchStatus(200), true);
  assert.equal(isSuccessfulAlphaSearchStatus(204), true);
  assert.equal(isSuccessfulAlphaSearchStatus(299), true);
  assert.equal(isSuccessfulAlphaSearchStatus(199), false);
  assert.equal(isSuccessfulAlphaSearchStatus(300), false);
  assert.equal(isSuccessfulAlphaSearchStatus(404), false);
});

test('P2-a: one call projects exactly one per-request billable unit', () => {
  const usage = alphaSearchBilling({ model: 'gpt-5.2-codex' });
  assert.equal(usage.billingMode, 'per_request');
  assert.equal(usage.units, 1);
  assert.equal(usage.status, 'reported');
  assert.equal(usage.inputTotal, null);
  assert.equal(usage.outputTotal, null);
  // The body never shapes the bill: one call is one unit regardless.
  assert.deepEqual(alphaSearchBilling(undefined), alphaSearchBilling({ settings: {} }));
});

test('P2-a: the estimator reserves a per-call hold with no token bounds', () => {
  const estimate = createAlphaSearchUsageUpperBoundEstimator().estimate(estimatorInput({ model: 'm' }));
  assert.equal(estimate.inputTotalUpperBound, '0');
  assert.equal(estimate.inputUncachedUpperBound, '0');
  assert.equal(estimate.outputTotalUpperBound, '0');
  assert.equal(estimate.reasoningOutputUpperBound, '0');
  assert.deepEqual(estimate.feasibleInputBuckets, ['input']);
  assert.equal(estimate.perUnitUnitsUpperBound, '1');
  assert.equal(estimate.sizeTier, undefined);
});

test('P2-a: the estimator refuses to bound non-alpha operations instead of guessing', () => {
  assert.throws(() =>
    createAlphaSearchUsageUpperBoundEstimator().estimate(estimatorInput({ model: 'm' }, 'chat.completions')),
  );
  assert.throws(() =>
    createAlphaSearchUsageUpperBoundEstimator().estimate(estimatorInput({ model: 'm', input: 'x' }, 'embeddings')),
  );
});

test('P2-a: the media extractor reports one unit for a usable 2xx body and null otherwise', () => {
  const extractor = createAlphaSearchMediaUsagePlan({
    providerOperation: 'alpha_search',
    payloadBytes: new Uint8Array(),
  })?.extractor;
  assert.ok(extractor);
  const observed = extractor.extract({ results: [{ type: 'text_result', url: 'https://example.com' }] });
  assert.ok(observed);
  assert.equal(observed.billingMode, 'per_request');
  assert.equal(observed.units, 1);
  assert.equal(observed.status, 'reported');
  // An upstream error envelope is never a successful search: unknown usage,
  // never a zero bill.
  assert.equal(extractor.extract({ error: { message: 'no_matching_rule' } }), null);
});

test('P2-a: the media plan binds only for the alpha_search operation', () => {
  const payloadBytes = new Uint8Array();
  assert.equal(createAlphaSearchMediaUsagePlan({ providerOperation: 'embeddings', payloadBytes }), null);
  assert.equal(createAlphaSearchMediaUsagePlan({ providerOperation: undefined, payloadBytes }), null);
  const plan = createAlphaSearchMediaUsagePlan({ providerOperation: 'alpha_search', payloadBytes });
  assert.ok(plan);
  assert.equal(plan.serviceTier, null);
  assert.ok(plan.extractor);
});

test('P2-a: the settlement-side observation is a frozen upstream per-call report', () => {
  const observed = observedAlphaSearchCallUsage();
  assert.equal(observed.source, 'upstream');
  assert.equal(observed.status, 'reported');
  assert.equal(observed.units, 1);
  assert.ok(Object.isFrozen(observed));
});

function normalizedRequest(
  body: unknown,
  providerOperation: ProviderNormalizedRequest['providerOperation'],
): ProviderNormalizedRequest {
  return {
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: providerOperation,
    providerOperation,
    providerId: 'openai-codex',
    productId: 'codex',
    requestedModel: 'public-alias',
    mappedModel: 'catalog-model',
    resolvedModel: 'provider-model',
    modelResolution: {
      requestedModel: 'public-alias',
      mappedModel: 'catalog-model',
      resolvedModel: 'provider-model',
      mappingSource: 'alias',
      mappingVersion: 1,
    },
    body: body as Readonly<Record<string, unknown>>,
  };
}

function estimatorInput(
  body: unknown,
  providerOperation: ProviderNormalizedRequest['providerOperation'] = 'alpha_search',
): ProviderUsageUpperBoundEstimatorInput {
  const normalized = normalizedRequest(body, providerOperation);
  return {
    normalizedRequest: normalized,
    request: normalized,
    providerId: 'openai-codex',
    productId: 'codex',
    providerModel: 'provider-model',
    estimatorVersion: ALPHA_SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
  };
}
