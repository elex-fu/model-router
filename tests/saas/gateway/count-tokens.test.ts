import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COUNT_TOKENS_PRICING_POLICY,
  CountTokensRateLimiter,
  countTokensPolicyHeader,
  estimateCountTokensInputTokens,
  resolveCountTokensPolicy,
} from '../../../src/saas/gateway/count-tokens.js';
import {
  COUNT_TOKENS_FEATURE_ESTIMATE,
  COUNT_TOKENS_FEATURE_NATIVE,
} from '../../../src/saas/gateway/endpoint-registry.js';

test('R2 §7.2: count_tokens resolves native upstream counting when the supply declares it, estimation otherwise', () => {
  assert.deepEqual(resolveCountTokensPolicy(true), { kind: 'native-upstream' });
  const estimate = resolveCountTokensPolicy(false);
  assert.equal(estimate.kind, 'local-estimate');
  assert.ok(estimate.estimatorVersion.length > 0);
});

test('R2 §7.2: the active counting policy is explicitly labeled for the response header', () => {
  assert.equal(countTokensPolicyHeader({ kind: 'native-upstream' }), COUNT_TOKENS_FEATURE_NATIVE);
  assert.equal(
    countTokensPolicyHeader({ kind: 'local-estimate', estimatorVersion: 'v' }),
    COUNT_TOKENS_FEATURE_ESTIMATE,
  );
});

test('R2 §7.2: the pricing policy is explicit — a declared zero, never an implicit free ride', () => {
  assert.deepEqual(COUNT_TOKENS_PRICING_POLICY, {
    operation: 'count_tokens',
    policyVersion: 'count-tokens-policy/v1',
    priceKind: 'explicit-zero',
    rateLimitScope: 'count_tokens',
  });
});

test('R2 §7.2: the estimator bounds a Messages-shaped count_tokens body with the chars/4 heuristic', () => {
  // "hello world, count me" is 21 chars -> ceil(21/4) = 6.
  assert.equal(estimateCountTokensInputTokens({ messages: [{ role: 'user', content: 'hello world, count me' }] }), 6);
  // system prompt and content-block arrays are included.
  assert.equal(
    estimateCountTokensInputTokens({
      system: [{ type: 'text', text: 'abcd' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'abcd' }] }],
    }),
    2,
  );
  // Empty bodies estimate zero; unreadable shapes never throw.
  assert.equal(estimateCountTokensInputTokens({}), 0);
  assert.equal(estimateCountTokensInputTokens({ messages: 'not-an-array' }), 0);
});

test('R2 §7.2: the count_tokens rate limiter is an independent per-key window', () => {
  let nowMs = 0;
  const limiter = new CountTokensRateLimiter(2, () => nowMs);
  assert.deepEqual(limiter.check('key-a'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check('key-a'), { allowed: true, retryAfterSeconds: 0 });
  const denied = limiter.check('key-a');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1);
  // A different key has its own window (independence from other callers).
  assert.deepEqual(limiter.check('key-b'), { allowed: true, retryAfterSeconds: 0 });
  // The window resets after 60s — a fresh budget of 2.
  nowMs = 61_000;
  assert.deepEqual(limiter.check('key-a'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check('key-a'), { allowed: true, retryAfterSeconds: 0 });
  assert.equal(limiter.check('key-a').allowed, false);
});

test('R2 §7.2: the limiter rejects non-positive limits (fail closed construction)', () => {
  assert.throws(() => new CountTokensRateLimiter(0), /positive integer/);
  assert.throws(() => new CountTokensRateLimiter(Number.NaN), /positive integer/);
});
