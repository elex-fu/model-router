import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { runSaasMigrations } from '../../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../../src/saas/db/types.js';

const realPostgresUrl = process.env.SAAS_TEST_DATABASE_URL;

class ScopedClient implements SaasDatabaseClient {
  constructor(private readonly client: import('pg').PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values ? [...values] : undefined);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class ScopedPool implements SaasDatabasePool {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
  ) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      const result = await client.query(sql, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    } finally {
      client.release();
    }
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

  async end(): Promise<void> {
    await this.pool.end();
  }
}

async function withScopedPostgresSchema<T>(work: (pool: ScopedPool) => Promise<T>): Promise<T> {
  if (!realPostgresUrl) throw new Error('SAAS_TEST_DATABASE_URL is required');
  const pool = new Pool({ connectionString: realPostgresUrl, max: 4 });
  const schema = `saas_platform_auth_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    return await work(new ScopedPool(pool, schema));
  } finally {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
}

test('migration 007 creates constrained platform auth tables and prevents cross-user references', {
  skip: !realPostgresUrl,
}, async () => {
  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('saas_platform_sessions', 'saas_platform_mfa_enrollment_tokens',
                            'saas_platform_mfa_setup_tokens')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map(({ table_name }) => table_name),
      ['saas_platform_mfa_enrollment_tokens', 'saas_platform_mfa_setup_tokens', 'saas_platform_sessions'],
    );

    const userOne = '00000000-0000-0000-0000-000000007001';
    const userTwo = '00000000-0000-0000-0000-000000007002';
    const credentialOne = '00000000-0000-0000-0000-000000007011';
    const credentialTwo = '00000000-0000-0000-0000-000000007012';
    await pool.query(
      `INSERT INTO saas_users (id, email)
       VALUES ($1, 'platform-one@example.com'), ($2, 'platform-two@example.com')`,
      [userOne, userTwo],
    );
    await pool.query(
      `INSERT INTO saas_platform_role_assignments (user_id, role)
       VALUES ($1, 'superadmin'), ($2, 'superadmin')`,
      [userOne, userTwo],
    );
    await pool.query(
      `INSERT INTO saas_mfa_credentials
         (id, user_id, kind, encrypted_secret, verified_at)
       VALUES ($1, $2, 'totp', decode('7b7d', 'hex'), now())`,
      [credentialOne, userOne],
    );
    await pool.query(
      `INSERT INTO saas_mfa_credentials (id, user_id, kind, encrypted_secret)
       VALUES ($1, $2, 'totp', decode('7b7d', 'hex'))`,
      [credentialTwo, userTwo],
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_mfa_credentials
           (id, user_id, kind, encrypted_secret, verified_at)
         VALUES ($1, $2, 'totp', decode('7b7d', 'hex'), now())`,
        [randomUUID(), userOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_platform_mfa_enrollment_tokens
           (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, 'not-a-sha256-digest', now() + interval '1 minute')`,
        [randomUUID(), userOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_platform_mfa_setup_tokens
           (id, user_id, credential_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 minute')`,
        [randomUUID(), userOne, credentialTwo, 'a'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await assert.rejects(
      pool.query(`UPDATE saas_mfa_credentials SET last_used_step = -1 WHERE id = $1`, [credentialOne]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_platform_sessions
           (id, user_id, credential_id, token_hash, csrf_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [randomUUID(), userOne, credentialTwo, 'b'.repeat(64), 'c'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
  });
});
