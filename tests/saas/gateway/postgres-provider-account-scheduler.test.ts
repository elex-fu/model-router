import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  PostgresProviderAccountScheduler,
  type PostgresProviderAccountSchedulerOptions,
} from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import type { ProviderAccountSchedulerHealthPort } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
} from '../../../src/saas/gateway/request-preparation-service.js';

type Mode = 'byok' | 'platform';
type Row = Record<string, unknown>;

const NOW = new Date('2026-09-28T00:00:00.000Z');
const HEALTHY: ProviderAccountSchedulerHealthPort = {
  async get() {
    return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
  },
};

function caller(mode: Mode): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: mode,
    modelScopes: ['public-model'],
    authzVersion: 2,
    entitlementVersion: 4,
    supplyProfileVersion: 3,
    modelScopeVersion: 5,
  };
}

function entitlement(mode: Mode): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 4,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 3,
    supplyMode: mode,
    modelScopeVersion: 5,
    allowedModels: ['public-model'],
    allowedProviderIds: mode === 'byok' ? ['provider-a'] : [],
    projectPolicyVersion: 6,
  };
}

function candidate(mode: Mode, accountId = 'account-a'): RequestPreparationCandidateAuthority {
  const common = {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    supplyProfileId: 'profile-a',
    accountId,
    credentialId: `credential-${accountId}`,
    credentialVersion: 2,
    credentialAuthzVersion: 9,
    accountAuthzVersion: 4,
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: 3,
    resolvedModel: 'provider-model-a',
    protocol: 'openai' as const,
    endpoint: 'https://catalog.example/v1',
    supplierCostVersion: mode === 'platform' ? 'cost-v2' : null,
    providerId: 'provider-a',
    productId: 'product-a',
  };
  if (mode === 'byok') {
    return {
      ...common,
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      upstreamId: 'tenant-route-a',
      profileAccountAuthzVersion: 5,
    };
  }
  return {
    ...common,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    upstreamId: 'pool-a',
    poolId: 'pool-a',
    poolAuthzVersion: 2,
    poolMemberAccountAuthzVersion: 4,
    poolMemberAuthzVersion: 6,
    poolGrantAuthzVersion: 7,
    poolGrantProfileAuthzVersion: 3,
    poolGrantPoolAuthzVersion: 2,
  };
}

function routeRow(mode: Mode, providerId = 'provider-a'): Row {
  return {
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    route_id: 'route-a',
    current_version: '8',
    route_version: '8',
    route_status: 'active',
    public_model_id: 'public-model-id',
    public_model_version: 11,
    protocol: 'openai',
    supply_mode: mode,
    target_mode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    upstream_id: mode === 'byok' ? 'tenant-route-a' : 'pool-a',
    endpoint: 'https://catalog.example/v1',
    public_model_alias: 'public-model',
    public_model_status: 'active',
    public_model_version_status: 'active',
    provider_id: providerId,
    product_id: providerId === 'provider-a' ? 'product-a' : 'foreign-product',
    model: 'provider-model-a',
  };
}

