import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { createSaasDatabase } from '../../../src/saas/db/database.js';
import { runSaasMigrations, verifySaasMigrations } from '../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';
import {
  type CredentialValidationLease,
  PostgresCredentialValidationWorkerStore,
} from '../../../src/saas/supply/credential-validation-worker.js';

const configuredTestDatabaseUrl = process.env.MODEL_ROUTER_TEST_DATABASE_URL?.trim();

class ScopedClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values === undefined ? undefined : [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class ScopedPool implements SaasDatabasePool {
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
      const scope = await client.query<{ current_schema: string; schemas: string[] }>(
        'SELECT pg_catalog.current_schema() AS current_schema, pg_catalog.current_schemas(false)::text[] AS schemas',
      );
      assert.equal(scope.rows[0]?.current_schema, this.schema);
      assert.deepEqual(scope.rows[0]?.schemas, [this.schema]);
      return new ScopedClient(client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async end(): Promise<void> {
    // The test owns the pool so it can drop its schema before disconnecting.
  }
}

function validateExplicitTestUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MODEL_ROUTER_TEST_DATABASE_URL must be a valid dedicated PostgreSQL test URL');
  }
  const port = parsed.port || parsed.searchParams.get('port');
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    (!parsed.hostname && !parsed.searchParams.get('host')) ||
    !port ||
    !/^\d+$/.test(port) ||
    Number(port) === 5432 ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'MODEL_ROUTER_TEST_DATABASE_URL must use an explicit non-5432 port and a dedicated PostgreSQL test database',
    );
  }
  return value;
}

function migrationsThrough035(): SaasMigration[] {
  const migrations = SAAS_MIGRATIONS.filter(({ version }) => version <= 35);
  assert.deepEqual(
    migrations.map(({ version }) => version),
    Array.from({ length: 35 }, (_, index) => index + 1),
    'the isolated validation test requires the registered migration history through 035',
  );
  return migrations;
}

interface Fixture {
  readonly tenantId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly jobId: string;
  readonly rightsId: string;
}

