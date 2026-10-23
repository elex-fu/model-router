import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import type { PreparedEvidenceTransportRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { createBuiltinProviderEvidenceTransportFactory } from '../../../src/saas/runtime/builtin-provider-transports.js';
import type { ProviderCredentialDispatchProof } from '../../../src/saas/supply/types.js';

function fixture(kind: 'claude' | 'codex' = 'claude') {
  const providerId = kind === 'codex' ? 'openai-codex' : 'anthropic-claude';
  const productId = kind === 'codex' ? 'codex-chatgpt' : 'claude-subscription';
  const protocol = kind === 'codex' ? 'responses' : 'anthropic';
  const endpoint = kind === 'codex' ? 'codex-responses' : 'claude-messages';
  const owner = { ownerKind: 'tenant', tenantId: 'tenant-a', supplyMode: 'byok' };
  const binding = {
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    accountId: 'account-a',
    providerId,
    productId,
    protocol,
    endpoint,
    routeConfigId: 'route-a',
    routeConfigVersion: 1,
    routePublicModelId: 'model-a',
    routePublicModelVersion: 1,
    routeProtocol: protocol,
    routeTargetMode: 'tenant_account',
    routeUpstreamId: 'upstream-a',
    upstreamId: 'upstream-a',
    resolvedModel: 'model-a',
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: 1,
    credentialId: 'credential-a',
    credentialVersion: 1,
    credentialAuthzVersion: 1,
    accountAuthzVersion: 1,
    profileAccountAuthzVersion: 1,
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
  };
  const proof = {
    evidence: {
      ...binding,
      evidenceId: 'evidence-a',
      supplyProfileId: 'profile-a',
      supplyProfileVersion: 1,
      publicModel: 'model-a',
      status: 'claimed',
      claimedAt: new Date().toISOString(),
      claimedAttemptId: 'attempt-a',
      dispatchDeadline: new Date(Date.now() + 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
    attempt: {
      ...binding,
      preparedEvidenceId: 'evidence-a',
      dispatchAuthorityState: 'bound',
      dispatchState: 'dispatching',
      resultState: 'pending',
      responseStarted: false,
    },
    account: {
      ...owner,
      id: 'account-a',
      providerId,
      productId,
      credentialType: 'oauth',
      purpose: 'inference',
      status: 'active',
      validationState: 'verified',
      authzVersion: 1,
    },
    credential: {
      ...owner,
      id: 'credential-a',
      accountId: 'account-a',
      providerId,
      productId,
      status: 'active',
      validationState: 'verified',
      currentVersion: 1,
      expiresAt: null,
      authzVersion: 1,
    },
    version: {
      ownerKind: 'tenant',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      credentialId: 'credential-a',
      version: 1,
      status: 'active',
      envelopeSchemaVersion: 1,
      contextVersion: 1,
      algorithm: 'aes-256-gcm',
      kmsPurpose: 'inference',
      wrappingRevision: 1,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      retiredAt: null,
      revokedAt: null,
      kmsKeyId: 'test-kms',
      envelope: { schemaVersion: 1, contextVersion: 1, algorithm: 'aes-256-gcm', kmsKeyId: 'test-kms' },
    },
    profile: { tenantId: 'tenant-a', id: 'profile-a', supplyMode: 'byok', status: 'active', authzVersion: 1 },
    profileAccount: {
      tenantId: 'tenant-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      accountId: 'account-a',
      providerId,
      productId,
      accountAuthzVersion: 1,
      status: 'active',
      authzVersion: 1,
      effectiveAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: null,
    },
    pool: null,
    poolMember: null,
    poolGrant: null,
    claimAudit: {
      action: 'saas_prepared_request_evidence.claimed',
      targetType: 'saas_prepared_request_evidence',
      targetId: 'evidence-a',
    },
  } as unknown as ProviderCredentialDispatchProof;
  const body = Buffer.from(
    JSON.stringify(kind === 'codex' ? { model: 'model-a', input: [], instructions: 'Test instructions', stream: true, store: false } : { model: 'model-a', messages: [{ role: 'user', content: 'Test' }], max_tokens: 1, stream: true }),
  );
  const request = {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
    fencingToken: 'fence-a',
    signal: new AbortController().signal,
    payloadBytes: body,
    evidence: {
      evidenceId: 'evidence-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      requestId: 'request-a',
      attemptId: 'attempt-a',
      attemptOrdinal: 1,
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      publicModel: 'model-a',
      protocol,
      resolvedModel: 'model-a',
      clientProtocol: protocol,
      providerProtocol: protocol,
      clientOperation: kind === 'codex' ? 'responses' : 'messages',
      providerOperation: kind === 'codex' ? 'responses' : 'messages',
      endpoint,
      upstreamId: 'upstream-a',
      accountId: 'account-a',
      credentialId: 'credential-a',
      credentialVersion: '1',
      routeTargetMode: 'tenant_account',
      payloadSha256: createHash('sha256').update(body).digest('hex'),
      statementSha256: randomBytes(32).toString('hex'),
      status: 'claimed',
      claimedAt: new Date().toISOString(),
      claimedAttemptId: 'attempt-a',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  } as PreparedEvidenceTransportRequest;
  const database = {
    query: async () => ({ rows: [{ proxy_key_id: 'key-a' }], rowCount: 1 }),
    transaction: async () => undefined,
  } as unknown as SaasDatabase;
  const accessToken = randomBytes(24).toString('hex');
  const plaintext = Buffer.from(
    JSON.stringify({
      access_token: accessToken,
      organization_uuid: '00000000-0000-4000-8000-000000000001',
      account_uuid: '00000000-0000-4000-8000-000000000002',
      chatgpt_account_id: 'upstream-account-a',
      chatgpt_user_id: 'upstream-user-a',
    }),
  );
  return { proof, request, database, accessToken, plaintext };
}

test('built-in native dispatch preserves account egress/TLS and closes its connector after the body drains', async () => {
  const f = fixture();
  let closed = 0;
  let sent = 0;
  let connectorInput: unknown;
  const buffers: Uint8Array[] = [];
  const factory = createBuiltinProviderEvidenceTransportFactory({
    database: f.database,
    providerBundles: [{ bundle: 'anthropic-claude', enabled: true }],
    timeoutMs: 1000,
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${f.accessToken}`);
      sent++;
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const transports = factory.factory({
    genericTransport: {
      async send() {
        throw new Error('wrong generic fallback');
      },
    },
    proofReader: {
      async readDispatchProof() {
        return structuredClone(f.proof);
      },
    },
    unsealer: {
      async withCredential(_input, use) {
        const secret = Buffer.from(f.plaintext);
        buffers.push(secret);
        await use(secret);
      },
    },
    resolveEgressProfile: async (input) => {
      assert.equal(input.accountId, 'account-a');
      assert.equal(input.tenantId, 'tenant-a');
      return { egressProxy: { url: 'http://proxy.example:8080' }, tlsFingerprint: { selector: 'default' } };
    },
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    createConnector(input) {
      connectorInput = input;
      return {
        dispatcher: {} as never,
        async close() {
          closed++;
        },
        async destroy() {
          closed++;
        },
      };
    },
  });
  try {
    const response = await transports.claudeEvidenceTransport?.send(f.request);
    assert.ok(response?.body);
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
    assert.equal(sent, 1);
    assert.equal((connectorInput as { proxy: { hostname: string } }).proxy.hostname, 'proxy.example');
    assert.deepEqual((connectorInput as { tlsFingerprint: unknown }).tlsFingerprint, { selector: 'default' });
    assert.equal(closed, 1);
    assert.ok(buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  } finally {
    factory.close();
    f.plaintext.fill(0);
  }
});

test('a revoked proof and an unavailable account proxy fail before any provider fetch', async () => {
  for (const fault of ['revoked-proof', 'proxy-unavailable'] as const) {
    const f = fixture();
    let unsealed = 0;
    let sent = 0;
    if (fault === 'revoked-proof') (f.proof.account as { status: string }).status = 'revoked';
    const factory = createBuiltinProviderEvidenceTransportFactory({
      database: f.database,
      providerBundles: [{ bundle: 'anthropic-claude', enabled: true }],
      timeoutMs: 1000,
      fetch: async () => {
        sent++;
        return new Response();
      },
    });
    const transport = factory.factory({
      genericTransport: {
        async send() {
          throw new Error('wrong fallback');
        },
      },
      proofReader: {
        async readDispatchProof() {
          return structuredClone(f.proof);
        },
      },
      unsealer: {
        async withCredential(_input, use) {
          unsealed++;
          await use(Buffer.from(f.plaintext));
        },
      },
      resolveEgressProfile: async () => {
        throw new Error('proxy read failed');
      },
    }).claudeEvidenceTransport;
    try {
      await assert.rejects(transport?.send(f.request) as Promise<unknown>);
      assert.equal(sent, 0);
      assert.equal(unsealed, fault === 'revoked-proof' ? 0 : 1);
    } finally {
      factory.close();
      f.plaintext.fill(0);
    }
  }
});

test('Codex missing reviewed trusted-bound evidence is rejected before credential unseal or egress', async () => {
  const f = fixture('codex');
  let unsealed = 0;
  let sent = 0;
  const factory = createBuiltinProviderEvidenceTransportFactory({ database: f.database, providerBundles: [{ bundle: 'openai-codex', enabled: true }], timeoutMs: 1000, fetch: async () => { sent++; return new Response(); } });
  const transport = factory.factory({
    genericTransport: { async send() { throw new Error('wrong fallback'); } },
    proofReader: { async readDispatchProof() { return structuredClone(f.proof); } },
    unsealer: { async withCredential(_input, use) { unsealed++; await use(Buffer.from(f.plaintext)); } },
    resolveEgressProfile: async () => { throw new Error('must not resolve egress without financial evidence'); },
  }).codexEvidenceTransport;
  try {
    assert.ok(transport);
    await assert.rejects(transport.send(f.request));
    assert.equal(unsealed, 0);
    assert.equal(sent, 0);
  } finally { factory.close(); f.plaintext.fill(0); }
});
