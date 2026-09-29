import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialKms,
  ProviderCredentialSealingKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import { ProviderSupplyService } from '../../../src/saas/supply/index.js';
import type { CreateProviderAccountInput, ProviderCredentialAccessGrant } from '../../../src/saas/supply/types.js';
import { createTenantDispatchProof, FakeProviderSupplyRepository } from './fake-repository.js';

const NOW = new Date('2026-09-28T00:00:00.000Z');
const SUPPLY_AUDIT = {
  actorUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  entryPoint: 'platform_admin',
  requestId: 'platform_admin_write_test',
  sourceIp: '203.0.113.10',
  userAgent: 'platform-admin-supply-test',
} as const;
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

class SealingOnlyKms implements ProviderCredentialSealingKms {
  readonly generated: GenerateProviderCredentialDataKeyRequest[] = [];
  private sequence = 0;

  async generateDataKey(request: GenerateProviderCredentialDataKeyRequest) {
    this.generated.push(request);
    const plaintextKey = Buffer.alloc(32, this.sequence + 1);
    const ciphertextBlob = Buffer.from(`sealed-${this.sequence}`, 'utf8');
    this.sequence += 1;
    return { plaintextKey, ciphertextBlob };
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

function serviceOptions(repository: FakeProviderSupplyRepository, kms = new DeterministicKms()) {
  return {
    repository,
    kms,
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  } as const;
}

class SchemaAwareDatabase implements SaasDatabase {
  readonly statements: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  memberValues: readonly unknown[] | null = null;
  private grantExists = false;

  private readonly pool = {
    id: 'pool-a',
    owner_kind: 'platform',
    supply_mode: 'platform',
    display_name: 'Platform pool',
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    rights_id: 'rights-platform',
    rights_version: 1,
    status: 'active',
    validation_state: 'verified',
    validation_error_code: null,
    last_validated_at: '2026-09-28T00:00:00.000Z',
    authz_version: 1,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    disabled_at: null,
    revoked_at: null,
  };

  private readonly profile = {
    tenant_id: 'tenant-a',
    id: 'profile-a',
    supply_mode: 'platform',
    status: 'active',
    authz_version: 4,
  };

  private readonly account = {
    id: 'platform-account-a',
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    status: 'active',
    validation_state: 'verified',
    authz_version: 1,
  };

  private readonly grant = {
    pool_id: 'pool-a',
    tenant_id: 'tenant-a',
    supply_profile_id: 'profile-a',
    supply_mode: 'platform',
    profile_authz_version: 4,
    pool_authz_version: 1,
    status: 'active',
    effective_at: '2026-09-28T00:00:00.000Z',
    expires_at: null,
    authz_version: 1,
    evidence_ref: 'evidence://grant-a',
    evidence_sha256: 'a'.repeat(64),
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    disabled_at: null,
    revoked_at: null,
  };

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push({ sql: normalized, values: [...values] });
    assert.doesNotMatch(
      normalized,
      /product_evidence|rights_evidence|capability_evidence|credential_wrappings|active_wrapping_revision|\bdeployment\b|\benvironment\b/,
      `retired provider-supply schema in SQL: ${normalized}`,
    );

    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO saas_platform_provider_pools')) {
      return { rows: [this.pool] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM saas_platform_provider_pools')) {
      return { rows: [this.pool] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM saas_platform_provider_accounts')) {
      return { rows: [this.account] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO saas_platform_provider_pool_members')) {
      assert.match(normalized, /pool_id, account_id, provider_id, product_id, account_authz_version/);
      this.memberValues = [...values];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM saas_supply_profiles')) {
      return { rows: [this.profile] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO saas_platform_provider_pool_grants')) {
      this.grantExists = true;
      return { rows: [this.grant] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM saas_platform_provider_pool_grants')) {
      return this.grantExists ? { rows: [this.grant] as Row[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('UPDATE saas_platform_provider_pool_grants')) {
      return {
        rows: [{ ...this.grant, status: 'revoked', authz_version: 2, revoked_at: NOW.toISOString() }] as Row[],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected schema-fixture SQL: ${normalized}`);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

test('exported service delegates normalized account/capability and credential persistence', async () => {
  const repository = new FakeProviderSupplyRepository();
  const kms = new DeterministicKms();
  const service = new ProviderSupplyService({} as SaasDatabase, serviceOptions(repository, kms));

  const account = await service.createProviderAccount(tenantAccount());
  assert.deepEqual(account.capabilities, [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }]);
  assert.deepEqual(await service.getProviderAccount('account-a'), account);
  assert.deepEqual(repository.accounts[0]?.capabilities, account.capabilities);

  await service.setProviderAccountValidation({ accountId: 'account-a', validationState: 'verified' });
  const credential = await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'credential-a',
    secret: Buffer.from('first-secret'),
  });
  await service.setProviderCredentialValidation({ credentialId: 'credential-a', validationState: 'verified' });
  repository.dispatchProof = createTenantDispatchProof(repository);

  const initialGrant: ProviderCredentialAccessGrant = {
    evidenceId: 'evidence-a',
  };
  assert.equal(await service.withProviderCredential(initialGrant, (secret) => secret.toString('utf8')), 'first-secret');
  assert.equal((await service.getProviderCredentialVersion('credential-a', 1)).wrappingRevision, 1);

  const replaced = await service.replaceProviderCredentialSecret({
    credential: {
      ownerKind: 'tenant',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      credentialId: 'credential-a',
    },
    expectedVersion: 1,
    secret: Buffer.from('second-secret'),
  });
  assert.equal(replaced.version.version, 2);
  await service.setProviderCredentialValidation({ credentialId: 'credential-a', validationState: 'verified' });
  repository.dispatchProof = createTenantDispatchProof(repository);
  assert.equal(
    await service.withProviderCredential(initialGrant, (secret) => secret.toString('utf8')),
    'second-secret',
  );
  assert.doesNotMatch(JSON.stringify(repository), /first-secret|second-secret/);
  assert.equal('envelope' in credential.version, false);
});

test('platform management writes carry actor evidence and roll back when the same-transaction audit fails', async () => {
  const repository = new FakeProviderSupplyRepository();
  const service = new ProviderSupplyService({} as SaasDatabase, serviceOptions(repository));
  const input = platformAccount();
  const account = await service.createPlatformProviderAccount({
    id: input.id,
    displayName: input.displayName,
    providerId: input.providerId,
    productId: input.productId,
    credentialType: input.credentialType,
    region: input.region,
    purpose: input.purpose,
    rightsId: input.rightsId,
    rightsVersion: input.rightsVersion,
    capabilities: [input.capability as NonNullable<typeof input.capability>],
    audit: SUPPLY_AUDIT,
  });
  assert.equal(account.ownerKind, 'platform');
  assert.equal(account.tenantId, null);
  assert.equal(repository.auditEvents[0]?.action, 'provider_supply.account.created');
  assert.equal(repository.auditEvents[0]?.audit.actorUserId, SUPPLY_AUDIT.actorUserId);

  const created = await service.createPlatformProviderCredential({
    accountId: account.id,
    id: 'platform-credential-a',
    secret: Buffer.from('platform-secret'),
    audit: SUPPLY_AUDIT,
  });
  assert.equal(created.credential.ownerKind, 'platform');
  assert.equal(created.version.version, 1);
  assert.equal(repository.auditEvents[1]?.action, 'provider_supply.credential.created');
  assert.doesNotMatch(JSON.stringify(repository.auditEvents), /platform-secret/);

  const rotated = await service.replacePlatformProviderCredentialSecret({
    credentialId: created.credential.id,
    expectedVersion: 1,
    secret: Buffer.from('platform-secret-rotated'),
    audit: SUPPLY_AUDIT,
  });
  assert.equal(rotated.version.version, 2);
  assert.equal(repository.auditEvents[2]?.action, 'provider_supply.credential.secret_rotated');

  const credentialBeforeFailure = repository.credentials.find((candidate) => candidate.id === created.credential.id);
  assert.ok(credentialBeforeFailure);
  const versionBeforeFailure = credentialBeforeFailure.currentVersion;
  repository.failAudit = true;
  await assert.rejects(
    service.replacePlatformProviderCredentialSecret({
      credentialId: created.credential.id,
      expectedVersion: 2,
      secret: Buffer.from('must-not-commit'),
      audit: SUPPLY_AUDIT,
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'SUPPLY_STORAGE_ERROR',
  );
  assert.equal(
    repository.credentials.find((candidate) => candidate.id === created.credential.id)?.currentVersion,
    versionBeforeFailure,
  );

  await assert.rejects(
    service.createPlatformProviderAccount({
      id: 'platform-account-audit-failure',
      displayName: input.displayName,
      providerId: input.providerId,
      productId: input.productId,
      credentialType: input.credentialType,
      region: input.region,
      purpose: input.purpose,
      rightsId: input.rightsId,
      rightsVersion: input.rightsVersion,
      capabilities: [input.capability as NonNullable<typeof input.capability>],
      audit: SUPPLY_AUDIT,
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'SUPPLY_STORAGE_ERROR',
  );
  assert.equal(
    repository.accounts.some((candidate) => candidate.id === 'platform-account-audit-failure'),
    false,
  );

  repository.failAudit = false;
  const disabledCredential = await service.disablePlatformProviderCredential({
    credentialId: created.credential.id,
    expectedAuthzVersion: 3,
    audit: SUPPLY_AUDIT,
  });
  assert.equal(disabledCredential.status, 'disabled');
  assert.equal(repository.auditEvents.at(-1)?.action, 'provider_supply.credential.disabled');

  const disabledAccount = await service.disablePlatformProviderAccount({
    accountId: account.id,
    expectedAuthzVersion: 1,
    audit: SUPPLY_AUDIT,
  });
  assert.equal(disabledAccount.status, 'disabled');
  assert.equal(repository.auditEvents.at(-1)?.action, 'provider_supply.account.disabled');

  repository.failAudit = true;
  await assert.rejects(
    service.revokePlatformProviderAccount({
      accountId: account.id,
      expectedAuthzVersion: 2,
      audit: SUPPLY_AUDIT,
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'SUPPLY_STORAGE_ERROR',
  );
  assert.equal(repository.accounts.find((candidate) => candidate.id === account.id)?.status, 'disabled');
});

test('platform credential management works with sealing-only KMS and unseal fails closed without access KMS', async () => {
  const repository = new FakeProviderSupplyRepository();
  const sealingKms = new SealingOnlyKms();
  const service = new ProviderSupplyService({} as SaasDatabase, {
    repository,
    sealingKms,
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  });
  const input = platformAccount();
  const account = await service.createPlatformProviderAccount({
    id: input.id,
    displayName: input.displayName,
    providerId: input.providerId,
    productId: input.productId,
    credentialType: input.credentialType,
    region: input.region,
    purpose: input.purpose,
    rightsId: input.rightsId,
    rightsVersion: input.rightsVersion,
    capabilities: [input.capability as NonNullable<typeof input.capability>],
    audit: SUPPLY_AUDIT,
  });
  const created = await service.createPlatformProviderCredential({
    accountId: account.id,
    id: 'platform-credential-sealing-only',
    secret: Buffer.from('platform-sealing-only-secret'),
    audit: SUPPLY_AUDIT,
  });
  const rotated = await service.replacePlatformProviderCredentialSecret({
    credentialId: created.credential.id,
    expectedVersion: 1,
    secret: Buffer.from('platform-sealing-only-rotated'),
    audit: SUPPLY_AUDIT,
  });

  assert.equal(rotated.version.version, 2);
  assert.equal(sealingKms.generated.length, 2);
  assert.doesNotMatch(JSON.stringify(repository), /platform-sealing-only-secret|platform-sealing-only-rotated/);
  await assert.rejects(
    service.withProviderCredential({ evidenceId: 'evidence-without-access-kms' }, () => 'not-reached'),
    (error: unknown) =>
      error instanceof ProviderSupplyError && error.code === 'KMS_UNSEAL_FAILED' && error.status === 503,
  );
});

test('exported pool operations use only 016 columns and include member provider/product identity', async () => {
  const repository = new FakeProviderSupplyRepository();
  const database = new SchemaAwareDatabase();
  const service = new ProviderSupplyService(database, serviceOptions(repository));
  await service.createProviderAccount(platformAccount());

  const pool = await service.createPlatformProviderPool({
    id: 'pool-a',
    displayName: 'Platform pool',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    rightsId: 'rights-platform',
    rightsVersion: 1,
    capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
    status: 'active',
    validationState: 'verified',
  });
  assert.equal(pool.id, 'pool-a');
  await service.addPlatformPoolMember({ poolId: 'pool-a', accountId: 'platform-account-a' });
  assert.deepEqual(database.memberValues?.slice(0, 4), ['pool-a', 'platform-account-a', 'provider-a', 'product-a']);

  const grant = await service.grantPlatformPoolToProfile({
    poolId: 'pool-a',
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-a',
    evidenceReference: 'evidence://grant-a',
    evidenceSha256: 'a'.repeat(64),
  });
  assert.equal(grant.supplyMode, 'platform');
  const revoked = await service.revokePlatformPoolGrant({
    poolId: 'pool-a',
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-a',
    expectedAuthzVersion: 1,
  });
  assert.equal(revoked.status, 'revoked');
  assert.ok(database.statements.some(({ sql }) => sql.includes('provider_id, product_id')));
});

test('credential rewrap fails closed without an explicit remote KMS rewrap capability', async () => {
  const repository = new FakeProviderSupplyRepository();
  const service = new ProviderSupplyService({} as SaasDatabase, serviceOptions(repository));
  await service.createProviderAccount(tenantAccount());
  await service.setProviderAccountValidation({ accountId: 'account-a', validationState: 'verified' });
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'credential-a',
    secret: Buffer.from('secret'),
  });

  await assert.rejects(
    service.rewrapProviderCredential({
      credential: {
        ownerKind: 'tenant',
        tenantId: 'tenant-a',
        accountId: 'account-a',
        credentialId: 'credential-a',
      },
      version: 1,
      expectedWrappingRevision: 1,
      destinationKmsKeyId: 'kms-new',
      operationId: 'rewrap-op-1',
      audit: {
        actorKind: 'workload',
        actorWorkloadId: 'provider-credential-rewrapper',
        requestId: 'rewrap-request-1',
      },
      reasonCode: 'scheduled_key_rotation',
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'KMS_REWRAP_FAILED',
  );
});
