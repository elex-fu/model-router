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

/*
 * R7 PostgreSQL scheduler strategy tests (plan §R7): the eligibility queries
 * surface the 099/100/108 scheduling columns, the supplier-cost-rate read is
 * issued only when cost-priority is enabled, and every strategy-enabled
 * selection records its discriminated dimensions on the attempt audit.
 */

type Row = Record<string, unknown>;

const NOW = new Date('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;

const HEALTHY: ProviderAccountSchedulerHealthPort = {
  async get() {
    return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
  },
};

function caller(): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    modelScopes: ['public-model'],
    authzVersion: 2,
    entitlementVersion: 4,
    supplyProfileVersion: 3,
    modelScopeVersion: 5,
  };
}

function entitlement(): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 4,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 3,
    supplyMode: 'platform',
    modelScopeVersion: 5,
    allowedModels: ['public-model'],
    allowedProviderIds: [],
    projectPolicyVersion: 6,
  };
}

function candidate(
  accountId: string,
  supplierCostVersion: string | null = 'cost-v2',
): RequestPreparationCandidateAuthority {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    upstreamId: 'pool-a',
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
    supplierCostVersion,
    providerId: 'provider-a',
    productId: 'product-a',
    poolId: 'pool-a',
    poolAuthzVersion: 2,
    poolMemberAccountAuthzVersion: 4,
    poolMemberAuthzVersion: 6,
    poolGrantAuthzVersion: 7,
    poolGrantProfileAuthzVersion: 3,
    poolGrantPoolAuthzVersion: 2,
  };
}

function routeRow(): Row {
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
    supply_mode: 'platform',
    target_mode: 'platform_pool',
    upstream_id: 'pool-a',
    endpoint: 'https://catalog.example/v1',
    public_model_alias: 'public-model',
    public_model_status: 'active',
    public_model_version_status: 'active',
    provider_id: 'provider-a',
    product_id: 'product-a',
    model: 'provider-model-a',
  };
}

function eligibilityRow(accountId: string, scheduling: Row = {}): Row {
  return {
    product_status: 'active',
    profile_tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    profile_supply_mode: 'platform',
    profile_status: 'active',
    profile_authz_version: '3',
    profile_model_scopes: ['public-model'],
    account_owner_kind: 'platform',
    account_supply_mode: 'platform',
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
    credential_owner_kind: 'platform',
    credential_supply_mode: 'platform',
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
    version_owner_kind: 'platform',
    version_supply_mode: 'platform',
    version_credential_id: `credential-${accountId}`,
    credential_version: 2,
    version_status: 'active',
    version_expires_at: null,
    account_rights_provider_id: 'provider-a',
    account_rights_product_id: 'product-a',
    account_rights_credential_type: 'api-key',
    account_rights_supply_mode: 'platform',
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
    // R7 quota-window scheduling columns (NULL = never observed = no signal).
    account_codex_5h_used_percent: null,
    account_codex_7d_used_percent: null,
    account_codex_5h_reset_at: null,
    account_codex_7d_reset_at: null,
    account_codex_usage_updated_at: null,
    account_claude_5h_utilization: null,
    account_claude_7d_utilization: null,
    account_claude_7d_sonnet_utilization: null,
    account_claude_7d_oi_utilization: null,
    account_claude_5h_reset_at: null,
    account_claude_7d_reset_at: null,
    account_claude_7d_sonnet_reset_at: null,
    account_claude_7d_oi_reset_at: null,
    account_claude_usage_updated_at: null,
    account_gemini_shared_daily_used: null,
    account_gemini_shared_daily_limit: null,
    account_gemini_pro_daily_used: null,
    account_gemini_pro_daily_limit: null,
    account_gemini_flash_daily_used: null,
    account_gemini_flash_daily_limit: null,
    account_gemini_daily_reset_at: null,
    account_gemini_usage_updated_at: null,
    account_opencode_go_rolling_5h_reset_at: null,
    account_opencode_go_weekly_reset_at: null,
    account_opencode_go_monthly_reset_at: null,
    account_opencode_go_usage_updated_at: null,
    ...scheduling,
  };
}

