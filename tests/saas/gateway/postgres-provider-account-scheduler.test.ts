import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import { effectiveWeight } from '../../../src/saas/gateway/health-score.js';
import type {
  ProviderAccountHalfOpenProbeAdmissionPort,
  ProviderAccountHealthSchedulingPort,
  ProviderAccountHealthSchedulingView,
  ProviderAccountRuntimeHealthWriter,
} from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
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
    account_priority: 0,
    account_weight: 1,
    account_quota_state: null,
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
  readonly rateWindows?: ReadonlyMap<string, Row[]>;
  /** F2: resolved billing-group rows; defaults to the seeded neutral group. */
  readonly groupRows?: Row[];
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
}

class FakeDatabase implements SaasDatabase {
  constructor(private readonly state: FakeDatabaseState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    let rows: Row[] = [];
    if (sql.includes('postgres-provider-account-scheduler:billing-group')) {
      rows = this.state.groupRows ?? [{ id: 'default', claude_code_only: false, fallback_group_id: null }];
    } else if (sql.includes('postgres-provider-account-scheduler:route')) {
      rows = this.state.routeRows ?? [routeRow(this.state.mode)];
    } else if (sql.includes('postgres-provider-account-scheduler:byok-eligibility')) {
      const accountId = String(values[2]);
      rows = this.state.eligibilityRows?.get(accountId) ?? [eligibilityRow('byok', accountId)];
    } else if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) {
      const accountId = String(values[3]);
      rows = this.state.eligibilityRows?.get(accountId) ?? [eligibilityRow('platform', accountId)];
    } else if (sql.includes('postgres-provider-account-scheduler:rate-window')) {
      rows = this.state.rateWindows?.get(String(values[1])) ?? [{ requests: '0', tokens: '0' }];
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

test('platform eligibility binds all 23 authority parameters including the member account epoch and the F2 group', async () => {
  const { scheduler, state, input } = setup('platform');
  const platformCandidate = candidate('platform');
  const result = await scheduler.select(input([platformCandidate]));
  assert.equal(result.decision, 'allow');

  const query = state.statements.find(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
  );
  assert.ok(query);
  const parameterSlots = [...new Set(Array.from(query.sql.matchAll(/\$(\d+)\b/g), (match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
  assert.deepEqual(
    parameterSlots,
    Array.from({ length: 23 }, (_, index) => index + 1),
  );
  assert.equal(query.values.length, 23);
  assert.equal(query.values[14], platformCandidate.poolMemberAccountAuthzVersion);
  assert.match(query.sql, /member\.account_authz_version\s*=\s*\$15\b/);
  assert.match(query.sql, /member\.account_authz_version\s*=\s*account\.authz_version\b/);
  // F2: $23 is the server-resolved billing group narrowing the pool domain.
  assert.equal(query.values[22], 'default');
});

test('stale platform member account epochs are rejected', async () => {
  const { scheduler, state, input } = setup('platform');
  const platformCandidate = candidate('platform');
  assert.ok(platformCandidate.supplyMode === 'platform');
  const staleMemberCandidate = { ...platformCandidate, poolMemberAccountAuthzVersion: 3 };
  assert.notEqual(staleMemberCandidate.poolMemberAccountAuthzVersion, staleMemberCandidate.accountAuthzVersion);

  const result = await scheduler.select(input([staleMemberCandidate]));
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  const query = state.statements.find(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
  );
  assert.ok(query);
  assert.equal(query.values[14], staleMemberCandidate.poolMemberAccountAuthzVersion);
  assert.equal(
    state.statements.some(({ sql }) => sql.includes(':concurrency')),
    false,
  );
});

test('platform candidates must target the exact persisted route pool before downstream checks', async () => {
  const genericUpstreamId = 'generic-upstream';
  const route = { ...routeRow('platform'), upstream_id: genericUpstreamId };
  const platformCandidate = { ...candidate('platform'), upstreamId: genericUpstreamId };
  assert.equal(platformCandidate.poolId, 'pool-a');
  assert.notEqual(platformCandidate.poolId, route.upstream_id);
  let healthCalls = 0;
  const { scheduler, state, input } = setup(
    'platform',
    { routeRows: [route] },
    {
      health: {
        async get(healthInput) {
          healthCalls += 1;
          return HEALTHY.get(healthInput);
        },
      },
    },
  );

  const result = await scheduler.select(input([platformCandidate]));
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  // F2: the billing-group resolution runs once before the route read; the
  // candidate is still rejected before any eligibility or concurrency read.
  assert.equal(state.statements.length, 2);
  assert.ok(state.statements[0]?.sql.includes('postgres-provider-account-scheduler:billing-group'));
  assert.ok(state.statements[1]?.sql.includes('postgres-provider-account-scheduler:route'));
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('eligibility') || sql.includes(':concurrency')),
    false,
  );
  assert.equal(healthCalls, 0);
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

test('eligibility SQL reads the persisted contract C-7 scheduling scalars from the account row', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { scheduler, state, input } = setup(mode);
      const result = await scheduler.select(input([candidate(mode)]));
      assert.equal(result.decision, 'allow');
      const eligibilitySql = state.statements.find(({ sql }) => sql.includes('eligibility'))?.sql;
      assert.ok(eligibilitySql?.includes('account.priority AS account_priority'));
      assert.ok(eligibilitySql?.includes('account.weight AS account_weight'));
    });
  }
});

test('eligibility SQL reads the persisted D4 quota signal from the account row', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { scheduler, state, input } = setup(mode);
      const result = await scheduler.select(input([candidate(mode)]));
      assert.equal(result.decision, 'allow');
      const eligibilitySql = state.statements.find(({ sql }) => sql.includes('eligibility'))?.sql;
      assert.ok(eligibilitySql?.includes('account.quota_state AS account_quota_state'));
      // The snapshot is read-only here: the eligibility path never writes it
      // and never joins billing or settlement relations for it.
      assert.doesNotMatch(eligibilitySql ?? '', /quota_remaining_minor_units|ledger|settlement/i);
    });
  }
});

