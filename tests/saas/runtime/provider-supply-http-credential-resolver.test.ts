import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type GenerateProviderCredentialDataKeyRequest,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { PreparedEvidenceTransportResponse } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { ProviderHttpCredentialResolveInput } from '../../../src/saas/gateway/provider-http-transport.js';
import type { ProviderCredentialUnsealingKms } from '../../../src/saas/runtime/gateway-provider-credential-kms.js';
import { GatewayProviderCredentialUnsealer } from '../../../src/saas/runtime/gateway-provider-credential-unsealer.js';
import {
  ProviderSupplyHttpCredentialResolver,
  ProviderSupplyHttpCredentialResolverError,
  type ProviderSupplyHttpAuthenticationHeader,
} from '../../../src/saas/runtime/provider-supply-http-credential-resolver.js';
import type {
  ProviderCredentialDispatchAccountSnapshot,
  ProviderCredentialDispatchBinding,
  ProviderCredentialDispatchAttempt,
  ProviderCredentialDispatchCredentialSnapshot,
  ProviderCredentialDispatchEvidence,
  ProviderCredentialDispatchProfileAccountSnapshot,
  ProviderCredentialDispatchProfileSnapshot,
  ProviderCredentialDispatchProof,
  ProviderCredentialDispatchProofReader,
  StoredProviderCredentialVersion,
} from '../../../src/saas/supply/types.js';

const NOW = new Date('2026-09-28T00:00:00.000Z');
const SECRET = 'gateway-http-provider-secret';
const SENSITIVE_KMS_ERROR = 'kms-error-must-be-redacted';
const KMS_KEY_ID = 'kms/provider-supply';
const RESPONSE: PreparedEvidenceTransportResponse = { responseStarted: false, resultHttpStatus: 204 };

const ACCOUNT = {
  ownerKind: 'tenant',
  tenantId: 'tenant-1',
  supplyMode: 'byok',
  id: 'account-1',
  providerId: 'provider-1',
  productId: 'product-1',
  credentialType: 'api-key',
  purpose: 'inference',
  status: 'active',
  validationState: 'verified',
  authzVersion: 1,
} as const satisfies ProviderCredentialDispatchAccountSnapshot;

const CREDENTIAL = {
  ownerKind: 'tenant',
  tenantId: 'tenant-1',
  supplyMode: 'byok',
  id: 'credential-1',
  accountId: 'account-1',
  providerId: 'provider-1',
  productId: 'product-1',
  status: 'active',
  validationState: 'verified',
  currentVersion: 1,
  expiresAt: null,
  authzVersion: 1,
} as const satisfies ProviderCredentialDispatchCredentialSnapshot;

function input(overrides: Partial<ProviderHttpCredentialResolveInput> = {}): ProviderHttpCredentialResolveInput {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-a',
    attemptId: 'attempt-a',
    evidenceId: 'evidence-a',
    accountId: 'account-1',
    upstreamId: 'upstream-a',
    credentialId: 'credential-1',
    credentialVersion: '1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function canonicalKmsContext(context: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

function sealingContext(): ProviderCredentialContext {
  return createProviderCredentialContext({
    deployment: 'managed-saas',
    environment: 'test',
    ownerKind: 'tenant',
    tenantId: ACCOUNT.tenantId,
    supplyMode: 'byok',
    purpose: ACCOUNT.purpose,
    providerId: ACCOUNT.providerId,
    productId: ACCOUNT.productId,
    accountId: ACCOUNT.id,
    credentialId: CREDENTIAL.id,
    credentialVersion: 1,
    credentialType: ACCOUNT.credentialType,
  });
}

class FakeCredentialKms implements ProviderCredentialKms {
  readonly decryptedOutputs: Buffer[] = [];
  private readonly entries = new Map<string, { readonly context: string; readonly key: Buffer }>();
  private sequence = 0;
  failDecrypt = false;

  async generateDataKey(request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = randomBytes(32);
    const ciphertextBlob = Buffer.from(`fake-wrapped-dek-${this.sequence++}`, 'utf8');
    this.entries.set(ciphertextBlob.toString('base64url'), {
      context: canonicalKmsContext(request.encryptionContext),
      key: Buffer.from(plaintextKey),
    });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    if (this.failDecrypt) throw new Error(`${SENSITIVE_KMS_ERROR}:${SECRET}`);
    const entry = this.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!entry || entry.context !== canonicalKmsContext(request.encryptionContext)) {
      throw new Error('fake KMS context mismatch');
    }
    const plaintextKey = Buffer.from(entry.key);
    this.decryptedOutputs.push(plaintextKey);
    return plaintextKey;
  }
}