function eligibilityRow(mode: Mode, accountId = 'account-a'): Row {
  const common: Row = {
    product_status: 'active',
    profile_tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    profile_supply_mode: mode,
    profile_status: 'active',
    profile_authz_version: '3',
    profile_model_scopes: ['public-model'],
    account_owner_kind: mode === 'byok' ? 'tenant' : 'platform',
    account_supply_mode: mode,
    account_id: accountId,
    account_provider_id: 'provider-a',
    account_product_id: 'product-a',
    account_credential_type: 'api-key',
    account_region: 'us-east-1',
    account_purpose: 'inference',
    account_rights_id: 'account-rights-a',
    account_rights_version: 8,
    account_status: 'active',
    account_validation_state: 'verified',
    account_authz_version: '4',
    credential_owner_kind: mode === 'byok' ? 'tenant' : 'platform',
    credential_supply_mode: mode,
    credential_id: `credential-${accountId}`,
    credential_account_id: accountId,
    credential_provider_id: 'provider-a',
    credential_product_id: 'product-a',
    credential_type: 'api-key',
    credential_status: 'active',
    credential_validation_state: 'verified',
    credential_current_version: '2',
    credential_expires_at: null,
    credential_authz_version: '9',
    version_owner_kind: mode === 'byok' ? 'tenant' : 'platform',
    version_supply_mode: mode,
    version_credential_id: `credential-${accountId}`,
    credential_version: 2,
    version_status: 'active',
    version_expires_at: null,
    account_rights_provider_id: 'provider-a',
    account_rights_product_id: 'product-a',
    account_rights_credential_type: 'api-key',
    account_rights_supply_mode: mode,
    account_rights_region: 'us-east-1',
    account_rights_purpose: 'inference',
    account_rights_model_scope: ['provider-model-a'],
    account_rights_endpoint_scope: ['https://catalog.example/v1'],
    account_rights_status: 'active',
    selected_account_rights_version: 8,
    account_rights_effective_at: '2026-01-01T00:00:00.000Z',
    account_rights_expires_at: null,
    capability_version: 12,
    capability_protocol: 'openai',
    capability_support_level: 'supported',
    capability_validation_state: 'verified',
    account_capability_version: '12',
  };
  if (mode === 'byok') {
    return {
      ...common,
      mapping_tenant_id: 'tenant-a',
      mapping_profile_id: 'profile-a',
      mapping_supply_mode: 'byok',
      mapping_account_id: accountId,
      mapping_provider_id: 'provider-a',
      mapping_product_id: 'product-a',
      mapping_account_authz_version: 4,
      mapping_status: 'active',
      mapping_effective_at: '2026-01-01T00:00:00.000Z',
      mapping_expires_at: null,
      mapping_authz_version: 5,
    };
  }
  return {
    ...common,
    pool_id: 'pool-a',
    pool_provider_id: 'provider-a',
    pool_product_id: 'product-a',
    pool_credential_type: 'api-key',
    pool_region: 'us-east-1',
    pool_purpose: 'inference',
    pool_rights_id: 'pool-rights-a',
    pool_rights_version: 10,
    pool_status: 'active',
    pool_validation_state: 'verified',
    pool_authz_version: 2,
    member_pool_id: 'pool-a',
    member_account_id: accountId,
    member_provider_id: 'provider-a',
    member_product_id: 'product-a',
    member_status: 'active',
    member_account_authz_version: 4,
    member_authz_version: 6,
    grant_tenant_id: 'tenant-a',
    grant_profile_id: 'profile-a',
    grant_supply_mode: 'platform',
    grant_status: 'active',
    grant_effective_at: '2026-01-01T00:00:00.000Z',
    grant_expires_at: null,
    grant_authz_version: 7,
    grant_profile_authz_version: 3,
    grant_pool_authz_version: 2,
    pool_rights_provider_id: 'provider-a',
    pool_rights_product_id: 'product-a',
    pool_rights_credential_type: 'api-key',
    pool_rights_supply_mode: 'platform',
    pool_rights_region: 'us-east-1',
    pool_rights_purpose: 'inference',
    pool_rights_model_scope: ['provider-model-a'],
    pool_rights_endpoint_scope: ['https://catalog.example/v1'],
    pool_rights_status: 'active',
    selected_pool_rights_version: 10,
    pool_rights_effective_at: '2026-01-01T00:00:00.000Z',
    pool_rights_expires_at: null,
  };
}

interface FakeDatabaseState {
  readonly mode: Mode;
  routeRows?: Row[];
  readonly eligibilityRows?: ReadonlyMap<string, Row[]>;
  readonly inFlight?: ReadonlyMap<string, unknown>;
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
}

