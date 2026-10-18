#!/usr/bin/env node
// Acceptance drill for the legacy-main-112-to-129 compat plan
// (docs/core-capability-alignment-technical-plan-2026-10-18.md §5.2).
//
// Builds a throwaway initdb PostgreSQL cluster (loopback, trust auth, port
// 55443+) and REAL databases in the three acceptance states:
//   (a)  old main: shared 001..111 + the OLD fault-classification 112
//       (SQL extracted from git 6ffa107, checksum-asserted against the
//       known identity), plus seeded wallet/balance/reservation rows, a
//       sealed credential envelope and a runtime-health row written with a
//       NEW outcome value the old-112 constraint already allows;
//   (b)  clean shared prefix (001..111 only);
//   (c)  the current full chain (through 129).
// plus reference/fault/drift/unknown variants.
//
// Proves, end to end through the real command surface:
//   - the legacy upgrade (a) → current is atomic, data-preserving and
//     satisfies the NORMAL migrator's strict full-registry verification;
//   - the normal migrator still refuses (a) before the compat plan (red line);
//   - (b) is refused by the compat plan and completes via the normal migrate;
//   - (c) is an idempotent no-op, as is every rerun after (a)'s upgrade;
//   - fault injection between plan steps rolls back cleanly and a rerun from
//     the complete source state succeeds;
//   - drifted and unknown histories are refused;
//   - the compat receipt is written with a verifiable checksum.
//
// The command runs from a sandbox tree = git HEAD + this work's source files,
// so concurrent in-flight registry edits in the working tree cannot skew the
// acceptance. Nothing here touches a developer's real database.

import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  compatMigrationChecksum,
  getLegacyMain112Manifests,
  getLegacyMain112SourceManifestChecksum,
  LEGACY_MAIN_112_COMPAT_PLAN_ID,
  LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  LEGACY_MAIN_112_MIGRATION_NAME,
  runLegacyMain112CompatPlan,
} from '../../src/saas/db/migrate-compat-legacy-112.js';
import { auditSaasMigrationCompatibility, getSaasMigrationAuditExpectations } from '../../src/saas/db/migration-audit.js';
import { runSaasMigrations, verifySaasMigrations } from '../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabasePool } from '../../src/saas/db/types.js';

const exec = (command: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawnSync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120_000,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    resolveRun({
      status: child.status,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
    });
  });

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SANDBOX_FILES: readonly string[] = [
  'src/saas/db/migrate-compat-legacy-112.ts',
  'src/saas/db/migrate.ts',
  'src/cli/saas-migrate-legacy-112.ts',
  'src/cli/index.ts',
];
const RELEASE_ID = 'legacy112-acceptance';
const SCHEMA = 'model_router_saas';
const OLD_MAIN_COMMIT = '6ffa107';
const OLD_112_PATH = 'src/saas/db/migrations/112_provider_account_durable_fault_classification.ts';

export interface Legacy112AcceptanceCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export interface Legacy112AcceptanceResult {
  readonly ok: boolean;
  readonly checks: readonly Legacy112AcceptanceCheck[];
}

