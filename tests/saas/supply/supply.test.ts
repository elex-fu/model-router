import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import {
  ProviderCredentialAccessService,
  ProviderSupplyPersistenceService,
} from '../../../src/saas/supply/persistence-service.js';
import type {
  CreateProviderAccountInput,
  ProviderAccountReference,
  ProviderCredentialAccessGrant,
} from '../../../src/saas/supply/types.js';
import { createTenantDispatchProof, FakeProviderSupplyRepository } from './fake-repository.js';

const NOW = new Date('2026-09-28T00:00:00.000Z');
type TenantAccountInput = Extract<CreateProviderAccountInput, { ownerKind: 'tenant' }>;
type PlatformAccountInput = Extract<CreateProviderAccountInput, { ownerKind: 'platform' }>;

function contextKey(context: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

class DeterministicKms implements ProviderCredentialKms {
  readonly generated: Array<{ readonly request: GenerateProviderCredentialDataKeyRequest; readonly context: string }> =
    [];
  private readonly keys = new Map<string, Buffer>();
  private sequence = 0;

  async generateDataKey(request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = Buffer.alloc(32, this.sequence + 1);
    const ciphertextBlob = Buffer.from(`wrapped-${this.sequence}`, 'utf8');
    this.sequence += 1;
    this.keys.set(ciphertextBlob.toString('base64url'), Buffer.from(plaintextKey));
    this.generated.push({ request, context: contextKey(request.encryptionContext) });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    const key = this.keys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!key) throw new Error('unknown wrapped key');
    return Buffer.from(key);
  }
}

function tenantAccount(overrides: Partial<Omit<TenantAccountInput, 'ownerKind'>> = {}): TenantAccountInput {
  return {
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    id: 'account-a',
    displayName: 'Tenant account',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    rightsId: 'rights-a',
    rightsVersion: 1,
    capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
    ...overrides,
  };
}

function platformAccount(overrides: Partial<Omit<PlatformAccountInput, 'ownerKind'>> = {}): PlatformAccountInput {
  return {
    ownerKind: 'platform',
    id: 'platform-account-a',
    displayName: 'Platform account',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    rightsId: 'rights-platform',
    rightsVersion: 1,
    capability: { model: 'model-a', endpoint: 'chat-completions', version: 1 },
    ...overrides,
  };
}

function serviceSetup(): {
  repository: FakeProviderSupplyRepository;
  kms: DeterministicKms;
  service: ProviderSupplyPersistenceService;
} {
  const repository = new FakeProviderSupplyRepository();
  const kms = new DeterministicKms();
  const service = new ProviderSupplyPersistenceService(repository, {
    kms,
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  });
  return { repository, kms, service };
}

function tenantReference(accountId = 'account-a'): ProviderAccountReference {
  return { ownerKind: 'tenant', tenantId: 'tenant-a', accountId };
}

function credentialGrant(evidenceId = 'evidence-a'): ProviderCredentialAccessGrant {
  return { evidenceId };
}

test('contract C-7 scheduling scalars default to the neutral tie and persist explicit values', async () => {
  const { service } = serviceSetup();
  const tenant = await service.createProviderAccount(tenantAccount());
  assert.equal(tenant.priority, 0);
  assert.equal(tenant.weight, 1);

  const platform = await service.createProviderAccount(platformAccount({ priority: 500, weight: 250 }));
  assert.equal(platform.priority, 500);
  assert.equal(platform.weight, 250);
});

test('contract C-7 scheduling scalars reject out-of-range and non-integer input', async () => {
  const { service } = serviceSetup();
  for (const overrides of [
    { priority: -1 },
    { priority: 1001 },
    { priority: 0.5 },
    { weight: 0 },
    { weight: 10001 },
    { weight: 1.5 },
  ] as const) {
    await assert.rejects(service.createProviderAccount(tenantAccount(overrides)), (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    });
  }
});

