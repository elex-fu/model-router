import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import type { PreparedEvidenceTransportRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  type ProviderHttpCredentialResolveInput,
  ProviderHttpTransport,
} from '../../../src/saas/gateway/provider-http-transport.js';
import { observeProviderJsonUsage } from '../../../src/saas/gateway/provider-json-usage-observer.js';
import { observeProviderSseUsage } from '../../../src/saas/gateway/provider-sse-usage-observer.js';
import {
  type ProviderUsageProfileEvidence,
  providerUsageProfile,
} from '../../../src/saas/gateway/provider-usage-profile.js';

const encoder = new TextEncoder();
const coding: ProviderUsageProfileEvidence = {
  providerId: 'kimi',
  productId: 'kimi-code',
  endpoint: 'messages',
  providerProtocol: 'anthropic',
  providerOperation: 'messages',
  providerTargetUrl: 'https://api.kimi.com/coding/v1/messages',
};
const usage = {
  input_tokens: 0,
  output_tokens: 11,
  cache_read_input_tokens: 25,
  cache_creation_input_tokens: 0,
  service_tier: 'standard',
  inference_geo: 'not_available',
};

function nativeJson(raw: Record<string, unknown>, envelope: Record<string, unknown> = {}) {
  return {
    id: 'msg-fixture',
    type: 'message',
    role: 'assistant',
    model: 'kimi-for-coding',
    content: [{ type: 'text', text: 'fixture' }],
    stop_reason: 'end_turn',
    usage: raw,
    ...envelope,
  };
}

