import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { PreparedSqlStatement, SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasCommercialMeteringPolicyService } from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import {
  observePreparationExecutor,
  type PostgresPreparationObservation,
} from '../../../src/saas/gateway/postgres-preparation-observer.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import type { ProviderAccountSchedulerInput } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import {
  anyRoleConfigured,
  type Fixture,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';
import { alignPlatformPool, type PlatformPoolFacts } from './admission-bench-fixture.js';
import { safeCancellationFailure } from './pre-dispatch-postgres-fixture.js';

type Mode = 'byok' | 'platform';
type StatementKind = 'cm-final' | 'sched-byok' | 'sched-platform';
type PlanMode = 'auto' | 'force_generic_plan';

// Original production SQL bytes, before adding the optional transport capability.
const SQL_FINGERPRINTS: Readonly<Record<StatementKind, { readonly bytes: number; readonly sha256: string }>> = {
  'cm-final': { bytes: 468, sha256: '358cd2967d4b0ccb1192b32cf1779e15d1d53412aff5d1882cdd0a6530136f16' },
  'sched-byok': { bytes: 10_787, sha256: '9b34c495847c2b54256174c5c2d1c6063ed6877e023708dfff4589fe09771993' },
  'sched-platform': { bytes: 14_331, sha256: 'bc83809c6d04f9c52ac8572fe4b1ed655468ad8861baf00cbb1740d2a7cf0b60' },
};

interface StatementCall {
  readonly kind: StatementKind;
  readonly transport: 'anonymous' | 'prepared';
  readonly name: string | null;
  readonly sqlSha256: string;
  readonly sqlMd5: string;
  readonly parameterDigest: string;
  readonly parameterCount: number;
  readonly rowCount: number;
  readonly rowIdentityDigest: string;
  readonly rowFactsDigest: string;
  readonly authorityAtMs: number | null;
}

interface PreparedStatementProjection {
  readonly name: string;
  readonly from_sql: boolean;
  readonly sql_md5: string;
  readonly parameter_count: number;
  readonly generic_plans: string;
  readonly custom_plans: string;
}

interface SchedulingFixture {
  readonly mode: Mode;
  readonly fixture: Fixture;
  readonly input: ProviderAccountSchedulerInput;
}

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
const md5 = (input: string): string => createHash('md5').update(input).digest('hex');
const fingerprint = (input: unknown): string =>
  sha256(JSON.stringify(input, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));

function text(value: unknown): string {
  assert.ok(typeof value === 'string' && value.length > 0, 'persisted synthetic authority identity required');
  return value;
}

function statementKind(sql: string): StatementKind | null {
  if (sql.includes('postgres-provider-account-scheduler:byok-eligibility')) return 'sched-byok';
  if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) return 'sched-platform';
  if (/FROM saas_route_config_dispatchable\s+WHERE tenant_id = \$1/.test(sql)) return 'cm-final';
  return null;
}

function validDate(value: unknown): Date {
  assert.ok(value instanceof Date && Number.isFinite(value.getTime()), 'real PostgreSQL authority timestamp required');
  return value;
}

