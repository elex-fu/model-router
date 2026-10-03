import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { SaasConsoleUsageQueryService, type ConsoleAttempt, type ConsoleRequest, type ConsoleRequestDetail, type ConsoleUsageEvent } from '../../../src/saas/console/index.js';

// Future paired G5 source/roles gate: original successful HTTP fixture first.
// This root is entirely read-only. It never migrates, grants, seeds a request,
// bootstraps, changes a membership, reconstructs signed usage or calls a provider.
// It proves CP query/ACL semantics, not session/browser or full FIN acceptance.
const REQUIRED = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roleConfig.map(([name]) => process.env[name]?.trim());
const anyConfigured = configured.some(Boolean);
type Phase = 'target' | 'principal' | 'schema-acl' | 'fixture' | 'scoped-query' | 'denial' | 'postflight' | 'close';
interface Diagnostic { phase: Phase; sqlState?: string }

function firstSqlState(cause: unknown): string | undefined {
  const seen = new Set<object>();
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)) return cause.code;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return undefined;
}

function redacted(cause: unknown, diagnostic: Diagnostic): Error {
  const failure = new Error(`Customer request role proof failed (phase=${diagnostic.phase}; SQLSTATE=${diagnostic.sqlState ?? firstSqlState(cause) ?? 'not-captured'}); details redacted.`);
  failure.stack = failure.message;
  return failure;
}

async function proof(t: TestContext, diagnostic: Diagnostic, phase: Phase, name: string, work: () => Promise<void>): Promise<void> {
  let failed = false;
  diagnostic.phase = phase;
  diagnostic.sqlState = undefined;
  await t.test(name, async () => {
    try { await work(); } catch (cause) { failed = true; throw redacted(cause, diagnostic); }
  });
  if (failed) throw redacted(undefined, diagnostic); // Stop, never label later stages passed.
}

