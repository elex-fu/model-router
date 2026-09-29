import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderCredentialKms } from '../../../src/saas/credentials/provider-crypto.js';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import { ProviderSupplyService } from '../../../src/saas/supply/index.js';

const NOW = '2026-09-28T00:00:00.000Z';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUDIT = {
  actorUserId: 'user-a',
  entryPoint: 'supply-test',
  sourceIp: '127.0.0.1',
  userAgent: 'test-agent',
  requestId: 'request-a',
} as const;

type Row = Record<string, unknown>;

function pool(id: string): Row {
  return {
    id,
    owner_kind: 'platform',
    supply_mode: 'platform',
    display_name: `Pool ${id}`,
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    region: 'global',
    purpose: 'inference',
    rights_id: 'rights-a',
    rights_version: 1,
    status: 'active',
    validation_state: 'verified',
    validation_error_code: null,
    last_validated_at: NOW,
    authz_version: 3,
    created_at: NOW,
    updated_at: NOW,
    disabled_at: null,
    revoked_at: null,
  };
}

function profile(id: string, supplyMode: 'byok' | 'platform'): Row {
  return {
    tenant_id: 'tenant-a',
    id,
    supply_mode: supplyMode,
    status: 'active',
    authz_version: id === 'profile-a' ? 4 : 5,
  };
}

function account(id: string, owner: 'tenant' | 'platform', authzVersion: number): Row {
  return {
    ...(owner === 'tenant' ? { tenant_id: 'tenant-a' } : {}),
    id,
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    region: 'global',
    purpose: 'inference',
    status: 'active',
    validation_state: 'verified',
    authz_version: authzVersion,
  };
}

function member(accountId: string, authzVersion = 1, status = 'active'): Row {
  return {
    pool_id: 'pool-a',
    account_id: accountId,
    provider_id: 'provider-a',
    product_id: 'product-a',
    account_authz_version: accountId === 'platform-account-b' ? 7 : 2,
    authz_version: authzVersion,
    status,
    created_at: NOW,
    updated_at: NOW,
    disabled_at: status === 'disabled' ? NOW : null,
    revoked_at: status === 'revoked' ? NOW : null,
  };
}

function grant(poolId = 'pool-a', profileId = 'profile-a', authzVersion = 1, status = 'active'): Row {
  return {
    pool_id: poolId,
    tenant_id: 'tenant-a',
    supply_profile_id: profileId,
    supply_mode: 'platform',
    profile_authz_version: profileId === 'profile-a' ? 4 : 5,
    pool_authz_version: 3,
    status,
    effective_at: NOW,
    expires_at: null,
    authz_version: authzVersion,
    evidence_ref: 'evidence://grant',
    evidence_sha256: 'a'.repeat(64),
    created_at: NOW,
    updated_at: NOW,
    disabled_at: status === 'disabled' ? NOW : null,
    revoked_at: status === 'revoked' ? NOW : null,
  };
}

function mapping(accountId = 'tenant-account-a', authzVersion = 1, status = 'active'): Row {
  return {
    tenant_id: 'tenant-a',
    supply_profile_id: 'profile-byok',
    supply_mode: 'byok',
    account_id: accountId,
    provider_id: 'provider-a',
    product_id: 'product-a',
    account_authz_version: accountId === 'tenant-account-b' ? 9 : 4,
    status,
    effective_at: NOW,
    expires_at: null,
    authz_version: authzVersion,
    evidence_ref: 'evidence://mapping',
    evidence_sha256: 'b'.repeat(64),
    created_at: NOW,
    updated_at: NOW,
    disabled_at: status === 'disabled' ? NOW : null,
    revoked_at: status === 'revoked' ? NOW : null,
  };
}