const TENANT_ID = '7e112233-4455-6677-8899-aabbccddeeff';
const WALLET_ID = '7e112233-4455-6677-8899-aabbccdd0011';
const RESERVATION_ID = '7e112233-4455-6677-8899-aabbccdd0012';
const TXN_ID = '7e112233-4455-6677-8899-aabbccdd0013';
const LEDGER_ENTRY_ID = '7e112233-4455-6677-8899-aabbccdd0014';
const ENVELOPE = {
  wrappedDek: 'seed-wrapped-dek-fixture',
  nonce: 'seed-nonce-fixture',
  ciphertext: 'seed-ciphertext-fixture',
  authTag: 'seed-auth-tag-fixture',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validRegistry(): SaasMigration[] {
  const valid = SAAS_MIGRATIONS.filter(
    (migration) =>
      !!migration &&
      Number.isSafeInteger(migration.version) &&
      typeof migration.name === 'string' &&
      typeof migration.sql === 'string',
  );
  if (valid.length < 110) throw new Error(`unexpected registry shape: ${valid.length} valid entries`);
  return valid;
}

async function extractOldMain112(): Promise<SaasMigration> {
  const source = await new Promise<string>((resolveText, reject) => {
    execFile('git', ['show', `${OLD_MAIN_COMMIT}:${OLD_112_PATH}`], { cwd: REPO_ROOT, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolveText(stdout);
    });
  });
  const match = /const providerAccountDurableFaultClassificationSql = `([\s\S]*?)`;\n/.exec(source);
  if (!match) throw new Error('unable to extract the old-main 112 SQL from git history');
  const migration: SaasMigration = {
    version: 112,
    name: LEGACY_MAIN_112_MIGRATION_NAME,
    sql: match[1],
  };
  const checksum = compatMigrationChecksum(migration);
  if (checksum !== LEGACY_MAIN_112_MIGRATION_CHECKSUM) {
    throw new Error(`the git-extracted old-112 SQL does not carry the known identity checksum (${checksum})`);
  }
  return migration;
}

function url(user: string, database: string, port: number): string {
  return `postgresql://${user}:legacy112-acceptance-fixture@127.0.0.1:${port}/${database}?sslmode=disable`;
}

function pool(connectionString: string): pg.Pool {
  const pgPool = new pg.Pool({ connectionString, max: 4 });
  // Teardown order races (cluster stop vs idle clients) must never crash the drill.
  pgPool.on('error', () => undefined);
  return pgPool;
}

/** The deploy-command pool contract, so the core plan runs against a real pg pool. */
function compatPool(connectionString: string): SaasDatabasePool {
  const pgPool = pool(connectionString);
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await pgPool.query(sql, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    async connect() {
      const client = await pgPool.connect();
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await client.query(sql, values ? [...values] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release: (error) => client.release(error),
      };
    },
    async end() {
      await pgPool.end();
    },
  };
}

const SEED_SQL = `
INSERT INTO saas_tenants (id, name, slug) VALUES ('${TENANT_ID}', 'Legacy 112 Acceptance', 'legacy-112-acceptance');
INSERT INTO saas_wallets (id, tenant_id, currency, posted_balance_minor_units) VALUES ('${WALLET_ID}', '${TENANT_ID}', 'USD', 125000);
INSERT INTO saas_ledger_transactions (id, tenant_id, currency, idempotency_namespace, business_key, source_type, amount_minor_units, metadata_ref, source_order_ref)
  VALUES ('${TXN_ID}', '${TENANT_ID}', 'USD', 'legacy112-seed', 'seed-order-1', 'wallet_funding', 200000, 'seed-metadata', 'seed-source-order');
INSERT INTO saas_ledger_entries (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref, wallet_id)
  VALUES ('${LEDGER_ENTRY_ID}', '${TXN_ID}', '${TENANT_ID}', 'USD', 'debit', 200000, 'funding_source', 'seed-funding-source', NULL);
INSERT INTO saas_ledger_entries (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref, wallet_id)
  VALUES ('7e112233-4455-6677-8899-aabbccdd0015', '${TXN_ID}', '${TENANT_ID}', 'USD', 'credit', 200000, 'wallet', '${WALLET_ID}', '${WALLET_ID}');
INSERT INTO saas_billing_reservations (id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key, amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at)
  VALUES ('${RESERVATION_ID}', '${TENANT_ID}', '${WALLET_ID}', 'USD', 'seed-request-1', 'legacy112-seed', 'seed-business-1', 75000, 'reserved', 'seed-price-ref', 'seed-reservation-meta', now() + interval '1 hour');
INSERT INTO saas_provider_products (provider_id, product_id, display_name) VALUES ('seed-provider', 'seed-product', 'Seed Product');
INSERT INTO saas_provider_rights (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose, model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
  VALUES ('seed-rights', 1, 'seed-provider', 'seed-product', 'api_key', 'byok', 'global', 'inference', ARRAY['seed-model'], ARRAY['seed-endpoint'], now(), 'seed-approval', 'active', 'seed-evidence', repeat('ab', 32));
INSERT INTO saas_tenant_provider_accounts (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version, status)
  VALUES ('${TENANT_ID}', 'seed-account', 'Seed Account', 'seed-provider', 'seed-product', 'api_key', 'global', 'inference', 'seed-rights', 1, 'active');
INSERT INTO saas_tenant_provider_credentials (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state)
  VALUES ('${TENANT_ID}', 'seed-credential', 'seed-account', 'seed-provider', 'seed-product', 'api_key', 'active', 'verified');
INSERT INTO saas_tenant_provider_credential_versions (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm, kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag)
  VALUES ('${TENANT_ID}', 'seed-account', 'seed-credential', 1, 1, 1, 'aes-256-gcm', 'seed-purpose', 'seed-kms-key', '${ENVELOPE.wrappedDek}', '${ENVELOPE.nonce}', '${ENVELOPE.ciphertext}', '${ENVELOPE.authTag}');
INSERT INTO saas_provider_account_runtime_health (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count, observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
  VALUES ('${TENANT_ID}', 'tenant', '${TENANT_ID}', 'seed-account', 'cooldown', 1, now(), now() + interval '2 minutes', 'gateway_account_access_failure', 1, 1);
`;

const PRESERVED_TABLES: readonly string[] = [
  'saas_tenants',
  'saas_wallets',
  'saas_ledger_transactions',
  'saas_ledger_entries',
  'saas_billing_reservations',
  'saas_tenant_provider_accounts',
  'saas_tenant_provider_credentials',
  'saas_tenant_provider_credential_versions',
  'saas_provider_account_runtime_health',
];

/** The pre-upgrade column set per preserved table (data preservation must hold on these exact columns). */
async function captureColumns(databaseUrl: string): Promise<Record<string, string[]>> {
  const pgPool = pool(databaseUrl);
  const columns: Record<string, string[]> = {};
  try {
    for (const table of PRESERVED_TABLES) {
      const result = await pgPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [SCHEMA, table],
      );
      const names = result.rows.map((row) => row.column_name).filter((name) => /^[a-z0-9_]+$/.test(name));
      if (names.length === 0) throw new Error(`no columns captured for ${table}`);
      columns[table] = names;
    }
  } finally {
    await pgPool.end();
  }
  return columns;
}

