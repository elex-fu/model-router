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
import type { RedisConcurrencySlots } from '../../../src/saas/runtime/redis-concurrency-slots.js';

/*
 * F2 (task #35) scheduler-consumption tests: the R6a probe column exclusion,
 * the R1 billing-group account-pool narrowing and per-group priority, the
 * claude_code_only enforcement matrix (R5 validator), and the R6b Redis
 * concurrency-slot pre-check (enabled/disabled/fail-open). Fake-database
 * harness following the existing postgres-provider-account-scheduler test
 * pattern; the fake simulates the pool-membership SQL predicate so the
 * narrowing is exercised end to end.
 */

type Mode = 'byok' | 'platform';
type Row = Record<string, unknown>;

const NOW = new Date('2026-10-15T12:00:00.000Z');

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

function entitlement(mode: Mode, identity: ProviderIdentity = OPENAI_IDENTITY): RequestPreparationEntitlement {
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
    allowedProviderIds: mode === 'byok' ? [identity.providerId] : [],
    projectPolicyVersion: 6,
  };
}

interface ProviderIdentity {
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: 'openai' | 'anthropic';
}

const OPENAI_IDENTITY: ProviderIdentity = {
  providerId: 'provider-a',
  productId: 'product-a',
  protocol: 'openai',
};

const CLAUDE_IDENTITY: ProviderIdentity = {
  providerId: 'anthropic-claude',
  productId: 'claude-subscription',
  protocol: 'anthropic',
};