async function insertFixture(
  database: ReturnType<typeof createSaasDatabase>,
  providerId: string,
  productId: string,
  label: string,
): Promise<Fixture> {
  const tenantId = randomUUID();
  const accountId = `validation-account-${label}-${randomUUID()}`;
  const credentialId = `validation-credential-${label}-${randomUUID()}`;
  const rightsId = `validation-rights-${label}-${randomUUID()}`;
  const now = new Date(Date.now() - 60_000).toISOString();

  await database.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1::uuid, $2, $3)`, [
    tenantId,
    `Validation ${label}`,
    `validation-${label}-${tenantId}`,
  ]);
  await database.query(
    `INSERT INTO saas_provider_products (provider_id, product_id, display_name)
     VALUES ($1, $2, $3) ON CONFLICT (provider_id, product_id) DO NOTHING`,
    [providerId, productId, 'Credential validation test product'],
  );
  await database.query(
    `INSERT INTO saas_provider_capabilities (
       provider_id, product_id, model, endpoint, protocol, version, support_level,
       validation_state, evidence_version, discovery_source, evidence_ref, evidence_sha256
     ) VALUES ($1, $2, 'test-model', 'chat-completions', 'openai-compatible', 1, 'supported',
       'verified', 'validation-test-v1', 'manual', $3, $4)
     ON CONFLICT (provider_id, product_id, model, endpoint, version) DO NOTHING`,
    [providerId, productId, `capability-${label}`, 'b'.repeat(64)],
  );
  await database.query(
    `INSERT INTO saas_provider_rights (
       rights_id, version, provider_id, product_id, credential_type, supply_mode,
       region, purpose, model_scope, endpoint_scope, effective_at, approval_ref,
       status, evidence_ref, evidence_sha256
     ) VALUES ($1, 1, $2, $3, 'api-key', 'byok', 'test-region', 'inference',
       ARRAY['test-model']::text[], ARRAY['chat-completions']::text[], $4::timestamptz,
       $5, 'active', $6, $7)`,
    [rightsId, providerId, productId, now, `approval-${label}`, `evidence-${label}`, 'a'.repeat(64)],
  );
  await database.query(
    `INSERT INTO saas_tenant_provider_accounts (
       tenant_id, id, display_name, provider_id, product_id, credential_type,
       region, purpose, rights_id, rights_version
     ) VALUES ($1::uuid, $2, $3, $4, $5, 'api-key', 'test-region', 'inference', $6, 1)`,
    [tenantId, accountId, `Validation ${label}`, providerId, productId, rightsId],
  );
  await database.query(
    `INSERT INTO saas_tenant_provider_account_capabilities (
       tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version
     ) VALUES ($1::uuid, $2, $3, $4, 'test-model', 'chat-completions', 1)`,
    [tenantId, accountId, providerId, productId],
  );
  await database.query(
    `INSERT INTO saas_tenant_provider_credentials (
       tenant_id, id, account_id, provider_id, product_id, credential_type
     ) VALUES ($1::uuid, $2, $3, $4, $5, 'api-key')`,
    [tenantId, credentialId, accountId, providerId, productId],
  );
  await database.query(
    `INSERT INTO saas_tenant_provider_credential_versions (
       tenant_id, account_id, credential_id, version, schema_version, context_version,
       algorithm, kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag
     ) VALUES ($1::uuid, $2, $3, 1, 1, 1, 'aes-256-gcm', 'inference', 'kms/test',
       'wrapped-test-only', 'nonce-test-only', 'ciphertext-test-only', 'tag-test-only')`,
    [tenantId, accountId, credentialId],
  );
  await database.query(
    `UPDATE saas_tenant_provider_credentials SET current_version = 1
      WHERE tenant_id = $1::uuid AND id = $2`,
    [tenantId, credentialId],
  );
  const jobs = await database.query<{ id: string }>(
    `INSERT INTO saas_tenant_provider_credential_validation_jobs (
       tenant_id, account_id, credential_id, credential_version,
       provider_id, product_id, credential_type, allowed_models,
       target_model, target_endpoint, capability_version, idempotency_key
     ) VALUES ($1::uuid, $2, $3, 1, $4, $5, 'api-key', ARRAY['test-model']::text[],
       'test-model', 'chat-completions', 1, $6)
     RETURNING id`,
    [tenantId, accountId, credentialId, providerId, productId, createHash('sha256').update(randomUUID()).digest('hex')],
  );
  const jobId = jobs.rows[0]?.id;
  assert.ok(jobId);
  return { tenantId, accountId, credentialId, jobId, rightsId };
}

const successfulResult = {
  state: 'verified' as const,
  adapterId: 'test-fixed-adapter',
  httpStatus: 200,
  durationMs: 1,
};

test('PostgreSQL worker claims once, reclaims expired leases with a fence, rejects stale completion, and records only health state', {
  skip: configuredTestDatabaseUrl
    ? false
    : 'MODEL_ROUTER_TEST_DATABASE_URL is not configured; the isolated PostgreSQL worker test is skipped without opening a connection',
}, async () => {
  if (!configuredTestDatabaseUrl) return;
  const connectionString = validateExplicitTestUrl(configuredTestDatabaseUrl);
  const schema = `saas_validation_worker_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^saas_validation_worker_[a-f0-9]{32}$/);
  const pool = new PgPool({
    connectionString,
    max: 6,
    application_name: 'model-router-credential-validation-worker-test',
  });
  let schemaCreated = false;
  let database: ReturnType<typeof createSaasDatabase> | undefined;

  try {
    const connection = await pool.connect();
    try {
      const version = await connection.query<{ server_version_num: string }>(
        `SELECT pg_catalog.current_setting('server_version_num') AS server_version_num`,
      );
      assert.ok(Number(version.rows[0]?.server_version_num) >= 150_000, 'test database must be PostgreSQL 15+');
      await connection.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
    } finally {
      connection.release();
    }

    const scopedPool = new ScopedPool(pool, schema);
    database = createSaasDatabase({ connectionString, pool: scopedPool });
    const migrations = migrationsThrough035();
    await runSaasMigrations(scopedPool, migrations);
    await verifySaasMigrations(scopedPool, migrations);
    assert.equal(migrations.at(-1)?.version, 35);

    const providerId = 'kimi';
    const productId = 'kimi-platform';
    const worker = new PostgresCredentialValidationWorkerStore(
      database,
      { decryptDataKey: async () => Buffer.alloc(32) },
      { deployment: 'worker-test', environment: 'test', leaseTtlMs: 1_000 },
    );

    const concurrentFixture = await insertFixture(database, providerId, productId, 'concurrent');
    const concurrentClaims = await Promise.all([worker.claimNext(), worker.claimNext()]);
    const concurrentLeases = concurrentClaims.filter((lease): lease is CredentialValidationLease => lease !== null);
    assert.equal(concurrentLeases.length, 1, 'one queued row can be claimed by only one concurrent worker');
    const firstLease = concurrentLeases[0];
    assert.ok(firstLease);
    assert.equal(firstLease.job.id, concurrentFixture.jobId);
    assert.equal(firstLease.job.attemptCount, 1);

    await database.query(
      `UPDATE saas_tenant_provider_credential_validation_jobs
            SET lease_until = clock_timestamp() - interval '1 millisecond'
          WHERE id = $1`,
      [firstLease.job.id],
    );
    const reclaimed = await worker.claimNext();
    assert.ok(reclaimed);
    assert.equal(reclaimed.job.id, firstLease.job.id);
    assert.equal(reclaimed.job.attemptCount, 2);
    assert.equal(reclaimed.fencingToken, firstLease.fencingToken + 1);
    assert.equal(
      await worker.complete(firstLease, successfulResult),
      false,
      'old fence cannot complete a reclaimed lease',
    );
    assert.equal(await worker.complete(reclaimed, successfulResult), true);

    const healthy = await database.query<{
      job_status: string;
      credential_status: string;
      credential_validation_state: string;
      account_status: string;
      account_validation_state: string;
      rights_id: string;
    }>(
      `SELECT job.status AS job_status,
                credential.status AS credential_status,
                credential.validation_state AS credential_validation_state,
                account.status AS account_status,
                account.validation_state AS account_validation_state,
                account.rights_id
           FROM saas_tenant_provider_credential_validation_jobs AS job
           JOIN saas_tenant_provider_credentials AS credential
             ON credential.tenant_id = job.tenant_id AND credential.id = job.credential_id
           JOIN saas_tenant_provider_accounts AS account
             ON account.tenant_id = job.tenant_id AND account.id = job.account_id
          WHERE job.id = $1`,
      [reclaimed.job.id],
    );
    assert.deepEqual(healthy.rows[0], {
      job_status: 'verified',
      credential_status: 'active',
      credential_validation_state: 'verified',
      account_status: 'active',
      account_validation_state: 'verified',
      rights_id: concurrentFixture.rightsId,
    });

    const failedFixture = await insertFixture(database, providerId, productId, 'failed');
    const failedLease = await worker.claimNext();
    assert.ok(failedLease);
    assert.equal(failedLease.job.id, failedFixture.jobId);
    assert.equal(
      await worker.complete(failedLease, {
        state: 'failed',
        errorCode: 'credential_rejected',
        retryable: false,
        adapterId: 'test-fixed-adapter',
        httpStatus: 401,
        durationMs: 1,
      }),
      true,
    );
    const failedState = await database.query<{
      job_status: string;
      last_error_code: string;
      credential_status: string;
      credential_validation_state: string;
      credential_error: string;
      account_status: string;
      account_error: string;
      rights_id: string;
    }>(
      `SELECT job.status AS job_status, job.last_error_code,
                credential.status AS credential_status,
                credential.validation_state AS credential_validation_state,
                credential.validation_error_code AS credential_error,
                account.status AS account_status,
                account.validation_error_code AS account_error,
                account.rights_id
           FROM saas_tenant_provider_credential_validation_jobs AS job
           JOIN saas_tenant_provider_credentials AS credential
             ON credential.tenant_id = job.tenant_id AND credential.id = job.credential_id
           JOIN saas_tenant_provider_accounts AS account
             ON account.tenant_id = job.tenant_id AND account.id = job.account_id
          WHERE job.id = $1`,
      [failedFixture.jobId],
    );
    assert.deepEqual(failedState.rows[0], {
      job_status: 'failed',
      last_error_code: 'credential_rejected',
      credential_status: 'pending',
      credential_validation_state: 'failed',
      credential_error: 'credential_rejected',
      account_status: 'pending',
      account_error: 'credential_rejected',
      rights_id: failedFixture.rightsId,
    });

    const rotationFixture = await insertFixture(database, providerId, productId, 'rotation');
    const rotationLease = await worker.claimNext();
    assert.ok(rotationLease);
    assert.equal(rotationLease.job.id, rotationFixture.jobId);
    await database.query(
      `UPDATE saas_tenant_provider_credential_versions
            SET status = 'retired', retired_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND credential_id = $2 AND version = 1`,
      [rotationFixture.tenantId, rotationFixture.credentialId],
    );
    await database.query(
      `INSERT INTO saas_tenant_provider_credential_versions (
           tenant_id, account_id, credential_id, version, schema_version, context_version,
           algorithm, kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag
         ) VALUES ($1::uuid, $2, $3, 2, 1, 1, 'aes-256-gcm', 'inference', 'kms/test',
           'wrapped-test-only-v2', 'nonce-test-only-v2', 'ciphertext-test-only-v2', 'tag-test-only-v2')`,
      [rotationFixture.tenantId, rotationFixture.accountId, rotationFixture.credentialId],
    );
    await database.query(
      `UPDATE saas_tenant_provider_credentials SET current_version = 2
          WHERE tenant_id = $1::uuid AND id = $2`,
      [rotationFixture.tenantId, rotationFixture.credentialId],
    );
    const rotatedJob = await database.query<{ status: string; lease_generation: string }>(
      `SELECT status, lease_generation FROM saas_tenant_provider_credential_validation_jobs WHERE id = $1`,
      [rotationFixture.jobId],
    );
    assert.equal(rotatedJob.rows[0]?.status, 'cancelled');
    assert.ok(Number(rotatedJob.rows[0]?.lease_generation) > rotationLease.fencingToken);
    assert.equal(await worker.complete(rotationLease, successfulResult), false);

    for (const [label, table, status, timestamp] of [
      ['credential-disabled', 'saas_tenant_provider_credentials', 'disabled', 'disabled_at'],
      ['credential-revoked', 'saas_tenant_provider_credentials', 'revoked', 'revoked_at'],
      ['account-disabled', 'saas_tenant_provider_accounts', 'disabled', 'disabled_at'],
    ] as const) {
      const fixture = await insertFixture(database, providerId, productId, label);
      const lease = await worker.claimNext();
      assert.ok(lease);
      assert.equal(lease.job.id, fixture.jobId);
      await database.query(
        `UPDATE ${table} SET status = $1, ${timestamp} = clock_timestamp()
            WHERE tenant_id = $2::uuid AND id = $3`,
        [
          status,
          fixture.tenantId,
          table === 'saas_tenant_provider_accounts' ? fixture.accountId : fixture.credentialId,
        ],
      );
      const invalidated = await database.query<{ status: string; lease_generation: string }>(
        `SELECT status, lease_generation FROM saas_tenant_provider_credential_validation_jobs WHERE id = $1`,
        [fixture.jobId],
      );
      assert.equal(invalidated.rows[0]?.status, 'cancelled', `${label} must cancel the job`);
      assert.ok(Number(invalidated.rows[0]?.lease_generation) > lease.fencingToken, `${label} must fence old work`);
      assert.equal(await worker.complete(lease, successfulResult), false);
    }

    const deletionFixture = await insertFixture(database, providerId, productId, 'delete');
    await assert.rejects(
      database.query(`DELETE FROM saas_tenant_provider_credential_validation_jobs WHERE id = $1`, [
        deletionFixture.jobId,
      ]),
    );
    await assert.rejects(
      database.query(`DELETE FROM saas_tenant_provider_credentials WHERE tenant_id = $1::uuid AND id = $2`, [
        deletionFixture.tenantId,
        deletionFixture.credentialId,
      ]),
    );
  } finally {
    await database?.close().catch(() => undefined);
    if (schemaCreated) {
      assert.match(schema, /^saas_validation_worker_[a-f0-9]{32}$/);
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
    }
    await pool.end();
  }
});
