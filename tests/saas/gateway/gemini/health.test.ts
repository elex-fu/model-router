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
