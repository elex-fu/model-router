import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';

// OPS-01 I3 backup/restore drill (Track I, fail-fast red line): a real
// pg_dump -> drop -> recreate -> pg_restore cycle against a dedicated drill
// database must preserve the migration ledger and every row, the restored
// database must still pass the closed migration registry verification and the
// read-only migration audit, and the tool must REFUSE (non-zero exit, no
// half-restored database left) both a corrupt dump and a foreign dump whose
// content does not match the target.
const { Client } = pg;
const ADMIN_ENV = 'MODEL_ROUTER_SAAS_DRILL_ADMIN_URL';
const MIGRATOR_ENV = 'MODEL_ROUTER_SAAS_DRILL_MIGRATOR_URL';
const REQUIRED = 'MODEL_ROUTER_SAAS_DRILL_BACKUP_REQUIRED';
const TOOL = 'scripts/drills/backup-restore.mjs';
const ROLES_SQL = 'deploy/managed-saas-postgres-roles.sql';
const MAIN_DB = 'model_router_test_drill_backup';
const MISMATCH_DB = 'model_router_test_drill_backup_mismatch';
const SAAS_SCHEMA = 'model_router_saas';

const adminUrl = process.env[ADMIN_ENV]?.trim();
const migratorUrl = process.env[MIGRATOR_ENV]?.trim();

interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | undefined;
}

function endpoint(raw: string): Endpoint {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/, '').toLowerCase();
  const port = url.port ? Number(url.port) : 5432;
  const ciTarget = hostname === 'postgres' && port === 5432;
  const localTarget =
    ['127.0.0.1', '::1', 'localhost'].includes(hostname) && Boolean(url.port) && ![5432, 6432].includes(port);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'the drill administrator URL must be PostgreSQL');
  assert.ok(url.username, 'the drill administrator URL must name a user');
  assert.equal(url.hash, '', 'the drill administrator URL must not carry a fragment');
  assert.equal(url.search, '', 'the drill administrator URL must not carry connection overrides');
  assert.ok(
    ciTarget || localTarget,
    'use the designated CI service or an explicit non-default-port loopback cluster for the backup drill',
  );
  return {
    host: hostname,
    port,
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

interface ToolRun {
  readonly status: number | null;
  readonly events: Array<Record<string, unknown>>;
}

function runTool(root: string, admin: string, args: readonly string[]): ToolRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', TOOL, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: process.env.TMPDIR, [ADMIN_ENV]: admin },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 240_000,
  });
  assert.ifError(result.error);
  const events = (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, events };
}

