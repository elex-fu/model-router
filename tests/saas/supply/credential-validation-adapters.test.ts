import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCanonicalIdentity } from '../../../src/saas/gateway/codex/identity.js';
import { grokCliIdentityHeaders } from '../../../src/saas/gateway/grok/constants.js';
import {
  credentialValidationCapabilityProtocol,
  isSupportedCredentialValidationTarget,
  KIMI_CODE_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
  KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS,
  PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
  PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS,
  PROVIDER_INFERENCE_VALIDATION_MAX_RESPONSE_BYTES,
  PROVIDER_INFERENCE_VALIDATION_TIMEOUT_MS,
  PROVIDER_OAUTH_VALIDATION_MAX_RESPONSE_BYTES,
  PROVIDER_OAUTH_VALIDATION_TIMEOUT_MS,
  validateProviderCredential,
} from '../../../src/saas/supply/credential-validation-adapters.js';
import type { ProviderCredentialValidationJobRecord } from '../../../src/saas/supply/types.js';
import { waitForValidationFixtureSignal } from './credential-validation-test-fixture.js';

function job(overrides: Partial<ProviderCredentialValidationJobRecord> = {}): ProviderCredentialValidationJobRecord {
  return {
    id: 'job-a',
    ownerKind: 'tenant',
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

const messagesTargets = [
  {
    providerId: 'kimi',
    productId: 'kimi-code',
    model: 'kimi-for-coding',
    url: 'https://api.kimi.com/coding/v1/messages',
    adapterId: 'kimi-code-messages-v1',
    maxResponseBytes: KIMI_CODE_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
    timeoutMs: KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS,
  },
  {
    providerId: 'kimi',
    productId: 'kimi-code-global',
    model: 'kimi-for-coding',
    url: 'https://api.kimi.ai/coding/v1/messages',
    adapterId: 'kimi-code-global-messages-v1',
    maxResponseBytes: KIMI_CODE_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
    timeoutMs: KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS,
  },
  {
    providerId: 'deepseek',
    productId: 'deepseek-anthropic',
    model: 'deepseek-flash',
    url: 'https://api.deepseek.com/anthropic/v1/messages',
    adapterId: 'deepseek-anthropic-messages-v1',
    maxResponseBytes: PROVIDER_INFERENCE_VALIDATION_MAX_RESPONSE_BYTES,
    timeoutMs: PROVIDER_INFERENCE_VALIDATION_TIMEOUT_MS,
  },
] as const;

function messagesJob(
  fixture: (typeof messagesTargets)[number] = messagesTargets[0],
): ProviderCredentialValidationJobRecord {
  return job({
    providerId: fixture.providerId,
    productId: fixture.productId,
    allowedModels: [fixture.model],
    target: { model: fixture.model, endpoint: 'messages', version: 1 },
  });
}

function message(model = 'kimi-for-coding') {
  return {
    id: 'msg-local-test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  };
}

function jsonResponse(value: unknown = message()): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function signedKimiMessage() {
  // Synthetic values reproduce the observed envelope/signature lengths only.
  const envelope = {
    ...message(),
    content: [{ type: 'thinking', thinking: '', signature: 'fixture-signature:'.padEnd(12_946, 's') }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 5, output_tokens: 8 },
  };
  envelope.content[0].thinking = 't'.repeat(13_385 - Buffer.byteLength(JSON.stringify(envelope)));
  return envelope;
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

test('OpenRouter validates a platform key against the pinned authenticated /key endpoint', async () => {
  const candidate = job({
    providerId: 'openrouter',
    productId: 'openrouter-api',
    credentialType: 'api-key',
    allowedModels: ['openai/gpt-4o'],
    target: { model: 'openai/gpt-4o', endpoint: 'openrouter-api', version: 1 },
  });
  assert.equal(isSupportedCredentialValidationTarget(candidate), true);
  assert.equal(credentialValidationCapabilityProtocol(candidate), 'openai');

  let requestedUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const result = await validateProviderCredential(candidate, Buffer.from('openrouter-unit-key'), async (url, init) => {
    requestedUrl = url;
    requestInit = init;
    return new Response(JSON.stringify({ data: { label: 'production-key', usage: 12.5 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.deepEqual(result, {
    state: 'verified',
    adapterId: 'openrouter-api-key-v1',
    httpStatus: 200,
    durationMs: result.durationMs,
  });
  assert.equal(requestedUrl?.href, 'https://openrouter.ai/api/v1/key');
  assert.equal(requestInit?.method, 'GET');
  assert.equal(requestInit?.redirect, 'manual');
  assert.equal(requestInit?.body, undefined);
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer openrouter-unit-key');
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('content-type'), null, 'key-info is a bodyless GET');
  assert.equal(JSON.stringify(result).includes('openrouter-unit-key'), false);
});

test('OpenRouter classified key rejection never retries as a provider outage', async () => {
  const candidate = job({
    providerId: 'openrouter',
    productId: 'openrouter-api',
    credentialType: 'api-key',
    allowedModels: ['openai/gpt-4o'],
    target: { model: 'openai/gpt-4o', endpoint: 'openrouter-api', version: 1 },
  });
  const result = await validateProviderCredential(candidate, Buffer.from('revoked-unit-key'), async () => {
    return new Response(JSON.stringify({ error: { code: 401, message: 'No auth credentials found' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(result.state, 'failed');
  if (result.state !== 'failed') throw new Error('expected rejection');
  assert.equal(result.errorCode, 'credential_rejected');
  assert.equal(result.retryable, false);
  assert.equal(result.adapterId, 'openrouter-api-key-v1');
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

test('Kimi Code CN/global and DeepSeek Anthropic use fixed truthful non-stream Messages probes', async (t) => {
  for (const fixture of messagesTargets) {
    await t.test(fixture.productId, async () => {
      const candidate = messagesJob(fixture);
      assert.equal(isSupportedCredentialValidationTarget(candidate), true);
      assert.equal(credentialValidationCapabilityProtocol(candidate), 'anthropic-compatible');
      let calls = 0;
      const result = await validateProviderCredential(
        candidate,
        Buffer.from('unit-test-api-key'),
        async (url, init) => {
          calls += 1;
          assert.equal(url.href, fixture.url);
          assert.equal(url.search, '');
          assert.equal(url.username, '');
          assert.equal(url.password, '');
          assert.equal(init.method, 'POST', 'Anthropic products must never fall back to GET models or OpenAI');
          assert.equal(init.redirect, 'manual');
          assert.ok(init.signal);
          assert.equal(init.signal.aborted, false);
          assert.deepEqual(
            Object.fromEntries(new Headers(init.headers)),
            {
              accept: 'application/json',
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
              'user-agent': 'model-router',
              'x-api-key': 'unit-test-api-key',
            },
            'no Bearer auth, cookies, proxy credentials, beta or impersonated client headers',
          );
          assert.ok(typeof init.body === 'string');
          assert.deepEqual(JSON.parse(init.body), {
            model: fixture.model,
            max_tokens: 8,
            stream: false,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
          });
          assert.equal(init.body.includes('unit-test-api-key'), false);
          return jsonResponse(message(fixture.model));
        },
      );
      assert.equal(calls, 1);
      assert.deepEqual(result, {
        state: 'verified',
        adapterId: fixture.adapterId,
        httpStatus: 200,
        durationMs: result.durationMs,
      });
      assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
      assert.equal(JSON.stringify(result).includes('OK'), false);
    });
  }
});

test('all three existing Chat models adapters retain GET/Bearer behavior and adapter identities', async () => {
  for (const fixture of [
    {
      providerId: 'kimi',
      productId: 'kimi-platform',
      url: 'https://api.moonshot.cn/v1/models',
      adapterId: 'kimi-platform-models-v1',
    },
    {
      providerId: 'kimi',
      productId: 'kimi-platform-global',
      url: 'https://api.moonshot.ai/v1/models',
      adapterId: 'kimi-platform-global-models-v1',
    },
    {
      providerId: 'deepseek',
      productId: 'deepseek-chat',
      url: 'https://api.deepseek.com/models',
      adapterId: 'deepseek-chat-models-v1',
    },
  ]) {
    const candidate = job({ providerId: fixture.providerId, productId: fixture.productId });
    assert.equal(credentialValidationCapabilityProtocol(candidate), 'openai-compatible');
    const result = await validateProviderCredential(candidate, Buffer.from('unit-test-api-key'), async (url, init) => {
      assert.equal(url.href, fixture.url);
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
        accept: 'application/json',
        authorization: 'Bearer unit-test-api-key',
        'user-agent': 'model-router',
      });
      return new Response(null, { status: 200 });
    });
    assert.equal(result.state, 'verified');
    assert.equal(result.adapterId, fixture.adapterId);
  }
});

test('malformed model/version, mismatched endpoint/protocol, credential type and custom targets fail before fetch', async () => {
  const base = messagesJob();
  const protocolOverride = { ...base.target, protocol: 'openai-compatible' };
  const urlOverride = { ...base.target, url: 'https://127.0.0.1:5432/messages?key=unit-test-api-key' };
  const invalid = [
    ...[
      '',
      ' not-trimmed',
      'with space',
      'with\r\nheader',
      'with\u0000nul',
      'https://127.0.0.1/messages',
      'model?key=unit-test-api-key',
      'x'.repeat(257),
    ].map((model) => ({ ...base, allowedModels: [model], target: { ...base.target, model } })),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((version) => ({
      ...base,
      target: { ...base.target, version },
    })),
    { ...base, allowedModels: ['some-other-model'] },
    { ...base, credentialType: 'bearer' },
    { ...base, credentialType: 'oauth' },
    { ...base, providerId: 'deepseek' },
    { ...base, target: { ...base.target, endpoint: 'chat-completions' } },
    { ...base, target: { ...base.target, endpoint: 'anthropic-compatible' } },
    { ...base, target: { ...base.target, endpoint: 'https://api.kimi.com/coding/v1/messages?redirect=127.0.0.1' } },
    { ...base, target: protocolOverride },
    { ...base, target: urlOverride },
    { ...base, productId: 'kimi-platform' },
    { ...base, productId: 'kimi-platform-global' },
    { ...base, providerId: 'deepseek', productId: 'deepseek-chat' },
    ...['custom-openai', 'custom-anthropic', 'custom-responses'].map((productId) => ({
      ...base,
      providerId: 'custom',
      productId,
    })),
  ];
  let calls = 0;
  for (const candidate of invalid) {
    assert.equal(isSupportedCredentialValidationTarget(candidate), false);
    assert.equal(credentialValidationCapabilityProtocol(candidate), null);
    const result = await validateProviderCredential(candidate, Buffer.from('unit-test-api-key'), async () => {
      calls += 1;
      return jsonResponse();
    });
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: 'adapter_unsupported',
      retryable: false,
      adapterId: null,
      httpStatus: null,
      durationMs: 0,
    });
  }
  assert.equal(calls, 0);
});

test('job URL/DNS/header hints cannot redirect a supported fixed probe or impersonate another client', async () => {
  const candidate = {
    ...messagesJob(),
    url: 'http://127.0.0.1:5432/admin?api_key=bad',
    dnsOverride: '127.0.0.1',
    headers: { authorization: 'Bearer wrong', 'user-agent': 'claude-code/99', cookie: 'secret' },
  };
  const result = await validateProviderCredential(
    candidate,
    Buffer.from('unit-test-api-key?not-a-query'),
    async (url, init) => {
      assert.equal(url.href, messagesTargets[0].url);
      assert.equal(url.search, '');
      assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'user-agent': 'model-router',
        'x-api-key': 'unit-test-api-key?not-a-query',
      });
      return jsonResponse();
    },
  );
  assert.equal(result.state, 'verified');
});

test('empty, whitespace/control/non-ASCII and overlarge credentials never reach the Messages transport', async () => {
  let calls = 0;
  for (const secret of [
    Buffer.alloc(0),
    Buffer.from('with space'),
    Buffer.from('key\r\nx-api-key: injected'),
    Buffer.from('key\u0000nul'),
    Buffer.from('秘密'),
    Buffer.alloc(4_097, 65),
  ]) {
    const result = await validateProviderCredential(messagesJob(), secret, async () => {
      calls += 1;
      return jsonResponse();
    });
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected credential format failure');
    assert.equal(result.errorCode, 'credential_format_invalid');
  }
  assert.equal(calls, 0);
});

test('Messages redirects and HTTP credential/rate/provider errors never verify or disclose response data', async () => {
  for (const [status, code, retryable] of [
    [301, 'provider_redirect_rejected', false],
    [307, 'provider_redirect_rejected', false],
    [401, 'credential_rejected', false],
    [403, 'credential_rejected', false],
    [404, 'provider_endpoint_unsupported', false],
    [405, 'provider_endpoint_unsupported', false],
    [429, 'provider_rate_limited', true],
    [500, 'provider_unavailable', true],
  ] as const) {
    let calls = 0;
    const result = await validateProviderCredential(
      messagesJob(),
      Buffer.from('unit-test-api-key'),
      async (_url, init) => {
        calls += 1;
        assert.equal(init.redirect, 'manual');
        return new Response('sensitive-provider-body unit-test-api-key', {
          status,
          headers: { location: 'http://127.0.0.1:5432/admin?secret=unit-test-api-key' },
        });
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: code,
      retryable,
      adapterId: messagesTargets[0].adapterId,
      httpStatus: status,
      durationMs: result.durationMs,
    });
    assert.equal(JSON.stringify(result).includes('sensitive-provider-body'), false);
    assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
    assert.equal(JSON.stringify(result).includes('127.0.0.1'), false);
  }
});

test('Messages success requires a complete legitimate JSON envelope, not HTML, errors or malformed usage', async () => {
  const good = message();
  const invalid = [
    null,
    [],
    {},
    { object: 'list', data: [] },
    { type: 'error', error: { message: 'unit-test-api-key' } },
    { ...good, error: { message: 'provider failure' } },
    { ...good, type: 'message_start' },
    { ...good, role: 'user' },
    { ...good, id: '' },
    { ...good, model: null },
    { ...good, content: [] },
    { ...good, content: [{ type: 'text', text: 123 }] },
    { ...good, content: [{ type: 'tool_use', id: 'tool-a' }] },
    { ...good, stop_reason: null },
    { ...good, stop_reason: ['end_turn'] },
    { ...good, usage: { input_tokens: 5 } },
    { ...good, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...good, usage: { input_tokens: 5, output_tokens: 1.5 } },
    { ...good, usage: { input_tokens: 5, output_tokens: '1' } },
    { ...good, usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } },
  ];
  const wireBodies = invalid.map((value) => JSON.stringify(value));
  wireBodies.push(
    '<html>unit-test-api-key sensitive-provider-body</html>',
    JSON.stringify(good).slice(0, -1),
    `${JSON.stringify(good)} trailing garbage`,
  );
  for (const wire of wireBodies) {
    const result = await validateProviderCredential(
      messagesJob(),
      Buffer.from('unit-test-api-key'),
      async () => new Response(wire, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: 'provider_response_invalid',
      retryable: false,
      adapterId: messagesTargets[0].adapterId,
      httpStatus: 200,
      durationMs: result.durationMs,
    });
    assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
    assert.equal(JSON.stringify(result).includes('sensitive-provider-body'), false);
  }
  for (const response of [
    new Response(null, { status: 204 }),
    new Response(JSON.stringify(good), { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const result = await validateProviderCredential(
      messagesJob(),
      Buffer.from('unit-test-api-key'),
      async () => response,
    );
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected envelope failure');
    assert.equal(result.errorCode, 'provider_response_invalid');
  }
});

test('bounded Messages envelopes accept max-token completion and canonical model aliases without capability claims', async () => {
  for (const content of [
    [{ type: 'text', text: 'O' }],
    [{ type: 'thinking', thinking: 'A short thought', signature: 'local-signature' }],
    [{ type: 'redacted_thinking', data: 'local-redacted-data' }],
  ]) {
    const result = await validateProviderCredential(messagesJob(), Buffer.from('unit-test-api-key'), async () =>
      jsonResponse({ ...message('kimi-canonical-model'), content, stop_reason: 'max_tokens' }),
    );
    assert.deepEqual(result, {
      state: 'verified',
      adapterId: messagesTargets[0].adapterId,
      httpStatus: 200,
      durationMs: result.durationMs,
    });
  }
});

test('Kimi Code CN/global accept a bounded signed envelope larger than the metadata limit', async () => {
  const envelope = signedKimiMessage();
  assert.equal(envelope.content[0].signature.length, 12_946);
  assert.equal(Buffer.byteLength(JSON.stringify(envelope)), 13_385);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) > PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES);
  for (const fixture of messagesTargets.slice(0, 2)) {
    const result = await validateProviderCredential(messagesJob(fixture), Buffer.from('unit-test-api-key'), async () =>
      jsonResponse(envelope),
    );
    assert.deepEqual(result, {
      state: 'verified',
      adapterId: fixture.adapterId,
      httpStatus: 200,
      durationMs: result.durationMs,
    });
    const output = JSON.stringify(result);
    assert.equal(output.includes('fixture-signature:'), false);
    assert.equal(output.includes('unit-test-api-key'), false);
    assert.equal(output.includes('thinking'), false);
  }
});

test('the larger Kimi Code allowance still rejects malformed signed envelopes and trailing data', async () => {
  const envelope = signedKimiMessage();
  const wire = JSON.stringify(envelope);
  const invalid = [
    JSON.stringify({ ...envelope, usage: { input_tokens: 5, output_tokens: -1 } }),
    JSON.stringify({ ...envelope, content: [{ ...envelope.content[0], signature: 123 }] }),
    wire.slice(0, -1),
    `${wire} trailing garbage`,
  ];
  for (const value of invalid) {
    const result = await validateProviderCredential(
      messagesJob(),
      Buffer.from('unit-test-api-key'),
      async () => new Response(value, { headers: { 'content-type': 'application/json' } }),
    );
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: 'provider_response_invalid',
      retryable: false,
      adapterId: messagesTargets[0].adapterId,
      httpStatus: 200,
      durationMs: result.durationMs,
    });
    assert.equal(JSON.stringify(result).includes('fixture-signature:'), false);
  }
});

test('Messages waits for EOF even after a full JSON prefix and supports split UTF-8 chunks', async (t) => {
  const lifetime = new AbortController();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let announceWait!: () => void;
  const waiting = new Promise<void>((resolve) => {
    announceWait = resolve;
  });
  const envelope = signedKimiMessage();
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...envelope, content: [...envelope.content, { type: 'text', text: '你好' }] }),
  );
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        sourceController = controller;
      },
      pull(controller) {
        if (index < bytes.length) controller.enqueue(bytes.subarray(index, ++index));
        else {
          announceWait();
          return new Promise<void>(() => {});
        }
      },
    },
    { highWaterMark: 0 },
  );
  let completed = false;
  const pending = validateProviderCredential(
    messagesJob(),
    Buffer.from('unit-test-api-key'),
    async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    lifetime.signal,
  ).then((result) => {
    completed = true;
    return result;
  });
  t.after(async () => {
    lifetime.abort();
    await pending;
  });
  await waitForValidationFixtureSignal(waiting, pending);
  assert.equal(completed, false, 'complete prefix must not verify before successful body EOF');
  sourceController.close();
  assert.equal((await pending).state, 'verified');
});

test('Messages provider caps apply to declared, absent and dishonest Content-Length and cancel oversize bodies', async (t) => {
  const encoder = new TextEncoder();
  const template = message();
  for (const fixture of messagesTargets) {
    await t.test(fixture.productId, async () => {
      const bytes = encoder.encode(
        JSON.stringify({
          ...template,
          content: [
            {
              type: 'text',
              text: 'x'.repeat(
                fixture.maxResponseBytes -
                  encoder.encode(JSON.stringify({ ...template, content: [{ type: 'text', text: '' }] })).byteLength,
              ),
            },
          ],
        }),
      );
      assert.equal(bytes.byteLength, fixture.maxResponseBytes);
      const atCap = await validateProviderCredential(
        messagesJob(fixture),
        Buffer.from('unit-test-api-key'),
        async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }),
      );
      assert.equal(atCap.state, 'verified');
      for (const length of [undefined, '1', String(fixture.maxResponseBytes + 1)]) {
        let cancelled = false;
        let index = 0;
        const chunks = [bytes, encoder.encode(' ')];
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = chunks[index++];
              if (chunk) controller.enqueue(chunk);
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        const headers = new Headers({ 'content-type': 'application/json' });
        if (length) headers.set('content-length', length);
        const result = await validateProviderCredential(
          messagesJob(fixture),
          Buffer.from('unit-test-api-key'),
          async () => new Response(body, { headers }),
        );
        assert.equal(result.state, 'failed');
        if (result.state !== 'failed') throw new Error('expected capped response failure');
        assert.equal(result.errorCode, 'provider_response_too_large');
        assert.equal(result.retryable, false);
        assert.equal(cancelled, true);
      }
    });
  }
});

test('Messages transport/read errors surface only stable health codes, never provider errors or secrets', async () => {
  for (const phase of ['fetch', 'body'] as const) {
    const result = await validateProviderCredential(messagesJob(), Buffer.from('unit-test-api-key'), async () => {
      const failure = new Error('sensitive-provider-body unit-test-api-key');
      if (phase === 'fetch') throw failure;
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(message())));
              } else controller.error(failure);
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected sanitized transport failure');
    assert.equal(result.errorCode, 'provider_network_error');
    assert.equal(result.retryable, true);
    assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
    assert.equal(JSON.stringify(result).includes('sensitive-provider-body'), false);
  }
});