class FakeDatabase implements SaasDatabase {
  constructor(private readonly state: FakeDatabaseState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    let rows: Row[] = [];
    if (sql.includes('postgres-provider-account-scheduler:route')) {
      rows = this.state.routeRows ?? [routeRow(this.state.mode)];
    } else if (sql.includes('postgres-provider-account-scheduler:byok-eligibility')) {
      const accountId = String(values[2]);
      rows = this.state.eligibilityRows?.get(accountId) ?? [eligibilityRow('byok', accountId)];
    } else if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) {
      const accountId = String(values[3]);
      rows = this.state.eligibilityRows?.get(accountId) ?? [eligibilityRow('platform', accountId)];
    } else if (sql.includes('postgres-provider-account-scheduler:concurrency')) {
      rows = [{ in_flight: this.state.inFlight?.get(String(values[2])) ?? '0' }];
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 100)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function setup(
  mode: Mode,
  overrides: Partial<FakeDatabaseState> = {},
  optionOverrides: Partial<PostgresProviderAccountSchedulerOptions> = {},
) {
  const state: FakeDatabaseState = {
    mode,
    statements: [],
    ...overrides,
  };
  const database = new FakeDatabase(state);
  const options: PostgresProviderAccountSchedulerOptions = {
    database,
    leaseConcurrencyLimit: 2,
    health: HEALTHY,
    now: () => NOW,
    maxHealthAgeMs: 60_000,
    ...optionOverrides,
  };
  const scheduler = new PostgresProviderAccountScheduler(options);
  const input = (
    candidates: readonly RequestPreparationCandidateAuthority[],
    scheduling?: { previousResponseId?: string },
  ) => ({
    requestId: 'request-a',
    caller: caller(mode),
    entitlement: entitlement(mode),
    candidates,
    publicModel: 'public-model',
    protocol: 'openai' as const,
    scheduling,
  });
  return { scheduler, state, database, input };
}

test('PostgreSQL scheduler admits only persisted BYOK and platform account authority', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { scheduler, state, input } = setup(mode);
      const result = await scheduler.select(input([candidate(mode)]));
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');

      const routeSql = state.statements.find(({ sql }) => sql.includes(':route'))?.sql;
      const eligibilitySql = state.statements.find(({ sql }) => sql.includes('eligibility'))?.sql;
      assert.ok(routeSql?.includes('saas_route_config_heads'));
      assert.ok(routeSql?.includes('h.current_version'));
      assert.ok(eligibilitySql?.includes('saas_provider_rights'));
      assert.ok(eligibilitySql?.includes('saas_provider_capabilities'));
      assert.ok(eligibilitySql?.includes("validation_state = 'verified'"));
      assert.ok(
        eligibilitySql?.includes(
          mode === 'byok'
            ? 'rights.version = account.rights_version'
            : 'account_rights.version = account.rights_version',
        ),
      );
      assert.ok(eligibilitySql?.includes('account_capability.capability_version = capability.version'));
      assert.ok(
        eligibilitySql?.includes(
          mode === 'byok' ? 'saas_tenant_provider_supply_profile_accounts' : 'saas_platform_provider_pool_grants',
        ),
      );
      if (mode === 'platform') {
        assert.ok(eligibilitySql?.includes('saas_platform_provider_pool_members'));
        assert.ok(eligibilitySql?.includes('pool_rights.version = pool.rights_version'));
      }
      assert.ok(!eligibilitySql?.includes('wrapped_dek'));
      assert.ok(!eligibilitySql?.includes('ciphertext'));
    });
  }
});

test('missing rights, inactive supply, unverified capability, and ambiguous authority fail closed', async (t) => {
  await t.test('missing rights or supply relation yields no eligible candidate', async () => {
    const { scheduler, input } = setup('byok', { eligibilityRows: new Map([['account-a', []]]) });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  });

  await t.test('limited capability is not dispatchable by this scheduler contract', async () => {
    const row = eligibilityRow('byok');
    row.capability_support_level = 'limited';
    const { scheduler, input } = setup('byok', { eligibilityRows: new Map([['account-a', [row]]]) });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'reject');
  });

  await t.test('disabled account is not rescued by an otherwise valid credential', async () => {
    const row = eligibilityRow('byok');
    row.account_status = 'disabled';
    const { scheduler, input } = setup('byok', { eligibilityRows: new Map([['account-a', [row]]]) });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'reject');
  });

  await t.test('duplicate eligibility authority blocks rather than choosing a row', async () => {
    const row = eligibilityRow('platform');
    const { scheduler, input } = setup('platform', {
      eligibilityRows: new Map([['account-a', [row, { ...row, selected_pool_rights_version: 11 }]]]),
    });
    const result = await scheduler.select(input([candidate('platform')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /ambiguous/i);
  });
});

test('missing or ambiguous active route blocks and cross-provider candidates cannot fall through', async (t) => {
  await t.test('missing route', async () => {
    const { scheduler, input } = setup('byok', { routeRows: [] });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /route authority is missing/);
  });

  await t.test('ambiguous route', async () => {
    const route = routeRow('byok');
    const { scheduler, input } = setup('byok', { routeRows: [route, { ...route, route_id: 'route-b' }] });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /route authority is ambiguous/);
  });

  await t.test('cross-provider candidate is denied without querying its account', async () => {
    const { scheduler, state, input } = setup('byok');
    const foreign = { ...candidate('byok'), providerId: 'provider-b', productId: 'product-b' };
    const result = await scheduler.select(input([foreign]));
    assert.equal(result.decision, 'reject');
    assert.equal(
      state.statements.some(({ sql }) => sql.includes('eligibility')),
      false,
    );
  });
});