function safeTargets(): { urls: string[]; database: string } {
  let identity: string | undefined;
  let expectedDatabase: string | undefined;
  const urls = roleConfig.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required`);
    let parsed: URL; let username: string; let database: string;
    try { parsed = new URL(value); username = decodeURIComponent(parsed.username); database = decodeURIComponent(parsed.pathname.slice(1)); }
    catch { throw new Error('Invalid guarded PostgreSQL target; details redacted.'); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL protocol required');
    assert.ok(username === role, 'exact direct managed principal required');
    assert.ok(parsed.search === '' && parsed.hash === '', 'URL overrides/fragments forbidden');
    const host = parsed.hostname.toLowerCase(); const port = Number(parsed.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && Boolean(parsed.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432, 53782, 15005, 15006].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[A-Za-z0-9_]+$/.test(database));
    assert.ok(ci || local, 'only designated CI or explicit nonshared disposable loopback target allowed');
    const current = `${host}:${port}/${database}`;
    identity ??= current; expectedDatabase ??= database;
    assert.ok(current === identity, 'all three actors must share the guarded database');
    return value;
  });
  assert.ok(expectedDatabase);
  return { urls, database: expectedDatabase };
}

async function bounded<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const mode = await tx.query<{ readonly: boolean }>("SELECT current_setting('transaction_read_only') = 'on' AS readonly");
    assert.equal(mode.rows[0]?.readonly, true);
    return work(tx);
  });
}

async function principal(tx: SqlExecutor, role: string, database: string): Promise<void> {
  const result = await tx.query<{ direct: boolean; safe: boolean; managed: boolean; database: string; major: number }>(
    `SELECT current_user = $1 AND session_user = $1 AS direct,
      NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) AS safe,
      current_schema() = 'model_router_saas' AND current_setting('search_path') = 'model_router_saas'
        AND current_schemas(false) = ARRAY['model_router_saas']::name[]
        AND current_schemas(true) = ARRAY['pg_catalog','model_router_saas']::name[] AS managed,
      current_database() AS database, current_setting('server_version_num')::integer / 10000 AS major
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`, [role]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]; assert.ok(row);
  assert.equal(row.direct, true); assert.equal(row.safe, true); assert.equal(row.managed, true);
  assert.ok(row.database === database); assert.ok(row.major === 15 || row.major === 18);
}

interface Fixture {
  tenantId: string; projectId: string; userId: string;
  requests: ConsoleRequest[];
}

const requestMetadataKeys = [
  'id', 'projectId', 'model', 'protocol', 'supplyMode', 'status',
  'financialStatus', 'reconciliationState', 'createdAt', 'updatedAt',
] as const satisfies readonly (keyof ConsoleRequest)[];
const attemptMetadataKeys = [
  'id', 'sequence', 'status', 'responseStarted', 'responseStartedAt',
  'httpStatus', 'createdAt', 'updatedAt',
] as const satisfies readonly (keyof ConsoleAttempt)[];
const usageMetadataKeys = [
  'id', 'supplyMode', 'inputTotal', 'inputUncached', 'cacheRead', 'cacheWrite',
  'cacheWrite5m', 'cacheWrite1h', 'outputTotal', 'reasoningOutput', 'status',
  'source', 'measurementKind', 'billableBasis', 'createdAt',
] as const satisfies readonly (keyof ConsoleUsageEvent)[];
const forbiddenMetadataKeys = [
  'proxyKey', 'principalId', 'credential', 'upstreamId', 'accountId',
  'evidenceRef', 'fingerprint', 'prompt', 'responseBody',
] as const;

function exactMetadataKeys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const keys = Reflect.ownKeys(value).map((key) => { assert.ok(typeof key === 'string'); return key; });
  assert.deepEqual(keys.sort(), [...expected].sort(), 'exact public DTO keys required');
}

function noForbiddenMetadataKeys(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  assert.equal(seen.has(value), false, 'public metadata cannot contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    for (const item of items) noForbiddenMetadataKeys(item, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key.replace(/[_-]/g, ''),
        /proxyKey|principalId|credential|upstreamId|accountId|evidenceRef|fingerprint|prompt|responseBody/i,
        'forbidden customer metadata key');
      noForbiddenMetadataKeys(child, seen);
    }
  }
  seen.delete(value);
}

function publicMetadataScalar(value: unknown): void {
  assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value),
    'public metadata leaf must remain a scalar');
}

function publicDetailProjection(value: unknown): void {
  noForbiddenMetadataKeys(value);
  exactMetadataKeys(value, [...requestMetadataKeys, 'attempts', 'usageEvents']);
  for (const key of requestMetadataKeys) publicMetadataScalar(value[key]);
  assert.ok(Array.isArray(value.attempts) && Array.isArray(value.usageEvents));
  const attempts: readonly unknown[] = value.attempts;
  const events: readonly unknown[] = value.usageEvents;
  for (const attempt of attempts) {
    exactMetadataKeys(attempt, attemptMetadataKeys);
    for (const key of attemptMetadataKeys) publicMetadataScalar(attempt[key]);
  }
  for (const event of events) {
    exactMetadataKeys(event, usageMetadataKeys);
    for (const key of usageMetadataKeys) publicMetadataScalar(event[key]);
  }
}

function projectionCounterexamples(detail: ConsoleRequestDetail): void {
  // These copies test only the privacy oracle; never write or replace PG facts.
  // 'upstream' is a valid public source VALUE, not a supplier identity KEY.
  publicDetailProjection({ ...detail,
    usageEvents: detail.usageEvents.map((event) => ({ ...event, source: 'upstream' })) });
  const attempt = detail.attempts[0]; const event = detail.usageEvents[0];
  assert.ok(attempt && event);
  for (const key of [...forbiddenMetadataKeys, 'upstream_id', 'credential_id', 'internalTrace']) {
    for (const invalid of [
      { ...detail, [key]: 'not-public' },
      { ...detail, attempts: [{ ...attempt, [key]: 'not-public' }] },
      { ...detail, usageEvents: [{ ...event, [key]: 'not-public' }] },
      { ...detail, model: { nested: [{ [key]: 'not-public' }] } },
    ]) assert.throws(() => publicDetailProjection(invalid));
  }
}

function timestamp(value: unknown): string {
  assert.ok(value instanceof Date || typeof value === 'string');
  const date = value instanceof Date ? value : new Date(value);
  assert.ok(Number.isFinite(date.getTime()));
  return date.toISOString();
}

async function fixture(tx: SqlExecutor): Promise<Fixture> {
  // Match the actual original HTTP project/tenant markers and two genuine
  // successful supply modes. Reject absent/ambiguous cohorts, never choose an
  // arbitrary latest database request or manufacture a signed result.
  const scopes = await tx.query<{ tenant_id: string; project_id: string; user_id: string }>(
    `SELECT r.tenant_id, r.project_id, m.user_id
     FROM saas_requests r JOIN saas_projects p ON p.tenant_id = r.tenant_id AND p.id = r.project_id
     JOIN saas_tenants t ON t.id = r.tenant_id AND t.status = 'active'
     JOIN saas_memberships m ON m.tenant_id = r.tenant_id AND m.role = 'owner' AND m.status = 'active'
     JOIN saas_users u ON u.id = m.user_id AND u.disabled_at IS NULL
     JOIN saas_project_memberships pm ON pm.tenant_id = r.tenant_id AND pm.project_id = r.project_id
       AND pm.user_id = m.user_id AND pm.status = 'active'
     WHERE t.slug LIKE 'gateway-e2e-%' AND p.slug LIKE 'gateway-e2e-project-%'
       AND r.execution_state = 'succeeded'
       AND EXISTS (SELECT 1 FROM saas_attempts a WHERE a.tenant_id = r.tenant_id AND a.request_id = r.id
         AND a.dispatch_state = 'sent' AND a.result_state = 'succeeded'
         AND a.response_started AND a.result_http_status = 200)
     GROUP BY r.tenant_id, r.project_id, m.user_id HAVING count(DISTINCT r.supply_mode) = 2`);
  assert.equal(scopes.rows.length, 1, 'one actual completed original HTTP cohort required before G5 PG execution');
  const scope = scopes.rows[0]; assert.ok(scope);
  const rows = await tx.query<{
    id: string; project_id: string; model: string; protocol: ConsoleRequest['protocol'];
    supply_mode: ConsoleRequest['supplyMode']; execution_state: ConsoleRequest['status'];
    financial_status: ConsoleRequest['financialStatus']; reconciliation_state: ConsoleRequest['reconciliationState'];
    created_at: Date | string; updated_at: Date | string;
  }>(`SELECT DISTINCT ON (r.supply_mode) r.id, r.project_id, r.public_model AS model, r.protocol,
       r.supply_mode, r.execution_state, r.financial_status, r.reconciliation_state, r.created_at, r.updated_at
     FROM saas_requests r WHERE r.tenant_id = $1::uuid AND r.project_id = $2::uuid AND r.execution_state = 'succeeded'
       AND EXISTS (SELECT 1 FROM saas_attempts a WHERE a.tenant_id = r.tenant_id AND a.request_id = r.id
         AND a.dispatch_state = 'sent' AND a.result_state = 'succeeded' AND a.response_started AND a.result_http_status = 200)
     ORDER BY r.supply_mode, r.created_at DESC, r.id DESC`, [scope.tenant_id, scope.project_id]);
  assert.equal(rows.rows.length, 2);
  assert.deepEqual(rows.rows.map((row) => row.supply_mode), ['byok', 'platform']);
  return { tenantId: scope.tenant_id, projectId: scope.project_id, userId: scope.user_id,
    requests: rows.rows.map((row) => ({ id: row.id, projectId: row.project_id, model: row.model,
      protocol: row.protocol, supplyMode: row.supply_mode, status: row.execution_state,
      financialStatus: row.financial_status, reconciliationState: row.reconciliation_state,
      createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) })) };
}

async function acl(tx: SqlExecutor): Promise<void> {
  const result = await tx.query<{ read_columns: string[]; table_read: boolean; insert_allowed: boolean; update_allowed: boolean; delete_allowed: boolean; execute_count: number }>(
    `SELECT ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = 'model_router_saas.saas_requests'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND pg_catalog.has_column_privilege(current_user, a.attrelid, a.attnum, 'SELECT') ORDER BY a.attname) AS read_columns,
      pg_catalog.has_table_privilege(current_user, 'model_router_saas.saas_requests', 'SELECT') AS table_read,
      pg_catalog.has_any_column_privilege(current_user, 'model_router_saas.saas_requests', 'INSERT') AS insert_allowed,
      pg_catalog.has_any_column_privilege(current_user, 'model_router_saas.saas_requests', 'UPDATE') AS update_allowed,
      pg_catalog.has_table_privilege(current_user, 'model_router_saas.saas_requests', 'DELETE') AS delete_allowed,
      (SELECT count(*)::integer FROM pg_catalog.pg_proc p
        WHERE p.pronamespace = 'model_router_saas'::regnamespace AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')) AS execute_count`);
  assert.equal(result.rows.length, 1); const row = result.rows[0]; assert.ok(row);
  assert.deepEqual(row.read_columns, ['id','tenant_id','project_id','public_model','protocol','supply_mode',
    'execution_state','financial_status','reconciliation_state','created_at','updated_at'].sort());
  assert.equal(row.table_read, false); assert.equal(row.insert_allowed, false); assert.equal(row.update_allowed, false);
  assert.equal(row.delete_allowed, false); assert.equal(row.execute_count, 0);
}

