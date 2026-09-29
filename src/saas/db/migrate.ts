import { createHash } from 'node:crypto';
import { SAAS_MIGRATIONS, type SaasMigration } from './migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool } from './types.js';

const MIGRATION_LOCK_CLASS = 1_384_101_203;
const MIGRATION_LOCK_ID = 1;

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

interface AppliedMigrationRow {
  version?: unknown;
  name?: unknown;
  checksum?: unknown;
}

function checksum(migration: SaasMigration): string {
  return createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
}

function orderMigrations(migrations: readonly SaasMigration[]): SaasMigration[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const seenVersions = new Set<number>();
  const seenNames = new Set<string>();

  for (const migration of ordered) {
    if (
      !migration ||
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      typeof migration.name !== 'string' ||
      !migration.name.trim() ||
      typeof migration.sql !== 'string' ||
      !migration.sql.trim() ||
      seenVersions.has(migration.version) ||
      seenNames.has(migration.name)
    ) {
      throw new Error('Invalid SaaS migration registry');
    }
    seenVersions.add(migration.version);
    seenNames.add(migration.name);
  }

  return ordered;
}

function parseAppliedMigrations(rows: readonly AppliedMigrationRow[]): AppliedMigration[] {
  const applied: AppliedMigration[] = [];
  const seenVersions = new Set<number>();
  const seenNames = new Set<string>();

  for (const row of rows) {
    const rawVersion = row?.version;
    const version =
      typeof rawVersion === 'number'
        ? rawVersion
        : typeof rawVersion === 'string' && rawVersion.trim() !== ''
          ? Number(rawVersion)
          : Number.NaN;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof row?.name !== 'string' ||
      typeof row.checksum !== 'string' ||
      seenVersions.has(version) ||
      seenNames.has(row.name)
    ) {
      throw new Error('Invalid SaaS migration history');
    }
    seenVersions.add(version);
    seenNames.add(row.name);
    applied.push({ version, name: row.name, checksum: row.checksum });
  }

  return applied;
}

function assertMigrationHistoryMatchesRelease(
  ordered: readonly SaasMigration[],
  applied: readonly AppliedMigration[],
): void {
  const knownVersions = new Set(ordered.map(({ version }) => version));
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));

  for (const migration of applied) {
    if (!knownVersions.has(migration.version)) {
      throw new Error('Database contains an unknown SaaS migration version');
    }
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const migration = ordered[index];
    const appliedMigration = appliedByVersion.get(migration.version);
    if (!appliedMigration) {
      const laterMigrationApplied = ordered.slice(index + 1).some(({ version }) => appliedByVersion.has(version));
      if (laterMigrationApplied) {
        throw new Error('SaaS migration history is out of order');
      }
      throw new Error('SaaS database schema is out of date; a required migration is missing');
    }

    if (appliedMigration.name !== migration.name || appliedMigration.checksum !== checksum(migration)) {
      throw new Error('Applied SaaS migration does not match this release');
    }
  }
}

export async function verifySaasMigrations(
  pool: SaasDatabasePool,
  migrations: readonly SaasMigration[] = SAAS_MIGRATIONS,
): Promise<void> {
  const ordered = orderMigrations(migrations);
  let client: SaasDatabaseClient;
  try {
    client = await pool.connect();
  } catch {
    throw new Error('Unable to verify SaaS schema compatibility');
  }

  let discardClient = false;
  try {
    let registryResult: { rows: Array<{ registry?: unknown }> };
    try {
      registryResult = await client.query<{ registry?: unknown }>(
        "SELECT to_regclass('saas_schema_migrations') AS registry",
      );
    } catch {
      discardClient = true;
      throw new Error('Unable to verify SaaS migration registry');
    }

    if (typeof registryResult.rows[0]?.registry !== 'string' || registryResult.rows[0].registry.trim() === '') {
      throw new Error('SaaS migration registry is missing');
    }

    let historyResult: { rows: AppliedMigrationRow[] };
    try {
      historyResult = await client.query<AppliedMigrationRow>(
        'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC',
      );
    } catch {
      discardClient = true;
      throw new Error('Unable to read SaaS migration registry');
    }

    assertMigrationHistoryMatchesRelease(ordered, parseAppliedMigrations(historyResult.rows));
  } finally {
    client.release(discardClient);
  }
}

