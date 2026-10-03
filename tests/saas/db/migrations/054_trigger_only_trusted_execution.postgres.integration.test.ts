import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import { saasAdvisoryKey } from '../../../../src/saas/db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../../../src/saas/db/types.js';
import { PLATFORM_WALLET_LEDGER_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/011_platform_wallet_ledger.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';

const requiredFlag = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configuredUrls = roles.map(([name]) => process.env[name]?.trim());
const anyConfigured = configuredUrls.some(Boolean);

// Same fail-closed disposable target contract as FIN/prelock. No URL logging,
// role switching, grants, trigger bypass or fixture cleanup of immutable rows.
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], index) => {
    const value = configuredUrls[index];
    assert.ok(value, `${name} is required for the 054 PostgreSQL gate`);
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`${name} must be a valid PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), `${name} must be PostgreSQL`);
    assert.equal(decodeURIComponent(parsed.username), role, `${name} must use its exact managed role`);
    assert.equal(parsed.search, '', `${name} must not contain connection overrides`);
    assert.equal(parsed.hash, '', `${name} must not contain a fragment`);
    const hostname = parsed.hostname.toLowerCase();
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local,
      `${name} must use designated CI postgres:5432/model_router_saas_ci or a disposable model_router_saas_ci/model_router_test_* exact loopback target on an explicit nondefault port`);
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity;
    assert.equal(identity, target, 'all 054 roles must use the same disposable target');
    return value;
  });
}

async function transaction<T>(db: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '10s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    return work(tx);
  });
}

function sqlState(code: string, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  };
}

function historicalBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE FUNCTION ${name}(`);
  const bodyStart = source.indexOf('AS $$', start);
  const end = source.indexOf('\n$$;', bodyStart);
  assert.ok(start >= 0 && bodyStart > start && end > bodyStart);
  return source.slice(bodyStart + 'AS $$'.length, end + 1);
}

async function seed(migrator: SaasDatabase) {
  const fixture = { tenantId: randomUUID(), projectId: randomUUID(), walletId: randomUUID(), label: randomUUID() };
  await transaction(migrator, async (tx) => {
    await tx.query("INSERT INTO saas_tenants (id, name, slug) VALUES ($1, '054 gate', $2)",
      [fixture.tenantId, `trigger-054-${fixture.label}`]);
    await tx.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug, inference_policy_status)
       VALUES ($1, $2, '054 gate', $3, 'active')`, [fixture.tenantId, fixture.projectId, `trigger-054-${fixture.label}`]);
    await tx.query(
      `INSERT INTO saas_project_inference_policy_versions (tenant_id, project_id, version, status)
       VALUES ($1, $2, 2, 'disabled')`, [fixture.tenantId, fixture.projectId]);
    await tx.query("INSERT INTO saas_wallets (id, tenant_id, currency) VALUES ($1, $2, 'USD')",
      [fixture.walletId, fixture.tenantId]);
  });
  return fixture;
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function insertLedger(tx: SqlExecutor, fixture: Fixture, id: string, debit: number | null, credit: number | null) {
  await tx.query(
    `INSERT INTO saas_ledger_transactions
       (id, tenant_id, currency, idempotency_namespace, business_key, source_type,
        amount_minor_units, metadata_ref, source_order_ref)
     VALUES ($1, $2, 'USD', 'trigger-054.funding', $3, 'wallet_funding', 100, $3, $3)`,
    [id, fixture.tenantId, `trigger-054-${id}`]);
  for (const [direction, amount] of [['debit', debit], ['credit', credit]] as const) {
    if (amount === null) continue;
    await tx.query(
      `INSERT INTO saas_ledger_entries
         (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref, wallet_id)
       VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7, $8)`,
      [randomUUID(), id, fixture.tenantId, direction, amount,
        direction === 'debit' ? 'funding_source' : 'wallet',
        direction === 'debit' ? `trigger-054-${id}` : fixture.walletId,
        direction === 'debit' ? null : fixture.walletId]);
  }
}

async function ledgerCounts(db: SaasDatabase, id: string) {
  const result = await db.query<{ transactions: string; entries: string }>(
    `SELECT (SELECT count(*)::text FROM saas_ledger_transactions WHERE id = $1) AS transactions,
            (SELECT count(*)::text FROM saas_ledger_entries WHERE transaction_id = $1) AS entries`, [id]);
  return result.rows[0];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForProjectFence(observer: SqlExecutor, waiter: number, holder: number, key: string) {
  const deadline = Date.now() + 3_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks w JOIN pg_locks h
          USING (locktype, database, classid, objid, objsubid)
        WHERE w.locktype = 'advisory' AND w.pid = $1 AND h.pid = $2
          AND NOT w.granted AND h.granted AND w.mode = 'ExclusiveLock' AND h.mode = 'ShareLock'
          AND h.objsubid = 1
          AND h.classid = ((hashtextextended($3::text, 0) >> 32) & 4294967295)::oid
          AND h.objid = (hashtextextended($3::text, 0) & 4294967295)::oid) AS blocked`, [waiter, holder, key]);
    if (result.rows[0]?.blocked) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('actual writer did not wait for the exact shared project authorization fence');
}

