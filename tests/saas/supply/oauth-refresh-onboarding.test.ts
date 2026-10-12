import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import {
  extractOauthMaterialExpiresInSeconds,
  isOauthRefreshBoundCredential,
  oauthRefreshScheduleFromMaterial,
} from '../../../src/saas/supply/oauth-refresh-onboarding.js';
import { oauthRefreshSuccessDelayMs } from '../../../src/saas/supply/oauth-token-refresh-worker.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import type {
  CreateProviderAccountInput,
  CreateTenantByokCredentialInput,
  ProviderCredentialReference,
} from '../../../src/saas/supply/types.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';

// #18a OAuth credential onboarding: creation initializes the migration-094
// refresh schedule only for credentials bound by the R4 fixed adapter registry;
// rotation inherits/rearranges the schedule unless the R4 worker owns the row.

const NOW = new Date('2026-09-28T00:00:00.000Z');
const OAUTH_ACCOUNT = { providerId: 'anthropic', productId: 'claude-code', credentialType: 'oauth' } as const;

type TenantAccountInput = Extract<CreateProviderAccountInput, { ownerKind: 'tenant' }>;
type PlatformAccountInput = Extract<CreateProviderAccountInput, { ownerKind: 'platform' }>;

class DeterministicKms implements ProviderCredentialKms {
  private readonly keys = new Map<string, Buffer>();
  private sequence = 0;

  async generateDataKey(_request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = Buffer.alloc(32, this.sequence + 1);
    const ciphertextBlob = Buffer.from(`wrapped-${this.sequence}`, 'utf8');
    this.sequence += 1;
    this.keys.set(ciphertextBlob.toString('base64url'), Buffer.from(plaintextKey));
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    const key = this.keys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!key) throw new Error('unknown wrapped key');
    return Buffer.from(key);
  }
}

function oauthMaterial(expiresIn?: unknown): Buffer {
  return Buffer.from(
    JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    }),
  );
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

function serviceSetup(repository = new FakeProviderSupplyRepository()): {
  repository: FakeProviderSupplyRepository;
  service: ProviderSupplyPersistenceService;
} {
  const service = new ProviderSupplyPersistenceService(repository, {
    kms: new DeterministicKms(),
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
    supplyProfileResolver: {
      async resolve(_context, mode) {
        return {
          entitlementId: 'entitlement-a',
          profileId: 'profile-a',
          mode,
          allowedModels: ['model-a'],
          entitlementAuthzVersion: 2,
          supplyProfileAuthzVersion: 4,
        };
      },
    },
  });
  return { repository, service };
}

function expectedNext(credentialId: string, expiresInSeconds: number | null): string {
  return new Date(NOW.getTime() + oauthRefreshSuccessDelayMs(credentialId, expiresInSeconds)).toISOString();
}

function credentialReference(
  owner: { ownerKind: 'tenant' | 'platform'; accountId: string },
  credentialId: string,
): ProviderCredentialReference {
  return {
    ownerKind: owner.ownerKind,
    tenantId: owner.ownerKind === 'tenant' ? 'tenant-a' : null,
    accountId: owner.accountId,
    credentialId,
  };
}

test('binding key: only the exact R4 registry triples are OAuth-refreshable', () => {
  assert.equal(isOauthRefreshBoundCredential(OAUTH_ACCOUNT), true);
  assert.equal(
    isOauthRefreshBoundCredential({ providerId: 'openai', productId: 'codex-cli', credentialType: 'oauth' }),
    true,
  );
  // Right provider and product, non-OAuth credential type: not bound.
  assert.equal(
    isOauthRefreshBoundCredential({ providerId: 'anthropic', productId: 'claude-code', credentialType: 'api-key' }),
    false,
  );
  // OAuth credential type on unregistered provider/product pairs: fail-closed.
  assert.equal(
    isOauthRefreshBoundCredential({ providerId: 'anthropic', productId: 'other-product', credentialType: 'oauth' }),
    false,
  );
  assert.equal(
    isOauthRefreshBoundCredential({ providerId: 'other-provider', productId: 'claude-code', credentialType: 'oauth' }),
    false,
  );
});

