import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { verifySaasMigrations, verifyUnknownOutcomeSaasMigrations } from '../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

interface VerificationPoolOptions {
  applied?: AppliedMigrationRow[];
  registryExists?: boolean;
  historyError?: Error;
}

function checksum(migration: SaasMigration): string {
  return createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
}

function appliedMigrations(migrations: readonly SaasMigration[] = SAAS_MIGRATIONS): AppliedMigrationRow[] {
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: checksum(migration),
  }));
}

class VerificationClient implements SaasDatabaseClient {
  readonly statements: string[] = [];
  readonly releases: Array<Error | boolean | undefined> = [];

  constructor(private readonly pool: VerificationPool) {}

  async query<Row>(sql: string): Promise<SqlResult<Row>> {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    this.statements.push(normalized);

    if (normalized === "SELECT to_regclass('saas_schema_migrations') AS registry") {
      return {
        rows: [
          {
            registry: this.pool.options.registryExists === false ? null : 'saas_schema_migrations',
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (normalized === 'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC') {
      if (this.pool.options.historyError) throw this.pool.options.historyError;
      const rows = this.pool.options.applied ?? [];
      return { rows: [...rows] as Row[], rowCount: rows.length };
    }

    throw new Error(`Unexpected verification query: ${normalized}`);
  }

  release(error?: Error | boolean): void {
    this.releases.push(error);
  }
}

class VerificationPool implements SaasDatabasePool {
  readonly client: VerificationClient;
  readonly endCalls: number[] = [];
  readonly options: VerificationPoolOptions;

  constructor(options: VerificationPoolOptions = {}) {
    this.options = options;
    this.client = new VerificationClient(this);
  }

  async query<Row>(): Promise<SqlResult<Row>> {
    throw new Error('schema verification must use one checked-out client');
  }

  async connect(): Promise<SaasDatabaseClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.endCalls.push(1);
  }
}

function assertReadOnly(statements: readonly string[]): void {
  assert.ok(
    statements.every(
      (statement) => !/\b(?:create|alter|drop|truncate|insert|update|delete|merge|grant|revoke)\b/i.test(statement),
    ),
    `schema verification issued a mutating statement: ${statements.join(' | ')}`,
  );
}

test('accepts the current schema through the database facade with only read queries', async () => {
  const pool = new VerificationPool({ applied: appliedMigrations() });
  const database = createSaasDatabase({
    connectionString: 'postgresql://saas-user:secret@localhost/saas',
    pool,
  });

  await database.verifySchema();
  await database.close();

  assert.deepEqual(pool.client.statements, [
    "SELECT to_regclass('saas_schema_migrations') AS registry",
    'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC',
  ]);
  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
  assert.deepEqual(pool.endCalls, [1]);
});

test('unknown-outcome readiness verifies the complete current migration registry', async () => {
  const pool = new VerificationPool({ applied: appliedMigrations() });
  const database = createSaasDatabase({
    connectionString: 'postgresql://saas-user:secret@localhost/saas',
    pool,
  });

  assert.ok(database.verifyUnknownOutcomeSchema);
  await database.verifyUnknownOutcomeSchema();
  await database.close();

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
  assert.deepEqual(pool.endCalls, [1]);
});

test('rejects unknown-outcome readiness when a required forward-only migration record is missing', async () => {
  for (const missingVersion of [49, 50, 51]) {
    const pool = new VerificationPool({
      applied: appliedMigrations().filter(({ version }) => version !== missingVersion),
    });

    await assert.rejects(verifyUnknownOutcomeSaasMigrations(pool), /(?:out of date.*missing|history is out of order)/);

    assertReadOnly(pool.client.statements);
    assert.deepEqual(pool.client.releases, [false]);
  }
});

test('rejects unknown-outcome readiness when the required migration version is not in the applied history', async () => {
  const applied = appliedMigrations();
  applied[applied.length - 1] = {
    version: 1052,
    name: 'unknown_outcome_unregistered_migration_fixture',
    checksum: applied[applied.length - 1].checksum,
  };
  const pool = new VerificationPool({ applied });

  await assert.rejects(verifyUnknownOutcomeSaasMigrations(pool), /unknown SaaS migration version/);

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
});

test('rejects unknown-outcome readiness when a forward-only migration record has the wrong identity', async () => {
  const applied = appliedMigrations();
  const migration050 = applied.find(({ version }) => version === 50);
  assert.ok(migration050);
  migration050.checksum = '0'.repeat(64);
  const pool = new VerificationPool({ applied });

  await assert.rejects(verifyUnknownOutcomeSaasMigrations(pool), /does not match this release/);

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
});

test('rejects a missing migration registry without issuing DDL or DML', async () => {
  const pool = new VerificationPool({ registryExists: false });

  await assert.rejects(verifySaasMigrations(pool), /SaaS migration registry is missing/);

  assert.deepEqual(pool.client.statements, ["SELECT to_regclass('saas_schema_migrations') AS registry"]);
  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
});

test('rejects an out-of-date schema with missing migrations', async () => {
  const pool = new VerificationPool({ applied: appliedMigrations(SAAS_MIGRATIONS.slice(0, 1)) });

  await assert.rejects(verifySaasMigrations(pool), /out of date.*missing/);

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
});

test('rejects out-of-order history when a later migration is recorded first', async () => {
  const applied = appliedMigrations(SAAS_MIGRATIONS.slice(0, 2)).slice(1);
  const pool = new VerificationPool({ applied });

  await assert.rejects(verifySaasMigrations(pool), /migration history is out of order/);

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
});

test('rejects an unknown migration version', async () => {
  const pool = new VerificationPool({
    applied: [...appliedMigrations(), { version: 999, name: 'unknown_release_migration', checksum: '0'.repeat(64) }],
  });

  await assert.rejects(verifySaasMigrations(pool), /unknown SaaS migration version/);

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [false]);
});

test('rejects an altered migration name or checksum', async () => {
  const alteredName = appliedMigrations();
  alteredName[0].name = 'altered_migration_name';
  const namePool = new VerificationPool({ applied: alteredName });
  await assert.rejects(verifySaasMigrations(namePool), /does not match this release/);

  const alteredChecksum = appliedMigrations();
  alteredChecksum[0].checksum = 'f'.repeat(64);
  const checksumPool = new VerificationPool({ applied: alteredChecksum });
  await assert.rejects(verifySaasMigrations(checksumPool), /does not match this release/);

  assertReadOnly(namePool.client.statements);
  assertReadOnly(checksumPool.client.statements);
  assert.deepEqual(namePool.client.releases, [false]);
  assert.deepEqual(checksumPool.client.releases, [false]);
});

test('discards the checked-out client when reading the registry fails and hides the database error', async () => {
  const pool = new VerificationPool({ historyError: new Error('password=top-secret') });

  await assert.rejects(verifySaasMigrations(pool), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Unable to read SaaS migration registry');
    assert.doesNotMatch(error.message, /top-secret/);
    return true;
  });

  assertReadOnly(pool.client.statements);
  assert.deepEqual(pool.client.releases, [true]);
});
