import assert, { AssertionError } from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../../src/saas/db/types.js';
import {
  CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS, CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS,
  CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION, CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS,
} from '../../../../src/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.js';
import { PostgresProviderSupplyRepository } from '../../../../src/saas/supply/repository.js';

// Real PostgreSQL CP invalidation/trigger proof only. Leased jobs are legal,
// test-owned initial fixture rows, not a claim of an actual worker claim or
// worker completion CAS. That separate proof requires a fourth exact worker
// role URL and the real worker store/service gate; this root cannot replace it.
// No migration/role/bootstrap/DDL is run here. The owner applies 057/058 and
// reconciles the reviewed roles before invoking this future candidate root.
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
    assert.ok(value, `${name} is required for the 058 CP invalidation root`);
    let url: URL; let user: string; let database: string;
    try { url = new URL(value); user = decodeURIComponent(url.username); database = decodeURIComponent(url.pathname.slice(1)); }
    catch { throw new Error(`${name} must be a valid PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.equal(user, role, `${name} must use its exact managed role`);
    assert.ok(url.search === '' && url.hash === '', `${name} cannot contain connection overrides/fragments`);
    const host = url.hostname.toLowerCase(); const port = Number(url.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && Boolean(url.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must use designated CI or an explicit nondefault disposable exact-loopback target`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all 058 actors must use the same disposable database');
    return value;
  });
}
async function bounded<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
    assert.equal((await tx.query<{ value: string }>("SELECT current_setting('transaction_isolation') AS value")).rows[0]?.value,
      'read committed');
    return work(tx);
  });
}
function sqlError(cause: unknown): { code: string; constraint?: string } | undefined {
  const seen = new Set<object>();
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)) {
      return { code: cause.code,
        ...('constraint' in cause && typeof cause.constraint === 'string' ? { constraint: cause.constraint } : {}) };
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return undefined;
}
function sqlState(code: string, constraint?: string) {
  return (cause: unknown) => {
    const actual = sqlError(cause);
    assert.ok(actual, `expected SQLSTATE ${code}; server details redacted`);
    assert.equal(actual.code, code, 'server details redacted');
    if (constraint) assert.ok(actual.constraint === constraint.slice(0, 63), 'the exact original job CHECK must reject');
    return true;
  };
}
function safeFailure(cause: unknown): Error {
  if (cause instanceof AssertionError) return cause;
  const state = sqlError(cause);
  return new Error(state ? `058 SQL operation failed (SQLSTATE ${state.code}); details redacted`
    : '058 operation failed; details redacted');
}
async function proof(t: TestContext, name: string, work: () => Promise<void>) {
  return t.test(name, async () => { try { await work(); } catch (cause) { throw safeFailure(cause); } });
}

type JobStatus = 'queued' | 'leased' | 'verified' | 'failed' | 'cancelled';
interface Fixture {
  tenants: [string, string]; accounts: [string, string]; credential: string;
  sibling: string; other: string; provider: string; product: string; jobIds: string[];
}
interface JobRow {
  id: string; tenant_id: string; account_id: string; credential_id: string; credential_version: number;
  provider_id: string; product_id: string; credential_type: string; allowed_models: string[];
  target_model: string; target_endpoint: string; capability_version: number; idempotency_key: string;
  status: JobStatus; attempt_count: number; available_at: string; lease_until: string | null;
  lease_generation: string; last_error_code: string | null; completed_at: string | null;
  created_at: string; updated_at: string;
}
const jobColumns = `id::text, tenant_id::text, account_id, credential_id, credential_version,
  provider_id, product_id, credential_type, allowed_models, target_model, target_endpoint, capability_version,
  idempotency_key, status, attempt_count, available_at::text, lease_until::text, lease_generation::text,
  last_error_code, completed_at::text, created_at::text, updated_at::text`;