test('an exhausted persisted quota snapshot denies only that candidate', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const rows = new Map([
        ['account-a', [{ ...eligibilityRow(mode, 'account-a'), account_quota_state: 'exhausted' }]],
        ['account-b', [eligibilityRow(mode, 'account-b')]],
      ]);
      const { scheduler, input } = setup(mode, { eligibilityRows: rows });
      const result = await scheduler.select(input([candidate(mode, 'account-a'), candidate(mode, 'account-b')]));
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
    });
  }

  await t.test('every exhausted candidate leaves no eligible account without blocking', async () => {
    const rows = new Map([
      ['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_quota_state: 'exhausted' }]],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a')]));
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  });
});

test('null, unknown, and ok quota snapshots leave scheduling untouched', async (t) => {
  for (const quotaState of [null, 'unknown', 'ok'] as const) {
    await t.test(String(quotaState), async () => {
      const rows = new Map([
        ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_quota_state: quotaState }]],
      ]);
      const { scheduler, input } = setup('platform', { eligibilityRows: rows });
      const result = await scheduler.select(input([candidate('platform', 'account-a')]));
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
    });
  }
});

test('a low persisted quota snapshot demotes but never removes the candidate', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const rows = new Map([['account-a', [{ ...eligibilityRow(mode, 'account-a'), account_quota_state: 'low' }]]]);
      const { scheduler, input } = setup(mode, { eligibilityRows: rows });
      const result = await scheduler.select(input([candidate(mode, 'account-a')]));
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
    });
  }

  await t.test('the demoted weight loses the deterministic draw it would win undemoted', async () => {
    // account-a at weight 9 wins the fixed request-e draw undemoted; a 'low'
    // snapshot demotes it to the contract minimum weight 1, flipping the same
    // deterministic draw to account-b.
    const rows = (quotaState: unknown) =>
      new Map([
        [
          'account-a',
          [{ ...eligibilityRow('platform', 'account-a'), account_weight: 9, account_quota_state: quotaState }],
        ],
        ['account-b', [eligibilityRow('platform', 'account-b')]],
      ]);
    const candidates = [candidate('platform', 'account-a'), candidate('platform', 'account-b')];
    const undemoted = setup('platform', { eligibilityRows: rows(null) });
    const undemotedResult = await undemoted.scheduler.select({
      ...undemoted.input(candidates),
      requestId: 'request-e',
    });
    assert.equal(undemotedResult.decision, 'allow');
    if (undemotedResult.decision === 'allow') assert.equal(undemotedResult.value.accountId, 'account-a');

    const demoted = setup('platform', { eligibilityRows: rows('low') });
    const demotedResult = await demoted.scheduler.select({ ...demoted.input(candidates), requestId: 'request-e' });
    assert.equal(demotedResult.decision, 'allow');
    if (demotedResult.decision === 'allow') assert.equal(demotedResult.value.accountId, 'account-b');
  });
});