class FakeCredentialProofRepository implements ProviderCredentialDispatchProofReader {
  readCount = 0;

  constructor(public proof: ProviderCredentialDispatchProof | null) {}

  async readDispatchProof(evidenceId: string): Promise<ProviderCredentialDispatchProof | null> {
    this.readCount += 1;
    if (this.proof?.evidence.evidenceId !== evidenceId) return null;
    return structuredClone(this.proof);
  }
}

function proofFor(
  envelope: ProviderCredentialEnvelope,
  protocol: ProviderCredentialDispatchBinding['protocol'] = 'openai',
): ProviderCredentialDispatchProof {
  const binding = {
    tenantId: ACCOUNT.tenantId,
    requestId: 'request-a',
    attemptId: 'attempt-a',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    accountId: ACCOUNT.id,
    providerId: ACCOUNT.providerId,
    productId: ACCOUNT.productId,
    protocol,
    endpoint: protocol === 'responses' ? 'responses' : protocol === 'anthropic' ? 'messages' : protocol === 'gemini' ? 'generateContent' : 'chat-completions',
    routeConfigId: 'route-a',
    routeConfigVersion: 1,
    routePublicModelId: 'public-model-a',
    routePublicModelVersion: 1,
    routeProtocol: protocol,
    routeTargetMode: 'tenant_account',
    routeUpstreamId: 'upstream-a',
    upstreamId: 'upstream-a',
    resolvedModel: 'model-a',
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: 1,
    credentialId: CREDENTIAL.id,
    credentialVersion: 1,
    credentialAuthzVersion: CREDENTIAL.authzVersion,
    accountAuthzVersion: ACCOUNT.authzVersion,
    profileAccountAuthzVersion: 1,
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
  } as const;
  const evidence: ProviderCredentialDispatchEvidence = {
    ...binding,
    evidenceId: 'evidence-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 1,
    publicModel: 'public-model-a',
    status: 'claimed',
    claimedAt: NOW.toISOString(),
    claimedAttemptId: 'attempt-a',
    dispatchDeadline: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
  };
  const attempt: ProviderCredentialDispatchAttempt = {
    ...binding,
    preparedEvidenceId: 'evidence-a',
    dispatchAuthorityState: 'bound',
    dispatchState: 'dispatching',
    resultState: 'pending',
    responseStarted: false,
  };
  const version: StoredProviderCredentialVersion = {
    ownerKind: ACCOUNT.ownerKind,
    tenantId: ACCOUNT.tenantId,
    accountId: ACCOUNT.id,
    credentialId: CREDENTIAL.id,
    version: 1,
    status: 'active',
    envelopeSchemaVersion: envelope.schemaVersion,
    contextVersion: envelope.contextVersion,
    algorithm: envelope.algorithm,
    kmsPurpose: ACCOUNT.purpose,
    wrappingRevision: 1,
    createdAt: NOW.toISOString(),
    expiresAt: null,
    retiredAt: null,
    revokedAt: null,
    kmsKeyId: envelope.kmsKeyId,
    envelope,
  };
  const profile: ProviderCredentialDispatchProfileSnapshot = {
    tenantId: ACCOUNT.tenantId,
    id: 'profile-a',
    supplyMode: 'byok',
    status: 'active',
    authzVersion: 1,
  };
  const profileAccount: ProviderCredentialDispatchProfileAccountSnapshot = {
    tenantId: ACCOUNT.tenantId,
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    accountId: ACCOUNT.id,
    providerId: ACCOUNT.providerId,
    productId: ACCOUNT.productId,
    accountAuthzVersion: ACCOUNT.authzVersion,
    status: 'active',
    authzVersion: 1,
    effectiveAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: null,
  };
  return {
    evidence,
    attempt,
    account: ACCOUNT,
    credential: CREDENTIAL,
    version,
    profile,
    profileAccount,
    pool: null,
    poolMember: null,
    poolGrant: null,
    claimAudit: {
      action: 'saas_prepared_request_evidence.claimed',
      targetType: 'saas_prepared_request_evidence',
      targetId: 'evidence-a',
    },
  };
}