async function jobs(tx: SqlExecutor, f: Fixture): Promise<JobRow[]> {
  return (await tx.query<JobRow>(`SELECT ${jobColumns} FROM saas_tenant_provider_credential_validation_jobs
    WHERE tenant_id = ANY($1::uuid[]) AND id = ANY($2::uuid[]) ORDER BY id`, [f.tenants, f.jobIds])).rows;
}
async function parents(tx: SqlExecutor, f: Fixture) {
  const accounts = (await tx.query(`SELECT tenant_id::text, id, status, authz_version::text,
    disabled_at::text, revoked_at::text, updated_at::text FROM saas_tenant_provider_accounts
    WHERE tenant_id = ANY($1::uuid[]) AND id = ANY($2::text[]) ORDER BY tenant_id, id`, [f.tenants, f.accounts])).rows;
  const credentials = (await tx.query(`SELECT tenant_id::text, id, account_id, status, current_version,
    authz_version::text, disabled_at::text, revoked_at::text, updated_at::text FROM saas_tenant_provider_credentials
    WHERE tenant_id = ANY($1::uuid[]) AND id = ANY($2::text[]) ORDER BY tenant_id, id`,
  [f.tenants, [f.credential, f.sibling, f.other]])).rows;
  return { accounts, credentials };
}
async function insertJob(tx: SqlExecutor, f: Fixture, tenant: string, account: string, credential: string,
  version: number, status: JobStatus, patch: { lease?: boolean; completed?: boolean } = {}) {
  const id = randomUUID();
  const terminal = ['verified', 'failed', 'cancelled'].includes(status);
  const result = await tx.query(`INSERT INTO saas_tenant_provider_credential_validation_jobs
    (id, tenant_id, account_id, credential_id, credential_version, provider_id, product_id, credential_type,
     allowed_models, target_model, target_endpoint, capability_version, idempotency_key, status,
     attempt_count, available_at, lease_until, lease_generation, last_error_code, completed_at, created_at, updated_at)
    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'api-key', ARRAY['058-model'], '058-model', 'chat/completions', 1,
      $8, $9, 4, clock_timestamp() - interval '4 minutes',
      CASE WHEN $10::boolean THEN clock_timestamp() + interval '30 minutes' ELSE NULL END, 11,
      CASE WHEN $11::boolean THEN '058_fixture_history' ELSE NULL END,
      CASE WHEN $11::boolean THEN clock_timestamp() - interval '1 minute' ELSE NULL END,
      clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '2 minutes')`,
  [id, tenant, account, credential, version, f.provider, f.product,
    createHash('sha256').update(id).digest('hex'), status, patch.lease ?? status === 'leased', patch.completed ?? terminal]);
  assert.equal(result.rowCount, 1);
  return id;
}
async function seedFixture(migrator: SaasDatabase): Promise<Fixture> {
  const f: Fixture = { tenants: [randomUUID(), randomUUID()], accounts: [`058-account-${randomUUID()}`, `058-account-${randomUUID()}`],
    credential: `058-credential-${randomUUID()}`, sibling: `058-sibling-${randomUUID()}`, other: `058-other-${randomUUID()}`,
    provider: `058-provider-${randomUUID()}`, product: `058-product-${randomUUID()}`, jobIds: [] };
  await bounded(migrator, async (tx) => {
    for (const tenant of f.tenants) assert.equal((await tx.query(
      'INSERT INTO saas_tenants (id, name, slug) VALUES ($1::uuid, $2, $2)', [tenant, `058-${tenant}`])).rowCount, 1);
    assert.equal((await tx.query('INSERT INTO saas_provider_products (provider_id, product_id, display_name) VALUES ($1,$2,$3)',
      [f.provider, f.product, '058 isolated SQL fixture'])).rowCount, 1);
    const rights = `058-rights-${randomUUID()}`;
    assert.equal((await tx.query(`INSERT INTO saas_provider_rights
      (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
       model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
      VALUES ($1,1,$2,$3,'api-key','byok','058-test','inference',ARRAY['058-model'],ARRAY['/v1/chat/completions'],
       clock_timestamp() - interval '1 minute',$4,'active',$4,$5)`,
    [rights, f.provider, f.product, '058 SQL fixture only; no live provider attestation', 'a'.repeat(64)])).rowCount, 1);
    for (const [tenant, account] of [[f.tenants[0], f.accounts[0]], [f.tenants[0], f.accounts[1]], [f.tenants[1], f.accounts[0]]] as const) {
      assert.equal((await tx.query(`INSERT INTO saas_tenant_provider_accounts
        (tenant_id,id,display_name,provider_id,product_id,credential_type,region,purpose,rights_id,rights_version,status,validation_state)
        VALUES ($1::uuid,$2,'058 fixture',$3,$4,'api-key','058-test','inference',$5,1,'active','verified')`,
      [tenant, account, f.provider, f.product, rights])).rowCount, 1);
    }
    for (const [tenant, account, credential, states] of [
      [f.tenants[0], f.accounts[0], f.credential, ['queued', 'leased', 'verified', 'failed', 'cancelled']],
      [f.tenants[0], f.accounts[0], f.sibling, ['queued']],
      [f.tenants[0], f.accounts[1], f.other, ['leased']],
      [f.tenants[1], f.accounts[0], f.credential, ['queued', 'leased']],
    ] as const) {
      assert.equal((await tx.query(`INSERT INTO saas_tenant_provider_credentials
        (tenant_id,id,account_id,provider_id,product_id,credential_type,status,validation_state)
        VALUES ($1::uuid,$2,$3,$4,$5,'api-key','active','verified')`,
      [tenant, credential, account, f.provider, f.product])).rowCount, 1);
      for (let i = 0; i < states.length; i += 1) {
        const active = i === states.length - 1;
        assert.equal((await tx.query(`INSERT INTO saas_tenant_provider_credential_versions
          (tenant_id,account_id,credential_id,version,schema_version,context_version,algorithm,kms_purpose,kms_key_id,
           wrapping_revision,wrapped_dek,nonce,ciphertext,auth_tag,status,retired_at)
          VALUES ($1::uuid,$2,$3,$4,1,1,'aes-256-gcm','058-sql-fixture','058-synthetic-kms',1,
           'fixture_wrapped_dek','fixture_nonce','fixture_ciphertext','fixture_auth_tag',$5,
           CASE WHEN $6::boolean THEN NULL ELSE clock_timestamp() - interval '1 minute' END)`,
        [tenant, account, credential, i + 1, active ? 'active' : 'retired', active])).rowCount, 1);
      }
      // Initial legal fixture head is established BEFORE any jobs exist.
      // No migrator ever performs the CP operation being proved by a case.
      assert.equal((await tx.query('UPDATE saas_tenant_provider_credentials SET current_version=$3 WHERE tenant_id=$1::uuid AND id=$2',
        [tenant, credential, states.length])).rowCount, 1);
      for (let i = 0; i < states.length; i += 1) f.jobIds.push(await insertJob(tx, f, tenant, account, credential, i + 1, states[i]!));
    }
  });
  return f;
}