test('malformed persisted quota signals block instead of silently defaulting', async (t) => {
  const cases: Array<{ name: string; patch: Row }> = [
    { name: 'unknown string state', patch: { account_quota_state: 'full' } },
    { name: 'wrong case state', patch: { account_quota_state: 'LOW' } },
    { name: 'empty string state', patch: { account_quota_state: '' } },
    { name: 'numeric state', patch: { account_quota_state: 0 } },
    { name: 'boolean state', patch: { account_quota_state: true } },
    { name: 'object state', patch: { account_quota_state: { state: 'low' } } },
    { name: 'array state', patch: { account_quota_state: ['low'] } },
  ];
  for (const { name, patch } of cases) {
    await t.test(name, async () => {
      const row = { ...eligibilityRow('platform'), ...patch };
      const { scheduler, input } = setup('platform', { eligibilityRows: new Map([['account-a', [row]]]) });
      const result = await scheduler.select(input([candidate('platform')]));
      assert.equal(result.decision, 'block');
      if (result.decision === 'block') assert.match(result.message, /quota signal is malformed/);
    });
  }
});

test('persisted priority outranks the neutral tie regardless of candidate order', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const rows = new Map([
        ['account-a', [{ ...eligibilityRow(mode, 'account-a'), account_priority: 7, account_weight: 9 }]],
        ['account-b', [eligibilityRow(mode, 'account-b')]],
      ]);
      const { scheduler, input } = setup(mode, { eligibilityRows: rows });
      const candidates = [candidate(mode, 'account-a'), candidate(mode, 'account-b')];
      const first = await scheduler.select(input(candidates));
      const second = await scheduler.select(input([...candidates].reverse()));
      assert.equal(first.decision, 'allow');
      assert.equal(second.decision, 'allow');
      if (first.decision === 'allow' && second.decision === 'allow') {
        assert.equal(first.value.accountId, 'account-a');
        assert.equal(second.value.accountId, 'account-a');
      }
    });
  }
});

test('a heavier persisted weight wins the deterministic draw within one priority band', async () => {
  // Total weight 1 + 9 = 10; the fixed requestId draws into the heavier row.
  const rows = new Map([
    ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_weight: 9 }]],
    ['account-b', [eligibilityRow('platform', 'account-b')]],
  ]);
  const { scheduler, input } = setup('platform', { eligibilityRows: rows });
  const seen = new Set<string>();
  for (const requestId of ['request-a', 'request-b', 'request-c', 'request-d']) {
    const result = await scheduler.select({
      ...input([candidate('platform', 'account-a'), candidate('platform', 'account-b')]),
      requestId,
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') seen.add(result.value.accountId);
  }
  // The draw is deterministic per requestId; across several draws the heavier
  // account must appear, and no draw may error or fall back to blocking.
  assert.ok(seen.has('account-a'));
});

