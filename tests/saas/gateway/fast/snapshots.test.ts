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
  cache.markUnavailable();
  await assert.rejects(cache.resolve(input), errorCode('SNAPSHOT_UNAVAILABLE'));
  assert.equal(loads, 1);
  cache.recover('1');
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