test('054: restricted-role trigger-only execution, real fences, deferred balance and immutable ledger', {
  skip: process.env[requiredFlag] !== '1' && !anyConfigured ? `set ${requiredFlag}=1 and all three managed E2E role URLs` : false,
  timeout: 90_000,
}, async (t) => {
  const urls = safeRoleUrls();
  const databases = urls.map((connectionString) => createSaasDatabase({ connectionString, max: 2 }));
  const [migrator, control, gateway] = databases as [SaasDatabase, SaasDatabase, SaasDatabase];
  try {
    for (const [index, db] of databases.entries()) {
      const identity = await db.query<{
        principal: string; session: string; superuser: boolean; database: string;
        schema: string; path: string; schemas: string[]; version: string;
      }>(`SELECT current_user AS principal, session_user AS session, r.rolsuper AS superuser,
                 current_database() AS database, current_schema() AS schema,
                 current_setting('search_path') AS path, current_schemas(true)::text[] AS schemas,
                 current_setting('server_version_num') AS version
            FROM pg_roles r WHERE r.rolname = current_user`);
      assert.equal(identity.rows[0]?.principal, roles[index]![1]);
      assert.equal(identity.rows[0]?.session, roles[index]![1]);
      assert.equal(identity.rows[0]?.superuser, false);
      assert.equal(identity.rows[0]?.database, decodeURIComponent(new URL(urls[0]!).pathname.slice(1)));
      assert.equal(identity.rows[0]?.schema, 'model_router_saas');
      assert.equal(identity.rows[0]?.path, 'model_router_saas');
      assert.deepEqual(identity.rows[0]?.schemas, ['pg_catalog', 'model_router_saas']);
      assert.ok([15, 18].includes(Math.floor(Number(identity.rows[0]?.version) / 10_000)));
    }
    await migrator.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');

    await t.test('live bodies stay historical; only three fixed-path wrappers are definer and directly callable by neither app', async () => {
      const expected = [
        ['saas_prepared_evidence_authorization_writer_fence()', true, PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql],
        ['saas_prepared_evidence_writer_require_value(jsonb,text)', false, PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql],
        ['saas_prepared_evidence_writer_lock_layer(text[])', false, PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql],
        ['saas_prepared_evidence_writer_composite_key(jsonb,text,text[])', false, PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql],
        ['saas_billing_assert_ledger_transaction_balanced(uuid)', false, PLATFORM_WALLET_LEDGER_SAAS_MIGRATION.sql],
        ['saas_billing_check_ledger_transaction()', true, PLATFORM_WALLET_LEDGER_SAAS_MIGRATION.sql],
        ['saas_billing_check_ledger_entry_transaction()', true, PLATFORM_WALLET_LEDGER_SAAS_MIGRATION.sql],
        ['saas_billing_reject_ledger_mutation()', false, PLATFORM_WALLET_LEDGER_SAAS_MIGRATION.sql],
      ] as const;
      for (const [signature, definer, source] of expected) {
        const row = await migrator.query<{ source: string; definer: boolean; config: string[] | null; owner: string }>(
          `SELECT p.prosrc AS source, p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner
             FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = to_regprocedure($1)`,
          [`model_router_saas.${signature}`]);
        assert.deepEqual(row.rows[0], {
          source: historicalBody(source, signature.slice(0, signature.indexOf('('))), definer,
          config: definer ? ['search_path=pg_catalog, model_router_saas, pg_temp'] : null,
          owner: 'model_router_saas_migrator',
        });
      }
      for (const db of [control, gateway]) {
        const count = await db.query<{ callable: string; api_key_update: boolean; schema_create: boolean; trigger_create: boolean }>(
          `SELECT (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'model_router_saas'::regnamespace
                     AND has_function_privilege(current_user, oid, 'EXECUTE')) AS callable,
                  has_any_column_privilege(current_user, 'saas_api_keys', 'UPDATE') AS api_key_update,
                  has_schema_privilege(current_user, 'model_router_saas', 'CREATE') AS schema_create,
                  has_table_privilege(current_user, 'saas_api_keys', 'TRIGGER') AS trigger_create`);
        assert.equal(count.rows[0]?.callable, '0');
        assert.equal(count.rows[0]?.schema_create, false);
        assert.equal(count.rows[0]?.trigger_create, false);
        if (db === gateway) assert.equal(count.rows[0]?.api_key_update, false);
        for (const call of [
          'saas_prepared_evidence_authorization_writer_fence()',
          "saas_prepared_evidence_writer_require_value('{}'::jsonb, 'id')",
          'saas_prepared_evidence_writer_lock_layer(ARRAY[]::text[])',
          "saas_prepared_evidence_writer_composite_key('{}'::jsonb, 'test', ARRAY['id'])",
          `saas_billing_assert_ledger_transaction_balanced('${randomUUID()}'::uuid)`,
          'saas_billing_check_ledger_transaction()', 'saas_billing_check_ledger_entry_transaction()',
        ]) {
          await assert.rejects(db.query(`SELECT model_router_saas.${call}`), sqlState('42501'));
        }
      }
    });

    for (const [name, db] of [['control_plane', control], ['gateway', gateway]] as const) {
      await t.test(`${name}: both deferred wrappers commit a balanced pair but roll back malformed postings`, async () => {
        const fixture = await seed(migrator);
        const valid = randomUUID();
        await transaction(db, (tx) => insertLedger(tx, fixture, valid, 100, 100));
        assert.deepEqual(await ledgerCounts(migrator, valid), { transactions: '1', entries: '2' });
        for (const [debit, credit] of [[null, null], [100, null], [100, 99], [99, 99]] as const) {
          const invalid = randomUUID();
          await assert.rejects(transaction(db, (tx) => insertLedger(tx, fixture, invalid, debit, credit)),
            sqlState('23514', /Posted ledger transaction is not balanced/));
          assert.deepEqual(await ledgerCounts(migrator, invalid), { transactions: '0', entries: '0' });
        }
        // No transaction INSERT event here: only the entry wrapper can reject
        // this attempt to unbalance an already posted immutable transaction.
        await assert.rejects(transaction(db, async (tx) => {
          await tx.query(
            `INSERT INTO saas_ledger_entries
               (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref)
             VALUES ($1, $2, $3, 'USD', 'debit', 1, 'funding_source', 'trigger-054-invalid-extra')`,
            [randomUUID(), valid, fixture.tenantId]);
        }), sqlState('23514', /Posted ledger transaction is not balanced/));
        assert.deepEqual(await ledgerCounts(migrator, valid), { transactions: '1', entries: '2' });
        await assert.rejects(db.query('UPDATE saas_ledger_transactions SET amount_minor_units = 1 WHERE id = $1', [valid]), sqlState('42501'));
        await assert.rejects(db.query('DELETE FROM saas_ledger_entries WHERE transaction_id = $1', [valid]), sqlState('42501'));
        await assert.rejects(migrator.query('UPDATE saas_ledger_transactions SET amount_minor_units = 1 WHERE id = $1', [valid]),
          sqlState('55000', /Posted ledger records are immutable/));
        await assert.rejects(migrator.query('DELETE FROM saas_ledger_entries WHERE transaction_id = $1', [valid]),
          sqlState('55000', /Posted ledger records are immutable/));
        assert.deepEqual(await ledgerCounts(migrator, valid), { transactions: '1', entries: '2' });
      });
    }

    await t.test('real control-plane policy writer blocks on the matching shared fence and commits a fresh disabled head', async () => {
      const fixture = await seed(migrator);
      const key = saasAdvisoryKey.project(fixture.tenantId, fixture.projectId);
      const held = deferred();
      const release = deferred();
      const started = deferred();
      let readerPid = 0;
      let writerPid = 0;
      const reader = transaction(gateway, async (tx) => {
        readerPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [key]);
        const prior = await tx.query<{ status: string }>(
          'SELECT inference_policy_status AS status FROM saas_projects WHERE tenant_id = $1 AND id = $2',
          [fixture.tenantId, fixture.projectId]);
        assert.equal(prior.rows[0]?.status, 'active');
        held.resolve();
        await release.promise;
      });
      void reader.catch(() => held.resolve());
      let writer: Promise<unknown> | undefined;
      try {
        await held.promise;
        writer = transaction(control, async (tx) => {
          writerPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          started.resolve();
          const updated = await tx.query(
            `UPDATE saas_projects SET inference_policy_version = 2, inference_policy_status = 'disabled',
                    updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [fixture.tenantId, fixture.projectId]);
          assert.equal(updated.rowCount, 1);
        });
        void writer.catch(() => started.resolve());
        await started.promise;
        await waitForProjectFence(migrator, writerPid, readerPid, key);
        release.resolve();
        await Promise.all([reader, writer]);
        const fresh = await gateway.query<{ version: string; status: string }>(
          `SELECT inference_policy_version::text AS version, inference_policy_status AS status
             FROM saas_projects WHERE tenant_id = $1 AND id = $2`, [fixture.tenantId, fixture.projectId]);
        assert.deepEqual(fresh.rows[0], { version: '2', status: 'disabled' });
      } finally {
        release.resolve();
        await Promise.allSettled([reader, ...(writer ? [writer] : [])]);
      }
    });
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  } finally {
    await Promise.all(databases.map((db) => db.close()));
  }
});
