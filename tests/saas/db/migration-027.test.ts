import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/026_prepared_request_evidence_platform_pool_fence.js';
import { PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/027_prepared_request_evidence_claim_pool_fence.js';

const realPostgresUrl = process.env.SAAS_TEST_DATABASE_URL;

test('migration 027 is the ordered claim-side pool fence', () => {
  const migration = PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION;

  assert.equal(migration.version, 27);
  assert.equal(migration.name, 'prepared_request_evidence_claim_pool_fence');
  assert.equal(SAAS_MIGRATIONS[26], migration);
});

test('migration 027 keeps claim revalidation fail-closed and lock-compatible', () => {
  const sql = PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION.sql;

  assert.match(sql, /CREATE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool\(\)/i);
  assert.match(sql, /NEW\.account_owner_kind IS DISTINCT FROM 'platform'/i);
  assert.match(sql, /NEW\.dispatch_authority_state IS DISTINCT FROM 'bound'/i);
  assert.match(
    sql,
    /SELECT provider_id, product_id, pool_id, pool_authz_version[\s\S]+FROM saas_prepared_request_evidence[\s\S]+FOR SHARE/i,
  );
  assert.match(sql, /evidence_record\.pool_id IS DISTINCT FROM NEW\.pool_id/i);
  assert.match(sql, /evidence_record\.pool_authz_version IS DISTINCT FROM NEW\.pool_authz_version/i);
  assert.match(
    sql,
    /SELECT provider_id, product_id, status, validation_state, authz_version[\s\S]+FROM saas_platform_provider_pools[\s\S]+FOR SHARE/i,
  );
  assert.match(sql, /pool_record\.status IS DISTINCT FROM 'active'/i);
  assert.match(sql, /pool_record\.validation_state IS DISTINCT FROM 'verified'/i);
  assert.match(sql, /pool_record\.authz_version IS DISTINCT FROM NEW\.pool_authz_version/i);
  assert.match(sql, /pool_record\.provider_id IS DISTINCT FROM NEW\.provider_id/i);
  assert.match(sql, /pool_record\.product_id IS DISTINCT FROM NEW\.product_id/i);
  assert.match(
    sql,
    /BEFORE INSERT OR UPDATE OF prepared_evidence_id, dispatch_state, dispatch_authority_state,[\s\S]+pool_authz_version ON saas_attempts/i,
  );
  assert.match(sql, /FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool\(\)/i);
  assert.match(sql, /ERRCODE = '23514'/i);
  assert.doesNotMatch(sql, /DROP TRIGGER|DROP FUNCTION|ALTER TABLE/i);
});

interface Fixture {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly evidenceId: string;
  readonly poolId: string;
}

function uuid(suffix: string): string {
  return `00000000-0000-0000-0000-00000000${suffix}`;
}

function fixture(suffix: string): Fixture {
  return {
    tenantId: uuid(`${suffix}01`),
    attemptId: uuid(`${suffix}02`),
    evidenceId: uuid(`${suffix}03`),
    poolId: `pool-${suffix}`,
  };
}

async function seedAttempt(client: PoolClient, ids: Fixture): Promise<void> {
  await client.query(
    `INSERT INTO saas_platform_provider_pools
       (id, provider_id, product_id, status, validation_state, authz_version)
     VALUES ($1, 'provider-a', 'product-a', 'active', 'verified', 1)`,
    [ids.poolId],
  );
  await client.query(
    `INSERT INTO saas_attempts
       (tenant_id, id, provider_id, product_id, account_owner_kind,
        dispatch_authority_state, dispatch_state, pool_id, pool_authz_version)
     VALUES ($1, $2, 'provider-a', 'product-a', 'platform',
             'bound', 'not_sent', $3, 1)`,
    [ids.tenantId, ids.attemptId, ids.poolId],
  );
}

async function registerEvidence(client: PoolClient, ids: Fixture): Promise<void> {
  await client.query(
    `INSERT INTO saas_prepared_request_evidence
       (id, tenant_id, attempt_id, account_owner_kind, provider_id, product_id,
        pool_id, pool_authz_version, status)
     VALUES ($1, $2, $3, 'platform', 'provider-a', 'product-a', $4, 1, 'registered')`,
    [ids.evidenceId, ids.tenantId, ids.attemptId, ids.poolId],
  );
}

async function bindEvidence(client: PoolClient, ids: Fixture): Promise<void> {
  await client.query(
    `UPDATE saas_attempts
        SET prepared_evidence_id = $3
      WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantId, ids.attemptId, ids.evidenceId],
  );
}

async function claimEvidence(client: PoolClient, ids: Fixture): Promise<void> {
  await client.query(
    `UPDATE saas_prepared_request_evidence
        SET status = 'claimed', claimed_attempt_id = $3
      WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantId, ids.evidenceId, ids.attemptId],
  );
}