interface FakeDatabaseState {
  readonly eligibilityRows: ReadonlyMap<string, Row[]>;
  readonly supplierCostRows?: ReadonlyMap<string, Row[]>;
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
      rows = [routeRow()];
    } else if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) {
      const accountId = String(values[3]);
      rows = this.state.eligibilityRows.get(accountId) ?? [eligibilityRow(accountId)];
    } else if (sql.includes('postgres-provider-account-scheduler:supplier-cost-rate')) {
      const costVersion = String(values[0]);
      rows = this.state.supplierCostRows?.get(costVersion) ?? [];
    } else if (sql.includes('postgres-provider-account-scheduler:selection-audit')) {
      rows = [];
    } else if (sql.includes('postgres-provider-account-scheduler:rate-window')) {
      rows = [{ requests: '0', tokens: '0' }];
    } else if (sql.includes('postgres-provider-account-scheduler:concurrency')) {
      rows = [{ in_flight: '0' }];
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
  overrides: Partial<FakeDatabaseState> = {},
  optionOverrides: Partial<PostgresProviderAccountSchedulerOptions> = {},
) {
  const state: FakeDatabaseState = {
    eligibilityRows: new Map(),
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
  const input = (candidates: readonly RequestPreparationCandidateAuthority[], attemptId?: string) => ({
    requestId: 'request-a',
    ...(attemptId !== undefined ? { attemptId } : {}),
    caller: caller(),
    entitlement: entitlement(),
    candidates,
    publicModel: 'public-model',
    protocol: 'openai' as const,
  });
  return { scheduler, state, input };
}

test('the eligibility query surfaces the quota scheduling columns', async () => {
  const { scheduler, state, input } = setup();
  const result = await scheduler.select(input([candidate('account-a')]));
  assert.equal(result.decision, 'allow');
  const eligibilitySql = state.statements.find(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
  )?.sql;
  assert.ok(eligibilitySql);
  for (const column of [
    'account.codex_5h_used_percent AS account_codex_5h_used_percent',
    'account.codex_7d_used_percent AS account_codex_7d_used_percent',
    'account.codex_5h_reset_at AS account_codex_5h_reset_at',
    'account.codex_7d_reset_at AS account_codex_7d_reset_at',
    'account.codex_usage_updated_at AS account_codex_usage_updated_at',
    'account.claude_5h_utilization AS account_claude_5h_utilization',
    'account.claude_7d_utilization AS account_claude_7d_utilization',
    'account.claude_7d_sonnet_utilization AS account_claude_7d_sonnet_utilization',
    'account.claude_7d_oi_utilization AS account_claude_7d_oi_utilization',
    'account.claude_5h_reset_at AS account_claude_5h_reset_at',
    'account.claude_7d_reset_at AS account_claude_7d_reset_at',
    'account.claude_7d_sonnet_reset_at AS account_claude_7d_sonnet_reset_at',
    'account.claude_7d_oi_reset_at AS account_claude_7d_oi_reset_at',
    'account.claude_usage_updated_at AS account_claude_usage_updated_at',
    'account.gemini_shared_daily_used AS account_gemini_shared_daily_used',
    'account.gemini_shared_daily_limit AS account_gemini_shared_daily_limit',
    'account.gemini_pro_daily_used AS account_gemini_pro_daily_used',
    'account.gemini_pro_daily_limit AS account_gemini_pro_daily_limit',
    'account.gemini_flash_daily_used AS account_gemini_flash_daily_used',
    'account.gemini_flash_daily_limit AS account_gemini_flash_daily_limit',
    'account.gemini_daily_reset_at AS account_gemini_daily_reset_at',
    'account.gemini_usage_updated_at AS account_gemini_usage_updated_at',
    'account.opencode_go_rolling_5h_reset_at AS account_opencode_go_rolling_5h_reset_at',
    'account.opencode_go_weekly_reset_at AS account_opencode_go_weekly_reset_at',
    'account.opencode_go_monthly_reset_at AS account_opencode_go_monthly_reset_at',
    'account.opencode_go_usage_updated_at AS account_opencode_go_usage_updated_at',
  ]) {
    assert.ok(eligibilitySql.includes(column), `missing column projection: ${column}`);
  }
});

test('the default path issues no supplier-cost read and no selection audit', async () => {
  const { scheduler, state, input } = setup();
  const result = await scheduler.select(input([candidate('account-a')]));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.scheduling, undefined);
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('postgres-provider-account-scheduler:supplier-cost-rate')),
    false,
    'cost-priority is disabled: no supplier cost read may be issued',
  );
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('postgres-provider-account-scheduler:selection-audit')),
    false,
    'the default path must not write a scheduling audit row',
  );
});

