import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  authorizeFastGatewaySnapshot,
  CachedFastGatewaySnapshots,
  type FastGatewaySnapshot,
  type FastGatewaySnapshotCacheStore,
  FastGatewaySnapshotError,
  type FastGatewaySnapshotInput,
  type FastGatewaySnapshotMetric,
  fastGatewaySnapshotCacheKey,
} from '../../../../src/saas/gateway/fast/snapshots.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';
import { fastExecutorFixture } from './executor-fixture.js';

function fixture(
  tenant = 'tenant-a',
  observedAtMs = 100_000,
): { input: FastGatewaySnapshotInput; snapshot: FastGatewaySnapshot } {
  const authorization: AuthenticatedApiKey['authorization'] = {
    keyId: 'key-a',
    tenantId: tenant,
    projectId: 'project-a',
    principalKind: 'member',
    principalId: 'user-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    modelScopes: ['model-a'],
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementAuthzVersion: 1,
    supplyProfileAuthzVersion: 1,
  };
  const authenticatedCaller: AuthenticatedApiKey = {
    authorization,
    metadata: {
      id: 'key-a',
      tenantId: tenant,
      projectId: 'project-a',
      principalUserId: 'user-a',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-a',
      createdByUserId: 'user-a',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      name: 'fixture',
      prefix: 'fixture',
      modelScopes: ['model-a'],
      status: 'active',
      createdAt: new Date(1).toISOString(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
  const input: FastGatewaySnapshotInput = {
    authenticatedCaller,
    publicModel: 'model-a',
    protocol: 'openai',
    clientOperation: 'chat.completions',
    clientAddress: { status: 'resolved', address: '192.0.2.1', source: 'socket-peer' },
    inputByteLength: 100,
  };
  const caller: FastGatewaySnapshot['caller'] = {
    tenantId: tenant,
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'user-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    modelScopes: ['model-a'],
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
  };
  const authority: FastGatewaySnapshot['authority'] = {
    route: {
      tenantId: tenant,
      projectId: 'project-a',
      publicModel: 'model-a',
      publicModelId: 'model-id',
      publicModelVersion: 1,
      routeConfigId: 'route-a',
      routeConfigVersion: 1,
      protocol: 'openai',
      clientOperation: 'chat.completions',
      targetMode: 'tenant_account',
      upstreamId: 'upstream-a',
      endpoint: 'chat.completions',
    },
    candidate: {
      tenantId: tenant,
      projectId: 'project-a',
      proxyKeyId: 'key-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      upstreamId: 'upstream-a',
      accountId: 'account-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
      credentialAuthzVersion: 1,
      accountAuthzVersion: 1,
      dispatchProfileId: 'dispatch-a',
      supplyProfileAuthzVersion: 1,
      resolvedModel: 'model-a',
      protocol: 'openai',
      endpoint: 'chat.completions',
      supplierCostVersion: null,
      profileAccountAuthzVersion: 1,
      providerId: 'provider-a',
      productId: 'product-a',
    },
    poolMemberAuthzVersion: null,
    credentialRef: 'credential-a',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-a',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-a',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-a',
      customerPriceVersion: null,
      supplierCostVersion: null,
    },
  };
  const scope = {
    ownerKind: 'tenant' as const,
    tenantId: tenant,
    supplyMode: 'byok' as const,
    providerId: 'provider-a',
    productId: 'product-a',
  };
  const snapshot: FastGatewaySnapshot = {
    caller,
    entitlement: {
      tenantId: tenant,
      projectId: 'project-a',
      proxyKeyId: 'key-a',
      entitlementId: 'entitlement-a',
      entitlementVersion: 1,
      supplyProfileId: 'profile-a',
      supplyProfileVersion: 1,
      supplyMode: 'byok',
      modelScopeVersion: 1,
      allowedModels: ['model-a'],
      allowedProviderIds: ['provider-a'],
      projectPolicyVersion: 1,
    },
    authority,
    candidates: [
      {
        authority: authority.candidate,
        customerPrice: null,
        supplierCost: null,
        limits: { rpm: null, tpm: null, concurrency: 16 },
        credential: {
          account: { ...scope, id: 'account-a', credentialType: 'api-key', purpose: 'inference' },
          credential: { ...scope, id: 'credential-a', accountId: 'account-a' },
          version: {
            ownerKind: 'tenant',
            tenantId: tenant,
            accountId: 'account-a',
            credentialId: 'credential-a',
            version: 1,
            status: 'active',
            envelopeSchemaVersion: 1,
            contextVersion: 1,
            algorithm: 'aes-256-gcm',
            kmsPurpose: 'inference',
            wrappingRevision: 1,
            createdAt: new Date(1).toISOString(),
            expiresAt: null,
            retiredAt: null,
            revokedAt: null,
            kmsKeyId: 'kms-a',
            envelope: {
              schemaVersion: 1,
              contextVersion: 1,
              algorithm: 'aes-256-gcm',
              kmsKeyId: 'kms-a',
              wrappedDek: randomBytes(32).toString('base64url'),
              nonce: randomBytes(12).toString('base64url'),
              ciphertext: randomBytes(40).toString('base64url'),
              authTag: randomBytes(16).toString('base64url'),
            },
          },
        },
      },
    ],
    observedAtMs,
    validUntilMs: observedAtMs + 5000,
    revision: 'revision-a',
    policy: {
      keyStatus: 'active',
      tenantStatus: 'active',
      projectStatus: 'active',
      principalStatus: 'active',
      groupStatus: null,
      spendingFrozen: false,
      ipPolicy: { mode: 'disabled', rules: [] },
      maxBodyBytes: 1024,
      absoluteExpiryMs: [],
    },
    limits: {
      tenant: { rpm: 1000, tpm: 10000, concurrency: 16 },
      project: { rpm: 1000, tpm: 10000, concurrency: 16 },
      key: { rpm: 1000, tpm: 10000, concurrency: 16 },
      group: null,
    },
  };
  return { input, snapshot };
}
function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof FastGatewaySnapshotError && error.code === code;
}
function replace(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, configurable: true, writable: true });
}
async function ownedFixture() {
  const { input, snapshot } = fixture();
  const cache = new CachedFastGatewaySnapshots(
    { resolve: async () => snapshot },
    { wallNow: () => 100_000, monotonicNow: () => 0 },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  return { input, held, cache };
}

test('warm lookup crossing handoff headroom joins one fresh load without renewing the old lease', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let loads = 0;
  let crossed = false;
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        if (++loads > 1) await barrier;
        return { ...snapshot, observedAtMs: clock.wall, validUntilMs: clock.wall + 5000 };
      },
    },
    {
      minimumValidityMs: 1000,
      refreshAheadMs: 1500,
      maxEntries: 1,
      wallNow: () => clock.wall,
      monotonicNow: () => clock.mono,
      observe(metric) {
        // A deterministic 2ms pause after the first usable check, still 999ms
        // before the immutable authority lease expires. No storage failed.
        if (metric === 'l1_hit' && !crossed) {
          crossed = true;
          clock.wall += 2;
          clock.mono += 2;
        }
      },
    },
  );
  const old = await cache.resolve(input);
  assert.ok(old);
  clock.wall += 3999;
  clock.mono += 3999;
  let returned = 0;
  const pending = Array.from({ length: 64 }, () =>
    cache.resolve(input).then((value) => {
      returned++;
      return value;
    }),
  );
  await Promise.resolve();
  assert.equal(returned, 0, 'no waiter receives the insufficient-headroom old object');
  assert.equal(loads, 2, 'join the single refresh; never issue a blanket retry');
  finish();
  const values = await Promise.all(pending);
  const current = values[0];
  assert.ok(current);
  assert.ok(values.every((value) => value === current));
  assert.notEqual(current, old);
  assert.equal(old.validUntilMs, 105000);
  assert.equal(current.validUntilMs, 109001);
  authorizeFastGatewaySnapshot(current, input, clock.wall);
  clock.wall += 999;
  clock.mono += 999;
  assert.throws(() => authorizeFastGatewaySnapshot(old, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  authorizeFastGatewaySnapshot(current, input, clock.wall);
});