test('Kimi Code cannot verify a body cancelled at pending EOF by its bounded model deadline', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS);
    return controller.signal;
  });
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(output) {
        if (!sent) {
          sent = true;
          output.enqueue(new TextEncoder().encode(JSON.stringify(message())));
          return;
        }
        controller.abort(new DOMException('local deadline', 'TimeoutError'));
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await validateProviderCredential(
    messagesJob(),
    Buffer.from('unit-test-api-key'),
    async (_url, init) => {
      assert.strictEqual(init.signal, controller.signal);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  );
  assert.equal(cancelled, true);
  assert.deepEqual(result, {
    state: 'failed',
    errorCode: 'provider_timeout',
    retryable: true,
    adapterId: messagesTargets[0].adapterId,
    httpStatus: 200,
    durationMs: result.durationMs,
  });
});

test('Messages fetch deadline and late successful responses stay failed and cancel the response', async (t) => {
  for (const lateResponse of [false, true]) {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    let cancelled = false;
    const result = await validateProviderCredential(messagesJob(), Buffer.from('unit-test-api-key'), async () => {
      controller.abort(new DOMException('sensitive-provider-body unit-test-api-key', 'TimeoutError'));
      if (!lateResponse) throw controller.signal.reason;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected fetch deadline failure');
    assert.equal(result.errorCode, 'provider_timeout');
    assert.equal(result.retryable, true);
    assert.equal(cancelled, lateResponse);
    assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
    t.mock.restoreAll();
  }
});

/* ------------------------------------------------------------------ */
/* R5b-4: opencode-go probe registration (R6 registry placeholder)     */
/* ------------------------------------------------------------------ */

function opencodeGoJob(
  overrides: Partial<ProviderCredentialValidationJobRecord> = {},
): ProviderCredentialValidationJobRecord {
  return job({
    providerId: 'opencode-go',
    productId: 'opencode-go-zen',
    allowedModels: ['glm-5.3'],
    target: { model: 'glm-5.3', endpoint: 'opencode-go-zen', version: 1 },
    ...overrides,
  });
}

function chatCompletion(model = 'glm-5.3'): Response {
  return jsonResponse({
    id: 'chatcmpl-local-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  });
}

test('opencode-go registers a fixed Chat Completions probe with Bearer auth (glm-5.3 default test model)', async () => {
  const candidate = opencodeGoJob();
  assert.equal(isSupportedCredentialValidationTarget(candidate), true);
  assert.equal(credentialValidationCapabilityProtocol(candidate), 'openai-compatible');
  let calls = 0;
  const result = await validateProviderCredential(candidate, Buffer.from('unit-test-api-key'), async (url, init) => {
    calls += 1;
    assert.equal(url.href, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(url.search, '');
    assert.equal(init.method, 'POST', 'the subscription pool probes the Chat Completions endpoint, not GET /models');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(
      Object.fromEntries(new Headers(init.headers)),
      {
        accept: 'application/json',
        authorization: 'Bearer unit-test-api-key',
        'content-type': 'application/json',
        'user-agent': 'model-router',
      },
      'openai-bearer-v1 auth profile like the kimi/deepseek API-key precedents',
    );
    assert.ok(typeof init.body === 'string');
    assert.deepEqual(JSON.parse(init.body), {
      model: 'glm-5.3',
      max_tokens: 8,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    return chatCompletion();
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    state: 'verified',
    adapterId: 'opencode-go-zen-chat-v1',
    httpStatus: 200,
    durationMs: result.durationMs,
  });
  assert.equal(JSON.stringify(result).includes('unit-test-api-key'), false);
});

test('opencode-go probe fails closed on mismatched product, credential type or endpoint', async () => {
  const invalid = [
    opencodeGoJob({ productId: 'opencode-go-zen-v2' }),
    opencodeGoJob({ providerId: 'opencode' }),
    opencodeGoJob({ credentialType: 'oauth' }),
    opencodeGoJob({ target: { model: 'glm-5.3', endpoint: 'chat-completions', version: 1 } }),
    opencodeGoJob({ target: { model: 'grok-4.7', endpoint: 'opencode-go-zen', version: 1 } }),
    opencodeGoJob({
      target: { model: 'glm-5.3', endpoint: 'https://opencode.ai/zen/go/v1/chat/completions', version: 1 },
    }),
  ];
  let calls = 0;
  for (const candidate of invalid) {
    assert.equal(isSupportedCredentialValidationTarget(candidate), false, JSON.stringify(candidate.target));
    assert.equal(credentialValidationCapabilityProtocol(candidate), null);
    const result = await validateProviderCredential(candidate, Buffer.from('unit-test-api-key'), async () => {
      calls += 1;
      return chatCompletion();
    });
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: 'adapter_unsupported',
      retryable: false,
      adapterId: null,
      httpStatus: null,
      durationMs: 0,
    });
  }
  assert.equal(calls, 0);
});

const oauthTargets = [
  {
    provider: 'codex',
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    model: 'gpt-5.3-codex',
    endpoint: 'codex-responses',
    url: 'https://chatgpt.com/backend-api/codex/responses',
    adapterId: 'openai-codex-oauth-probe-v1',
  },
  {
    provider: 'grok',
    providerId: 'xai-grok',
    productId: 'grok-subscription',
    model: 'grok-4',
    endpoint: 'grok-responses',
    url: 'https://cli-chat-proxy.grok.com/v1/responses',
    adapterId: 'xai-grok-oauth-probe-v1',
  },
] as const;

function oauthJob(fixture: (typeof oauthTargets)[number]): ProviderCredentialValidationJobRecord {
  return job({
    providerId: fixture.providerId,
    productId: fixture.productId,
    credentialType: 'oauth',
    allowedModels: [fixture.model],
    target: { model: fixture.model, endpoint: fixture.endpoint, version: 1 },
  });
}

function oauthSecret(provider: 'codex' | 'grok'): Buffer {
  const material =
    provider === 'codex'
      ? {
          access_token: 'codex-access-token',
          refresh_token: 'codex-refresh-token',
          token_type: 'Bearer',
          chatgpt_account_id: 'acct-123',
          client_id: 'codex-client',
        }
      : {
          access_token: 'grok-access-token',
          refresh_token: 'grok-refresh-token',
          token_type: 'Bearer',
        };
  return Buffer.from(JSON.stringify(material));
}

function responsesEnvelope(text: string): unknown {
  return {
    id: 'resp_local_test',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  };
}

function challengeFrom(requestBody: string): string {
  const body = JSON.parse(requestBody) as {
    input?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  const prompt = body.input?.[0]?.content?.[0]?.text;
  if (typeof prompt !== 'string') throw new Error('expected a challenge prompt');
  const match = /([0-9]{6})/.exec(prompt);
  if (!match?.[1]) throw new Error('expected a six-digit challenge');
  return match[1];
}

test('Codex and Grok OAuth onboarding probes dispatch the canonical CLI request and verify the challenge', async (t) => {
  for (const fixture of oauthTargets) {
    await t.test(fixture.provider, async () => {
      const candidate = oauthJob(fixture);
      assert.equal(isSupportedCredentialValidationTarget(candidate), true);
      assert.equal(credentialValidationCapabilityProtocol(candidate), 'responses');
      let calls = 0;
      const result = await validateProviderCredential(candidate, oauthSecret(fixture.provider), async (url, init) => {
        calls += 1;
        assert.equal(url.href, fixture.url);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'manual');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('authorization'), `Bearer ${fixture.provider}-access-token`);
        assert.equal(headers.get('accept'), 'application/json');
        assert.equal(headers.get('content-type'), 'application/json');
        if (fixture.provider === 'codex') {
          const identity = buildCanonicalIdentity();
          assert.equal(headers.get('chatgpt-account-id'), 'acct-123');
          assert.equal(headers.get('user-agent'), identity.userAgent);
          assert.equal(headers.get('originator'), identity.originator);
          assert.equal(headers.get('version'), identity.version);
          assert.equal(headers.get('openai-beta'), 'responses=experimental');
        } else {
          for (const [name, value] of Object.entries(grokCliIdentityHeaders())) {
            assert.equal(headers.get(name), value, `missing pinned Grok CLI header ${name}`);
          }
        }
        const body = JSON.parse(String(init.body)) as {
          model?: unknown;
          stream?: unknown;
          store?: unknown;
        };
        assert.equal(body.model, fixture.model);
        assert.equal(body.stream, false);
        assert.equal(body.store, false);
        const challenge = challengeFrom(String(init.body));
        assert.equal(
          String(init.body).includes('access-token'),
          false,
          'the sealed token never enters the request body',
        );
        return jsonResponse(responsesEnvelope(challenge));
      });
      assert.equal(calls, 1);
      assert.deepEqual(result, {
        state: 'verified',
        adapterId: fixture.adapterId,
        httpStatus: 200,
        durationMs: result.durationMs,
      });
      assert.equal(JSON.stringify(result).includes('access-token'), false);
    });
  }
});

test('OAuth onboarding probes verify only an exact numeric challenge answer', async () => {
  const candidate = oauthJob(oauthTargets[0]);
  for (const answer of ['000000', 'OK', '']) {
    const result = await validateProviderCredential(candidate, oauthSecret('codex'), async () =>
      jsonResponse(responsesEnvelope(answer)),
    );
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected challenge failure');
    assert.equal(result.errorCode, 'provider_response_invalid');
    assert.equal(result.retryable, false);
  }
});

test('OAuth onboarding probes fail closed on malformed sealed material before transport', async () => {
  const candidate = oauthJob(oauthTargets[0]);
  let calls = 0;
  for (const secret of [
    Buffer.from('plain-token'),
    Buffer.from('{'),
    Buffer.from(JSON.stringify({ refresh_token: 'only-refresh' })),
    Buffer.from(JSON.stringify({ access_token: 'codex-access-token', chatgpt_account_id: 'bad id' })),
  ]) {
    const result = await validateProviderCredential(candidate, secret, async () => {
      calls += 1;
      return jsonResponse(responsesEnvelope('123456'));
    });
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected format failure');
    assert.equal(result.errorCode, 'credential_format_invalid');
  }
  assert.equal(calls, 0);
});

test('OAuth onboarding probes classify upstream rejection and use the larger bounded budget', async () => {
  assert.equal(PROVIDER_OAUTH_VALIDATION_TIMEOUT_MS, 20_000);
  assert.equal(PROVIDER_OAUTH_VALIDATION_MAX_RESPONSE_BYTES, 65_536);

  const rejected = await validateProviderCredential(
    oauthJob(oauthTargets[1]),
    oauthSecret('grok'),
    async () => new Response(null, { status: 401 }),
  );
  assert.equal(rejected.state, 'failed');
  if (rejected.state !== 'failed') throw new Error('expected rejection');
  assert.equal(rejected.errorCode, 'credential_rejected');
  assert.equal(rejected.retryable, false);

  const fixture = oauthTargets[0];
  const candidate = oauthJob(fixture);
  let paddedBytes = 0;
  const accepted = await validateProviderCredential(candidate, oauthSecret('codex'), async (_url, init) => {
    const challenge = challengeFrom(String(init.body));
    const envelope = JSON.stringify(responsesEnvelope(challenge));
    const padded = envelope.replace(
      '"status":"completed"',
      `"status":"completed","padding":"${'x'.repeat(PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES)}"`,
    );
    paddedBytes = Buffer.byteLength(padded);
    return new Response(padded, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.ok(paddedBytes > PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES);
  assert.ok(paddedBytes < PROVIDER_OAUTH_VALIDATION_MAX_RESPONSE_BYTES);
  assert.equal(accepted.state, 'verified');

  let oversizedCancelled = false;
  const oversized = await validateProviderCredential(candidate, oauthSecret('codex'), async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        oversizedCancelled = true;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(PROVIDER_OAUTH_VALIDATION_MAX_RESPONSE_BYTES + 1) },
    });
  });
  assert.equal(oversized.state, 'failed');
  if (oversized.state !== 'failed') throw new Error('expected oversize failure');
  assert.equal(oversized.errorCode, 'provider_response_too_large');
  assert.equal(oversizedCancelled, true);
});

test('fixed probe deadlines follow metadata, inference, Kimi Code and OAuth budgets', async (t) => {
  const fixtures = [
    {
      candidate: job(),
      secret: Buffer.from('unit-test-api-key'),
      timeoutMs: PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS,
    },
    ...messagesTargets.map((target) => ({
      candidate: messagesJob(target),
      secret: Buffer.from('unit-test-api-key'),
      timeoutMs: target.timeoutMs,
    })),
    {
      candidate: opencodeGoJob(),
      secret: Buffer.from('unit-test-api-key'),
      timeoutMs: PROVIDER_INFERENCE_VALIDATION_TIMEOUT_MS,
    },
    ...oauthTargets.map((target) => ({
      candidate: oauthJob(target),
      secret: oauthSecret(target.provider),
      timeoutMs: PROVIDER_OAUTH_VALIDATION_TIMEOUT_MS,
    })),
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.candidate.productId, async (t) => {
      const deadline = new AbortController();
      t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
        assert.equal(milliseconds, fixture.timeoutMs);
        return deadline.signal;
      });
      const result = await validateProviderCredential(fixture.candidate, fixture.secret, async () => {
        deadline.abort();
        throw deadline.signal.reason;
      });
      assert.equal(result.state, 'failed');
      if (result.state !== 'failed') throw new Error('expected deadline failure');
      assert.equal(result.errorCode, 'provider_timeout');
      assert.equal(result.retryable, true);
    });
  }
});

test('unmounted Claude/Gemini OAuth categories remain fail-closed', async () => {
  const candidates = [
    job({
      providerId: 'anthropic-claude',
      productId: 'claude-subscription',
      credentialType: 'oauth',
      allowedModels: ['claude-sonnet-4-5'],
      target: { model: 'claude-sonnet-4-5', endpoint: 'claude-messages', version: 1 },
    }),
    job({
      providerId: 'google-gemini',
      productId: 'gemini-subscription',
      credentialType: 'oauth',
      allowedModels: ['gemini-2.5-pro'],
      target: { model: 'gemini-2.5-pro', endpoint: 'gemini-generate-content', version: 1 },
    }),
  ];
  let calls = 0;
  for (const candidate of candidates) {
    assert.equal(isSupportedCredentialValidationTarget(candidate), false);
    assert.equal(credentialValidationCapabilityProtocol(candidate), null);
    const result = await validateProviderCredential(candidate, Buffer.from('{}'), async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    });
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: 'adapter_unsupported',
      retryable: false,
      adapterId: null,
      httpStatus: null,
      durationMs: 0,
    });
  }
  assert.equal(calls, 0);
});