test('expires_in extraction accepts valid seconds and rejects the malformed without blocking', () => {
  assert.equal(extractOauthMaterialExpiresInSeconds(oauthMaterial(3600)), 3600);
  assert.equal(extractOauthMaterialExpiresInSeconds(oauthMaterial('3600')), 3600);
  assert.equal(extractOauthMaterialExpiresInSeconds(oauthMaterial(31_536_000)), 31_536_000);
  assert.equal(extractOauthMaterialExpiresInSeconds(oauthMaterial(1)), 1);
  for (const malformed of [0, -10, 1.5, 31_536_001, 'abc', '12x', '', true, {}, [], null] as const) {
    assert.equal(extractOauthMaterialExpiresInSeconds(oauthMaterial(malformed)), null, `malformed ${malformed}`);
  }
  // Absent, non-JSON, non-object and invalid UTF-8 material all fall back.
  assert.equal(extractOauthMaterialExpiresInSeconds(oauthMaterial()), null);
  assert.equal(extractOauthMaterialExpiresInSeconds(Buffer.from('not json')), null);
  assert.equal(extractOauthMaterialExpiresInSeconds(Buffer.from('[1,2]')), null);
  assert.equal(extractOauthMaterialExpiresInSeconds(Buffer.from('"text"')), null);
  assert.equal(extractOauthMaterialExpiresInSeconds(Uint8Array.from([0xff, 0xfe])), null);
});

test('first-refresh schedule uses the worker delay semantic against the injected clock', () => {
  assert.deepEqual(oauthRefreshScheduleFromMaterial(oauthMaterial(3600), 'cred-a', NOW), {
    nextRefreshAt: expectedNext('cred-a', 3600),
  });
  // No usable expires_in: the default 1h token TTL, jittered, floored.
  assert.deepEqual(oauthRefreshScheduleFromMaterial(oauthMaterial(), 'cred-a', NOW), {
    nextRefreshAt: expectedNext('cred-a', null),
  });
  assert.deepEqual(oauthRefreshScheduleFromMaterial(oauthMaterial('soon'), 'cred-a', NOW), {
    nextRefreshAt: expectedNext('cred-a', null),
  });
  // Tiny expires_in hits the 60s floor (expires_in x 0.8 = 0.8s < 60s).
  const floored = oauthRefreshScheduleFromMaterial(oauthMaterial(1), 'cred-a', NOW);
  const flooredDelayMs = new Date(floored.nextRefreshAt).getTime() - NOW.getTime();
  assert.ok(flooredDelayMs >= 54_000 && flooredDelayMs <= 66_000, `floored delay ${flooredDelayMs}ms`);
});

test('tenant OAuth credential creation persists idle plus the first-refresh schedule', async () => {
  const { repository, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount({ ...OAUTH_ACCOUNT }));
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'cred-oauth-1',
    secret: oauthMaterial(3600),
  });
  assert.deepEqual(
    repository.oauthRefreshOf(credentialReference({ ownerKind: 'tenant', accountId: 'account-a' }, 'cred-oauth-1')),
    {
      state: 'idle',
      nextRefreshAt: expectedNext('cred-oauth-1', 3600),
      lastRefreshAt: null,
      forceRefreshRequested: false,
      errorCode: null,
    },
  );
});

test('platform OAuth credential creation persists idle plus the first-refresh schedule', async () => {
  const { repository, service } = serviceSetup();
  await service.createProviderAccount(platformAccount({ ...OAUTH_ACCOUNT }));
  await service.createProviderCredential({
    account: { ownerKind: 'platform', tenantId: null, accountId: 'platform-account-a' },
    id: 'cred-oauth-platform',
    secret: oauthMaterial(7200),
  });
  const scheduling = repository.oauthRefreshOf(
    credentialReference({ ownerKind: 'platform', accountId: 'platform-account-a' }, 'cred-oauth-platform'),
  );
  assert.equal(scheduling.state, 'idle');
  assert.equal(scheduling.nextRefreshAt, expectedNext('cred-oauth-platform', 7200));
  assert.equal(scheduling.lastRefreshAt, null);
});

