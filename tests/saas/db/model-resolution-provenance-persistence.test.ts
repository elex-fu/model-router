import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { runSaasMigrations } from '../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

const realPostgresUrl = process.env.SAAS_TEST_DATABASE_URL;

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

  async query<Row>(): Promise<SqlResult<Row>> {
    throw new Error('the migration runner must use one checked-out client');
  }

  async connect(): Promise<SaasDatabaseClient> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      return new ScopedClient(client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async end(): Promise<void> {}
}

test('migration 029 persists the immutable model, transport, compiler, and estimator snapshot shape', {
  skip: !realPostgresUrl,
}, async () => {
  const pool = new PgPool({ connectionString: realPostgresUrl, max: 2 });
  const schema = `saas_model_provenance_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await runSaasMigrations(
      new ScopedPool(pool, schema),
      SAAS_MIGRATIONS.filter(({ version }) => version <= 29),
    );

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = ANY($2::text[])
            AND column_name = ANY($3::text[])
          ORDER BY table_name, column_name`,
      [
        schema,
        ['saas_attempts', 'saas_prepared_request_evidence'],
        [
          'model_resolution_requested_model',
          'model_resolution_mapped_model',
          'model_resolution_mapping_source',
          'model_resolution_mapping_version',
          'provider_protocol',
          'client_operation',
          'provider_operation',
          'request_fingerprint',
          'request_fingerprint_version',
          'payload_compiler_version',
          'usage_estimator_version',
          'payload_sha256',
        ],
      ],
    );
    const actualColumns = columns.rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`);
    const expectedColumns = [
      'saas_attempts.model_resolution_requested_model',
      'saas_attempts.model_resolution_mapped_model',
      'saas_attempts.model_resolution_mapping_source',
      'saas_attempts.model_resolution_mapping_version',
      'saas_attempts.provider_protocol',
      'saas_attempts.client_operation',
      'saas_attempts.provider_operation',
      'saas_attempts.request_fingerprint',
      'saas_attempts.request_fingerprint_version',
      'saas_attempts.payload_compiler_version',
      'saas_attempts.usage_estimator_version',
      'saas_attempts.payload_sha256',
      'saas_prepared_request_evidence.model_resolution_requested_model',
      'saas_prepared_request_evidence.model_resolution_mapped_model',
      'saas_prepared_request_evidence.model_resolution_mapping_source',
      'saas_prepared_request_evidence.model_resolution_mapping_version',
      'saas_prepared_request_evidence.provider_protocol',
      'saas_prepared_request_evidence.client_operation',
      'saas_prepared_request_evidence.provider_operation',
      'saas_prepared_request_evidence.request_fingerprint',
      'saas_prepared_request_evidence.request_fingerprint_version',
      'saas_prepared_request_evidence.payload_compiler_version',
      'saas_prepared_request_evidence.usage_estimator_version',
      'saas_prepared_request_evidence.payload_sha256',
    ];
    assert.deepEqual(actualColumns.sort(), expectedColumns.sort());

    const triggers = await pool.query<{ tgname: string }>(
      `SELECT t.tgname
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND t.tgname = ANY($2::text[])
          ORDER BY t.tgname`,
      [
        schema,
        [
          'saas_attempts_guard_model_resolution_provenance',
          'saas_prepared_request_evidence_guard_model_resolution_provenance',
          'saas_prepared_request_evidence_model_resolution_immutable',
        ],
      ],
    );
    assert.deepEqual(
      triggers.rows.map(({ tgname }) => tgname),
      [
        'saas_attempts_guard_model_resolution_provenance',
        'saas_prepared_request_evidence_guard_model_resolution_provenance',
        'saas_prepared_request_evidence_model_resolution_immutable',
      ],
    );
  } finally {
    try {
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
});