test('malformed persisted scheduling scalars block instead of silently defaulting', async (t) => {
  const cases: Array<{ name: string; patch: Row }> = [
    { name: 'priority above the contract bound', patch: { account_priority: 1001 } },
    { name: 'negative priority', patch: { account_priority: -1 } },
    { name: 'fractional priority', patch: { account_priority: 0.5 } },
    { name: 'zero weight', patch: { account_weight: 0 } },
    { name: 'weight above the contract bound', patch: { account_weight: 10001 } },
    { name: 'non-numeric weight', patch: { account_weight: 'heavy' } },
    { name: 'null priority', patch: { account_priority: null } },
  ];
  for (const { name, patch } of cases) {
    await t.test(name, async () => {
      const row = { ...eligibilityRow('platform'), ...patch };
      const { scheduler, input } = setup('platform', { eligibilityRows: new Map([['account-a', [row]]]) });
      const result = await scheduler.select(input([candidate('platform')]));
      assert.equal(result.decision, 'block');
      if (result.decision === 'block') assert.match(result.message, /scheduling scalars are malformed/);
    });
  }

  await t.test('text-form scalars within bounds are accepted', async () => {
    const row = { ...eligibilityRow('byok'), account_priority: '1000', account_weight: '10000' };
    const { scheduler, input } = setup('byok', { eligibilityRows: new Map([['account-a', [row]]]) });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'allow');
  });
});

test('eligibility SQL reads the persisted R6 rate limits and R7 health score without extra queries when unset', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { scheduler, state, input } = setup(mode);
      const result = await scheduler.select(input([candidate(mode)]));
      assert.equal(result.decision, 'allow');
      const eligibilitySql = state.statements.find(({ sql }) => sql.includes('eligibility'))?.sql;
      assert.ok(eligibilitySql?.includes('account.rpm_limit AS account_rpm_limit'));
      assert.ok(eligibilitySql?.includes('account.tpm_limit AS account_tpm_limit'));
      assert.ok(eligibilitySql?.includes('health.health_score AS account_health_score'));
      assert.match(eligibilitySql ?? '', /LEFT JOIN saas_provider_account_runtime_health health/);
      // NULL limits keep the pre-R6 path exactly: no window read is issued.
      assert.equal(
        state.statements.some(({ sql }) => sql.includes(':rate-window')),
        false,
      );
    });
  }
});

test('the rate window query is a bounded single-index trailing-minute read with the injected clock', async () => {
  const rows = new Map([['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_rpm_limit: 10 }]]]);
  const { scheduler, state, input } = setup('byok', {
    eligibilityRows: rows,
    rateWindows: new Map([['account-a', [{ requests: '3', tokens: '42' }]]]),
  });
  const result = await scheduler.select(input([candidate('byok')]));
  assert.equal(result.decision, 'allow');
  const query = state.statements.find(({ sql }) => sql.includes(':rate-window'));
  assert.ok(query);
  assert.deepEqual(query.values, ['tenant', 'account-a', NOW]);
  assert.match(query.sql, /window_start > \$3::timestamptz - interval '60 seconds'/);
  assert.match(query.sql, /coalesce\(sum\(requests\), 0\)::text AS requests/);
  assert.match(query.sql, /account_scope = \$1\s+AND account_id = \$2/);
  assert.doesNotMatch(query.sql, /INSERT|UPDATE|DELETE/i);
});

test('an account at its rpm ceiling is denied without affecting siblings', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const rows = new Map([
        ['account-a', [{ ...eligibilityRow(mode, 'account-a'), account_rpm_limit: 2 }]],
        ['account-b', [eligibilityRow(mode, 'account-b')]],
      ]);
      const { scheduler, state, input } = setup(mode, {
        eligibilityRows: rows,
        rateWindows: new Map([['account-a', [{ requests: '2', tokens: '0' }]]]),
      });
      const result = await scheduler.select(input([candidate(mode, 'account-a'), candidate(mode, 'account-b')]));
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
      const scope = mode === 'byok' ? 'tenant' : 'platform';
      const query = state.statements.find(({ sql }) => sql.includes(':rate-window'));
      assert.deepEqual(query?.values, [scope, 'account-a', NOW]);
    });
  }

  await t.test('every ceiling-exhausted candidate leaves no eligible account without blocking', async () => {
    const rows = new Map([['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_rpm_limit: 2 }]]]);
    const { scheduler, input } = setup('byok', {
      eligibilityRows: rows,
      rateWindows: new Map([['account-a', [{ requests: '5', tokens: '0' }]]]),
    });
    const result = await scheduler.select(input([candidate('byok', 'account-a')]));
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  });
});

test('an account at its tpm ceiling is denied on the token dimension', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const rows = new Map([['account-a', [{ ...eligibilityRow(mode, 'account-a'), account_tpm_limit: 100 }]]]);
      const { scheduler, input } = setup(mode, {
        eligibilityRows: rows,
        rateWindows: new Map([['account-a', [{ requests: '0', tokens: '100' }]]]),
      });
      const result = await scheduler.select(input([candidate(mode, 'account-a')]));
      assert.equal(result.decision, 'reject');
      if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
    });
  }
});

