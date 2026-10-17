#!/usr/bin/env node
// OPS-01 (DOps plan §5.4) upgrade drill tool: a scripted, real migration
// upgrade against ONE explicitly named disposable drill database.
//
// Phases (each emits a JSON step line; any failure exits non-zero):
//   preflight        pg_dump/psql available, target database provisionable
//   seed             fresh database at registry head N-1 (roles template +
//                    passwords + runSaasMigrations over SAAS_MIGRATIONS[:-1] +
//                    template replay) — the honest "older release" state
//   happy-upgrade    model-router saas:upgrade with a pg_dump backup point:
//                    exit 0, registry N-1 → N, downtime window reported,
//                    backup archive written, three probes green
//   inject           re-seed to N-1, then saas:upgrade with a corrupted role
//                    template (MODEL_ROUTER_SAAS_DEPLOY_TEMPLATE_DIR): must
//                    stop at the roles step non-zero with the database left
//                    migrated (head N) — safe to re-run
//   ungrant          revoke one granted control-plane column: the concrete
//                    "migrated-but-ungranted" state a failed replay leaves
//   heal             saas:upgrade re-run with the real templates: exit 0, the
//                    revoked grant restored (probe green proves it)
//   rollback-refusal saas:upgrade --rollback-to N-1: exit 0 printing the
//                    REFUSED down-migration banner + the documented
//                    backup-restore path, and the registry head stays N
//
// Red lines (scripts/drills/README.md contract):
//  - The administrator URL arrives only via env; credentials never appear in
//    argv, stdout, or markers. Role passwords are drill-generated fixtures,
//    written only to a 0600 env file inside the workdir.
//  - Child non-zero exits are never swallowed; child output is archived under
//    the workdir, never echoed (it may embed connection details).
//  - Only model_router_test_drill* databases on the CI service or an explicit
//    non-default-port loopback cluster are accepted.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import pg from 'pg';

const { Client, Pool } = pg;
const SAAS_SCHEMA = 'model_router_saas';
const ROLES_SQL = 'deploy/managed-saas-postgres-roles.sql';
const WORKER_SQL = 'deploy/managed-saas-validation-worker-role-grants.sql';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}
const database = arg('database');
const workdir = arg('workdir');
const adminUrl = process.env.MODEL_ROUTER_SAAS_DRILL_ADMIN_URL;

const DRILL_DATABASE = /^model_router_test_drill[a-z0-9_]*$/;
if (!database || !DRILL_DATABASE.test(database) || !workdir || !adminUrl) {
  console.error(
    'usage: upgrade --database model_router_test_drill* --workdir dir (env: MODEL_ROUTER_SAAS_DRILL_ADMIN_URL)',
  );
  process.exit(2);
}

let endpoint;
try {
  const url = new URL(adminUrl);
  const hostname = url.hostname.replace(/^\[|\]$/, '').toLowerCase();
  const port = url.port ? Number(url.port) : 5432;
  const ciTarget = hostname === 'postgres' && port === 5432;
  const localTarget =
    ['127.0.0.1', '::1', 'localhost'].includes(hostname) && Boolean(url.port) && ![5432, 6432].includes(port);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    url.hash ||
    url.search ||
    (!ciTarget && !localTarget)
  ) {
    throw new Error('invalid');
  }
  endpoint = {
    host: hostname,
    port,
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    loopback: localTarget,
  };
} catch {
  console.error(
    'MODEL_ROUTER_SAAS_DRILL_ADMIN_URL must be a queryless PostgreSQL administrator URL ' +
      'for the CI service or an explicit non-default-port loopback cluster',
  );
  process.exit(2);
}

const scratch = resolve(workdir);
mkdirSync(join(scratch, 'logs'), { recursive: true });
const backupsDir = join(scratch, 'backups');
// The upgrade's backup step is fail-closed about the configured directory:
// the drill provisions it explicitly.
mkdirSync(backupsDir, { recursive: true });
const corruptDir = join(scratch, 'corrupt-templates');
const envFile = join(scratch, 'upgrade.env');

function emit(kind, extra) {
  process.stdout.write(`${JSON.stringify({ kind, ...extra })}\n`);
}

function maintenanceClient() {
  return new Client({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: endpoint.password,
    database: 'postgres',
    connectionTimeoutMillis: 5_000,
  });
}

function adminClient() {
  return new Client({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: endpoint.password,
    database,
    connectionTimeoutMillis: 5_000,
  });
}

