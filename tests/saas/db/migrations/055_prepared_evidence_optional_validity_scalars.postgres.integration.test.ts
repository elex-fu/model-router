import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../../src/saas/db/types.js';
import { saasAdvisoryKey } from '../../../../src/saas/db/advisory-lock-keys.js';
import { SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS } from '../../../../src/saas/db/runtime-privileges.js';
import { PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.js';

const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());

function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], i) => {
    const value = configured[i];
    assert.ok(value, `${name} is required for the 055 PostgreSQL gate`);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a valid PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.equal(decodeURIComponent(url.username), role, `${name} must use its exact managed role`);
    assert.equal(url.search, '', `${name} must not contain connection overrides`);
    assert.equal(url.hash, '', `${name} must not contain a fragment`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const database = decodeURIComponent(url.pathname.slice(1));
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && Boolean(url.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must identify the designated CI or an explicit nondefault disposable loopback target`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.equal(identity, target, 'all 055 roles must use the same disposable database');
    return value;
  });
}

async function transaction<T>(db: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '20s'");
    await tx.query("SET LOCAL lock_timeout = '15s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '25s'");
    const isolation = await tx.query<{ isolation: string }>("SELECT current_setting('transaction_isolation') AS isolation");
    assert.equal(isolation.rows[0]?.isolation, 'read committed');
    return work(tx);
  });
}

function denied(message: string, functionName: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && 'where' in error);
    assert.equal(error.code, '23514');
    // Compare a fixed enum-like guard message/context identity, never print a
    // raw server error, tuple, stack, SQL, parameter or credential envelope.
    assert.ok(error.message === message, '055 rejection must be from the exact expected validity check');
    assert.ok(typeof error.where === 'string' && error.where.includes(`${functionName}()`),
      '055 rejection must originate in the real expected trigger function');
    return true;
  };
}

interface Template {
  id: string; tenant_id: string; project_id: string; request_id: string; attempt_id: string;
  supply_mode: 'byok' | 'platform'; supply_profile_id: string; dispatch_profile_id: string;
  account_id: string; credential_id: string; credential_version: number; pool_id: string | null;
  customer_price_version: string | null; supplier_cost_version: string | null;
  route_config_id: string; route_config_version: number;
  customer_metering_policy_id: string; customer_metering_policy_version: number;
  provider_metering_policy_id: string; provider_metering_policy_version: number; contract_attestation_id: string;
}

// This required gate follows the unchanged six-case HTTP/FIN gateway suite.
// It fails (never skips) if its real successful BYOK/platform fixture is absent.
// Only that local HTTPS synthetic fixture is reused. No production secret is
// read; sealed test envelopes stay inside SQL, with no unsealing or output.
async function templates(db: SqlExecutor): Promise<Template[]> {
  const result = await db.query<{ evidence: Template }>(
    `WITH fixture AS (
       SELECT r.tenant_id FROM saas_requests r JOIN saas_projects p
         ON p.tenant_id = r.tenant_id AND p.id = r.project_id
        WHERE p.slug LIKE 'gateway-e2e-project-%' AND r.execution_state = 'succeeded'
        GROUP BY r.tenant_id HAVING count(DISTINCT r.supply_mode) = 2
        ORDER BY max(r.created_at) DESC LIMIT 1
     )
     SELECT DISTINCT ON (e.supply_mode) to_jsonb(e) AS evidence
       FROM saas_prepared_request_evidence e JOIN fixture f ON f.tenant_id = e.tenant_id
       JOIN saas_requests r ON r.tenant_id = e.tenant_id AND r.id = e.request_id
      WHERE r.execution_state = 'succeeded' AND e.status = 'claimed'
        AND e.account_id LIKE 'gateway-e2e-%' AND e.credential_id LIKE 'gateway-e2e-%'
      ORDER BY e.supply_mode, e.created_at DESC`);
  assert.equal(result.rows.length, 2, 'run the required real commercial gateway HTTP fixture first on this fresh disposable database');
  assert.deepEqual(result.rows.map((r) => r.evidence.supply_mode), ['byok', 'platform']);
  assert.equal(result.rows[0]!.evidence.tenant_id, result.rows[1]!.evidence.tenant_id);
  return result.rows.map((r) => r.evidence);
}

const tables = [
  'saas_tenant_provider_accounts', 'saas_tenant_provider_credentials', 'saas_tenant_provider_credential_versions',
  'saas_tenant_provider_supply_profile_accounts', 'saas_platform_provider_pools',
  'saas_platform_provider_pool_members', 'saas_platform_provider_pool_grants',
  'saas_customer_price_versions', 'saas_supplier_cost_versions',
  'saas_customer_metering_policy_versions', 'saas_provider_metering_policy_versions',
  'saas_customer_metering_policy_heads', 'saas_provider_metering_policy_heads',
  'saas_contract_test_attestations', 'saas_route_config_versions', 'saas_route_config_heads',
  'saas_route_config_commercial_authorities',
] as const;
type Table = typeof tables[number];
type BusinessTable = 'saas_requests' | 'saas_attempts' | 'saas_prepared_request_evidence';
interface BusinessSource {
  table: BusinessTable;
  columns: readonly { name: string; sql_type: string }[];
  row: Readonly<Record<string, unknown>>;
}
const columnCache = new Map<Table, string[]>();
function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

async function readBusinessSource(migrator: SqlExecutor, table: BusinessTable, sourceId: string, tenantId: string): Promise<BusinessSource> {
  assert.equal((await migrator.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_migrator');
  const attributes = await migrator.query<{ name: string; sql_type: string }>(
    `SELECT attname AS name, format_type(atttypid, atttypmod) AS sql_type FROM pg_attribute
      WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
    [`model_router_saas.${table}`]);
  const allowed = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([relation, , privilege]) => relation === table && privilege === 'INSERT')
    .map(([, column]) => column);
  // The existing role contract grants INSERT of every evidence column, but
  // request/attempt INSERT deliberately omits result-only/UPDATE-only fields.
  const columns = attributes.rows.filter((c) => table === 'saas_prepared_request_evidence' || allowed.includes(c.name));
  assert.ok(columns.length);
  assert.ok(columns.some((c) => c.name === 'id' && c.sql_type === 'uuid'));
  assert.ok(columns.some((c) => c.name === 'tenant_id' && c.sql_type === 'uuid'));
  const source = await migrator.query<Record<string, unknown>>(
    `SELECT ${columns.map((c) => identifier(c.name)).join(', ')} FROM model_router_saas.${identifier(table)}
      WHERE id = $1::uuid AND tenant_id = $2::uuid`, [sourceId, tenantId]);
  assert.equal(source.rows.length, 1, '055 must read one known-test-owned source under migrator, never an unrestricted source set');
  return { table, columns, row: source.rows[0]! };
}