for (const result of ['deny', 'unsupported', 'unavailable', 'expired'] as const) {
  test(`crossed handoff joins refresh ${result} without stale fallback or another source attempt`, async () => {
    const { input, snapshot } = fixture();
    const clock = clocks();
    let loads = 0;
    let crossed = false;
    const cache = new CachedFastGatewaySnapshots(
      {
        async resolve() {
          if (++loads === 1) return snapshot;
          if (result === 'deny') throw new FastGatewaySnapshotError('SNAPSHOT_DENIED');
          if (result === 'unavailable') throw new FastGatewaySnapshotError('SNAPSHOT_UNAVAILABLE');
          if (result === 'unsupported') return null;
          return { ...snapshot, observedAtMs: clock.wall - 5000, validUntilMs: clock.wall };
        },
      },
      {
        minimumValidityMs: 1000,
        refreshAheadMs: 1500,
        wallNow: () => clock.wall,
        monotonicNow: () => clock.mono,
        observe(metric) {
          if (metric === 'l1_hit' && !crossed) {
            crossed = true;
            clock.wall += 2;
            clock.mono += 2;
          }
        },
      },
    );
    const old = await cache.resolve(input);
    assert.ok(old);
    clock.wall += 3999;
    clock.mono += 3999;
    if (result === 'unsupported') assert.equal(await cache.resolve(input), null);
    else
      await assert.rejects(
        cache.resolve(input),
        errorCode(result === 'deny' ? 'SNAPSHOT_DENIED' : 'SNAPSHOT_UNAVAILABLE'),
      );
    assert.equal(loads, 2);
    assert.equal(old.validUntilMs, 105000);
    if (result === 'deny' || result === 'unsupported') {
      assert.throws(() => authorizeFastGatewaySnapshot(old, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
    }
    clock.wall += 999;
    clock.mono += 999;
    assert.throws(() => authorizeFastGatewaySnapshot(old, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  });
}

for (const fence of ['expired', 'invalidated', 'unavailable'] as const) {
  test(`warm handoff never retries an authority that became ${fence} after selection`, async () => {
    const { input, snapshot } = fixture();
    const clock = clocks();
    let loads = 0;
    let crossed = false;
    const cache = new CachedFastGatewaySnapshots(
      {
        async resolve() {
          loads++;
          return snapshot;
        },
      },
      {
        minimumValidityMs: 1000,
        refreshAheadMs: 1500,
        wallNow: () => clock.wall,
        monotonicNow: () => clock.mono,
        observe(metric) {
          if (metric !== 'l1_hit' || crossed) return;
          crossed = true;
          if (fence === 'expired') {
            clock.wall += 1001;
            clock.mono += 1001;
          } else if (fence === 'invalidated') cache.invalidate(1n);
          else cache.markUnavailable();
        },
      },
    );
    const old = await cache.resolve(input);
    assert.ok(old);
    clock.wall += 3999;
    clock.mono += 3999;
    await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
    assert.equal(loads, 2, 'only the already-started prefetch; no catch-and-retry');
    assert.throws(() => authorizeFastGatewaySnapshot(old, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  });
}

function clocks() {
  return { wall: 100_000, mono: 0 };
}
function store(): FastGatewaySnapshotCacheStore & { values: Map<string, Buffer>; writes: number; reads: number } {
  return {
    values: new Map(),
    writes: 0,
    reads: 0,
    async get(key) {
      this.reads++;
      return this.values.get(key) ?? null;
    },
    async set(key, value) {
      this.writes++;
      this.values.set(key, value);
    },
  };
}

test('warm L1 is immutable, runs no source/database or Redis operations and exposes explicit metric', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  const l2 = store();
  const metrics: FastGatewaySnapshotMetric[] = [];
  let loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        return snapshot;
      },
    },
    {
      wallNow: () => clock.wall,
      monotonicNow: () => clock.mono,
      store: l2,
      encryptionKey: randomBytes(32),
      observe: (m) => metrics.push(m),
    },
  );
  const first = await cache.resolve(input);
  assert.equal(await cache.resolve(input), first);
  assert.equal(loads, 1);
  assert.equal(l2.reads, 1);
  assert.equal(l2.writes, 1);
  assert.ok(metrics.includes('l1_hit'));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first?.candidates[0].credential.version.envelope));
  assert.throws(() => Object.defineProperty(first?.caller, 'tenantId', { value: 'tenant-b' }));
});

test('owned snapshots reuse request primitive parsing but unowned snapshots retain full validation', async (t) => {
  const { input, snapshot } = fixture();
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return snapshot;
      },
    },
    { wallNow: () => 100_000, monotonicNow: () => 0 },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  const unowned = structuredClone(held);
  Object.freeze(unowned);
  const originalBigInt = BigInt;
  let conversions = 0;
  t.mock.method(globalThis, 'BigInt', (value: Parameters<typeof BigInt>[0]) => {
    conversions++;
    return originalBigInt(value);
  });
  for (let repeat = 0; repeat < 2; repeat++) {
    conversions = 0;
    authorizeFastGatewaySnapshot(held, input, 100_000);
    assert.equal(conversions, 0, 'all eight live comparisons reuse the same request primitive parse');
    conversions = 0;
    authorizeFastGatewaySnapshot(unowned, input, 100_000);
    assert.equal(conversions, 26, 'a frozen public object never receives the cache-owned static proof');
  }
  const otherRequest = structuredClone(input);
  conversions = 0;
  authorizeFastGatewaySnapshot(held, otherRequest, 100_000);
  assert.equal(conversions, 1, 'an independent request parses its primitive version value once');
  authorizeFastGatewaySnapshot(held, otherRequest, 100_000);
  assert.equal(conversions, 1, 'repeated boundaries reuse parsing, not the authorization decision');
});