test('limits above the trailing window keep the candidate eligible', async () => {
  const rows = new Map([
    ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_rpm_limit: 3, account_tpm_limit: 10_000 }]],
  ]);
  const { scheduler, input } = setup('platform', {
    eligibilityRows: rows,
    rateWindows: new Map([['account-a', [{ requests: '2', tokens: '9999' }]]]),
  });
  const result = await scheduler.select(input([candidate('platform', 'account-a')]));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
});

test('malformed persisted rate limits block instead of silently defaulting', async (t) => {
  const cases: Array<{ name: string; patch: Row }> = [
    { name: 'zero rpm limit', patch: { account_rpm_limit: 0 } },
    { name: 'negative rpm limit', patch: { account_rpm_limit: -5 } },
    { name: 'fractional tpm limit', patch: { account_tpm_limit: 1.5 } },
    { name: 'text zero limit', patch: { account_rpm_limit: '0' } },
    { name: 'non-numeric limit', patch: { account_tpm_limit: 'fast' } },
    { name: 'boolean limit', patch: { account_rpm_limit: true } },
    { name: 'limit above the contract bound', patch: { account_tpm_limit: 1_000_000_001 } },
  ];
  for (const { name, patch } of cases) {
    await t.test(name, async () => {
      const row = { ...eligibilityRow('platform'), ...patch };
      const { scheduler, state, input } = setup('platform', {
        eligibilityRows: new Map([['account-a', [row]]]),
        rateWindows: new Map([['account-a', [{ requests: '0', tokens: '0' }]]]),
      });
      const result = await scheduler.select(input([candidate('platform')]));
      assert.equal(result.decision, 'block');
      if (result.decision === 'block') assert.match(result.message, /rate limits are malformed/);
      // A malformed ceiling is rejected before any window read is issued.
      assert.equal(
        state.statements.some(({ sql }) => sql.includes(':rate-window')),
        false,
      );
    });
  }
});

