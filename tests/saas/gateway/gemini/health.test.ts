import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUpstreamError, shouldFailover } from '../../../../src/saas/gateway/gemini/health.js';

/**
 * The Gemini package consumes the shared oauth-subscription health
 * classifier (the same extraction the claude package uses). These assertions
 * pin the decision matrix as the gemini transport sees it (gemini/health.ts
 * re-export) — over Google JSON error body shaped failures.
 */

test('401 splits revoked from expired; expired does not fail over', () => {
  const revoked = classifyUpstreamError({
    status: 401,
    bodyText: '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"token_revoked"}}',
  });
  assert.equal(revoked.kind, 'auth-revoked');
  assert.equal(shouldFailover(revoked), true);

  const expired = classifyUpstreamError({
    status: 401,
    bodyText:
      '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials"}}',
  });
  assert.equal(expired.kind, 'auth-expired');
  assert.equal(shouldFailover(expired), false);
});

test('429 is rate-limited with failover; 5xx maps to transient without failover', () => {
  const rateLimited = classifyUpstreamError({
    status: 429,
    bodyText: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}',
  });
  assert.equal(rateLimited.kind, 'rate-limited');
  assert.equal(shouldFailover(rateLimited), true);

  const unavailable = classifyUpstreamError({
    status: 503,
    bodyText: '{"error":{"code":503,"status":"UNAVAILABLE","message":"try again"}}',
  });
  assert.equal(unavailable.kind, 'transient');
  assert.equal(shouldFailover(unavailable), false);

  const badRequest = classifyUpstreamError({
    status: 400,
    bodyText: '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"bad shape"}}',
  });
  assert.equal(badRequest.kind, 'request-error');
  assert.equal(shouldFailover(badRequest), false);
});

test('batch 2.3: the shared matrix extension reaches the gemini transport view', () => {
  assert.equal(classifyUpstreamError({ status: 402, bodyText: 'insufficient balance' }).kind, 'insufficient-balance');
  assert.equal(classifyUpstreamError({ status: 404, bodyText: 'model not found' }).kind, 'model-unavailable');
  assert.equal(classifyUpstreamError({ status: 403, bodyText: 'quota will reset' }).kind, 'rate-limited');
  assert.equal(
    classifyUpstreamError({
      status: 403,
      bodyText:
        "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
    }).kind,
    'concurrency-limited',
  );
});