async function unchanged(tx: SqlExecutor, tenantId: string): Promise<unknown> {
  return (await tx.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
    'requests', (SELECT jsonb_agg(jsonb_build_array(id, execution_state, financial_status, reconciliation_state,
      state_version::text, updated_at::text) ORDER BY id) FROM saas_requests WHERE tenant_id = $1::uuid),
    'holds', (SELECT jsonb_agg(jsonb_build_array(id, state, amount_minor_units::text, settlement_amount_minor_units::text,
      updated_at::text) ORDER BY id) FROM saas_billing_reservations WHERE tenant_id = $1::uuid),
    'wallets', (SELECT jsonb_agg(jsonb_build_array(id, posted_balance_minor_units::text, updated_at::text) ORDER BY id)
      FROM saas_wallets WHERE tenant_id = $1::uuid),
    'usage_events', (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1::uuid),
    'settlements', (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1::uuid),
    'ledger_transactions', (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = $1::uuid),
    'ledger_entries', (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1::uuid),
    'freezes', (SELECT count(*)::text FROM saas_billing_spending_freezes WHERE tenant_id = $1::uuid)
    ) AS snapshot`, [tenantId])).rows[0]?.snapshot;
}

async function close(database: SaasDatabase): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([database.close(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Bounded pool close failed; details redacted.')), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('G5 restricted CP request axes and privacy contract on real PostgreSQL', {
  skip: !anyConfigured && process.env[REQUIRED] !== '1',
}, async (t) => {
  const diagnostic: Diagnostic = { phase: 'target' }; const databases: SaasDatabase[] = [];
  let failure: Error | undefined;
  try {
    const targets = safeTargets();
    for (const url of targets.urls) databases.push(createSaasDatabase({ connectionString: url, max: 1,
      connectionTimeoutMillis: 5_000, idleTimeoutMillis: 0 }));
    const [migrator, control, gateway] = databases; assert.ok(migrator && control && gateway);
    await proof(t, diagnostic, 'principal', 'direct guarded principals, current ledger and full runtime probes', async () => {
      for (const [index, database] of databases.entries()) {
        const role = roleConfig[index]; assert.ok(role);
        // Retain one connection until close. Session bounds also cover the real
        // verifySchema pool/client reader, not a mock or reconstructed ledger.
        // No search_path, identity, persistent role setting or business write.
        await database.query("SET SESSION default_transaction_read_only = 'on'");
        await database.query("SET SESSION statement_timeout = '15s'");
        await database.query("SET SESSION lock_timeout = '5s'");
        await database.query("SET SESSION idle_in_transaction_session_timeout = '30s'");
        await bounded(database, (tx) => principal(tx, role[1], targets.database));
      }
      diagnostic.phase = 'schema-acl';
      await migrator.verifySchema();
      await bounded(control, (tx) => verifySaasRuntimeDatabasePrivileges(tx, 'control_plane'));
      await bounded(gateway, (tx) => verifySaasRuntimeDatabasePrivileges(tx, 'gateway'));
      await bounded(control, acl);
    });
    diagnostic.phase = 'fixture';
    const f = await bounded(migrator, fixture);
    const before = await bounded(migrator, (tx) => unchanged(tx, f.tenantId)); assert.ok(before);
    await proof(t, diagnostic, 'scoped-query', 'actual CP list/detail project scope preserve stored axes for both successful HTTP modes', async () => {
      await bounded(control, async (tx) => {
        const queries = new SaasConsoleUsageQueryService(tx);
        const scope = { userId: f.userId, tenantId: f.tenantId, projectId: f.projectId };
        for (const expected of f.requests) {
          const page = await queries.listRequests({ ...scope, supplyMode: expected.supplyMode, status: 'succeeded', limit: 1 });
          assert.deepEqual(page.items[0], expected);
          const detail = await queries.getRequestDetail({ ...scope, requestId: expected.id }); assert.ok(detail);
          const { attempts, usageEvents, ...metadata } = detail;
          assert.deepEqual(metadata, expected);
          assert.ok(attempts.length > 0); assert.ok(usageEvents.length > 0);
          assert.equal(expected.supplyMode === 'byok', expected.financialStatus === 'not_applicable');
          publicDetailProjection(detail);
          projectionCounterexamples(detail);
        }
      });
    });
    await proof(t, diagnostic, 'scoped-query', 'CP predicates deny wrong tenant/project and a principal with no active membership', async () => {
      await bounded(control, async (tx) => {
        const queries = new SaasConsoleUsageQueryService(tx); const request = f.requests[0]; assert.ok(request);
        const scope = { userId: f.userId, tenantId: f.tenantId, projectId: f.projectId };
        for (const wrong of [{ tenantId: randomUUID() }, { projectId: randomUUID() }, { userId: randomUUID() }]) {
          assert.deepEqual((await queries.listRequests({ ...scope, ...wrong })).items, []);
          assert.equal(await queries.getRequestDetail({ ...scope, ...wrong, requestId: request.id }), null);
        }
      });
    });
    await proof(t, diagnostic, 'denial', 'actual CP star/whole-row/internal-field/helper reads each fail with 42501', async () => {
      const request = f.requests[0]; assert.ok(request);
      const statements = [
        'SELECT * FROM saas_requests WHERE tenant_id=$1::uuid AND id=$2::uuid',
        'SELECT to_jsonb(r) FROM saas_requests r WHERE tenant_id=$1::uuid AND id=$2::uuid',
        ...['proxy_key_id','principal_id','entitlement_id','supply_profile_id','request_fingerprint']
          .map((column) => `SELECT ${column} FROM saas_requests WHERE tenant_id=$1::uuid AND id=$2::uuid`),
      ];
      for (const statement of statements) {
        diagnostic.sqlState = undefined;
        await assert.rejects(bounded(control, (tx) => tx.query(statement, [f.tenantId, request.id])), (cause: unknown) => {
          diagnostic.sqlState = firstSqlState(cause); assert.equal(diagnostic.sqlState, '42501'); return true;
        });
      }
      await assert.rejects(bounded(control, (tx) => tx.query(
        "SELECT model_router_saas.saas_prepared_evidence_valid_input_buckets(ARRAY['input_uncached']::text[])")), (cause: unknown) => {
        diagnostic.sqlState = firstSqlState(cause); assert.equal(diagnostic.sqlState, '42501'); return true;
      });
    });
    await proof(t, diagnostic, 'postflight', 'all queries leave request/hold/wallet/usage/ledger facts and exact CP/GW authority unchanged', async () => {
      assert.deepEqual(await bounded(migrator, (tx) => unchanged(tx, f.tenantId)), before);
      await bounded(control, acl);
      await bounded(control, (tx) => verifySaasRuntimeDatabasePrivileges(tx, 'control_plane'));
      await bounded(gateway, (tx) => verifySaasRuntimeDatabasePrivileges(tx, 'gateway'));
      await migrator.verifySchema();
    });
  } catch (cause) { failure = redacted(cause, diagnostic); }
  finally {
    diagnostic.phase = 'close'; diagnostic.sqlState = undefined;
    const results = await Promise.allSettled(databases.map(close));
    if (results.some((result) => result.status === 'rejected')) {
      if (failure) t.diagnostic('Customer request role proof cleanup failed; details redacted.');
      else failure = redacted(undefined, diagnostic);
    }
  }
  if (failure) throw failure;
});