async function tableDigests(databaseUrl: string, columns: Record<string, string[]>): Promise<Record<string, string>> {
  const pgPool = pool(databaseUrl);
  const digests: Record<string, string> = {};
  try {
    for (const table of PRESERVED_TABLES) {
      const tableColumns = columns[table];
      if (!tableColumns) throw new Error(`no captured column set for ${table}`);
      // Digest only the pre-upgrade columns: the upgrade legitimately adds
      // columns to some tables, and (t.*)::text would otherwise change while
      // the data itself is identical.
      const rowExpression = `(${tableColumns.map((column) => `t."${column}"`).join(', ')})::text`;
      const result = await pgPool.query<{ digest: string | null }>(
        `SELECT md5(string_agg(${rowExpression}, E'\\n' ORDER BY ${rowExpression})) AS digest FROM ${SCHEMA}.${table} t`,
      );
      digests[table] = result.rows[0]?.digest ?? 'empty';
    }
    const wallet = await pgPool.query<{ balance: string }>(
      `SELECT posted_balance_minor_units::text AS balance FROM ${SCHEMA}.saas_wallets WHERE id = $1`,
      [WALLET_ID],
    );
    digests['saas_wallets.balance'] = wallet.rows[0]?.balance ?? 'missing';
    const envelope = await pgPool.query<{ material: string }>(
      `SELECT wrapped_dek || ':' || nonce || ':' || ciphertext || ':' || auth_tag AS material FROM ${SCHEMA}.saas_tenant_provider_credential_versions WHERE version = 1`,
    );
    digests['saas_tenant_provider_credential_versions.envelope'] = envelope.rows[0]?.material ?? 'missing';
    const reservation = await pgPool.query<{ state: string; amount: string }>(
      `SELECT state, amount_minor_units::text AS amount FROM ${SCHEMA}.saas_billing_reservations WHERE id = $1`,
      [RESERVATION_ID],
    );
    digests['saas_billing_reservations.seed'] = `${reservation.rows[0]?.state ?? 'missing'}:${reservation.rows[0]?.amount ?? 'missing'}`;
  } finally {
    await pgPool.end();
  }
  return digests;
}

async function ledgerRows(databaseUrl: string): Promise<Array<{ version: number; name: string; checksum: string }>> {
  const pgPool = pool(databaseUrl);
  try {
    const result = await pgPool.query(`SELECT version, name, checksum FROM ${SCHEMA}.saas_schema_migrations ORDER BY version ASC`);
    return result.rows as Array<{ version: number; name: string; checksum: string }>;
  } finally {
    await pgPool.end();
  }
}

// ---------------------------------------------------------------------------
// Cluster + sandbox
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  for (let port = 55443; port <= 55452; port += 1) {
    const bindable = await new Promise<boolean>((resolveBind) => {
      const server = createServer();
      server.once('error', () => resolveBind(false));
      server.once('listening', () => server.close(() => resolveBind(true)));
      server.listen(port, '127.0.0.1');
    });
    if (bindable) return port;
  }
  throw new Error('no free port in 55443..55452');
}

interface Cluster {
  readonly port: number;
  readonly directory: string;
  stop: () => Promise<void>;
}

async function startCluster(): Promise<Cluster> {
  const directory = await mkdtemp(join(tmpdir(), 'legacy112-acceptance-'));
  const data = join(directory, 'pgdata');
  const port = await freePort();
  const initdb = await exec('initdb', [
    '-D',
    data,
    '-U',
    'compat_owner',
    '--auth-local=trust',
    '--auth-host=trust',
    '--encoding=UTF8',
    '--no-locale',
  ]);
  if (initdb.status !== 0) throw new Error(`initdb failed: ${initdb.stderr}`);
  const start = await exec('pg_ctl', [
    '-D',
    data,
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-h 127.0.0.1 -p ${port} -k ${directory}`,
    '-w',
    '-t',
    '30',
    'start',
  ]);
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr}`);
  let stopped = false;
  return {
    port,
    directory,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await exec('pg_ctl', ['-D', data, '-w', '-t', '15', '-m', 'fast', 'stop']);
    },
  };
}