test('soonest-reset promotion works end to end from the persisted codex columns', async () => {
  const { scheduler, input } = setup(
    {
      eligibilityRows: new Map([
        ['account-a', [eligibilityRow('account-a')]],
        [
          'account-b',
          [
            eligibilityRow('account-b', {
              account_codex_5h_reset_at: new Date(NOW.getTime() + 10 * MINUTE).toISOString(),
              account_codex_usage_updated_at: new Date(NOW.getTime() - MINUTE).toISOString(),
            }),
          ],
        ],
      ]),
    },
    { strategies: { soonestReset: { enabled: true } } },
  );
  for (let index = 0; index < 8; index += 1) {
    const result = await scheduler.select(input([candidate('account-a'), candidate('account-b')], `attempt-${index}`));
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') {
      assert.equal(result.value.accountId, 'account-b');
      assert.deepEqual(result.scheduling?.reasons, ['soonest-reset']);
    }
  }
});

test('an opencode-go weekly reset and a claude 7d reset feed the same signal', async () => {
  const { scheduler, input } = setup(
    {
      eligibilityRows: new Map([
        [
          'account-a',
          [
            eligibilityRow('account-a', {
              account_opencode_go_weekly_reset_at: new Date(NOW.getTime() + 20 * MINUTE).toISOString(),
              account_opencode_go_usage_updated_at: new Date(NOW.getTime() - 2 * MINUTE).toISOString(),
            }),
          ],
        ],
        [
          'account-b',
          [
            eligibilityRow('account-b', {
              account_claude_7d_reset_at: new Date(NOW.getTime() + 25 * MINUTE).toISOString(),
              account_claude_usage_updated_at: new Date(NOW.getTime() - MINUTE).toISOString(),
            }),
          ],
        ],
      ]),
    },
    { strategies: { soonestReset: { enabled: true }, lru: { enabled: true } } },
  );
  // Both accounts are imminent, so promotion does not discriminate; the LRU
  // tail then orders by the health observedAt (identical here) and shuffles
  // the tie group — the selection stays inside the promoted pair.
  const result = await scheduler.select(input([candidate('account-a'), candidate('account-b')], 'attempt-a'));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.ok(['account-a', 'account-b'].includes(result.value.accountId));
  }
});

test('cost priority reads the exact rational supplier rate only when enabled', async () => {
  const supplierCostRows = new Map<string, Row[]>([
    [
      'cost-free',
      [
        {
          input_rate_numerator_minor_units: '0',
          input_rate_denominator_units: '1',
          output_rate_numerator_minor_units: '0',
          output_rate_denominator_units: '1',
        },
      ],
    ],
    [
      'cost-metered',
      [
        {
          input_rate_numerator_minor_units: '1500',
          input_rate_denominator_units: '1000000',
          output_rate_numerator_minor_units: '6000',
          output_rate_denominator_units: '1000000',
        },
      ],
    ],
  ]);
  const { scheduler, state, input } = setup(
    { supplierCostRows },
    { strategies: { costPriority: { enabled: true }, lru: { enabled: true } } },
  );
  for (let index = 0; index < 8; index += 1) {
    const result = await scheduler.select(
      input([candidate('metered-account', 'cost-metered'), candidate('free-account', 'cost-free')], `attempt-${index}`),
    );
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') {
      assert.equal(result.value.accountId, 'free-account');
      assert.equal(result.scheduling?.reasons.includes('cost-priority'), true);
    }
  }
  const costQueries = state.statements.filter(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:supplier-cost-rate'),
  );
  assert.ok(costQueries.length > 0);
  for (const query of costQueries) {
    assert.ok(typeof query.values[0] === 'string' && (query.values[0] as string).startsWith('cost-'));
  }
});

