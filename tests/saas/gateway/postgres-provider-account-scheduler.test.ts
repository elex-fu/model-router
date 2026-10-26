import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PreparedSqlStatement, SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
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
  RequestPreparationRouteAuthority,
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
    authority_now: NOW,
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
  readonly prepared?: Array<{ statement: PreparedSqlStatement; values: readonly unknown[] }>;
  readonly preparedFailure?: Error;
}

class FakeDatabase implements SaasDatabase {
  queryPrepared?: SqlExecutor['queryPrepared'];
  transactionCalls = 0;

  constructor(private readonly state: FakeDatabaseState) {
    const prepared = state.prepared;
    if (prepared) {
      this.queryPrepared = async <RowType>(statement: PreparedSqlStatement, values: readonly unknown[] = []) => {
        prepared.push({ statement, values });
        if (state.preparedFailure) throw state.preparedFailure;
        return this.query<RowType>(statement.text, values);
      };
    }
  }

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
    } else if (sql.includes('postgres-provider-account-scheduler:supplier-cost-rate')) {
      rows = [];
    } else if (sql.includes('postgres-provider-account-scheduler:concurrency')) {
      rows = [{ in_flight: this.state.inFlight?.get(String(values[2])) ?? '0' }];
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 100)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
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

function nativeRoute(mode: Mode): RequestPreparationRouteAuthority {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    publicModel: 'public-model',
    publicModelId: 'public-model-id',
    publicModelVersion: 11,
    routeConfigId: 'route-a',
    routeConfigVersion: 8,
    protocol: 'openai',
    providerProtocol: 'anthropic',
    clientOperation: 'chat.completions',
    providerOperation: 'messages',
    targetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    upstreamId: mode === 'byok' ? 'tenant-route-a' : 'pool-a',
    endpoint: 'https://catalog.example/v1',
  };
}

test('combined PG selection retains only its bound winner after all binding calls complete', async () => {
  const events: string[] = [];
  const held = new Set<string>();
  const binds: string[] = [];
  const rows = new Map([
    ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_priority: 1 }]],
    ['account-b', [{ ...eligibilityRow('platform', 'account-b'), account_priority: 10 }]],
  ]);
  const { scheduler, input, state } = setup(
    'platform',
    { eligibilityRows: rows },
    {
      redisConcurrencySlots: {
        enabled: true,
        maxSlots: 2,
        slots: {
          async tryAcquire(value) {
            events.push(`acquire:${value.accountId}`);
            held.add(value.accountId);
            return { state: 'acquired' };
          },
          async release(value) {
            events.push(`release:${value.accountId}`);
            held.delete(value.accountId);
          },
        },
      },
      affinity: {
        async resolve() {
          return { decision: 'allow', accountId: null };
        },
        async bind(value) {
          binds.push(value.accountId);
          events.push(`bind:${value.accountId}`);
          assert.deepEqual(
            [...held].sort(),
            ['account-a', 'account-b'],
            'no temporary slot is settled before binding finishes',
          );
          return binds.length === 1
            ? {
                decision: 'block',
                reason: 'provider account affinity binding conflict',
                contention: { kind: 'active_binding', accountId: 'account-a' },
              }
            : { decision: 'allow' };
        },
      },
    },
  );
  const result = await scheduler.selectAndBind({
    ...input([candidate('platform', 'account-a'), candidate('platform', 'account-b')], {
      previousResponseId: 'combined-pg',
    }),
    route: { ...nativeRoute('platform'), providerProtocol: 'openai', providerOperation: 'chat.completions' },
  });
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
  assert.deepEqual(binds, ['account-b', 'account-a']);
  assert.deepEqual([...held], ['account-a']);
  assert.deepEqual(
    events.filter((event) => event.startsWith('release:')),
    ['release:account-b'],
  );
  assert.equal(events.at(-1), 'release:account-b');
  assert.equal(state.statements.filter(({ sql }) => sql.includes(':selection-audit')).length, 1);
});

for (const mode of [
  'second-conflict',
  'throw',
  'bad-shape',
  'bad-candidate',
  'wrong-source',
  'release-failure',
] as const) {
  test(`combined PG selection releases all temporary slots on ${mode}`, async () => {
    const releases: string[] = [];
    const held = new Set<string>();
    let binds = 0;
    const { scheduler, input } = setup(
      'platform',
      {
        eligibilityRows: new Map([
          ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_priority: 10 }]],
          ['account-b', [{ ...eligibilityRow('platform', 'account-b'), account_priority: 1 }]],
        ]),
      },
      {
        redisConcurrencySlots: {
          enabled: true,
          maxSlots: 2,
          slots: {
            async tryAcquire(value) {
              held.add(value.accountId);
              return { state: 'acquired' };
            },
            async release(value) {
              releases.push(value.accountId);
              held.delete(value.accountId);
              if (mode === 'release-failure' && value.accountId === 'account-b')
                throw new Error('private release error');
            },
          },
        },
        affinity: {
          async resolve() {
            return { decision: 'allow', accountId: null };
          },
          async bind(value) {
            binds++;
            if (mode === 'second-conflict')
              return {
                decision: 'block',
                reason: 'provider account affinity binding conflict',
                contention: {
                  kind: 'active_binding',
                  accountId: value.accountId === 'account-a' ? 'account-b' : 'account-a',
                },
              };
            return { decision: 'allow' };
          },
        },
      },
    );
    const core = (
      scheduler as unknown as { scheduler: { selectAndBindCandidate: (value: unknown) => Promise<unknown> } }
    ).scheduler;
    const original = core.selectAndBindCandidate.bind(core);
    if (mode === 'throw' || mode === 'bad-shape' || mode === 'bad-candidate' || mode === 'wrong-source')
      core.selectAndBindCandidate = async (value) => {
        await original(value);
        if (mode === 'throw') throw new Error('private combined failure');
        if (mode === 'bad-candidate') return { decision: 'allow', value: { accountId: 'account-a' } };
        if (mode === 'wrong-source')
          return { decision: 'allow', value: { ...candidate('platform'), credentialId: 'foreign-credential' } };
        return {};
      };
    // Force a stable account-a proposal so release-failure always concerns its non-winner.
    const proposed = [candidate('platform', 'account-a'), candidate('platform', 'account-b')];
    const result = await scheduler.selectAndBind({
      ...input(proposed, { previousResponseId: 'combined-failure' }),
      route: { ...nativeRoute('platform'), providerProtocol: 'openai', providerOperation: 'chat.completions' },
    });
    assert.equal(result.decision, mode === 'second-conflict' ? 'reject' : 'block');
    if (result.decision === 'reject') {
      assert.equal(result.code, 'rate_limited');
      assert.equal(Object.hasOwn(result, 'retryAfterSeconds'), false);
    }
    assert.deepEqual([...held], []);
    assert.deepEqual([...new Set(releases)].sort(), ['account-a', 'account-b']);
    assert.equal(binds, mode === 'second-conflict' ? 2 : 1);
  });
}