test('a malformed or missing rate window blocks the whole selection', async (t) => {
  await t.test('non-numeric sums', async () => {
    const rows = new Map([['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_rpm_limit: 2 }]]]);
    const { scheduler, input } = setup('byok', {
      eligibilityRows: rows,
      rateWindows: new Map([['account-a', [{ requests: 'many', tokens: '0' }]]]),
    });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /rate window is malformed/);
  });

  await t.test('negative sums', async () => {
    const rows = new Map([['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_tpm_limit: 100 }]]]);
    const { scheduler, input } = setup('byok', {
      eligibilityRows: rows,
      rateWindows: new Map([['account-a', [{ requests: '0', tokens: '-1' }]]]),
    });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /rate window is malformed/);
  });

  await t.test('window authority unavailable', async () => {
    const rows = new Map([['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_rpm_limit: 2 }]]]);
    const { scheduler, input } = setup('byok', {
      eligibilityRows: rows,
      rateWindows: new Map([['account-a', []]]),
    });
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /rate window is unavailable/);
  });
});

test('the R7 effectiveWeight seam halves, floors, and passes through', () => {
  assert.equal(effectiveWeight(9, 0.5), 4);
  assert.equal(effectiveWeight(100, 0), 5);
  assert.equal(effectiveWeight(7, null), 7);
  assert.equal(effectiveWeight(10, 1), 10);
  // The contract minimum weight is never undercut, even at the 5% floor.
  assert.equal(effectiveWeight(1, 0), 1);
  assert.equal(effectiveWeight(3, 0.05), 1);
});

test('a persisted health score modulates the deterministic draw without blocking', async (t) => {
  await t.test('a halved score flips at least one deterministic draw to the sibling', async () => {
    const rowsFor = (healthScore: unknown) =>
      new Map([
        [
          'account-a',
          [
            {
              ...eligibilityRow('platform', 'account-a'),
              account_weight: 9,
              account_health_score: healthScore,
            },
          ],
        ],
        ['account-b', [eligibilityRow('platform', 'account-b')]],
      ]);
    const candidates = [candidate('platform', 'account-a'), candidate('platform', 'account-b')];
    const pick = async (healthScore: unknown, requestId: string) => {
      const { scheduler, input } = setup('platform', { eligibilityRows: rowsFor(healthScore) });
      const result = await scheduler.select({ ...input(candidates), requestId });
      assert.equal(result.decision, 'allow');
      return result.decision === 'allow' ? result.value.accountId : null;
    };
    // Deterministic per requestId: a halved weight (9 -> 4 against 1) must
    // lose at least one draw the full weight wins, and every draw is stable.
    let flipped: string | null = null;
    for (let index = 0; index < 100 && flipped === null; index += 1) {
      const requestId = `request-scan-${index}`;
      const full = await pick(null, requestId);
      const halved = await pick('0.500', requestId);
      assert.equal(await pick(null, requestId), full);
      assert.equal(await pick('0.500', requestId), halved);
      if (full === 'account-a' && halved === 'account-b') flipped = requestId;
    }
    assert.ok(flipped !== null, 'a halved health score must flip at least one deterministic draw');
  });

  await t.test('a zero score keeps the five-percent floor and never blocks the candidate', async () => {
    const rows = new Map([
      ['account-a', [{ ...eligibilityRow('byok', 'account-a'), account_weight: 100, account_health_score: '0.000' }]],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a')]));
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
  });

  await t.test('a NULL score keeps the pre-R7 selection exactly', async () => {
    const rowsFor = (includeScore: boolean) =>
      new Map([
        [
          'account-a',
          [
            includeScore
              ? { ...eligibilityRow('platform', 'account-a'), account_weight: 9, account_health_score: null }
              : { ...eligibilityRow('platform', 'account-a'), account_weight: 9 },
          ],
        ],
        ['account-b', [eligibilityRow('platform', 'account-b')]],
      ]);
    const candidates = [candidate('platform', 'account-a'), candidate('platform', 'account-b')];
    for (const requestId of ['request-a', 'request-b', 'request-c', 'request-d']) {
      const absent = setup('platform', { eligibilityRows: rowsFor(false) });
      const explicitNull = setup('platform', { eligibilityRows: rowsFor(true) });
      const first = await absent.scheduler.select({ ...absent.input(candidates), requestId });
      const second = await explicitNull.scheduler.select({ ...explicitNull.input(candidates), requestId });
      assert.equal(first.decision, 'allow');
      assert.equal(second.decision, 'allow');
      if (first.decision === 'allow' && second.decision === 'allow') {
        assert.equal(first.value.accountId, second.value.accountId);
      }
    }
  });

  await t.test('numeric and text scores inside the range are accepted', async () => {
    for (const score of [0.5, '0.500', 1, '1.000', 0, '0']) {
      const rows = new Map([
        ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_health_score: score }]],
      ]);
      const { scheduler, input } = setup('platform', { eligibilityRows: rows });
      const result = await scheduler.select(input([candidate('platform', 'account-a')]));
      assert.equal(result.decision, 'allow', `score ${String(score)} must stay eligible`);
    }
  });
});

test('malformed persisted health scores block instead of silently defaulting', async (t) => {
  const cases: Array<{ name: string; score: unknown }> = [
    { name: 'above one', score: '1.001' },
    { name: 'numeric above one', score: 2 },
    { name: 'negative', score: -0.1 },
    { name: 'negative text', score: '-0.500' },
    { name: 'non-numeric', score: 'healthy' },
    { name: 'precision beyond numeric(4,3)', score: '0.1234' },
    { name: 'object', score: { value: 0.5 } },
    { name: 'NaN', score: Number.NaN },
  ];
  for (const { name, score } of cases) {
    await t.test(name, async () => {
      const row = { ...eligibilityRow('platform'), account_health_score: score };
      const { scheduler, input } = setup('platform', { eligibilityRows: new Map([['account-a', [row]]]) });
      const result = await scheduler.select(input([candidate('platform')]));
      assert.equal(result.decision, 'block');
      if (result.decision === 'block') assert.match(result.message, /health score is malformed/);
    });
  }
});

/* ------------------------------------------------------------------ */
/* H5a (R9 bench finding P5a): half-open probe wiring                  */
/* ------------------------------------------------------------------ */

type ProbeStore = ProviderAccountHealthSchedulingPort &
  ProviderAccountHalfOpenProbeAdmissionPort &
  ProviderAccountRuntimeHealthWriter;

interface ProbeStoreCalls {
  readonly admissions: Array<{ readonly accountId: string; readonly staleAfterMs?: number }>;
  readonly outcomes: ReadonlyArray<{
    readonly accountId: string;
    readonly fencingToken: string;
    readonly evidence: unknown;
  }>;
  readonly views: readonly string[];
}

function probeStore(
  viewFor: (accountId: string) => ProviderAccountHealthSchedulingView,
  admission: 'admitted' | 'closed',
  applied: 'applied' | 'stale' = 'applied',
): { store: ProbeStore; calls: ProbeStoreCalls } {
  const calls: {
    admissions: Array<{ accountId: string; staleAfterMs?: number }>;
    outcomes: Array<{ accountId: string; fencingToken: string; evidence: unknown }>;
    views: string[];
  } = { admissions: [], outcomes: [], views: [] };
  return {
    calls,
    store: {
      async getSchedulingView(input) {
        calls.views.push(input.candidate.accountId);
        return viewFor(input.candidate.accountId);
      },
      async tryAdmitHalfOpenProbe(input) {
        calls.admissions.push({ accountId: input.candidate.accountId, staleAfterMs: input.staleAfterMs });
        return admission;
      },
      async recordRuntimeOutcome(input) {
        calls.outcomes.push({
          accountId: input.candidate.accountId,
          fencingToken: input.fencingToken,
          evidence: input.evidence,
        });
        return applied;
      },
    },
  };
}

function allowView(): ProviderAccountHealthSchedulingView {
  return {
    decision: 'allow',
    value: {
      status: 'healthy',
      observedAt: NOW,
      cooldownUntil: null,
      healthScore: null,
      halfOpenProbeAt: null,
      consecutiveFailures: 0,
    },
  };
}

function staleView(): ProviderAccountHealthSchedulingView {
  return {
    decision: 'block',
    reason: 'provider account runtime health is stale or malformed',
    code: 'stale',
  };
}

test('a fresh scheduling view passes through the probe port without admitting a probe (H5a)', async () => {
  const { store, calls } = probeStore(() => allowView(), 'admitted');
  const { scheduler, input } = setup(
    'byok',
    {},
    { healthProbe: { store, leaseProvider: { acquire: async () => null } } },
  );
  const result = await scheduler.select(input([candidate('byok')]));
  assert.equal(result.decision, 'allow');
  assert.deepEqual(calls.admissions, []);
  assert.deepEqual(calls.outcomes, []);
});

test('a stale scheduling view is self-healed by a half-open probe (H5a)', async () => {
  const { store, calls } = probeStore(() => staleView(), 'admitted');
  let releases = 0;
  const leaseProvider = {
    async acquire() {
      return {
        fencingToken: '9001',
        release: async () => {
          releases += 1;
        },
      };
    },
  };
  const { scheduler, input } = setup('byok', {}, { healthProbe: { store, leaseProvider } });
  const result = await scheduler.select(input([candidate('byok')]));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
  // The admission carries the scheduler's freshness bound (setup: 60 s).
  assert.deepEqual(calls.admissions, [{ accountId: 'account-a', staleAfterMs: 60_000 }]);
  // The probe outcome is lease-authorized probe-success evidence.
  assert.equal(calls.outcomes.length, 1);
  assert.equal(calls.outcomes[0]?.fencingToken, '9001');
  assert.deepEqual(calls.outcomes[0]?.evidence, { source: 'probe', result: 'success' });
  assert.equal(releases, 1);
});

test('a losing half-open probe admission denies only the stale candidate (H5a)', async () => {
  const { store, calls } = probeStore((accountId) => (accountId === 'account-a' ? staleView() : allowView()), 'closed');
  const { scheduler, input } = setup(
    'byok',
    {},
    { healthProbe: { store, leaseProvider: { acquire: async () => null } } },
  );
  const result = await scheduler.select(input([candidate('byok'), candidate('byok', 'account-b')]));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  assert.deepEqual(calls.admissions, [{ accountId: 'account-a', staleAfterMs: 60_000 }]);
  assert.deepEqual(calls.outcomes, []);

  // With the stale account as the only candidate the request is rejected,
  // never blocked: the concurrent winner's probe will refresh the row.
  const single = await scheduler.select(input([candidate('byok')]));
  assert.equal(single.decision, 'reject');
  if (single.decision === 'reject') assert.equal(single.code, 'account_denied');
});

test('a probe that cannot acquire or record its outcome denies the candidate (H5a)', async () => {
  const noLease = probeStore(() => staleView(), 'admitted');
  const noLeaseSetup = setup(
    'byok',
    {},
    { healthProbe: { store: noLease.store, leaseProvider: { acquire: async () => null } } },
  );
  const rejected = await noLeaseSetup.scheduler.select(noLeaseSetup.input([candidate('byok')]));
  assert.equal(rejected.decision, 'reject');
  assert.deepEqual(noLease.calls.outcomes, []);

  const fenced = probeStore(() => staleView(), 'admitted', 'stale');
  const fencedSetup = setup(
    'byok',
    {},
    {
      healthProbe: {
        store: fenced.store,
        leaseProvider: { acquire: async () => ({ fencingToken: '9002', release: async () => {} }) },
      },
    },
  );
  const fencedResult = await fencedSetup.scheduler.select(fencedSetup.input([candidate('byok')]));
  assert.equal(fencedResult.decision, 'reject');
  assert.equal(fenced.calls.outcomes.length, 1);
});

test('non-stale scheduling view blocks keep the fail-closed whole-selection block (H5a)', async () => {
  const { store, calls } = probeStore(
    () => ({
      decision: 'block' as const,
      reason: 'provider account runtime health authority is unavailable',
      code: 'unavailable' as const,
    }),
    'admitted',
  );
  const { scheduler, input } = setup(
    'byok',
    {},
    { healthProbe: { store, leaseProvider: { acquire: async () => null } } },
  );
  const result = await scheduler.select(input([candidate('byok')]));
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /authority is unavailable/);
  assert.deepEqual(calls.admissions, []);
});

test('failureFeedback is forwarded to the core scheduler and cools only the faulted account (H5c)', async () => {
  const { scheduler, input } = setup(
    'byok',
    {},
    {
      failureFeedback: {
        isExcluded(probe: { candidate: RequestPreparationCandidateAuthority }) {
          return probe.candidate.accountId === 'account-a';
        },
      },
    },
  );
  const result = await scheduler.select(input([candidate('byok'), candidate('byok', 'account-b')]));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
});
