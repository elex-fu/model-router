import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import {
  beginPreparedEvidenceDispatchStage,
  observePreparedEvidenceDispatchStage,
  PREPARED_EVIDENCE_DISPATCH_STAGES,
  type PreparedEvidenceDispatchObservation,
  type PreparedEvidenceDispatchStage,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-observer.js';
import type { PreparedEvidenceTransportRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  ProviderHttpTransport,
  ProviderHttpTransportError,
  type ProviderHttpTransportOptions,
} from '../../../src/saas/gateway/provider-http-transport.js';

const TRANSPORT_STAGES = [
  'transport-profile-resolve',
  'transport-provider-dns',
  'transport-proxy-prepare',
  'transport-fixed-headers',
  'transport-credential-prepare',
  'transport-connector-create',
  'transport-fetch-headers',
] as const satisfies readonly PreparedEvidenceDispatchStage[];
const payload = new TextEncoder().encode(JSON.stringify({ model: 'observer-model', input: 'local input' }));
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
const dispatcher = {} as Dispatcher;

function request(signal: AbortSignal = new AbortController().signal): PreparedEvidenceTransportRequest {
  const evidence: PreparedRequestEvidenceRecord = {
    evidenceId: 'observer-evidence',
    tenantId: 'observer-tenant',
    projectId: 'observer-project',
    requestId: 'observer-request',
    attemptId: 'observer-attempt',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    publicModel: 'observer-model',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    upstreamId: 'observer-upstream',
    accountId: 'observer-account',
    credentialId: 'observer-credential',
    credentialVersion: '7',
    routeTargetMode: 'tenant_account',
    payloadSha256,
    statementSha256: 'b'.repeat(64),
    status: 'claimed',
    claimedAt: '2026-10-22T00:00:00.000Z',
    claimedAttemptId: 'observer-attempt',
    expiresAt: '2026-10-22T00:10:00.000Z',
  };
  return {
    tenantId: evidence.tenantId,
    projectId: evidence.projectId,
    requestId: evidence.requestId,
    attemptId: evidence.attemptId,
    fencingToken: 'observer-fence',
    signal,
    payloadBytes: payload,
    evidence,
  };
}

function options(overrides: Partial<ProviderHttpTransportOptions> = {}): ProviderHttpTransportOptions {
  return {
    fetch: async () => new Response(null, { status: 204 }),
    timeoutMs: 1000,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/dispatch' }),
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'transient-observer-credential' }),
    createConnector: () => ({ dispatcher, close: async () => {}, destroy: async () => {} }),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('deferred promise was not initialized');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function assertBounded(observations: readonly PreparedEvidenceDispatchObservation[]): void {
  for (const observation of observations) {
    assert.deepEqual(Object.keys(observation).sort(), ['durationMs', 'outcome', 'stage']);
    assert.ok(PREPARED_EVIDENCE_DISPATCH_STAGES.includes(observation.stage));
    assert.ok(Number.isFinite(observation.durationMs) && observation.durationMs >= 0);
    assert.ok(observation.outcome === 'ok' || observation.outcome === 'error');
  }
  const serialized = JSON.stringify(observations);
  for (const value of ['provider.example', 'observer-account', 'observer-evidence', 'transient-observer-credential']) {
    assert.equal(serialized.includes(value), false);
  }
}

test('phase completion is idempotent and diagnostics cannot replace a result or error', async () => {
  const observations: PreparedEvidenceDispatchObservation[] = [];
  const finish = beginPreparedEvidenceDispatchStage('transport-credential-prepare', (value) =>
    observations.push(value),
  );
  finish('ok');
  finish('error');
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.outcome, 'ok');
  assertBounded(observations);
  const ignored = beginPreparedEvidenceDispatchStage('transport-connector-create', undefined);
  ignored('ok');
  ignored('error');

  const diagnosticFailure = () => {
    throw new Error('diagnostic failure');
  };
  assert.equal(
    await observePreparedEvidenceDispatchStage('transport-fetch-headers', diagnosticFailure, async () => 7),
    7,
  );
  const originalError = new Error('original failure');
  await assert.rejects(
    observePreparedEvidenceDispatchStage('transport-fetch-headers', diagnosticFailure, async () => {
      throw originalError;
    }),
    (error) => error === originalError,
  );
});