test('a thrown temporary-slot release overrides pending contention 429 and still attempts every release', async () => {
  const releases: string[] = [];
  const binds: string[] = [];
  const { scheduler, input, state } = setup(
    'platform',
    {
      eligibilityRows: new Map([
        ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_priority: 10 }]],
        ['account-b', [{ ...eligibilityRow('platform', 'account-b'), account_priority: 1 }]],
      ]),
    },
    {
      redisConcurrencySlots: {
        enabled: true,
        maxSlots: 2,
        slots: {
          async tryAcquire() {
            return { state: 'acquired' };
          },
          async release(value) {
            releases.push(value.accountId);
            if (value.accountId === 'account-a') throw new Error('private release failure');
          },
        },
      },
      affinity: {
        async resolve() {
          return { decision: 'allow', accountId: null };
        },
        async bind(value) {
          binds.push(value.accountId);
          return {
            decision: 'block',
            reason: 'provider account affinity binding conflict',
            contention: {
              kind: 'active_binding',
              accountId: value.accountId === 'account-a' ? 'account-b' : 'account-a',
            },
          };
        },
      },
    },
  );
  const core = (
    scheduler as unknown as {
      scheduler: { selectAndBindCandidate: (value: unknown) => Promise<{ decision: string; code?: string }> };
    }
  ).scheduler;
  const original = core.selectAndBindCandidate.bind(core);
  let pendingDecision: unknown;
  core.selectAndBindCandidate = async (value) => {
    const result = await original(value);
    pendingDecision = result;
    return result;
  };
  const result = await scheduler.selectAndBind({
    ...input([candidate('platform', 'account-a'), candidate('platform', 'account-b')], {
      previousResponseId: 'combined-release-failure',
    }),
    route: { ...nativeRoute('platform'), providerProtocol: 'openai', providerOperation: 'chat.completions' },
  });
  assert.equal((pendingDecision as { decision: string }).decision, 'reject');
  assert.equal((pendingDecision as { code: string }).code, 'rate_limited');
  assert.equal(result.decision, 'block');
  assert.deepEqual(binds, ['account-a', 'account-b']);
  assert.deepEqual(releases, ['account-a', 'account-b']);
  assert.equal(state.statements.filter(({ sql }) => sql.includes(':selection-audit')).length, 0);
});

test('BYOK and platform scheduling query and revalidate native capabilities without changing client scope', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const row = { ...eligibilityRow(mode), capability_protocol: 'anthropic' };
      const { scheduler, input, state } = setup(mode, { eligibilityRows: new Map([['account-a', [row]]]) });
      const result = await scheduler.select({ ...input([candidate(mode)]), route: nativeRoute(mode) });
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.protocol, 'openai');
      const route = state.statements.find(({ sql }) => sql.includes('postgres-provider-account-scheduler:route'));
      assert.equal(route?.values[3], 'openai', 'the persisted client route is still selected by client protocol');
      const eligibility = state.statements.find(({ sql }) => sql.includes(`${mode}-eligibility`));
      assert.ok(eligibility);
      assert.equal(eligibility.values[mode === 'byok' ? 14 : 20], 'anthropic');
      assert.equal(eligibility.values[mode === 'byok' ? 6 : 7], 'https://catalog.example/v1');
    });
  }
});

test('native capability mismatches and undeclared protocol changes remain denied', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const wrong = setup(mode);
      const denied = await wrong.scheduler.select({ ...wrong.input([candidate(mode)]), route: nativeRoute(mode) });
      assert.equal(denied.decision, 'reject');
      if (denied.decision === 'reject') assert.equal(denied.code, 'account_denied');
      assert.equal(
        wrong.state.statements.some(({ sql }) => sql.includes(':concurrency')),
        false,
      );

      const row = { ...eligibilityRow(mode), capability_protocol: 'anthropic' };
      const undeclared = setup(mode, { eligibilityRows: new Map([['account-a', [row]]]) });
      const legacy = await undeclared.scheduler.select(undeclared.input([candidate(mode)]));
      assert.equal(legacy.decision, 'reject', 'native protocol must come from explicit trusted route authority');
      const eligibility = undeclared.state.statements.find(({ sql }) => sql.includes(`${mode}-eligibility`));
      assert.equal(eligibility?.values[mode === 'byok' ? 14 : 20], 'openai');
    });
  }
});