test('OPS-01 I3: backup/restore preserves ledger and rows; corrupt or foreign dumps are refused fail-fast', {
  skip:
    process.env[REQUIRED] !== '1' && !(adminUrl && migratorUrl)
      ? `set ${REQUIRED}=1, ${ADMIN_ENV} (drill-scoped cluster administrator URL) and ${MIGRATOR_ENV} ` +
        '(drill-scoped migrator role URL) to require the backup drill'
      : false,
  timeout: 300_000,
  concurrency: false,
}, async (t) => {
  assert.ok(adminUrl, 'the drill administrator URL is required once the drill is not skipped');
  assert.ok(migratorUrl, 'the drill migrator URL is required once the drill is not skipped');
  const migrator = migratorUrl;
  const target = endpoint(adminUrl);
  const root = resolve(process.cwd());
  const scratch = mkdtempSync(join(tmpdir(), 'ops01-backup-drill-'));
  const clients: Array<InstanceType<typeof Client>> = [];
  t.after(async () => {
    // Drill databases are deliberately KEPT for post-drill inspection and are
    // reported in docs/evidence/ops-01-drills.md; only connections and the
    // scratch directory are released here.
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.end();
        } catch {
          // A client whose database was dropped mid-drill may already be dead.
        }
      }),
    );
    rmSync(scratch, { recursive: true, force: true });
  });

  async function connect(database: string): Promise<InstanceType<typeof Client>> {
    const client = new Client({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database,
      connectionTimeoutMillis: 5_000,
    });
    clients.push(client);
    await client.connect();
    return client;
  }

  // Every phase uses a fresh short-lived connection: the drill tool
  // legitimately terminates backends on the target database mid-cycle, so a
  // pooled connection would observe 57P01 instead of drill facts.
  async function withClient<T>(
    database: string,
    work: (client: InstanceType<typeof Client>) => Promise<T>,
  ): Promise<T> {
    const client = await connect(database);
    try {
      return await work(client);
    } finally {
      try {
        await client.end();
      } catch {
        // The tool may already have terminated this backend.
      }
    }
  }

  async function provision(database: string): Promise<void> {
    await withClient('postgres', async (maintenance) => {
      await maintenance.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database],
      );
      await maintenance.query(`DROP DATABASE IF EXISTS "${database}"`);
      await maintenance.query(`CREATE DATABASE "${database}"`);
    });
    // Same provisioning contract as the CI runtime-privileges script: role
    // template first (per-database search_path/ownership guards), then the
    // complete registered migration sequence as the migrator role through the
    // explicit CLI (startup never migrates; drills must not either), then the
    // template again to reconcile post-migration objects.
    const applyRoles = (): void => {
      const applied = spawnSync(
        'psql',
        [
          '--no-psqlrc',
          '--set=ON_ERROR_STOP=1',
          '--host',
          target.host,
          '--port',
          String(target.port),
          '--username',
          target.user,
          '--dbname',
          database,
          '--file',
          ROLES_SQL,
        ],
        {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(target.password !== undefined ? { PGPASSWORD: target.password } : {}),
          },
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      assert.ifError(applied.error);
      assert.equal(applied.status, 0, 'the managed-saas role template must apply to the drill database');
    };
    applyRoles();
    const migrated = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migrate'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MODEL_ROUTER_SAAS_DATABASE_URL: migratorUrlFor(database) },
      encoding: 'utf8',
      timeout: 240_000,
    });
    assert.ifError(migrated.error);
    assert.equal(migrated.status, 0, 'the drill database must migrate through the explicit saas:migrate CLI');
    applyRoles();
  }

  function migratorUrlFor(database: string): string {
    const url = new URL(migrator);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async function seedTenants(
    database: string,
    count: number,
  ): Promise<Array<{ id: string; name: string; slug: string }>> {
    const seeded: Array<{ id: string; name: string; slug: string }> = [];
    await withClient(database, async (client) => {
      for (let index = 0; index < count; index += 1) {
        const id = randomUUID();
        const row = { id, name: `ops01-drill-tenant-${id}`, slug: `ops01-drill-tenant-${id}` };
        const inserted = await client.query(
          `INSERT INTO ${SAAS_SCHEMA}.saas_tenants (id, name, slug) VALUES ($1, $2, $3)`,
          [row.id, row.name, row.slug],
        );
        assert.equal(inserted.rowCount, 1);
        seeded.push(row);
      }
    });
    return seeded.sort((left, right) => left.id.localeCompare(right.id));
  }

  async function tenantImage(database: string): Promise<Array<{ id: string; name: string; slug: string }>> {
    return withClient(database, async (client) => {
      const result = await client.query<{ id: string; name: string; slug: string }>(
        `SELECT id, name, slug FROM ${SAAS_SCHEMA}.saas_tenants ORDER BY id`,
      );
      return result.rows;
    });
  }

  async function ledgerHash(database: string): Promise<{ count: number; hash: string }> {
    return withClient(database, async (client) => {
      const result = await client.query(
        `SELECT version, name, checksum FROM ${SAAS_SCHEMA}.saas_schema_migrations ORDER BY version ASC`,
      );
      return {
        count: result.rows.length,
        hash: createHash('sha256').update(JSON.stringify(result.rows)).digest('hex'),
      };
    });
  }

  // Positive cycle: provision -> migrate -> seed -> backup/restore with the
  // read-only audit re-check -> everything survives byte-identical.
  await provision(MAIN_DB);
  const seeded = await seedTenants(MAIN_DB, 3);
  const beforeImage = await tenantImage(MAIN_DB);
  assert.deepEqual(beforeImage, seeded);
  const beforeLedger = await ledgerHash(MAIN_DB);
  assert.ok(beforeLedger.count > 0, 'the migrated drill database has a non-empty migration ledger');

  const positive = runTool(root, adminUrl, ['--database', MAIN_DB, '--workdir', join(scratch, 'positive'), '--audit']);
  assert.equal(positive.status, 0, 'the backup/restore drill must succeed on a healthy drill database');
  const result = positive.events.find((event) => event.kind === 'result');
  assert.ok(result, 'the tool must emit a terminal result marker');
  assert.equal(result.ok, true);
  assert.equal(result.migrations, beforeLedger.count, 'the restore preserves every migration ledger row');
  assert.equal(result.ledgerHash, beforeLedger.hash, 'the restore preserves the exact migration ledger content');
  assert.equal(
    result.audit,
    'ledger-matched-baseline-unverified',
    'the read-only audit matches every ledger row (catalog baseline intentionally absent in drills)',
  );
  assert.deepEqual(await tenantImage(MAIN_DB), beforeImage, 'every seeded row survives the cycle unchanged');
  assert.deepEqual(await ledgerHash(MAIN_DB), beforeLedger, 'the migration ledger is byte-identical after restore');
  t.diagnostic(`restored ${String(result.tables)} tables / ${String(result.migrations)} ledger rows on ${MAIN_DB}`);

  // Negative 1: a corrupt dump is rejected BEFORE the source is dropped.
  const corruptDir = join(scratch, 'corrupt');
  writeFileSync(join(scratch, 'corrupt.dump'), createHash('sha256').update('not-a-pg-dump').digest());
  const corrupt = runTool(root, adminUrl, [
    '--database',
    MAIN_DB,
    '--workdir',
    corruptDir,
    '--dump-file',
    join(scratch, 'corrupt.dump'),
  ]);
  assert.equal(corrupt.status, 1, 'a corrupt dump must fail the drill');
  assert.ok(
    corrupt.events.some((event) => event.kind === 'refused' && event.step === 'verify-dump'),
    'the corrupt dump is refused at archive verification',
  );
  assert.deepEqual(await tenantImage(MAIN_DB), beforeImage, 'the source database is untouched by a refused dump');

  // Negative 2: a foreign dump (this database's own archive) aimed at a
  // different, legitimately migrated target is refused after restore, and the
  // half-restored target is dropped instead of being left behind.
  await provision(MISMATCH_DB);
  await seedTenants(MISMATCH_DB, 1);
  const foreignDump = join(scratch, 'foreign.dump');
  const pgEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGUSER: target.user,
    PGDATABASE: MAIN_DB,
  };
  if (target.password !== undefined) pgEnv.PGPASSWORD = target.password;
  const dumped = spawnSync('pg_dump', ['--format=custom', '--file', foreignDump, MAIN_DB], {
    env: pgEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.ifError(dumped.error);
  assert.equal(dumped.status, 0, 'the foreign archive for the mismatch drill must dump cleanly');
  const mismatch = runTool(root, adminUrl, [
    '--database',
    MISMATCH_DB,
    '--workdir',
    join(scratch, 'mismatch'),
    '--dump-file',
    foreignDump,
  ]);
  assert.equal(mismatch.status, 1, 'a foreign dump must fail the drill');
  assert.ok(
    mismatch.events.some(
      (event) => event.kind === 'refused' && event.step === 'verify-restore' && event.reason === 'fingerprint-mismatch',
    ),
    'the foreign dump is refused on the post-restore fingerprint comparison',
  );
  assert.ok(
    mismatch.events.some((event) => event.kind === 'cleanup' && event.dropped === true),
    'the half-restored foreign target is dropped, never left behind',
  );
  const leftover = await withClient('postgres', (maintenance) =>
    maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [MISMATCH_DB]),
  );
  assert.equal(leftover.rows.length, 0, 'no half-restored database may remain after a refused restore');
  assert.deepEqual(await tenantImage(MAIN_DB), beforeImage, 'the healthy drill database survives both refusals');
});