async function lifecycle(tx: SqlExecutor, f: Fixture, target: 'account' | 'credential', status: 'active' | 'disabled' | 'revoked') {
  // Actual restricted CP DML/CAS, the same lifecycle columns/predicate as the
  // production repository and the existing lease PG root, never owner DML.
  assert.equal((await tx.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, roles[1][1]);
  const table = target === 'account' ? 'saas_tenant_provider_accounts' : 'saas_tenant_provider_credentials';
  const id = target === 'account' ? f.accounts[0] : f.credential;
  const version = (await tx.query<{ version: string }>(`SELECT authz_version::text AS version FROM ${table}
    WHERE tenant_id=$1::uuid AND id=$2`, [f.tenants[0], id])).rows[0]?.version;
  assert.ok(version);
  const result = await tx.query(`UPDATE ${table} SET status=$3,
    disabled_at=CASE WHEN $3='disabled' THEN clock_timestamp() ELSE NULL END,
    revoked_at=CASE WHEN $3='revoked' THEN clock_timestamp() ELSE NULL END,
    updated_at=clock_timestamp(), authz_version=authz_version+1
    WHERE tenant_id=$1::uuid AND id=$2 AND authz_version=$4::bigint RETURNING id`, [f.tenants[0], id, status, version]);
  assert.equal(result.rowCount, 1, 'the exact CP lifecycle CAS must really update its parent');
}
async function assertCancelled(tx: SqlExecutor, f: Fixture, before: JobRow[], target: 'account' | 'credential', started: string) {
  const after = await jobs(tx, f);
  assert.equal(after.length, before.length);
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) {
    const old = before[i]!; const row = after[i]!;
    const matches = old.tenant_id === f.tenants[0]
      && (target === 'account' ? old.account_id === f.accounts[0] : old.credential_id === f.credential)
      && ['queued', 'leased'].includes(old.status);
    if (!matches) { assert.deepEqual(row, old, 'terminal/nonmatching tenant/account/credential history must remain byte-identical'); continue; }
    changed += 1;
    assert.equal(row.status, 'cancelled'); assert.equal(row.lease_until, null);
    assert.equal(row.lease_generation, (BigInt(old.lease_generation) + 1n).toString());
    assert.equal(row.last_error_code, target === 'account' ? 'account_changed' : 'credential_changed');
    assert.ok(row.completed_at !== null && row.updated_at !== old.updated_at);
    assert.deepEqual({ ...row, status: old.status, lease_until: old.lease_until, lease_generation: old.lease_generation,
      last_error_code: old.last_error_code, completed_at: old.completed_at, updated_at: old.updated_at }, old,
    'authority identity, available_at and cumulative attempt_count cannot change');
    assert.equal((await tx.query<{ valid: boolean }>(`SELECT completed_at >= $2::timestamptz AND updated_at >= $2::timestamptz
      AND completed_at <= clock_timestamp() AND updated_at <= clock_timestamp() AS valid
      FROM saas_tenant_provider_credential_validation_jobs WHERE id=$1::uuid`, [row.id, started])).rows[0]?.valid, true);
  }
  assert.equal(changed, target === 'account' ? 3 : 2);
}
async function catalog(tx: SqlExecutor) {
  const result = await tx.query<{ value: unknown }>(`SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='model_router_saas'),
    'tables',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas'),
    'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas'),
    'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname='model_router_saas'),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas'),
    'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas')) AS value`);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.value;
}