interface ResolverFixture {
  readonly repository: FakeCredentialProofRepository;
  readonly kms: FakeCredentialKms;
  readonly resolver: ProviderSupplyHttpCredentialResolver;
  readonly unsealer: Pick<GatewayProviderCredentialUnsealer, 'withCredential'>;
  readonly plaintexts: Buffer[];
}

async function fixture(options: {
  authentication?: ProviderSupplyHttpAuthenticationHeader;
  secret?: Uint8Array;
  protocol?: ProviderCredentialDispatchBinding['protocol'];
} = {}): Promise<ResolverFixture> {
  const kms = new FakeCredentialKms();
  const plaintext = options.secret === undefined ? Buffer.from(SECRET) : Buffer.from(options.secret);
  let envelope: ProviderCredentialEnvelope;
  try {
    envelope = await sealProviderCredential(plaintext, sealingContext(), kms, KMS_KEY_ID);
  } finally {
    plaintext.fill(0);
  }
  const repository = new FakeCredentialProofRepository(proofFor(envelope, options.protocol));
  const gatewayKms: ProviderCredentialUnsealingKms = {
    decryptDataKey: (request) => kms.decryptDataKey(request),
    checkReady: async () => undefined,
    close: async () => undefined,
  };
  const realUnsealer = new GatewayProviderCredentialUnsealer(gatewayKms, {
    deployment: 'managed-saas',
    environment: 'test',
  });
  const plaintexts: Buffer[] = [];
  const unsealer: Pick<GatewayProviderCredentialUnsealer, 'withCredential'> = {
    withCredential: (request, callback) => realUnsealer.withCredential(request, (secret) => {
      plaintexts.push(secret);
      return callback(secret);
    }),
  };
  const resolver = new ProviderSupplyHttpCredentialResolver({
    proofReader: repository,
    unsealer,
    resolveAuthenticationHeader: async () => options.authentication ?? 'authorization',
    now: () => NOW,
  });
  return { repository, kms, resolver, unsealer, plaintexts };
}

function assertUnavailable(error: unknown): boolean {
  assert.ok(error instanceof ProviderSupplyHttpCredentialResolverError);
  assert.equal(error.code, 'CREDENTIAL_UNAVAILABLE');
  assert.equal(error.message.includes(SECRET), false);
  assert.equal(error.message.includes(SENSITIVE_KMS_ERROR), false);
  assert.equal(String(error).includes(SECRET), false);
  assert.equal(String(error).includes(SENSITIVE_KMS_ERROR), false);
  return true;
}

test('reads the database proof and passes its ephemeral plaintext through provider header injection', async () => {
  const { repository, kms, resolver } = await fixture();
  let receivedValue: Uint8Array | undefined;
  const response = await resolver.resolveCredential(input(), async (providerCredential) => {
    receivedValue = providerCredential.value instanceof Uint8Array ? providerCredential.value : undefined;
    assert.equal(providerCredential.headerName, 'authorization');
    assert.ok(Buffer.isBuffer(providerCredential.value));
    assert.equal(Buffer.from(providerCredential.value).toString('utf8'), `Bearer ${SECRET}`);
    return RESPONSE;
  });

  assert.deepEqual(response, RESPONSE);
  assert.equal(repository.proof?.evidence.evidenceId, 'evidence-a');
  assert.equal(repository.readCount, 1);
  assert.ok(receivedValue instanceof Buffer);
  assert.deepEqual(receivedValue, Buffer.alloc(receivedValue.length));
  assert.equal(JSON.stringify(response).includes(SECRET), false);
  assert.equal(kms.decryptedOutputs.length, 1);
  assert.deepEqual(kms.decryptedOutputs[0], Buffer.alloc(32));
});