test('public shallow-frozen and accessor snapshots revalidate nested structural changes on every use', () => {
  const { input, snapshot } = fixture();
  Object.freeze(snapshot);
  authorizeFastGatewaySnapshot(snapshot, input, 100_000);
  Object.defineProperty(snapshot.candidates[0].credential.account, 'tenantId', { value: 'tenant-b' });
  assert.throws(() => authorizeFastGatewaySnapshot(snapshot, input, 100_000), errorCode('SNAPSHOT_DENIED'));

  const withAccessor = fixture().snapshot;
  let candidateVersion = 1;
  Object.defineProperty(withAccessor.candidates[0].authority, 'credentialVersion', { get: () => candidateVersion });
  Object.freeze(withAccessor);
  authorizeFastGatewaySnapshot(withAccessor, input, 100_000);
  candidateVersion = 2;
  assert.throws(() => authorizeFastGatewaySnapshot(withAccessor, input, 100_000), errorCode('SNAPSHOT_DENIED'));
});

test('request parse reuse preserves equivalent primitive versions and rejects invalid representations', async () => {
  const { input, held } = await ownedFixture();
  const m = input.authenticatedCaller.metadata;
  const a = input.authenticatedCaller.authorization;
  for (const value of [1, 1n, '1', '01', '+1', '0x1', '0b1', ' 1 ']) {
    replace(m, 'authzVersion', value);
    replace(a, 'authzVersion', value);
    authorizeFastGatewaySnapshot(held, input, 100_000);
    authorizeFastGatewaySnapshot(held, input, 100_000);
  }
  for (const value of [0, -1, NaN, Infinity, '', '0', '-1', '1.2', '1e0', 'bad', undefined, Symbol('1')]) {
    replace(m, 'authzVersion', value);
    replace(a, 'authzVersion', value);
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  }
});

test('a held request reparses changed raw versions and still compares every live authorization version', async () => {
  const { input, held } = await ownedFixture();
  const m = input.authenticatedCaller.metadata;
  const a = input.authenticatedCaller.authorization;
  for (const field of ['authzVersion', 'modelScopeVersion', 'entitlementAuthzVersion', 'supplyProfileAuthzVersion']) {
    replace(m, field, 2);
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
    replace(a, field, 2);
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
    replace(m, field, 1);
    replace(a, field, 1);
    authorizeFastGatewaySnapshot(held, input, 100_000);
  }
});

test('request primitive memo stays bounded under changing equivalent version representations', async (t) => {
  const { input, held } = await ownedFixture();
  const m = input.authenticatedCaller.metadata;
  const a = input.authenticatedCaller.authorization;
  for (let padding = 1; padding <= 20; padding++) {
    replace(m, 'authzVersion', `${'0'.repeat(padding)}1`);
    replace(a, 'authzVersion', m.authzVersion);
    authorizeFastGatewaySnapshot(held, input, 100_000);
  }
  const originalBigInt = BigInt;
  let conversions = 0;
  t.mock.method(globalThis, 'BigInt', (value: Parameters<typeof BigInt>[0]) => {
    conversions++;
    return originalBigInt(value);
  });
  replace(m, 'authzVersion', '01');
  replace(a, 'authzVersion', '01');
  authorizeFastGatewaySnapshot(held, input, 100_000);
  assert.equal(conversions, 1, 'old primitive facts were evicted rather than retained without a bound');
  authorizeFastGatewaySnapshot(held, input, 100_000);
  assert.equal(conversions, 1);
});

for (const kind of ['getter', 'proxy'] as const) {
  test(`${kind} request versions are reread at each original comparison, including within one invocation`, async () => {
    const { input, held } = await ownedFixture();
    const original = input.authenticatedCaller.authorization;
    let reads = 0;
    let changeDuringCall = false;
    const read = () => (++reads === 2 && changeDuringCall ? 2 : 1);
    if (kind === 'getter') Object.defineProperty(original, 'authzVersion', { get: read, configurable: true });
    else
      replace(
        input.authenticatedCaller,
        'authorization',
        new Proxy(original, {
          get(target, key, receiver) {
            return key === 'authzVersion' ? read() : Reflect.get(target, key, receiver);
          },
        }),
      );
    authorizeFastGatewaySnapshot(held, input, 100_000);
    assert.equal(reads, 2, 'the metadata and snapshot comparisons each read current authorization');
    reads = 0;
    changeDuringCall = true;
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
    assert.equal(reads, 2, 'an earlier matching primitive is not a cached decision');
  });
}

for (const kind of ['frozen-object', 'proxy'] as const) {
  test(`${kind} version coercion never becomes a memoized primitive fact`, async () => {
    const { input, held } = await ownedFixture();
    let current = '1';
    const source = Object.freeze({ toString: () => current });
    const version = kind === 'proxy' ? new Proxy(source, {}) : source;
    replace(input.authenticatedCaller.metadata, 'authzVersion', version);
    replace(input.authenticatedCaller.authorization, 'authzVersion', version);
    authorizeFastGatewaySnapshot(held, input, 100_000);
    current = '2';
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
    current = 'invalid';
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  });
}

test('request expiry parsing is reused only for the current string; time, revocation and getter reads stay live', async (t) => {
  const { input, held } = await ownedFixture();
  const m = input.authenticatedCaller.metadata;
  const expiry = new Date(101_000).toISOString();
  replace(m, 'expiresAt', expiry);
  const originalParse = Date.parse;
  let parses = 0;
  t.mock.method(Date, 'parse', (value: string) => {
    parses++;
    return originalParse(value);
  });
  authorizeFastGatewaySnapshot(held, input, 100_000);
  authorizeFastGatewaySnapshot(held, input, 100_999);
  assert.equal(parses, 1);
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, 101_000), errorCode('SNAPSHOT_DENIED'));
  assert.equal(parses, 1, 'expiry is rechecked, not reparsed or extended');
  replace(m, 'expiresAt', 'invalid');
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  replace(m, 'expiresAt', expiry);
  replace(m, 'revokedAt', new Date(99_999).toISOString());
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  replace(m, 'revokedAt', null);
  let reads = 0;
  Object.defineProperty(m, 'expiresAt', {
    configurable: true,
    get: () => (++reads === 1 ? expiry : new Date(100_000).toISOString()),
  });
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  assert.equal(reads, 2, 'the null guard and parse each retain the original current-value read');
});

