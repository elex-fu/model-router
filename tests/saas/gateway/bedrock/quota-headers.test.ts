import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEDROCK_DEFAULT_RATE_LIMIT_COOLDOWN_MS } from '../../../../src/saas/gateway/bedrock/constants.js';
import { classifyBedrockRateLimit } from '../../../../src/saas/gateway/bedrock/quota-headers.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');

test('an explicit retry-after header wins (seconds and HTTP-date spellings)', () => {
  const body = '{"__type":"ThrottlingException","message":"Too many invocations"}';
  assert.deepEqual(classifyBedrockRateLimit({ headers: { 'retry-after': '30' }, bodyText: body }, NOW), {
    throttlingException: true,
    exceptionType: 'ThrottlingException',
    resetAtMs: NOW + 30_000,
    source: 'retry-after',
  });
  assert.equal(
    classifyBedrockRateLimit({ headers: { 'retry-after': new Date(NOW + 60_000).toUTCString() }, bodyText: body }, NOW)
      .source,
    'retry-after',
  );
});

test('the modeled RetryAfterSeconds detail is the second signal', () => {
  const body = JSON.stringify({
    __type: 'ThrottlingException',
    message: 'Too many invocations',
    details: [{ RetryAfterSeconds: 120 }],
  });
  assert.deepEqual(classifyBedrockRateLimit({ headers: {}, bodyText: body }, NOW), {
    throttlingException: true,
    exceptionType: 'ThrottlingException',
    resetAtMs: NOW + 120_000,
    source: 'modeled-hint',
  });
});

test('the fixed default cooldown applies when no hint is present', () => {
  const body = '{"__type":"ThrottlingException"}';
  assert.deepEqual(classifyBedrockRateLimit({ headers: {}, bodyText: body }, NOW), {
    throttlingException: true,
    exceptionType: 'ThrottlingException',
    resetAtMs: NOW + BEDROCK_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    source: 'default-cooldown',
  });
});

test('an implausible retry-after deadline is rejected and the next signal is tried', () => {
  const body = JSON.stringify({
    __type: 'ThrottlingException',
    details: [{ RetryAfterSeconds: 90 }],
  });
  const result = classifyBedrockRateLimit(
    { headers: { 'retry-after': '999999' }, bodyText: body, maxAheadMs: 60 * 60 * 1000 },
    NOW,
  );
  assert.equal(result.source, 'modeled-hint');
  assert.equal(result.resetAtMs, NOW + 90_000);
});

test('a non-throttling body records the classification but keeps the cooldown signal', () => {
  const result = classifyBedrockRateLimit(
    { headers: { 'retry-after': '45' }, bodyText: '{"__type":"ValidationException"}' },
    NOW,
  );
  assert.equal(result.throttlingException, false);
  assert.equal(result.exceptionType, 'ValidationException');
  assert.equal(result.resetAtMs, NOW + 45_000);
});