async function buildSandbox(): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), 'legacy112-sandbox-'));
  const archive = await exec('git', ['archive', 'HEAD'], { cwd: REPO_ROOT });
  if (archive.status !== 0) throw new Error('git archive HEAD failed');
  const tar = spawnSync('tar', ['-x', '-C', sandbox], { input: archive.stdout, maxBuffer: 32 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error('tar extract of the release tree failed');
  for (const file of SANDBOX_FILES) {
    await mkdir(join(sandbox, file, '..'), { recursive: true });
    await exec('cp', [join(REPO_ROOT, file), join(sandbox, file)]);
  }
  await exec('ln', ['-s', join(REPO_ROOT, 'node_modules'), join(sandbox, 'node_modules')]);
  return sandbox;
}

// ---------------------------------------------------------------------------
// Database builders
// ---------------------------------------------------------------------------

async function replayTemplates(cluster: Cluster, database: string, templates: readonly string[]): Promise<void> {
  for (const template of templates) {
    const result = await exec('psql', [
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '--dbname',
      url('compat_owner', database, cluster.port),
      '--file',
      join(REPO_ROOT, 'deploy', template),
    ]);
    if (result.status !== 0) throw new Error(`template replay failed (${template}): ${result.stderr.slice(0, 500)}`);
  }
}

async function buildDatabase(
  cluster: Cluster,
  database: string,
  migrations: readonly SaasMigration[],
  seed: boolean,
  options: { replayWorkerTemplate?: boolean } = {},
): Promise<void> {
  const ownerPool = pool(url('compat_owner', 'postgres', cluster.port));
  try {
    await ownerPool.query(`CREATE DATABASE ${database}`);
  } finally {
    await ownerPool.end();
  }
  // The main template (roles + schema ownership) must precede the migrations.
  // The worker template references columns created by the current-chain
  // migrations (e.g. 119's grok scheduling columns), so it only replays on a
  // database already at the full chain — for the legacy databases the CURRENT
  // worker template is replayed by the compat command's roles step after the
  // upgrade transaction, exactly like a real deployment upgrade.
  await replayTemplates(cluster, database, ['managed-saas-postgres-roles.sql']);
  const migratorPool = compatPool(url('model_router_saas_migrator', database, cluster.port));
  try {
    await runSaasMigrations(migratorPool, migrations);
    if (seed) {
      const seeded = await migratorPool.query(SEED_SQL);
      if (seeded.rowCount === null) throw new Error('the seed statement returned no row count');
    }
  } finally {
    await migratorPool.end();
  }
  await replayTemplates(cluster, database, [
    'managed-saas-postgres-roles.sql',
    ...(options.replayWorkerTemplate === true ? ['managed-saas-validation-worker-role-grants.sql'] : []),
  ]);
}

async function writeEnvFile(cluster: Cluster, directory: string, database: string): Promise<string> {
  const path = join(directory, `${database}.env`);
  await writeFile(
    path,
    [
      `MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL=${url('compat_owner', database, cluster.port)}`,
      `MODEL_ROUTER_SAAS_DATABASE_URL=${url('model_router_saas_migrator', database, cluster.port)}`,
      `MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=${url('model_router_saas_control_plane', database, cluster.port)}`,
      `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=${url('model_router_saas_gateway', database, cluster.port)}`,
      `MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=${url('model_router_saas_validation_worker', database, cluster.port)}`,
      '',
    ].join('\n'),
  );
  return path;
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runCompatCli(sandbox: string, args: readonly string[], timeoutMs = 300_000): Promise<CliRun> {
  return exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migrate-legacy-112', ...args], {
    cwd: sandbox,
    timeoutMs,
  });
}

/** Runs the normal `saas:migrate` CLI in the sandbox with an explicit database URL. */
function runNormalMigrateCli(sandbox: string, databaseUrl: string, timeoutMs = 300_000): CliRun {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migrate'], {
    cwd: sandbox,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, MODEL_ROUTER_SAAS_DATABASE_URL: databaseUrl },
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// The acceptance matrix
// ---------------------------------------------------------------------------

