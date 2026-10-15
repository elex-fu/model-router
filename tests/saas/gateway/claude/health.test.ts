import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUpstreamError, shouldFailover } from '../../../../src/saas/gateway/claude/health.js';

/**
 * The Claude package consumes the shared oauth-subscription health
 * classifier (R5 step 1 extraction). These assertions pin the decision
 * matrix as the claude transport sees it (claude/health.ts re-export) — the same functions the codex
 * transport re-exports, over Anthropic-shaped failures.
 */

test('401 splits revoked from expired; expired does not fail over', () => {
  const revoked = classifyUpstreamError({ status: 401, bodyText: '{"error":"token_invalidated"}' });
  assert.equal(revoked.kind, 'auth-revoked');
  assert.equal(shouldFailover(revoked), true);

  const expired = classifyUpstreamError({ status: 401, bodyText: '{"error":"oauth token expired"}' });
  assert.equal(expired.kind, 'auth-expired');
  assert.equal(shouldFailover(expired), false);
});

test('403 Cloudflare blocks are transient; other 403s are forbidden', () => {
  const blocked = classifyUpstreamError({ status: 403, bodyText: '<html><body>cloudflare</body></html>' });
  assert.equal(blocked.kind, 'transient');
  assert.equal(shouldFailover(blocked), false);
  const edge = classifyUpstreamError({ status: 403, bodyText: 'error code: 1010' });
  assert.equal(edge.kind, 'transient');
  const forbidden = classifyUpstreamError({ status: 403, bodyText: 'request not allowed' });
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(shouldFailover(forbidden), true);
});

test('429 is rate-limited with failover; overloaded and org-disabled match Anthropic wording', () => {
  const rateLimited = classifyUpstreamError({ status: 429, bodyText: 'rate_limit_error' });
  assert.equal(rateLimited.kind, 'rate-limited');
  assert.equal(shouldFailover(rateLimited), true);

  const overloaded = classifyUpstreamError({ status: 529, bodyText: '' });
  assert.equal(overloaded.kind, 'overloaded');
  const overloadedBody = classifyUpstreamError({ status: 500, bodyText: 'server_is_overloaded' });
  assert.equal(overloadedBody.kind, 'overloaded');
  assert.equal(shouldFailover(overloaded), true);

  const orgDisabled = classifyUpstreamError({ status: 400, bodyText: 'organization has been disabled' });
  assert.equal(orgDisabled.kind, 'org-disabled');
  const verification = classifyUpstreamError({ status: 400, bodyText: 'identity verification required' });
  assert.equal(verification.kind, 'org-disabled');
  assert.equal(shouldFailover(orgDisabled), true);
});

test('other statuses map to transient or request-error without failover', () => {
  assert.equal(classifyUpstreamError({ status: 500, bodyText: 'oops' }).kind, 'transient');
  assert.equal(classifyUpstreamError({ status: 503, bodyText: '' }).kind, 'transient');
  const badRequest = classifyUpstreamError({ status: 400, bodyText: 'invalid request' });
  assert.equal(badRequest.kind, 'request-error');
  assert.equal(shouldFailover(badRequest), false);
  assert.equal(classifyUpstreamError({ status: Number.NaN, bodyText: '' }).kind, 'request-error');
  assert.equal(shouldFailover(classifyUpstreamError({ status: 200, bodyText: '' })), false);
});
