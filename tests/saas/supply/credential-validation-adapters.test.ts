import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isSupportedCredentialValidationTarget,
  validateProviderCredential,
} from '../../../src/saas/supply/credential-validation-adapters.js';
import type { ProviderCredentialValidationJobRecord } from '../../../src/saas/supply/types.js';

function job(overrides: Partial<ProviderCredentialValidationJobRecord> = {}): ProviderCredentialValidationJobRecord {
  return {
    id: 'job-a',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: 1,
    providerId: 'kimi',
    productId: 'kimi-platform',
    credentialType: 'api-key',
    allowedModels: ['kimi-model'],
    target: { model: 'kimi-model', endpoint: 'chat-completions', version: 1 },
    idempotencyKey: 'a'.repeat(64),
    state: 'queued',
    attemptCount: 0,
    availableAt: '2026-09-28T00:00:00.000Z',
    leaseUntil: null,
    leaseGeneration: 0,
    lastErrorCode: null,
    completedAt: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

test('fixed adapter targets server-owned HTTPS origin and emits only health metadata', async () => {
  const requestSecret = Buffer.from('unit-test-api-key');
  let requestedUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const result = await validateProviderCredential(job(), requestSecret, async (url, init) => {
    requestedUrl = url;
    requestInit = init;
    return new Response('{"models":[]} ', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.deepEqual(result, {
    state: 'verified',
    adapterId: 'kimi-platform-models-v1',
    httpStatus: 200,
    durationMs: result.durationMs,
  });
  assert.equal(requestedUrl?.href, 'https://api.moonshot.cn/v1/models');
  assert.equal(requestInit?.method, 'GET');
  assert.equal(requestInit?.redirect, 'manual');
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer unit-test-api-key');
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
});

test('redirect responses are rejected without following caller-controlled locations', async () => {
  let calls = 0;
  const result = await validateProviderCredential(job(), Buffer.from('unit-test-api-key'), async (url, init) => {
    calls += 1;
    assert.equal(url.href, 'https://api.moonshot.cn/v1/models');
    assert.equal(init.redirect, 'manual');
    return new Response('sensitive response body', {
      status: 302,
      headers: { location: 'http://127.0.0.1:5432/admin', 'content-length': '24' },
    });
  });

  assert.equal(calls, 1);
  assert.equal(result.state, 'failed');
  if (result.state !== 'failed') throw new Error('expected redirect failure');
  assert.equal(result.errorCode, 'provider_redirect_rejected');
  assert.equal(JSON.stringify(result).includes('127.0.0.1'), false);
  assert.equal(JSON.stringify(result).includes('sensitive response body'), false);
});

test('arbitrary endpoints, models and custom products fail closed before transport', async () => {
  let calls = 0;
  const invalidTargets = [
    job({ target: { model: 'not-allowed', endpoint: 'chat-completions', version: 1 } }),
    job({ target: { model: 'kimi-model', endpoint: 'https://127.0.0.1/admin', version: 1 } }),
    job({ productId: 'custom', providerId: 'custom-provider' }),
    job({ productId: 'kimi-code' }),
  ];
  for (const candidate of invalidTargets) {
    assert.equal(isSupportedCredentialValidationTarget(candidate), false);
    const result = await validateProviderCredential(candidate, Buffer.from('unit-test-api-key'), async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    });
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected unsupported adapter failure');
    assert.equal(result.errorCode, 'adapter_unsupported');
  }
  assert.equal(calls, 0);
});

test('oversized declared responses are rejected and discarded without exposing their body', async () => {
  let bodyCancelled = false;
  const result = await validateProviderCredential(job(), Buffer.from('unit-test-api-key'), async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-length': '4097' } });
  });
  assert.equal(result.state, 'failed');
  if (result.state !== 'failed') throw new Error('expected size failure');
  assert.equal(result.errorCode, 'provider_response_too_large');
  assert.equal(bodyCancelled, true);
});

test('oversized streaming responses are capped even when Content-Length is absent', async () => {
  let bodyCancelled = false;
  const result = await validateProviderCredential(job(), Buffer.from('unit-test-api-key'), async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    return new Response(body, { status: 200 });
  });
  assert.equal(result.state, 'failed');
  if (result.state !== 'failed') throw new Error('expected stream size failure');
  assert.equal(result.errorCode, 'provider_response_too_large');
  assert.equal(bodyCancelled, true);
});
