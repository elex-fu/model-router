import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlatformApiError } from '../../web/src/api/saas-platform-client.js';
import {
  parseValidationRequeueReceipt,
  parseValidationRequeueStatus,
  platformValidationClient,
} from '../../web/src/api/saas-platform-validation-client.js';

const JOB = '10000000-0000-4000-8000-000000000001';
const AUDIT = '10000000-0000-4000-8000-000000000002';
const READY = { state: 'ready', jobId: JOB, credentialVersion: 2, credentialAuthzVersion: 7, leaseGeneration: 3 };
const RECEIPT = {
  outcome: 'queued',
  jobId: JOB,
  credentialVersion: 2,
  leaseGeneration: 4,
  auditEventId: AUDIT,
  recordedAt: '2026-10-21T00:00:00Z',
  replayed: false,
};

test('validation client accepts only complete typed revision metadata and projects away extra fields', () => {
  assert.deepEqual(parseValidationRequeueStatus({ ...READY, signature: 'provider-only' }), READY);
  assert.deepEqual(
    parseValidationRequeueStatus({
      state: 'not_eligible',
      jobId: null,
      credentialVersion: null,
      credentialAuthzVersion: null,
      leaseGeneration: null,
    }),
    {
      state: 'not_eligible',
      jobId: null,
      credentialVersion: null,
      credentialAuthzVersion: null,
      leaseGeneration: null,
    },
  );
  assert.deepEqual(parseValidationRequeueReceipt({ ...RECEIPT, reason: 'private operator explanation' }), RECEIPT);
  for (const value of [
    null,
    {},
    { ...READY, jobId: null },
    { ...READY, credentialVersion: '2' },
    { ...READY, leaseGeneration: -1 },
    { ...READY, credentialAuthzVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => parseValidationRequeueStatus(value), PlatformApiError);
  for (const value of [
    { ...RECEIPT, recordedAt: 'bad' },
    { ...RECEIPT, outcome: 'verified' },
    { ...RECEIPT, replayed: 'true' },
    { ...RECEIPT, auditEventId: '' },
  ])
    assert.throws(() => parseValidationRequeueReceipt(value), PlatformApiError);
});

test('validation POST retains one caller idempotency key and exact revision/reason input across retries', async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: RECEIPT }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const input = {
    jobId: JOB,
    expectedCredentialVersion: 2,
    expectedCredentialAuthzVersion: 7,
    expectedLeaseGeneration: 3,
    reason: '修复验证响应上限后重试',
  };
  await platformValidationClient.requeue('account:one', 'credential:one', input, 'retained-operation-id');
  await platformValidationClient.requeue('account:one', 'credential:one', input, 'retained-operation-id');
  for (const call of calls) {
    assert.equal(
      call.url,
      '/admin/api/v1/supply/accounts/account%3Aone/credentials/credential%3Aone/validation-requeue',
    );
    assert.equal(new Headers(call.init.headers).get('idempotency-key'), 'retained-operation-id');
    assert.deepEqual(JSON.parse(String(call.init.body)), input);
    assert.equal(call.init.credentials, 'same-origin');
  }
});

test('validation client rejects a success receipt for a different job or generation', async (t) => {
  for (const changed of [
    { ...RECEIPT, jobId: AUDIT },
    { ...RECEIPT, leaseGeneration: 99 },
    { ...RECEIPT, credentialVersion: 3 },
  ]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ data: changed }), { headers: { 'content-type': 'application/json' } }),
    );
    await assert.rejects(
      platformValidationClient.requeue(
        'account',
        'credential',
        {
          jobId: JOB,
          expectedCredentialVersion: 2,
          expectedCredentialAuthzVersion: 7,
          expectedLeaseGeneration: 3,
          reason: 'bounded retry',
        },
        'operation',
      ),
      (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
    );
    t.mock.restoreAll();
  }
});
