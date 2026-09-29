import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { runSaasMigrations } from '../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

const configuredTestDatabaseUrl = process.env.MODEL_ROUTER_TEST_DATABASE_URL?.trim();
const allowEphemeralLoopbackTestTarget = process.env.MODEL_ROUTER_TEST_ALLOW_EPHEMERAL_LOOPBACK === '1';
const migrationTargetVersion = 37;

interface TestDatabaseTarget {
  connectionString?: string;
  skipReason?: string;
}

class ScopedPostgresClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values === undefined ? undefined : [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class ScopedPostgresPool implements SaasDatabasePool {
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
      await setSearchPath(client, this.schema);
      return new ScopedPostgresClient(client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async end(): Promise<void> {
    // The integration test owns the underlying pool so it can drop its schema first.
  }
}

function resolveTestDatabaseTarget(value: string | undefined): TestDatabaseTarget {
  if (!value) {
    return {
      skipReason:
        'MODEL_ROUTER_TEST_DATABASE_URL is not configured; PostgreSQL integration assertions skipped without opening a connection',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      skipReason:
        'MODEL_ROUTER_TEST_DATABASE_URL is not a valid PostgreSQL URL; PostgreSQL integration assertions skipped without opening a connection',
    };
  }

  const exactHostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostname = exactHostname.replace(/\.$/, '');
  const port = Number(parsed.port);
  const addressType = isIP(hostname);
  const isLoopbackOrUnspecifiedAddress =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '0:0:0:0:0:0:0:0' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    hostname.startsWith('::ffff:127.') ||
    (addressType === 4 && hostname.startsWith('127.'));
  const isCommonServiceAlias = ['db', 'database', 'host.docker.internal', 'postgres', 'postgresql'].includes(hostname);
  const hasConnectionOverrides = [...parsed.searchParams.keys()].some((key) =>
    ['host', 'port'].includes(key.toLowerCase()),
  );
  let databaseName = '';
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    // An invalid encoded database name cannot qualify for the loopback exception.
  }
  const hasExplicitNonDefaultPort =
    Boolean(parsed.port) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    ![5432, 6432].includes(port);
  const isAllowedEphemeralLoopbackTarget =
    allowEphemeralLoopbackTestTarget &&
    parsed.protocol === 'postgres:' &&
    ['127.0.0.1', '::1'].includes(exactHostname) &&
    hasExplicitNonDefaultPort &&
    databaseName.startsWith('model_router_test_') &&
    !databaseName.includes('/') &&
    parsed.hash === '' &&
    !hasConnectionOverrides;

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !hostname ||
    (isLoopbackOrUnspecifiedAddress && !isAllowedEphemeralLoopbackTarget) ||
    isCommonServiceAlias ||
    !hasExplicitNonDefaultPort ||
    parsed.pathname.length < 2 ||
    parsed.hash !== '' ||
    hasConnectionOverrides
  ) {
    return {
      skipReason:
        'MODEL_ROUTER_TEST_DATABASE_URL must target a disposable PostgreSQL database on a non-local, non-default host and explicit non-default port; unsafe target skipped without opening a connection',
    };
  }

  return { connectionString: value };
}

async function setSearchPath(client: PoolClient, schema: string): Promise<void> {
  await client.query(`SET search_path TO "${schema}"`);
  const result = await client.query<{ current_schema: string; schemas: string[] }>(
    'SELECT pg_catalog.current_schema() AS current_schema, pg_catalog.current_schemas(false)::text[] AS schemas',
  );
  assert.equal(result.rows[0]?.current_schema, schema, 'connection must resolve to the isolated test schema');
  assert.deepEqual(result.rows[0]?.schemas, [schema], 'search_path must exclude public and other user schemas');
}

