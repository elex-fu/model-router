import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUpstreamError, shouldFailover } from '../../../../src/saas/gateway/codex/health.js';

function classify(status: number, bodyText: string): string {
  return classifyUpstreamError({ status, bodyText }).kind;
}

test('401 with revocation markers classifies as auth-revoked', () => {
  assert.equal(classify(401, '{"error":"token_invalidated"}'), 'auth-revoked');
  assert.equal(classify(401, '{"error":"token_revoked"}'), 'auth-revoked');
  assert.equal(classify(401, 'Unauthorized'), 'auth-revoked');
  assert.equal(classify(401, 'unauthorized: bad token'), 'auth-revoked');
});

test('401 without revocation markers classifies as auth-expired', () => {
  assert.equal(classify(401, '{"error":"invalid_token"}'), 'auth-expired');
  assert.equal(classify(401, ''), 'auth-expired');
});

test('403 with an HTML or Cloudflare 1010 body is exempted as transient', () => {
  assert.equal(classify(403, '<!DOCTYPE html><html><body>blocked</body></html>'), 'transient');
  assert.equal(classify(403, '<html lang="en">Access denied</html>'), 'transient');
  assert.equal(classify(403, 'error code: 1010'), 'transient');
  assert.equal(classify(403, 'cloudflare ray 8f3: code 1010'), 'transient');
});

test('403 with a plain JSON body classifies as forbidden', () => {
  assert.equal(classify(403, '{"error":"country not supported"}'), 'forbidden');
  assert.equal(classify(403, ''), 'forbidden');
});

test('429 always classifies as rate-limited', () => {
  assert.equal(classify(429, '{"error":"rate limit exceeded"}'), 'rate-limited');
  assert.equal(classify(429, ''), 'rate-limited');
});

test('529 or a server_is_overloaded body classifies as overloaded', () => {
  assert.equal(classify(529, ''), 'overloaded');
  assert.equal(classify(529, '{"detail":"busy"}'), 'overloaded');
  assert.equal(classify(500, '{"error":{"code":"server_is_overloaded"}}'), 'overloaded');
  assert.equal(classify(503, 'server_is_overloaded'), 'overloaded');
});

test('400 with org-disabled or identity-verification text classifies as org-disabled', () => {
  assert.equal(classify(400, 'This organization has been disabled.'), 'org-disabled');
  assert.equal(classify(400, 'identity verification required before use'), 'org-disabled');
  assert.equal(classify(400, '{"error":"bad request"}'), 'request-error');
});

test('other statuses classify as transient (5xx) or request-error (4xx)', () => {
  assert.equal(classify(500, 'boom'), 'transient');
  assert.equal(classify(502, ''), 'transient');
  assert.equal(classify(503, ''), 'transient');
  assert.equal(classify(404, 'nope'), 'request-error');
  assert.equal(classify(422, 'invalid'), 'request-error');
  assert.equal(classify(400, 'plain bad request'), 'request-error');
});

test('classifyUpstreamError keeps the status and tolerates a malformed body', () => {
  const result = classifyUpstreamError({ status: 429, bodyText: '' });
  assert.equal(result.status, 429);
  assert.equal(result.kind, 'rate-limited');
  assert.equal(classifyUpstreamError({ status: 401, bodyText: undefined as unknown as string }).kind, 'auth-expired');
  assert.equal(classifyUpstreamError({ status: Number.NaN, bodyText: 'x' }).kind, 'request-error');
});

test('shouldFailover is true exactly for failover-worthy classifications', () => {
  assert.equal(shouldFailover({ kind: 'auth-revoked', status: 401 }), true);
  assert.equal(shouldFailover({ kind: 'forbidden', status: 403 }), true);
  assert.equal(shouldFailover({ kind: 'rate-limited', status: 429 }), true);
  assert.equal(shouldFailover({ kind: 'overloaded', status: 529 }), true);
  assert.equal(shouldFailover({ kind: 'org-disabled', status: 400 }), true);
  assert.equal(shouldFailover({ kind: 'auth-expired', status: 401 }), false);
  assert.equal(shouldFailover({ kind: 'transient', status: 500 }), false);
  assert.equal(shouldFailover({ kind: 'request-error', status: 400 }), false);
  assert.equal(shouldFailover(undefined as unknown as { kind: 'transient'; status: 500 }), false);
});

test('batch 2.3: 402, model-level 404/400 and 403 reclassification (codex view)', () => {
  assert.equal(classify(402, '{"detail":"insufficient_credit"}'), 'insufficient-balance');
  assert.equal(classify(404, '{"error":{"message":"The model `gpt-x` was not found"}}'), 'model-unavailable');
  assert.equal(
    classify(400, "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."),
    'model-unavailable',
  );
  assert.equal(
    classify(
      403,
      "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
    ),
    'concurrency-limited',
  );
  assert.equal(classify(403, 'usage limit reached for this plan'), 'rate-limited');
});