async function dispatchAttempt(client: PoolClient, ids: Fixture): Promise<void> {
  await client.query(
    `UPDATE saas_attempts
        SET dispatch_state = 'dispatching'
      WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantId, ids.attemptId],
  );
}

function isPoolFenceViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === '23514';
}

async function withMinimalPostgresSchema(work: (client: PoolClient) => Promise<void>): Promise<void> {
  if (!realPostgresUrl) return;

  const pool = new PgPool({ connectionString: realPostgresUrl, max: 1 });
  const schema = `saas_migration_027_${process.pid}_${Date.now()}`;
  let schemaCreated = false;
  let client: PoolClient | undefined;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE saas_platform_provider_pools (
        id text PRIMARY KEY,
        provider_id text NOT NULL,
        product_id text NOT NULL,
        status text NOT NULL,
        validation_state text NOT NULL,
        authz_version bigint NOT NULL
      );
      CREATE TABLE saas_attempts (
        tenant_id uuid NOT NULL,
        id uuid NOT NULL,
        provider_id text NOT NULL,
        product_id text NOT NULL,
        account_owner_kind text NOT NULL,
        dispatch_authority_state text NOT NULL,
        dispatch_state text NOT NULL,
        pool_id text,
        pool_authz_version bigint,
        prepared_evidence_id uuid,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE saas_prepared_request_evidence (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        attempt_id uuid NOT NULL,
        account_owner_kind text NOT NULL,
        provider_id text NOT NULL,
        product_id text NOT NULL,
        pool_id text,
        pool_authz_version bigint,
        status text NOT NULL,
        claimed_attempt_id uuid
      );
    `);
    await client.query(PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION.sql);
    await client.query(PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION.sql);
    await work(client);
  } finally {
    client?.release();
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

test('PostgreSQL pool fence rejects inactive and stale pools on register and claim, and accepts the normal path', {
  skip: !realPostgresUrl && 'SAAS_TEST_DATABASE_URL is not configured; SQL contract tests still run',
}, async () => {
  await withMinimalPostgresSchema(async (client) => {
    const inactiveRegister = fixture('a0');
    await seedAttempt(client, inactiveRegister);
    await client.query("UPDATE saas_platform_provider_pools SET status = 'disabled' WHERE id = $1", [
      inactiveRegister.poolId,
    ]);
    await assert.rejects(registerEvidence(client, inactiveRegister), isPoolFenceViolation);

    const staleRegister = fixture('a1');
    await seedAttempt(client, staleRegister);
    await client.query('UPDATE saas_platform_provider_pools SET authz_version = 2 WHERE id = $1', [
      staleRegister.poolId,
    ]);
    await assert.rejects(registerEvidence(client, staleRegister), isPoolFenceViolation);

    const inactiveClaim = fixture('a2');
    await seedAttempt(client, inactiveClaim);
    await registerEvidence(client, inactiveClaim);
    await client.query("UPDATE saas_platform_provider_pools SET status = 'disabled' WHERE id = $1", [
      inactiveClaim.poolId,
    ]);
    await assert.rejects(bindEvidence(client, inactiveClaim), isPoolFenceViolation);

    const staleClaim = fixture('a3');
    await seedAttempt(client, staleClaim);
    await registerEvidence(client, staleClaim);
    await client.query('UPDATE saas_platform_provider_pools SET authz_version = 2 WHERE id = $1', [staleClaim.poolId]);
    await assert.rejects(bindEvidence(client, staleClaim), isPoolFenceViolation);

    const staleDispatch = fixture('a4');
    await seedAttempt(client, staleDispatch);
    await registerEvidence(client, staleDispatch);
    await bindEvidence(client, staleDispatch);
    await claimEvidence(client, staleDispatch);
    await client.query('UPDATE saas_platform_provider_pools SET authz_version = 2 WHERE id = $1', [
      staleDispatch.poolId,
    ]);
    await assert.rejects(dispatchAttempt(client, staleDispatch), isPoolFenceViolation);

    const normal = fixture('a5');
    await seedAttempt(client, normal);
    await registerEvidence(client, normal);
    await bindEvidence(client, normal);
    await claimEvidence(client, normal);
    await dispatchAttempt(client, normal);
    const result = await client.query<{ status: string }>(
      'SELECT status FROM saas_prepared_request_evidence WHERE id = $1',
      [normal.evidenceId],
    );
    assert.deepEqual(result.rows, [{ status: 'claimed' }]);
  });
});