test('a missing supplier cost version row is a null signal, not an error', async () => {
  const { scheduler, input } = setup(
    { supplierCostRows: new Map() },
    { strategies: { costPriority: { enabled: true }, lru: { enabled: true } } },
  );
  const result = await scheduler.select(input([candidate('account-a', 'cost-v2')], 'attempt-a'));
  assert.equal(result.decision, 'allow');
});

test('a malformed supplier cost rate blocks the whole selection', async () => {
  const { scheduler, input } = setup(
    {
      supplierCostRows: new Map<string, Row[]>([
        [
          'cost-v2',
          [
            {
              input_rate_numerator_minor_units: '1',
              input_rate_denominator_units: '0',
              output_rate_numerator_minor_units: '1',
              output_rate_denominator_units: '1',
            },
          ],
        ],
      ]),
    },
    { strategies: { costPriority: { enabled: true } } },
  );
  const result = await scheduler.select(input([candidate('account-a', 'cost-v2')], 'attempt-a'));
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /supplier cost rate is malformed/);
});

test('every strategy-enabled selection records the discriminated dimensions on the attempt audit', async () => {
  const supplierCostRows = new Map<string, Row[]>([
    [
      'cost-free',
      [
        {
          input_rate_numerator_minor_units: '0',
          input_rate_denominator_units: '1',
          output_rate_numerator_minor_units: '0',
          output_rate_denominator_units: '1',
        },
      ],
    ],
    [
      'cost-metered',
      [
        {
          input_rate_numerator_minor_units: '1500',
          input_rate_denominator_units: '1000000',
          output_rate_numerator_minor_units: '6000',
          output_rate_denominator_units: '1000000',
        },
      ],
    ],
  ]);
  const imminent = {
    account_codex_5h_reset_at: new Date(NOW.getTime() + 10 * MINUTE).toISOString(),
    account_codex_usage_updated_at: new Date(NOW.getTime() - MINUTE).toISOString(),
  };
  const { scheduler, state, input } = setup(
    {
      supplierCostRows,
      eligibilityRows: new Map([
        ['idle-account', [eligibilityRow('idle-account')]],
        ['free-account', [eligibilityRow('free-account', imminent)]],
        ['metered-account', [eligibilityRow('metered-account', imminent)]],
      ]),
    },
    { strategies: { soonestReset: { enabled: true }, costPriority: { enabled: true }, lru: { enabled: true } } },
  );
  // soonest-reset promotes the two imminent accounts, cost-priority then
  // orders the free pool ahead of the metered key inside that promotion.
  const result = await scheduler.select(
    input(
      [
        candidate('idle-account', 'cost-free'),
        candidate('metered-account', 'cost-metered'),
        candidate('free-account', 'cost-free'),
      ],
      'attempt-42',
    ),
  );
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.equal(result.value.accountId, 'free-account');
    assert.deepEqual(result.scheduling?.reasons, ['soonest-reset', 'cost-priority']);
  }
  const audit = state.statements.find(({ sql }) => sql.includes('postgres-provider-account-scheduler:selection-audit'));
  assert.ok(audit, 'a strategy-enabled selection must write an audit row');
  assert.match(audit.sql, /INSERT INTO saas_audit_events/);
  assert.equal(audit.values[1], 'tenant-a');
  assert.equal(audit.values[2], 'provider_account_scheduler.selection:soonest-reset+cost-priority');
  assert.equal(audit.values[3], 'saas_attempts');
  assert.equal(audit.values[4], 'attempt-42');
  assert.equal(audit.values[6], 'request-a');
});

test('a strategy-enabled selection without discriminated dimensions still audits the base action', async () => {
  const { scheduler, state, input } = setup({}, { strategies: { lru: { enabled: true } } });
  const result = await scheduler.select(input([candidate('account-a')], 'attempt-7'));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.deepEqual(result.scheduling?.reasons, []);
  const audit = state.statements.find(({ sql }) => sql.includes('postgres-provider-account-scheduler:selection-audit'));
  assert.ok(audit);
  assert.equal(audit.values[2], 'provider_account_scheduler.selection');
  assert.equal(audit.values[3], 'saas_attempts');
  assert.equal(audit.values[4], 'attempt-7');
});