function event(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function nativeSse(
  raw: Record<string, unknown>,
  delta: Record<string, unknown> = { output_tokens: 11 },
  envelope: Record<string, unknown> = {},
): string {
  return (
    event('message_start', { message: nativeJson({ ...raw, output_tokens: 0 }, envelope) }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture' } }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: delta }) +
    event('message_stop', {})
  );
}

function source(text: string): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset < bytes.byteLength) controller.enqueue(bytes.slice(offset, ++offset));
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

async function readText(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

async function observe(
  kind: 'json' | 'sse',
  raw: Record<string, unknown>,
  evidence = coding,
  envelope: Record<string, unknown> = {},
  delta?: Record<string, unknown>,
) {
  const text = kind === 'json' ? JSON.stringify(nativeJson(raw, envelope)) : nativeSse(raw, delta, envelope);
  const observed =
    kind === 'json'
      ? observeProviderJsonUsage(source(text), evidence)
      : observeProviderSseUsage(source(text), evidence);
  assert.equal(observed.getObservation(), null);
  assert.equal(await readText(observed.body), text, 'raw provider bytes must remain unchanged');
  return observed.observation;
}

test('Coding usage profile requires the signed provider/product/endpoint and exact validated target', () => {
  assert.equal(providerUsageProfile(coding), 'kimi-coding-messages/v1');
  // The global endpoint is a synthetic contract check, not a live acceptance claim.
  assert.equal(
    providerUsageProfile({
      ...coding,
      productId: 'kimi-code-global',
      providerTargetUrl: 'https://api.kimi.ai/coding/v1/messages',
    }),
    'kimi-coding-messages/v1',
  );
  for (const overrides of [
    { providerId: undefined },
    { providerId: 'anthropic' },
    { productId: undefined },
    { productId: 'kimi-api' },
    { endpoint: '/v1/messages' },
    { providerProtocol: 'openai' },
    { providerOperation: 'chat.completions' },
    { providerTargetUrl: undefined },
    { providerTargetUrl: 'https://provider.example/coding/v1/messages' },
    { providerTargetUrl: 'https://api.kimi.com/v1/messages' },
    { providerTargetUrl: 'https://api.kimi.ai/coding/v1/messages' },
    { providerTargetUrl: 'https://api.kimi.com:8443/coding/v1/messages' },
    { providerTargetUrl: 'https://api.kimi.com/coding/v1/messages?profile=kimi' },
    { providerTargetUrl: 'http://api.kimi.com/coding/v1/messages' },
  ]) {
    assert.equal(providerUsageProfile({ ...coding, ...overrides }), null);
  }
});

for (const kind of ['json', 'sse'] as const) {
  test(`${kind}: Coding output decomposition reports thinking_tokens as a non-additive sub-counter`, async () => {
    // Live evidence 2026-10-24 (A1o run06 + direct CN probes): thinking-bearing
    // responses report thinking_tokens inside the terminal usage alongside the
    // final output_tokens; output_tokens remains the authoritative billed
    // counter. SSE carries the decomposition on the message_delta usage.
    const result =
      kind === 'json'
        ? await observe(kind, { ...usage, output_tokens_details: { thinking_tokens: 11 } })
        : await observe(kind, usage, coding, {}, { output_tokens: 11, output_tokens_details: { thinking_tokens: 11 } });
    assert.equal(result.state, 'reported');
    assert.equal(result.usage?.outputTotal, 11);
  });

  test(`${kind}: Coding baseline metadata retains all 25 cached input tokens and the observed standard tier`, async () => {
    const result = await observe(kind, usage);
    assert.equal(result.state, 'reported');
    assert.equal(result.usage?.inputTotal, 25);
    assert.equal(result.usage?.inputUncached, 0);
    assert.equal(result.usage?.cacheRead, 25);
    assert.equal(result.usage?.cacheWrite, 0);
    assert.equal(result.usage?.outputTotal, 11);
    assert.equal(result.observedServiceTier, 'standard');
    assert.notEqual(result.observedServiceTierConflict, true);
  });

  test(`${kind}: absence of optional metadata preserves the existing native counter contract`, async () => {
    const raw: Record<string, unknown> = { ...usage };
    delete raw.service_tier;
    delete raw.inference_geo;
    for (const evidence of [coding, { providerProtocol: 'anthropic', providerOperation: 'messages' }]) {
      const result = await observe(kind, raw, evidence);
      assert.equal(result.state, 'reported');
      assert.equal(result.usage?.inputTotal, 25);
      assert.equal(result.observedServiceTier, null);
    }
  });

  test(`${kind}: premium, regional, malformed, and unmodeled usage dimensions remain untrusted`, async (t) => {
    const cases: Array<readonly [string, Record<string, unknown>]> = [
      ...['priority', 'batch', 'fast', 'STANDARD', '', null, 1, {}].map(
        (value) => [`service_tier ${JSON.stringify(value)}`, { ...usage, service_tier: value }] as const,
      ),
      ...['us', 'global', 'new-region', '', null, 1, {}].map(
        (value) => [`inference_geo ${JSON.stringify(value)}`, { ...usage, inference_geo: value }] as const,
      ),
      ['fast speed', { ...usage, speed: 'fast' }],
      ['new counter', { ...usage, future_billable_tokens: 7 }],
      ['counter alias', { ...usage, prompt_tokens: 25 }],
      ['output details exceeding output_tokens', { ...usage, output_tokens_details: { thinking_tokens: 12 } }],
      ['output details unknown sub-key', { ...usage, output_tokens_details: { reasoning_tokens: 1 } }],
      ['output details non-object', { ...usage, output_tokens_details: 7 }],
      ['output details non-integer', { ...usage, output_tokens_details: { thinking_tokens: 1.5 } }],
      ['output details negative', { ...usage, output_tokens_details: { thinking_tokens: -1 } }],
      ['negative counter', { ...usage, cache_read_input_tokens: -1 }],
      ['fractional counter', { ...usage, input_tokens: 0.5 }],
      ['unsafe counter', { ...usage, cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1 }],
      ['TTL mismatch', { ...usage, cache_creation: { ephemeral_5m_input_tokens: 1 } }],
    ];
    for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const raw: Record<string, unknown> = { ...usage };
      delete raw[key];
      cases.push([`missing ${key}`, raw]);
    }
    if (kind === 'json') {
      const raw: Record<string, unknown> = { ...usage };
      delete raw.output_tokens;
      cases.push(['missing output_tokens', raw]);
    }
    for (const [name, raw] of cases) {
      await t.test(name, async () => {
        const result = await observe(kind, raw);
        assert.equal(result.state, 'unknown');
        assert.equal(result.usage, null);
        if (result.state === 'unknown') assert.equal(result.reason, 'invalid_usage');
      });
    }
  });

  test(`${kind}: metadata cannot be borrowed by another provider or target`, async () => {
    for (const overrides of [
      { providerId: undefined },
      { providerId: 'anthropic' },
      { productId: 'kimi-api' },
      { endpoint: 'chat-completions' },
      { providerTargetUrl: 'https://provider.example/coding/v1/messages' },
    ]) {
      const result = await observe(kind, usage, { ...coding, ...overrides });
      assert.equal(result.state, 'unknown');
      assert.equal(result.usage, null);
    }
  });

  test(`${kind}: conflicting envelope tiers remain visible and cannot authorize settlement`, async () => {
    const result = await observe(kind, usage, coding, { service_tier: 'priority' });
    assert.equal(result.state, 'unknown');
    assert.equal(result.usage, null);
    assert.equal(result.observedServiceTierConflict, true);
    assert.equal(result.observedServiceTier, null);
  });
}

test('SSE repeats baseline metadata across start/delta and rejects later premium or regional changes', async () => {
  const complete = await observe(
    'sse',
    usage,
    coding,
    {},
    {
      output_tokens: 11,
      service_tier: 'standard',
      inference_geo: 'not_available',
    },
  );
  assert.equal(complete.state, 'reported');
  assert.equal(complete.observedServiceTier, 'standard');
  assert.equal(complete.observedServiceTierConflict, false);
  for (const delta of [
    { output_tokens: 11, service_tier: 'priority' },
    { output_tokens: 11, inference_geo: 'us' },
    { output_tokens: 11, service_tier: null },
  ]) {
    const result = await observe('sse', usage, coding, {}, delta);
    assert.equal(result.state, 'unknown');
    assert.equal(result.usage, null);
    if (Object.hasOwn(delta, 'service_tier')) assert.equal(result.observedServiceTierConflict, true);
  }
});

const payloadBytes = encoder.encode(JSON.stringify({ model: 'kimi-for-coding', messages: [], max_tokens: 32 }));
const digest = createHash('sha256').update(payloadBytes).digest('hex');

function request(overrides: Partial<PreparedRequestEvidenceRecord> = {}): PreparedEvidenceTransportRequest {
  return {
    tenantId: 'tenant-fixture',
    projectId: 'project-fixture',
    requestId: 'request-fixture',
    attemptId: 'attempt-fixture',
    fencingToken: 'fence-fixture',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: {
      evidenceId: 'evidence-fixture',
      tenantId: 'tenant-fixture',
      projectId: 'project-fixture',
      requestId: 'request-fixture',
      attemptId: 'attempt-fixture',
      attemptOrdinal: 1,
      supplyMode: 'byok',
      publicModel: 'public-fixture',
      resolvedModel: 'kimi-for-coding',
      protocol: 'anthropic',
      clientProtocol: 'anthropic',
      clientOperation: 'messages',
      providerId: 'kimi',
      productId: 'kimi-code',
      endpoint: 'messages',
      providerProtocol: 'anthropic',
      providerOperation: 'messages',
      upstreamId: 'upstream-fixture',
      accountId: 'account-fixture',
      credentialId: 'credential-fixture',
      credentialVersion: '1',
      routeTargetMode: 'tenant_account',
      payloadSha256: digest,
      statementSha256: 'a'.repeat(64),
      status: 'claimed',
      claimedAt: '2026-10-21T00:00:00.000Z',
      claimedAttemptId: 'attempt-fixture',
      expiresAt: '2026-10-21T01:00:00.000Z',
      ...overrides,
    },
  };
}

async function send(
  kind: 'json' | 'sse',
  target: string,
  evidence: Partial<PreparedRequestEvidenceRecord> = {},
  onCredentialInput?: (input: ProviderHttpCredentialResolveInput, record: PreparedRequestEvidenceRecord) => void,
) {
  const wire = kind === 'json' ? JSON.stringify(nativeJson(usage)) : nativeSse(usage);
  const transportRequest = request(evidence);
  const transport = new ProviderHttpTransport({
    timeoutMs: 5_000,
    endpointPolicy: { allowedHosts: ['api.kimi.com', 'api.kimi.ai', 'provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    createConnector: () => ({ dispatcher: {} as Dispatcher, close: async () => {}, destroy: async () => {} }),
    resolveDispatchProfile: async () => ({ url: target }),
    resolveCredential: async (input, use) => {
      onCredentialInput?.(input, transportRequest.evidence);
      return use({ headerName: 'x-api-key', value: 'synthetic-fixture' });
    },
    fetch: async () =>
      new Response(source(wire), {
        status: 200,
        headers: { 'content-type': kind === 'json' ? 'application/json' : 'text/event-stream' },
      }),
  });
  const result = await transport.send(transportRequest);
  assert.equal(result.providerUsage, null, 'no usage is trusted before raw EOF');
  assert.ok(result.body);
  const clientText = await readText(result.body);
  return { result, wire, clientText };
}

for (const kind of ['json', 'sse'] as const) {
  test(`${kind}: HTTP transport binds the profile and observes raw cache usage before optional client bridging`, async () => {
    for (const bridge of [false, true]) {
      const { result, wire, clientText } = await send(
        kind,
        coding.providerTargetUrl as string,
        {
          ...(bridge ? { protocol: 'openai', clientProtocol: 'openai', clientOperation: 'chat.completions' } : {}),
        },
        (input) => {
          assert.equal(input.providerId, 'kimi');
          assert.equal(input.productId, 'kimi-code');
          assert.equal(input.endpoint, 'messages');
          assert.equal(input.providerProtocol, 'anthropic');
          assert.equal(input.providerOperation, 'messages');
          assert.equal(Object.isFrozen(input), true);
        },
      );
      assert.equal(result.providerUsage?.inputTotal, 25);
      assert.equal(result.providerUsage?.inputUncached, 0);
      assert.equal(result.providerUsage?.cacheRead, 25);
      assert.equal(result.providerUsage?.cacheWrite, 0);
      assert.equal(result.providerUsage?.outputTotal, 11);
      assert.deepEqual(result.serviceTier, { requested: null, observed: 'standard' });
      assert.equal(result.usageEvidence?.completeness, 'complete');
      assert.equal(result.usageEvidence?.model, 'kimi-for-coding');
      assert.equal(result.usageEvidence?.operation, 'messages');
      assert.equal(result.usageEvidence?.observerVersion, `provider-${kind}-usage-observer/v2+kimi-coding-messages/v1`);
      if (!bridge) assert.equal(clientText, wire);
      else if (kind === 'json') assert.equal(JSON.parse(clientText).usage.prompt_tokens, 25);
      else assert.match(clientText, /"object":"chat.completion.chunk"/);
    }
  });

  test(`${kind}: HTTP transport cannot borrow Coding metadata rules with a wrong signed identity or target`, async () => {
    for (const [target, evidence] of [
      [coding.providerTargetUrl, { providerId: undefined }],
      [coding.providerTargetUrl, { providerId: 'other' }],
      [coding.providerTargetUrl, { productId: 'kimi-api' }],
      [coding.providerTargetUrl, { endpoint: '/v1/messages' }],
      [coding.providerTargetUrl, { productId: 'kimi-code-global' }],
      ['https://provider.example/coding/v1/messages', {}],
      ['https://api.kimi.com/v1/messages', {}],
    ] as const) {
      const { result, wire, clientText } = await send(kind, target as string, evidence);
      assert.equal(clientText, wire);
      assert.equal(result.providerUsage, null);
      assert.equal(result.usageEvidence?.completeness, 'incomplete-malformed');
      assert.equal(result.usageEvidence?.observerVersion, `provider-${kind}-usage-observer/v2`);
    }
  });

  test(`${kind}: mutation after credential identity capture cannot borrow the Coding response profile`, async () => {
    const { result } = await send(
      kind,
      coding.providerTargetUrl as string,
      { providerId: 'other', productId: 'other-product' },
      (input, record) => {
        assert.equal(input.providerId, 'other');
        assert.equal(input.productId, 'other-product');
        Object.assign(record, { providerId: 'kimi', productId: 'kimi-code' });
      },
    );
    assert.equal(result.providerUsage, null);
    assert.equal(result.usageEvidence?.completeness, 'incomplete-malformed');
    assert.equal(result.usageEvidence?.observerVersion, `provider-${kind}-usage-observer/v2`);
  });
}