test('058 real restricted CP invalidation, immutable guards and unchanged ACL/catalog', async (t) => {
  if (!configured.some(Boolean) && process.env[required] !== '1') {
    t.skip(`set all three exact gateway E2E role URLs, or ${required}=1 to require them`); return;
  }
  const urls = safeRoleUrls();
  const databases = urls.map((connectionString) => createSaasDatabase({ connectionString, max: 3, connectionTimeoutMillis: 5_000 }));
  const [migrator, control, gateway] = databases;
  assert.ok(migrator && control && gateway);
  try {
    for (let i = 0; i < databases.length; i += 1) await bounded(databases[i]!, async (tx) => {
      const row = (await tx.query<{ current_role: string; session_role: string; safe: boolean; path: boolean }>(
        `SELECT current_user AS current_role, session_user AS session_role,
          NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AS safe,
          current_setting('search_path')='model_router_saas' AND current_schemas(true)=ARRAY['pg_catalog','model_router_saas']::name[] AS path
         FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert.ok(row); assert.equal(row.current_role, roles[i]![1]); assert.equal(row.session_role, roles[i]![1]);
      assert.equal(row.safe, true); assert.equal(row.path, true);
    });
    const migration = CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION;
    const applied = (await migrator.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM saas_schema_migrations WHERE version=$1', [58])).rows;
    assert.equal(applied.length, 1, 'external migration owner must apply/register the exact 058 candidate first');
    assert.equal(applied[0]?.name, migration.name);
    assert.equal(applied[0]?.checksum, createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex'));
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    const beforeCatalog = await catalog(migrator);

    await proof(t, 'only two exact 035 wrappers are trusted; bodies/bindings/helpers/constraints stay intact', async () => {
      for (const { signature, source } of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS) {
        const wrapper = CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS.some((name) => name === signature);
        const row = (await migrator.query<{ source: string; owner: string; definer: boolean; config: boolean }>(
          `SELECT p.prosrc AS source,r.rolname AS owner,p.prosecdef AS definer,
            p.proconfig IS NOT DISTINCT FROM $2::text[] AS config FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
           WHERE p.oid=to_regprocedure('model_router_saas.' || $1)`,
        [signature, wrapper ? ['search_path=pg_catalog, model_router_saas, pg_temp'] : null])).rows[0];
        assert.ok(row);
        assert.equal(row.source, source, '035 body must remain byte-identical');
        assert.equal(row.owner, roles[0][1]); assert.equal(row.definer, wrapper); assert.equal(row.config, true);
      }
      for (const [table, name, signature, type, columns] of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS) {
        const row = (await migrator.query<{ valid: boolean; columns: string[] }>(`SELECT
          t.tgfoid=to_regprocedure('model_router_saas.' || $3) AND t.tgtype=$4 AND NOT t.tgisinternal
          AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgargs=decode('','hex') AND t.tgqual IS NULL
          AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
          AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AS valid,
          to_jsonb(ARRAY(SELECT a.attname::text FROM unnest(t.tgattr) WITH ORDINALITY x(n,pos)
            JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.n ORDER BY x.pos)) AS columns
          FROM pg_trigger t WHERE t.tgrelid=to_regclass('model_router_saas.' || $1) AND t.tgname=$2`,
        [table, name.slice(0, 63), signature, type])).rows[0];
        assert.ok(row); assert.equal(row.valid, true); assert.deepEqual(row.columns, columns);
      }
      assert.equal((await migrator.query<{ bad: number }>(`SELECT count(*)::int AS bad FROM pg_constraint
        WHERE conrelid='model_router_saas.saas_tenant_provider_credential_validation_jobs'::regclass AND NOT convalidated`)).rows[0]?.bad, 0);
    });

    for (const target of ['account', 'credential'] as const) for (const status of ['disabled', 'revoked'] as const) {
      await proof(t, `real CP ${target} ${status} cancels only live matching jobs; repeats/cascade never increment twice`, async () => {
        const f = await seedFixture(migrator); const before = await jobs(control, f);
        await bounded(control, async (tx) => {
          const started = (await tx.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
          await lifecycle(tx, f, target, status);
          await assertCancelled(tx, f, before, target, started);
          const once = await jobs(tx, f);
          await lifecycle(tx, f, target, status);
          assert.deepEqual(await jobs(tx, f), once, 'same status cannot re-cancel or bump generation');
          if (target === 'account') {
            await lifecycle(tx, f, 'credential', status);
            assert.deepEqual(await jobs(tx, f), once, 'account then credential cascade cannot double-increment generation');
          }
        });
      });
    }
    await proof(t, 'zero-match credential invalidation and unchanged active lifecycle still execute without CP job UPDATE', async () => {
      const f = await seedFixture(migrator); const before = await jobs(control, f);
      await bounded(control, async (tx) => {
        await lifecycle(tx, f, 'account', 'active'); await lifecycle(tx, f, 'credential', 'active');
        assert.deepEqual(await jobs(tx, f), before);
        await lifecycle(tx, f, 'credential', 'revoked');
        const once = await jobs(tx, f);
        // The original credential wrapper executes UPDATE even when its WHERE matches zero rows.
        await lifecycle(tx, f, 'credential', 'revoked');
        assert.deepEqual(await jobs(tx, f), once);
      });
    });
    await proof(t, 'CP account+credential invalidation and all job effects roll back together', async () => {
      const f = await seedFixture(migrator); const before = { jobs: await jobs(control, f), parents: await parents(control, f) };
      const rollback = new Error('058 intentional rollback sentinel');
      await assert.rejects(bounded(control, async (tx) => {
        const started = (await tx.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
        await lifecycle(tx, f, 'account', 'revoked'); await lifecycle(tx, f, 'credential', 'revoked');
        await assertCancelled(tx, f, before.jobs, 'account', started);
        throw rollback;
      }), (cause: unknown) => cause === rollback);
      assert.deepEqual({ jobs: await jobs(control, f), parents: await parents(control, f) }, before);
    });

    await proof(t, 'CP/GW cannot directly execute any wrapper/helper or update/delete jobs', async () => {
      const f = await seedFixture(migrator);
      for (const db of [control, gateway]) {
        for (const { signature } of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS) await assert.rejects(
          bounded(db, (tx) => tx.query(`SELECT model_router_saas.${signature}`)), sqlState('42501'));
        await assert.rejects(bounded(db, (tx) => tx.query(`UPDATE saas_tenant_provider_credential_validation_jobs
          SET status='cancelled', lease_until=NULL, completed_at=clock_timestamp() WHERE id=$1::uuid`, [f.jobIds[0]])), sqlState('42501'));
        await assert.rejects(bounded(db, (tx) => tx.query('DELETE FROM saas_tenant_provider_credential_validation_jobs WHERE id=$1::uuid',
          [f.jobIds[0]])), sqlState('42501'));
        const acl = (await db.query<{ execute: number; update: boolean; key_update: boolean }>(`SELECT
          (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='model_router_saas' AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS execute,
          has_any_column_privilege(current_user,'model_router_saas.saas_tenant_provider_credential_validation_jobs','UPDATE') AS update,
          has_any_column_privilege(current_user,'model_router_saas.saas_api_keys','UPDATE') AS key_update`)).rows[0];
        assert.ok(acl); assert.equal(acl.execute, 0); assert.equal(acl.update, false);
        if (db === gateway) assert.equal(acl.key_update, false);
      }
    });
    await proof(t, 'original job identity/no-delete helpers and lease/completion CHECKs still reject owner fixture attacks', async () => {
      const f = await seedFixture(migrator); const before = await jobs(control, f);
      // Owner-only NEGATIVE fixture attacks always roll back: never privileged
      // business writes used to make CP cancellation/rotation appear successful.
      for (const statement of [
        "UPDATE saas_tenant_provider_credential_validation_jobs SET allowed_models=ARRAY['changed'] WHERE id=$1::uuid",
        'DELETE FROM saas_tenant_provider_credential_validation_jobs WHERE id=$1::uuid',
      ]) await assert.rejects(bounded(migrator, async (tx) => {
        await tx.query(statement, [f.jobIds[0]]); throw new Error('058 immutable guard unexpectedly accepted');
      }), sqlState('55006'));
      for (const [patch, constraint] of [
        [{ lease: false }, 'saas_tenant_provider_credential_validation_jobs_lease_shape'],
        [{ completed: true }, 'saas_tenant_provider_credential_validation_jobs_completion_shape'],
      ] as const) await assert.rejects(bounded(migrator, async (tx) => {
        await insertJob(tx, f, f.tenants[0], f.accounts[0], f.credential, 1,
          'lease' in patch ? 'leased' : 'queued', patch);
        throw new Error('058 original CHECK unexpectedly accepted');
      }), sqlState('23514', constraint));
      assert.deepEqual(await jobs(control, f), before);
    });

    await proof(t, 'actual CP repository rotation must advance version CAS and cancel only target credential jobs', async () => {
      const f = await seedFixture(migrator); const before = await jobs(control, f);
      // Strict SUCCESS gate, intentionally not converted to an expected 42501.
      // CP already has exact current_version/expires_at UPDATE on both tenant
      // and platform credentials; the worker deliberately does not. This real
      // repository path must succeed without any new rotation/job UPDATE grant.
      // 058 changes only the two invalidation wrappers' trusted metadata.
      await bounded(control, async (tx) => {
        const started = (await tx.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
        const result = await new PostgresProviderSupplyRepository(control, tx, true).appendCredentialVersion({
          credential: { ownerKind: 'tenant', tenantId: f.tenants[0], accountId: f.accounts[0], credentialId: f.credential, version: 6 },
          providerId: f.provider, productId: f.product, expectedCurrentVersion: 5,
          kmsPurpose: '058-sql-fixture', wrappingRevision: 1, createdAt: new Date().toISOString(), expiresAt: null,
          envelope: { schemaVersion: 1, contextVersion: 1, algorithm: 'aes-256-gcm', kmsKeyId: '058-synthetic-kms',
            wrappedDek: 'fixture_wrapped_dek', nonce: 'fixture_nonce', ciphertext: 'fixture_ciphertext', authTag: 'fixture_auth_tag' },
        });
        assert.equal(result.credential.currentVersion, 6); assert.equal(result.version.version, 6);
        await assertCancelled(tx, f, before, 'credential', started);
        assert.equal((await tx.query<{ version: number }>(`SELECT current_version AS version FROM saas_tenant_provider_credentials
          WHERE tenant_id=$1::uuid AND id=$2`, [f.tenants[0], f.credential])).rows[0]?.version, 6);
      });
    });
    assert.ok(JSON.stringify(await catalog(migrator)) === JSON.stringify(beforeCatalog), '058 business/negative proofs cannot mutate catalog or ACLs');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  } catch (cause) { throw safeFailure(cause); }
  finally { await Promise.all(databases.map((db) => db.close())); }
});