test('a strategy-enabled selection without an attempt id audits against the request', async () => {
  const { scheduler, state, input } = setup({}, { strategies: { lru: { enabled: true } } });
  const result = await scheduler.select(input([candidate('account-a')]));
  assert.equal(result.decision, 'allow');
  const audit = state.statements.find(({ sql }) => sql.includes('postgres-provider-account-scheduler:selection-audit'));
  assert.ok(audit);
  assert.equal(audit.values[3], 'saas_requests');
  assert.equal(audit.values[4], 'request-a');
});

test('quota-aware excludes an exhausted codex window and always selects the ample account', async () => {
  const resetAt = new Date(NOW.getTime() + 60 * MINUTE).toISOString();
  const { scheduler, input } = setup(
    {
      eligibilityRows: new Map([
        [
          'account-a',
          [
            eligibilityRow('account-a', {
              account_codex_5h_used_percent: 100,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
        [
          'account-b',
          [
            eligibilityRow('account-b', {
              account_codex_5h_used_percent: 20,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
      ]),
    },
    { strategies: { quotaAware: { enabled: true } } },
  );
  for (let index = 0; index < 16; index += 1) {
    const result = await scheduler.select({
      ...input([candidate('account-a'), candidate('account-b')], `attempt-${index}`),
      requestId: `exhausted-${index}`,
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  }
});

test('quota-aware reached resets replenish both candidates', async () => {
  let current = new Date(NOW);
  const resetAt = new Date(NOW.getTime() + 5 * MINUTE).toISOString();
  const rows = new Map([
    [
      'account-a',
      [
        eligibilityRow('account-a', {
          account_codex_5h_used_percent: 100,
          account_codex_5h_reset_at: resetAt,
          account_codex_usage_updated_at: NOW.toISOString(),
        }),
      ],
    ],
    [
      'account-b',
      [
        eligibilityRow('account-b', {
          account_codex_5h_used_percent: 20,
          account_codex_5h_reset_at: resetAt,
          account_codex_usage_updated_at: NOW.toISOString(),
        }),
      ],
    ],
  ]);
  const { scheduler, input } = setup(
    { eligibilityRows: rows },
    {
      now: () => current,
      maxHealthAgeMs: 2 * 60 * 60_000,
      strategies: { quotaAware: { enabled: true } },
    },
  );
  const candidates = [candidate('account-a'), candidate('account-b')];
  const before = await scheduler.select({ ...input(candidates), requestId: 'before-reset' });
  assert.equal(before.decision, 'allow');
  if (before.decision === 'allow') assert.equal(before.value.accountId, 'account-b');

  current = new Date(NOW.getTime() + 10 * MINUTE);
  const selected = new Set<string>();
  for (let index = 0; index < 64 && selected.size < 2; index += 1) {
    const result = await scheduler.select({ ...input(candidates), requestId: `after-reset-${index}` });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') selected.add(result.value.accountId);
  }
  assert.deepEqual(selected, new Set(['account-a', 'account-b']));
});

test('quota-aware preserves sticky selection and excludes paused accounts from its domain', async () => {
  const resetAt = new Date(NOW.getTime() + 60 * MINUTE).toISOString();
  let observedEligibleIds: readonly string[] = [];
  const { scheduler, input } = setup(
    {
      eligibilityRows: new Map([
        [
          'account-a',
          [
            eligibilityRow('account-a', {
              account_codex_5h_used_percent: 90,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
        [
          'account-b',
          [
            eligibilityRow('account-b', {
              account_codex_5h_used_percent: 10,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
        [
          'account-c',
          [
            eligibilityRow('account-c', {
              account_codex_5h_used_percent: 100,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
      ]),
    },
    {
      strategies: { quotaAware: { enabled: true } },
      affinity: {
        async resolve(affinityInput) {
          observedEligibleIds = affinityInput.eligibleAccountIds;
          return { decision: 'allow', accountId: 'account-a' };
        },
        async bind() {
          return { decision: 'allow' };
        },
      },
    },
  );
  for (let index = 0; index < 8; index += 1) {
    const result = await scheduler.select({
      ...input([candidate('account-a'), candidate('account-b'), candidate('account-c')]),
      requestId: `sticky-${index}`,
      scheduling: { sessionId: 'sticky-quota-session' },
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') {
      assert.equal(result.value.accountId, 'account-a');
      assert.deepEqual(result.scheduling?.reasons, ['affinity']);
    }
    assert.deepEqual(observedEligibleIds, ['account-a', 'account-b']);
  }
});

test('disabled quota-aware preserves weighted selection and emits no scheduling audit', async () => {
  const resetAt = new Date(NOW.getTime() + 60 * MINUTE).toISOString();
  const { scheduler, state, input } = setup({
    eligibilityRows: new Map([
      [
        'account-a',
        [
          eligibilityRow('account-a', {
            account_codex_5h_used_percent: 100,
            account_codex_5h_reset_at: resetAt,
            account_codex_usage_updated_at: NOW.toISOString(),
          }),
        ],
      ],
      [
        'account-b',
        [
          eligibilityRow('account-b', {
            account_codex_5h_used_percent: 20,
            account_codex_5h_reset_at: resetAt,
            account_codex_usage_updated_at: NOW.toISOString(),
          }),
        ],
      ],
    ]),
  });
  const selected = new Set<string>();
  for (let index = 0; index < 64 && selected.size < 2; index += 1) {
    const result = await scheduler.select({
      ...input([candidate('account-a'), candidate('account-b')]),
      requestId: `default-${index}`,
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') {
      assert.equal(result.scheduling, undefined);
      selected.add(result.value.accountId);
    }
  }
  assert.deepEqual(selected, new Set(['account-a', 'account-b']));
  assert.equal(
    state.statements.some(({ sql }) => sql.includes(':selection-audit')),
    false,
  );
});

test('quota-aware stale snapshots sort as unknown probes rather than full quota', async () => {
  const resetAt = new Date(NOW.getTime() + 60 * MINUTE).toISOString();
  const { scheduler, input } = setup(
    {
      eligibilityRows: new Map([
        [
          'account-a',
          [
            eligibilityRow('account-a', {
              account_codex_5h_used_percent: 0,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
            }),
          ],
        ],
        [
          'account-b',
          [
            eligibilityRow('account-b', {
              account_codex_5h_used_percent: 80,
              account_codex_5h_reset_at: resetAt,
              account_codex_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
      ]),
    },
    { strategies: { quotaAware: { enabled: true } } },
  );
  for (let index = 0; index < 16; index += 1) {
    const result = await scheduler.select({
      ...input([candidate('account-a'), candidate('account-b')]),
      requestId: `stale-${index}`,
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') {
      assert.equal(result.value.accountId, 'account-b');
      assert.deepEqual(result.scheduling?.reasons, ['quota-aware']);
    }
  }
  const probe = await scheduler.select({ ...input([candidate('account-a')]), requestId: 'stale-probe' });
  assert.equal(probe.decision, 'allow');
  if (probe.decision === 'allow') assert.equal(probe.value.accountId, 'account-a');
});

test('quota-aware normalizes Claude utilization fractions and Gemini daily request counts', async () => {
  const resetAt = new Date(NOW.getTime() + 60 * MINUTE).toISOString();
  const { scheduler, input } = setup(
    {
      eligibilityRows: new Map([
        [
          'claude-account',
          [
            eligibilityRow('claude-account', {
              account_claude_5h_utilization: 0.1,
              account_claude_5h_reset_at: resetAt,
              account_claude_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
        [
          'gemini-account',
          [
            eligibilityRow('gemini-account', {
              account_gemini_shared_daily_used: 90,
              account_gemini_shared_daily_limit: 100,
              account_gemini_daily_reset_at: resetAt,
              account_gemini_usage_updated_at: NOW.toISOString(),
            }),
          ],
        ],
      ]),
    },
    { strategies: { quotaAware: { enabled: true } } },
  );
  for (let index = 0; index < 16; index += 1) {
    const result = await scheduler.select({
      ...input([candidate('claude-account'), candidate('gemini-account')]),
      requestId: `normalized-${index}`,
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') {
      assert.equal(result.value.accountId, 'claude-account');
      assert.deepEqual(result.scheduling?.reasons, ['quota-aware']);
    }
  }
});