test('eligibility reads use the root executor in order without a transaction wrapper', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    for (const nativePrepared of [false, true]) {
      await t.test(`${mode}, prepared=${nativePrepared}`, async () => {
        const prepared: NonNullable<FakeDatabaseState['prepared']> = [];
        const row = { ...eligibilityRow(mode), account_rpm_limit: 100 };
        const { scheduler, database, state, input } = setup(
          mode,
          {
            ...(nativePrepared ? { prepared } : {}),
            eligibilityRows: new Map([['account-a', [row]]]),
          },
          { strategies: { costPriority: { enabled: true } } },
        );
        const rootCalls: string[] = [];
        const rootQuery = database.query.bind(database);
        database.query = async <RowType>(sql: string, values: readonly unknown[] = []) => {
          rootCalls.push(sql.match(/postgres-provider-account-scheduler:([^ ]+)/)?.[1] ?? 'other');
          return rootQuery<RowType>(sql, values);
        };
        if (database.queryPrepared) {
          const rootPrepared = database.queryPrepared.bind(database);
          database.queryPrepared = async <RowType>(
            statement: PreparedSqlStatement,
            values: readonly unknown[] = [],
          ) => {
            rootCalls.push('prepared');
            return rootPrepared<RowType>(statement, values);
          };
        }
        assert.equal((await scheduler.select(input([candidate(mode)]))).decision, 'allow');
        assert.equal(database.transactionCalls, 0, 'pure SELECT eligibility must use root autocommit queries');
        const relevant = rootCalls.filter((call) =>
          ['route', 'prepared', `${mode}-eligibility`, 'rate-window', 'supplier-cost-rate'].includes(call),
        );
        assert.deepEqual(relevant, [
          'route',
          ...(nativePrepared ? ['prepared'] : []),
          `${mode}-eligibility`,
          'rate-window',
          ...(mode === 'platform' ? ['supplier-cost-rate'] : []),
        ]);
        assert.equal(prepared.length, nativePrepared ? 1 : 0);
        assert.deepEqual(state.statements.find(({ sql }) => sql.includes(':route'))?.values, [
          'tenant-a',
          'project-a',
          'public-model',
          'openai',
          mode,
        ]);
        assert.deepEqual(state.statements.find(({ sql }) => sql.includes(':rate-window'))?.values, [
          mode === 'byok' ? 'tenant' : 'platform',
          'account-a',
          NOW,
        ]);
        if (mode === 'platform') {
          assert.deepEqual(state.statements.find(({ sql }) => sql.includes(':supplier-cost-rate'))?.values, [
            'cost-v2',
          ]);
        }
      });
    }
  }
});

test('later candidates reread a changed route before reading eligibility', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { scheduler, database, state, input } = setup(mode, {
        eligibilityRows: new Map([['account-a', [{ ...eligibilityRow(mode), account_quota_state: 'exhausted' }]]]),
      });
      const rootQuery = database.query.bind(database);
      database.query = async <RowType>(sql: string, values: readonly unknown[] = []) => {
        const result = await rootQuery<RowType>(sql, values);
        if (sql.includes(`${mode}-eligibility`)) state.routeRows = [routeRow(mode, 'provider-b')];
        return result;
      };
      const result = await scheduler.select(input([candidate(mode), candidate(mode, 'account-b')]));
      assert.notEqual(result.decision, 'allow');
      assert.equal(database.transactionCalls, 0);
      assert.equal(state.statements.filter(({ sql }) => sql.includes(':route')).length, 2);
      const eligibility = state.statements.filter(({ sql }) => sql.includes(`${mode}-eligibility`));
      assert.equal(eligibility.length, 1, 'the changed route denies candidate B before its eligibility read');
      assert.equal(eligibility[0]?.values[mode === 'byok' ? 2 : 3], 'account-a');
      assert.equal(
        state.statements.some(({ sql }) => sql.includes(':rate-window') || sql.includes(':supplier-cost-rate')),
        false,
      );
    });
  }
});

test('only scheduler eligibility uses fixed prepared SQL with current values and authority clocks', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const prepared: NonNullable<FakeDatabaseState['prepared']> = [];
      const eligibilityRows = new Map<string, Row[]>();
      const { scheduler, input, state } = setup(mode, { prepared, eligibilityRows });
      for (const accountId of ['account-a', 'account-b']) {
        assert.equal((await scheduler.select(input([candidate(mode, accountId)]))).decision, 'allow');
      }
      eligibilityRows.set('account-a', [
        { ...eligibilityRow(mode), authority_now: new Date(NOW.getTime() + 35), account_status: 'disabled' },
      ]);
      assert.equal((await scheduler.select(input([candidate(mode)]))).decision, 'reject');
      assert.equal(prepared.length, 3);
      assert.ok(prepared.every(({ statement }) => statement === prepared[0].statement && Object.isFrozen(statement)));
      assert.equal(new Set(prepared.map(({ statement }) => statement.name)).size, 1);
      const statement = prepared[0].statement;
      assert.equal(
        createHash('sha256').update(statement.text).digest('hex'),
        mode === 'byok'
          ? '9b34c495847c2b54256174c5c2d1c6063ed6877e023708dfff4589fe09771993'
          : 'bc83809c6d04f9c52ac8572fe4b1ed655468ad8861baf00cbb1740d2a7cf0b60',
      );
      assert.equal(
        statement.name,
        `mr_sched-${mode}_${createHash('sha256').update(statement.text).digest('base64url')}`,
      );
      assert.deepEqual(
        prepared.map(({ values }) => values[mode === 'byok' ? 2 : 3]),
        ['account-a', 'account-b', 'account-a'],
      );
      assert.match(
        statement.text,
        /WITH authority_clock AS MATERIALIZED \(SELECT clock_timestamp\(\) AS authority_now\)/,
      );
      assert.equal(state.statements.filter(({ sql }) => sql.includes(':route')).length, 3);
      assert.equal(state.statements.filter(({ sql }) => sql.includes(`${mode}-eligibility`)).length, 3);
    });
  }
});

test('scheduler native failures block without an anonymous eligibility replay', async () => {
  const prepared: NonNullable<FakeDatabaseState['prepared']> = [];
  const { scheduler, input, state, database } = setup('platform', {
    prepared,
    preparedFailure: new Error('expected native failure'),
  });
  assert.equal((await scheduler.select(input([candidate('platform')]))).decision, 'block');
  assert.equal(prepared.length, 1);
  assert.equal(database.transactionCalls, 0);
  assert.equal(state.statements.filter(({ sql }) => sql.includes(':route')).length, 1);
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('platform-eligibility')),
    false,
  );
});

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

test('platform eligibility binds all 22 non-clock authority parameters including the member account epoch and the F2 group', async () => {
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
    Array.from({ length: 22 }, (_, index) => index + 1),
  );
  assert.equal(query.values.length, 22);
  assert.equal(query.values[14], platformCandidate.poolMemberAccountAuthzVersion);
  assert.match(query.sql, /member\.account_authz_version\s*=\s*\$15\b/);
  assert.match(query.sql, /member\.account_authz_version\s*=\s*account\.authz_version\b/);
  // F2: $22 is the server-resolved billing group narrowing the pool domain.
  assert.equal(query.values[21], 'default');
});