test('D3 revalidation cadence defaults to disabled and persists explicit values', async () => {
  const { service } = serviceSetup();
  const tenant = await service.createProviderAccount(tenantAccount());
  assert.equal(tenant.revalidationIntervalSeconds, null);

  const platform = await service.createProviderAccount(platformAccount({ revalidationIntervalSeconds: 3600 }));
  assert.equal(platform.revalidationIntervalSeconds, 3600);

  // null is the explicit disable, never confused with an absent value.
  const disabled = await service.createProviderAccount(
    platformAccount({ id: 'platform-account-b', revalidationIntervalSeconds: null }),
  );
  assert.equal(disabled.revalidationIntervalSeconds, null);
});

test('D3 revalidation cadence rejects out-of-range and non-integer input', async () => {
  const { service } = serviceSetup();
  for (const overrides of [
    { revalidationIntervalSeconds: 899 },
    { revalidationIntervalSeconds: 604_801 },
    { revalidationIntervalSeconds: 0 },
    { revalidationIntervalSeconds: 3600.5 },
    { revalidationIntervalSeconds: Number.NaN },
  ] as const) {
    await assert.rejects(service.createProviderAccount(tenantAccount(overrides)), (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    });
  }
});

test('updateProviderAccountRevalidation CAS-updates the cadence, disables with null and bumps the epoch', async () => {
  const { service } = serviceSetup();
  const created = await service.createProviderAccount(tenantAccount());
  const updated = await service.updateProviderAccountRevalidation(tenantReference(), {
    revalidationIntervalSeconds: 86_400,
    expectedAuthzVersion: created.authzVersion,
  });
  assert.equal(updated.revalidationIntervalSeconds, 86_400);
  assert.equal(updated.authzVersion, created.authzVersion + 1);

  const disabled = await service.updateProviderAccountRevalidation(tenantReference(), {
    revalidationIntervalSeconds: null,
    expectedAuthzVersion: updated.authzVersion,
  });
  assert.equal(disabled.revalidationIntervalSeconds, null);
  assert.equal(disabled.authzVersion, updated.authzVersion + 1);

  await assert.rejects(
    service.updateProviderAccountRevalidation(tenantReference(), {
      revalidationIntervalSeconds: 3600,
      expectedAuthzVersion: created.authzVersion,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'ACCOUNT_STATE_CONFLICT');
      return true;
    },
  );
  for (const cadence of [899, 604_801, 0, 3600.5, Number.NaN, undefined] as const) {
    await assert.rejects(
      service.updateProviderAccountRevalidation(tenantReference(), {
        revalidationIntervalSeconds: cadence as number,
        expectedAuthzVersion: disabled.authzVersion,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderSupplyError);
        assert.equal(error.code, 'INVALID_INPUT');
        return true;
      },
    );
  }
});