test('rejects another evidence id, account, and stale credential version before gateway KMS unsealing', async () => {
  const { repository, kms, resolver } = await fixture();
  let callbackCalls = 0;

  await assert.rejects(
    resolver.resolveCredential(input({ evidenceId: 'evidence-from-another-attempt' }), async () => {
      callbackCalls += 1;
      return RESPONSE;
    }),
    assertUnavailable,
  );

  await assert.rejects(
    resolver.resolveCredential(input({ accountId: 'different-account' }), async () => {
      callbackCalls += 1;
      return RESPONSE;
    }),
    assertUnavailable,
  );

  await assert.rejects(
    resolver.resolveCredential(input({ credentialVersion: '2' }), async () => {
      callbackCalls += 1;
      return RESPONSE;
    }),
    assertUnavailable,
  );

  const proof = repository.proof as ProviderCredentialDispatchProof;
  repository.proof = {
    ...proof,
    credential: { ...proof.credential, currentVersion: 2 },
  };
  await assert.rejects(
    resolver.resolveCredential(input(), async () => {
      callbackCalls += 1;
      return RESPONSE;
    }),
    assertUnavailable,
  );

  assert.equal(callbackCalls, 0);
  assert.equal(kms.decryptedOutputs.length, 0);
});

test('rejects revoked account, credential, and credential version before gateway KMS unsealing', async () => {
  const { repository, kms, resolver } = await fixture();
  const proof = repository.proof as ProviderCredentialDispatchProof;

  repository.proof = {
    ...proof,
    account: { ...proof.account, status: 'revoked' },
  };
  await assert.rejects(
    resolver.resolveCredential(input(), async () => RESPONSE),
    assertUnavailable,
  );

  repository.proof = {
    ...proof,
    credential: { ...proof.credential, status: 'revoked' },
  };
  await assert.rejects(
    resolver.resolveCredential(input(), async () => RESPONSE),
    assertUnavailable,
  );

  repository.proof = {
    ...proof,
    version: { ...proof.version, status: 'revoked', revokedAt: NOW.toISOString() },
  };
  await assert.rejects(
    resolver.resolveCredential(input(), async () => RESPONSE),
    assertUnavailable,
  );

  assert.equal(kms.decryptedOutputs.length, 0);
});

test('zeroizes plaintext on callback throw and redacts callback, KMS, and envelope data from errors', async () => {
  const { repository, kms, resolver, plaintexts } = await fixture();
  const ciphertextSentinel = repository.proof?.version.envelope.ciphertext ?? '';
  let callbackBuffer: Buffer | undefined;

  await assert.rejects(
    resolver.resolveCredential(input(), async (providerCredential) => {
      callbackBuffer = providerCredential.value as Buffer;
      throw new Error(`${SECRET}:${ciphertextSentinel}`);
    }),
    (error: unknown) => {
      assertUnavailable(error);
      assert.equal((error as Error).message.includes(ciphertextSentinel), false);
      assert.equal(String(error).includes(ciphertextSentinel), false);
      return true;
    },
  );
  assert.ok(callbackBuffer);
  assert.deepEqual(callbackBuffer, Buffer.alloc(callbackBuffer.length));
  assert.deepEqual(kms.decryptedOutputs[0], Buffer.alloc(32));
  assertCleared(plaintexts);

  kms.failDecrypt = true;
  await assert.rejects(
    resolver.resolveCredential(input(), async () => {
      throw new Error('must not be called');
    }),
    assertUnavailable,
  );
});

test('validates the server-owned header before proof lookup and preserves header allowlisting', async () => {
  const { repository, kms } = await fixture();
  const resolver = new ProviderSupplyHttpCredentialResolver({
    proofReader: repository,
    unsealer: new GatewayProviderCredentialUnsealer(
      {
        decryptDataKey: (request) => kms.decryptDataKey(request),
        checkReady: async () => undefined,
        close: async () => undefined,
      },
      { deployment: 'managed-saas', environment: 'test' },
    ),
    resolveAuthenticationHeader: async () => 'x-forwarded-for',
    now: () => NOW,
  });

  await assert.rejects(
    resolver.resolveCredential(input(), async () => RESPONSE),
    (error: unknown) =>
      error instanceof ProviderSupplyHttpCredentialResolverError && error.code === 'CREDENTIAL_INVALID',
  );
  assert.equal(repository.readCount, 0);
  assert.equal(kms.decryptedOutputs.length, 0);
});