async function connectToSchema(pool: PgPool, schema: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await setSearchPath(client, schema);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

function migrationsThrough037(): SaasMigration[] {
  const migrations = SAAS_MIGRATIONS.filter(({ version }) => version <= migrationTargetVersion);
  const actualVersions = migrations.map(({ version }) => version);
  const expectedVersions = Array.from({ length: migrationTargetVersion }, (_, index) => index + 1);
  assert.deepEqual(
    actualVersions,
    expectedVersions,
    'registered SaaS migrations must be present once each in order from 001 through 037',
  );
  assert.equal(migrations.at(-1)?.name, 'payment_refunds_and_wallet_freezes');
  return migrations;
}

const testDatabaseTarget = resolveTestDatabaseTarget(configuredTestDatabaseUrl);

test('migration 037 creates refund storage and wallet_refund ledger checks in an isolated PostgreSQL schema', {
  skip: testDatabaseTarget.skipReason,
}, async (t) => {
  if (!testDatabaseTarget.connectionString) return;

  const migrations = migrationsThrough037();
  const schema = `saas_refunds_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^saas_refunds_[a-f0-9]{32}$/);

  const pool = new PgPool({
    connectionString: testDatabaseTarget.connectionString,
    max: 4,
    application_name: 'model-router-refunds-migration-037-test',
  });
  let schemaCreated = false;

  try {
    const admin = await pool.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await setSearchPath(admin, schema);
    } finally {
      admin.release();
    }

    const scopedPool = new ScopedPostgresPool(pool, schema);
    await runSaasMigrations(scopedPool, migrations);

    const client = await connectToSchema(pool, schema);
    try {
      const history = await client.query<{ version: number; name: string }>(
        'SELECT version, name FROM saas_schema_migrations ORDER BY version',
      );
      assert.deepEqual(
        history.rows.map(({ version }) => Number(version)),
        migrations.map(({ version }) => version),
        `migration history in schema ${schema} must contain 001 through 037 in order`,
      );
      assert.equal(history.rows.at(-1)?.name, 'payment_refunds_and_wallet_freezes');
      t.diagnostic(
        `verified database migration history: ${history.rows
          .map(({ version }) => String(version).padStart(3, '0'))
          .join(', ')}`,
      );

      const refundTables = ['saas_refund_orders', 'saas_refund_wallet_freezes'];
      const tableResult = await client.query<{ table_name: string; table_exists: boolean }>(
        `SELECT required.table_name,
                  pg_catalog.to_regclass(pg_catalog.format('%I.%I', $1::text, required.table_name)) IS NOT NULL
                    AS table_exists
             FROM unnest($2::text[]) AS required(table_name)
            ORDER BY required.table_name`,
        [schema, refundTables],
      );
      assert.deepEqual(
        tableResult.rows.filter(({ table_exists }) => !table_exists).map(({ table_name }) => table_name),
        [],
        `migration 037 refund tables are missing in isolated schema ${schema}`,
      );

      const expectedIndexes = [
        ['saas_refund_orders', 'saas_refund_orders_reconciliation_idx'],
        ['saas_refund_orders', 'saas_refund_orders_wallet_order_idx'],
        ['saas_refund_orders', 'saas_refund_orders_service_plan_order_idx'],
        ['saas_refund_wallet_freezes', 'saas_refund_wallet_freezes_wallet_idx'],
      ];
      const indexNames = expectedIndexes.map(([, indexName]) => indexName);
      const indexResult = await client.query<{ table_name: string; index_name: string }>(
        `SELECT tablename AS table_name, indexname AS index_name
             FROM pg_catalog.pg_indexes
            WHERE schemaname = $1
              AND indexname = ANY($2::text[])
            ORDER BY tablename, indexname`,
        [schema, indexNames],
      );
      assert.deepEqual(
        indexResult.rows.map(({ table_name, index_name }) => `${table_name}.${index_name}`).sort(),
        expectedIndexes.map(([tableName, indexName]) => `${tableName}.${indexName}`).sort(),
        `migration 037 refund indexes are missing in isolated schema ${schema}`,
      );

      const expectedConstraints = [
        ['saas_payment_orders', 'saas_payment_orders_tenant_id_unique', 'u'],
        ['saas_ledger_transactions', 'saas_ledger_transactions_source_type_check', 'c'],
        ['saas_ledger_transactions', 'saas_ledger_transactions_source_fields', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_pkey', 'p'],
        ['saas_refund_orders', 'saas_refund_orders_tenant_id_fkey', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_refund_type_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_provider_key_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_merchant_id_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_provider_order_id_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_original_local_order_ref_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_idempotency_namespace_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_client_request_id_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_requested_by_user_id_fkey', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_authorization_ref_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_reason_code_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_amount_minor_units_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_currency_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_state_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_failure_code_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_blocked_code_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_provider_attempts_check', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_tenant_id_unique', 'u'],
        ['saas_refund_orders', 'saas_refund_orders_idempotency_unique', 'u'],
        ['saas_refund_orders', 'saas_refund_orders_provider_refund_unique', 'u'],
        ['saas_refund_orders', 'saas_refund_orders_wallet_order_fk', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_service_plan_order_fk', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_funding_transaction_fk', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_wallet_fk', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_wallet_transaction_fk', 'f'],
        ['saas_refund_orders', 'saas_refund_orders_source_shape', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_lease_shape', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_terminal_shape', 'c'],
        ['saas_refund_orders', 'saas_refund_orders_provider_attempt_shape', 'c'],
        ['saas_refund_wallet_freezes', 'saas_refund_wallet_freezes_pkey', 'p'],
        ['saas_refund_wallet_freezes', 'saas_refund_wallet_freezes_currency_check', 'c'],
        ['saas_refund_wallet_freezes', 'saas_refund_wallet_freezes_amount_minor_units_check', 'c'],
        ['saas_refund_wallet_freezes', 'saas_refund_wallet_freezes_refund_fk', 'f'],
        ['saas_refund_wallet_freezes', 'saas_refund_wallet_freezes_wallet_fk', 'f'],
      ];
      const constraintNames = expectedConstraints.map(([, constraintName]) => constraintName);
      const constraintResult = await client.query<{
        table_name: string;
        constraint_name: string;
        constraint_type: string;
      }>(
        `SELECT relation.relname AS table_name,
                  constraint_row.conname AS constraint_name,
                  constraint_row.contype AS constraint_type
             FROM pg_catalog.pg_constraint AS constraint_row
             JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
             JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = $1
              AND constraint_row.conname = ANY($2::text[])
            ORDER BY relation.relname, constraint_row.conname`,
        [schema, constraintNames],
      );
      assert.deepEqual(
        constraintResult.rows
          .map(
            ({ table_name, constraint_name, constraint_type }) => `${table_name}.${constraint_name}:${constraint_type}`,
          )
          .sort(),
        expectedConstraints
          .map(([tableName, constraintName, constraintType]) => `${tableName}.${constraintName}:${constraintType}`)
          .sort(),
        `migration 037 refund constraints are missing in isolated schema ${schema}`,
      );

      const ledgerChecks = await client.query<{ constraint_name: string; definition: string }>(
        `SELECT constraint_row.conname AS constraint_name,
                  pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
             FROM pg_catalog.pg_constraint AS constraint_row
             JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
             JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = $1
              AND relation.relname = 'saas_ledger_transactions'
              AND constraint_row.conname IN (
                'saas_ledger_transactions_source_type_check',
                'saas_ledger_transactions_source_fields'
              )
            ORDER BY constraint_row.conname`,
        [schema],
      );
      assert.equal(ledgerChecks.rows.length, 2, 'both ledger source checks from migration 037 must exist');
      for (const check of ledgerChecks.rows) {
        assert.match(check.definition, /wallet_refund/, `${check.constraint_name} must allow wallet_refund`);
      }
    } finally {
      client.release();
    }
  } finally {
    try {
      if (schemaCreated) {
        const cleanup = await pool.connect();
        try {
          await setSearchPath(cleanup, schema);
          await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          cleanup.release();
        }
      }
    } finally {
      await pool.end();
    }
  }
});