test('updateProviderAccountScheduling CAS-updates scalars and bumps the account epoch', async () => {
  const { service } = serviceSetup();
  const created = await service.createProviderAccount(tenantAccount());
  const updated = await service.updateProviderAccountScheduling(tenantReference(), {
    priority: 1000,
    weight: 10000,
    expectedAuthzVersion: created.authzVersion,
  });
  assert.equal(updated.priority, 1000);
  assert.equal(updated.weight, 10000);
  assert.equal(updated.authzVersion, created.authzVersion + 1);

  await assert.rejects(
    service.updateProviderAccountScheduling(tenantReference(), {
      priority: 1,
      weight: 1,
      expectedAuthzVersion: created.authzVersion,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'ACCOUNT_STATE_CONFLICT');
      return true;
    },
  );
  await assert.rejects(
    service.updateProviderAccountScheduling(tenantReference(), {
      priority: 1001,
      weight: 1,
      expectedAuthzVersion: updated.authzVersion,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('keeps tenant BYOK and platform supply accounts in disjoint owner contracts', async () => {
  const { service } = serviceSetup();
  const tenant = await service.createProviderAccount(tenantAccount());
  const platform = await service.createProviderAccount(platformAccount());

  assert.deepEqual(
    {
      ownerKind: tenant.ownerKind,
      tenantId: tenant.tenantId,
      supplyMode: tenant.supplyMode,
      capabilities: tenant.capabilities,
    },
    {
      ownerKind: 'tenant',
      tenantId: 'tenant-a',
      supplyMode: 'byok',
      capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
    },
  );
  assert.deepEqual(
    { ownerKind: platform.ownerKind, tenantId: platform.tenantId, supplyMode: platform.supplyMode },
    { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' },
  );
  await assert.rejects(
    service.createProviderAccount(
      tenantAccount({ ownerKind: 'platform', tenantId: 'tenant-a', supplyMode: 'platform' } as never),
    ),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'INVALID_INPUT',
  );
});

test('seals versioned credentials, returns metadata only, and rotates with CAS', async () => {
  const { repository, service } = serviceSetup();
  const account = await service.createProviderAccount(tenantAccount());
  const credential = await service.createProviderCredential({
    account: tenantReference(),
    id: 'credential-a',
    secret: Buffer.from('tenant-provider-secret'),
  });

  assert.equal(credential.credential.currentVersion, 1);
  assert.equal(credential.version.version, 1);
  assert.equal(credential.version.status, 'active');
  assert.doesNotMatch(JSON.stringify(credential), /tenant-provider-secret/);
  assert.equal('envelope' in credential.version, false);
  assert.equal('ciphertext' in credential.version, false);
  assert.equal('wrappedDek' in credential.version, false);
  assert.equal('kmsKeyId' in credential.version, false);

  const listed = await service.listProviderCredentialVersions({
    ...tenantReference(),
    credentialId: 'credential-a',
  });
  assert.deepEqual(
    listed.map((version) => version.version),
    [1],
  );
  assert.equal('ciphertext' in (listed[0] ?? {}), false);

  await service.setProviderAccountValidation(tenantReference(), 'verified');
  await service.activateProviderAccount(tenantReference());
  await service.setProviderCredentialValidation({ ...tenantReference(), credentialId: 'credential-a' }, 'verified');
  const rotated = await service.replaceProviderCredentialSecret({
    credential: { ...tenantReference(), credentialId: 'credential-a' },
    expectedVersion: 1,
    secret: Buffer.from('rotated-provider-secret'),
  });
  assert.equal(rotated.version.version, 2);
  assert.equal(rotated.credential.currentVersion, 2);
  assert.equal(repository.versions.find((version) => version.version === 1)?.status, 'retired');
  await assert.rejects(
    service.replaceProviderCredentialSecret({
      credential: { ...tenantReference(), credentialId: 'credential-a' },
      expectedVersion: 1,
      secret: Buffer.from('stale-rotation'),
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_VERSION_CONFLICT',
  );
  assert.doesNotMatch(JSON.stringify(repository), /tenant-provider-secret|rotated-provider-secret|stale-rotation/);
  assert.equal(account.status, 'pending');
});

test('binds KMS context to owner and account-qualified credential identity', async () => {
  const { kms, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount({ id: 'shared-account' }));
  await service.createProviderAccount(platformAccount({ id: 'shared-account' }));
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'shared-account' },
    id: 'shared-credential',
    secret: Buffer.from('tenant-key'),
  });
  await service.createProviderCredential({
    account: { ownerKind: 'platform', tenantId: null, accountId: 'shared-account' },
    id: 'shared-credential',
    secret: Buffer.from('platform-key'),
  });

  assert.equal(kms.generated.length, 2);
  const contexts = kms.generated.map(({ request }) => request.encryptionContext);
  assert.deepEqual(
    contexts.map((context) => ({
      ownerKind: context.ownerKind,
      supplyMode: context.supplyMode,
      tenantId: context.tenantId,
    })),
    [
      { ownerKind: 'tenant', supplyMode: 'byok', tenantId: 'tenant-a' },
      { ownerKind: 'platform', supplyMode: 'platform', tenantId: undefined },
    ],
  );
  assert.notEqual(contexts[0]?.credentialId, contexts[1]?.credentialId);
  assert.match(contexts[0]?.credentialId ?? '', /account14:shared-account/);
  assert.match(contexts[0]?.credentialId ?? '', /credential17:shared-credential/);
});

test('runtime access is fail-closed until validation and does not expose a read secret DTO', async () => {
  const { repository, kms, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount());
  await service.createProviderCredential({
    account: tenantReference(),
    id: 'credential-a',
    secret: Buffer.from('runtime-secret'),
  });
  const runtime = new ProviderCredentialAccessService(repository, kms, {
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  });
  const grant = credentialGrant();
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );

  await service.setProviderAccountValidation(tenantReference(), 'verified');
  await service.activateProviderAccount(tenantReference());
  await service.setProviderCredentialValidation({ ...tenantReference(), credentialId: 'credential-a' }, 'verified');
  repository.dispatchProof = createTenantDispatchProof(repository);
  let callbackSecret: Buffer | undefined;
  const value = await runtime.withCredential(grant, (secret) => {
    callbackSecret = secret;
    return secret.toString('utf8');
  });
  assert.equal(value, 'runtime-secret');
  assert.ok(callbackSecret);
  assert.equal(
    callbackSecret.every((byte) => byte === 0),
    true,
  );
  const dto = await service.getProviderCredential({ ...tenantReference(), credentialId: 'credential-a' });
  assert.doesNotMatch(JSON.stringify(dto), /runtime-secret|ciphertext|wrappedDek/);

  await service.revokeProviderAccount(tenantReference());
  repository.dispatchProof = createTenantDispatchProof(repository);
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );

  repository.dispatchProof = createTenantDispatchProof(repository, {
    attempt: { routeConfigId: 'different-route' },
  });
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );

  repository.dispatchProof = createTenantDispatchProof(repository, {
    attempt: { dispatchState: 'not_sent' },
  });
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );
});

test('runtime access rejects unclaimed evidence and mismatched attempt proof before KMS', async () => {
  const { repository, kms, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount());
  await service.createProviderCredential({
    account: tenantReference(),
    id: 'credential-a',
    secret: Buffer.from('runtime-secret'),
  });
  await service.setProviderAccountValidation(tenantReference(), 'verified');
  await service.activateProviderAccount(tenantReference());
  await service.setProviderCredentialValidation({ ...tenantReference(), credentialId: 'credential-a' }, 'verified');
  const runtime = new ProviderCredentialAccessService(repository, kms, {
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  });
  const grant = credentialGrant();

  repository.dispatchProof = createTenantDispatchProof(repository, {
    evidence: { status: 'registered', claimedAttemptId: null, claimedAt: null },
  });
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );

  repository.dispatchProof = createTenantDispatchProof(repository, {
    attempt: { preparedEvidenceId: 'different-evidence' },
  });
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );
});

test('runtime access rejects revoked and stale credential authority snapshots', async () => {
  const { repository, kms, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount());
  await service.createProviderCredential({
    account: tenantReference(),
    id: 'credential-a',
    secret: Buffer.from('runtime-secret'),
  });
  await service.setProviderAccountValidation(tenantReference(), 'verified');
  await service.activateProviderAccount(tenantReference());
  await service.setProviderCredentialValidation({ ...tenantReference(), credentialId: 'credential-a' }, 'verified');
  const runtime = new ProviderCredentialAccessService(repository, kms, {
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  });
  const grant = credentialGrant();

  repository.dispatchProof = createTenantDispatchProof(repository, {
    account: { status: 'revoked' },
  });
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );

  repository.dispatchProof = createTenantDispatchProof(repository, {
    credential: { currentVersion: 2 },
  });
  await assert.rejects(
    runtime.withCredential(grant, () => 'not-reached'),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );
});