test('rejects an invalid provider callback response and still clears its plaintext', async () => {
  const { kms, resolver, plaintexts } = await fixture();
  let callbackBuffer: Buffer | undefined;

  await assert.rejects(
    resolver.resolveCredential(input(), async (providerCredential) => {
      callbackBuffer = providerCredential.value as Buffer;
      return undefined as never;
    }),
    (error: unknown) =>
      error instanceof ProviderSupplyHttpCredentialResolverError && error.code === 'CREDENTIAL_INVALID',
  );
  assert.ok(callbackBuffer);
  assert.deepEqual(callbackBuffer, Buffer.alloc(callbackBuffer.length));
  assert.deepEqual(kms.decryptedOutputs[0], Buffer.alloc(32));
  assertCleared(plaintexts);
});

test('redacts repository errors and never returns credential contents in resolver output', async () => {
  const { kms } = await fixture();
  const resolver = new ProviderSupplyHttpCredentialResolver({
    proofReader: {
      async readDispatchProof() {
        throw new Error(`${SENSITIVE_KMS_ERROR}:${SECRET}`);
      },
    },
    unsealer: new GatewayProviderCredentialUnsealer(
      {
        decryptDataKey: (request) => kms.decryptDataKey(request),
        checkReady: async () => undefined,
        close: async () => undefined,
      },
      { deployment: 'managed-saas', environment: 'test' },
    ),
    resolveAuthenticationHeader: async () => 'authorization',
    now: () => NOW,
  });

  await assert.rejects(
    resolver.resolveCredential(input(), async () => RESPONSE),
    assertUnavailable,
  );
});

function assertCleared(buffers: readonly Uint8Array[]): void {
  for (const buffer of buffers) assert.equal(buffer.every((byte) => byte === 0), true, 'ephemeral bytes must be cleared');
}

function isInvalidCredential(error: unknown): boolean {
  assert.ok(error instanceof ProviderSupplyHttpCredentialResolverError);
  assert.equal(error.code, 'CREDENTIAL_INVALID');
  assert.equal(String(error).includes(SECRET), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

test('deployment-owned native authentication formats do not infer the client protocol', { timeout: 5000 }, async (t) => {
  const cases = [
    { name: 'OpenAI Chat default bearer', protocol: 'openai', authentication: 'authorization', expected: `Bearer ${SECRET}` },
    { name: 'OpenAI Responses default bearer', protocol: 'responses', authentication: { headerName: 'authorization' }, expected: `Bearer ${SECRET}` },
    { name: 'explicit OpenAI bearer', protocol: 'openai', authentication: { headerName: 'authorization', valueFormat: 'bearer' }, expected: `Bearer ${SECRET}` },
    { name: 'Anthropic Messages raw API key', protocol: 'anthropic', authentication: 'x-api-key', expected: SECRET },
    { name: 'OpenAI client bridged to Anthropic raw API key', protocol: 'openai', authentication: { headerName: 'x-api-key' }, expected: SECRET },
    { name: 'Anthropic client bridged to OpenAI bearer', protocol: 'anthropic', authentication: 'authorization', expected: `Bearer ${SECRET}` },
    { name: 'other API-key header defaults raw', protocol: 'openai', authentication: 'api-key', expected: SECRET },
    { name: 'Google API-key header defaults raw', protocol: 'gemini', authentication: 'x-goog-api-key', expected: SECRET },
  ] as const;
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = await fixture({ protocol: scenario.protocol, authentication: scenario.authentication });
    let injected: Uint8Array | undefined;
    const response = await f.resolver.resolveCredential(input(), async (credential) => {
      assert.ok(credential.value instanceof Uint8Array);
      injected = credential.value;
      assert.equal(Buffer.from(credential.value).toString('utf8') === scenario.expected, true);
      return RESPONSE;
    });
    assert.deepEqual(response, RESPONSE);
    assert.ok(injected);
    assert.equal(f.repository.readCount, 1);
    assert.equal(f.kms.decryptedOutputs.length, 1);
    assertCleared([injected, ...f.plaintexts, ...f.kms.decryptedOutputs]);
  });
});