test('seven phases preserve serial ordering and stop credential preparation before fetch and resolver cleanup', async () => {
  const observations: PreparedEvidenceDispatchObservation[] = [];
  const fetchEntered = deferred<void>();
  const fetchResponse = deferred<Response>();
  const resolverTailEntered = deferred<void>();
  const finishResolver = deferred<void>();
  const credential = new TextEncoder().encode('transient-observer-credential');
  let connectorMicrotaskRan = false;
  let closed = 0;
  let destroyed = 0;
  let settled = false;
  const transport = new ProviderHttpTransport(
    options({
      observe: (value) => observations.push(value),
      resolveDispatchProfile: async () => ({
        url: 'https://provider.example/v1/dispatch',
        egressProxy: { url: 'http://proxy.example:8080' },
      }),
      resolveFixedRequestHeaders: async () => ({ 'anthropic-version': '2023-06-01' }),
      resolveCredential: async (_input, useCredential) => {
        let result: Awaited<ReturnType<typeof useCredential>>;
        try {
          result = await useCredential({ headerName: 'authorization', value: credential });
        } finally {
          credential.fill(0);
        }
        resolverTailEntered.resolve(undefined);
        await finishResolver.promise;
        return result;
      },
      createConnector: () => {
        assert.equal(observations.at(-1)?.stage, 'transport-credential-prepare');
        queueMicrotask(() => {
          connectorMicrotaskRan = true;
        });
        return {
          dispatcher,
          close: async () => {
            closed++;
          },
          destroy: async () => {
            destroyed++;
          },
        };
      },
      fetch: async () => {
        assert.equal(connectorMicrotaskRan, false, 'connector creation must not introduce an await');
        assert.deepEqual(
          observations.map((value) => value.stage),
          TRANSPORT_STAGES.slice(0, -1),
        );
        fetchEntered.resolve(undefined);
        return fetchResponse.promise;
      },
    }),
  );
  const sending = transport.send(request()).finally(() => {
    settled = true;
  });
  await fetchEntered.promise;
  const credentialObservation = observations.find((value) => value.stage === 'transport-credential-prepare');
  assert.ok(credentialObservation);
  const credentialDuration = credentialObservation.durationMs;
  fetchResponse.resolve(new Response(null, { status: 204 }));
  await resolverTailEntered.promise;
  assert.equal(settled, false);
  assert.deepEqual(
    observations.map((value) => value.stage),
    TRANSPORT_STAGES,
  );
  assert.equal(credentialObservation.durationMs, credentialDuration);
  assert.equal(observations.filter((value) => value.stage === 'transport-credential-prepare').length, 1);
  assert.ok(credential.every((value) => value === 0));
  finishResolver.resolve(undefined);
  assert.equal((await sending).resultHttpStatus, 204);
  assert.ok(observations.every((value) => value.outcome === 'ok'));
  assert.equal(closed, 1);
  assert.equal(destroyed, 0);
  assertBounded(observations);
});

test('unused DNS, proxy and fixed-header branches emit no samples', async () => {
  const observations: PreparedEvidenceDispatchObservation[] = [];
  await new ProviderHttpTransport(
    options({
      observe: (value) => observations.push(value),
      endpointPolicy: { allowedHosts: ['8.8.8.8'], allowedPorts: [443] },
      resolveDispatchProfile: async () => ({ url: 'https://8.8.8.8/v1/dispatch' }),
      resolveAddresses: async () => {
        throw new Error('literal targets must not resolve DNS');
      },
    }),
  ).send(request());
  assert.deepEqual(
    observations.map((value) => value.stage),
    [
      'transport-profile-resolve',
      'transport-credential-prepare',
      'transport-connector-create',
      'transport-fetch-headers',
    ],
  );
  assertBounded(observations);
});