test('same input identity never caches scope, request-body, requested-model, route or client-IP decisions', async () => {
  const { input, snapshot } = fixture();
  replace(snapshot.policy, 'ipPolicy', { mode: 'allowlist', rules: ['192.0.2.0/24'] });
  const cache = new CachedFastGatewaySnapshots(
    { resolve: async () => snapshot },
    { wallNow: () => 100_000, monotonicNow: () => 0 },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  for (const [field, value] of [
    ['publicModel', 'model-b'],
    ['protocol', 'anthropic'],
    ['clientOperation', 'embeddings'],
    ['inputByteLength', 1025],
    ['clientAddress', { status: 'resolved', address: '198.51.100.1', source: 'socket-peer' }],
  ] as const) {
    const before = input[field];
    replace(input, field, value);
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
    replace(input, field, before);
    authorizeFastGatewaySnapshot(held, input, 100_000);
  }
  replace(input.authenticatedCaller.metadata.modelScopes, '0', 'model-b');
  replace(input.authenticatedCaller.authorization.modelScopes, '0', 'model-b');
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
});

test('cache-owned proof does not cache caller identity, revocation, expiry, scope or authorization versions', async () => {
  const { input, snapshot } = fixture();
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return snapshot;
      },
    },
    { wallNow: () => 100_000, monotonicNow: () => 0 },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  for (const [metadataField, authorizationField, value] of [
    ['id', 'keyId', 'key-b'],
    ['tenantId', 'tenantId', 'tenant-b'],
    ['projectId', 'projectId', 'project-b'],
    ['executionPrincipalId', 'principalId', 'user-b'],
    ['entitlementId', 'entitlementId', 'entitlement-b'],
    ['supplyProfileId', 'supplyProfileId', 'profile-b'],
    ['supplyMode', 'supplyMode', 'platform'],
  ] as const) {
    const changed = structuredClone(input);
    Object.defineProperty(changed.authenticatedCaller.metadata, metadataField, { value });
    Object.defineProperty(changed.authenticatedCaller.authorization, authorizationField, { value });
    assert.throws(() => authorizeFastGatewaySnapshot(held, changed, 100_000), errorCode('SNAPSHOT_DENIED'));
  }
  for (const field of ['authzVersion', 'modelScopeVersion', 'entitlementAuthzVersion', 'supplyProfileAuthzVersion']) {
    const changed = structuredClone(input);
    Object.defineProperty(changed.authenticatedCaller.metadata, field, { value: 2 });
    assert.throws(() => authorizeFastGatewaySnapshot(held, changed, 100_000), errorCode('SNAPSHOT_DENIED'));
    Object.defineProperty(changed.authenticatedCaller.authorization, field, { value: 2 });
    assert.throws(() => authorizeFastGatewaySnapshot(held, changed, 100_000), errorCode('SNAPSHOT_DENIED'));
  }
  for (const [field, value] of [
    ['revokedAt', new Date(99_999).toISOString()],
    ['expiresAt', new Date(100_000).toISOString()],
    ['status', 'inactive'],
    ['modelScopes', ['model-b']],
  ] as const) {
    const changed = structuredClone(input);
    Object.defineProperty(changed.authenticatedCaller.metadata, field, { value });
    assert.throws(() => authorizeFastGatewaySnapshot(held, changed, 100_000), errorCode('SNAPSHOT_DENIED'));
  }
  const changed = structuredClone(input);
  Object.defineProperty(changed.authenticatedCaller.metadata, 'modelScopes', { value: ['model-b'] });
  Object.defineProperty(changed.authenticatedCaller.authorization, 'modelScopes', { value: ['model-b'] });
  assert.throws(() => authorizeFastGatewaySnapshot(held, changed, 100_000), errorCode('SNAPSHOT_DENIED'));
  authorizeFastGatewaySnapshot(held, input, 100_000);
});

test('cache-owned proof retains all candidate time checks and monotonic wall-clock anchoring', async (t) => {
  const { input, snapshot } = fastExecutorFixture('tenant-a', 99_000, true);
  const clock = clocks();
  const first = snapshot.candidates[0];
  assert.ok(first.customerPrice);
  assert.ok(first.supplierCost);
  const candidate = {
    ...first,
    credential: {
      ...first.credential,
      version: { ...first.credential.version, expiresAt: new Date(105_000).toISOString() },
    },
    customerPrice: {
      ...first.customerPrice,
      effectiveAt: new Date(99_000).toISOString(),
      expiresAt: new Date(105_000).toISOString(),
    },
    supplierCost: {
      ...first.supplierCost,
      effectiveAt: new Date(99_000).toISOString(),
      expiresAt: new Date(105_000).toISOString(),
    },
  };
  const value = {
    ...snapshot,
    candidates: [
      candidate,
      {
        ...candidate,
        supplierCost: { ...candidate.supplierCost, effectiveAt: new Date(99_500).toISOString() },
      },
    ],
  };
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return value;
      },
    },
    { wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  const unowned = structuredClone(held);
  const originalParse = Date.parse;
  let parses = 0;
  t.mock.method(Date, 'parse', (value: string) => {
    parses++;
    return originalParse(value);
  });
  authorizeFastGatewaySnapshot(held, input, clock.wall);
  assert.equal(parses, 0, 'all candidate date strings were parsed when the owned proof was acquired');
  clock.wall = 99_250;
  parses = 0;
  authorizeFastGatewaySnapshot(held, input, clock.wall);
  assert.equal(parses, 0, 'live comparisons use parsed bounds and the unchanged monotonic lease anchor');
  assert.throws(() => authorizeFastGatewaySnapshot(unowned, input, clock.wall), errorCode('SNAPSHOT_DENIED'));
  clock.wall = 100_000;
  authorizeFastGatewaySnapshot(held, input, clock.wall);
  clock.wall = 104_000;
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
});

for (const field of ['credential', 'customerPrice', 'supplierCost'] as const) {
  for (const expiry of ['invalid', new Date(100_000).toISOString(), new Date(103_999).toISOString()]) {
    test(`later candidate ${field} expiry ${expiry} cannot acquire or reuse an owned proof`, async () => {
      const { input, snapshot } = fastExecutorFixture('tenant-a', 99_000, true);
      const later = structuredClone(snapshot.candidates[0]);
      const timed = field === 'credential' ? later.credential.version : later[field];
      assert.ok(timed);
      replace(timed, 'expiresAt', expiry);
      replace(snapshot, 'candidates', [snapshot.candidates[0], later]);
      const cache = new CachedFastGatewaySnapshots(
        { resolve: async () => snapshot },
        { wallNow: () => 100_000, monotonicNow: () => 0 },
      );
      for (let repeat = 0; repeat < 2; repeat++)
        await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_DENIED'));
    });
  }
}