async function insertBusiness(gateway: SqlExecutor, source: BusinessSource, patch: Record<string, unknown>) {
  assert.equal((await gateway.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_gateway',
    '055 business INSERT must actually execute under the restricted gateway role, not the fixture migrator');
  for (const name of Object.keys(patch)) assert.ok(source.columns.some((c) => c.name === name),
    '055 business INSERT must stay inside the existing column-level INSERT manifest');
  const record = { ...source.row, ...patch };
  const result = await gateway.query(
    `INSERT INTO model_router_saas.${identifier(source.table)} (${source.columns.map((c) => identifier(c.name)).join(', ')})
      VALUES (${source.columns.map((c, i) => `$${i + 1}::${c.sql_type}`).join(', ')})`,
    source.columns.map((c) => record[c.name]));
  assert.equal(result.rowCount, 1);
}

// SQL-only copies of test-owned metadata exercise all real triggers/FKs. The
// allowlist and catalog-derived columns exclude generated columns; no trigger
// is disabled and no historical/immutable row is updated or deleted.
async function copy(tx: SqlExecutor, table: Table, source: Record<string, unknown>, patch: Record<string, unknown>) {
  assert.ok(tables.includes(table));
  let columns = columnCache.get(table);
  if (!columns) {
    const result = await tx.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
        ORDER BY attnum`, [`model_router_saas.${table}`]);
    columns = result.rows.map((r) => r.attname);
    assert.ok(columns.length);
    columnCache.set(table, columns);
  }
  for (const key of [...Object.keys(source), ...Object.keys(patch)]) assert.ok(columns.includes(key));
  const keys = Object.keys(source);
  const result = await tx.query(
    `WITH candidate AS (
       SELECT jsonb_populate_record(NULL::model_router_saas.${identifier(table)}, to_jsonb(s) || $1::jsonb) AS value
         FROM model_router_saas.${identifier(table)} s
        WHERE ${keys.map((k, i) => `s.${identifier(k)} = $${i + 2}`).join(' AND ')}
     ) INSERT INTO model_router_saas.${identifier(table)} (${columns.map(identifier).join(', ')})
       SELECT ${columns.map((c) => `(value).${identifier(c)}`).join(', ')} FROM candidate`,
    [JSON.stringify(patch), ...keys.map((k) => source[k])]);
  assert.equal(result.rowCount, 1, '055 must copy exactly one explicitly scoped fixture row');
}

type Path = 'mapping' | 'grant' | 'price' | 'cost';
type Window = 'open' | 'future' | 'expiring';
interface Fixture {
  template: Template; overrides: Record<string, unknown>;
  business: Record<BusinessTable, BusinessSource>;
  requestId: string; attemptId: string; evidenceId: string;
  relationship: 'saas_tenant_provider_supply_profile_accounts' | 'saas_platform_provider_pool_grants';
  relationshipIdentity: Record<string, unknown>; expiresAt: string | null;
}

async function seed(migrator: SaasDatabase, template: Template, path: Path, window: Window): Promise<Fixture> {
  return transaction(migrator, async (tx) => {
    const business = {
      saas_requests: await readBusinessSource(tx, 'saas_requests', template.request_id, template.tenant_id),
      saas_attempts: await readBusinessSource(tx, 'saas_attempts', template.attempt_id, template.tenant_id),
      saas_prepared_request_evidence: await readBusinessSource(tx, 'saas_prepared_request_evidence', template.id, template.tenant_id),
    };
    const clock = await tx.query<{ effective: string; future: string; expires: string }>(
      `SELECT (clock_timestamp() - interval '1 hour')::text AS effective,
              (clock_timestamp() + interval '1 hour')::text AS future,
              (clock_timestamp() + interval '6 seconds')::text AS expires`);
    const now = clock.rows[0]!;
    const validity = { effective_at: window === 'future' ? now.future : now.effective,
      expires_at: window === 'expiring' ? now.expires : null };
    const label = randomUUID();
    const scope = { tenant_id: template.tenant_id };
    const project = { ...scope, project_id: template.project_id };
    const overrides: Record<string, unknown> = {};
    let relationship: Fixture['relationship'];
    let relationshipIdentity: Fixture['relationshipIdentity'];
    if (template.supply_mode === 'byok') {
      const account = `055-account-${label}`;
      const credential = `055-credential-${label}`;
      await copy(tx, 'saas_tenant_provider_accounts', { ...scope, id: template.account_id }, { id: account });
      await copy(tx, 'saas_tenant_provider_credentials', { ...scope, id: template.credential_id },
        { id: credential, account_id: account, current_version: null });
      await copy(tx, 'saas_tenant_provider_credential_versions',
        { ...scope, credential_id: template.credential_id, version: template.credential_version },
        { credential_id: credential, account_id: account });
      // The head FK is immediate, and the immutable version itself needs its
      // parent credential. Assemble only this new fixture inside the same
      // transaction: nullable head -> immutable version -> exact head CAS.
      // Existing 050/054/058 writer fences and triggers remain enabled.
      const head = await tx.query<{ current_version: number }>(
        `UPDATE saas_tenant_provider_credentials SET current_version = $3::integer
          WHERE tenant_id = $1::uuid AND id = $2::text AND account_id = $4::text
            AND current_version IS NULL RETURNING current_version`,
        [template.tenant_id, credential, template.credential_version, account]);
      assert.equal(head.rowCount, 1, '055 must install only the newly owned credential head after its version exists');
      assert.equal(head.rows[0]?.current_version, template.credential_version);
      relationship = 'saas_tenant_provider_supply_profile_accounts';
      relationshipIdentity = { ...scope, supply_profile_id: template.dispatch_profile_id, account_id: account };
      await copy(tx, relationship,
        { ...scope, supply_profile_id: template.dispatch_profile_id, account_id: template.account_id },
        { account_id: account, ...validity });
      Object.assign(overrides, { account_id: account, credential_id: credential });
    } else {
      const pool = `055-pool-${label}`;
      await copy(tx, 'saas_platform_provider_pools', { id: template.pool_id }, { id: pool });
      await copy(tx, 'saas_platform_provider_pool_members', { pool_id: template.pool_id, account_id: template.account_id },
        { pool_id: pool });
      relationship = 'saas_platform_provider_pool_grants';
      relationshipIdentity = { ...scope, supply_profile_id: template.dispatch_profile_id, pool_id: pool };
      await copy(tx, relationship, { ...scope, supply_profile_id: template.dispatch_profile_id, pool_id: template.pool_id },
        { pool_id: pool, ...(path === 'grant' ? validity : { effective_at: now.effective, expires_at: null }) });
      overrides.pool_id = pool;
      if (path === 'price' || path === 'cost') {
        const priceTable = path === 'price' ? 'saas_customer_price_versions' : 'saas_supplier_cost_versions';
        const oldVersion = path === 'price' ? template.customer_price_version : template.supplier_cost_version;
        const newVersionId = `055-${path}-${label}`;
        const next = await tx.query<{ version: string }>(`SELECT (COALESCE(max(version), 0) + 1)::text AS version FROM ${priceTable}`);
        await copy(tx, priceTable, { id: oldVersion }, { id: newVersionId, version: next.rows[0]!.version,
          idempotency_key: `055-${label}`, ...validity });
        const price = path === 'price' ? newVersionId : template.customer_price_version;
        const cost = path === 'cost' ? newVersionId : template.supplier_cost_version;
        const customerPolicy = `055-customer-${label}`;
        const providerPolicy = `055-provider-${label}`;
        const attestation = `055-attestation-${label}`;
        const route = `055-route-${label}`;
        await copy(tx, 'saas_customer_metering_policy_versions',
          { ...project, policy_id: template.customer_metering_policy_id, version: template.customer_metering_policy_version },
          { policy_id: customerPolicy, version: 1, customer_price_version: price });
        await copy(tx, 'saas_provider_metering_policy_versions',
          { ...project, policy_id: template.provider_metering_policy_id, version: template.provider_metering_policy_version },
          { policy_id: providerPolicy, version: 1, supplier_cost_version: cost });
        await copy(tx, 'saas_customer_metering_policy_heads', { ...project, policy_id: template.customer_metering_policy_id },
          { policy_id: customerPolicy, current_version: 1 });
        await copy(tx, 'saas_provider_metering_policy_heads', { ...project, policy_id: template.provider_metering_policy_id },
          { policy_id: providerPolicy, current_version: 1 });
        await copy(tx, 'saas_contract_test_attestations', { ...project, id: template.contract_attestation_id },
          { id: attestation, provider_policy_id: providerPolicy, provider_policy_version: 1 });
        await copy(tx, 'saas_route_config_versions',
          { ...project, route_id: template.route_config_id, version: template.route_config_version },
          { route_id: route, version: 1 });
        await copy(tx, 'saas_route_config_heads', { ...project, route_id: template.route_config_id },
          { route_id: route, current_version: 1 });
        await copy(tx, 'saas_route_config_commercial_authorities',
          { ...project, route_id: template.route_config_id, route_version: template.route_config_version },
          { route_id: route, route_version: 1, customer_policy_id: customerPolicy, customer_policy_version: 1,
            provider_policy_id: providerPolicy, provider_policy_version: 1, contract_attestation_id: attestation,
            customer_price_version: price, supplier_cost_version: cost });
        Object.assign(overrides, { route_config_id: route, route_config_version: 1, config_version: 1,
          customer_metering_policy_id: customerPolicy, customer_metering_policy_version: 1,
          provider_metering_policy_id: providerPolicy, provider_metering_policy_version: 1,
          contract_attestation_id: attestation, customer_price_version: price, supplier_cost_version: cost });
      }
    }
    return { template, business, overrides, relationship, relationshipIdentity,
      requestId: randomUUID(), attemptId: randomUUID(), evidenceId: randomUUID(),
      expiresAt: validity.expires_at };
  });
}

async function pending(gateway: SaasDatabase, fixture: Fixture) {
  const { template: e, overrides: o } = fixture;
  await transaction(gateway, async (tx) => {
    const { account_id, credential_id, pool_id, supplier_cost_version, ...requestOverrides } = o;
    await insertBusiness(tx, fixture.business.saas_requests, {
      ...requestOverrides, id: fixture.requestId, execution_state: 'pending', reconciliation_state: 'none',
      financial_status: e.supply_mode === 'byok' ? 'not_applicable' : 'pending', state_version: 1 });
    // saas_attempts.account_id is generated from the owner-specific column;
    // customer_price_version is a real attempt snapshot and must stay bound.
    // config_version mirrors the new route in request/evidence, not attempts.
    const { account_id: generatedAccount, config_version, ...attemptOverrides } = o;
    await insertBusiness(tx, fixture.business.saas_attempts, {
      ...attemptOverrides, ...(generatedAccount ? { tenant_account_id: generatedAccount } : {}),
      id: fixture.attemptId, request_id: fixture.requestId, dispatch_state: 'not_sent',
      result_state: 'pending', response_started: false, state_version: 1 });
    // UPDATE-only result fields/prepared_evidence_id use their NULL defaults;
    // inserting them explicitly, even as NULL, would require forbidden ACLs.
  });
}

async function insertEvidence(tx: SqlExecutor, fixture: Fixture) {
  const deadline = await tx.query<{ deadline: string }>("SELECT (clock_timestamp() + interval '1 minute')::text AS deadline");
  await insertBusiness(tx, fixture.business.saas_prepared_request_evidence, {
    ...fixture.overrides, id: fixture.evidenceId, request_id: fixture.requestId, attempt_id: fixture.attemptId,
    status: 'registered', claimed_at: null, claimed_attempt_id: null,
    dispatch_deadline: deadline.rows[0]!.deadline, expires_at: deadline.rows[0]!.deadline });
  // These DB-only rows deliberately remain unclaimed/unbound to dispatch; the
  // original HTTP suite, not these copies, proves signing/unsealing/transport.
}

async function writer(tx: SqlExecutor, fixture: Fixture) {
  const keys = Object.keys(fixture.relationshipIdentity);
  const result = await tx.query(
    `UPDATE ${fixture.relationship} SET updated_at = clock_timestamp()
      WHERE ${keys.map((key, i) => `${identifier(key)} = $${i + 1}`).join(' AND ')}`,
    keys.map((key) => fixture.relationshipIdentity[key]));
  assert.equal(result.rowCount, 1);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function pid(tx: SqlExecutor) {
  return (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}
async function waitForFence(db: SqlExecutor, waiter: number, holder: number, key: string, readerWaits: boolean) {
  const end = Date.now() + 3_000;
  do {
    const result = await db.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks w JOIN pg_locks h
        USING (locktype, database, classid, objid, objsubid)
        WHERE w.locktype = 'advisory' AND w.pid = $1 AND h.pid = $2
          AND NOT w.granted AND h.granted AND w.mode = $4 AND h.mode = $5 AND h.objsubid = 1
          AND h.classid = ((hashtextextended($3::text, 0) >> 32) & 4294967295)::oid
          AND h.objid = (hashtextextended($3::text, 0) & 4294967295)::oid) AS blocked`,
      [waiter, holder, key, readerWaits ? 'ShareLock' : 'ExclusiveLock', readerWaits ? 'ExclusiveLock' : 'ShareLock']);
    if (result.rows[0]?.blocked) return;
    await delay(10);
  } while (Date.now() < end);
  assert.fail('055 must observe both real backends waiting on the exact matching shared/exclusive tenant fence');
}
async function waitForExpiry(db: SqlExecutor, expiry: string) {
  const end = Date.now() + 10_000;
  do {
    if ((await db.query<{ expired: boolean }>('SELECT clock_timestamp() >= $1::timestamptz AS expired', [expiry])).rows[0]?.expired) return;
    await delay(10);
  } while (Date.now() < end);
  assert.fail('055 fixture must cross its real PostgreSQL expiry boundary');
}
async function noEvidence(db: SqlExecutor, fixture: Fixture) {
  const result = await db.query<{ count: string }>('SELECT count(id)::text AS count FROM saas_prepared_request_evidence WHERE id = $1::uuid', [fixture.evidenceId]);
  assert.equal(result.rows[0]?.count, '0');
}