function quoteIdent(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

// Run an external tool with credentials confined to the child environment.
// stdout/stderr are archived under the workdir; only the step name and exit
// status reach this process's stdout. A non-zero exit is never swallowed.
function runTool(step, command, args, env) {
  const result = spawnSync(command, args, {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) writeFileSync(join(scratch, 'logs', `${step}.stdout.log`), result.stdout);
  if (result.stderr) writeFileSync(join(scratch, 'logs', `${step}.stderr.log`), result.stderr);
  if (result.error || result.status !== 0) {
    const error = new Error(`drill step ${step} failed`);
    error.reason = `${step}-failed`;
    throw error;
  }
  return result.stdout ?? '';
}

function pgEnv(dbname) {
  const env = {
    PGHOST: endpoint.host,
    PGPORT: String(endpoint.port),
    PGUSER: endpoint.user,
    PGDATABASE: dbname,
  };
  if (endpoint.password !== undefined) env.PGPASSWORD = endpoint.password;
  return env;
}

async function refuse(step, reason) {
  emit('refused', { step, reason });
  emit('result', { ok: false, reason });
  process.exit(1);
}

async function step(name, work) {
  try {
    const detail = await work();
    emit('step', { step: name, ok: true, ...detail });
    return detail;
  } catch (error) {
    await refuse(name, error && typeof error === 'object' && 'reason' in error ? error.reason : `${name}-failed`);
    throw error; // unreachable; refuse exits
  }
}

// Drill-generated fixture passwords: written only into the 0600 env file and
// ALTER ROLE statements, never printed.
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ROLE_PASSWORDS = {
  model_router_saas_migrator: `drill-migrator-${suffix}`,
  model_router_saas_control_plane: `drill-cp-${suffix}`,
  model_router_saas_gateway: `drill-gateway-${suffix}`,
  model_router_saas_validation_worker: `drill-worker-${suffix}`,
};
const roleUrl = (role) =>
  `postgresql://${role}:${encodeURIComponent(ROLE_PASSWORDS[role])}@${endpoint.host}:${endpoint.port}/${database}?sslmode=disable`;

function writeEnvFile() {
  const adminTarget = `postgresql://${encodeURIComponent(endpoint.user)}${endpoint.password === undefined ? '' : `:${encodeURIComponent(endpoint.password)}`}@${endpoint.host}:${endpoint.port}/${database}?sslmode=disable`;
  writeFileSync(
    envFile,
    [
      '# saas:upgrade drill fixture (disposable cluster); 0600; contains drill-generated passwords',
      `MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL=${adminTarget}`,
      `MODEL_ROUTER_SAAS_DATABASE_URL=${roleUrl('model_router_saas_migrator')}`,
      `MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=${roleUrl('model_router_saas_control_plane')}`,
      `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=${roleUrl('model_router_saas_gateway')}`,
      `MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=${roleUrl('model_router_saas_validation_worker')}`,
      `MODEL_ROUTER_SAAS_UPGRADE_RESTART_MECHANISM=manual`,
      `MODEL_ROUTER_SAAS_UPGRADE_BACKUP_DIR=${backupsDir}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

// The upgrade child never receives credentials in argv; the env file carries
// the deployment surface and the drill captures its output for archiving only.
function runUpgrade(extraArgs, extraEnv = {}) {
  const args = [
    '--import',
    'tsx',
    'src/cli/index.ts',
    'saas:upgrade',
    '--env-file',
    envFile,
    '--allow-local-plaintext',
    ...extraArgs,
  ];
  const result = spawnSync(process.execPath, args, {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      ...extraEnv,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  const label = extraArgs.join(' ') || 'default';
  const tag = `upgrade-${label.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${Date.now()}`;
  if (result.stdout) writeFileSync(join(scratch, 'logs', `${tag}.stdout.log`), result.stdout);
  if (result.stderr) writeFileSync(join(scratch, 'logs', `${tag}.stderr.log`), result.stderr);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function dropAndCreate() {
  const maintenance = maintenanceClient();
  await maintenance.connect();
  try {
    await maintenance.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
    await maintenance.query(`CREATE DATABASE ${quoteIdent(database)}`);
  } finally {
    await maintenance.end();
  }
}

async function setRolePasswords(roles) {
  const client = adminClient();
  await client.connect();
  try {
    for (const role of roles) {
      const password = ROLE_PASSWORDS[role];
      const built = await client.query(
        'SELECT pg_catalog.format($1, $2::text, $3::text) AS statement',
        ['ALTER ROLE %I WITH PASSWORD %L', role, password],
      );
      await client.query(built.rows[0].statement);
    }
  } finally {
    await client.end();
  }
}

/** Pool adapter for the migration runner (search_path pinned like the drill audit precedent). */
function migratorPool() {
  const pool = new Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: 'model_router_saas_migrator',
    password: ROLE_PASSWORDS.model_router_saas_migrator,
    database,
    max: 1,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${SAAS_SCHEMA},public`,
  });
  pool.on('error', () => {});
  return {
    async query(sql, values = []) {
      const result = await pool.query(sql, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, values = []) {
          const result = await client.query(sql, [...values]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release: (error) => client.release(error),
      };
    },
    end: () => pool.end(),
  };
}

async function registryHead() {
  const client = adminClient();
  await client.connect();
  try {
    const result = await client.query(
      `SELECT coalesce(max(version), 0)::int AS head, count(*)::int AS applied FROM ${quoteIdent(SAAS_SCHEMA)}.saas_schema_migrations`,
    );
    return { head: result.rows[0].head, applied: result.rows[0].applied };
  } finally {
    await client.end();
  }
}

/** Seed the database to the N-1 "older release" state with grants applied. */
async function seedToPrevious(migrations, runSaasMigrationsImpl) {
  await dropAndCreate();
  runTool('seed-roles', 'psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', database, '--file', ROLES_SQL], pgEnv(database));
  // The main template creates migrator/control-plane/gateway; the worker role
  // only appears with the worker template after migration (same ordering as
  // saas:deploy bootstrap → migrate → both templates).
  await setRolePasswords([
    'model_router_saas_migrator',
    'model_router_saas_control_plane',
    'model_router_saas_gateway',
  ]);
  const pool = migratorPool();
  try {
    await runSaasMigrationsImpl(pool, migrations.slice(0, -1));
  } finally {
    await pool.end();
  }
  runTool('seed-roles-2', 'psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', database, '--file', ROLES_SQL], pgEnv(database));
  runTool('seed-worker', 'psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', database, '--file', WORKER_SQL], pgEnv(database));
  await setRolePasswords(['model_router_saas_validation_worker']);
  return await registryHead();
}

function writeCorruptTemplateDir() {
  if (!existsSync(corruptDir)) mkdirSync(corruptDir, { recursive: true });
  // The real template plus a statement that fails inside the template
  // transaction: replay must roll back and the upgrade must stop at roles.
  const poison = "\n-- drill-injected replay failure\nGRANT USAGE ON SCHEMA model_router_saas TO model_router_saas_drill_nonexistent_role;\n";
  writeFileSync(join(corruptDir, 'managed-saas-postgres-roles.sql'), readFileSync(ROLES_SQL, 'utf8') + poison);
  writeFileSync(
    join(corruptDir, 'managed-saas-validation-worker-role-grants.sql'),
    readFileSync(WORKER_SQL, 'utf8') + poison,
  );
}

async function main() {
  const { SAAS_MIGRATIONS } = await import('../../src/saas/db/migrations/001_initial_schema.js');
  const { runSaasMigrations } = await import('../../src/saas/db/migrate.js');
  const { SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS } = await import('../../src/saas/db/runtime-privileges.js');
  const total = SAAS_MIGRATIONS.length;
  // Registry versions carry gaps (115/116 are claimed by the parallel
  // capability-parity workstream), so the drill asserts against the real
  // version numbers of the last two registered migrations.
  const previousVersion = SAAS_MIGRATIONS[total - 2].version;
  const releaseVersion = SAAS_MIGRATIONS[total - 1].version;

  await step('preflight', async () => {
    runTool('pg-dump-version', 'pg_dump', ['--version'], {});
    runTool('psql-version', 'psql', ['--version'], {});
    return { registry: total };
  });

  // ---------- phase 1: seeded older release → happy upgrade ----------
  const seeded = await step('seed', () => seedToPrevious(SAAS_MIGRATIONS, runSaasMigrations));
  if (seeded.head !== previousVersion) {
    const error = new Error(`seed reached head ${seeded.head}, expected ${previousVersion}`);
    error.reason = 'seed-unexpected-head';
    throw error;
  }

  const happy = await step('happy-upgrade', async () => {
    writeEnvFile();
    const run = runUpgrade([]);
    if (run.status !== 0) {
      const error = new Error('happy-path saas:upgrade exited non-zero');
      error.reason = 'happy-upgrade-failed';
      throw error;
    }
    if (!/saas:upgrade report ok/.test(run.stdout) && !/registry versions: before/.test(run.stdout)) {
      const error = new Error('happy-path saas:upgrade output is missing the report');
      error.reason = 'happy-upgrade-report-missing';
      throw error;
    }
    const window = /downtime window: (\d+)ms/.exec(run.stdout);
    const before = new RegExp(`registry versions: before ${previousVersion} → after ${releaseVersion}`).test(run.stdout);
    if (!before) {
      const error = new Error('happy-path report does not show the expected version transition');
      error.reason = 'happy-upgrade-versions-missing';
      throw error;
    }
    const archives = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((name) => name.endsWith('.dump'))
      : [];
    if (archives.length === 0) {
      const error = new Error('no pg_dump backup archive was written to the configured backup dir');
      error.reason = 'backup-archive-missing';
      throw error;
    }
    return { downtimeWindowMs: window ? Number(window[1]) : null, backupArchives: archives.length };
  });

  const afterHappy = await registryHead();
  if (afterHappy.head !== releaseVersion) {
    await refuse('happy-upgrade', 'registry-head-not-release');
  }

  // ---------- phase 2: failure injection at the roles step ----------
  await step('reseed', () => seedToPrevious(SAAS_MIGRATIONS, runSaasMigrations));

  const injected = await step('inject', async () => {
    writeCorruptTemplateDir();
    writeEnvFile();
    const run = runUpgrade([], { MODEL_ROUTER_SAAS_DEPLOY_TEMPLATE_DIR: corruptDir });
    if (run.status === 0) {
      const error = new Error('the corrupted-template upgrade must exit non-zero');
      error.reason = 'injection-not-failed';
      throw error;
    }
    if (!/saas:upgrade failed at step "roles"/.test(run.stdout)) {
      const error = new Error('the corrupted-template upgrade did not stop at the roles step');
      error.reason = 'injection-wrong-step';
      throw error;
    }
    if (!/safe to re-run/.test(run.stdout)) {
      const error = new Error('the roles failure did not document the safe rerun');
      error.reason = 'injection-rerun-note-missing';
      throw error;
    }
    return { exit: run.status };
  });

  const afterInject = await registryHead();
  if (afterInject.head !== releaseVersion) {
    await refuse('inject', 'injection-left-registry-not-migrated');
  }
  emit('step', { step: 'inject-state', ok: true, head: afterInject.head, note: 'database migrated, template replay rolled back' });

  // ---------- phase 3: the concrete migrated-but-ungranted state, healed ----------
  await step('ungrant', async () => {
    const [table, column] = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS[0];
    const client = adminClient();
    await client.connect();
    try {
      await client.query(
        `REVOKE SELECT ("${column}") ON ${quoteIdent(SAAS_SCHEMA)}."${table}" FROM model_router_saas_control_plane`,
      );
    } finally {
      await client.end();
    }
    return { revoked: `${table}.${column}:SELECT` };
  });

  await step('heal', async () => {
    writeEnvFile();
    const run = runUpgrade([]);
    if (run.status !== 0) {
      const error = new Error('the healing re-run must succeed');
      error.reason = 'heal-failed';
      throw error;
    }
    if (!/pre-heal tolerated/.test(run.stdout)) {
      const error = new Error('the healing re-run did not tolerate the pre-heal probe failure');
      error.reason = 'heal-precheck-note-missing';
      throw error;
    }
    if (!/model_router_saas_control_plane: runtime privilege probe green/.test(run.stdout)) {
      const error = new Error('the healing re-run did not restore the revoked grant (probe not green)');
      error.reason = 'heal-probe-not-green';
      throw error;
    }
    return { exit: run.status };
  });

  // ---------- phase 4: rollback refusal (never a down-migration) ----------
  await step('rollback-refusal', async () => {
    writeEnvFile();
    const run = runUpgrade(['--rollback-to', String(previousVersion)]);
    if (run.status !== 0) {
      const error = new Error('the rollback runbook print must exit 0');
      error.reason = 'rollback-runbook-failed';
      throw error;
    }
    if (!/REFUSED: down-migration/.test(run.stdout) || !/pg_restore --format=custom/.test(run.stdout)) {
      const error = new Error('the rollback output must refuse the down-migration and print the restore path');
      error.reason = 'rollback-runbook-shape-wrong';
      throw error;
    }
    const state = await registryHead();
    if (state.head !== releaseVersion) {
      const error = new Error('the rollback runbook must not change the registry');
      error.reason = 'rollback-mutated-registry';
      throw error;
    }
    return { exit: run.status, head: state.head };
  });

  emit('result', {
    ok: true,
    database,
    registryCount: total,
    headBefore: previousVersion,
    headAfter: releaseVersion,
    happyDowntimeWindowMs: happy.downtimeWindowMs,
    injectedExit: injected.exit,
  });
}

try {
  await main();
} catch {
  // step() already emitted the sanitized refusal; this boundary only guarantees
  // a non-zero exit for unexpected failures outside the step pipeline.
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
}