for (const field of ['customerPrice', 'supplierCost'] as const) {
  test(`later candidate ${field} effective time cannot hide behind the first candidate proof`, async () => {
    const { input, snapshot } = fastExecutorFixture('tenant-a', 99_000, true);
    const later = structuredClone(snapshot.candidates[0]);
    assert.ok(later[field]);
    replace(later[field], 'effectiveAt', new Date(100_001).toISOString());
    replace(snapshot, 'candidates', [snapshot.candidates[0], later]);
    const cache = new CachedFastGatewaySnapshots(
      { resolve: async () => snapshot },
      { wallNow: () => 100_000, monotonicNow: () => 0 },
    );
    await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_DENIED'));
    await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_DENIED'));
  });
}

test('encrypted L2 and independent clones cannot inherit parsed candidate date provenance', async (t) => {
  const { input, snapshot } = fastExecutorFixture('tenant-a', 99_000, true);
  const candidate = snapshot.candidates[0];
  assert.ok(candidate.customerPrice);
  assert.ok(candidate.supplierCost);
  for (const timed of [candidate.credential.version, candidate.customerPrice, candidate.supplierCost])
    replace(timed, 'expiresAt', new Date(105_000).toISOString());
  const l2 = store();
  const options = { store: l2, encryptionKey: randomBytes(32), wallNow: () => 100_000, monotonicNow: () => 0 };
  const first = await new CachedFastGatewaySnapshots({ resolve: async () => snapshot }, options).resolve(input);
  assert.ok(first);
  const originalParse = Date.parse;
  let parses = 0;
  t.mock.method(Date, 'parse', (value: string) => {
    parses++;
    return originalParse(value);
  });
  const second = await new CachedFastGatewaySnapshots(
    { resolve: async () => assert.fail('must use encrypted L2') },
    options,
  ).resolve(input);
  assert.ok(second);
  assert.equal(parses, 5, 'the independently decoded owned object validates all date strings once');
  authorizeFastGatewaySnapshot(second, input, 100_000);
  assert.equal(parses, 5);
  const unowned = structuredClone(second);
  Object.freeze(unowned);
  authorizeFastGatewaySnapshot(unowned, input, 100_000);
  assert.equal(parses, 10, 'shallow freezing a clone never grants date parsing provenance');
  replace(unowned.candidates[0].credential.version, 'expiresAt', new Date(100_000).toISOString());
  assert.throws(() => authorizeFastGatewaySnapshot(unowned, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  authorizeFastGatewaySnapshot(first, input, 100_000);
  authorizeFastGatewaySnapshot(second, input, 100_000);
});

for (const field of ['credential', 'customerPrice', 'supplierCost'] as const) {
  test(`frozen Date internal slots in ${field} expiry cannot inherit primitive time facts`, async () => {
    const { input, snapshot } = fastExecutorFixture('tenant-a', 99_000, true);
    const candidate = snapshot.candidates[0];
    const timed = field === 'credential' ? candidate.credential.version : candidate[field];
    assert.ok(timed);
    replace(timed, 'expiresAt', new Date(105_000));
    const cache = new CachedFastGatewaySnapshots(
      { resolve: async () => snapshot },
      { wallNow: () => 100_000, monotonicNow: () => 0 },
    );
    const held = await cache.resolve(input);
    assert.ok(held);
    authorizeFastGatewaySnapshot(held, input, 100_000);
    const heldTimed = field === 'credential' ? held.candidates[0].credential.version : held.candidates[0][field];
    const expiry = heldTimed?.expiresAt as unknown as Date;
    assert.ok(Object.isFrozen(expiry));
    expiry.setTime(100_000);
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  });
}

for (const field of ['customerPrice', 'supplierCost'] as const) {
  test(`frozen Date internal slots in ${field} effective time are still revalidated`, async () => {
    const { input, snapshot } = fastExecutorFixture('tenant-a', 99_000, true);
    const price = snapshot.candidates[0][field];
    assert.ok(price);
    replace(price, 'effectiveAt', new Date(99_000));
    const cache = new CachedFastGatewaySnapshots(
      { resolve: async () => snapshot },
      { wallNow: () => 100_000, monotonicNow: () => 0 },
    );
    const held = await cache.resolve(input);
    assert.ok(held);
    authorizeFastGatewaySnapshot(held, input, 100_000);
    const effective = held.candidates[0][field]?.effectiveAt as unknown as Date;
    assert.ok(Object.isFrozen(effective));
    effective.setTime(101_000);
    assert.throws(() => authorizeFastGatewaySnapshot(held, input, 100_000), errorCode('SNAPSHOT_DENIED'));
  });
}

test('invalid later candidates never acquire a static proof in L1 or encrypted L2', async () => {
  const { input, snapshot } = fixture();
  const first = snapshot.candidates[0];
  const invalid = {
    ...snapshot,
    candidates: [first, { ...first, authority: { ...first.authority, credentialVersion: 2 } }],
  };
  const l2 = store();
  const options = { store: l2, encryptionKey: randomBytes(32), wallNow: () => 100_000, monotonicNow: () => 0 };
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return invalid;
      },
    },
    options,
  );
  await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_DENIED'));
  await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_DENIED'));
  assert.equal(l2.writes, 1);
  let loads = 0;
  const fromL2 = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        return snapshot;
      },
    },
    options,
  );
  await assert.rejects(fromL2.resolve(input), errorCode('SNAPSHOT_DENIED'));
  await assert.rejects(fromL2.resolve(input), errorCode('SNAPSHOT_DENIED'));
  assert.equal(loads, 0, 'the invalid L2 object itself must be revalidated, not trusted or refreshed into success');
});

test('64 simultaneous cold requests share one bounded loader', async () => {
  const { input, snapshot } = fixture();
  let loads = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        await barrier;
        return snapshot;
      },
    },
    { wallNow: () => 100_000, monotonicNow: () => 0 },
  );
  const requests = Array.from({ length: 64 }, () => cache.resolve(input));
  assert.equal(loads, 1);
  release?.();
  assert.equal((await Promise.all(requests)).length, 64);
  assert.equal(loads, 1);
});

