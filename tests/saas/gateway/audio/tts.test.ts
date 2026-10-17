import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTtsUsageUpperBoundEstimator,
  observedTtsUsage,
  TTS_MAX_INPUT_RUNES,
  TTS_PROVIDER_OPERATION,
  TTS_SIZE_TIER,
  TTS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
  ttsBillingRunes,
  ttsInputRunes,
  ttsInputText,
} from '../../../../src/saas/gateway/audio/tts.js';
import type { ProviderUsageUpperBoundEstimatorInput } from '../../../../src/saas/gateway/provider-payload-compiler.js';

/**
 * §4.3 (task #17) TTS audio billing unit tests — the pure module behind the
 * /v1/tts passthrough (validation, rune counting, exact per-unit bounds, and
 * the settlement observation shape).
 */

const ASTRAL = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';

function estimatorInput(operation: string, body: unknown): ProviderUsageUpperBoundEstimatorInput {
  const normalizedRequest = {
    clientProtocol: 'responses',
    providerProtocol: 'responses',
    clientOperation: operation,
    providerOperation: operation,
    providerId: 'xai-grok',
    productId: 'grok-subscription',
    requestedModel: 'public-model',
    mappedModel: 'catalog-model',
    resolvedModel: 'provider-model',
    modelResolution: {
      requestedModel: 'public-model',
      mappedModel: 'catalog-model',
      resolvedModel: 'provider-model',
      mappingSource: 'alias',
      mappingVersion: 1,
    },
    body,
  } as unknown as ProviderUsageUpperBoundEstimatorInput['normalizedRequest'];
  return {
    normalizedRequest,
    request: normalizedRequest,
    providerId: 'xai-grok',
    productId: 'grok-subscription',
    providerModel: 'provider-model',
    estimatorVersion: TTS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
  };
}

test('4.3 tts: the spoken text is the trimmed `input` field; structural misses fail closed', () => {
  assert.equal(ttsInputText({ input: '  hello  ' }), 'hello');
  assert.equal(ttsInputText({ input: 'hello' }), 'hello');
  assert.equal(ttsInputText({}), null);
  assert.equal(ttsInputText({ input: '' }), null);
  assert.equal(ttsInputText({ input: '   ' }), null);
  assert.equal(ttsInputText({ input: 42 }), null);
  assert.equal(ttsInputText({ input: ['hello'] }), null);
  assert.equal(ttsInputText('not-a-record'), null);
  assert.equal(ttsInputText(null), null);
});

test('4.3 tts: rune counting is code points, not UTF-16 units (astral characters count once)', () => {
  assert.equal(ttsInputRunes('hello'), 5);
  // 7 code points (4 emoji + 3 joiners), 14 UTF-16 units.
  assert.equal(ASTRAL.length, 11);
  assert.equal(ttsInputRunes(ASTRAL), 7);
  assert.equal(ttsInputRunes(`a${ASTRAL}b`), 9);
});

test('4.3 tts: the billing unit count bounds the input and rejects over-cap text', () => {
  assert.equal(ttsBillingRunes({ input: 'hello world' }), 11);
  assert.equal(ttsBillingRunes({ input: `  ${ASTRAL}  ` }), 7, 'billing uses the trimmed text');
  assert.equal(ttsBillingRunes({ input: 'x'.repeat(TTS_MAX_INPUT_RUNES) }), TTS_MAX_INPUT_RUNES);
  assert.equal(ttsBillingRunes({ input: 'x'.repeat(TTS_MAX_INPUT_RUNES + 1) }), null);
  assert.equal(ttsBillingRunes({ input: '' }), null);
  assert.equal(ttsBillingRunes({ input: 'x', voice: 'marin' }), 1, 'voice fields do not affect billing');
});

test('4.3 tts: the estimator bounds the exact character count on the fixed tts tier', () => {
  const estimator = createTtsUsageUpperBoundEstimator();
  assert.equal(estimator.version, TTS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION);
  const estimate = estimator.estimate(estimatorInput(TTS_PROVIDER_OPERATION, { input: `memo ${ASTRAL}` }));
  assert.deepEqual(estimate, {
    inputTotalUpperBound: '0',
    inputUncachedUpperBound: '0',
    cacheReadUpperBound: '0',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '0',
    reasoningOutputUpperBound: '0',
    feasibleInputBuckets: ['input'],
    perUnitUnitsUpperBound: '12', // "memo " (5) + 7 code points
    sizeTier: TTS_SIZE_TIER,
  });
});

test('4.3 tts: the estimator fails closed on miscomposition and on an invalid body', () => {
  const estimator = createTtsUsageUpperBoundEstimator();
  assert.throws(() => estimator.estimate(estimatorInput('responses', { input: 'x' })), /only serves the audio\.tts/);
  assert.throws(() => estimator.estimate(estimatorInput('web_search', { input: 'x' })), /only serves the audio\.tts/);
  assert.throws(
    () => estimator.estimate(estimatorInput(TTS_PROVIDER_OPERATION, { voice: 'marin' })),
    /non-empty input/,
  );
  assert.throws(
    () => estimator.estimate(estimatorInput(TTS_PROVIDER_OPERATION, { input: 'x'.repeat(TTS_MAX_INPUT_RUNES + 1) })),
    /non-empty input/,
  );
});

test('4.3 tts: the observed settlement usage is the audio mode with the exact units on the tts tier', () => {
  const usage = observedTtsUsage(1234);
  assert.equal(usage.billingMode, 'audio');
  assert.equal(usage.units, 1234);
  assert.equal(usage.sizeTier, 'tts');
  assert.equal(usage.inputTotal, null);
  assert.equal(usage.outputTotal, null);
  assert.equal(usage.status, 'reported');
  assert.equal(usage.source, 'upstream');
  // Frozen: the settlement observation is never mutated downstream.
  assert.ok(Object.isFrozen(usage));
});