class RelationDatabase implements SaasDatabase {
  readonly statements: Array<{ readonly sql: string; readonly values: readonly unknown[]; readonly tx: number }> = [];
  readonly audits: Array<{ readonly action: string; readonly tx: number }> = [];
  readonly pools = new Map([
    ['pool-a', pool('pool-a')],
    ['pool-b', pool('pool-b')],
  ]);
  readonly profiles = new Map([
    ['profile-a', profile('profile-a', 'platform')],
    ['profile-b', profile('profile-b', 'platform')],
    ['profile-byok', profile('profile-byok', 'byok')],
  ]);
  readonly accounts = new Map([
    ['platform-account-a', account('platform-account-a', 'platform', 2)],
    ['platform-account-b', account('platform-account-b', 'platform', 7)],
    ['tenant-account-a', account('tenant-account-a', 'tenant', 4)],
    ['tenant-account-b', account('tenant-account-b', 'tenant', 9)],
  ]);
  readonly members = new Map([['pool-a/platform-account-a', member('platform-account-a')]]);
  readonly grants = new Map([['pool-a/profile-a', grant()]]);
  readonly mappings = new Map([['profile-byok/tenant-account-a', mapping()]]);
  failOn: RegExp | null = null;
  private nextTransaction = 0;
  private activeTransaction = 0;

  private result<RowType>(rows: RowType[]): SqlResult<RowType> {
    return { rows, rowCount: rows.length };
  }

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push({ sql: normalized, values: [...values], tx: this.activeTransaction });
    if (this.failOn?.test(normalized)) throw new Error('database failure');