test('cold pending bound never bypasses singleflight into extra database work', async () => {
  const first = fixture();
  const second = fixture('tenant-b');
  let release: (() => void) | undefined;
  let loads = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        await barrier;
        return first.snapshot;
      },
    },
    { maxPending: 1, wallNow: () => 100_000, monotonicNow: () => 0 },
  );
  const pending = cache.resolve(first.input);
  await assert.rejects(cache.resolve(second.input), errorCode('SNAPSHOT_BUSY'));
  assert.equal(loads, 1);
  release?.();
  await pending;
});

test('timeout retains its capacity slot until underlying load exits; late work never publishes', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        await barrier;
        return snapshot;
      },
    },
    { maxPending: 1, loadTimeoutMs: 10, wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
  await assert.rejects(cache.resolve(fixture('tenant-b').input), errorCode('SNAPSHOT_BUSY'));
  clock.mono = 11;
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
});

test('L2 preserves original validation/deadline and ciphertext is bound to complete cache key', async () => {
  const { input, snapshot } = fixture();
  const l2 = store();
  const encryptionKey = randomBytes(32);
  const clock = clocks();
  let loads = 0;
  const source = {
    async resolve() {
      loads++;
      return { ...snapshot, observedAtMs: clock.wall, validUntilMs: clock.wall + 5000 };
    },
  };
  const options = { store: l2, encryptionKey, wallNow: () => clock.wall, monotonicNow: () => clock.mono };
  await new CachedFastGatewaySnapshots(source, options).resolve(input);
  const bytes = [...l2.values.values()][0];
  assert.ok(bytes);
  assert.equal(bytes.includes(Buffer.from('tenant-a')), false);
  assert.equal(bytes.includes(Buffer.from(snapshot.candidates[0].credential.version.envelope.ciphertext)), false);
  clock.wall += 4900;
  clock.mono += 4900;
  const second = new CachedFastGatewaySnapshots(source, options);
  const hit = await second.resolve(input);
  assert.equal(hit?.observedAtMs, 100_000);
  assert.equal(hit?.validUntilMs, 105_000);
  assert.equal(loads, 1);
  clock.wall += 101;
  clock.mono += 101;
  await second.resolve(input);
  assert.equal(loads, 2);
  const other = fixture('tenant-b').input;
  l2.values.set(fastGatewaySnapshotCacheKey(other), bytes);
  await assert.rejects(
    new CachedFastGatewaySnapshots(source, options).resolve(other),
    errorCode('SNAPSHOT_UNAVAILABLE'),
  );
});

test('absolute expiries and monotonic deadline prevent sliding and wall-clock rollback renewal', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let loads = 0;
  const capped = { ...snapshot, policy: { ...snapshot.policy, absoluteExpiryMs: [101_000] } };
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        return capped;
      },
    },
    { wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  assert.equal((await cache.resolve(input))?.validUntilMs, 101_000);
  clock.wall = 100_900;
  clock.mono = 900;
  await cache.resolve(input);
  clock.wall = 100_500;
  clock.mono = 1100;
  await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(loads, 2);
});

test('negative unsupported cache is bounded and cannot swallow new support forever', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return ++loads === 1 ? null : { ...snapshot, observedAtMs: clock.wall, validUntilMs: clock.wall + 5000 };
      },
    },
    { negativeTtlMs: 100, wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  assert.equal(await cache.resolve(input), null);
  assert.equal(await cache.resolve(input), null);
  assert.equal(loads, 1);
  clock.wall += 101;
  clock.mono += 101;
  assert.ok(await cache.resolve(input));
  assert.equal(loads, 2);
});

test('per-request IP and body limits are evaluated even on hot entry with no source reload', async () => {
  const { input, snapshot } = fixture();
  let loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        return {
          ...snapshot,
          policy: { ...snapshot.policy, ipPolicy: { mode: 'allowlist', rules: ['192.0.2.0/24'] } },
        };
      },
    },
    { wallNow: () => 100_000 },
  );
  await cache.resolve(input);
  await assert.rejects(
    cache.resolve({ ...input, clientAddress: { status: 'resolved', address: '198.51.100.1', source: 'socket-peer' } }),
    errorCode('SNAPSHOT_DENIED'),
  );
  await assert.rejects(cache.resolve({ ...input, clientAddress: undefined }), errorCode('SNAPSHOT_DENIED'));
  await assert.rejects(cache.resolve({ ...input, inputByteLength: 1025 }), errorCode('SNAPSHOT_DENIED'));
  assert.equal(loads, 1);
});

test('tenant, project, key, model and operation differences have independent hashed cache identities', () => {
  const { input } = fixture();
  const original = fastGatewaySnapshotCacheKey(input);
  assert.match(original, /:[0-9a-f]{64}$/);
  assert.equal(original.includes('tenant-a'), false);
  const variants: FastGatewaySnapshotInput[] = [
    fixture('tenant-b').input,
    { ...input, publicModel: 'model-b' },
    { ...input, clientOperation: 'embeddings' },
    ...(['projectId', 'keyId', 'principalId', 'supplyProfileId'] as const).map((field) => ({
      ...input,
      authenticatedCaller: {
        ...input.authenticatedCaller,
        authorization: { ...input.authenticatedCaller.authorization, [field]: 'different' },
      },
    })),
  ];
  for (const changed of variants) assert.notEqual(fastGatewaySnapshotCacheKey(changed), original);
});

test('pure authorization rejects status, stale scope, model/protocol and cross-tenant credential substitutions', () => {
  const { input, snapshot } = fixture();
  for (const status of ['keyStatus', 'tenantStatus', 'projectStatus', 'principalStatus', 'groupStatus'] as const)
    assert.throws(
      () =>
        authorizeFastGatewaySnapshot(
          { ...snapshot, policy: { ...snapshot.policy, [status]: 'inactive' } },
          input,
          100_000,
        ),
      errorCode('SNAPSHOT_DENIED'),
    );
  assert.throws(
    () => authorizeFastGatewaySnapshot(snapshot, fixture('tenant-b').input, 100_000),
    errorCode('SNAPSHOT_DENIED'),
  );
  assert.throws(
    () => authorizeFastGatewaySnapshot(snapshot, { ...input, publicModel: 'model-b' }, 100_000),
    errorCode('SNAPSHOT_DENIED'),
  );
  const candidate = snapshot.candidates[0];
  for (const section of ['account', 'credential', 'version'] as const) {
    const changed = {
      ...candidate,
      credential: { ...candidate.credential, [section]: { ...candidate.credential[section], tenantId: 'tenant-b' } },
    };
    assert.throws(
      () => authorizeFastGatewaySnapshot({ ...snapshot, candidates: [changed] }, input, 100_000),
      errorCode('SNAPSHOT_DENIED'),
    );
  }
});