test('tenant BYOK OAuth creation (account + credential atomic path) onboards the schedule', async () => {
  const { repository, service } = serviceSetup();
  const input: CreateTenantByokCredentialInput = {
    context: {
      userId: 'user-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      tenantRole: 'owner',
      projectRole: 'owner',
    },
    account: {
      displayName: 'Customer OAuth',
      ...OAUTH_ACCOUNT,
      region: 'region-a',
      purpose: 'inference',
      rightsId: 'rights-a',
      rightsVersion: 1,
      capability: { model: 'model-a', endpoint: 'chat-completions', version: 3 },
    },
    secret: oauthMaterial(3600),
    evidenceReference: 'evidence-a',
    evidenceSha256: 'a'.repeat(64),
    audit: { actorUserId: 'user-a', entryPoint: 'customer_byok', requestId: 'request-a' },
  };
  const created = await service.createTenantByokCredentialWithAudit(input);
  const scheduling = repository.oauthRefreshOf(
    credentialReference({ ownerKind: 'tenant', accountId: created.account.id }, created.credential.id),
  );
  assert.equal(scheduling.state, 'idle');
  assert.equal(scheduling.nextRefreshAt, expectedNext(created.credential.id, 3600));
});

test('non-OAuth credential creation keeps the NULL oauth shape on both owner paths', async () => {
  const { repository, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount());
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'cred-api-key',
    secret: Buffer.from('plain-api-key'),
  });
  assert.deepEqual(
    repository.oauthRefreshOf(credentialReference({ ownerKind: 'tenant', accountId: 'account-a' }, 'cred-api-key')),
    { state: null, nextRefreshAt: null, lastRefreshAt: null, forceRefreshRequested: false, errorCode: null },
  );

  await service.createProviderAccount(platformAccount());
  await service.createProviderCredential({
    account: { ownerKind: 'platform', tenantId: null, accountId: 'platform-account-a' },
    id: 'cred-api-key-platform',
    secret: Buffer.from('plain-api-key'),
  });
  assert.equal(
    repository.oauthRefreshOf(
      credentialReference({ ownerKind: 'platform', accountId: 'platform-account-a' }, 'cred-api-key-platform'),
    ).state,
    null,
  );
  // The OAuth credential type on an unregistered provider/product pair is not
  // onboarded either: the registry triple is the binding key, not the type.
  await service.createProviderAccount(
    tenantAccount({ id: 'account-b', providerId: 'anthropic', productId: 'unknown-product', credentialType: 'oauth' }),
  );
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-b' },
    id: 'cred-oauth-unregistered',
    secret: oauthMaterial(3600),
  });
  assert.equal(
    repository.oauthRefreshOf(
      credentialReference({ ownerKind: 'tenant', accountId: 'account-b' }, 'cred-oauth-unregistered'),
    ).state,
    null,
  );
});

test('malformed expires_in never blocks creation and falls back to the default TTL', async () => {
  const { repository, service } = serviceSetup();
  await service.createProviderAccount(tenantAccount({ ...OAUTH_ACCOUNT }));
  const created = await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'cred-oauth-malformed',
    secret: oauthMaterial('soon'),
  });
  assert.equal(created.version.version, 1);
  const scheduling = repository.oauthRefreshOf(
    credentialReference({ ownerKind: 'tenant', accountId: 'account-a' }, 'cred-oauth-malformed'),
  );
  assert.equal(scheduling.state, 'idle');
  assert.equal(scheduling.nextRefreshAt, expectedNext('cred-oauth-malformed', null));
});

async function createdOauthCredential(repository: FakeProviderSupplyRepository) {
  const { service } = serviceSetup(repository);
  await service.createProviderAccount(tenantAccount({ ...OAUTH_ACCOUNT }));
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'cred-oauth-rotate',
    secret: oauthMaterial(3600),
  });
  const reference = credentialReference({ ownerKind: 'tenant', accountId: 'account-a' }, 'cred-oauth-rotate');
  return { service, reference };
}

test('rotation of an idle OAuth credential rearranges the schedule from the new material', async () => {
  const repository = new FakeProviderSupplyRepository();
  const { service, reference } = await createdOauthCredential(repository);
  const rotated = await service.replaceProviderCredentialSecret({
    credential: reference,
    expectedVersion: 1,
    secret: oauthMaterial(7200),
  });
  assert.equal(rotated.version.version, 2);
  const scheduling = repository.oauthRefreshOf(reference);
  assert.equal(scheduling.state, 'idle');
  assert.equal(scheduling.nextRefreshAt, expectedNext('cred-oauth-rotate', 7200));
  const append = repository.appendedCredentialVersionInputs.at(-1);
  assert.deepEqual(append?.oauthRefreshSchedule, { nextRefreshAt: expectedNext('cred-oauth-rotate', 7200) });
});