function candidate(mode: Mode, accountId = 'account-a', identity: ProviderIdentity = OPENAI_IDENTITY) {
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
    protocol: identity.protocol,
    endpoint: 'https://catalog.example/v1',
    supplierCostVersion: mode === 'platform' ? 'cost-v2' : null,
    providerId: identity.providerId,
    productId: identity.productId,
  };
  if (mode === 'byok') {
    return {
      ...common,
      supplyMode: 'byok' as const,
      accountOwnerKind: 'tenant' as const,
      upstreamId: 'tenant-route-a',
      profileAccountAuthzVersion: 5,
    };
  }
  return {
    ...common,
    supplyMode: 'platform' as const,
    accountOwnerKind: 'platform' as const,
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

function routeRow(mode: Mode, identity: ProviderIdentity = OPENAI_IDENTITY): Row {
  return {
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    route_id: 'route-a',
    current_version: '8',
    route_version: '8',
    route_status: 'active',
    public_model_id: 'public-model-id',
    public_model_version: 11,
    protocol: identity.protocol,
    supply_mode: mode,
    target_mode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    upstream_id: mode === 'byok' ? 'tenant-route-a' : 'pool-a',
    endpoint: 'https://catalog.example/v1',
    public_model_alias: 'public-model',
    public_model_status: 'active',
    public_model_version_status: 'active',
    provider_id: identity.providerId,
    product_id: identity.productId,
    model: 'provider-model-a',
  };
}

function eligibilityRow(mode: Mode, accountId = 'account-a', identity: ProviderIdentity = OPENAI_IDENTITY): Row {
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
    account_provider_id: identity.providerId,
    account_product_id: identity.productId,
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
    credential_provider_id: identity.providerId,
    credential_product_id: identity.productId,
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
    account_rights_provider_id: identity.providerId,
    account_rights_product_id: identity.productId,
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
    capability_protocol: identity.protocol,
    capability_support_level: 'supported',
    capability_validation_state: 'verified',
    account_capability_version: '12',
    // R7 quota-window scheduling columns (NULL = never observed = no signal).
    account_codex_5h_reset_at: null,
    account_codex_7d_reset_at: null,
    account_codex_usage_updated_at: null,
    account_claude_5h_reset_at: null,
    account_claude_7d_reset_at: null,
    account_claude_7d_sonnet_reset_at: null,
    account_claude_7d_oi_reset_at: null,
    account_claude_usage_updated_at: null,
    account_opencode_go_rolling_5h_reset_at: null,
    account_opencode_go_weekly_reset_at: null,
    account_opencode_go_monthly_reset_at: null,
    account_opencode_go_usage_updated_at: null,
  };
  if (mode === 'byok') {
    return {
      ...common,
      mapping_tenant_id: 'tenant-a',
      mapping_profile_id: 'profile-a',
      mapping_supply_mode: 'byok',
      mapping_account_id: accountId,
      mapping_provider_id: identity.providerId,
      mapping_product_id: identity.productId,
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
    pool_provider_id: identity.providerId,
    pool_product_id: identity.productId,
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
    member_provider_id: identity.providerId,
    member_product_id: identity.productId,
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
    pool_rights_provider_id: identity.providerId,
    pool_rights_product_id: identity.productId,
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
  readonly identity?: ProviderIdentity;
  routeRows?: Row[];
  readonly eligibilityRows?: ReadonlyMap<string, Row[]>;
  readonly inFlight?: ReadonlyMap<string, unknown>;
  /** F2: resolved billing-group rows; defaults to the seeded neutral group. */
  readonly groupRows?: Row[];
  /** F2: rows answered by the by-id fallback-group lookup (any id matches). */
  readonly groupByIdRows?: Row[];
  /** F2: group pools — groupId → accountId → per-group priority. */
  readonly pools?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
}

class FakeDatabase implements SaasDatabase {
  constructor(private readonly state: FakeDatabaseState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    const identity = this.state.identity ?? OPENAI_IDENTITY;
    let rows: Row[] = [];
    if (sql.includes('postgres-provider-account-scheduler:billing-group-by-id')) {
      const groupId = String(values[0]);
      rows = this.state.groupByIdRows ?? [{ id: groupId, claude_code_only: false, fallback_group_id: null }];
    } else if (sql.includes('postgres-provider-account-scheduler:billing-group')) {
      rows = this.state.groupRows ?? [{ id: 'default', claude_code_only: false, fallback_group_id: null }];
    } else if (sql.includes('postgres-provider-account-scheduler:route')) {
      rows = this.state.routeRows ?? [routeRow(this.state.mode, identity)];
    } else if (sql.includes('postgres-provider-account-scheduler:byok-eligibility')) {
      const accountId = String(values[2]);
      rows = this.state.eligibilityRows?.get(accountId) ?? [eligibilityRow('byok', accountId, identity)];
    } else if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) {
      const accountId = String(values[3]);
      const groupId = String(values[22]);
      const pool = this.state.pools?.get(groupId);
      if (pool !== undefined && !pool.has(accountId)) {
        // The SQL membership guard excludes non-members of a narrowed group.
        rows = [];
      } else {
        const base = this.state.eligibilityRows?.get(accountId) ?? [eligibilityRow('platform', accountId, identity)];
        rows = base.map((row) => ({
          ...row,
          group_pool_priority: pool?.has(accountId) ? pool.get(accountId) : row.group_pool_priority,
        }));
      }
    } else if (sql.includes('postgres-provider-account-scheduler:rate-window')) {
      rows = [{ requests: '0', tokens: '0' }];
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
  identity: ProviderIdentity = OPENAI_IDENTITY,
) {
  const state: FakeDatabaseState = {
    mode,
    identity,
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
  const input = (candidatesList: readonly RequestPreparationCandidateAuthority[], requestId = 'request-a') => ({
    requestId,
    caller: caller(mode),
    entitlement: entitlement(mode, identity),
    candidates: candidatesList,
    publicModel: 'public-model',
    protocol: identity.protocol,
  });
  return { scheduler, state, input };
}

/* ------------------------------------------------------------------ */
/* Piece 1 — R6a probe column consumption                              */
/* ------------------------------------------------------------------ */

test('both eligibility queries exclude accounts whose probe deadline is in the future', async (t) => {
  await t.test('byok predicate binds the shared revalidation clock ($14)', async () => {
    const { scheduler, state, input } = setup('byok');
    const result = await scheduler.select(input([candidate('byok')]));
    assert.equal(result.decision, 'allow');
    const sql = state.statements.find(({ sql: text }) =>
      text.includes('postgres-provider-account-scheduler:byok-eligibility'),
    )?.sql;
    assert.ok(sql);
    assert.match(
      sql,
      /account\.probe_temp_unschedulable_until IS NULL\s+OR account\.probe_temp_unschedulable_until <= \$14::timestamptz/,
    );
  });

  await t.test('platform predicate binds the shared revalidation clock ($20)', async () => {
    const { scheduler, state, input } = setup('platform');
    const result = await scheduler.select(input([candidate('platform')]));
    assert.equal(result.decision, 'allow');
    const sql = state.statements.find(({ sql: text }) =>
      text.includes('postgres-provider-account-scheduler:platform-eligibility'),
    )?.sql;
    assert.ok(sql);
    assert.match(
      sql,
      /account\.probe_temp_unschedulable_until IS NULL\s+OR account\.probe_temp_unschedulable_until <= \$20::timestamptz/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Piece 3a — billing-group pool narrowing and per-group priority      */
/* ------------------------------------------------------------------ */

test('the wrapper resolves the billing group once per platform selection', async () => {
  const { scheduler, state, input } = setup('platform', {
    eligibilityRows: new Map([
      ['account-a', [eligibilityRow('platform', 'account-a')]],
      ['account-b', [eligibilityRow('platform', 'account-b')]],
    ]),
  });
  const result = await scheduler.select(
    input([candidate('platform', 'account-a'), candidate('platform', 'account-b')]),
  );
  assert.equal(result.decision, 'allow');
  const groupQueries = state.statements.filter(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:billing-group'),
  );
  assert.equal(groupQueries.length, 1, 'exactly one group resolution per selection');
  assert.deepEqual(groupQueries[0]?.values, ['tenant-a', 'project-a', 'key-a']);
  const eligibility = state.statements.find(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
  );
  assert.equal(eligibility?.values[22], 'default');
});

test('byok selections never resolve a billing group', async () => {
  const { scheduler, state, input } = setup('byok');
  const result = await scheduler.select(input([candidate('byok')]));
  assert.equal(result.decision, 'allow');
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('postgres-provider-account-scheduler:billing-group')),
    false,
  );
});

test('a missing or ambiguous billing group blocks the whole selection', async (t) => {
  await t.test('no group row', async () => {
    const { scheduler, input } = setup('platform', { groupRows: [] });
    const result = await scheduler.select(input([candidate('platform')]));
    assert.equal(result.decision, 'block');
    if (result.decision === 'block') assert.match(result.message, /billing group authority is unavailable/);
  });

  await t.test('ambiguous group row', async () => {
    const { scheduler, input } = setup('platform', {
      groupRows: [
        { id: 'default', claude_code_only: false, fallback_group_id: null },
        { id: 'group-b', claude_code_only: false, fallback_group_id: null },
      ],
    });
    const result = await scheduler.select(input([candidate('platform')]));
    assert.equal(result.decision, 'block');
  });

  await t.test('malformed group flags', async () => {
    const { scheduler, input } = setup('platform', {
      groupRows: [{ id: 'default', claude_code_only: 'no', fallback_group_id: null }],
    });
    const result = await scheduler.select(input([candidate('platform')]));
    assert.equal(result.decision, 'block');
  });
});

test('a group with pool rows narrows the platform candidate domain to its members', async (t) => {
  const pools = new Map([['group-a', new Map([['account-a', 50]])]]);
  const eligibilityRows = new Map([
    ['account-a', [eligibilityRow('platform', 'account-a')]],
    ['account-b', [eligibilityRow('platform', 'account-b')]],
  ]);

  await t.test('a non-member is excluded and the member is selected', async () => {
    const { scheduler, state, input } = setup('platform', {
      groupRows: [{ id: 'group-a', claude_code_only: false, fallback_group_id: null }],
      pools,
      eligibilityRows,
    });
    for (let index = 0; index < 6; index += 1) {
      const result = await scheduler.select(
        input([candidate('platform', 'account-b'), candidate('platform', 'account-a')], `request-${index}`),
      );
      assert.equal(result.decision, 'allow');
      if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
    }
    const eligibility = state.statements.find(({ sql }) =>
      sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
    );
    assert.equal(eligibility?.values[22], 'group-a');
  });

  await t.test('every candidate excluded leaves no eligible account (reject, not block)', async () => {
    const { scheduler, input } = setup('platform', {
      groupRows: [{ id: 'group-a', claude_code_only: false, fallback_group_id: null }],
      pools,
      eligibilityRows: new Map([['account-b', [eligibilityRow('platform', 'account-b')]]]),
    });
    const result = await scheduler.select(input([candidate('platform', 'account-b')]));
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  });

  await t.test('the narrowing SQL carries the membership guard and the pool join', async () => {
    const { scheduler, state, input } = setup('platform', {
      groupRows: [{ id: 'group-a', claude_code_only: false, fallback_group_id: null }],
      pools,
    });
    await scheduler.select(input([candidate('platform', 'account-a')]));
    const sql = state.statements.find(({ sql: text }) =>
      text.includes('postgres-provider-account-scheduler:platform-eligibility'),
    )?.sql;
    assert.ok(sql);
    assert.match(
      sql,
      /LEFT JOIN saas_billing_group_account_pools group_pool\s+ON group_pool\.group_id = \$23 AND group_pool\.account_id = account\.id/,
    );
    assert.match(
      sql,
      /NOT EXISTS \(SELECT 1 FROM saas_billing_group_account_pools guard_pool\s+WHERE guard_pool\.group_id = \$23\)/,
    );
    assert.match(sql, /group_pool\.priority AS group_pool_priority/);
  });
});

test('a group with NO pool rows is unrestricted: every account stays eligible', async () => {
  const { scheduler, input } = setup('platform', {
    groupRows: [{ id: 'default', claude_code_only: false, fallback_group_id: null }],
    pools: new Map(),
    eligibilityRows: new Map([
      ['account-a', [eligibilityRow('platform', 'account-a')]],
      ['account-b', [eligibilityRow('platform', 'account-b')]],
    ]),
  });
  const result = await scheduler.select(
    input([candidate('platform', 'account-a'), candidate('platform', 'account-b')]),
  );
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.ok(['account-a', 'account-b'].includes(result.value.accountId));
  }
});

test('per-group priority orders the narrowed domain before the account priority tiers', async () => {
  // account-b has the lower ACCOUNT priority (0 vs 9) but the higher GROUP
  // priority; the group tier runs first, so account-b wins every seed.
  const { scheduler, input } = setup('platform', {
    groupRows: [{ id: 'group-a', claude_code_only: false, fallback_group_id: null }],
    pools: new Map([
      [
        'group-a',
        new Map([
          ['account-a', 10],
          ['account-b', 900],
        ]),
      ],
    ]),
    eligibilityRows: new Map([
      ['account-a', [{ ...eligibilityRow('platform', 'account-a'), account_priority: 9 }]],
      ['account-b', [eligibilityRow('platform', 'account-b')]],
    ]),
  });
  for (let index = 0; index < 8; index += 1) {
    const result = await scheduler.select(
      input([candidate('platform', 'account-a'), candidate('platform', 'account-b')], `request-${index}`),
    );
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  }
});

test('a malformed persisted group pool priority blocks the whole selection', async () => {
  const { scheduler, input } = setup('platform', {
    groupRows: [{ id: 'group-a', claude_code_only: false, fallback_group_id: null }],
    pools: new Map([['group-a', new Map([['account-a', 1001]])]]),
  });
  const result = await scheduler.select(input([candidate('platform', 'account-a')]));
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /billing group pool priority is malformed/);
});

/* ------------------------------------------------------------------ */
/* Piece 3b — claude_code_only enforcement                             */
/* ------------------------------------------------------------------ */

const VALID_CLAUDE_EVIDENCE = {
  userAgent: 'claude-cli/1.0.34',
  path: '/v1/messages',
  headers: { 'x-app': 'cli', 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
  body: {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    metadata: { user_id: 'user_a' },
  },
};

const THIRD_PARTY_EVIDENCE = {
  userAgent: 'curl/8.4.0',
  path: '/v1/messages',
  headers: {},
  body: { model: 'claude-sonnet-4-5-20250929', max_tokens: 1024 },
};

function claudeSetup(
  groupRow: Row,
  overrides: Partial<FakeDatabaseState> = {},
  optionOverrides: Partial<PostgresProviderAccountSchedulerOptions> = {},
) {
  return setup('platform', { groupRows: [groupRow], ...overrides }, optionOverrides, CLAUDE_IDENTITY);
}

test('claude_code_only admits a genuine Claude Code client under its own group', async () => {
  const { scheduler, state, input } = claudeSetup({ id: 'group-cc', claude_code_only: true, fallback_group_id: null });
  const result = await scheduler.select({
    ...input([candidate('platform', 'account-a', CLAUDE_IDENTITY)]),
    claudeCodeClient: VALID_CLAUDE_EVIDENCE,
  });
  assert.equal(result.decision, 'allow');
  const eligibility = state.statements.find(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
  );
  assert.equal(eligibility?.values[22], 'group-cc');
});

test('claude_code_only rejects third-party clients when no fallback group is set', async () => {
  const { scheduler, state, input } = claudeSetup({ id: 'group-cc', claude_code_only: true, fallback_group_id: null });
  const result = await scheduler.select({
    ...input([candidate('platform', 'account-a', CLAUDE_IDENTITY)]),
    claudeCodeClient: THIRD_PARTY_EVIDENCE,
  });
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') {
    assert.equal(result.code, 'account_denied');
    assert.match(result.message, /Claude Code clients/);
  }
  // The rejection happens before any candidate eligibility read.
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('postgres-provider-account-scheduler:platform-eligibility')),
    false,
  );
});

test('claude_code_only reroutes a failed validation to the fallback group', async (t) => {
  await t.test('the selection runs under the fallback group identity', async () => {
    const pools = new Map([['group-fallback', new Map([['account-b', 50]])]]);
    const { scheduler, state, input } = claudeSetup(
      { id: 'group-cc', claude_code_only: true, fallback_group_id: 'group-fallback' },
      {
        pools,
        eligibilityRows: new Map([
          ['account-a', [eligibilityRow('platform', 'account-a', CLAUDE_IDENTITY)]],
          ['account-b', [eligibilityRow('platform', 'account-b', CLAUDE_IDENTITY)]],
        ]),
      },
    );
    const result = await scheduler.select({
      ...input([
        candidate('platform', 'account-a', CLAUDE_IDENTITY),
        candidate('platform', 'account-b', CLAUDE_IDENTITY),
      ]),
      claudeCodeClient: THIRD_PARTY_EVIDENCE,
    });
    assert.equal(result.decision, 'allow');
    if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
    const fallbackQuery = state.statements.find(({ sql }) =>
      sql.includes('postgres-provider-account-scheduler:billing-group-by-id'),
    );
    assert.ok(fallbackQuery, 'the fallback group flags must be read');
    assert.deepEqual(fallbackQuery.values, ['group-fallback']);
    const eligibility = state.statements.find(({ sql }) =>
      sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
    );
    assert.equal(eligibility?.values[22], 'group-fallback');
  });

  await t.test('a fallback group that is itself claude_code_only rejects instead of looping', async () => {
    const { scheduler, input } = claudeSetup(
      { id: 'group-cc', claude_code_only: true, fallback_group_id: 'group-cc2' },
      { groupByIdRows: [{ id: 'group-cc2', claude_code_only: true, fallback_group_id: null }] },
    );
    const result = await scheduler.select({
      ...input([candidate('platform', 'account-a', CLAUDE_IDENTITY)]),
      claudeCodeClient: THIRD_PARTY_EVIDENCE,
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  });
});

test('claude_code_only fails closed when the client evidence is absent or malformed', async (t) => {
  await t.test('no evidence', async () => {
    const { scheduler, input } = claudeSetup({ id: 'group-cc', claude_code_only: true, fallback_group_id: null });
    const result = await scheduler.select(input([candidate('platform', 'account-a', CLAUDE_IDENTITY)]));
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
  });

  await t.test('malformed evidence shape', async () => {
    const { scheduler, input } = claudeSetup({ id: 'group-cc', claude_code_only: true, fallback_group_id: null });
    const result = await scheduler.select({
      ...input([candidate('platform', 'account-a', CLAUDE_IDENTITY)]),
      claudeCodeClient: { userAgent: 42, path: null, headers: {}, body: null } as unknown as {
        userAgent: string | null;
        path: string | null;
        headers: Record<string, string>;
        body: unknown;
      },
    });
    assert.equal(result.decision, 'reject');
  });
});

test('a group without claude_code_only ignores client evidence entirely', async () => {
  const { scheduler, input } = claudeSetup({ id: 'default', claude_code_only: false, fallback_group_id: null });
  const result = await scheduler.select({
    ...input([candidate('platform', 'account-a', CLAUDE_IDENTITY)]),
    claudeCodeClient: THIRD_PARTY_EVIDENCE,
  });
  assert.equal(result.decision, 'allow');
});

test('claude_code_only never applies to non-claude providers', async () => {
  const { scheduler, state, input } = setup('platform', {
    groupRows: [{ id: 'group-cc', claude_code_only: true, fallback_group_id: null }],
  });
  const result = await scheduler.select({
    ...input([candidate('platform', 'account-a')]),
    claudeCodeClient: THIRD_PARTY_EVIDENCE,
  });
  assert.equal(result.decision, 'allow');
  const eligibility = state.statements.find(({ sql }) =>
    sql.includes('postgres-provider-account-scheduler:platform-eligibility'),
  );
  assert.equal(eligibility?.values[22], 'group-cc');
});

/* ------------------------------------------------------------------ */
/* Piece 2 — Redis concurrency-slot pre-check                          */
/* ------------------------------------------------------------------ */

interface SlotCall {
  readonly kind: 'tryAcquire' | 'release';
  readonly ownerScopeKey: string;
  readonly accountId: string;
  readonly requestId: string;
}

function fakeSlots(behavior: ReadonlyMap<string, 'acquired' | 'saturated' | 'unavailable'>): {
  slots: RedisConcurrencySlots;
  calls: SlotCall[];
} {
  const calls: SlotCall[] = [];
  const slots: RedisConcurrencySlots = {
    async tryAcquire(input) {
      calls.push({
        kind: 'tryAcquire',
        ownerScopeKey: input.ownerScopeKey,
        accountId: input.accountId,
        requestId: input.requestId,
      });
      return { state: behavior.get(input.accountId) ?? 'acquired' };
    },
    async release(input) {
      calls.push({
        kind: 'release',
        ownerScopeKey: input.ownerScopeKey,
        accountId: input.accountId,
        requestId: input.requestId,
      });
    },
  };
  return { slots, calls };
}

test('the slot pre-check is off by default: no Redis interaction, pure PG concurrency', async () => {
  const { scheduler, state, input } = setup('platform', {}, {});
  const result = await scheduler.select(input([candidate('platform', 'account-a')]));
  assert.equal(result.decision, 'allow');
  const concurrencyQueries = state.statements.filter(({ sql }) => sql.includes(':concurrency'));
  assert.equal(concurrencyQueries.length, 1);
  assert.deepEqual(concurrencyQueries[0]?.values, ['platform', null, 'account-a']);
});

test('an enabled slot pre-check acquires, still reads the PG lease, and releases the losers', async () => {
  const { slots, calls } = fakeSlots(new Map());
  const { scheduler, state, input } = setup(
    'platform',
    {},
    {
      redisConcurrencySlots: { enabled: true, slots, maxSlots: 2, windowMs: 60_000 },
    },
  );
  const result = await scheduler.select(
    input([candidate('platform', 'account-a'), candidate('platform', 'account-b')], 'request-slots'),
  );
  assert.equal(result.decision, 'allow');
  const winner = result.decision === 'allow' ? result.value.accountId : null;
  assert.ok(winner !== null);
  // Both candidates were pre-checked against Redis...
  assert.deepEqual(
    calls
      .filter((call) => call.kind === 'tryAcquire')
      .map((call) => call.accountId)
      .sort(),
    ['account-a', 'account-b'],
  );
  // ...and both still went through the authoritative PG lease snapshot.
  const concurrencyAccounts = state.statements
    .filter(({ sql }) => sql.includes(':concurrency'))
    .map(({ values }) => String(values[2]))
    .sort();
  assert.deepEqual(concurrencyAccounts, ['account-a', 'account-b']);
  // Exactly the non-winning acquisition is released; the winner keeps its slot.
  const releases = calls.filter((call) => call.kind === 'release');
  assert.deepEqual(
    releases.map((call) => `${call.accountId}:${call.requestId}`),
    [`${winner === 'account-a' ? 'account-b' : 'account-a'}:request-slots`],
  );
});

test('a saturated slot denies only that candidate and skips its PG lease read', async () => {
  const { slots, calls } = fakeSlots(new Map([['account-a', 'saturated']]));
  const { scheduler, state, input } = setup(
    'platform',
    {},
    {
      redisConcurrencySlots: { enabled: true, slots },
    },
  );
  const result = await scheduler.select(
    input([candidate('platform', 'account-a'), candidate('platform', 'account-b')], 'request-saturated'),
  );
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  // The saturated candidate never reaches the PG lease snapshot.
  const concurrencyAccounts = state.statements
    .filter(({ sql }) => sql.includes(':concurrency'))
    .map(({ values }) => String(values[2]));
  assert.deepEqual(concurrencyAccounts, ['account-b']);
  // Saturation means no acquisition happened, so nothing is released for it.
  assert.equal(
    calls.some((call) => call.kind === 'release' && call.accountId === 'account-a'),
    false,
  );
});

test('an unavailable Redis fails open to the PostgreSQL lease authority', async (t) => {
  await t.test('unavailable decision', async () => {
    const { slots } = fakeSlots(new Map([['account-a', 'unavailable']]));
    const { scheduler, state, input } = setup(
      'platform',
      {},
      {
        redisConcurrencySlots: { enabled: true, slots },
      },
    );
    const result = await scheduler.select(input([candidate('platform', 'account-a')]));
    assert.equal(result.decision, 'allow');
    assert.equal(
      state.statements.some(({ sql }) => sql.includes(':concurrency')),
      true,
      'the PG lease snapshot must still be read',
    );
  });

  await t.test('thrown client error', async () => {
    const slots: RedisConcurrencySlots = {
      async tryAcquire() {
        throw new Error('redis is down');
      },
      async release() {},
    };
    const { scheduler, input } = setup(
      'platform',
      {},
      {
        redisConcurrencySlots: { enabled: true, slots },
      },
    );
    const result = await scheduler.select(input([candidate('platform', 'account-a')]));
    assert.equal(result.decision, 'allow');
  });
});

test('a failed selection releases every acquired slot', async () => {
  const { slots, calls } = fakeSlots(new Map());
  const { scheduler, input } = setup(
    'platform',
    {
      inFlight: new Map([
        ['account-a', '2'],
        ['account-b', '2'],
      ]),
    },
    {
      redisConcurrencySlots: { enabled: true, slots },
    },
  );
  const result = await scheduler.select(
    input([candidate('platform', 'account-a'), candidate('platform', 'account-b')], 'request-full'),
  );
  assert.equal(result.decision, 'reject');
  const releases = calls
    .filter((call) => call.kind === 'release')
    .map((call) => call.accountId)
    .sort();
  assert.deepEqual(releases, ['account-a', 'account-b']);
});

test('malformed slot options fail fast at construction', async (t) => {
  const { slots } = fakeSlots(new Map());

  await t.test('enabled without a slot client', () => {
    const state: FakeDatabaseState = { mode: 'platform', statements: [] };
    assert.throws(
      () =>
        new PostgresProviderAccountScheduler({
          database: new FakeDatabase(state),
          leaseConcurrencyLimit: 2,
          health: HEALTHY,
          now: () => NOW,
          redisConcurrencySlots: { enabled: true, slots: undefined as unknown as RedisConcurrencySlots },
        }),
      TypeError,
    );
  });

  await t.test('invalid window', () => {
    const state: FakeDatabaseState = { mode: 'platform', statements: [] };
    assert.throws(
      () =>
        new PostgresProviderAccountScheduler({
          database: new FakeDatabase(state),
          leaseConcurrencyLimit: 2,
          health: HEALTHY,
          now: () => NOW,
          redisConcurrencySlots: { enabled: true, slots, windowMs: 10 },
        }),
      TypeError,
    );
  });

  await t.test('invalid capacity without a lease limit default', () => {
    const state: FakeDatabaseState = { mode: 'platform', statements: [] };
    assert.throws(
      () =>
        new PostgresProviderAccountScheduler({
          database: new FakeDatabase(state),
          health: HEALTHY,
          now: () => NOW,
          redisConcurrencySlots: { enabled: true, slots, maxSlots: 0 },
        }),
      TypeError,
    );
  });
});
