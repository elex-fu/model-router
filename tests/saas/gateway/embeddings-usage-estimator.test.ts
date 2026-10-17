import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmbeddingsUsageUpperBoundEstimator,
  EMBEDDINGS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
  embeddingsInputTokenUpperBound,
  selectUsageUpperBoundEstimatorByOperation,
} from '../../../src/saas/gateway/embeddings-usage-estimator.js';
import type {
  ProviderNormalizedRequest,
  ProviderUsageUpperBoundEstimatorInput,
} from '../../../src/saas/gateway/provider-payload-compiler.js';
import { createVideoUsageUpperBoundEstimator } from '../../../src/saas/gateway/videos/video-usage-estimator.js';

function normalizedRequest(
  body: unknown,
  providerOperation: ProviderNormalizedRequest['providerOperation'] = 'embeddings',
): ProviderNormalizedRequest {
  return {
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: providerOperation,
    providerOperation,
    providerId: 'provider-a',
    productId: 'product-a',
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
  providerOperation: ProviderNormalizedRequest['providerOperation'] = 'embeddings',
): ProviderUsageUpperBoundEstimatorInput {
  const normalized = normalizedRequest(body, providerOperation);
  return {
    normalizedRequest: normalized,
    request: normalized,
    providerId: 'provider-a',
    productId: 'product-a',
    providerModel: 'provider-model',
    estimatorVersion: EMBEDDINGS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION,
  };
}

test('R2: text embeddings input is bounded by characters divided by four (rounded up)', () => {
  assert.equal(embeddingsInputTokenUpperBound(''), 0);
  assert.equal(embeddingsInputTokenUpperBound('ab'), 1);
  assert.equal(embeddingsInputTokenUpperBound('abcd'), 1);
  assert.equal(embeddingsInputTokenUpperBound('abcde'), 2);
  assert.equal(embeddingsInputTokenUpperBound('你好世界测试'), 2);
});

test('R2: pre-tokenized id vectors are counted exactly and text arrays sum per element', () => {
  assert.equal(embeddingsInputTokenUpperBound([1, 2, 3, 4, 5]), 5);
  assert.equal(embeddingsInputTokenUpperBound(['abcd', 'efgh']), 2);
  assert.equal(embeddingsInputTokenUpperBound(['abcde', [1, 2, 3]]), 5);
  assert.equal(embeddingsInputTokenUpperBound([]), 0);
});

test('R2: the estimator reserves input-only hold bounds with no output', () => {
  const estimate = createEmbeddingsUsageUpperBoundEstimator().estimate(
    estimatorInput({ model: 'provider-model', input: 'a'.repeat(40) }),
  );
  assert.equal(estimate.inputTotalUpperBound, '10');
  assert.equal(estimate.inputUncachedUpperBound, '10');
  assert.equal(estimate.outputTotalUpperBound, '0');
  assert.equal(estimate.reasoningOutputUpperBound, '0');
  assert.deepEqual(estimate.feasibleInputBuckets, ['input']);
});

test('R2: the estimator refuses to bound non-embeddings operations instead of guessing', () => {
  assert.throws(() =>
    createEmbeddingsUsageUpperBoundEstimator().estimate(
      estimatorInput({ model: 'provider-model', messages: [] }, 'chat.completions'),
    ),
  );
});

test('R2: the operation selector routes embeddings to the embeddings estimator and everything else to the default', () => {
  const defaultEstimator = {
    version: 'default-v1',
    estimate: () => ({ inputTotalUpperBound: 1 }),
  };
  const selector = selectUsageUpperBoundEstimatorByOperation({ default: defaultEstimator });
  assert.match(selector.version, /^default-v1\+/);
  const chat = selector.estimate(estimatorInput({ model: 'm', messages: [] }, 'chat.completions'));
  assert.equal(chat.inputTotalUpperBound, 1);
  const embeddings = selector.estimate(estimatorInput({ model: 'm', input: 'abcd' }));
  assert.equal(embeddings.inputTotalUpperBound, '1');
  assert.equal(embeddings.outputTotalUpperBound, '0');
});

test('4.3: the operation selector routes the videos.* family to the video estimator', () => {
  const defaultEstimator = {
    version: 'default-v1',
    estimate: () => ({ inputTotalUpperBound: 1 }),
  };
  const selector = selectUsageUpperBoundEstimatorByOperation({
    default: defaultEstimator,
    videos: createVideoUsageUpperBoundEstimator(),
  });
  assert.match(selector.version, /^default-v1\+embeddings-usage-upper-bound\/v1\+video-usage-upper-bound\/v1$/);
  const video = selector.estimate(
    estimatorInput({ model: 'grok-imagine-video-1.5', prompt: 'p', resolution: '720p', n: 2 }, 'videos.generations'),
  );
  assert.equal(video.inputTotalUpperBound, '0');
  // The conservative hold: 15s × n = 30 per-unit seconds at the request tier.
  assert.equal(video.perUnitUnitsUpperBound, '30');
  assert.equal(video.sizeTier, '720p');
  // Everything else (chat, embeddings) keeps its own estimator.
  const chat = selector.estimate(estimatorInput({ model: 'm', messages: [] }, 'chat.completions'));
  assert.equal(chat.inputTotalUpperBound, 1);
});