test('each eligibility statement fixes one database clock and never binds the process clock', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { scheduler, state, input } = setup(mode);
      assert.equal((await scheduler.select(input([candidate(mode)]))).decision, 'allow');
      const query = state.statements.find(({ sql }) => sql.includes(`${mode}-eligibility`));
      assert.ok(query);
      assert.match(query.sql, /WITH authority_clock AS MATERIALIZED \(SELECT clock_timestamp\(\) AS authority_now\)/);
      assert.match(query.sql, /SELECT authority_clock\.authority_now, product\.status/);
      assert.equal([...query.sql.matchAll(/clock_timestamp\(\)/g)].length, 1);
      assert.doesNotMatch(query.sql, /\$\d+::timestamptz/);
      assert.equal(
        query.values.some((value) => value instanceof Date),
        false,
      );
      assert.equal(query.values.length, mode === 'byok' ? 15 : 22);
      assert.match(query.sql, /credential\.expires_at > authority_clock\.authority_now/);
      assert.match(query.sql, /credential_version\.expires_at > authority_clock\.authority_now/);
      assert.match(
        query.sql,
        mode === 'byok'
          ? /mapping\.effective_at <= authority_clock\.authority_now/
          : /grant_row\.effective_at <= authority_clock\.authority_now/,
      );
      assert.match(
        query.sql,
        mode === 'byok'
          ? /rights\.expires_at > authority_clock\.authority_now/
          : /pool_rights\.expires_at > authority_clock\.authority_now/,
      );
    });
  }
});

test('database authorization windows remain valid across positive and negative process clock skew', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    for (const offset of [-86_400_000, 86_400_000]) {
      await t.test(`${mode}: authority offset ${offset}ms`, async () => {
        const authorityAt = new Date(NOW.getTime() + offset);
        const effectiveAt = new Date(authorityAt.getTime() - 1);
        const expiresAt = new Date(authorityAt.getTime() + 1);
        const row = {
          ...eligibilityRow(mode),
          authority_now: authorityAt,
          credential_expires_at: expiresAt,
          version_expires_at: expiresAt,
          account_rights_effective_at: effectiveAt,
          account_rights_expires_at: expiresAt,
          ...(mode === 'byok'
            ? { mapping_effective_at: effectiveAt, mapping_expires_at: expiresAt }
            : {
                grant_effective_at: effectiveAt,
                grant_expires_at: expiresAt,
                pool_rights_effective_at: effectiveAt,
                pool_rights_expires_at: expiresAt,
              }),
        };
        const { scheduler, input } = setup(mode, { eligibilityRows: new Map([['account-a', [row]]]) });
        const result = await scheduler.select(input([candidate(mode)]));
        assert.equal(result.decision, 'allow', 'JS rights and relation checks must use the returned DB clock');
      });
    }
  }
});

test('future and expired database authorization windows cannot be waived by the process clock', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    const windows = [
      ['account rights', 'account_rights_effective_at', 'account_rights_expires_at'],
      ...(mode === 'byok'
        ? [['profile mapping', 'mapping_effective_at', 'mapping_expires_at']]
        : [
            ['pool grant', 'grant_effective_at', 'grant_expires_at'],
            ['pool rights', 'pool_rights_effective_at', 'pool_rights_expires_at'],
          ]),
    ];
    for (const [label, effectiveField, expiresField] of windows) {
      for (const boundary of ['future', 'expired']) {
        await t.test(`${mode}: ${label} ${boundary}`, async () => {
          const row = {
            ...eligibilityRow(mode),
            authority_now: new Date(NOW.getTime() + (boundary === 'future' ? -100 : 100)),
            [effectiveField]: new Date(NOW.getTime() - 50),
            [expiresField]: new Date(NOW.getTime() + 50),
          };
          const { scheduler, state, input } = setup(mode, { eligibilityRows: new Map([['account-a', [row]]]) });
          const result = await scheduler.select(input([candidate(mode)]));
          assert.equal(result.decision, 'reject');
          if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
          assert.equal(
            state.statements.some(({ sql }) => sql.includes(':concurrency')),
            false,
          );
        });
      }
    }
    for (const field of ['credential_expires_at', 'version_expires_at']) {
      await t.test(`${mode}: ${field} expired`, async () => {
        const row = {
          ...eligibilityRow(mode),
          authority_now: new Date(NOW.getTime() + 100),
          [field]: new Date(NOW.getTime() + 50),
        };
        const { scheduler, input } = setup(mode, { eligibilityRows: new Map([['account-a', [row]]]) });
        assert.equal((await scheduler.select(input([candidate(mode)]))).decision, 'reject');
      });
    }
  }
});

test('PostgreSQL eligibility never falls back when its authority clock is missing or malformed', async (t) => {
  const cases = [
    { label: 'missing', present: false, inherited: false, value: undefined },
    { label: 'undefined', present: true, inherited: false, value: undefined },
    { label: 'null', present: true, inherited: false, value: null },
    { label: 'invalid string', present: true, inherited: false, value: 'not-a-date' },
    { label: 'invalid Date', present: true, inherited: false, value: new Date(Number.NaN) },
    { label: 'inherited valid time', present: false, inherited: true, value: NOW },
  ];
  for (const mode of ['byok', 'platform'] as const) {
    for (const entry of cases) {
      await t.test(`${mode}: ${entry.label}`, async () => {
        const row = eligibilityRow(mode);
        delete row.authority_now;
        if (entry.present) row.authority_now = entry.value;
        if (entry.inherited) Object.setPrototypeOf(row, { authority_now: entry.value });
        let healthCalls = 0;
        const { scheduler, state, input } = setup(
          mode,
          { eligibilityRows: new Map([['account-a', [row]]]) },
          {
            health: {
              async get() {
                healthCalls += 1;
                return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
              },
            },
          },
        );
        const result = await scheduler.select(input([candidate(mode)]));
        assert.equal(result.decision, 'block');
        if (result.decision === 'block') assert.match(result.message, /database eligibility authority clock/);
        assert.equal(healthCalls, 0);
        assert.equal(
          state.statements.some(({ sql }) => sql.includes(':concurrency')),
          false,
        );
      });
    }
  }
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
  // R-dormant (115): the scheduling-threshold candidate read runs between
  // the group resolution and the route read — it is a scheduling-signal
  // read, never an eligibility or concurrency read.
  assert.equal(state.statements.length, 3);
  assert.ok(state.statements[0]?.sql.includes('postgres-provider-account-scheduler:billing-group'));
  assert.ok(state.statements[1]?.sql.includes('postgres-provider-account-scheduler:threshold-candidates'));
  assert.ok(state.statements[2]?.sql.includes('postgres-provider-account-scheduler:route'));
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
  // K2: the durable health authority denied the only candidate — an
  // availability block (503), not the account_denied 403.
  assert.equal(result.decision, 'block');
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

test('Kimi quota 429 cooldown denies a candidate only until its persisted deadline', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const row = {
        ...eligibilityRow(mode, 'account-a'),
        account_kimi_rate_limited_until: new Date(NOW.getTime() + 60_000).toISOString(),
      };
      const rows = new Map([['account-a', [row]]]);
      const { scheduler, input } = setup(mode, { eligibilityRows: rows });
      const denied = await scheduler.select(input([candidate(mode, 'account-a')]));
      assert.equal(denied.decision, 'reject');
      row.account_kimi_rate_limited_until = NOW.toISOString();
      const recovered = await scheduler.select(input([candidate(mode, 'account-a')]));
      assert.equal(recovered.decision, 'allow');
    });
  }
});