test('committed monotonic invalidation fences pending load and cannot regress or reuse old L2', async () => {
  const { input, snapshot } = fixture();
  let release: (() => void) | undefined;
  let loads = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const l2 = store();
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        await barrier;
        return snapshot;
      },
    },
    { wallNow: () => 100_000, monotonicNow: () => 0, store: l2, encryptionKey: randomBytes(32) },
  );
  const pending = cache.resolve(input);
  await new Promise((resolve) => setImmediate(resolve));
  cache.invalidate('2');
  cache.invalidate('1');
  release?.();
  await assert.rejects(pending, errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(l2.writes, 0);
  await cache.resolve(input);
  assert.equal(loads, 2);
});

test('known Redis failure closes warm cache until explicitly recovered at verified epoch', async () => {
  const { input, snapshot } = fixture();
  const l2 = store();
  let loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        loads++;
        return snapshot;
      },
    },
    { store: l2, encryptionKey: randomBytes(32), wallNow: () => 100_000 },
  );
  await cache.resolve(input);
  assert.equal(cache.isAvailable(), true);
  cache.markUnavailable();
  assert.equal(cache.isAvailable(), false);
  await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(loads, 1);
  assert.equal(cache.isAvailable(), false);
  cache.recover('1');
  assert.equal(cache.isAvailable(), true);
  await cache.resolve(input);
  assert.equal(loads, 2);
  const failing = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        throw new Error('must not load');
      },
    },
    {
      store: {
        async get() {
          throw new Error(randomBytes(10).toString('hex'));
        },
        async set() {},
      },
      encryptionKey: randomBytes(32),
      wallNow: () => 100_000,
    },
  );
  await assert.rejects(failing.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
});

test('cache errors expose fixed safe messages, reject bad configuration and tampered ciphertext', async () => {
  assert.throws(
    () =>
      new CachedFastGatewaySnapshots(
        {
          async resolve() {
            return null;
          },
        },
        { ttlMs: 5_001 },
      ),
  );
  assert.throws(
    () =>
      new CachedFastGatewaySnapshots(
        {
          async resolve() {
            return null;
          },
        },
        { store: store() },
      ),
  );
  const { input, snapshot } = fixture();
  const l2 = store();
  const options = { store: l2, encryptionKey: randomBytes(32), wallNow: () => 100_000 };
  await new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return snapshot;
      },
    },
    options,
  ).resolve(input);
  const bytes = [...l2.values.values()][0];
  bytes[15] ^= 1;
  await assert.rejects(
    new CachedFastGatewaySnapshots(
      {
        async resolve() {
          throw new Error('must not load');
        },
      },
      options,
    ).resolve(input),
    errorCode('SNAPSHOT_UNAVAILABLE'),
  );
});