/** Forward the actual source API; retain only fixed labels, hashes, counts, and the authority clock. */
function observeExecutor(executor: SqlExecutor, calls: StatementCall[]): SqlExecutor {
  const run = async <Row>(
    sql: string,
    values: readonly unknown[] | undefined,
    statement?: PreparedSqlStatement,
  ): Promise<SqlResult<Row>> => {
    const kind = statementKind(sql);
    if (kind) {
      assert.equal(Buffer.byteLength(sql), SQL_FINGERPRINTS[kind].bytes);
      assert.equal(sha256(sql), SQL_FINGERPRINTS[kind].sha256, 'preparation must preserve the original SQL bytes');
    }
    if (statement) {
      assert.ok(kind, 'only the three fixed business statements may use the prepared capability');
      assert.equal(Object.isFrozen(statement), true, 'the source descriptor must be immutable');
      assert.equal(statement.name, `mr_${kind}_${createHash('sha256').update(sql).digest('base64url')}`);
    }
    const before =
      kind && kind !== 'cm-final'
        ? validDate((await executor.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now)
        : null;
    let result: SqlResult<Row>;
    if (statement) {
      assert.ok(executor.queryPrepared);
      result = await executor.queryPrepared<Row>(statement, values);
    } else {
      result = await executor.query<Row>(sql, values);
    }
    if (kind) {
      const after =
        kind !== 'cm-final'
          ? validDate((await executor.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now)
          : null;
      let authorityAtMs: number | null = null;
      if (kind !== 'cm-final' && result.rows.length === 1) {
        const row = result.rows[0] as Record<string, unknown>;
        authorityAtMs = validDate(row.authority_now).getTime();
        assert.ok(before && after && authorityAtMs >= before.getTime() && authorityAtMs <= after.getTime());
      }
      calls.push({
        kind,
        transport: statement ? 'prepared' : 'anonymous',
        name: statement?.name ?? null,
        sqlSha256: sha256(sql),
        sqlMd5: md5(sql),
        parameterDigest: fingerprint(values ?? []),
        parameterCount: values?.length ?? 0,
        rowCount: result.rows.length,
        rowIdentityDigest: fingerprint(
          result.rows.map((value) => {
            const row = value as Record<string, unknown>;
            return kind === 'cm-final'
              ? [row.tenant_id, row.project_id, row.route_id, row.version]
              : [row.profile_tenant_id, row.profile_id, row.account_id, row.credential_id];
          }),
        ),
        rowFactsDigest: fingerprint(
          result.rows.map((value) =>
            Object.fromEntries(
              Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'authority_now'),
            ),
          ),
        ),
        authorityAtMs,
      });
    }
    return result;
  };
  const observed: SqlExecutor = { query: (sql, values) => run(sql, values) };
  if (typeof executor.queryPrepared === 'function') {
    observed.queryPrepared = (statement, values) => run(statement.text, values, statement);
  }
  return observed;
}

/** Every business transaction still begins through the real owned-pg database implementation. */
function observedDatabase(
  database: SaasDatabase,
  planMode: PlanMode,
  calls: StatementCall[],
  observations: PostgresPreparationObservation[],
): SaasDatabase {
  const observer = (observation: PostgresPreparationObservation): void => {
    observations.push(observation);
  };
  const wrap = (executor: SqlExecutor): SqlExecutor => {
    const observed = observePreparationExecutor(observeExecutor(executor, calls), 'authority', observer);
    assert.equal(typeof observed.queryPrepared, typeof executor.queryPrepared, 'the real observer retains capability');
    return observed;
  };
  const configuredTransaction: SaasDatabase['transaction'] = (work) =>
    database.transaction(async (executor) => {
      const state = (
        await executor.query<{ isolation: string; plan_mode: string }>(
          `SELECT current_setting('transaction_isolation') AS isolation,
                  current_setting('plan_cache_mode') AS plan_mode`,
        )
      ).rows[0];
      assert.equal(state?.isolation, 'read committed');
      assert.equal(state?.plan_mode, 'auto', 'no transaction may inherit a forced session plan mode');
      if (planMode === 'force_generic_plan') await executor.query('SET LOCAL plan_cache_mode = force_generic_plan');
      assert.equal(
        (await executor.query<{ mode: string }>("SELECT current_setting('plan_cache_mode') AS mode")).rows[0]?.mode,
        planMode,
      );
      await executor.query("SET LOCAL lock_timeout = '10s'");
      await executor.query("SET LOCAL statement_timeout = '15s'");
      return work(wrap(executor));
    });
  const root = wrap(database);
  if (planMode === 'force_generic_plan' && root.queryPrepared) {
    // Generic-plan correctness uses a configured transaction for each root
    // Bind/Execute. The auto scenes keep production root autocommit.
    root.queryPrepared = <Row>(statement: PreparedSqlStatement, values: readonly unknown[] = []) =>
      configuredTransaction(async (executor) => {
        assert.ok(executor.queryPrepared);
        return executor.queryPrepared<Row>(statement, values);
      });
  }
  return {
    ...database,
    ...root,
    transaction: configuredTransaction,
  };
}

function onExecutor(database: SaasDatabase, executor: SqlExecutor): SaasDatabase {
  return {
    ...database,
    ...executor,
    query: (sql, values) => executor.query(sql, values),
    transaction: (work) => work(executor),
  };
}

async function assertAutoRestored(database: SaasDatabase): Promise<void> {
  assert.equal(
    (await database.query<{ mode: string }>("SELECT current_setting('plan_cache_mode') AS mode")).rows[0]?.mode,
    'auto',
  );
}

async function preparedStatements(database: SaasDatabase): Promise<PreparedStatementProjection[]> {
  const result = await database.query<PreparedStatementProjection>(
    `SELECT name, from_sql, md5(statement) AS sql_md5, cardinality(parameter_types) AS parameter_count,
            generic_plans::text AS generic_plans, custom_plans::text AS custom_plans
       FROM pg_prepared_statements ORDER BY name`,
  );
  assert.ok(result.rows.length <= 3, 'one owned connection may retain at most three fixed names');
  for (const row of result.rows) {
    assert.match(row.name, /^mr_(?:cm-final|sched-byok|sched-platform)_[A-Za-z0-9_-]{43}$/);
    assert.equal(row.from_sql, false, 'real extended-protocol Parse, not SQL PREPARE');
    assert.match(row.generic_plans, /^\d+$/);
    assert.match(row.custom_plans, /^\d+$/);
  }
  return result.rows;
}

function assertExecutions(
  before: readonly PreparedStatementProjection[],
  after: readonly PreparedStatementProjection[],
  calls: readonly StatementCall[],
  forced: boolean,
): void {
  assert.equal(after.length, 3, 'all three real source paths must have prepared their fixed statement');
  for (const row of after) {
    const previous = before.find((entry) => entry.name === row.name);
    const executions = calls.filter((call) => call.name === row.name);
    const genericDelta = BigInt(row.generic_plans) - BigInt(previous?.generic_plans ?? '0');
    const customDelta = BigInt(row.custom_plans) - BigInt(previous?.custom_plans ?? '0');
    assert.equal(genericDelta + customDelta, BigInt(executions.length), 'every real call makes a new Bind/Execute');
    if (forced) {
      assert.equal(customDelta, 0n);
      assert.equal(genericDelta, BigInt(executions.length));
    }
    for (const call of executions) {
      assert.equal(row.sql_md5, call.sqlMd5);
      assert.equal(row.parameter_count, call.parameterCount);
    }
  }
  if (before.length)
    assert.deepEqual(
      after.map((row) => row.name),
      before.map((row) => row.name),
    );
}

async function financialDigest(database: SqlExecutor, fixture: Fixture): Promise<string> {
  const result = await database.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::text FROM saas_requests WHERE tenant_id=$1) AS requests,
       (SELECT count(*)::text FROM saas_attempts WHERE tenant_id=$1) AS attempts,
       (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id=$1) AS usage,
       (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id=$1) AS settlements,
       (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1) AS ledger_transactions,
       (SELECT jsonb_agg(jsonb_build_array(currency,posted_balance_minor_units) ORDER BY id)
          FROM saas_wallets WHERE tenant_id=$1) AS wallets,
       (SELECT jsonb_agg(jsonb_build_array(state,amount_minor_units) ORDER BY id)
          FROM saas_billing_reservations WHERE tenant_id=$1) AS holds,
       (SELECT jsonb_agg(jsonb_build_array(execution_state,financial_status,state_version) ORDER BY id)
          FROM saas_requests WHERE tenant_id=$1) AS request_states,
       (SELECT jsonb_agg(jsonb_build_array(dispatch_state,result_state,state_version) ORDER BY id)
          FROM saas_attempts WHERE tenant_id=$1) AS attempt_states`,
    [fixture.tenantId],
  );
  assert.equal(result.rows.length, 1);
  return fingerprint(result.rows[0]);
}

async function seedHealthyAccount(migrator: SaasDatabase, fixture: Fixture, mode: Mode): Promise<void> {
  await migrator.query(
    `INSERT INTO saas_provider_account_runtime_health
       (owner_scope_key,owner_kind,owner_tenant_id,account_id,state,failure_count,observed_at,
        cooldown_until,last_outcome,source_fencing_token,revision)
     VALUES ($1,$2,$3,$4,'healthy',0,clock_timestamp(),NULL,'gateway_success',1,1)`,
    [
      mode === 'byok' ? fixture.tenantId : 'platform',
      mode === 'byok' ? 'tenant' : 'platform',
      mode === 'byok' ? fixture.tenantId : null,
      fixture.sent.accountId,
    ],
  );
}

function candidate(fixture: Fixture, mode: Mode, pool?: PlatformPoolFacts): RequestPreparationCandidateAuthority {
  const sent = fixture.sent;
  const common = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    supplyProfileId: fixture.profileId,
    upstreamId: text(sent.upstreamId),
    accountId: text(sent.accountId),
    credentialId: text(sent.credentialId),
    credentialVersion: Number(sent.credentialVersion),
    credentialAuthzVersion: Number(sent.credentialAuthzVersion),
    accountAuthzVersion: Number(sent.accountAuthzVersion),
    dispatchProfileId: text(sent.dispatchProfileId),
    supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
    resolvedModel: text(sent.resolvedModel),
    protocol: 'openai' as const,
    endpoint: text(sent.endpoint),
    supplierCostVersion: sent.supplierCostVersion,
    providerId: text(sent.providerId),
    productId: text(sent.productId),
  };
  if (mode === 'byok')
    return {
      ...common,
      supplyMode: mode,
      accountOwnerKind: 'tenant',
      profileAccountAuthzVersion: Number(sent.profileAccountAuthzVersion),
    };
  assert.ok(pool, 'platform candidate requires the actual route-aligned pool');
  return { ...common, supplyMode: mode, accountOwnerKind: 'platform', ...pool };
}

async function schedulingFixture(
  migrator: SaasDatabase,
  seedGateway: SaasDatabase,
  mode: Mode,
  poolFactory: (fixture: Fixture) => Promise<PlatformPoolFacts> = (fixture) => alignPlatformPool(migrator, fixture),
): Promise<SchedulingFixture> {
  const fixture = await seedFixture(migrator, seedGateway, mode);
  const pool = mode === 'platform' ? await poolFactory(fixture) : undefined;
  await seedHealthyAccount(migrator, fixture, mode);
  const selected = candidate(fixture, mode, pool);
  const alias = text(
    (
      await seedGateway.query<{ public_model: string }>(
        'SELECT public_model FROM saas_requests WHERE tenant_id=$1 AND id=$2',
        [fixture.tenantId, fixture.input.requestId],
      )
    ).rows[0]?.public_model,
  );
  return {
    mode,
    fixture,
    input: {
      requestId: randomUUID(),
      publicModel: alias,
      protocol: 'openai',
      caller: {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        proxyKeyId: fixture.keyId,
        principalKind: 'member',
        principalId: fixture.userId,
        entitlementId: fixture.entitlementId,
        supplyProfileId: fixture.profileId,
        supplyMode: mode,
        modelScopes: [alias],
        authzVersion: 1,
        entitlementVersion: 1,
        supplyProfileVersion: 1,
        modelScopeVersion: 1,
      },
      entitlement: {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        proxyKeyId: fixture.keyId,
        entitlementId: fixture.entitlementId,
        entitlementVersion: 1,
        supplyProfileId: fixture.profileId,
        supplyProfileVersion: 1,
        supplyMode: mode,
        modelScopeVersion: 1,
        allowedModels: [alias],
        allowedProviderIds: mode === 'byok' ? [selected.providerId] : [],
        projectPolicyVersion: Number(fixture.sent.projectPolicyVersion),
      },
      route: {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        publicModel: alias,
        publicModelId: text(fixture.sent.routePublicModelId),
        publicModelVersion: Number(fixture.sent.routePublicModelVersion),
        routeConfigId: text(fixture.sent.routeConfigId),
        routeConfigVersion: Number(fixture.sent.routeConfigVersion),
        protocol: 'openai',
        providerProtocol: 'openai',
        clientOperation: 'chat.completions',
        providerOperation: 'chat.completions',
        targetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
        upstreamId: text(fixture.sent.upstreamId),
        endpoint: text(fixture.sent.endpoint),
      },
      candidates: [selected],
    },
  };
}

function scheduler(database: SaasDatabase): PostgresProviderAccountScheduler {
  return new PostgresProviderAccountScheduler({
    database,
    leaseConcurrencyLimit: 2,
    health: new PostgresProviderAccountRuntimeHealthStore({ database, maxHealthAgeMs: 300_000 }),
    maxHealthAgeMs: 300_000,
  });
}

function resolveCommercial(database: SaasDatabase, fixture: Fixture, executor?: SqlExecutor) {
  return new SaasCommercialMeteringPolicyService(database).resolveDispatchableRoute(
    fixture.tenantId,
    fixture.projectId,
    text(fixture.sent.routeConfigId),
    text(fixture.sent.routeConfigVersion),
    executor,
  );
}

async function runAllowedPaths(database: SaasDatabase, fixtures: readonly SchedulingFixture[]): Promise<void> {
  const sourceScheduler = scheduler(database);
  for (const item of fixtures) {
    const decision = await sourceScheduler.select({ ...item.input, requestId: randomUUID() });
    assert.equal(decision.decision, 'allow');
    const commercial = await resolveCommercial(database, item.fixture);
    assert.ok(commercial, 'the actual final commercial authority must allow the seeded route');
    assert.equal(commercial.customerPriceVersion, item.fixture.sent.customerPriceVersion);
    assert.equal(commercial.supplierCostVersion, item.fixture.sent.supplierCostVersion);
  }
}

function supply(database: SaasDatabase): ProviderSupplyService {
  return new ProviderSupplyService(database, {
    deployment: 'fin057-test',
    environment: 'test',
    kmsKeyId: 'fin057-synthetic-kms',
  });
}

async function windowPool(
  migrator: SaasDatabase,
  fixture: Fixture,
  boundary: 'future' | 'expired',
): Promise<PlatformPoolFacts> {
  const now = validDate((await migrator.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now);
  const rights = await new SaasCatalogService(migrator).registerProviderRightsVersion({
    providerId: text(fixture.sent.providerId),
    productId: text(fixture.sent.productId),
    credentialType: 'api-key',
    supplyMode: 'platform',
    region: 'test',
    purpose: 'inference',
    modelScope: [text(fixture.sent.resolvedModel)],
    endpointScope: [text(fixture.sent.endpoint)],
    effectiveAt: new Date(now.getTime() + (boundary === 'future' ? 3_600_000 : -7_200_000)),
    expiresAt: new Date(now.getTime() + (boundary === 'future' ? 7_200_000 : -3_600_000)),
    approvalReference: `prepared-window-${randomUUID()}`,
    evidenceReference: `prepared-window-${randomUUID()}`,
    evidenceSha256: 'b'.repeat(64),
    audit: { actorUserId: fixture.userId, entryPoint: 'prepared-pg-window', requestId: randomUUID() },
  });
  const service = supply(migrator);
  const pool = await service.createPlatformProviderPool({
    id: text(fixture.sent.upstreamId),
    displayName: 'prepared statement synthetic window pool',
    providerId: text(fixture.sent.providerId),
    productId: text(fixture.sent.productId),
    credentialType: 'api-key',
    region: 'test',
    purpose: 'inference',
    rightsId: rights.rightsId,
    rightsVersion: rights.version,
    status: 'active',
    validationState: 'verified',
  });
  await service.addPlatformPoolMember({
    poolId: pool.id,
    accountId: text(fixture.sent.accountId),
    expectedAccountAuthzVersion: Number(fixture.sent.accountAuthzVersion),
  });
  const grant = await service.grantPlatformPoolToProfile({
    poolId: pool.id,
    tenantId: fixture.tenantId,
    supplyProfileId: fixture.profileId,
    evidenceReference: `prepared-window-grant-${randomUUID()}`,
    evidenceSha256: 'd'.repeat(64),
  });
  return {
    poolId: pool.id,
    poolAuthzVersion: pool.authzVersion,
    poolMemberAccountAuthzVersion: Number(fixture.sent.accountAuthzVersion),
    poolMemberAuthzVersion: 1,
    poolGrantAuthzVersion: grant.authzVersion,
    poolGrantProfileAuthzVersion: grant.profileAuthzVersion,
    poolGrantPoolAuthzVersion: grant.poolAuthzVersion,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function scene(context: TestContext, name: string, work: () => Promise<void>): Promise<void> {
  await context.test(name, async () => {
    try {
      await work();
    } catch (error) {
      // Driver errors may carry SQL parameters or sensitive row details; keep only a SQLSTATE.
      throw safeCancellationFailure(error);
    }
  });
}

test('owned restricted PostgreSQL executes three real business statements with optional native preparation', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three designated disposable gateway E2E role URLs`
      : false,
  timeout: 300_000,
}, async (t) => {
  const [migratorUrl, controlPlaneUrl, gatewayUrl] = roleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl, max: 4, env: {} });
  const controlPlane = createSaasDatabase({ connectionString: controlPlaneUrl, max: 4, env: {} });
  // No injected pool: the optional capability must survive the real node-postgres transaction wrapper.
  const off = createSaasDatabase({ connectionString: gatewayUrl, max: 1, idleTimeoutMillis: 0, env: {} });
  const native = createSaasDatabase({
    connectionString: gatewayUrl,
    max: 1,
    idleTimeoutMillis: 0,
    preparedStatements: 'native',
    env: {},
  });
  const databases = [migrator, controlPlane, off, native];
  try {
    for (const [database, role] of [
      [migrator, 'model_router_saas_migrator'],
      [controlPlane, 'model_router_saas_control_plane'],
      [off, 'model_router_saas_gateway'],
      [native, 'model_router_saas_gateway'],
    ] as const) {
      const row = (
        await database.query<{ role: string; session: string; superuser: boolean; version: string }>(
          `SELECT current_user AS role,session_user AS session,r.rolsuper AS superuser,
                current_setting('server_version_num') AS version FROM pg_roles r WHERE rolname=current_user`,
        )
      ).rows[0];
      assert.equal(row?.role, role);
      assert.equal(row?.session, role);
      assert.equal(row?.superuser, false);
      assert.ok([15, 18].includes(Math.floor(Number(row?.version) / 10_000)));
    }
    await migrator.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(native, 'gateway');
    const fixtures: SchedulingFixture[] = [];
    for (const mode of ['byok', 'platform'] as const) {
      for (let index = 0; index < 2; index += 1) fixtures.push(await schedulingFixture(migrator, off, mode));
    }
    const finances = await Promise.all(fixtures.map((item) => financialDigest(migrator, item.fixture)));
    const nativePid = (await native.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    assert.ok(Number.isInteger(nativePid));
    const anonymousFacts = new Map<string, string>();

    await scene(t, 'default off keeps database, real transactions and all three source paths anonymous', async () => {
      assert.equal(typeof off.queryPrepared, 'undefined');
      await off.transaction(async (executor) => {
        assert.equal(typeof executor.queryPrepared, 'undefined');
      });
      const calls: StatementCall[] = [];
      await runAllowedPaths(observedDatabase(off, 'auto', calls, []), fixtures);
      assert.equal(calls.length, fixtures.length * 2);
      assert.deepEqual([...new Set(calls.map((call) => call.kind))].sort(), [
        'cm-final',
        'sched-byok',
        'sched-platform',
      ]);
      assert.ok(calls.every((call) => call.transport === 'anonymous' && call.name === null));
      for (const call of calls) anonymousFacts.set(`${call.kind}/${call.rowIdentityDigest}`, call.rowFactsDigest);
      assert.deepEqual(await preparedStatements(off), []);
      await assertAutoRestored(off);
    });

    await scene(
      t,
      'native auto retains root autocommit and transaction observer capabilities, fresh rows, and three fixed names',
      async () => {
        assert.equal(typeof native.queryPrepared, 'function');
        await native.transaction(async (executor) => {
          assert.equal(typeof executor.queryPrepared, 'function');
        });
        const before = await preparedStatements(native);
        assert.deepEqual(before, []);
        const calls: StatementCall[] = [];
        const observations: PostgresPreparationObservation[] = [];
        const database = observedDatabase(native, 'auto', calls, observations);
        for (let round = 0; round < 3; round += 1) await runAllowedPaths(database, fixtures);
        assert.ok(calls.every((call) => call.transport === 'prepared'));
        for (const call of calls) {
          assert.equal(
            anonymousFacts.get(`${call.kind}/${call.rowIdentityDigest}`),
            call.rowFactsDigest,
            'native preparation preserves all non-clock authority rows from the anonymous source path',
          );
        }
        for (const kind of ['cm-final', 'sched-byok', 'sched-platform'] as const) {
          const selected = calls.filter((call) => call.kind === kind);
          assert.equal(new Set(selected.map((call) => call.name)).size, 1);
          assert.equal(new Set(selected.map((call) => call.sqlSha256)).size, 1);
          assert.ok(
            new Set(selected.map((call) => call.parameterDigest)).size >= 2,
            'different own-row parameters reuse one name',
          );
          const operation =
            kind === 'cm-final'
              ? 'saas_route_config_dispatchable'
              : `postgres-provider-account-scheduler:${kind === 'sched-byok' ? 'byok' : 'platform'}-eligibility`;
          assert.equal(
            observations.filter(
              (entry) => entry.kind === 'query' && entry.operation === operation && entry.outcome === 'ok',
            ).length,
            selected.length,
          );
        }
        const after = await preparedStatements(native);
        assertExecutions(before, after, calls, false);
        for (const kind of ['sched-byok', 'sched-platform'] as const) {
          const clocks = calls.filter((call) => call.kind === kind).map((call) => call.authorityAtMs);
          assert.ok(clocks.every((clock) => clock !== null));
          const first = clocks[0];
          const last = clocks.at(-1);
          assert.ok(
            typeof first === 'number' && typeof last === 'number' && last > first,
            'warm execution must return a new database authority clock',
          );
        }
        await assertAutoRestored(native);
        t.diagnostic(
          JSON.stringify({
            mode: 'native-auto',
            scope: 'correctness-only; no automatic generic-plan or performance claim',
            statements: after,
          }),
        );
      },
    );

    const genericCalls: StatementCall[] = [];
    const generic = observedDatabase(native, 'force_generic_plan', genericCalls, []);
    const genericBaseline = await preparedStatements(native);
    await scene(
      t,
      'transaction-local forced generic warmup uses every existing name for new Bind/Execute',
      async () => {
        const before = await preparedStatements(native);
        const offset = genericCalls.length;
        for (let round = 0; round < 3; round += 1) await runAllowedPaths(generic, fixtures);
        const after = await preparedStatements(native);
        assertExecutions(before, after, genericCalls.slice(offset), true);
        await assertAutoRestored(native);
        t.diagnostic(
          JSON.stringify({
            mode: 'native-forced-generic',
            scope:
              'forced generic correctness with statement transactions; production autocommit covered separately; no performance claim',
            statements: after,
          }),
        );
      },
    );

    for (const mode of ['byok', 'platform'] as const) {
      await scene(
        t,
        `${mode}: warm generic reads reject a committed credential epoch and revocation without billing effects`,
        async () => {
          const item = fixtures.filter((entry) => entry.mode === mode)[1];
          assert.ok(item);
          const before = await financialDigest(migrator, item.fixture);
          const original = item.input.candidates[0];
          assert.ok(original);
          const service = supply(controlPlane);
          const disabled = await service.disableProviderCredential({
            credentialId: original.credentialId,
            expectedAuthzVersion: original.credentialAuthzVersion,
          });
          assert.equal(disabled.authzVersion, original.credentialAuthzVersion + 1);
          assert.equal((await scheduler(generic).select(item.input)).decision, 'reject');
          const enabled = await service.enableProviderCredential({
            credentialId: original.credentialId,
            expectedAuthzVersion: disabled.authzVersion,
          });
          assert.equal(enabled.status, 'active');
          assert.equal(enabled.authzVersion, original.credentialAuthzVersion + 2);
          const stale = await scheduler(generic).select(item.input);
          assert.equal(
            stale.decision,
            'reject',
            'an active credential with a new persisted epoch cannot reuse warm authority',
          );
          if (stale.decision === 'reject') assert.equal(stale.code, 'account_denied');
          const current = {
            ...item.input,
            candidates: [{ ...original, credentialAuthzVersion: enabled.authzVersion }],
          };
          assert.equal((await scheduler(generic).select(current)).decision, 'allow');
          await service.revokeProviderCredential({
            credentialId: original.credentialId,
            expectedAuthzVersion: enabled.authzVersion,
          });
          const revoked = await scheduler(generic).select(current);
          assert.equal(revoked.decision, 'reject');
          if (revoked.decision === 'reject') assert.equal(revoked.code, 'account_denied');
          assert.equal(await financialDigest(migrator, item.fixture), before);
          await assertAutoRestored(native);
        },
      );
    }

    for (const boundary of ['future', 'expired'] as const) {
      await scene(t, `warm generic eligibility rejects ${boundary} database-authority rights windows`, async () => {
        const item = await schedulingFixture(migrator, off, 'platform', (fixture) =>
          windowPool(migrator, fixture, boundary),
        );
        const before = await financialDigest(migrator, item.fixture);
        const offset = genericCalls.length;
        const decision = await scheduler(generic).select(item.input);
        assert.equal(decision.decision, 'reject');
        if (decision.decision === 'reject') assert.equal(decision.code, 'account_denied');
        const selected = genericCalls.slice(offset).filter((call) => call.kind === 'sched-platform');
        assert.equal(selected.length, 1, 'the actual cached eligibility statement must read this window');
        assert.equal(selected[0]?.rowCount, 0, 'database authority clock filters the invalid pool-rights window');
        assert.equal(await financialDigest(migrator, item.fixture), before);
        await assertAutoRestored(native);
      });
    }

    for (const mode of ['byok', 'platform'] as const) {
      await scene(
        t,
        `${mode}: warm generic final authority waits for a real writer fence and rejects committed revocation`,
        async () => {
          const item = fixtures.find((entry) => entry.mode === mode);
          assert.ok(item);
          const fixture = item.fixture;
          const before = await financialDigest(migrator, fixture);
          assert.ok(await resolveCommercial(generic, fixture));
          const writerReady = deferred<number>();
          const readerReady = deferred<number>();
          const release = deferred<void>();
          // Match the existing commercial-dispatch-hint operator writer. These policy tables
          // have no control-plane write grant; the named-plan reader remains restricted GW.
          const writer = migrator.transaction(async (executor) => {
            await new SaasCommercialMeteringPolicyService(onExecutor(migrator, executor)).disableCustomerPolicy({
              tenantId: fixture.tenantId,
              projectId: fixture.projectId,
              policyId: text(fixture.sent.customerMeteringPolicyId),
              expectedVersion: text(fixture.sent.customerMeteringPolicyVersion),
              audit: { actorUserId: fixture.userId, entryPoint: 'prepared-pg-revocation' },
            });
            const pid = (await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
            assert.ok(pid);
            writerReady.resolve(pid);
            await release.promise;
          });
          void writer.catch(writerReady.reject);
          let reader: ReturnType<typeof resolveCommercial> | undefined;
          try {
            const writerPid = await writerReady.promise;
            reader = generic.transaction(async (executor) => {
              const pid = (await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
              assert.ok(typeof pid === 'number');
              assert.equal(pid, nativePid, 'warm prepared plans and the waiting reader use the same owned connection');
              readerReady.resolve(pid);
              return resolveCommercial(generic, fixture, executor);
            });
            void reader.catch(readerReady.reject);
            const readerPid = await readerReady.promise;
            let blocked = false;
            const deadline = Date.now() + 5_000;
            do {
              blocked =
                (
                  await migrator.query<{ blocked: boolean }>(
                    'SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked',
                    [writerPid, readerPid],
                  )
                ).rows[0]?.blocked === true;
              if (!blocked) await delay(10);
            } while (!blocked && Date.now() < deadline);
            assert.equal(blocked, true, 'the real policy writer must block the reader authorization fence');
            release.resolve();
            await writer;
            assert.equal(await reader, null, 'fresh post-fence Bind/Execute cannot reuse the pre-revocation allow');
          } finally {
            release.resolve();
            await Promise.allSettled(reader ? [writer, reader] : [writer]);
          }
          assert.equal(await financialDigest(migrator, fixture), before);
          await assertAutoRestored(native);
        },
      );
    }
    for (const [index, item] of fixtures.entries())
      assert.equal(await financialDigest(migrator, item.fixture), finances[index]);
    const final = await preparedStatements(native);
    assertExecutions(genericBaseline, final, genericCalls, true);
    assert.equal((await native.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid, nativePid);
    await assertAutoRestored(native);
    assert.ok(genericCalls.every((call) => call.transport === 'prepared'));
    t.diagnostic(
      JSON.stringify({
        mode: 'native-forced-generic',
        scope: 'transaction-local correctness only; no performance claim',
        statements: final,
      }),
    );
  } catch (error) {
    throw safeCancellationFailure(error);
  } finally {
    await Promise.allSettled(databases.map((database) => database.close()));
  }
});