test('explicit raw preserves stored complete header values without guessing or stripping a prefix', { timeout: 5000 }, async () => {
  const stored = Buffer.from(`Bearer ${SECRET}`);
  for (const authentication of [
    { headerName: 'authorization', valueFormat: 'raw' },
    { headerName: 'authorization', valueFormat: 'bearer' },
  ] as const) {
    const f = await fixture({ secret: stored, authentication });
    await f.resolver.resolveCredential(input(), async (credential) => {
      assert.ok(credential.value instanceof Uint8Array);
      const expected = authentication.valueFormat === 'raw' ? stored : Buffer.concat([Buffer.from('Bearer '), stored]);
      try { assert.equal(Buffer.from(credential.value).equals(expected), true); }
      finally { if (expected !== stored) expected.fill(0); }
      return RESPONSE;
    });
    assertCleared([...f.plaintexts, ...f.kms.decryptedOutputs]);
  }
  stored.fill(0);
});

test('invalid deployment format/header policies fail before proof, KMS, or injection', { timeout: 5000 }, async (t) => {
  const invalid: readonly unknown[] = [
    'x-forwarded-for', 'authorization\r\n',
    { headerName: 'authorization', valueFormat: 'basic' },
    { headerName: 'authorization', valueFormat: 'Bearer' },
    { headerName: 'authorization', valueFormat: null },
    { headerName: 'x-api-key', valueFormat: 'bearer' },
    { headerName: 'authorization', valueFormat: 'raw', prefix: 'Bearer ' },
    { headerName: 'authorization', scheme: 'Bearer' },
    { get headerName() { throw new Error(SECRET); } },
  ];
  for (let index = 0; index < invalid.length; index += 1) await t.test(`invalid policy ${index}`, async () => {
    const f = await fixture();
    // Deliberate untyped trusted-module return boundary, not a wider public DTO.
    const candidate: unknown = Reflect.construct(ProviderSupplyHttpCredentialResolver, [{
      proofReader: f.repository, unsealer: f.unsealer,
      resolveAuthenticationHeader: () => invalid[index], now: () => NOW,
    }]);
    assert.ok(candidate instanceof ProviderSupplyHttpCredentialResolver);
    let calls = 0;
    await assert.rejects(candidate.resolveCredential(input(), async () => { calls += 1; return RESPONSE; }), isInvalidCredential);
    assert.equal(calls, 0);
    assert.equal(f.repository.readCount, 0);
    assert.equal(f.kms.decryptedOutputs.length, 0);
  });
});

test('malformed or oversized plaintext never reaches injection and is cleared', { timeout: 5000 }, async (t) => {
  const cases = [
    { name: 'invalid UTF-8', secret: Buffer.from([0xc3, 0x28]), authentication: 'authorization' },
    { name: 'CRLF', secret: Buffer.from('token\r\nsecond-header'), authentication: 'authorization' },
    { name: 'NUL', secret: Buffer.from('token\0'), authentication: 'x-api-key' },
    { name: 'DEL', secret: Buffer.from([0x61, 0x7f]), authentication: 'x-api-key' },
    { name: 'bearer prefix exceeds cap', secret: Buffer.alloc(16 * 1024 - 6, 0x61), authentication: 'authorization' },
    { name: 'raw exceeds cap', secret: Buffer.alloc(16 * 1024 + 1, 0x61), authentication: 'x-api-key' },
  ] as const;
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = await fixture(scenario);
    let calls = 0;
    await assert.rejects(f.resolver.resolveCredential(input(), async () => { calls += 1; return RESPONSE; }), isInvalidCredential);
    assert.equal(calls, 0);
    assert.equal(f.plaintexts.length, 1);
    assertCleared([...f.plaintexts, ...f.kms.decryptedOutputs]);
    scenario.secret.fill(0);
  });
  await t.test('empty unsealer output', async () => {
    const f = await fixture();
    const secret = Buffer.alloc(0);
    const resolver = new ProviderSupplyHttpCredentialResolver({
      proofReader: f.repository, now: () => NOW, resolveAuthenticationHeader: () => 'authorization',
      unsealer: { withCredential: async (_binding, callback) => callback(secret) },
    });
    let calls = 0;
    await assert.rejects(resolver.resolveCredential(input(), async () => { calls += 1; return RESPONSE; }), isInvalidCredential);
    assert.equal(calls, 0);
    assertCleared([secret]);
  });
});