test('held snapshots recheck epoch, outage and monotonic expiry immediately before dispatch', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        return snapshot;
      },
    },
    { wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  authorizeFastGatewaySnapshot(held, input, clock.wall);
  cache.invalidate('2');
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  const fresh = await cache.resolve(input);
  assert.ok(fresh);
  cache.markUnavailable();
  assert.throws(() => authorizeFastGatewaySnapshot(fresh, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.throws(() => cache.recover('1'), errorCode('SNAPSHOT_UNAVAILABLE'));
  cache.recover('2');
  const recovered = await cache.resolve(input);
  assert.ok(recovered);
  clock.mono = 5001;
  clock.wall = 100_001;
  assert.throws(() => authorizeFastGatewaySnapshot(recovered, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
});

test('refresh-ahead coalesces 64 near-boundary admissions without extending issued authority', async () => {
  const { input, snapshot } = fixture();
  let wall = 100_000,
    mono = 0,
    loads = 0;
  let finishRefresh: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      resolve: async () => {
        loads++;
        if (loads > 1) await barrier;
        return { ...snapshot, observedAtMs: wall, validUntilMs: wall + 5000 };
      },
    },
    { wallNow: () => wall, monotonicNow: () => mono, minimumValidityMs: 1000, refreshAheadMs: 1500 },
  );
  const issued = await cache.resolve(input);
  assert.ok(issued);
  wall += 3600;
  mono += 3600;
  assert.equal(await cache.resolve(input), issued);
  assert.equal(loads, 2, 'one refresh starts while old lease still has safe handoff time');
  wall += 500;
  mono += 500;
  let returned = 0;
  const waiting = Array.from({ length: 64 }, () =>
    cache.resolve(input).then((value) => {
      returned++;
      return value;
    }),
  );
  await Promise.resolve();
  assert.equal(returned, 0);
  assert.equal(loads, 2);
  assert.ok(finishRefresh);
  finishRefresh();
  const fresh = await Promise.all(waiting);
  assert.equal(loads, 2);
  assert.ok(fresh.every((value) => value === fresh[0]));
  assert.notEqual(fresh[0], issued);
  assert.equal(issued.validUntilMs, 105_000);
  wall = 105_001;
  mono = 5001;
  assert.throws(() => authorizeFastGatewaySnapshot(issued, input, wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  authorizeFastGatewaySnapshot(fresh[0] as FastGatewaySnapshot, input, wall);
});

test('near-expiry encrypted L2 is not promoted as a new admission lease', async () => {
  const { input, snapshot } = fixture();
  let wall = 100_000,
    mono = 0,
    loads = 0;
  const l2 = store();
  const options = {
    store: l2,
    encryptionKey: randomBytes(32),
    wallNow: () => wall,
    monotonicNow: () => mono,
    minimumValidityMs: 1000,
    refreshAheadMs: 1500,
  };
  const source = {
    resolve: async () => {
      loads++;
      return { ...snapshot, observedAtMs: wall, validUntilMs: wall + 5000 };
    },
  };
  const old = await new CachedFastGatewaySnapshots(source, options).resolve(input);
  wall += 4200;
  mono += 4200;
  const next = await new CachedFastGatewaySnapshots(source, options).resolve(input);
  assert.equal(loads, 2);
  assert.notEqual(next?.observedAtMs, old?.observedAtMs);
  assert.equal(old?.validUntilMs, 105000);
  assert.equal(next?.validUntilMs, 109200);
});

test('failed refresh never extends old lease or hands out insufficient validity', async () => {
  const { input, snapshot } = fixture();
  let wall = 100000,
    mono = 0,
    loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      resolve: async () => {
        if (++loads > 1) throw new Error('authority unavailable');
        return snapshot;
      },
    },
    { wallNow: () => wall, monotonicNow: () => mono, minimumValidityMs: 1000, refreshAheadMs: 1500 },
  );
  const issued = await cache.resolve(input);
  assert.ok(issued);
  wall += 4100;
  mono += 4100;
  await assert.rejects(() => cache.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(issued.validUntilMs, 105000);
  wall = 105001;
  mono = 5001;
  assert.throws(() => authorizeFastGatewaySnapshot(issued, input, wall), errorCode('SNAPSHOT_UNAVAILABLE'));
});

for (const result of ['deny', 'unsupported', 'transient'] as const) {
  test(`refresh-ahead ${result} updates only the intended scope and never renews issued leases`, async () => {
    const first = fixture();
    const other = fixture('tenant-b');
    const clock = clocks();
    let loads = 0;
    const cache = new CachedFastGatewaySnapshots(
      {
        async resolve(input) {
          if (input.authenticatedCaller.authorization.tenantId === 'tenant-b') return other.snapshot;
          if (++loads === 1) return first.snapshot;
          if (result === 'unsupported') return null;
          if (result === 'deny') throw new FastGatewaySnapshotError('SNAPSHOT_DENIED');
          throw new Error('transient source failure');
        },
      },
      { wallNow: () => clock.wall, monotonicNow: () => clock.mono, minimumValidityMs: 1000, refreshAheadMs: 1500 },
    );
    const held = await cache.resolve(first.input);
    const unrelated = await cache.resolve(other.input);
    assert.ok(held);
    assert.ok(unrelated);
    clock.wall += 3600;
    clock.mono += 3600;
    await cache.resolve(first.input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held.validUntilMs, 105000);
    authorizeFastGatewaySnapshot(unrelated, other.input, clock.wall);
    if (result === 'transient') authorizeFastGatewaySnapshot(held, first.input, clock.wall);
    else {
      assert.throws(
        () => authorizeFastGatewaySnapshot(held, first.input, clock.wall),
        errorCode('SNAPSHOT_UNAVAILABLE'),
      );
      if (result === 'deny') await assert.rejects(cache.resolve(first.input), errorCode('SNAPSHOT_DENIED'));
      else assert.equal(await cache.resolve(first.input), null);
      assert.equal(loads, 2);
    }
  });
}

test('known deny fences held objects after L1 eviction and cannot resurrect from old encrypted L2', async () => {
  const first = fixture();
  const other = fixture('tenant-b');
  const clock = clocks();
  const l2 = store();
  let denied = false;
  let loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve(input) {
        loads++;
        if (input.authenticatedCaller.authorization.tenantId === 'tenant-b') return other.snapshot;
        if (denied) throw new FastGatewaySnapshotError('SNAPSHOT_DENIED');
        return first.snapshot;
      },
    },
    {
      maxEntries: 1,
      maxPending: 1,
      minimumValidityMs: 1000,
      refreshAheadMs: 1500,
      wallNow: () => clock.wall,
      monotonicNow: () => clock.mono,
      store: l2,
      encryptionKey: randomBytes(32),
    },
  );
  const held = await cache.resolve(first.input);
  assert.ok(held);
  await cache.resolve(other.input);
  denied = true;
  // Make the old L2 fall below handoff margin, forcing an actual source denial.
  clock.wall += 4100;
  clock.mono += 4100;
  await assert.rejects(cache.resolve(first.input), errorCode('SNAPSHOT_DENIED'));
  assert.throws(() => authorizeFastGatewaySnapshot(held, first.input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  const before = l2.reads;
  clock.wall += 501;
  clock.mono += 501;
  await assert.rejects(cache.resolve(first.input), errorCode('SNAPSHOT_DENIED'));
  assert.equal(l2.reads, before, 'known rejection bypasses stale L2, including after negative TTL');
  assert.equal(loads, 4);
});

test('refresh-ahead completion cannot fill a newer epoch or poison it with an old denial', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let loads = 0;
  let finish: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        if (++loads === 2) {
          await barrier;
          throw new FastGatewaySnapshotError('SNAPSHOT_DENIED');
        }
        return { ...snapshot, observedAtMs: clock.wall, validUntilMs: clock.wall + 5000 };
      },
    },
    { minimumValidityMs: 1000, refreshAheadMs: 1500, wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  clock.wall += 3600;
  clock.mono += 3600;
  await cache.resolve(input);
  cache.invalidate('1');
  finish?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.ok(await cache.resolve(input));
  assert.equal(loads, 3);
});

test('retained scope barriers are bounded without revoking unrelated live tickets', async () => {
  const clock = clocks();
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve(input) {
        return fixture(input.authenticatedCaller.authorization.tenantId, clock.wall).snapshot;
      },
    },
    { maxEntries: 1, maxPending: 1, wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  const first = fixture();
  const held = await cache.resolve(first.input);
  assert.ok(held);
  await cache.resolve(fixture('tenant-b').input);
  await assert.rejects(cache.resolve(fixture('tenant-c').input), errorCode('SNAPSHOT_BUSY'));
  authorizeFastGatewaySnapshot(held, first.input, clock.wall);
  clock.wall += 8001;
  clock.mono += 8001;
  assert.ok(await cache.resolve(fixture('tenant-c').input));
});

test('late explicit unsupported refresh fences held authority without publishing its timed-out result', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let loads = 0;
  let finish: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        if (++loads === 1) return snapshot;
        await barrier;
        return null;
      },
    },
    {
      loadTimeoutMs: 100,
      minimumValidityMs: 1000,
      refreshAheadMs: 1500,
      wallNow: () => clock.wall,
      monotonicNow: () => clock.mono,
    },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  clock.wall += 3600;
  clock.mono += 3600;
  await cache.resolve(input);
  clock.wall += 200;
  clock.mono += 200;
  finish?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(held.validUntilMs, 105000);
});

test('later fresh allow does not revive an already revoked issued object', async () => {
  const { input, snapshot } = fixture();
  const clock = clocks();
  let loads = 0;
  const cache = new CachedFastGatewaySnapshots(
    {
      async resolve() {
        if (++loads === 2) throw new FastGatewaySnapshotError('SNAPSHOT_DENIED');
        return { ...snapshot, observedAtMs: clock.wall, validUntilMs: clock.wall + 5000 };
      },
    },
    { minimumValidityMs: 1000, refreshAheadMs: 1500, wallNow: () => clock.wall, monotonicNow: () => clock.mono },
  );
  const held = await cache.resolve(input);
  assert.ok(held);
  clock.wall += 3600;
  clock.mono += 3600;
  await cache.resolve(input);
  await new Promise((resolve) => setImmediate(resolve));
  clock.wall += 501;
  clock.mono += 501;
  const current = await cache.resolve(input);
  assert.ok(current);
  authorizeFastGatewaySnapshot(current, input, clock.wall);
  assert.throws(() => authorizeFastGatewaySnapshot(held, input, clock.wall), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(held.validUntilMs, 105000);
  assert.equal(loads, 3);
});