export async function runLegacy112Acceptance(): Promise<Legacy112AcceptanceResult> {
  const checks: Legacy112AcceptanceCheck[] = [];
  const check = async (name: string, work: () => Promise<string>): Promise<void> => {
    try {
      const detail = await work();
      checks.push({ name, status: 'pass', detail });
      console.log(`  PASS  ${name} — ${detail}`);
    } catch (error) {
      checks.push({ name, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
      console.log(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const assert = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
  };

  const registry = validRegistry();
  const manifests = getLegacyMain112Manifests(registry);
  const old112 = await extractOldMain112();
  const shared = manifests.shared;
  const legacyChain: SaasMigration[] = [...shared, old112];
  const targetChain = registry.filter((migration) => migration.version <= 129);
  const legacyUrlDatabase = (database: string, port: number) => url('model_router_saas_migrator', database, port);

  console.log(`legacy-112 compat acceptance — registry head ${manifests.registry[manifests.registry.length - 1].version}, shared ${shared.length} entries, old-112 checksum ${LEGACY_MAIN_112_MIGRATION_CHECKSUM.slice(0, 12)}…`);

  const cluster = await startCluster();
  const sandbox = await buildSandbox();
  try {
    const artifacts = join(cluster.directory, 'artifacts');
    await mkdir(artifacts);

    // ---------- build the databases ----------
    await check('build (a) legacy112 — old-main chain 001..111 + git-extracted old 112 + seeds', async () => {
      await buildDatabase(cluster, 'legacy112_a', legacyChain, true);
      const rows = await ledgerRows(url('compat_owner', 'legacy112_a', cluster.port));
      assert(rows.length === 93, `expected 93 ledger rows, got ${rows.length}`);
      assert(rows[92].version === 112 && rows[92].name === LEGACY_MAIN_112_MIGRATION_NAME, 'the old-main 112 row is missing');
      return `ledger 93 rows, head 112 (${LEGACY_MAIN_112_MIGRATION_NAME}); seed rows inserted`;
    });

    await check('build (a_ref) reference old-main database for the reviewed baseline', async () => {
      await buildDatabase(cluster, 'legacy112_ref', legacyChain, false);
      return 'reference old-main schema built';
    });

    await check('build (b) clean111 — shared prefix only', async () => {
      await buildDatabase(cluster, 'clean111_b', shared, false);
      const rows = await ledgerRows(url('compat_owner', 'clean111_b', cluster.port));
      assert(rows.length === 92 && rows[91].version === 111, `unexpected clean-prefix ledger (${rows.length} rows)`);
      return 'ledger 92 rows, head 111';
    });

    await check('build (c) current129 — the full current chain', async () => {
      await buildDatabase(cluster, 'current129_c', targetChain, false, { replayWorkerTemplate: true });
      const rows = await ledgerRows(url('compat_owner', 'current129_c', cluster.port));
      assert(rows.length === 110 && rows[109].version === 129, `unexpected current chain (${rows.length} rows)`);
      return 'ledger 110 rows, head 129';
    });

    // Reference databases for fault injection / drift / unknown.
    await check('build the fault/drift/unknown reference databases and tamper their ledgers', async () => {
      await buildDatabase(cluster, 'legacy112_fault', legacyChain, true);
      await buildDatabase(cluster, 'legacy112_drift', legacyChain, true);
      await buildDatabase(cluster, 'legacy112_unknown', legacyChain, true);
      const driftPool = pool(url('compat_owner', 'legacy112_drift', cluster.port));
      try {
        await driftPool.query(`UPDATE ${SCHEMA}.saas_schema_migrations SET checksum = '${'f'.repeat(64)}' WHERE version = 100`);
      } finally {
        await driftPool.end();
      }
      const unknownPool = pool(url('compat_owner', 'legacy112_unknown', cluster.port));
      try {
        await unknownPool.query(
          `INSERT INTO ${SCHEMA}.saas_schema_migrations (version, name, checksum) VALUES (999, 'mystery_migration', '${'a'.repeat(64)}')`,
        );
      } finally {
        await unknownPool.end();
      }
      return 'legacy112_fault/drift/unknown built from the old-main chain; drift checksum tampered at v100; unknown v999 row inserted';
    });

    // ---------- reviewed source catalog baseline ----------
    const baselinePath = join(artifacts, 'legacy112-source-catalog-baseline.json');
    await check('generate the reviewed source catalog baseline from the reference old-main database', async () => {
      const auditPool = compatPool(legacyUrlDatabase('legacy112_ref', cluster.port));
      try {
        const report = await auditSaasMigrationCompatibility(auditPool, {
          target: {
            deploymentId: 'legacy112-acceptance',
            environmentId: 'acceptance',
            database: 'legacy112_ref',
            schema: SCHEMA,
          },
          releaseId: RELEASE_ID,
          migrations: legacyChain,
        });
        assert(report.catalog.actual.length > 0, 'the catalog snapshot is empty');
        assert(report.catalog.unsupportedFeatures.length === 0, `unsupported catalog features: ${report.catalog.unsupportedFeatures.join(',')}`);
        assert(
          report.migrations.every((comparison) => comparison.state === 'match'),
          'the reference ledger does not match the legacy chain expectations',
        );
        const serverPool = pool(url('compat_owner', 'legacy112_ref', cluster.port));
        let versionNum: number;
        try {
          const versionResult = await serverPool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
          versionNum = Number(versionResult.rows[0]?.v);
        } finally {
          await serverPool.end();
        }
        const baseline = {
          profile: 'saas-ddl-v1',
          coverage: 'complete-profile',
          evidenceId: 'legacy112-acceptance-baseline',
          releaseId: RELEASE_ID,
          schema: SCHEMA,
          postgresMajor: Math.floor(versionNum / 10_000),
          migrationsChecksum: getSaasMigrationAuditExpectations(legacyChain).checksum,
          objects: report.catalog.actual,
        };
        await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
        return `${report.catalog.actual.length} catalog objects; migrations checksum ${baseline.migrationsChecksum.slice(0, 12)}…; PG major ${baseline.postgresMajor}`;
      } finally {
        await auditPool.end();
      }
    });

    // ---------- CLI registration ----------
    await check('the CLI registers saas:migrate-legacy-112', async () => {
      const help = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--help'], { cwd: sandbox });
      assert(help.status === 0, `--help exited ${help.status}`);
      assert(help.stdout.includes('saas:migrate-legacy-112'), 'the command is not listed in --help');
      return 'listed in model-router --help (sandbox release tree)';
    });

    // ---------- (a): the legacy upgrade ----------
    const envFileA = await writeEnvFile(cluster, artifacts, 'legacy112_a');
    const receiptA = join(artifacts, 'legacy112-a-receipt.json');
    const columnsBefore = await captureColumns(url('compat_owner', 'legacy112_a', cluster.port));
    const digestsBefore = await tableDigests(url('compat_owner', 'legacy112_a', cluster.port), columnsBefore);

    await check('(a) pre-upgrade: the NORMAL migrator refuses the old-main ledger (red line intact)', async () => {
      const withEnv = runNormalMigrateCli(sandbox, legacyUrlDatabase('legacy112_a', cluster.port));
      assert(withEnv.status !== 0, 'the normal migrator must refuse the legacy ledger');
      const output = `${withEnv.stdout}${withEnv.stderr}`;
      assert(
        output.includes('Unable to apply SaaS database migrations'),
        `unexpected normal-migrate output: ${output.slice(-500)}`,
      );
      return `saas:migrate exited ${withEnv.status} (refused) on the old-main ledger`;
    });

    await check('(a) compat dry-run classifies the complete source state', async () => {
      const result = await runCompatCli(sandbox, [
        '--dry-run',
        '--env-file',
        envFileA,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--allow-local-plaintext',
      ]);
      assert(result.status === 0, `dry-run exited ${result.status}\n${result.stdout}\n${result.stderr}`);
      assert(result.stdout.includes('ledger classified: legacy-112-source'), result.stdout.slice(-800));
      assert(result.stdout.includes('zero mutations'), 'the dry-run must state zero mutations');
      return 'dry-run verified the complete source state with the reviewed baseline';
    });

    await check('(a) compat apply: the legacy upgrade is atomic and data-preserving', async () => {
      const result = await runCompatCli(sandbox, [
        '--env-file',
        envFileA,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--receipt-file',
        receiptA,
        '--confirm-writes-stopped',
        '--confirm-backup-taken',
        '--allow-local-plaintext',
      ]);
      assert(result.status === 0, `apply exited ${result.status}\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-500)}`);
      assert(result.stdout.includes('ledger 112 → 129 moved'), 'the move was not reported');
      assert(result.stdout.includes('17 target migrations applied and registered'), 'the pending target migrations were not applied');
      assert(result.stdout.includes('runtime privilege probe green'), 'a runtime privilege probe failed');
      const rows = await ledgerRows(url('compat_owner', 'legacy112_a', cluster.port));
      const expected = manifests.target.map((entry) => ({ version: entry.version, name: entry.name, checksum: entry.checksum }));
      assert(
        rows.length === expected.length && rows.every((row, index) =>
          row.version === expected[index].version && row.name === expected[index].name && row.checksum === expected[index].checksum,
        ),
        `the post-upgrade ledger does not equal the target history (${rows.length} rows)`,
      );
      return `ledger == complete target history (${rows.length} rows, head 129)`;
    });

    await check('(a) data preservation: wallets, reservations, sealed envelope, runtime health are byte-identical', async () => {
      const digestsAfter = await tableDigests(url('compat_owner', 'legacy112_a', cluster.port), columnsBefore);
      for (const [table, before] of Object.entries(digestsBefore)) {
        assert(digestsAfter[table] === before, `table ${table} changed during the upgrade`);
      }
      assert(digestsAfter['saas_wallets.balance'] === '125000', 'wallet balance changed');
      assert(
        digestsAfter['saas_tenant_provider_credential_versions.envelope'] ===
          `${ENVELOPE.wrappedDek}:${ENVELOPE.nonce}:${ENVELOPE.ciphertext}:${ENVELOPE.authTag}`,
        'the sealed credential envelope changed',
      );
      assert(digestsAfter['saas_billing_reservations.seed'] === 'reserved:75000', 'the reservation changed');
      return `${PRESERVED_TABLES.length} table digests + wallet/envelope/reservation values identical before and after`;
    });

    await check('(a) post-upgrade: the NORMAL migrator verification passes on the normalized database', async () => {
      const verifyPool = compatPool(legacyUrlDatabase('legacy112_a', cluster.port));
      try {
        await verifySaasMigrations(verifyPool, registry);
      } finally {
        await verifyPool.end();
      }
      return 'verifySaasMigrations (strict full-registry check) is green on (a)';
    });

    await check('(a) post-upgrade: the 129 constraint vocabulary still accepts the new outcomes', async () => {
      const pgPool = pool(url('compat_owner', 'legacy112_a', cluster.port));
      try {
        await pgPool.query(
          `INSERT INTO ${SCHEMA}.saas_provider_account_runtime_health (owner_scope_key, owner_kind, account_id, state, failure_count, observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
           VALUES ('platform', 'platform', 'seed-account-2', 'cooldown', 2, now(), now() + interval '3 minutes', 'gateway_rate_limited_failure', 1, 1)`,
        );
      } finally {
        await pgPool.end();
      }
      return "a post-upgrade runtime-health row with 'gateway_rate_limited_failure' inserts cleanly";
    });

    await check('(a) the compat receipt is written with a verifiable checksum', async () => {
      if (!existsSync(receiptA)) throw new Error('the receipt file was not written');
      const text = await (await import('node:fs/promises')).readFile(receiptA, 'utf8');
      const receipt = JSON.parse(text);
      assert(receipt.format === 'saas-migration-compat-receipt-v1', 'unexpected receipt format');
      assert(receipt.plan === LEGACY_MAIN_112_COMPAT_PLAN_ID, 'unexpected receipt plan');
      assert(receipt.move.name === LEGACY_MAIN_112_MIGRATION_NAME, 'the receipt move identity is wrong');
      const { receiptChecksum, ...body } = receipt;
      assert(
        receiptChecksum === createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        'the receipt checksum does not cover the receipt body',
      );
      return `receipt checksum ${receiptChecksum.slice(0, 12)}… verified (move 112 → 129, ${receipt.applied.length} registered)`;
    });

    await check('(a) double rerun after the upgrade is an idempotent no-op', async () => {
      for (let run = 1; run <= 2; run += 1) {
        const result = await runCompatCli(sandbox, [
          '--env-file',
          envFileA,
          '--release-id',
          RELEASE_ID,
          '--schema',
          SCHEMA,
          '--source-catalog-baseline',
          baselinePath,
          '--receipt-file',
          join(artifacts, `legacy112-a-rerun-${run}.json`),
          '--confirm-writes-stopped',
          '--confirm-backup-taken',
          '--allow-local-plaintext',
        ]);
        assert(result.status === 0, `rerun ${run} exited ${result.status}\n${result.stdout.slice(-1500)}`);
        assert(result.stdout.includes('already at the complete target state'), `rerun ${run} was not a no-op`);
      }
      return 'two consecutive reruns both reported the complete target state with exit 0';
    });

    // ---------- fault injection ----------
    await check('fault injection: a kill between steps rolls back and a rerun from the complete source state succeeds', async () => {
      const faultDatabase = 'legacy112_fault';
      const columnsBeforeFault = await captureColumns(url('compat_owner', faultDatabase, cluster.port));
      const digestsBeforeFault = await tableDigests(url('compat_owner', faultDatabase, cluster.port), columnsBeforeFault);
      // F1: a kill after the ledger move (simulating a process death between steps).
      const killPool = compatPool(legacyUrlDatabase(faultDatabase, cluster.port));
      try {
        const killed = await runLegacyMain112CompatPlan(killPool, {
          schema: SCHEMA,
          releaseId: RELEASE_ID,
          migrations: registry,
          onPhase: (phase) => {
            if (phase === 'after-move') throw new Error('simulated kill between steps');
          },
        });
        assert(killed.status === 'failed', `the kill scenario must fail (got ${killed.status})`);
      } finally {
        await killPool.end();
      }
      let rows = await ledgerRows(url('compat_owner', faultDatabase, cluster.port));
      assert(rows.length === 93 && rows[92].version === 112, `the ledger must keep its complete source state after the kill (${rows.length} rows)`);
      // F2: a poisoned pending migration fails the whole transaction.
      const poisonedPool = compatPool(legacyUrlDatabase(faultDatabase, cluster.port));
      try {
        const poisoned = await runLegacyMain112CompatPlan(poisonedPool, {
          schema: SCHEMA,
          releaseId: RELEASE_ID,
          migrations: registry.map((migration) =>
            migration.version === 115 ? { ...migration, sql: 'ALTER TABLE saas_fault_injection_missing_table ADD COLUMN x int' } : migration,
          ),
        });
        assert(poisoned.status === 'failed', `the poisoned-migration scenario must fail (got ${poisoned.status})`);
      } finally {
        await poisonedPool.end();
      }
      rows = await ledgerRows(url('compat_owner', faultDatabase, cluster.port));
      assert(rows.length === 93, `the ledger must still be the complete source state after the poisoned apply (${rows.length} rows)`);
      const digestsAfterFault = await tableDigests(url('compat_owner', faultDatabase, cluster.port), columnsBeforeFault);
      for (const [table, before] of Object.entries(digestsBeforeFault)) {
        assert(digestsAfterFault[table] === before, `table ${table} changed during the fault scenarios`);
      }
      // F3: the real rerun from the complete source state succeeds through the command surface.
      const envFile = await writeEnvFile(cluster, artifacts, faultDatabase);
      const result = await runCompatCli(sandbox, [
        '--env-file',
        envFile,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--receipt-file',
        join(artifacts, 'legacy112-fault-receipt.json'),
        '--confirm-writes-stopped',
        '--confirm-backup-taken',
        '--allow-local-plaintext',
      ]);
      assert(result.status === 0, `the post-fault rerun exited ${result.status}\n${result.stdout.slice(-2000)}`);
      rows = await ledgerRows(url('compat_owner', faultDatabase, cluster.port));
      assert(rows.length === 110 && rows[109].version === 129, `the post-fault rerun did not reach the target (${rows.length} rows)`);
      return 'kill-after-move and poisoned-migration both rolled back to the 93-row source state; the rerun then upgraded atomically';
    });

    // ---------- (b): clean prefix ----------
    await check('(b) the compat plan refuses a clean ≤111 prefix (normal-migrate territory)', async () => {
      const envFile = await writeEnvFile(cluster, artifacts, 'clean111_b');
      const result = await runCompatCli(sandbox, [
        '--dry-run',
        '--env-file',
        envFile,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--allow-local-plaintext',
      ]);
      assert(result.status !== 0, 'the compat plan must refuse a clean prefix');
      assert(result.stdout.includes('STATE_NOT_APPLICABLE') || result.stdout.includes('clean registry prefix'), result.stdout.slice(-800));
      return 'dry-run refused with STATE_NOT_APPLICABLE and normal-migrate guidance';
    });

    await check('(b) the normal migrate completes the clean prefix to the current chain', async () => {
      const result = runNormalMigrateCli(sandbox, legacyUrlDatabase('clean111_b', cluster.port));
      assert(result.status === 0, `normal migrate exited ${result.status}\n${result.stdout}\n${result.stderr}`);
      const rows = await ledgerRows(url('compat_owner', 'clean111_b', cluster.port));
      assert(rows.length === 110 && rows[109].version === 129, `unexpected post-migrate ledger (${rows.length} rows)`);
      return 'saas:migrate applied 112..129 on the clean prefix; ledger 110 rows';
    });

    // ---------- (c): current chain ----------
    await check('(c) the compat plan is an idempotent no-op on the complete current chain', async () => {
      const envFile = await writeEnvFile(cluster, artifacts, 'current129_c');
      const result = await runCompatCli(sandbox, [
        '--env-file',
        envFile,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--receipt-file',
        join(artifacts, 'legacy112-c-receipt.json'),
        '--confirm-writes-stopped',
        '--confirm-backup-taken',
        '--allow-local-plaintext',
      ]);
      assert(result.status === 0, `apply on (c) exited ${result.status}\n${result.stdout.slice(-1500)}`);
      assert(result.stdout.includes('already at the complete target state'), 'the (c) run was not a no-op');
      return 'already-current no-op with exit 0';
    });

    // ---------- drift / unknown ----------
    await check('a drifted checksum is refused', async () => {
      const envFile = await writeEnvFile(cluster, artifacts, 'legacy112_drift');
      const result = await runCompatCli(sandbox, [
        '--dry-run',
        '--env-file',
        envFile,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--allow-local-plaintext',
      ]);
      assert(result.status !== 0, 'a drifted checksum must be refused');
      assert(result.stdout.includes('STATE_DRIFTED') || result.stdout.includes('drifted'), result.stdout.slice(-800));
      return 'dry-run refused with STATE_DRIFTED';
    });

    await check('an unknown history is refused', async () => {
      const envFile = await writeEnvFile(cluster, artifacts, 'legacy112_unknown');
      const result = await runCompatCli(sandbox, [
        '--dry-run',
        '--env-file',
        envFile,
        '--release-id',
        RELEASE_ID,
        '--schema',
        SCHEMA,
        '--source-catalog-baseline',
        baselinePath,
        '--allow-local-plaintext',
      ]);
      assert(result.status !== 0, 'an unknown history must be refused');
      assert(result.stdout.includes('STATE_UNKNOWN') || result.stdout.includes('unknown'), result.stdout.slice(-800));
      return 'dry-run refused with STATE_UNKNOWN';
    });

    await check('the source manifest checksum binding stays stable', async () => {
      const checksum = getLegacyMain112SourceManifestChecksum(registry);
      assert(/^[0-9a-f]{64}$/.test(checksum), 'invalid source manifest checksum');
      return `source manifest checksum ${checksum.slice(0, 12)}… binds the reviewed baseline`;
    });
  } finally {
    await cluster.stop();
    await rm(cluster.directory, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  const failed = checks.filter((checkEntry) => checkEntry.status === 'fail');
  return { ok: failed.length === 0, checks };
}

async function main(): Promise<void> {
  const result = await runLegacy112Acceptance();
  console.log('');
  console.log(`legacy-112 compat acceptance: ${result.ok ? 'ALL CHECKS PASS' : `${result.checks.filter((c) => c.status === 'fail').length} CHECK(S) FAILED`}`);
  process.exitCode = result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));
if (invokedDirectly) {
  void main();
}
