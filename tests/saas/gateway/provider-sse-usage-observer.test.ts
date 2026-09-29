import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  NormalSuccessCompletionInput,
  NormalSuccessSettlementPort,
  NormalSuccessSettlementSnapshot,
  NormalSuccessTransactionInput,
  NormalSuccessTransactionPort,
  NormalSuccessUncertaintyInput,
} from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { DispatchUsageSettlementCoordinator } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import type {
  PreparedEvidenceClientStream,
  PreparedEvidenceLeaseProvider,
  PreparedEvidenceMeteringPort,
  PreparedEvidenceTransportRequest,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { SaasPreparedEvidenceDispatchService } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  PreparedRequestEvidenceAudit,
  PreparedRequestEvidenceDispatchPort,
  PreparedRequestEvidenceRecord,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  type ProviderHttpFetch,
  ProviderHttpTransport,
  ProviderHttpTransportError,
} from '../../../src/saas/gateway/provider-http-transport.js';
import {
  observeProviderSseUsage,
  PROVIDER_SSE_USAGE_MAX_EVENT_BYTES,
  type ProviderSseObservedTransportResponse,
  type ProviderSseUsageEvidence,
  type ProviderSseUsageObservation,
  ProviderSseUsageObservingTransport,
} from '../../../src/saas/gateway/provider-sse-usage-observer.js';
import type { AttemptRecord, AttemptTransitionInput } from '../../../src/saas/metering/types.js';
import { normalizeRates } from '../../../src/saas/pricing/calculator.js';
import type { CustomerPriceVersionRecord, RateSetInput } from '../../../src/saas/pricing/types.js';

const encoder = new TextEncoder();
const payload = encoder.encode('prepared-local-fixture');
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
const customerPrice: CustomerPriceVersionRecord = {
  kind: 'customer',
  id: 'price-1',
  version: 1,
  publicModelId: 'model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  commercialPolicyVersion: 'policy-v1',
  calculatorVersion: 'calculator-v1',
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_up',
  roundingBoundary: 'total',
  rates: normalizeRates({
    input: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
    cache_read: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
    output: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  } satisfies RateSetInput),
  effectiveAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  idempotencyKey: 'price-key-v1',
  definitionDigest: 'd'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
};