/**
 * Verify the complete schema required by the managed unknown-outcome
 * scanner/recovery and operator-resolution routes.  This is read-only; the
 * caller must use the explicit migration command to make the schema ready.
 */
export function verifyUnknownOutcomeSaasMigrations(pool: SaasDatabasePool): Promise<void> {
  return verifySaasMigrations(pool);
}

async function executeMigration(
  client: SaasDatabaseClient,
  migration: SaasMigration,
  onDiscardClient: () => void,
): Promise<void> {
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(migration.sql);
    await client.query('INSERT INTO saas_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
      migration.version,
      migration.name,
      checksum(migration),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    if (!transactionStarted) {
      onDiscardClient();
      throw error;
    }
    try {
      await client.query('ROLLBACK');
    } catch {
      onDiscardClient();
      throw error;
    }
    throw error;
  }
}

export async function runSaasMigrations(
  pool: SaasDatabasePool,
  migrations: readonly SaasMigration[] = SAAS_MIGRATIONS,
): Promise<void> {
  const ordered = orderMigrations(migrations);
  const client = await pool.connect();
  let lockAcquired = false;
  let discardClient = false;
  let hasPrimaryFailure = false;
  let primaryError: unknown;
  let hasUnlockFailure = false;
  let unlockError: unknown;

  try {
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID]);
    } catch (error) {
      // The server may have acquired the session lock before the response was lost.
      discardClient = true;
      throw error;
    }
    lockAcquired = true;

    await client.query(
      [
        'CREATE TABLE IF NOT EXISTS saas_schema_migrations (',
        '  version integer PRIMARY KEY,',
        '  name text NOT NULL UNIQUE,',
        "  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),",
        '  applied_at timestamptz NOT NULL DEFAULT now()',
        ')',
      ].join('\n'),
    );

    const result = await client.query<AppliedMigration>(
      'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC',
    );
    const appliedByVersion = new Map<number, AppliedMigration>();
    for (const row of result.rows) {
      const version = Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1 || appliedByVersion.has(version)) {
        throw new Error('Invalid SaaS migration history');
      }
      appliedByVersion.set(version, { ...row, version });
    }

    const knownVersions = new Set(ordered.map(({ version }) => version));
    for (const version of appliedByVersion.keys()) {
      if (!knownVersions.has(version)) {
        throw new Error('Database contains an unknown SaaS migration version');
      }
    }

    for (const migration of ordered) {
      const applied = appliedByVersion.get(migration.version);
      const expectedChecksum = checksum(migration);
      if (applied) {
        if (applied.name !== migration.name || applied.checksum !== expectedChecksum) {
          throw new Error('Applied SaaS migration does not match this release');
        }
        continue;
      }

      if ([...appliedByVersion.keys()].some((version) => version > migration.version)) {
        throw new Error('SaaS migration history is out of order');
      }

      await executeMigration(client, migration, () => {
        discardClient = true;
      });
      appliedByVersion.set(migration.version, {
        version: migration.version,
        name: migration.name,
        checksum: expectedChecksum,
      });
    }
  } catch (error) {
    hasPrimaryFailure = true;
    primaryError = error;
  }

  if (lockAcquired) {
    try {
      const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1, $2) AS unlocked', [
        MIGRATION_LOCK_CLASS,
        MIGRATION_LOCK_ID,
      ]);
      if (result.rows[0]?.unlocked !== true) {
        throw new Error('Failed to release the SaaS migration advisory lock');
      }
    } catch (unlockFailure) {
      hasUnlockFailure = true;
      unlockError = unlockFailure;
    }
  }

  if (hasUnlockFailure) {
    client.release(true);
  } else {
    client.release(discardClient);
  }

  if (hasPrimaryFailure) throw primaryError;
  if (hasUnlockFailure) throw unlockError;
}
