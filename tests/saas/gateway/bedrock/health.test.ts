import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyBedrockUpstreamError,
  parseAwsErrorBody,
  shouldBedrockFailover,
} from '../../../../src/saas/gateway/bedrock/health.js';

test('AWS error bodies parse from the __type / type / code spellings', () => {
  assert.deepEqual(parseAwsErrorBody('{"__type":"com.amazonaws.bedrock#ThrottlingException","message":"slow down"}'), {
    type: 'ThrottlingException',
    message: 'slow down',
  });
  assert.deepEqual(parseAwsErrorBody('{"type":"ValidationException"}'), { type: 'ValidationException', message: null });
  assert.equal(parseAwsErrorBody('plain text'), null);
  assert.equal(parseAwsErrorBody('{}'), null);
  assert.equal(parseAwsErrorBody(null), null);
});

test('ThrottlingException maps to rate-limited from both the 429 and the 400 spelling', () => {
  const body = '{"__type":"ThrottlingException","message":"Too many invocations"}';
  assert.deepEqual(classifyBedrockUpstreamError({ status: 429, bodyText: body }), {
    kind: 'rate-limited',
    status: 429,
  });
  assert.deepEqual(classifyBedrockUpstreamError({ status: 400, bodyText: body }), {
    kind: 'rate-limited',
    status: 400,
  });
  assert.deepEqual(classifyBedrockUpstreamError({ status: 429, bodyText: '{"__type":"TooManyRequestsException"}' }), {
    kind: 'rate-limited',
    status: 429,
  });
});

test('a streamed overloaded event through the AWS envelope keeps overloaded semantics', () => {
  assert.deepEqual(
    classifyBedrockUpstreamError({
      status: 200,
      bodyText: '{"__type":"ModelStreamedException","message":"overloaded_error"}',
    }),
    { kind: 'overloaded', status: 200 },
  );
});

test('model-not-found ValidationExceptions keep the model-level cooldown kind', () => {
  assert.deepEqual(
    classifyBedrockUpstreamError({
      status: 400,
      bodyText: '{"__type":"ValidationException","message":"Model with ID foo is not found"}',
    }),
    { kind: 'model-unavailable', status: 400 },
  );
  // A generic validation error stays a request error (never retried).
  assert.deepEqual(
    classifyBedrockUpstreamError({
      status: 400,
      bodyText: '{"__type":"ValidationException","message":"Extra inputs are not permitted"}',
    }),
    { kind: 'request-error', status: 400 },
  );
});

test('the shared matrix still classifies the non-AWS-shaped statuses', () => {
  assert.deepEqual(classifyBedrockUpstreamError({ status: 401, bodyText: 'Unauthorized' }), {
    kind: 'auth-revoked',
    status: 401,
  });
  // Static AWS keys have no OAuth refresh path, so a bare 401 is also
  // auth-revoked (failover), not the shared matrix's auth-expired.
  assert.deepEqual(classifyBedrockUpstreamError({ status: 401, bodyText: '' }), {
    kind: 'auth-revoked',
    status: 401,
  });
  assert.deepEqual(classifyBedrockUpstreamError({ status: 403, bodyText: '' }), {
    kind: 'forbidden',
    status: 403,
  });
  assert.deepEqual(classifyBedrockUpstreamError({ status: 404, bodyText: '' }), {
    kind: 'request-error',
    status: 404,
  });
  assert.deepEqual(classifyBedrockUpstreamError({ status: 503, bodyText: '' }), {
    kind: 'transient',
    status: 503,
  });
});

test('UnrecognizedClientException (bad key material) is auth-revoked', () => {
  assert.deepEqual(
    classifyBedrockUpstreamError({
      status: 403,
      bodyText:
        '{"__type":"UnrecognizedClientException","message":"The security token included in the request is invalid."}',
    }),
    { kind: 'auth-revoked', status: 403 },
  );
});

test('the task #10 failover matrix: 401/403/429/529/≥500 fail over, 400 never retries', () => {
  const failover = (status: number, bodyText = ''): boolean =>
    shouldBedrockFailover(classifyBedrockUpstreamError({ status, bodyText }));

  assert.equal(failover(401), true);
  assert.equal(failover(403), true);
  assert.equal(failover(429), true);
  assert.equal(failover(500), true);
  assert.equal(failover(503), true);
  assert.equal(failover(529), true);
  // A 400 with any body never fails over (Bedrock ValidationException is a
  // request-shape error; retrying the same body can only fail again).
  assert.equal(failover(400, '{"__type":"ValidationException","message":"Extra inputs are not permitted"}'), false);
  // ...except the AWS exception spellings that are genuinely retryable
  // conditions reported as 400 (throttling) — those classify as
  // rate-limited and DO fail over.
  assert.equal(failover(400, '{"__type":"ThrottlingException"}'), true);
  // A 2xx misroute never fails over.
  assert.equal(failover(200), false);
});