function sse(data: string, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${data}\n\n`;
}

function openAiUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 2 },
    ...overrides,
  };
}

function openAiUsageStream(usage: Record<string, unknown> = openAiUsage()): Uint8Array[] {
  const contentChunk = {
    id: 'chatcmpl-local',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'fixture response' }, finish_reason: null }],
  };
  const usageChunk = {
    id: 'chatcmpl-local',
    object: 'chat.completion.chunk',
    choices: [],
    usage,
  };
  return [
    encoder.encode(sse(JSON.stringify(contentChunk))),
    encoder.encode(sse(JSON.stringify(usageChunk))),
    encoder.encode(sse('[DONE]')),
  ];
}

function splitBytes(bytes: Uint8Array, pattern: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let patternIndex = 0;
  while (offset < bytes.length) {
    const size = pattern[patternIndex % pattern.length] ?? 1;
    const end = Math.min(bytes.length, offset + size);
    chunks.push(bytes.slice(offset, end));
    offset = end;
    patternIndex += 1;
  }
  return chunks;
}

function streamFromChunks(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[index];
        if (next) {
          index += 1;
          controller.enqueue(next);
        } else {
          controller.close();
        }
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}

async function observeText(text: string, evidence: ProviderSseUsageEvidence): Promise<ProviderSseUsageObservation> {
  const observed = observeProviderSseUsage(streamFromChunks([encoder.encode(text)]), evidence);
  await drain(observed.body);
  return observed.observation;
}

const openAiEvidence: ProviderSseUsageEvidence = {
  providerProtocol: 'openai',
  providerOperation: 'chat.completions',
};

test('OpenAI Chat Completions usage survives arbitrary byte boundaries and the body stays byte transparent', async () => {
  const input = openAiUsageStream();
  const source = new Uint8Array(input.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of input) {
    source.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const chunks = splitBytes(source, [1]);
  const observed = observeProviderSseUsage(streamFromChunks(chunks), openAiEvidence);
  const output = await drain(observed.body);
  const result = await observed.observation;

  assert.equal(result.state, 'reported');
  if (result.state !== 'reported') return;
  assert.deepEqual(result.usage, {
    inputTotal: 12,
    inputUncached: 9,
    cacheRead: 3,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: 7,
    reasoningOutput: 2,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'v1',
  });
  assert.deepEqual(
    output.map((chunk) => [...chunk]),
    chunks.map((chunk) => [...chunk]),
  );
});

test('Anthropic Messages combines message_start cache/input with message_delta output', async () => {
  const events = [
    sse(
      JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 3,
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 },
            output_tokens: 1,
          },
        },
      }),
      'message_start',
    ),
    sse(JSON.stringify({ type: 'content_block_start', index: 0 }), 'content_block_start'),
    sse(
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🙂' } }),
      'content_block_delta',
    ),
    sse(JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } }), 'message_delta'),
    sse(JSON.stringify({ type: 'message_stop' }), 'message_stop'),
  ].join('');
  const chunks = splitBytes(encoder.encode(events), [2, 1, 7, 3, 11]);
  const observed = observeProviderSseUsage(streamFromChunks(chunks), {
    providerProtocol: 'anthropic',
    providerOperation: 'messages',
  });
  const output = await drain(observed.body);
  const result = await observed.observation;

  assert.equal(result.state, 'reported');
  if (result.state !== 'reported') return;
  assert.deepEqual(result.usage, {
    inputTotal: 17,
    inputUncached: 10,
    cacheRead: 4,
    cacheWrite: 3,
    cacheWrite5m: 2,
    cacheWrite1h: 1,
    outputTotal: 5,
    reasoningOutput: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'v1',
  });
  assert.deepEqual(
    output.map((chunk) => [...chunk]),
    chunks.map((chunk) => [...chunk]),
  );
});

test('Anthropic missing cache counters are unknown instead of being treated as zero', async () => {
  const events = [
    sse(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } }), 'message_start'),
    sse(JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2 } }), 'message_delta'),
    sse(JSON.stringify({ type: 'message_stop' }), 'message_stop'),
  ].join('');
  assert.deepEqual(await observeText(events, { providerProtocol: 'anthropic', providerOperation: 'messages' }), {
    state: 'unknown',
    usage: null,
    reason: 'invalid_usage',
  });
});

test('unsupported or client-side protocol evidence never selects a parser', async () => {
  assert.deepEqual(
    await observeText(
      openAiUsageStream()
        .map((chunk) => new TextDecoder().decode(chunk))
        .join(''),
      {
        providerProtocol: 'openai',
        providerOperation: 'responses',
      },
    ),
    { state: 'unknown', usage: null, reason: 'unsupported_protocol_operation' },
  );
  assert.deepEqual(await observeText(sse(JSON.stringify({ choices: [], usage: openAiUsage() })) + sse('[DONE]'), {}), {
    state: 'unknown',
    usage: null,
    reason: 'unsupported_protocol_operation',
  });
});

test('missing usage, malformed JSON, and an unterminated event remain unknown', async (context) => {
  await context.test('valid stream without a usage trailer', async () => {
    const chunk = { object: 'chat.completion.chunk', choices: [{ delta: { content: 'x' } }] };
    assert.deepEqual(await observeText(sse(JSON.stringify(chunk)) + sse('[DONE]'), openAiEvidence), {
      state: 'unknown',
      usage: null,
      reason: 'no_usage',
    });
  });
  await context.test('bad JSON', async () => {
    assert.deepEqual(await observeText(`data: {not-json}\n\n${sse('[DONE]')}`, openAiEvidence), {
      state: 'unknown',
      usage: null,
      reason: 'malformed_event',
    });
  });
  await context.test('truncated final event', async () => {
    const validChunk = sse(JSON.stringify({ choices: [], usage: openAiUsage() }));
    assert.deepEqual(await observeText(`${validChunk}data: [DONE]`, openAiEvidence), {
      state: 'unknown',
      usage: null,
      reason: 'truncated',
    });
  });
});

test('oversized events are ignored for usage while every response byte is forwarded', async () => {
  const oversizedData = JSON.stringify({
    choices: [{ delta: { content: 'x'.repeat(PROVIDER_SSE_USAGE_MAX_EVENT_BYTES) } }],
  });
  const bytes = encoder.encode(sse(oversizedData) + sse('[DONE]'));
  const chunks = splitBytes(bytes, [257, 1, 31]);
  const observed = observeProviderSseUsage(streamFromChunks(chunks), openAiEvidence);
  const output = await drain(observed.body);

  assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'oversized_event' });
  assert.deepEqual(
    output.map((chunk) => [...chunk]),
    chunks.map((chunk) => [...chunk]),
  );
});

test('unsafe totals and contradictory duplicate usage reports are unknown', async (context) => {
  await context.test('unsafe integer', async () => {
    assert.deepEqual(
      await observeText(
        sse(JSON.stringify({ choices: [], usage: openAiUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }) })) +
          sse('[DONE]'),
        openAiEvidence,
      ),
      { state: 'unknown', usage: null, reason: 'invalid_usage' },
    );
  });
  await context.test('overflowing aggregate', async () => {
    assert.deepEqual(
      await observeText(
        sse(
          JSON.stringify({
            choices: [],
            usage: openAiUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: 0 }),
          }),
        ) + sse('[DONE]'),
        openAiEvidence,
      ),
      { state: 'unknown', usage: null, reason: 'invalid_usage' },
    );
  });
  await context.test('conflicting repeated usage trailer', async () => {
    const first = { choices: [], usage: openAiUsage() };
    const second = { choices: [], usage: openAiUsage({ prompt_tokens: 11, total_tokens: 18 }) };
    assert.deepEqual(
      await observeText(sse(JSON.stringify(first)) + sse(JSON.stringify(second)) + sse('[DONE]'), openAiEvidence),
      { state: 'unknown', usage: null, reason: 'conflicting_usage' },
    );
  });
});

test('downstream cancellation cancels the source and resolves only an unknown observation', async () => {
  let cancelled = false;
  const observed = observeProviderSseUsage(
    streamFromChunks(
      [encoder.encode(sse(JSON.stringify({ choices: [], usage: openAiUsage() })) + sse('[DONE]'))],
      () => {
        cancelled = true;
      },
    ),
    openAiEvidence,
  );
  const reader = observed.body.getReader();
  await reader.cancel('client disconnected');

  assert.equal(cancelled, true);
  assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'cancelled' });
});

const audit: PreparedRequestEvidenceAudit = {
  actorUserId: 'user-local-test',
  entryPoint: 'provider-sse-usage-observer-test',
  sourceIp: null,
  userAgent: null,
  requestId: 'request-1',
};

function evidence(overrides: Partial<PreparedRequestEvidenceRecord> = {}): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'evidence-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    publicModel: 'model-1',
    protocol: 'anthropic',
    providerProtocol: 'openai',
    providerOperation: 'chat.completions',
    endpoint: '/v1/messages',
    upstreamId: 'upstream-1',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    routeTargetMode: 'tenant_account',
    payloadSha256,
    statementSha256: 'b'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: '2026-09-28T00:10:00.000Z',
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    tenantId: 'tenant-1',
    requestId: 'request-1',
    projectPolicyVersion: '1',
    customerPriceVersion: null,
    customerMeteringPolicyId: 'customer-policy-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-1',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-1',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'tenant_account',
    ordinal: 1,
    upstreamId: 'upstream-1',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'tenant',
    accountId: 'account-1',
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: 'resolved-model-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    supplierCostVersion: null,
    dispatchProfileId: 'profile-1',
    supplyProfileAuthzVersion: '1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
    profileAccountAuthzVersion: '1',
    preparedEvidenceId: null,
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    stateVersion: 1,
    ...overrides,
  };
}

class FakeMetering implements PreparedEvidenceMeteringPort {
  current = attempt();

  async getAttempt(): Promise<AttemptRecord> {
    return this.current;
  }

  async transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord> {
    this.current = {
      ...this.current,
      dispatchState: input.dispatchState ?? this.current.dispatchState,
      resultState: input.resultState ?? this.current.resultState,
      responseStarted: this.current.responseStarted || input.responseStarted === true,
      resultHttpStatus: input.resultHttpStatus ?? this.current.resultHttpStatus,
      unknownReason: input.unknownReason ?? null,
      stateVersion: this.current.stateVersion + 1,
    };
    return this.current;
  }
}

class FakeClient implements PreparedEvidenceClientStream {
  private readonly controller = new AbortController();
  readonly chunks: Uint8Array[] = [];
  starts: Array<{ status: number | null; headers: Readonly<Record<string, string>> }> = [];
  endCount = 0;
  abortCount = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    this.starts.push({ status, headers });
  }

  write(chunk: Uint8Array): void {
    this.chunks.push(new Uint8Array(chunk));
  }

  end(): void {
    this.endCount += 1;
  }

  abort(): void {
    this.abortCount += 1;
  }
}

function normalSuccessSnapshot(supplyMode: 'byok' | 'platform'): NormalSuccessSettlementSnapshot {
  const platform = supplyMode === 'platform';
  return {
    supplyMode,
    providerProtocol: 'openai',
    customerPriceVersion: platform ? 'price-1' : null,
    reservationId: platform ? 'hold-1' : null,
    priceSnapshotRef: platform ? 'snapshot-1' : null,
    currency: platform ? 'USD' : null,
    holdAmountMinorUnits: platform ? '100' : null,
    publicModelId: 'model-1',
    publicModelVersion: '1',
    providerId: 'provider-1',
    productId: 'product-1',
    endpoint: 'chat-completions',
    usageEstimatorVersion: 'estimator-v1',
  };
}

function httpTransport(chunks: readonly Uint8Array[]): ProviderHttpTransport {
  const fetch: ProviderHttpFetch = async (_url, _init) => {
    return new Response(streamFromChunks(chunks), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'local-provider-response',
        'x-private-test-header': 'filtered',
      },
    });
  };
  return new ProviderHttpTransport({
    fetch,
    timeoutMs: 5_000,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/dispatch' }),
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'Bearer local-fixture' }),
  });
}

function dispatchEvidencePort(record: PreparedRequestEvidenceRecord): PreparedRequestEvidenceDispatchPort {
  return {
    async preflightForDispatch(evidenceId) {
      assert.equal(evidenceId, record.evidenceId);
      return record;
    },
    async claimForDispatch(evidenceId) {
      assert.equal(evidenceId, record.evidenceId);
      return {
        ...record,
        status: 'claimed',
        claimedAt: '2026-09-28T00:01:00.000Z',
        claimedAttemptId: record.attemptId,
      };
    },
  };
}

function leaseProvider(): PreparedEvidenceLeaseProvider {
  return {
    async acquire() {
      return {
        fencingToken: 'fence-1',
        renewIntervalMs: 60_000,
        async renew() {},
        async release() {},
      };
    },
  };
}

test('local SSE E2E: ProviderHttpTransport dispatches transparent bytes and settles BYOK/platform from the same EOF usage', async () => {
  const wireChunks = splitBytes(
    encoder.encode(
      openAiUsageStream()
        .map((chunk) => new TextDecoder().decode(chunk))
        .join(''),
    ),
    [5, 1, 23, 2],
  );
  const observedResults: ProviderSseUsageObservation[] = [];
  const transactionInputs: NormalSuccessTransactionInput[] = [];

  for (const supplyMode of ['byok', 'platform'] as const) {
    const metering = new FakeMetering();
    const evidenceRecord = evidence({ supplyMode });
    const client = new FakeClient();
    const completions: NormalSuccessCompletionInput[] = [];
    const transactions: NormalSuccessTransactionInput[] = [];
    const transaction: NormalSuccessTransactionPort = {
      async complete(input) {
        transactions.push(input);
        transactionInputs.push(input);
        return { kind: 'settled', attempt: metering.current };
      },
      async retainUnknown() {
        return metering.current;
      },
    };
    const coordinator = new DispatchUsageSettlementCoordinator(
      {
        async getCustomerPriceVersion(id) {
          assert.equal(id, 'price-1');
          return customerPrice;
        },
      },
      transaction,
    );
    const settlement: NormalSuccessSettlementPort = {
      async complete(input) {
        completions.push(input);
        return coordinator.complete(input);
      },
      retainUnknown(input) {
        return coordinator.retainUnknown(input);
      },
    };
    const inner = httpTransport(wireChunks);
    const transport = new ProviderSseUsageObservingTransport(inner);
    const dispatch = new SaasPreparedEvidenceDispatchService(
      dispatchEvidencePort(evidenceRecord),
      metering,
      leaseProvider(),
      transport,
      settlement,
    );

    const result = await dispatch.dispatch({
      evidenceId: evidenceRecord.evidenceId,
      payloadBytes: payload,
      audit,
      normalSuccessSnapshot: normalSuccessSnapshot(supplyMode),
      client,
    });

    assert.equal(result.kind, 'sent');
    if (result.kind !== 'sent') continue;
    const observedResponse = result.transport as ProviderSseObservedTransportResponse;
    const observation = await observedResponse.usageObservation;
    assert.equal(observation?.state, 'reported');
    if (observation?.state !== 'reported') continue;
    observedResults.push(observation);
    assert.equal(client.endCount, 1);
    assert.equal(client.abortCount, 0);
    assert.deepEqual(client.starts, [
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'local-provider-response' },
      },
    ]);
    assert.deepEqual(
      client.chunks.map((chunk) => [...chunk]),
      wireChunks.map((chunk) => [...chunk]),
    );
    assert.equal(completions.length, 1);
    assert.strictEqual(completions[0]?.usage, result.transport.providerUsage);
    assert.equal(completions[0]?.usage.source, 'upstream');
    assert.equal(completions[0]?.snapshot.supplyMode, supplyMode);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.supplyMode, supplyMode);
    assert.equal(transactions[0]?.usage.status, 'reported');
    assert.equal(transactions[0]?.usage.source, 'upstream');
    if (supplyMode === 'byok') assert.equal(transactions[0]?.chargeAmountMinorUnits, null);
    if (supplyMode === 'platform') assert.equal(transactions[0]?.chargeAmountMinorUnits, '19');
  }

  assert.equal(observedResults.length, 2);
  assert.deepEqual(observedResults[0]?.usage, observedResults[1]?.usage);
  assert.deepEqual(transactionInputs[0]?.usage, transactionInputs[1]?.usage);
});

test('upstream cancellation from ProviderHttpTransport propagates and cannot produce a usage report', async () => {
  let upstreamCancelled = false;
  const controller = new AbortController();
  const pendingBody = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const base = new ProviderHttpTransport({
    fetch: async () => new Response(pendingBody, { status: 200 }),
    timeoutMs: 5_000,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/dispatch' }),
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'Bearer local-fixture' }),
  });
  const response = await new ProviderSseUsageObservingTransport(base).send({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    fencingToken: 'fence-1',
    signal: controller.signal,
    payloadBytes: payload,
    evidence: evidence({
      providerProtocol: 'openai',
      providerOperation: 'chat.completions',
      status: 'claimed',
      claimedAttemptId: 'attempt-1',
    }),
  } satisfies PreparedEvidenceTransportRequest);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const pendingRead = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(
    pendingRead,
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ABORTED',
  );
  assert.equal(upstreamCancelled, true);
  const observation = await (response as ProviderSseObservedTransportResponse).usageObservation;
  assert.deepEqual(observation, { state: 'unknown', usage: null, reason: 'stream_error' });
});

test('successful delivery without trusted usage retains the reconciliation hold', async () => {
  const chunks = splitBytes(
    encoder.encode(sse(JSON.stringify({ choices: [{ delta: { content: 'visible response' } }] })) + sse('[DONE]')),
    [4, 13, 1],
  );
  const metering = new FakeMetering();
  const evidenceRecord = evidence({ supplyMode: 'platform' });
  const client = new FakeClient();
  const retained: NormalSuccessUncertaintyInput[] = [];
  let completeCalls = 0;
  const settlement: NormalSuccessSettlementPort = {
    async complete() {
      completeCalls += 1;
      return { kind: 'settled', attempt: metering.current };
    },
    async retainUnknown(input) {
      retained.push(input);
      return metering.current;
    },
  };
  const dispatch = new SaasPreparedEvidenceDispatchService(
    dispatchEvidencePort(evidenceRecord),
    metering,
    leaseProvider(),
    new ProviderSseUsageObservingTransport(httpTransport(chunks)),
    settlement,
  );

  const result = await dispatch.dispatch({
    evidenceId: evidenceRecord.evidenceId,
    payloadBytes: payload,
    audit,
    normalSuccessSnapshot: normalSuccessSnapshot('platform'),
    client,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(client.endCount, 1);
  assert.equal(completeCalls, 0);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.reason, 'usage_missing');
  assert.equal(retained[0]?.responseStarted, true);
});

test('observer completion stays pending until EOF and resolves unknown after cancellation', async () => {
  let sourceCancelled = false;
  const observed = observeProviderSseUsage(
    streamFromChunks(
      [encoder.encode(sse(JSON.stringify({ choices: [], usage: openAiUsage() })) + sse('[DONE]'))],
      () => {
        sourceCancelled = true;
      },
    ),
    openAiEvidence,
  );
  let completed = false;
  void observed.observation.then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  await observed.body.cancel('downstream closed');
  assert.equal(sourceCancelled, true);
  assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'cancelled' });
});