test('runtime health is mandatory and account validation is not used as a health default', async () => {
  const state: FakeDatabaseState = { mode: 'platform', statements: [] };
  const scheduler = new PostgresProviderAccountScheduler({
    database: new FakeDatabase(state),
    leaseConcurrencyLimit: 2,
    now: () => NOW,
  });
  const result = await scheduler.select({
    requestId: 'request-a',
    caller: caller('platform'),
    entitlement: entitlement('platform'),
    candidates: [candidate('platform')],
    publicModel: 'public-model',
    protocol: 'openai',
  });
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') {
    assert.match(result.message, /health authority is missing/);
    assert.match(result.message, /validation_state is not runtime health/);
  }
});

test('authoritative unhealthy state excludes an otherwise eligible account', async () => {
  const { scheduler, input } = setup(
    'platform',
    {},
    {
      health: {
        async get() {
          return { decision: 'allow', value: { status: 'unhealthy', observedAt: NOW } };
        },
      },
    },
  );
  const result = await scheduler.select(input([candidate('platform')]));
  assert.equal(result.decision, 'reject');
});

test('concurrency requires the lease service limit and denies a full observed account', async (t) => {
  await t.test('missing shared lease configuration blocks', async () => {
    const state: FakeDatabaseState = { mode: 'platform', statements: [] };
    const scheduler = new PostgresProviderAccountScheduler({
      database: new FakeDatabase(state),
      health: HEALTHY,
      now: () => NOW,
    });
    const result = await scheduler.select({
      requestId: 'request-a',
      caller: caller('platform'),
      entitlement: entitlement('platform'),
      candidates: [candidate('platform')],
      publicModel: 'public-model',
      protocol: 'openai',
    });
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /same maxConcurrency as the lease service/);
  });

  await t.test('full lease slots are excluded using the owner boundary', async () => {
    const { scheduler, state, input } = setup('byok', { inFlight: new Map([['account-a', '2']]) });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'reject');
    const query = state.statements.find(({ sql }) => sql.includes(':concurrency'));
    assert.deepEqual(query?.values, ['tenant', 'tenant-a', 'account-a']);
    assert.match(query?.sql ?? '', /lease_expires_at > clock_timestamp\(\)/);
    assert.doesNotMatch(query?.sql ?? '', /INSERT|UPDATE/i);
  });
});

test('affinity references block when there is no persisted affinity authority', async () => {
  const { scheduler, input } = setup('platform');
  const result = await scheduler.select(input([candidate('platform')], { previousResponseId: 'response-opaque' }));
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /no persisted session\/response-to-account mapping/);
});

test('selection is deterministic across candidate ordering and exposes no credential plaintext', async () => {
  const rows = new Map([
    ['account-a', [eligibilityRow('platform', 'account-a')]],
    ['account-b', [eligibilityRow('platform', 'account-b')]],
  ]);
  const first = setup('platform', { eligibilityRows: rows });
  const second = setup('platform', { eligibilityRows: rows });
  const candidates = [candidate('platform', 'account-a'), candidate('platform', 'account-b')];
  const firstResult = await first.scheduler.select(first.input(candidates));
  const secondResult = await second.scheduler.select(second.input([...candidates].reverse()));
  assert.equal(firstResult.decision, 'allow');
  assert.equal(secondResult.decision, 'allow');
  if (firstResult.decision === 'allow' && secondResult.decision === 'allow') {
    assert.equal(firstResult.value.accountId, secondResult.value.accountId);
    assert.equal(JSON.stringify(firstResult.value).includes('plaintext'), false);
  }
  const sql = first.state.statements.map(({ sql: statement }) => statement).join('\n');
  assert.doesNotMatch(sql, /wrapped_dek|ciphertext|auth_tag|plaintext/i);
});

test('platform lease snapshots use account-wide ownership and an explicit observed limit', async () => {
  const { scheduler, state, input } = setup('platform', { inFlight: new Map([['account-a', '1']]) });
  const result = await scheduler.select(input([candidate('platform')]));
  assert.equal(result.decision, 'allow');
  const query = state.statements.find(({ sql }) => sql.includes(':concurrency'));
  assert.deepEqual(query?.values, ['platform', null, 'account-a']);
  assert.match(query?.sql ?? '', /owner_tenant_id IS NOT DISTINCT FROM \$2/);
});