test('a failing phase emits one bounded error without starting later phases', async (t) => {
  const failure = () => {
    throw new Error('private failure detail must not be observed');
  };
  const cases: Array<{
    name: string;
    stage: PreparedEvidenceDispatchStage;
    code: string;
    overrides: Partial<ProviderHttpTransportOptions>;
  }> = [
    {
      name: 'profile',
      stage: 'transport-profile-resolve',
      code: 'PROFILE_UNAVAILABLE',
      overrides: { resolveDispatchProfile: async () => failure() },
    },
    {
      name: 'DNS',
      stage: 'transport-provider-dns',
      code: 'ENDPOINT_POLICY_VIOLATION',
      overrides: { resolveAddresses: async () => failure() },
    },
    {
      name: 'proxy',
      stage: 'transport-proxy-prepare',
      code: 'EGRESS_PROXY_INVALID',
      overrides: {
        resolveDispatchProfile: async () => ({
          url: 'https://provider.example/v1/dispatch',
          egressProxy: { url: 'http://proxy.example:8080' },
        }),
        resolveAddresses: async (hostname) =>
          hostname === 'proxy.example' ? failure() : [{ address: '8.8.8.8', family: 4 }],
      },
    },
    {
      name: 'fixed headers',
      stage: 'transport-fixed-headers',
      code: 'FIXED_REQUEST_HEADERS_INVALID',
      overrides: { resolveFixedRequestHeaders: async () => failure() },
    },
    {
      name: 'credential resolver',
      stage: 'transport-credential-prepare',
      code: 'CREDENTIAL_UNAVAILABLE',
      overrides: { resolveCredential: async () => failure() },
    },
    {
      name: 'credential validation',
      stage: 'transport-credential-prepare',
      code: 'CREDENTIAL_INVALID',
      overrides: {
        resolveCredential: async (_input, useCredential) =>
          useCredential({ headerName: 'authorization', value: 'invalid\ncredential' }),
      },
    },
    {
      name: 'connector',
      stage: 'transport-connector-create',
      code: 'NETWORK_ERROR',
      overrides: { createConnector: failure },
    },
    {
      name: 'fetch',
      stage: 'transport-fetch-headers',
      code: 'NETWORK_ERROR',
      overrides: { fetch: async () => failure() },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const observations: PreparedEvidenceDispatchObservation[] = [];
      await assert.rejects(
        new ProviderHttpTransport(
          options({ ...scenario.overrides, observe: (value) => observations.push(value) }),
        ).send(request()),
        (error) => error instanceof ProviderHttpTransportError && error.code === scenario.code,
      );
      assert.deepEqual(
        observations.filter((value) => value.stage === scenario.stage).map((value) => value.outcome),
        ['error'],
      );
      assert.equal(observations.at(-1)?.stage, scenario.stage);
      assert.equal(JSON.stringify(observations).includes('private failure'), false);
      assertBounded(observations);
    });
  }
});

test('resolver cleanup failure cannot reopen an already completed credential phase', async () => {
  const observations: PreparedEvidenceDispatchObservation[] = [];
  await assert.rejects(
    new ProviderHttpTransport(
      options({
        observe: (value) => observations.push(value),
        resolveCredential: async (_input, useCredential) => {
          await useCredential({ headerName: 'authorization', value: 'transient-observer-credential' });
          throw new Error('resolver cleanup failure');
        },
      }),
    ).send(request()),
    (error) => error instanceof ProviderHttpTransportError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );
  assert.deepEqual(
    observations.filter((value) => value.stage === 'transport-credential-prepare').map((value) => value.outcome),
    ['ok'],
  );
  assert.equal(observations.at(-1)?.stage, 'transport-fetch-headers');
  assertBounded(observations);
});

test('lease cancellation records the active phase once and retains connector destruction', async (t) => {
  for (const phase of ['credential', 'fetch'] as const) {
    await t.test(phase, async () => {
      const entered = deferred<void>();
      const controller = new AbortController();
      const observations: PreparedEvidenceDispatchObservation[] = [];
      let destroyed = 0;
      let closed = 0;
      const aborted = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          entered.resolve(undefined);
          signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        });
      const sending = new ProviderHttpTransport(
        options({
          observe: (value) => observations.push(value),
          ...(phase === 'credential' ? { resolveCredential: async (input) => aborted(input.signal) } : {}),
          fetch: async (_url, init) => aborted(init.signal as AbortSignal),
          createConnector: () => ({
            dispatcher,
            close: async () => {
              closed++;
            },
            destroy: async () => {
              destroyed++;
            },
          }),
        }),
      ).send(request(controller.signal));
      await entered.promise;
      controller.abort();
      await assert.rejects(sending, (error) => error instanceof ProviderHttpTransportError && error.code === 'ABORTED');
      const stage = phase === 'credential' ? 'transport-credential-prepare' : 'transport-fetch-headers';
      assert.deepEqual(
        observations.filter((value) => value.stage === stage).map((value) => value.outcome),
        ['error'],
      );
      assert.equal(observations.at(-1)?.stage, stage);
      assert.equal(destroyed, phase === 'fetch' ? 1 : 0);
      assert.equal(closed, 0);
      assertBounded(observations);
    });
  }
});

test('throwing observers preserve streaming cancellation and do not change body or usage', async () => {
  let cancelled = 0;
  let destroyed = 0;
  let closed = 0;
  let sent = false;
  const chunk = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(chunk);
        } else return new Promise<void>(() => {});
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await new ProviderHttpTransport(
    options({
      observe: () => {
        throw new Error('diagnostic observer failure');
      },
      fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      createConnector: () => ({
        dispatcher,
        close: async () => {
          closed++;
        },
        destroy: async () => {
          destroyed++;
        },
      }),
    }),
  ).send(request());
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, chunk);
  await reader.cancel();
  reader.releaseLock();
  assert.equal(cancelled, 1);
  assert.equal(destroyed, 1);
  assert.equal(closed, 0);
  assert.equal(response.providerUsage, null);
});
