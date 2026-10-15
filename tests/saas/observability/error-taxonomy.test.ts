import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attemptCategorySqlCase,
  classifyAttemptOutcome,
  classifyError,
  ERROR_TAXONOMY_VERSION,
  OBS_ERROR_CATEGORIES,
} from '../../../src/saas/observability/channel-status.js';

test('the taxonomy is the fixed 16-category ordered cascade', () => {
  assert.equal(OBS_ERROR_CATEGORIES.length, 16);
  assert.deepEqual(OBS_ERROR_CATEGORIES, [
    'content_policy',
    'authentication',
    'context_limit',
    'invalid_request',
    'model_unsupported',
    'quota_or_balance',
    'account_pool_unavailable',
    'rate_or_capacity',
    'timeout',
    'transport_or_stream',
    'upstream_forbidden',
    'not_found',
    'client_cancelled',
    'upstream_5xx',
    'internal',
    'other',
  ]);
  assert.equal(typeof ERROR_TAXONOMY_VERSION, 'string');
});

test('classifyError maps statuses without text through the status cascade', () => {
  assert.equal(classifyError(401, null), 'authentication');
  assert.equal(classifyError(400, null), 'invalid_request');
  assert.equal(classifyError(402, null), 'quota_or_balance');
  assert.equal(classifyError(429, null), 'rate_or_capacity');
  assert.equal(classifyError(403, null), 'upstream_forbidden');
  assert.equal(classifyError(404, null), 'not_found');
  assert.equal(classifyError(499, null), 'client_cancelled');
  assert.equal(classifyError(500, null), 'upstream_5xx');
  assert.equal(classifyError(503, null), 'upstream_5xx');
  assert.equal(classifyError(null, null), 'internal');
  assert.equal(classifyError(418, null), 'other');
});

test('classifyError lets text signals win over status mapping', () => {
  assert.equal(classifyError(400, 'request violates content policy'), 'content_policy');
  assert.equal(classifyError(400, 'maximum context length exceeded'), 'context_limit');
  assert.equal(classifyError(400, 'model not found for this route'), 'model_unsupported');
  assert.equal(classifyError(403, 'rate limit exceeded, slow down'), 'rate_or_capacity');
  assert.equal(classifyError(404, 'request timed out while waiting for upstream'), 'timeout');
  assert.equal(classifyError(403, 'invalid api key'), 'authentication');
  assert.equal(classifyError(500, 'insufficient balance in account'), 'quota_or_balance');
});

test('classifyError covers every text category', () => {
  assert.equal(classifyError(400, 'content_policy_violation'), 'content_policy');
  assert.equal(classifyError(null, 'unauthorized'), 'authentication');
  assert.equal(classifyError(null, 'prompt is too long: too many tokens'), 'context_limit');
  assert.equal(classifyError(400, 'malformed request shape'), 'invalid_request');
  assert.equal(classifyError(404, 'no such model or unsupported model'), 'model_unsupported');
  assert.equal(classifyError(402, 'billing hard limit reached'), 'quota_or_balance');
  assert.equal(classifyError(null, 'no available accounts in pool'), 'account_pool_unavailable');
  assert.equal(classifyError(null, 'server overloaded, capacity issues'), 'rate_or_capacity');
  assert.equal(classifyError(null, 'upstream request timed out'), 'timeout');
  assert.equal(classifyError(null, 'socket hang up / ECONNRESET'), 'transport_or_stream');
  assert.equal(classifyError(403, 'upstream says no'), 'upstream_forbidden');
  assert.equal(classifyError(404, 'resource does not exist here'), 'not_found');
  assert.equal(classifyError(499, 'client cancelled'), 'client_cancelled');
  assert.equal(classifyError(502, null), 'upstream_5xx');
  assert.equal(classifyError(null, null), 'internal');
  assert.equal(classifyError(418, 'teapot'), 'other');
});

test('classifyAttemptOutcome handles succeeded, pending and dispatch nuances', () => {
  assert.equal(classifyAttemptOutcome({ resultState: 'succeeded' }), 'ok');
  assert.equal(classifyAttemptOutcome({ resultState: 'pending' }), null);
  // A dispatched attempt that failed without any HTTP status is a transport
  // failure; one that never left the proxy is internal.
  assert.equal(
    classifyAttemptOutcome({ resultState: 'failed', dispatchState: 'sent', status: null }),
    'transport_or_stream',
  );
  assert.equal(
    classifyAttemptOutcome({ resultState: 'unknown', dispatchState: 'unknown', status: null }),
    'transport_or_stream',
  );
  assert.equal(classifyAttemptOutcome({ resultState: 'failed', dispatchState: 'not_sent', status: null }), 'internal');
  assert.equal(
    classifyAttemptOutcome({ resultState: 'failed', dispatchState: 'sent', status: 429, errorText: null }),
    'rate_or_capacity',
  );
});

test('the SQL CASE mirrors the TypeScript cascade arm for arm', () => {
  const sql = attemptCategorySqlCase('a');
  assert.match(sql, /WHEN a\.result_state = 'succeeded' THEN 'ok'/);
  assert.match(sql, /WHEN a\.result_state = 'pending' THEN NULL/);
  assert.match(
    sql,
    /WHEN a\.unknown_reason ~\* 'content_polic\|content polic\|safety system\|policy violation\|flagged as sensitive' THEN 'content_policy'/,
  );
  assert.match(
    sql,
    /WHEN a\.dispatch_state IN \('sent', 'unknown'\) AND a\.result_http_status IS NULL THEN 'transport_or_stream'/,
  );
  assert.match(sql, /WHEN a\.result_http_status IS NULL THEN 'internal'/);
  assert.match(sql, /WHEN a\.result_http_status = 429 THEN 'rate_or_capacity'/);
  assert.match(sql, /WHEN a\.result_http_status >= 500 THEN 'upstream_5xx'/);
  // Every taxonomy category is representable in the SQL CASE.
  for (const category of OBS_ERROR_CATEGORIES) {
    assert.ok(sql.includes(`'${category}'`), `expected SQL CASE to mention ${category}`);
  }
});
