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

test('batch 2.3: 402 classifies as insufficient-balance with failover', () => {
  const balance = classifyUpstreamError({ status: 402, bodyText: '{"error":"insufficient balance"}' });
  assert.equal(balance.kind, 'insufficient-balance');
  assert.equal(shouldFailover(balance), true);
  assert.equal(classifyUpstreamError({ status: 402, bodyText: 'payment required' }).kind, 'insufficient-balance');
});

test('batch 2.3: Kimi 403 concurrency and quota-window reclassification', () => {
  const concurrency = classifyUpstreamError({
    status: 403,
    bodyText:
      "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
  });
  assert.equal(concurrency.kind, 'concurrency-limited');
  assert.equal(shouldFailover(concurrency), true);

  const quotaText = classifyUpstreamError({ status: 403, bodyText: 'usage limit exceeded, quota will reset soon' });
  assert.equal(quotaText.kind, 'rate-limited');
  const quotaStructured = classifyUpstreamError({
    status: 403,
    bodyText: '{"error":{"type":"access_terminated_error"}}',
  });
  assert.equal(quotaStructured.kind, 'rate-limited');
  // A generic 403 still strikes.
  assert.equal(classifyUpstreamError({ status: 403, bodyText: 'nope' }).kind, 'forbidden');
});

test('batch 2.3: model-not-found 404 and Codex plan-gated 400 are model-level', () => {
  const notFound = classifyUpstreamError({ status: 404, bodyText: '{"error":"model not found"}' });
  assert.equal(notFound.kind, 'model-unavailable');
  assert.equal(shouldFailover(notFound), true);
  assert.equal(classifyUpstreamError({ status: 404, bodyText: 'unknown model requested' }).kind, 'model-unavailable');
  // A 404 without a model body stays a request error.
  assert.equal(classifyUpstreamError({ status: 404, bodyText: 'route missing' }).kind, 'request-error');
  const planGated = classifyUpstreamError({
    status: 400,
    bodyText: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
  });
  assert.equal(planGated.kind, 'model-unavailable');
  // A generic 400 stays a request error.
  assert.equal(classifyUpstreamError({ status: 400, bodyText: 'invalid request' }).kind, 'request-error');
});
