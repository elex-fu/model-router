import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { OPENCODE_GO_ENDPOINT } from '../../../../src/saas/gateway/opencode-go/catalog-identity.js';
import {
  OPENCODE_GO_ANTHROPIC_VERSION,
  openCodeGoFixedRequestHeaders,
} from '../../../../src/saas/gateway/opencode-go/transport-headers.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';
import { ProviderHttpTransport } from '../../../../src/saas/gateway/provider-http-transport.js';

test('anthropic-routed opencode-go traffic gains anthropic-version only', () => {
  assert.deepEqual(openCodeGoFixedRequestHeaders({ endpoint: OPENCODE_GO_ENDPOINT, providerProtocol: 'anthropic' }), {
    'anthropic-version': OPENCODE_GO_ANTHROPIC_VERSION,
  });
  assert.equal(OPENCODE_GO_ANTHROPIC_VERSION, '2023-06-01');
});

test('every other combination adds nothing (zero behavior change)', () => {
  assert.equal(openCodeGoFixedRequestHeaders({ endpoint: OPENCODE_GO_ENDPOINT, providerProtocol: 'openai' }), null);
  assert.equal(openCodeGoFixedRequestHeaders({ endpoint: OPENCODE_GO_ENDPOINT, providerProtocol: 'responses' }), null);
  assert.equal(openCodeGoFixedRequestHeaders({ endpoint: OPENCODE_GO_ENDPOINT, providerProtocol: undefined }), null);
  // A foreign provider's anthropic-routed traffic keeps its exact header set.
  assert.equal(openCodeGoFixedRequestHeaders({ endpoint: 'codex-responses', providerProtocol: 'anthropic' }), null);
  assert.equal(openCodeGoFixedRequestHeaders({ endpoint: 'other-endpoint', providerProtocol: 'anthropic' }), null);
  assert.equal(openCodeGoFixedRequestHeaders({}), null);
});

/* ------------------------------------------------------------------ */
/* ProviderHttpTransport fixed-header plumbing                         */
/* ------------------------------------------------------------------ */

const NOW = '2099-01-01T00:00:00.000Z';

function transportRequest(evidence: Partial<PreparedRequestEvidenceRecord>): PreparedEvidenceTransportRequest {
  const payloadBytes = new Uint8Array([1, 2, 3]);
  const record: PreparedRequestEvidenceRecord = {
    evidenceId: 'headers-evidence',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    requestId: 'headers-request',
    attemptId: 'headers-attempt',
    attemptOrdinal: 1,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    publicModel: 'model-a',
    protocol: 'openai',
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    endpoint: OPENCODE_GO_ENDPOINT,
    upstreamId: 'upstream-opencode-go',
    accountId: 'account-opencode-go',
    credentialId: 'credential-a',
    credentialVersion: '1',
    routeTargetMode: 'platform_pool',
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    requestFingerprint: 'c'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    statementSha256: 'b'.repeat(64),
    status: 'claimed',
    claimedAt: NOW,
    claimedAttemptId: 'headers-attempt',
    expiresAt: NOW,
    ...evidence,
  };
  return {
    tenantId: record.tenantId,
    projectId: record.projectId,
    requestId: record.requestId,
    attemptId: record.attemptId,
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: record,
  };
}

interface CapturedFetch {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function headerTransport(options: {
  readonly endpoint: string;
  readonly providerProtocol: string;
  readonly providerOperation: string;
  readonly resolveFixedRequestHeaders?: boolean;
}): {
  readonly transport: ProviderHttpTransport;
  readonly captured: CapturedFetch[];
} {
  const captured: CapturedFetch[] = [];
  const transport = new ProviderHttpTransport({
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1' }),
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'secret-value' }),
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    timeoutMs: 1000,
    // Deterministic address seam: no OS DNS in tests.
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 as const }],
    fetch: async (url, init) => {
      captured.push({
        url,
        headers: Object.fromEntries(new Headers(init.headers as HeadersInit)),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    ...(options.resolveFixedRequestHeaders === false
      ? {}
      : { resolveFixedRequestHeaders: openCodeGoFixedRequestHeaders }),
  });
  return { transport, captured };
}

test('the generic transport merges the resolver headers for anthropic-routed opencode-go requests', async () => {
  const { transport, captured } = headerTransport({
    endpoint: OPENCODE_GO_ENDPOINT,
    providerProtocol: 'anthropic',
    providerOperation: 'messages',
  });
  const result = await transport.send(
    transportRequest({ providerProtocol: 'anthropic', providerOperation: 'messages' }),
  );
  assert.ok(result && typeof result === 'object');
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.headers, {
    accept: 'application/json',
    'content-type': 'application/json',
    'anthropic-version': OPENCODE_GO_ANTHROPIC_VERSION,
    authorization: 'secret-value',
  });
});

test('openai- and responses-routed opencode-go requests keep the exact previous header set', async () => {
  for (const providerProtocol of ['openai', 'responses'] as const) {
    const { transport, captured } = headerTransport({
      endpoint: OPENCODE_GO_ENDPOINT,
      providerProtocol,
      providerOperation: providerProtocol === 'openai' ? 'chat.completions' : 'responses',
    });
    await transport.send(
      transportRequest({
        providerProtocol,
        providerOperation: providerProtocol === 'openai' ? 'chat.completions' : 'responses',
      }),
    );
    assert.deepEqual(
      captured[0]?.headers,
      {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'secret-value',
      },
      providerProtocol,
    );
  }
});

test('without the resolver the transport behavior is unchanged', async () => {
  const { transport, captured } = {
    ...headerTransport({
      endpoint: OPENCODE_GO_ENDPOINT,
      providerProtocol: 'anthropic',
      providerOperation: 'messages',
      resolveFixedRequestHeaders: false,
    }),
  };
  await transport.send(transportRequest({ providerProtocol: 'anthropic', providerOperation: 'messages' }));
  assert.deepEqual(captured[0]?.headers, {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: 'secret-value',
  });
});

test('fixed headers may not override the credential or the transport-owned pair', async () => {
  const transport = new ProviderHttpTransport({
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1' }),
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'secret-value' }),
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    timeoutMs: 1000,
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 as const }],
    fetch: async () => new Response('{}', { status: 200 }),
    resolveFixedRequestHeaders: async () => ({ Authorization: 'evil', 'x-api-key': 'evil', accept: 'text/plain' }),
  });
  await assert.rejects(
    () => transport.send(transportRequest({})),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'FIXED_REQUEST_HEADERS_INVALID');
      return true;
    },
  );
});

test('malformed fixed-header records fail closed with a typed transport error', async () => {
  for (const bad of [
    { 'bad name': 'value' },
    { '': 'value' },
    { 'x-header': '' },
    { 'x-header': 'bad\r\nvalue' },
    { 'x-header': 7 },
    'not-a-record',
  ] as const) {
    const transport = new ProviderHttpTransport({
      resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1' }),
      resolveCredential: async (_input, useCredential) =>
        useCredential({ headerName: 'authorization', value: 'secret-value' }),
      endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
      timeoutMs: 1000,
      resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 as const }],
      fetch: async () => new Response('{}', { status: 200 }),
      resolveFixedRequestHeaders: async () => bad as unknown as Record<string, string>,
    });
    await assert.rejects(
      () => transport.send(transportRequest({})),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'FIXED_REQUEST_HEADERS_INVALID');
        return true;
      },
      JSON.stringify(bad),
    );
  }
});
