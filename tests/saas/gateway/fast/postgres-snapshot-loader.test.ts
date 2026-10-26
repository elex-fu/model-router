import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { createPostgresFastGatewaySnapshotLoader } from '../../../../src/saas/gateway/fast/postgres-snapshot-loader.js';
import {
  authorizeFastGatewaySnapshot,
  CachedFastGatewaySnapshots,
  FastGatewaySnapshotError,
  type FastGatewaySnapshotInput,
} from '../../../../src/saas/gateway/fast/snapshots.js';
import type {
  RequestPreparationAuthority,
  RequestPreparationCaller,
  RequestPreparationEntitlement,
} from '../../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';

type Row = Record<string, unknown>;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = (delta = 0) => new Date(NOW + delta).toISOString();

function fixture(mode: 'byok' | 'platform' = 'byok') {
  const tenant = randomUUID();
  const project = randomUUID();
  const key = randomUUID();
  const user = randomUUID();
  const entitlementId = randomUUID();
  const priceId = randomUUID();
  const costId = randomUUID();
  const owner = mode === 'byok' ? 'tenant' : 'platform';
  const auth: AuthenticatedApiKey = {
    authorization: {
      keyId: key,
      tenantId: tenant,
      projectId: project,
      principalKind: 'member',
      principalId: user,
      entitlementId,
      supplyProfileId: 'profile',
      supplyMode: mode,
      modelScopes: ['public'],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    metadata: {
      id: key,
      tenantId: tenant,
      projectId: project,
      principalUserId: user,
      executionPrincipalType: 'member',
      executionPrincipalId: user,
      createdByUserId: user,
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId,
      supplyProfileId: 'profile',
      supplyMode: mode,
      name: 'synthetic',
      prefix: 'synthetic',
      modelScopes: ['public'],
      status: 'active',
      createdAt: iso(-10_000),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
  const caller: RequestPreparationCaller = {
    tenantId: tenant,
    projectId: project,
    proxyKeyId: key,
    principalKind: 'member',
    principalId: user,
    entitlementId,
    supplyProfileId: 'profile',
    supplyMode: mode,
    modelScopes: ['public'],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
  const entitlement: RequestPreparationEntitlement = {
    tenantId: tenant,
    projectId: project,
    proxyKeyId: key,
    entitlementId,
    entitlementVersion: 1,
    supplyProfileId: 'profile',
    supplyProfileVersion: 1,
    supplyMode: mode,
    modelScopeVersion: 1,
    allowedModels: ['public'],
    allowedProviderIds: mode === 'byok' ? ['provider'] : [],
    projectPolicyVersion: 1,
  };
  const common = {
    tenantId: tenant,
    projectId: project,
    proxyKeyId: key,
    supplyProfileId: 'profile',
    upstreamId: 'upstream',
    accountId: 'account',
    credentialId: 'credential',
    credentialVersion: 1,
    credentialAuthzVersion: 1,
    accountAuthzVersion: 1,
    dispatchProfileId: 'profile',
    supplyProfileAuthzVersion: 1,
    resolvedModel: 'native',
    protocol: 'openai' as const,
    endpoint: '/v1/chat/completions',
    providerId: 'provider',
    productId: 'product',
  };
  const candidate =
    mode === 'byok'
      ? {
          ...common,
          supplyMode: mode,
          accountOwnerKind: 'tenant' as const,
          profileAccountAuthzVersion: 1,
          supplierCostVersion: null,
        }
      : {
          ...common,
          supplyMode: mode,
          accountOwnerKind: 'platform' as const,
          supplierCostVersion: costId,
          poolId: 'upstream',
          poolAuthzVersion: 1,
          poolMemberAccountAuthzVersion: 1,
          poolMemberAuthzVersion: 1,
          poolGrantAuthzVersion: 1,
          poolGrantProfileAuthzVersion: 1,
          poolGrantPoolAuthzVersion: 1,
        };
  const authority: RequestPreparationAuthority = {
    route: {
      tenantId: tenant,
      projectId: project,
      publicModel: 'public',
      publicModelId: 'model',
      publicModelVersion: 1,
      routeConfigId: 'route',
      routeConfigVersion: 1,
      protocol: 'openai',
      targetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
      upstreamId: 'upstream',
      endpoint: '/v1/chat/completions',
    },
    candidate,
    poolMemberAuthzVersion: mode === 'byok' ? null : 1,
    credentialRef: 'credential',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation',
      customerPriceVersion: mode === 'byok' ? null : priceId,
      supplierCostVersion: mode === 'byok' ? null : costId,
    },
  };
  const keyRow: Row = {
    id: key,
    tenant_id: tenant,
    project_id: project,
    principal_user_id: user,
    execution_principal_type: 'member',
    execution_principal_id: user,
    entitlement_id: entitlementId,
    supply_profile_id: 'profile',
    supply_mode: mode,
    model_scopes: ['public'],
    status: 'active',
    revoked_at: null,
    expires_at: null,
    authz_version: 1,
    model_scope_version: 1,
    entitlement_authz_version: 1,
    supply_profile_authz_version: 1,
  };
  const principal: Row = { id: user, disabled_at: null, anonymized_at: null };
  const group: Row = {
    id: 'default',
    status: 'active',
    rate_multiplier_num: '1',
    rate_multiplier_den: '1',
    peak_enabled: false,
    model_pricing: null,
    daily_limit_minor_units: null,
    weekly_limit_minor_units: null,
    monthly_limit_minor_units: null,
    profit_min_margin_num: null,
    profit_min_margin_den: null,
    profit_safety_buffer_num: null,
    profit_safety_buffer_den: null,
    claude_code_only: false,
    fallback_group_id: null,
    composite: false,
    supported_model_scopes: null,
    rpm_limit: null,
  };
  const policy: Row = {
    spending_frozen: false,
    tenant_status: 'active',
    project_status: 'active',
    policy_status: 'active',
    key_status: 'active',
    project_version: 1,
    key_version: 1,
    key_expires_at: null,
    tenant_rpm: 100,
    tenant_tpm: 100_000,
    tenant_concurrency: 64,
    project_rpm: 100,
    project_tpm: 100_000,
    project_concurrency: 64,
    key_rpm: 100,
    key_tpm: 100_000,
    key_concurrency: 64,
    ip_mode: null,
    ip_rules: null,
    token_daily: null,
    token_lifetime: null,
    charge_daily: null,
    charge_lifetime: null,
    billing_group: group,
    group_accounts: [],
  };
  const account: Row = {
    owner_kind: owner,
    tenant_id: mode === 'byok' ? tenant : null,
    supply_mode: mode,
    id: 'account',
    display_name: 'Account',
    provider_id: 'provider',
    product_id: 'product',
    credential_type: 'api-key',
    region: 'test',
    purpose: 'inference',
    rights_id: 'rights',
    rights_version: 1,
    status: 'active',
    validation_state: 'verified',
    validation_error_code: null,
    last_validated_at: iso(),
    authz_version: 1,
    priority: 50,
    weight: 1,
    revalidation_interval_seconds: null,
    created_at: iso(-10_000),
    updated_at: iso(),
    disabled_at: null,
    revoked_at: null,
    quota_state: null,
    rpm_limit: 80,
    tpm_limit: 50_000,
  };
  const credential: Row = { ...account, id: 'credential', account_id: 'account', current_version: 1, expires_at: null };
  const version: Row = {
    owner_kind: owner,
    tenant_id: mode === 'byok' ? tenant : null,
    supply_mode: mode,
    account_id: 'account',
    credential_id: 'credential',
    version: 1,
    status: 'active',
    schema_version: 1,
    context_version: 1,
    algorithm: 'aes-256-gcm',
    kms_purpose: 'inference',
    kms_key_id: 'synthetic-kms',
    wrapping_revision: 1,
    wrapped_dek: randomBytes(32).toString('base64url'),
    nonce: randomBytes(12).toString('base64url'),
    ciphertext: randomBytes(32).toString('base64url'),
    auth_tag: randomBytes(16).toString('base64url'),
    created_at: iso(-10_000),
    expires_at: null,
    retired_at: null,
    revoked_at: null,
  };
  const price: Row = {
    id: priceId,
    version: 1,
    public_model_id: 'model',
    public_model_version: 1,
    provider_id: 'provider',
    product_id: 'product',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    currency: 'USD',
    commercial_policy_version: '1',
    calculator_version: 'test',
    rounding_version: 'test',
    rounding_mode: 'ceil',
    rounding_boundary: 'total',
    input_rate_numerator_minor_units: '1',
    input_rate_denominator_units: '1000',
    output_rate_numerator_minor_units: '1',
    output_rate_denominator_units: '1000',
    effective_at: iso(-10_000),
    expires_at: null,
    idempotency_key: 'synthetic-price',
    definition_digest: 'a'.repeat(64),
    created_at: iso(-10_000),
  };
  const health: Row = { state: 'healthy', cooldown_until: null, half_open_probe_at: null, observed_at: iso(-120_000) };
  const expiryRow: Row = { expires_at: iso(10_000), subscription_expires_at: iso(8000) };
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  let txCount = 0;
  let authorityCount = 0;
  let monotonic = 0;
  let clockStep = 0;
  const unsupportedReasons: string[] = [];
  let failSql: RegExp | null = null;
  const executor: SqlExecutor = {
    async query<T>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<T>> {
      statements.push({ sql, values });
      if (failSql?.test(sql)) throw new Error(version.ciphertext as string);
      let rows: Row[] = [];
      if (sql.startsWith('SET ') || sql.includes('set_config(') || sql.includes('pg_advisory_xact_lock')) rows = [];
      else if (sql.includes('fast-snapshot:clock')) rows = [{ observed_at: iso() }];
      else if (sql.includes('AS principal_user'))
        rows = [
          {
            tenant: [{ id: tenant, status: policy.tenant_status }],
            project: [
              {
                tenant_id: tenant,
                id: project,
                inference_policy_version: 1,
                inference_policy_status: policy.project_status,
              },
            ],
            policy: [{ tenant_id: tenant, project_id: project, version: 1, status: policy.policy_status }],
            principal_user: [principal],
            tenant_membership: [
              { tenant_id: tenant, user_id: user, role: 'developer', status: 'active', revoked_at: null },
            ],
            project_membership: [
              {
                tenant_id: tenant,
                project_id: project,
                user_id: user,
                role: 'developer',
                status: 'active',
                revoked_at: null,
              },
            ],
            api_key: [keyRow],
            now: iso(),
          },
        ];
      else if (sql.includes('fast-snapshot:policy')) rows = [policy];
      else if (sql.includes('fixture:authority-expiries')) rows = [expiryRow];
      else if (sql.includes('fast-snapshot:account-runtime')) rows = [{ account, health, model_cooling: false }];
      else if (sql.includes('WITH base_version AS')) rows = [version];
      else if (sql.includes('FROM saas_customer_price_versions')) rows = [price];
      else if (sql.includes('FROM saas_supplier_cost_versions'))
        rows = [{ ...price, id: costId, resolved_model: 'native' }];
      else if (/FROM saas_(tenant|platform)_provider_account_capabilities/.test(sql))
        rows = [{ model: 'native', endpoint: '/v1/chat/completions', capability_version: 1 }];
      else if (/FROM saas_(tenant|platform)_provider_accounts/.test(sql)) rows = [account];
      else if (/FROM saas_(tenant|platform)_provider_credentials/.test(sql)) rows = [credential];
      else throw new Error(`Unexpected fixture SQL: ${sql.slice(0, 100)}`);
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  const noop = async () => {};
  const database: SaasDatabase = {
    ...executor,
    async transaction(work) {
      txCount++;
      return work(executor);
    },
    migrate: noop,
    verifySchema: noop,
    ping: noop,
    close: noop,
  };
  const loader = createPostgresFastGatewaySnapshotLoader({
    database,
    caller: {
      async validate() {
        return { decision: 'allow', value: caller };
      },
    },
    entitlement: {
      async resolve(_input, options) {
        assert.equal(typeof options?.executor?.query, 'function');
        return { decision: 'allow', value: entitlement };
      },
    },
    createAuthority(db) {
      return {
        async resolve() {
          authorityCount++;
          await db.transaction(async (tx) => {
            await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await tx.query('/* fixture:authority-expiries */ SELECT expires_at');
          });
          return { decision: 'allow', value: authority };
        },
      };
    },
    maxBodyBytes: 1024,
    accountMaxConcurrency: 8,
    monotonicNow: () => {
      monotonic += clockStep;
      return monotonic;
    },
    observeUnsupported: (reason) => {
      unsupportedReasons.push(reason);
    },
  });
  const input: FastGatewaySnapshotInput = {
    authenticatedCaller: auth,
    publicModel: 'public',
    protocol: 'openai',
    clientOperation: 'chat.completions',
    inputByteLength: 32,
  };
  return {
    loader,
    input,
    policy,
    group,
    account,
    credential,
    version,
    price,
    health,
    expiryRow,
    keyRow,
    principal,
    authority,
    statements,
    unsupportedReasons,
    setClockStep: (value: number) => {
      clockStep = value;
    },
    txCount: () => txCount,
    authorityCount: () => authorityCount,
    advance: (ms: number) => {
      monotonic += ms;
    },
    fail: (pattern: RegExp) => {
      failSql = pattern;
    },
  };
}

for (const mode of ['byok', 'platform'] as const)
  test(`${mode}: loads native sealed credentials and prices in one read-only cold transaction`, async (t) => {
    const f = fixture(mode);
    const snapshot = await f.loader.resolve(f.input);
    assert.ok(snapshot);
    t.diagnostic(
      `Cold mock ${mode}: ${f.statements.length} source SQL calls (includes per-query timeout configuration; native authority reader stubbed)`,
    );
    assert.equal(f.txCount(), 1);
    assert.equal(f.authorityCount(), 1);
    assert.equal(f.statements[0]?.sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(f.statements.filter((s) => s.sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ').length, 0);
    assert.equal(
      f.statements.some((s) => /\b(?:INSERT|UPDATE|DELETE)\b/.test(s.sql)),
      false,
    );
    assert.equal(snapshot.candidates[0]?.credential.version.envelope.ciphertext, f.version.ciphertext);
    assert.equal(snapshot.candidates[0]?.customerPrice?.id ?? null, mode === 'platform' ? f.price.id : null);
    assert.equal(snapshot.candidates[0]?.limits.concurrency, 8);
    assert.equal(snapshot.validUntilMs, NOW + 5000);
    authorizeFastGatewaySnapshot(snapshot, f.input, NOW + 1);
  });

test('captures the earliest original aliased/nested absolute expiry without extending on load', async () => {
  const f = fixture();
  f.expiryRow.subscription_expires_at = iso(2400);
  f.version.expires_at = iso(1900);
  const snapshot = await f.loader.resolve(f.input);
  assert.ok(snapshot);
  assert.equal(snapshot.validUntilMs, NOW + 1900);
  assert.ok(snapshot.policy.absoluteExpiryMs.includes(NOW + 2400));
  assert.ok(snapshot.policy.absoluteExpiryMs.includes(NOW + 1900));
});

test('native cache hit repeats pure policy checks but executes no SQL', async () => {
  const f = fixture();
  let now = NOW;
  const cache = new CachedFastGatewaySnapshots(f.loader, { wallNow: () => now, monotonicNow: () => now - NOW });
  await cache.resolve(f.input);
  const queries = f.statements.length;
  now++;
  await cache.resolve(f.input);
  assert.equal(f.statements.length, queries);
  assert.equal(f.txCount(), 1);
});

for (const mutation of ['revoked-key', 'stale-key', 'disabled-user', 'tenant', 'project', 'group'] as const)
  test(`fresh cold facts reject ${mutation}`, async () => {
    const f = fixture();
    if (mutation === 'revoked-key') f.keyRow.status = 'revoked';
    if (mutation === 'stale-key') f.keyRow.authz_version = 2;
    if (mutation === 'disabled-user') f.principal.disabled_at = iso(-1);
    if (mutation === 'tenant') f.policy.tenant_status = 'disabled';
    if (mutation === 'project') f.policy.project_status = 'disabled';
    if (mutation === 'group') f.group.status = 'disabled';
    await assert.rejects(
      f.loader.resolve(f.input),
      (e: unknown) => e instanceof FastGatewaySnapshotError && e.code === 'SNAPSHOT_DENIED',
    );
  });

test('key identity cannot cross tenant or principal boundaries', async () => {
  const f = fixture();
  f.keyRow.tenant_id = randomUUID();
  await assert.rejects(f.loader.resolve(f.input), FastGatewaySnapshotError);
});

for (const feature of ['key-budget', 'group-price', 'group-spend', 'composite', 'claude-only'] as const)
  test(`unsupported ${feature} returns null before any dispatch or authority load`, async () => {
    const f = fixture();
    if (feature === 'key-budget') f.policy.token_daily = '0';
    if (feature === 'group-price') f.group.rate_multiplier_num = '2';
    if (feature === 'group-spend') f.group.daily_limit_minor_units = '1';
    if (feature === 'composite') f.group.composite = true;
    if (feature === 'claude-only') f.group.claude_code_only = true;
    assert.equal(await f.loader.resolve(f.input), null);
    assert.equal(f.authorityCount(), 0);
  });

test('group account pool membership removes unauthorized platform supply', async () => {
  const f = fixture('platform');
  f.policy.group_accounts = ['other-account'];
  assert.equal(await f.loader.resolve(f.input), null);
  assert.equal(
    f.statements.some((s) => s.sql.includes('WITH base_version AS')),
    false,
  );
});

for (const feature of ['cooldown', 'quota-exhausted', 'cost-limit', 'threshold', 'egress', 'oauth'] as const)
  test(`unsupported account ${feature} cannot enter the fast candidate set`, async () => {
    const f = fixture();
    if (feature === 'cooldown') f.health.state = 'cooldown';
    if (feature === 'quota-exhausted') f.account.quota_state = 'exhausted';
    if (feature === 'cost-limit') f.account.window_cost_limit_minor_units = '1';
    if (feature === 'threshold') f.account.auto_pause_5h_threshold = 90;
    if (feature === 'egress') f.account.egress_proxy_id = 'proxy';
    if (feature === 'oauth') f.account.credential_type = 'oauth';
    assert.equal(await f.loader.resolve(f.input), null);
  });

test('store errors throw sanitized unavailable rather than silently falling back', async () => {
  const f = fixture();
  f.fail(/WITH base_version AS/);
  await assert.rejects(
    f.loader.resolve(f.input),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Fast gateway snapshot unavailable' &&
      !JSON.stringify(error).includes(String(f.version.ciphertext)),
  );
});

test('unsupported operations do not open a transaction', async () => {
  const f = fixture();
  assert.equal(await f.loader.resolve({ ...f.input, clientOperation: 'embeddings' }), null);
  assert.equal(f.txCount(), 0);
});

test('cold source deadline is bounded and query timeout configuration is finite', async () => {
  const f = fixture();
  f.setClockStep(500);
  await assert.rejects(
    f.loader.resolve(f.input),
    (error: unknown) => error instanceof Error && error.message === 'Fast gateway snapshot timeout',
  );
  for (const statement of f.statements.filter((entry) => entry.sql.includes('set_config(')))
    assert.match(String(statement.values[0]), /^[1-9][0-9]*ms$/);
});

test('unsupported diagnostics are fixed safe labels, never data or key material', async () => {
  const f = fixture();
  f.policy.token_daily = '0';
  assert.equal(await f.loader.resolve(f.input), null);
  assert.deepEqual(f.unsupportedReasons, ['key_budget']);
});

test('tenant-wide spending freeze denies platform cold authority but not BYOK', async () => {
  const platform = fixture('platform');
  platform.policy.spending_frozen = true;
  await assert.rejects(
    platform.loader.resolve(platform.input),
    (error: unknown) => error instanceof FastGatewaySnapshotError && error.code === 'SNAPSHOT_DENIED',
  );
  const byok = fixture('byok');
  byok.policy.spending_frozen = true;
  const snapshot = await byok.loader.resolve(byok.input);
  assert.ok(snapshot);
  assert.equal(snapshot.policy.spendingFrozen, true);
  authorizeFastGatewaySnapshot(snapshot, byok.input, NOW);
});

test('new spending freeze is observed after the fixed TTL, not ignored while credit remains', async () => {
  const f = fixture('platform');
  let wall = NOW;
  let mono = 0;
  const cache = new CachedFastGatewaySnapshots(f.loader, { wallNow: () => wall, monotonicNow: () => mono });
  assert.ok(await cache.resolve(f.input));
  const before = f.statements.length;
  f.policy.spending_frozen = true;
  assert.ok(await cache.resolve(f.input));
  assert.equal(f.statements.length, before);
  wall += 5001;
  mono += 5001;
  await assert.rejects(
    cache.resolve(f.input),
    (error: unknown) => error instanceof FastGatewaySnapshotError && error.code === 'SNAPSHOT_DENIED',
  );
  assert.ok(f.statements.length > before);
});

test('snapshot TTL anchors to transaction BEGIN before any repeatable-read acquisition', async () => {
  const f = fixture();
  const snapshot = await f.loader.resolve(f.input);
  assert.ok(snapshot);
  const clock = f.statements.find((statement) => statement.sql.includes('fast-snapshot:clock'))?.sql;
  assert.match(clock ?? '', /SELECT transaction_timestamp\(\) AS observed_at/);
  assert.doesNotMatch(clock ?? '', /clock_timestamp/);
  assert.equal(snapshot.observedAtMs, NOW);
  assert.equal(snapshot.validUntilMs, NOW + 5000);
});