    // Fake SQL acceptance only; protocol assertions inspect fence ordering, not PostgreSQL lock behavior.
    if (/^SELECT pg_advisory_xact_lock(?:_shared)?\(/i.test(normalized)) {
      return this.result([]) as SqlResult<RowType>;
    }

    if (normalized.startsWith('INSERT INTO saas_audit_events')) {
      this.audits.push({ action: String(values[3]), tx: this.activeTransaction });
      return this.result([]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_platform_provider_pools')) {
      return this.result([this.pools.get(String(values[0]))].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_supply_profiles')) {
      return this.result([this.profiles.get(String(values[1]))].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_platform_provider_accounts')) {
      return this.result([this.accounts.get(String(values[0]))].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_tenant_provider_accounts')) {
      return this.result([this.accounts.get(String(values[1]))].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_platform_provider_pool_members')) {
      const key = `${String(values[0])}/${String(values[1])}`;
      return this.result([this.members.get(key)].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_platform_provider_pool_grants')) {
      const key = `${String(values[0])}/${String(values[2])}`;
      return this.result([this.grants.get(key)].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }
    if (normalized.includes('FROM saas_tenant_provider_supply_profile_accounts')) {
      const key = `${String(values[1])}/${String(values[2])}`;
      return this.result([this.mappings.get(key)].filter(Boolean) as Row[]) as SqlResult<RowType>;
    }

    if (normalized.startsWith('UPDATE saas_platform_provider_pool_members')) {
      const rebinding = normalized.includes("status = 'revoked'");
      const [first, poolId, accountId, expected] = rebinding
        ? [undefined, values[1], values[2], values[3]]
        : [values[0], values[4], values[5], values[6]];
      const key = `${String(poolId)}/${String(accountId)}`;
      const current = this.members.get(key);
      if (!current || Number(current.authz_version) !== Number(expected)) return this.result([]) as SqlResult<RowType>;
      if (rebinding) {
        current.status = 'revoked';
        current.revoked_at = values[0];
        current.disabled_at = null;
        current.updated_at = values[0];
      } else {
        current.status = String(first);
        current.disabled_at = values[1];
        current.revoked_at = values[2];
        current.updated_at = values[3];
      }
      current.authz_version = Number(current.authz_version) + 1;
      return this.result([current]) as SqlResult<RowType>;
    }
    if (normalized.startsWith('INSERT INTO saas_platform_provider_pool_members')) {
      const [poolId, accountId, providerId, productId, accountEpoch, at] = values;
      const row = member(String(accountId), 1, 'active');
      Object.assign(row, {
        pool_id: poolId,
        provider_id: providerId,
        product_id: productId,
        account_authz_version: accountEpoch,
        created_at: at,
        updated_at: at,
      });
      this.members.set(`${String(poolId)}/${String(accountId)}`, row);
      return this.result([row]) as SqlResult<RowType>;
    }
    if (normalized.startsWith('UPDATE saas_platform_provider_pool_grants')) {
      const rebinding = normalized.includes("status = 'revoked'");
      const first = rebinding ? undefined : values[0];
      const disabledAt = rebinding ? null : values[1];
      const revokedAt = rebinding ? values[0] : values[2];
      const at = rebinding ? values[0] : values[3];
      const poolId = rebinding ? values[1] : values[4];
      const profileId = rebinding ? values[3] : values[6];
      const expected = rebinding ? values[4] : values[7];
      const key = `${String(poolId)}/${String(profileId)}`;
      const current = this.grants.get(key);
      if (!current || Number(current.authz_version) !== Number(expected)) return this.result([]) as SqlResult<RowType>;
      current.status = rebinding ? 'revoked' : String(first);
      current.disabled_at = disabledAt;
      current.revoked_at = revokedAt;
      current.updated_at = at;
      current.authz_version = Number(current.authz_version) + 1;
      return this.result([current]) as SqlResult<RowType>;
    }
    if (normalized.startsWith('INSERT INTO saas_platform_provider_pool_grants')) {
      const [poolId, tenantId, profileId, profileEpoch, poolEpoch, at, expiresAt, evidenceRef, evidenceSha] = values;
      const row = grant(String(poolId), String(profileId), 1, 'active');
      Object.assign(row, {
        tenant_id: tenantId,
        profile_authz_version: profileEpoch,
        pool_authz_version: poolEpoch,
        effective_at: at,
        expires_at: expiresAt,
        evidence_ref: evidenceRef,
        evidence_sha256: evidenceSha,
        created_at: at,
        updated_at: at,
      });
      this.grants.set(`${String(poolId)}/${String(profileId)}`, row);
      return this.result([row]) as SqlResult<RowType>;
    }
    if (normalized.startsWith('UPDATE saas_tenant_provider_supply_profile_accounts')) {
      const rebinding = normalized.includes("status = 'revoked'");
      const first = rebinding ? undefined : values[0];
      const disabledAt = rebinding ? null : values[1];
      const revokedAt = rebinding ? values[0] : values[2];
      const at = rebinding ? values[0] : values[3];
      const profileId = rebinding ? values[2] : values[5];
      const accountId = rebinding ? values[3] : values[6];
      const expected = rebinding ? values[4] : values[7];
      const key = `${String(profileId)}/${String(accountId)}`;
      const current = this.mappings.get(key);
      if (!current || Number(current.authz_version) !== Number(expected)) return this.result([]) as SqlResult<RowType>;
      current.status = rebinding ? 'revoked' : String(first);
      current.disabled_at = disabledAt;
      current.revoked_at = revokedAt;
      current.updated_at = at;
      current.authz_version = Number(current.authz_version) + 1;
      return this.result([current]) as SqlResult<RowType>;
    }
    if (normalized.startsWith('INSERT INTO saas_tenant_provider_supply_profile_accounts')) {
      const [
        tenantId,
        profileId,
        accountId,
        providerId,
        productId,
        accountEpoch,
        effectiveAt,
        expiresAt,
        evidenceRef,
        evidenceSha,
        at,
      ] = values;
      const row = mapping(String(accountId), 1, 'active');
      Object.assign(row, {
        tenant_id: tenantId,
        supply_profile_id: profileId,
        provider_id: providerId,
        product_id: productId,
        account_authz_version: accountEpoch,
        effective_at: effectiveAt,
        expires_at: expiresAt,
        evidence_ref: evidenceRef,
        evidence_sha256: evidenceSha,
        created_at: at,
        updated_at: at,
      });
      this.mappings.set(`${String(profileId)}/${String(accountId)}`, row);
      return this.result([row]) as SqlResult<RowType>;
    }
    throw new Error(`Unexpected relationship SQL: ${normalized}`);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.activeTransaction;
    this.activeTransaction = ++this.nextTransaction;
    try {
      return await work(this);
    } finally {
      this.activeTransaction = previous;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function service(database: RelationDatabase): ProviderSupplyService {
  return new ProviderSupplyService(database, {
    deployment: 'managed-saas',
    environment: 'test',
    kmsKeyId: 'kms/test',
    kms: {} as ProviderCredentialKms,
    now: () => new Date(NOW),
  });
}

function assertSupplyCode(code: string) {
  return (error: unknown): boolean => error instanceof ProviderSupplyError && error.code === code;
}

test('pool member lifecycle is independent CAS, terminal on revoke, and audited in the same transaction', async () => {
  const database = new RelationDatabase();
  const supply = service(database);

  const disabled = await supply.disablePlatformPoolMember({
    poolId: 'pool-a',
    accountId: 'platform-account-a',
    expectedAuthzVersion: 1,
    audit: AUDIT,
  });
  assert.equal(disabled.authzVersion, 2);
  const enabled = await supply.enablePlatformPoolMember({
    poolId: 'pool-a',
    accountId: 'platform-account-a',
    expectedAuthzVersion: 2,
    audit: AUDIT,
  });
  assert.equal(enabled.authzVersion, 3);
  const revoked = await supply.revokePlatformPoolMember({
    poolId: 'pool-a',
    accountId: 'platform-account-a',
    expectedAuthzVersion: 3,
    audit: AUDIT,
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.authzVersion, 4);
  await assert.rejects(
    supply.enablePlatformPoolMember({
      poolId: 'pool-a',
      accountId: 'platform-account-a',
      expectedAuthzVersion: 4,
      audit: AUDIT,
    }),
    assertSupplyCode('ACCOUNT_REVOKED'),
  );

  const memberSelects = database.statements.filter(({ sql }) =>
    sql.includes('FROM saas_platform_provider_pool_members'),
  );
  assert.ok(memberSelects.every(({ sql }) => sql.includes('FOR UPDATE')));
  assert.equal(database.audits.length, 3);
  assert.ok(database.audits.every(({ tx }) => tx > 0));
  assert.equal(new Set(database.audits.map(({ tx }) => tx)).size, 3);
  assert.ok(database.statements.some(({ sql }) => sql.includes('authz_version = $7')));
});

test('pool grants fence pool and profile policy reads before inserting the relationship', async () => {
  const database = new RelationDatabase();
  await service(database).grantPlatformPoolToProfile({
    poolId: 'pool-b',
    tenantId: TENANT_ID,
    supplyProfileId: 'profile-b',
    evidenceReference: 'approval-1',
    evidenceSha256: 'c'.repeat(64),
  });

  const statements = database.statements.map(({ sql }) => sql.toLowerCase());
  const poolFence = statements.findIndex(
    (sql, index) =>
      sql.includes('pg_advisory_xact_lock(') &&
      !sql.includes('_shared') &&
      sql.includes('$1::text') &&
      database.statements[index]?.values[0] === saasAdvisoryKey.platformPool('pool-b'),
  );
  const poolRead = statements.findIndex((sql) => sql.includes('from saas_platform_provider_pools'));
  const profileFence = statements.findIndex(
    (sql, index) =>
      sql.includes('pg_advisory_xact_lock(') &&
      !sql.includes('_shared') &&
      sql.includes('$1::text') &&
      database.statements[index]?.values[0] === saasAdvisoryKey.supplyProfile(TENANT_ID, 'profile-b'),
  );
  const profileRead = statements.findIndex((sql) => sql.includes('from saas_supply_profiles'));
  const grantInsert = statements.findIndex((sql) => sql.startsWith('insert into saas_platform_provider_pool_grants'));
  assert.ok(poolFence >= 0 && poolFence < poolRead);
  assert.ok(poolRead < profileFence && profileFence < profileRead && profileRead < grantInsert);
});

test('pool member rebind revokes old identity and captures the replacement account epoch', async () => {
  const database = new RelationDatabase();
  const rebound = await service(database).rebindPlatformPoolMember({
    poolId: 'pool-a',
    accountId: 'platform-account-a',
    newAccountId: 'platform-account-b',
    expectedAuthzVersion: 1,
    audit: AUDIT,
  });

  assert.equal(rebound.accountId, 'platform-account-b');
  assert.equal(rebound.accountAuthzVersion, 7);
  assert.equal(rebound.authzVersion, 1);
  assert.equal(database.members.get('pool-a/platform-account-a')?.status, 'revoked');
  assert.equal(database.members.get('pool-a/platform-account-a')?.authz_version, 2);
  assert.equal(database.audits[0]?.action, 'provider_pool_member.rebound');
  assert.equal(
    database.statements.some(({ sql }) => sql.includes('FOR SHARE')),
    false,
  );
  assert.ok(database.statements.some(({ sql }) => sql.includes("status = 'revoked'")));

  const poolFenceIndex = database.statements.findIndex(
    ({ sql, values }) =>
      sql.includes('pg_advisory_xact_lock(') &&
      !sql.includes('_shared') &&
      values[0] === saasAdvisoryKey.platformPool('pool-a'),
  );
  const poolReadIndex = database.statements.findIndex(({ sql }) => sql.includes('FROM saas_platform_provider_pools'));
  const accountRead = database.statements.find(({ sql }) => sql.includes('FROM saas_platform_provider_accounts'));
  assert.ok(poolFenceIndex >= 0 && poolFenceIndex < poolReadIndex);
  assert.match(database.statements[poolReadIndex]?.sql ?? '', /FOR UPDATE/i);
  assert.match(accountRead?.sql ?? '', /FOR UPDATE/i);
});

test('BYOK mapping lifecycle and rebind use the existing relationship epoch with explicit CAS', async () => {
  const database = new RelationDatabase();
  database.mappings.clear();
  const supply = service(database);
  const created = await supply.createTenantProviderSupplyProfileAccount({
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-byok',
    accountId: 'tenant-account-a',
    evidenceReference: 'evidence://mapping',
    evidenceSha256: 'b'.repeat(64),
    audit: AUDIT,
  });
  assert.equal(created.accountAuthzVersion, 4);
  assert.equal(created.authzVersion, 1);
  const profileFenceIndex = database.statements.findIndex(
    ({ sql, values }) =>
      sql.includes('pg_advisory_xact_lock(') &&
      !sql.includes('_shared') &&
      values[0] === saasAdvisoryKey.supplyProfile('tenant-a', 'profile-byok'),
  );
  const profileReadIndex = database.statements.findIndex(({ sql }) => sql.includes('FROM saas_supply_profiles'));
  assert.ok(profileFenceIndex >= 0 && profileFenceIndex < profileReadIndex);
  assert.match(database.statements[profileReadIndex]?.sql ?? '', /FOR UPDATE/i);
  const disabled = await supply.disableTenantProviderSupplyProfileAccount({
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-byok',
    accountId: 'tenant-account-a',
    expectedAuthzVersion: 1,
    audit: AUDIT,
  });
  assert.equal(disabled.authzVersion, 2);
  await assert.rejects(
    supply.enableTenantProviderSupplyProfileAccount({
      tenantId: 'tenant-a',
      supplyProfileId: 'profile-byok',
      accountId: 'tenant-account-a',
      expectedAuthzVersion: 1,
      audit: AUDIT,
    }),
    assertSupplyCode('CREDENTIAL_STATE_CONFLICT'),
  );

  const rebindDb = new RelationDatabase();
  const rebound = await service(rebindDb).rebindTenantProviderSupplyProfileAccount({
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-byok',
    accountId: 'tenant-account-a',
    newAccountId: 'tenant-account-b',
    expectedAuthzVersion: 1,
    audit: AUDIT,
  });
  assert.equal(rebound.accountId, 'tenant-account-b');
  assert.equal(rebound.accountAuthzVersion, 9);
  assert.equal(rebindDb.mappings.get('profile-byok/tenant-account-a')?.status, 'revoked');
  assert.equal(rebindDb.audits[0]?.action, 'tenant_profile_account.rebound');
});

test('platform grant lifecycle and rebind use explicit CAS and do not refresh old grants', async () => {
  const database = new RelationDatabase();
  const supply = service(database);
  const disabled = await supply.disablePlatformPoolGrant({
    poolId: 'pool-a',
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-a',
    expectedAuthzVersion: 1,
    audit: AUDIT,
  });
  assert.equal(disabled.authzVersion, 2);
  const enabled = await supply.enablePlatformPoolGrant({
    poolId: 'pool-a',
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-a',
    expectedAuthzVersion: 2,
    audit: AUDIT,
  });
  assert.equal(enabled.authzVersion, 3);
  const revoked = await supply.revokePlatformPoolGrant({
    poolId: 'pool-a',
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-a',
    expectedAuthzVersion: 3,
    audit: AUDIT,
  });
  assert.equal(revoked.status, 'revoked');

  const rebindDb = new RelationDatabase();
  const rebound = await service(rebindDb).rebindPlatformPoolGrant({
    poolId: 'pool-a',
    tenantId: 'tenant-a',
    supplyProfileId: 'profile-a',
    newPoolId: 'pool-b',
    newSupplyProfileId: 'profile-b',
    expectedAuthzVersion: 1,
    audit: AUDIT,
  });
  assert.equal(rebound.poolId, 'pool-b');
  assert.equal(rebound.supplyProfileId, 'profile-b');
  assert.equal(rebound.authzVersion, 1);
  assert.equal(rebindDb.grants.get('pool-a/profile-a')?.status, 'revoked');
  assert.equal(rebindDb.audits[0]?.action, 'provider_pool_grant.rebound');

  const poolFenceIndex = rebindDb.statements.findIndex(
    ({ sql, values }) =>
      sql.includes('pg_advisory_xact_lock(') &&
      !sql.includes('_shared') &&
      values[0] === saasAdvisoryKey.platformPool('pool-b'),
  );
  const poolReadIndex = rebindDb.statements.findIndex(
    ({ sql, values }) => sql.includes('FROM saas_platform_provider_pools') && values[0] === 'pool-b',
  );
  const profileFenceIndex = rebindDb.statements.findIndex(
    ({ sql, values }) =>
      sql.includes('pg_advisory_xact_lock(') &&
      !sql.includes('_shared') &&
      values[0] === saasAdvisoryKey.supplyProfile('tenant-a', 'profile-b'),
  );
  const profileReadIndex = rebindDb.statements.findIndex(
    ({ sql, values }) => sql.includes('FROM saas_supply_profiles') && values[1] === 'profile-b',
  );
  assert.ok(poolFenceIndex >= 0 && poolFenceIndex < poolReadIndex);
  assert.ok(profileFenceIndex >= 0 && profileFenceIndex < profileReadIndex);
  assert.match(rebindDb.statements[poolReadIndex]?.sql ?? '', /FOR UPDATE/i);
  assert.match(rebindDb.statements[profileReadIndex]?.sql ?? '', /FOR UPDATE/i);
});

test('pool member storage failures fail closed', async () => {
  const database = new RelationDatabase();
  database.failOn = /^UPDATE saas_platform_provider_pool_members/;
  await assert.rejects(
    service(database).disablePlatformPoolMember({
      poolId: 'pool-a',
      accountId: 'platform-account-a',
      expectedAuthzVersion: 1,
      audit: AUDIT,
    }),
    assertSupplyCode('SUPPLY_STORAGE_ERROR'),
  );
});