test('055: real restricted-role prepared INSERT optional dates, matching writers and post-wait expiry', {
  skip: process.env[required] !== '1' && !configured.some(Boolean) ? `set ${required}=1 and all three managed E2E role URLs` : false,
  timeout: 120_000,
}, async (t) => {
  const urls = safeRoleUrls();
  const databases = urls.map((connectionString) => createSaasDatabase({ connectionString, max: 2 }));
  const [migrator, control, gateway] = databases as [SaasDatabase, SaasDatabase, SaasDatabase];
  try {
    await migrator.verifySchema();
    for (let i = 0; i < databases.length; i++) {
      const current = await databases[i]!.query<{ role: string; session: string; superuser: boolean; search_path: string; schemas: string[] }>(
        `SELECT current_user AS role, session_user AS session, r.rolsuper AS superuser,
          current_setting('search_path') AS search_path, current_schemas(true)::text[] AS schemas
          FROM pg_roles r WHERE r.rolname = current_user`);
      assert.deepEqual(current.rows[0], { role: roles[i]![1], session: roles[i]![1], superuser: false,
        search_path: 'model_router_saas', schemas: ['pg_catalog', 'model_router_saas'] });
    }
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await t.test('055 retains exact invoker/migrator source, trigger binding and zero application EXECUTE/API-key UPDATE', async () => {
      const sourceSql = PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION.sql;
      const tag = '$replacement_source$';
      const start = sourceSql.indexOf(tag) + tag.length;
      const expected = sourceSql.slice(start, sourceSql.indexOf(tag, start));
      const result = await migrator.query<{ source: string; definer: boolean; config: string[] | null; owner: string; binding: boolean }>(
        `SELECT p.prosrc AS source, p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner,
          EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND t.tgtype = 7 AND t.tgenabled = 'O'
            AND t.tgrelid = 'saas_prepared_request_evidence'::regclass AND t.tgnargs = 0
            AND t.tgname = 'saas_prepared_request_evidence_guard') AS binding
          FROM pg_proc p WHERE p.oid = 'saas_prepared_request_evidence_guard()'::regprocedure`);
      assert.deepEqual(result.rows[0], { source: expected, definer: false, config: null,
        owner: 'model_router_saas_migrator', binding: true });
      for (const db of [control, gateway]) {
        const acl = await db.query<{ executable: string; key_update: boolean }>(
          `SELECT (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'model_router_saas'::regnamespace
            AND has_function_privilege(current_user, oid, 'EXECUTE')) AS executable,
            has_any_column_privilege(current_user, 'saas_api_keys', 'UPDATE') AS key_update`);
        assert.equal(acl.rows[0]?.executable, '0');
        if (db === gateway) assert.equal(acl.rows[0]?.key_update, false);
        await assert.rejects(db.query('SELECT saas_prepared_request_evidence_guard()'), (error: unknown) => {
          assert.ok(error !== null && typeof error === 'object' && 'code' in error);
          assert.equal(error.code, '42501');
          return true;
        });
      }
    });
    const evidenceTemplates = await templates(migrator);
    for (const template of evidenceTemplates) {
      const path = template.supply_mode === 'byok' ? 'mapping' : 'grant';
      await t.test(`${path}: NULL expiry accepts the real opposite-branch-absent INSERT and blocks the actual exclusive writer`, async () => {
        const fixture = await seed(migrator, template, path, 'open');
        await pending(gateway, fixture);
        const inserted = deferred<number>();
        const release = deferred();
        const writerPid = deferred<number>();
        let writing: Promise<unknown> | undefined;
        const reading = transaction(gateway, async (tx) => {
          await insertEvidence(tx, fixture);
          inserted.resolve(await pid(tx));
          await release.promise;
        });
        void reading.catch(() => {});
        try {
          const holder = await Promise.race([inserted.promise, reading.then(() => { throw new Error('055 reader ended before its fence checkpoint'); })]);
          writing = transaction(control, async (tx) => { writerPid.resolve(await pid(tx)); await writer(tx, fixture); });
          void writing.catch(() => {});
          const waiter = await Promise.race([writerPid.promise, writing.then(() => { throw new Error('055 writer ended before its backend checkpoint'); })]);
          await waitForFence(migrator, waiter, holder, saasAdvisoryKey.tenant(template.tenant_id), false);
        } finally {
          release.resolve();
          await Promise.all([reading, ...(writing ? [writing] : [])]);
        }
        const row = await gateway.query<{ mode: string; status: string; pool: string | null; mapping: number | null; price: string | null; cost: string | null }>(
          `SELECT supply_mode AS mode, status, pool_id AS pool, profile_account_authz_version::int AS mapping,
            customer_price_version AS price, supplier_cost_version AS cost FROM saas_prepared_request_evidence WHERE id = $1`, [fixture.evidenceId]);
        assert.equal(row.rows[0]?.mode, template.supply_mode);
        assert.equal(row.rows[0]?.status, 'registered');
        if (path === 'mapping') {
          assert.equal(row.rows[0]?.pool, null); assert.equal(row.rows[0]?.price, null); assert.equal(row.rows[0]?.cost, null);
        } else {
          assert.equal(row.rows[0]?.mapping, null); assert.ok(row.rows[0]?.price); assert.ok(row.rows[0]?.cost);
          const dates = await gateway.query<{ price_expiry: string | null; cost_expiry: string | null }>(
            `SELECT p.expires_at::text AS price_expiry, c.expires_at::text AS cost_expiry
               FROM saas_customer_price_versions p CROSS JOIN saas_supplier_cost_versions c
              WHERE p.id = $1 AND c.id = $2`, [template.customer_price_version, template.supplier_cost_version]);
          assert.deepEqual(dates.rows[0], { price_expiry: null, cost_expiry: null });
        }
      });
      await t.test(`${path}: a future effective date is rejected by the real admission guard, never made into evidence`, async () => {
        const fixture = await seed(migrator, template, path, 'future');
        await assert.rejects(pending(gateway, fixture), denied(path === 'mapping'
          ? 'SaaS attempt BYOK profile-account mapping is stale or mismatched'
          : 'SaaS attempt platform pool grant is stale or mismatched', 'saas_attempts_guard_dispatch_authority'));
        await noEvidence(gateway, fixture);
      });
      await t.test(`${path}: expiry crossed while the prepared reader waits on a real writer rejects at its fresh locked time`, async () => {
        const fixture = await seed(migrator, template, path, 'expiring');
        await pending(gateway, fixture);
        assert.ok(fixture.expiresAt);
        const held = deferred<number>(); const release = deferred(); const readerPid = deferred<number>();
        const writing = transaction(control, async (tx) => { await writer(tx, fixture); held.resolve(await pid(tx)); await release.promise; });
        void writing.catch(() => {});
        let reading: Promise<unknown> | undefined;
        try {
          const holder = await Promise.race([held.promise, writing.then(() => { throw new Error('055 writer ended before its fence checkpoint'); })]);
          reading = transaction(gateway, async (tx) => {
            const clock = await tx.query<{ valid: boolean }>('SELECT clock_timestamp() < $1::timestamptz AS valid', [fixture.expiresAt]);
            assert.equal(clock.rows[0]?.valid, true, 'the real reader must enter before expiry, not merely observe an already expired fixture');
            readerPid.resolve(await pid(tx));
            await insertEvidence(tx, fixture);
          });
          void reading.catch(() => {});
          const waiter = await Promise.race([readerPid.promise, reading.then(() => { throw new Error('055 reader ended before its backend checkpoint'); })]);
          await waitForFence(migrator, waiter, holder, saasAdvisoryKey.tenant(template.tenant_id), true);
          await waitForExpiry(migrator, fixture.expiresAt);
        } finally { release.resolve(); await writing; }
        assert.ok(reading);
        await assert.rejects(reading, denied(path === 'mapping'
          ? 'Prepared-request evidence profile mapping is outside its validity window'
          : 'Prepared-request evidence pool grant is outside its validity window', 'saas_prepared_request_evidence_guard'));
        await noEvidence(gateway, fixture);
      });
    }
    const platform = evidenceTemplates.find((e) => e.supply_mode === 'platform')!;
    for (const path of ['price', 'cost'] as const) {
      await t.test(`${path}: future immutable commercial version fails the real route binding guard`, async () => {
        await assert.rejects(seed(migrator, platform, path, 'future'), denied(path === 'price'
          ? 'Customer price version is not effective at authority binding'
          : 'Supplier cost version is not effective at authority binding', 'saas_route_config_commercial_authority_guard'));
      });
      await t.test(`${path}: nullable immutable version dates still reject after admission when the actual prepared INSERT crosses expiry`, async () => {
        const fixture = await seed(migrator, platform, path, 'expiring');
        await pending(gateway, fixture);
        assert.ok(fixture.expiresAt);
        await waitForExpiry(migrator, fixture.expiresAt);
        await assert.rejects(transaction(gateway, (tx) => insertEvidence(tx, fixture)), denied(path === 'price'
          ? 'Prepared-request evidence customer price is expired'
          : 'Prepared-request evidence provider cost is expired', 'saas_prepared_request_evidence_guard'));
        await noEvidence(gateway, fixture);
      });
    }
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  } finally { await Promise.all(databases.map((db) => db.close())); }
});
