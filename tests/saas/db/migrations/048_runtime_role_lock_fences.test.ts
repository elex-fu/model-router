import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool as PgPool, type PoolClient } from 'pg';
import { evaluateProviderEligibilityInTransaction } from '../../../../src/saas/catalog/service.js';
import { runSaasMigrations } from '../../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/048_runtime_role_lock_fences.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../../src/saas/db/types.js';

const migration = RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION;
const databaseUrl = process.env.MODEL_ROUTER_TEST_DATABASE_URL;

class ScopedPgClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values === undefined ? undefined : [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class ScopedPgPool implements SaasDatabasePool {
  constructor(
    private readonly pool: PgPool,
    private readonly schema: string,
  ) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const client = await this.connect();
    try {
      return await client.query<Row>(sql, values);
    } finally {
      client.release();
    }
  }

  async connect(): Promise<SaasDatabaseClient> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      return new ScopedPgClient(client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async end(): Promise<void> {}
}

function triggerFunction(name: string): string {
  const match = migration.sql.match(
    new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\(\\) RETURNS trigger[\\s\\S]+?\\$\\$;`, 'i'),
  );
  assert.ok(match, `Expected migration SQL to define ${name}`);
  return match[0];
}

test('migration 048 is registered and stays forward-only', () => {
  assert.equal(migration.version, 48);
  assert.equal(migration.name, 'runtime_role_lock_fences');
  assert.equal(
    SAAS_MIGRATIONS.find(({ version }) => version === 48),
    migration,
  );
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|TRIGGER|FUNCTION)\b/i);
  assert.doesNotMatch(migration.sql, /\bGRANT\s+UPDATE\b/i);
});

test('catalog append and qualification triggers share the provider-product advisory fence', () => {
  const appendFence = triggerFunction('saas_catalog_lock_product_for_version_insert');
  const aliasFence = triggerFunction('saas_public_model_lock_for_version_insert');
  const rightsFence = triggerFunction('saas_provider_supply_require_byok_rights');
  const capabilityFence = triggerFunction('saas_provider_supply_require_byok_capability');

  assert.match(appendFence, /pg_advisory_xact_lock\(/i);
  assert.match(appendFence, /saas_catalog_product:/i);
  assert.doesNotMatch(appendFence, /FOR\s+UPDATE/i);
  assert.match(aliasFence, /pg_advisory_xact_lock\(/i);
  assert.match(aliasFence, /saas_public_model:/i);
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_public_model_versions_runtime_advisory_fence\s+BEFORE INSERT ON saas_public_model_versions/i,
  );
  for (const validator of [rightsFence, capabilityFence]) {
    assert.match(validator, /pg_advisory_xact_lock_shared\(/i);
    assert.match(validator, /saas_catalog_product:/i);
    assert.match(validator, /saas_provider_products/i);
    assert.doesNotMatch(validator, /FOR\s+SHARE/i);
  }
  assert.match(rightsFence, /rights\.status = 'active'/i);
  assert.match(rightsFence, /latest\.effective_at <= qualification_time/i);
  assert.match(capabilityFence, /capability\.validation_state = 'verified'/i);
  assert.match(capabilityFence, /capability\.support_level IN \('supported', 'limited'\)/i);
});

test('mutable profile, pool, and plan heads have matching exclusive update fences', () => {
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_supply_profiles_runtime_advisory_fence\s+BEFORE UPDATE ON saas_supply_profiles[\s\S]+EXECUTE FUNCTION saas_runtime_supply_profile_update_fence\(\)/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_platform_provider_pools_runtime_advisory_fence\s+BEFORE UPDATE ON saas_platform_provider_pools[\s\S]+EXECUTE FUNCTION saas_runtime_platform_pool_update_fence\(\)/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_service_plans_runtime_advisory_fence\s+BEFORE UPDATE ON saas_service_plans[\s\S]+EXECUTE FUNCTION saas_runtime_service_plan_update_fence\(\)/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_service_plan_versions_runtime_advisory_fence\s+BEFORE UPDATE ON saas_service_plan_versions[\s\S]+EXECUTE FUNCTION saas_runtime_service_plan_version_update_fence\(\)/i,
  );
  assert.match(migration.sql, /saas_supply_profile:/i);
  assert.match(migration.sql, /saas_platform_pool:/i);
  assert.match(migration.sql, /saas_service_plan:/i);
});

test('migration 048 advisory catalog fence blocks a concurrent history append in PostgreSQL', {
  skip: databaseUrl
    ? false
    : 'MODEL_ROUTER_TEST_DATABASE_URL is not configured; PostgreSQL advisory-fence race is skipped',
}, async () => {
  if (!databaseUrl) return;
  const migrations = SAAS_MIGRATIONS.filter(({ version }) => version <= 34);
  const schema = `saas_runtime_fence_${randomUUID().replaceAll('-', '')}`;
  const pool = new PgPool({ connectionString: databaseUrl, max: 6 });
  let schemaCreated = false;
  let readerOpen = false;
  let writerOpen = false;
  let writerQuery: Promise<void> | undefined;
  let readerClient: PoolClient | undefined;
  let writerClient: PoolClient | undefined;
  let observerClient: PoolClient | undefined;

  try {
    const admin = await pool.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
    } finally {
      admin.release();
    }

    const scopedPool = new ScopedPgPool(pool, schema);
    await runSaasMigrations(scopedPool, migrations);
    readerClient = await pool.connect();
    writerClient = await pool.connect();
    observerClient = await pool.connect();
    await readerClient.query(`SET search_path TO "${schema}"`);
    await writerClient.query(`SET search_path TO "${schema}"`);
    await observerClient.query(`SET search_path TO "${schema}"`);
    await readerClient.query(migration.sql);

    await readerClient.query(
      `INSERT INTO saas_provider_products (provider_id, product_id, display_name)
       VALUES ('fence-provider', 'fence-product', 'Fence product')`,
    );
    await readerClient.query(
      `INSERT INTO saas_provider_capabilities
         (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
          evidence_version, discovery_source, evidence_ref, evidence_sha256)
       VALUES ('fence-provider', 'fence-product', 'fence-model', 'chat.completions', 'openai', 1,
               'supported', 'verified', 'v1', 'manual', 'initial-capability', repeat('a', 64))`,
    );
    await readerClient.query(
      `INSERT INTO saas_provider_rights
         (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
          model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
       VALUES ('fence-rights', 1, 'fence-provider', 'fence-product', 'api-key', 'platform', 'global',
               'inference', ARRAY['fence-model'], ARRAY['chat.completions'], now() - interval '1 day',
               'approval-v1', 'active', 'initial-rights', repeat('b', 64))`,
    );

    await readerClient.query('BEGIN');
    readerOpen = true;
    const readerPid = Number(
      (await readerClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid,
    );
    const decision = await evaluateProviderEligibilityInTransaction(
      new ScopedPgClient(readerClient),
      {
        providerId: 'fence-provider',
        productId: 'fence-product',
        model: 'fence-model',
        endpoint: 'chat.completions',
        credentialType: 'api-key',
        supplyMode: 'platform',
        region: 'global',
        purpose: 'inference',
      },
      new Date(),
    );
    assert.equal(decision.decision, 'allow');

    await writerClient.query('BEGIN');
    writerOpen = true;
    const writerPid = Number(
      (await writerClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid,
    );
    writerQuery = writerClient
      .query(
        `INSERT INTO saas_provider_capabilities
           (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
            evidence_version, discovery_source, evidence_ref, evidence_sha256)
         VALUES ('fence-provider', 'fence-product', 'parallel-model', 'chat.completions', 'openai', 1,
                 'supported', 'verified', 'v1', 'manual', 'parallel-capability', repeat('c', 64))`,
      )
      .then(() => undefined);
    const writerOutcome = writerQuery.then(
      () => ({ kind: 'completed' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );

    let sawAdvisoryWait = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await observerClient.query<{
        readonly blockers: number[];
        readonly wait_event_type: string | null;
        readonly query: string;
      }>(
        `SELECT pg_catalog.pg_blocking_pids(activity.pid) AS blockers,
                activity.wait_event_type, activity.query
           FROM pg_catalog.pg_stat_activity AS activity
          WHERE activity.pid = $1`,
        [writerPid],
      );
      const state = waiting.rows[0];
      if (state?.wait_event_type === 'Lock' && state.blockers.includes(readerPid)) {
        const locks = await observerClient.query<{ readonly advisory_wait: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_catalog.pg_locks
              WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
           ) AS advisory_wait`,
          [writerPid],
        );
        assert.equal(locks.rows[0]?.advisory_wait, true);
        assert.match(state.query, /INSERT INTO saas_provider_capabilities/i);
        sawAdvisoryWait = true;
        break;
      }
      const outcome = await Promise.race([writerOutcome, delay(15).then(() => undefined)]);
      if (outcome) {
        if (outcome.kind === 'failed') throw outcome.error;
        break;
      }
    }
    assert.equal(sawAdvisoryWait, true, 'version insert must wait on the eligibility transaction fence');

    await readerClient.query('COMMIT');
    readerOpen = false;
    await writerQuery;
    await writerClient.query('COMMIT');
    writerOpen = false;
  } finally {
    if (readerOpen && readerClient) await readerClient.query('ROLLBACK').catch(() => undefined);
    if (writerQuery) await writerQuery.catch(() => undefined);
    if (writerOpen && writerClient) await writerClient.query('ROLLBACK').catch(() => undefined);
    readerClient?.release();
    writerClient?.release();
    observerClient?.release();
    if (schemaCreated) {
      const admin = await pool.connect();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        admin.release();
      }
    }
    await pool.end();
  }
});