test('rotation of a failed OAuth credential resets to idle, clears error and force, keeps the last stamp', async () => {
  const repository = new FakeProviderSupplyRepository();
  const { service, reference } = await createdOauthCredential(repository);
  const lastStamp = '2026-09-27T12:00:00.000Z';
  repository.setOauthRefreshForTest(reference, {
    state: 'failed',
    errorCode: 'provider_timeout',
    forceRefreshRequested: true,
    lastRefreshAt: lastStamp,
  });
  await service.replaceProviderCredentialSecret({
    credential: reference,
    expectedVersion: 1,
    secret: oauthMaterial(7200),
  });
  assert.deepEqual(repository.oauthRefreshOf(reference), {
    state: 'idle',
    nextRefreshAt: expectedNext('cred-oauth-rotate', 7200),
    lastRefreshAt: lastStamp,
    forceRefreshRequested: false,
    errorCode: null,
  });
});

test('rotation of a refreshing OAuth credential passes no schedule and preserves the worker-owned row', async () => {
  const repository = new FakeProviderSupplyRepository();
  const { service, reference } = await createdOauthCredential(repository);
  const workerOwned = {
    state: 'refreshing' as const,
    nextRefreshAt: '2026-09-28T00:30:00.000Z',
    lastRefreshAt: '2026-09-28T00:00:01.000Z',
    forceRefreshRequested: true,
    errorCode: null,
  };
  repository.setOauthRefreshForTest(reference, workerOwned);
  const rotated = await service.replaceProviderCredentialSecret({
    credential: reference,
    expectedVersion: 1,
    secret: oauthMaterial(7200),
  });
  assert.equal(rotated.version.version, 2);
  assert.deepEqual(repository.oauthRefreshOf(reference), workerOwned);
  // The R4 rotation seam runs on the control plane, whose column grants are
  // SELECT-only on oauth_*: no schedule may be passed, keeping the UPDATE
  // byte-identical to pre-#18a.
  const append = repository.appendedCredentialVersionInputs.at(-1);
  assert.ok(append);
  assert.equal('oauthRefreshSchedule' in append, false);
});

test('rotation of a legacy NULL-state OAuth credential keeps the NULL shape', async () => {
  const repository = new FakeProviderSupplyRepository();
  const { service, reference } = await createdOauthCredential(repository);
  repository.setOauthRefreshForTest(reference, { state: null, nextRefreshAt: null });
  await service.replaceProviderCredentialSecret({
    credential: reference,
    expectedVersion: 1,
    secret: oauthMaterial(7200),
  });
  assert.deepEqual(repository.oauthRefreshOf(reference), {
    state: null,
    nextRefreshAt: null,
    lastRefreshAt: null,
    forceRefreshRequested: false,
    errorCode: null,
  });
  const append = repository.appendedCredentialVersionInputs.at(-1);
  assert.ok(append);
  assert.equal('oauthRefreshSchedule' in append, false);
});

test('rotation of a non-OAuth credential never touches the oauth scheduling', async () => {
  const repository = new FakeProviderSupplyRepository();
  const { service } = serviceSetup(repository);
  await service.createProviderAccount(tenantAccount());
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'cred-api-key-rotate',
    secret: Buffer.from('old-key'),
  });
  const reference = credentialReference({ ownerKind: 'tenant', accountId: 'account-a' }, 'cred-api-key-rotate');
  await service.replaceProviderCredentialSecret({
    credential: reference,
    expectedVersion: 1,
    secret: Buffer.from('new-key'),
  });
  assert.deepEqual(repository.oauthRefreshOf(reference), {
    state: null,
    nextRefreshAt: null,
    lastRefreshAt: null,
    forceRefreshRequested: false,
    errorCode: null,
  });
  const append = repository.appendedCredentialVersionInputs.at(-1);
  assert.ok(append);
  assert.equal('oauthRefreshSchedule' in append, false);
});