test('the 16KiB credential cap includes the fixed prefix and preserves the raw boundary', { timeout: 5000 }, async () => {
  for (const authentication of ['authorization', 'x-api-key']) {
    const secret = Buffer.alloc(16 * 1024 - (authentication === 'authorization' ? 7 : 0), 0x61);
    const f = await fixture({ authentication, secret });
    let injected: Uint8Array | undefined;
    await f.resolver.resolveCredential(input(), async (credential) => {
      assert.ok(credential.value instanceof Uint8Array);
      injected = credential.value;
      assert.equal(credential.value.byteLength, 16 * 1024);
      return RESPONSE;
    });
    assert.ok(injected);
    assertCleared([injected, ...f.plaintexts, ...f.kms.decryptedOutputs]);
    secret.fill(0);
  }
});

test('duplicate callbacks, including swallowed concurrent failures, never inject twice', { timeout: 5000 }, async (t) => {
  for (const concurrent of [false, true]) await t.test(concurrent ? 'concurrent' : 'sequential', async () => {
    const f = await fixture();
    const first = Buffer.from(SECRET);
    const second = Buffer.from(SECRET);
    const resolver = new ProviderSupplyHttpCredentialResolver({
      proofReader: f.repository, now: () => NOW, resolveAuthenticationHeader: () => 'authorization',
      unsealer: {
        async withCredential(_binding, callback) {
          const pending = Promise.resolve(callback(first));
          if (!concurrent) await pending;
          await assert.rejects(Promise.resolve(callback(second)), isInvalidCredential);
          return await pending;
        },
      },
    });
    let calls = 0;
    let formatted: Uint8Array | undefined;
    await assert.rejects(resolver.resolveCredential(input(), async (credential) => {
      calls += 1;
      assert.ok(credential.value instanceof Uint8Array);
      formatted = credential.value;
      return RESPONSE;
    }), isInvalidCredential);
    assert.equal(calls, 1);
    assert.ok(formatted);
    assertCleared([first, second, formatted]);
  });
});

test('late callbacks after unsealer completion cannot dispatch and their plaintext is cleared', { timeout: 5000 }, async () => {
  const f = await fixture();
  let late: ((secret: Buffer) => Promise<unknown>) | undefined;
  const resolver = new ProviderSupplyHttpCredentialResolver({
    proofReader: f.repository, now: () => NOW, resolveAuthenticationHeader: () => 'authorization',
    unsealer: {
      async withCredential(_binding, callback) {
        late = async (secret) => callback(secret);
        throw new Error('completed without invoking callback');
      },
    },
  });
  let calls = 0;
  await assert.rejects(resolver.resolveCredential(input(), async () => { calls += 1; return RESPONSE; }), assertUnavailable);
  assert.ok(late);
  const secret = Buffer.from(SECRET);
  await assert.rejects(late(secret), isInvalidCredential);
  assert.equal(calls, 0);
  assertCleared([secret]);
});

test('abort boundaries prevent new injection without pretending to cancel KMS', { timeout: 5000 }, async (t) => {
  for (const boundary of ['before policy', 'after policy', 'after proof', 'after KMS', 'during injection'] as const) {
    await t.test(boundary, async () => {
      const f = await fixture();
      const controller = new AbortController();
      let injected: Uint8Array | undefined;
      let calls = 0;
      const resolver = new ProviderSupplyHttpCredentialResolver({
        proofReader: {
          async readDispatchProof(id) {
            const proof = await f.repository.readDispatchProof(id);
            if (boundary === 'after proof') controller.abort();
            return proof;
          },
        },
        unsealer: {
          withCredential: (binding, callback) => f.unsealer.withCredential(binding, (secret) => {
            if (boundary === 'after KMS') controller.abort();
            return callback(secret);
          }),
        },
        resolveAuthenticationHeader: () => {
          if (boundary === 'after policy') controller.abort();
          return 'authorization';
        },
        now: () => NOW,
      });
      if (boundary === 'before policy') controller.abort();
      await assert.rejects(resolver.resolveCredential(input({ signal: controller.signal }), async (credential) => {
        calls += 1;
        assert.ok(credential.value instanceof Uint8Array);
        injected = credential.value;
        controller.abort();
        return RESPONSE;
      }), assertUnavailable);
      assert.equal(calls, boundary === 'during injection' ? 1 : 0);
      assert.equal(f.kms.decryptedOutputs.length, boundary === 'after KMS' || boundary === 'during injection' ? 1 : 0);
      assertCleared([...f.plaintexts, ...f.kms.decryptedOutputs, ...(injected === undefined ? [] : [injected])]);
    });
  }
});