test('a live grok 429 cooldown and the free-tier soft gate deny the candidate (migration 119, 9.1)', async (t) => {
  const now = NOW.getTime();
  const fresh = new Date(now - 60_000).toISOString();
  const future = new Date(now + 10 * 60_000).toISOString();

  await t.test('a live persisted 429 cooldown denies only this candidate', async () => {
    const rows = new Map([
      [
        'account-a',
        [
          {
            ...eligibilityRow('byok', 'account-a'),
            account_grok_subscription_tier: 'free',
            account_grok_5h_used_percent: 10,
            account_grok_usage_updated_at: fresh,
            account_grok_rate_limited_until: future,
          },
        ],
      ],
      ['account-b', [eligibilityRow('byok', 'account-b')]],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a'), candidate('byok', 'account-b')]));
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  });

  await t.test('a past 429 cooldown keeps the candidate eligible (NULL-or-elapsed semantics)', async () => {
    const rows = new Map([
      [
        'account-a',
        [
          {
            ...eligibilityRow('byok', 'account-a'),
            account_grok_subscription_tier: 'free',
            account_grok_5h_used_percent: 10,
            account_grok_usage_updated_at: fresh,
            account_grok_rate_limited_until: new Date(now - 1_000).toISOString(),
          },
        ],
      ],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a')]));
    assert.equal(result.decision, 'allow');
  });

  await t.test('a fresh free-tier snapshot at the 95% floor excludes the candidate', async () => {
    const rows = new Map([
      [
        'account-a',
        [
          {
            ...eligibilityRow('byok', 'account-a'),
            account_grok_subscription_tier: 'free',
            account_grok_5h_used_percent: 95,
            account_grok_usage_updated_at: fresh,
            account_grok_rate_limited_until: null,
          },
        ],
      ],
      ['account-b', [eligibilityRow('byok', 'account-b')]],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a'), candidate('byok', 'account-b')]));
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  });

  await t.test('a paid tier at 100% observed is never gated', async () => {
    const rows = new Map([
      [
        'account-a',
        [
          {
            ...eligibilityRow('byok', 'account-a'),
            account_grok_subscription_tier: 'supergrok',
            account_grok_5h_used_percent: 100,
            account_grok_usage_updated_at: fresh,
            account_grok_rate_limited_until: null,
          },
        ],
      ],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a')]));
    assert.equal(result.decision, 'allow');
  });

  await t.test('a stale free-tier snapshot is admitted (fail-open)', async () => {
    const rows = new Map([
      [
        'account-a',
        [
          {
            ...eligibilityRow('byok', 'account-a'),
            account_grok_subscription_tier: 'free',
            account_grok_5h_used_percent: 100,
            account_grok_usage_updated_at: new Date(now - 2 * 60 * 60 * 1000 - 1).toISOString(),
            account_grok_rate_limited_until: null,
          },
        ],
      ],
    ]);
    const { scheduler, input } = setup('byok', { eligibilityRows: rows });
    const result = await scheduler.select(input([candidate('byok', 'account-a')]));
    assert.equal(result.decision, 'allow');
  });

  await t.test('row columns absent entirely keep the default selection (fixture red line)', async () => {
    const { scheduler, input } = setup('byok');
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'allow');
  });

  await t.test('the eligibility SQL projects the migration-119 columns', async () => {
    const { scheduler: projected, state: queried, input: projectedInput } = setup('byok');
    await projected.select(projectedInput([candidate('byok')]));
    const eligibilitySql = queried.statements.find(({ sql }) => sql.includes('eligibility'))?.sql;
    for (const column of [
      'account.grok_subscription_tier AS account_grok_subscription_tier',
      'account.grok_5h_used_percent AS account_grok_5h_used_percent',
      'account.grok_usage_updated_at AS account_grok_usage_updated_at',
      'account.grok_rate_limited_until AS account_grok_rate_limited_until',
    ]) {
      assert.ok(eligibilitySql?.includes(column), `missing ${column}`);
    }
  });
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

test('the rate window query is a bounded single-index trailing-minute read with the database authority clock', async () => {
  const authorityAt = new Date(NOW.getTime() + 35);
  const rows = new Map([
    ['account-a', [{ ...eligibilityRow('byok', 'account-a'), authority_now: authorityAt, account_rpm_limit: 10 }]],
  ]);
  const { scheduler, state, input } = setup('byok', {
    eligibilityRows: rows,
    rateWindows: new Map([['account-a', [{ requests: '3', tokens: '42' }]]]),
  });
  const result = await scheduler.select(input([candidate('byok')]));
  assert.equal(result.decision, 'allow');
  const query = state.statements.find(({ sql }) => sql.includes(':rate-window'));
  assert.ok(query);
  assert.deepEqual(query.values, ['tenant', 'account-a', authorityAt]);
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
  refreshedViewFor: (accountId: string) => ProviderAccountHealthSchedulingView = () => allowView(),
): { store: ProbeStore; calls: ProbeStoreCalls } {
  const calls: {
    admissions: Array<{ accountId: string; staleAfterMs?: number }>;
    outcomes: Array<{ accountId: string; fencingToken: string; evidence: unknown }>;
    views: string[];
  } = { admissions: [], outcomes: [], views: [] };
  const refreshed = new Set<string>();
  return {
    calls,
    store: {
      async getSchedulingView(input) {
        calls.views.push(input.candidate.accountId);
        return refreshed.has(input.candidate.accountId)
          ? refreshedViewFor(input.candidate.accountId)
          : viewFor(input.candidate.accountId);
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
        if (applied === 'applied') refreshed.add(input.candidate.accountId);
        return applied;
      },
    },
  };
}

function allowView(
  observedAt = NOW,
  status: 'healthy' | 'degraded' | 'cooldown' | 'unhealthy' = 'healthy',
  cooldownUntil: Date | null = null,
): ProviderAccountHealthSchedulingView {
  return {
    decision: 'allow',
    value: {
      status,
      observedAt,
      cooldownUntil,
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

test('the half-open wrapper forwards the clock and samples it after the view await', async () => {
  let current = NOW.getTime();
  const clock = () => new Date(current);
  const { store, calls } = probeStore(() => {
    current += 1_000;
    return allowView(new Date(current));
  }, 'admitted');
  const get = store.getSchedulingView.bind(store);
  store.getSchedulingView = async (input) => {
    assert.equal(input.clock, clock);
    assert.equal(input.now.getTime(), NOW.getTime());
    await Promise.resolve();
    return get(input);
  };
  const { scheduler, input } = setup(
    'byok',
    {},
    {
      now: clock,
      healthProbe: { store, leaseProvider: { acquire: async () => null } },
    },
  );
  assert.equal((await scheduler.select(input([candidate('byok')]))).decision, 'allow');
  assert.deepEqual(calls.admissions, []);
  assert.equal(calls.views.length, 1);
});

test('invalid half-open read clocks cannot start a probe or fall back', async (t) => {
  for (const [name, clock] of [
    ['undefined', undefined],
    ['null', null],
    ['non-function', 1],
    [
      'throw',
      () => {
        throw new Error('test-only clock failure');
      },
    ],
    ['invalid Date', () => new Date(Number.NaN)],
    ['non-Date result', () => NOW.toISOString()],
    ['inherited', () => NOW],
  ] as const) {
    await t.test(name, async () => {
      const { store, calls } = probeStore(() => staleView(), 'admitted');
      const get = store.getSchedulingView.bind(store);
      store.getSchedulingView = async (input) => {
        if (name === 'inherited') {
          Reflect.deleteProperty(input, 'clock');
          Object.setPrototypeOf(input, { clock });
        } else {
          Reflect.set(input, 'clock', clock);
        }
        return get(input);
      };
      const { scheduler, input } = setup(
        'byok',
        {},
        {
          healthProbe: { store, leaseProvider: { acquire: async () => null } },
        },
      );
      assert.equal((await scheduler.select(input([candidate('byok')]))).decision, 'block');
      assert.deepEqual(calls.admissions, []);
      assert.deepEqual(calls.outcomes, []);
      assert.equal(calls.views.length, 1);
    });
  }
});

test('a successful probe releases its lease before one real fresh view read', async () => {
  let current = NOW.getTime();
  const clock = () => new Date(current);
  const events: string[] = [];
  const { store, calls } = probeStore(
    () => staleView(),
    'admitted',
    'applied',
    () => allowView(new Date(current), 'degraded'),
  );
  const get = store.getSchedulingView.bind(store);
  store.getSchedulingView = async (input) => {
    assert.equal(input.clock, clock);
    events.push(calls.views.length === 0 ? 'initial-read' : 'refresh-read');
    return get(input);
  };
  const record = store.recordRuntimeOutcome.bind(store);
  store.recordRuntimeOutcome = async (input) => {
    events.push('outcome');
    current += 1_000;
    return record(input);
  };
  const { scheduler, input } = setup(
    'byok',
    {},
    {
      now: clock,
      healthProbe: {
        store,
        leaseProvider: {
          async acquire() {
            events.push('acquire');
            return {
              fencingToken: '9001',
              async release() {
                events.push('release');
                current += 1_000;
              },
            };
          },
        },
      },
    },
  );
  assert.equal((await scheduler.select(input([candidate('byok')]))).decision, 'allow');
  assert.deepEqual(events, ['initial-read', 'acquire', 'outcome', 'release', 'refresh-read']);
  assert.equal(calls.views.length, 2);
  assert.equal(calls.admissions.length, 1);
  assert.equal(calls.outcomes.length, 1);
});

test('a probe refresh never fabricates success or recursively probes', async (t) => {
  for (const failure of [
    'stale',
    'unknown',
    'malformed',
    'unavailable',
    'future',
    'expired',
    'cooldown',
    'unhealthy',
    'invalid-observation',
    'throw',
    'invalid-clock',
  ] as const) {
    await t.test(failure, async () => {
      const { store, calls } = probeStore(
        () => staleView(),
        'admitted',
        'applied',
        () => {
          if (failure === 'throw') throw new Error('test-only refresh failure');
          if (failure === 'stale' || failure === 'unknown' || failure === 'malformed' || failure === 'unavailable') {
            return { decision: 'block', reason: 'test-only refresh refusal', code: failure };
          }
          if (failure === 'future') return allowView(new Date(NOW.getTime() + 251));
          if (failure === 'expired') return allowView(new Date(NOW.getTime() - 60_001));
          if (failure === 'invalid-observation') return allowView(new Date(Number.NaN));
          if (failure === 'cooldown') return allowView(NOW, 'cooldown', new Date(NOW.getTime() + 1_000));
          if (failure === 'unhealthy') return allowView(NOW, 'unhealthy');
          return allowView();
        },
      );
      const get = store.getSchedulingView.bind(store);
      store.getSchedulingView = async (input) => {
        if (failure === 'invalid-clock' && calls.views.length === 1) {
          Reflect.set(input, 'clock', () => new Date(Number.NaN));
        }
        return get(input);
      };
      let releases = 0;
      const { scheduler, input } = setup(
        'byok',
        {},
        {
          healthProbe: {
            store,
            leaseProvider: {
              acquire: async () => ({
                fencingToken: '9001',
                release: async () => {
                  releases++;
                },
              }),
            },
          },
        },
      );
      assert.equal((await scheduler.select(input([candidate('byok')]))).decision, 'block');
      assert.equal(calls.views.length, 2);
      assert.equal(calls.admissions.length, 1);
      assert.equal(calls.outcomes.length, 1);
      assert.equal(releases, 1);
    });
  }
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

  // With the stale account as the only candidate the selection blocks as a
  // 503 availability signal (K2: the durable health authority denied it);
  // the concurrent winner's probe will refresh the row.
  const single = await scheduler.select(input([candidate('byok')]));
  assert.equal(single.decision, 'block');
  if (single.decision === 'block') assert.equal(single.code, 'capability_unavailable');
});

test('a probe that cannot acquire or record its outcome denies the candidate (H5a)', async () => {
  const noLease = probeStore(() => staleView(), 'admitted');
  const noLeaseSetup = setup(
    'byok',
    {},
    { healthProbe: { store: noLease.store, leaseProvider: { acquire: async () => null } } },
  );
  const rejected = await noLeaseSetup.scheduler.select(noLeaseSetup.input([candidate('byok')]));
  // K2: the durable health authority (stale row, probe in flight) denied the
  // candidate — an availability block, not an account_denied rejection.
  assert.equal(rejected.decision, 'block');
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
  // K2: same durable-authority deny shape — a 503 availability block.
  assert.equal(fencedResult.decision, 'block');
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

/* ------------------------------------------------------------------ */
/* P18 (R9 re-run finding): zero-row cold-start probe wiring           */
/* ------------------------------------------------------------------ */

function unknownView(): ProviderAccountHealthSchedulingView {
  return {
    decision: 'block',
    reason: 'provider account runtime health is unknown',
    code: 'unknown',
  };
}

test('a zero-row scheduling view is cold-start primed by a half-open probe (P18)', async () => {
  const { store, calls } = probeStore(() => unknownView(), 'admitted');
  let releases = 0;
  const leaseProvider = {
    async acquire() {
      return {
        fencingToken: '9003',
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
  // The cold-start prime rides the same admission call as the stale path.
  assert.deepEqual(calls.admissions, [{ accountId: 'account-a', staleAfterMs: 60_000 }]);
  assert.equal(calls.outcomes.length, 1);
  assert.equal(calls.outcomes[0]?.fencingToken, '9003');
  assert.deepEqual(calls.outcomes[0]?.evidence, { source: 'probe', result: 'success' });
  assert.equal(releases, 1);
});

test('a losing cold-start prime admission denies only the unobserved candidate (P18)', async () => {
  const { store, calls } = probeStore(
    (accountId) => (accountId === 'account-a' ? unknownView() : allowView()),
    'closed',
  );
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

  // The concurrent winner's prime will create the row; until then the lone
  // unobserved candidate blocks as a 503 availability signal (K2: the durable
  // health authority denied it), never a gateway 403.
  const single = await scheduler.select(input([candidate('byok')]));
  assert.equal(single.decision, 'block');
  if (single.decision === 'block') assert.equal(single.code, 'capability_unavailable');
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

test('modelCooldown is forwarded to the core scheduler and cools only the (account, model) pair (9.1)', async () => {
  const { scheduler, input } = setup(
    'byok',
    {},
    {
      modelCooldown: {
        isModelExcluded(probe: { candidate: RequestPreparationCandidateAuthority; model: string }) {
          assert.equal(probe.model, 'provider-model-a');
          return probe.candidate.accountId === 'account-a';
        },
      },
    },
  );
  const result = await scheduler.select(input([candidate('byok'), candidate('byok', 'account-b')]));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
});

test('half-open refresh bookkeeping preserves the native authority observer shape', () => {
  const { store } = probeStore(() => staleView(), 'admitted');
  const { scheduler } = setup(
    'byok',
    {},
    {
      healthProbe: { store, leaseProvider: { acquire: async () => null } },
    },
  );
  const health = (
    scheduler as unknown as {
      scheduler: { dependencies: { health: ProviderAccountSchedulerHealthPort } };
    }
  ).scheduler.dependencies.health;
  assert.deepEqual(Reflect.ownKeys(health).sort(), ['leaseProvider', 'maxHealthAgeMs', 'store']);
});

test('concurrent stale-health callers await one refresh and independently re-read authority', async () => {
  const count = 32;
  let initialReads = 0;
  let admitCalls = 0;
  let outcomeCalls = 0;
  let freshReads = 0;
  let releases = 0;
  let refreshed = false;
  let allInitialReads!: () => void;
  const initialBarrier = new Promise<void>((resolve) => {
    allInitialReads = resolve;
  });
  const store: ProbeStore = {
    async getSchedulingView() {
      if (refreshed) {
        freshReads++;
        return allowView();
      }
      if (++initialReads === count) allInitialReads();
      await initialBarrier;
      return staleView();
    },
    async tryAdmitHalfOpenProbe() {
      return ++admitCalls === 1 ? 'admitted' : 'closed';
    },
    async recordRuntimeOutcome() {
      outcomeCalls++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      refreshed = true;
      return 'applied';
    },
  };
  const { scheduler, input } = setup(
    'byok',
    {},
    {
      healthProbe: {
        store,
        leaseProvider: {
          acquire: async () => ({
            fencingToken: '9001',
            release: async () => {
              releases++;
            },
          }),
        },
      },
    },
  );
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      scheduler.select({
        ...input([candidate('byok')]),
        requestId: `concurrent-${i}`,
      }),
    ),
  );
  assert.deepEqual(
    results.map(({ decision }) => decision),
    Array(count).fill('allow'),
  );
  assert.equal(admitCalls, 1);
  assert.equal(outcomeCalls, 1);
  assert.equal(releases, 1);
  assert.equal(freshReads, count);
});

test('three schedulers wait for a remote stale-health probe without duplicating it', async () => {
  const count = 24;
  let initialReads = 0;
  let admitCalls = 0;
  let outcomes = 0;
  let refreshed = false;
  let allInitial!: () => void;
  const barrier = new Promise<void>((resolve) => {
    allInitial = resolve;
  });
  const store: ProbeStore = {
    async getSchedulingView() {
      if (refreshed) return allowView();
      if (++initialReads === count) allInitial();
      await barrier;
      return staleView();
    },
    async tryAdmitHalfOpenProbe() {
      return ++admitCalls === 1 ? 'admitted' : 'closed';
    },
    async recordRuntimeOutcome() {
      outcomes++;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      refreshed = true;
      return 'applied';
    },
  };
  const gateways = Array.from({ length: 3 }, () =>
    setup(
      'byok',
      {},
      {
        healthProbe: {
          store,
          leaseProvider: { acquire: async () => ({ fencingToken: '9001', release: async () => {} }) },
        },
      },
    ),
  );
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const gateway = gateways[i % 3];
      return gateway.scheduler.select({ ...gateway.input([candidate('byok')]), requestId: `remote-${i}` });
    }),
  );
  assert.deepEqual(
    results.map(({ decision }) => decision),
    Array(count).fill('allow'),
  );
  assert.equal(admitCalls, 3);
  assert.equal(outcomes, 1);
});

test('concurrent health-refresh waiters never inherit a successful authority decision', async (t) => {
  for (const outcome of ['write-throws', 'fenced', 'cooldown', 'malformed', 'unavailable', 'expired'] as const) {
    await t.test(outcome, async () => {
      const count = 8;
      let initialReads = 0;
      let reads = 0;
      let writes = 0;
      let finished = false;
      let allInitial!: () => void;
      const barrier = new Promise<void>((resolve) => {
        allInitial = resolve;
      });
      const store: ProbeStore = {
        async getSchedulingView() {
          reads++;
          if (finished) {
            if (outcome === 'cooldown') return allowView(NOW, 'cooldown', new Date(NOW.getTime() + 1000));
            if (outcome === 'expired') return allowView(new Date(NOW.getTime() - 60_001));
            if (outcome === 'malformed' || outcome === 'unavailable')
              return { decision: 'block', reason: 'test-only refusal', code: outcome };
            return staleView();
          }
          if (++initialReads === count) allInitial();
          await barrier;
          return staleView();
        },
        async tryAdmitHalfOpenProbe() {
          return 'admitted';
        },
        async recordRuntimeOutcome() {
          writes++;
          await new Promise<void>((resolve) => setImmediate(resolve));
          finished = true;
          if (outcome === 'write-throws') throw new Error('test-only write failure');
          return outcome === 'fenced' ? 'stale' : 'applied';
        },
      };
      const { scheduler, input } = setup(
        'byok',
        {},
        {
          healthProbe: {
            store,
            leaseProvider: { acquire: async () => ({ fencingToken: '9001', release: async () => {} }) },
          },
        },
      );
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          scheduler.select({
            ...input([candidate('byok')]),
            requestId: `negative-${i}`,
          }),
        ),
      );
      assert.deepEqual(
        results.map(({ decision }) => decision),
        Array(count).fill('block'),
      );
      assert.equal(writes, 1);
      assert.ok(reads <= count * 2, 'failed probes do not recursively poll or probe');
    });
  }
});

test('half-open single-flight keys isolate BYOK tenants and account identities', async () => {
  let writes = 0;
  const refreshed = new Set<string>();
  const scope = (value: { tenantId: string; accountId: string }) => JSON.stringify([value.tenantId, value.accountId]);
  const store: ProbeStore = {
    async getSchedulingView({ candidate: value }) {
      return refreshed.has(scope(value)) ? allowView() : staleView();
    },
    async tryAdmitHalfOpenProbe() {
      return 'admitted';
    },
    async recordRuntimeOutcome({ candidate: value }) {
      writes++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      refreshed.add(scope(value));
      return 'applied';
    },
  };
  const { scheduler } = setup(
    'byok',
    {},
    {
      healthProbe: {
        store,
        leaseProvider: { acquire: async () => ({ fencingToken: '9001', release: async () => {} }) },
      },
    },
  );
  const health = (
    scheduler as unknown as { scheduler: { dependencies: { health: ProviderAccountSchedulerHealthPort } } }
  ).scheduler.dependencies.health;
  const results = await Promise.all(
    [
      ['tenant-a', 'account-a'],
      ['tenant-b', 'account-a'],
      ['tenant-a', 'account-b'],
    ].map(([tenantId, accountId]) =>
      health.get({
        caller: { ...caller('byok'), tenantId },
        candidate: { ...candidate('byok', accountId), tenantId },
        now: NOW,
      }),
    ),
  );
  assert.deepEqual(
    results.map(({ decision }) => decision),
    ['allow', 'allow', 'allow'],
  );
  assert.equal(writes, 3);
});

test('remote probe waiting is bounded and never retries a real health or storage refusal', async (t) => {
  for (const refusal of ['stale', 'cooldown', 'unavailable', 'malformed', 'admission-throws'] as const) {
    await t.test(refusal, async () => {
      let reads = 0;
      let admissions = 0;
      const store: ProbeStore = {
        async getSchedulingView() {
          if (++reads === 1 || refusal === 'stale' || refusal === 'admission-throws') return staleView();
          if (refusal === 'cooldown') return allowView(NOW, 'cooldown', new Date(NOW.getTime() + 1000));
          return { decision: 'block', reason: 'test-only refusal', code: refusal };
        },
        async tryAdmitHalfOpenProbe() {
          admissions++;
          if (refusal === 'admission-throws') throw new Error('test-only unavailable admission');
          return 'closed';
        },
        async recordRuntimeOutcome() {
          assert.fail('CAS losers must never write a probe outcome');
        },
      };
      const { scheduler, input } = setup(
        'byok',
        {},
        { healthProbe: { store, leaseProvider: { acquire: async () => null } } },
      );
      const started = performance.now();
      const result = await scheduler.select(input([candidate('byok')]));
      const elapsed = performance.now() - started;
      assert.equal(result.decision, 'block');
      assert.equal(admissions, 1);
      if (refusal === 'stale') {
        assert.ok(elapsed >= 900 && elapsed < 2500, `bounded wait took ${elapsed}ms`);
        assert.ok(reads > 2 && reads <= 45, `bounded poll count: ${reads}`);
      } else {
        assert.equal(reads, refusal === 'admission-throws' ? 1 : 2);
      }
    });
  }
});
