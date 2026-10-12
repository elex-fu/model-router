#!/usr/bin/env node
// OPS-01 I1 backup/restore drill tool (Track I, fail-fast red line):
// pg_dump -> archive verification -> drop -> recreate -> pg_restore ->
// fingerprint comparison -> verifySaasMigrations -> optional read-only
// saas:migration-audit re-check, against ONE explicitly named drill database.
//
// Red lines:
//  - The source database is never dropped before the dump archive itself is
//    verified (pg_restore --list), so a corrupt dump cannot destroy data.
//  - Any failed step after the drop removes the half-restored database; the
//    tool never leaves a partially restored database behind.
//  - A post-restore fingerprint (migration ledger hash + exact per-table row
//    counts) that differs from the pre-drop source refuses the restore and
//    drops the target, so a foreign/mismatched dump cannot impersonate a
//    successful recovery.
//  - Child tool (pg_dump/pg_restore/psql/node) non-zero exits are never
//    swallowed; every failure exits 1 with a sanitized reason.
//  - The administrator URL arrives only via env; credentials never appear in
//    argv, stdout or markers. Only model_router_test_drill* databases and the
//    fixed CI/loopback targets are accepted.
//
// Drill databases are provisioned by the normal managed-saas path, so every
// SaaS object lives in the fixed `model_router_saas` schema; the fingerprint
// and the audit both address that schema explicitly (the administrator role
// carries no per-database search_path).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import pg from 'pg';

const { Client, Pool } = pg;
const SAAS_SCHEMA = 'model_router_saas';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}
const database = arg('database');
const workdir = arg('workdir');
const dumpFileOverride = arg('dump-file');
const audit = process.argv.includes('--audit');
const adminUrl = process.env.MODEL_ROUTER_SAAS_DRILL_ADMIN_URL;

const DRILL_DATABASE = /^model_router_test_drill[a-z0-9_]*$/;
if (!database || !DRILL_DATABASE.test(database) || !workdir || !adminUrl) {
  console.error(
    'usage: backup-restore --database model_router_test_drill* --workdir dir [--dump-file archive] [--audit] ' +
      '(env: MODEL_ROUTER_SAAS_DRILL_ADMIN_URL)',
  );
  process.exit(2);
}

let endpoint;
try {
  const url = new URL(adminUrl);
  const hostname = url.hostname.replace(/^\[|\]$/, '').toLowerCase();
  const port = url.port ? Number(url.port) : 5432;
  const ciTarget = hostname === 'postgres' && port === 5432;
  const localTarget = ['127.0.0.1', '::1', 'localhost'].includes(hostname) && Boolean(url.port) &&
    ![5432, 6432].includes(port);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || url.hash || url.search ||
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
  console.error('MODEL_ROUTER_SAAS_DRILL_ADMIN_URL must be a queryless PostgreSQL administrator URL ' +
    'for the CI service or an explicit non-default-port loopback cluster');
  process.exit(2);
}

const scratch = resolve(workdir);
mkdirSync(join(scratch, 'logs'), { recursive: true });
const dumpFile = dumpFileOverride ? resolve(dumpFileOverride) : join(scratch, `${database}.dump`);
if (!dumpFileOverride && !dumpFile.startsWith(scratch + sep)) {
  console.error('the dump archive must live inside the drill workdir');
  process.exit(2);
}

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

function targetClient() {
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

async function fingerprint(client) {
  const tables = (
    await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'model_router_saas' AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
  ).rows.map((row) => row.table_name);
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::text AS count FROM ${quoteIdent(SAAS_SCHEMA)}.${quoteIdent(table)}`);
    counts[table] = result.rows[0].count;
  }
  const ledger = (
    await client.query(
      `SELECT version, name, checksum FROM ${quoteIdent(SAAS_SCHEMA)}.saas_schema_migrations ORDER BY version ASC`,
    )
  ).rows;
  return {
    tableCount: tables.length,
    counts,
    ledgerCount: ledger.length,
    ledgerHash: createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),
  };
}

function sameFingerprint(source, restored) {
  return (
    source.tableCount === restored.tableCount &&
    source.ledgerCount === restored.ledgerCount &&
    source.ledgerHash === restored.ledgerHash &&
    JSON.stringify(source.counts) === JSON.stringify(restored.counts)
  );
}

// Run an external tool with credentials confined to the child environment.
// stderr is archived under the workdir; only the step name and exit status
// reach stdout. A non-zero exit is never swallowed.
function runTool(step, command, args, env) {
  const result = spawnSync(command, args, {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
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

let recreateStarted = false;
let targetDropped = false;

async function dropTarget() {
  const client = maintenanceClient();
  await client.connect();
  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
    targetDropped = true;
  } finally {
    await client.end();
  }
}

async function refuse(step, reason) {
  emit('refused', { step, reason });
  if (recreateStarted && !targetDropped) {
    try {
      await dropTarget();
      emit('cleanup', { dropped: true });
    } catch {
      // Honest unknown state: the half-restored database could not be removed.
      emit('cleanup', { dropped: false });
    }
  }
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

async function main() {
  // Preflight: the target must exist and the tools must be runnable before any
  // destructive step is considered.
  await step('preflight', async () => {
    runTool('pg_dump-version', 'pg_dump', ['--version'], {});
    runTool('pg_restore-version', 'pg_restore', ['--version'], {});
    const client = maintenanceClient();
    await client.connect();
    try {
      const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (found.rows.length !== 1) {
        const error = new Error('target drill database does not exist');
        error.reason = 'target-missing';
        throw error;
      }
      const version = await client.query("SELECT current_setting('server_version_num')::integer / 10000 AS version");
      return { serverMajor: version.rows[0].version };
    } finally {
      await client.end();
    }
  });

  const source = await step('fingerprint-source', async () => {
    const client = targetClient();
    await client.connect();
    try {
      return await fingerprint(client);
    } finally {
      await client.end();
    }
  });

  if (!dumpFileOverride) {
    await step('dump', async () => {
      runTool(
        'dump',
        'pg_dump',
        ['--format=custom', '--compress=6', '--file', dumpFile, database],
        pgEnv(database),
      );
      return { bytes: statSync(dumpFile).size };
    });
  }

  await step('verify-dump', async () => {
    const listing = runTool('verify-dump', 'pg_restore', ['--list', dumpFile], {});
    const entries = listing.split('\n').filter((line) => line.trim() !== '' && !line.startsWith(';')).length;
    if (entries < 1) {
      const error = new Error('dump archive lists no entries');
      error.reason = 'dump-invalid';
      throw error;
    }
    return { entries };
  });

  await step('recreate', async () => {
    recreateStarted = true;
    await dropTarget();
    targetDropped = false;
    const client = maintenanceClient();
    await client.connect();
    try {
      await client.query(`CREATE DATABASE ${quoteIdent(database)}`);
    } finally {
      await client.end();
    }
  });

  await step('restore', async () => {
    runTool('restore', 'pg_restore', ['--format=custom', '--exit-on-error', '--dbname', database, dumpFile], pgEnv(database));
  });

  await step('verify-restore', async () => {
    const client = targetClient();
    await client.connect();
    let restored;
    try {
      restored = await fingerprint(client);
    } catch {
      const error = new Error('restored database fingerprint unreadable');
      error.reason = 'fingerprint-mismatch';
      throw error;
    } finally {
      await client.end();
    }
    if (!sameFingerprint(source, restored)) {
      const error = new Error('restored fingerprint differs from the pre-drop source');
      error.reason = 'fingerprint-mismatch';
      throw error;
    }
    return { ledgerCount: restored.ledgerCount, tableCount: restored.tableCount };
  });

  await step('verify-migrations', async () => {
    const { verifySaasMigrations } = await import('../../src/saas/db/migrate.js');
    // The closed registry verification resolves the ledger through the
    // session search_path; pin it for this administrator connection.
    const pool = new Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: endpoint.user,
      password: endpoint.password,
      database,
      max: 1,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${SAAS_SCHEMA},public`,
    });
    pool.on('error', () => {});
    const adapter = {
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
    try {
      await verifySaasMigrations(adapter);
    } catch {
      const error = new Error('restored database fails the closed migration registry verification');
      error.reason = 'migration-registry-mismatch';
      throw error;
    } finally {
      await pool.end();
    }
  });

  let auditOutcome = 'skipped';
  if (audit) {
    const detail = await step('audit', async () => {
      const url = new URL(adminUrl);
      url.pathname = `/${database}`;
      const args = [
        '--import', 'tsx', 'src/cli/index.ts', 'saas:migration-audit',
        '--deployment-id', 'ops-01-drill',
        '--environment-id', 'backup-restore',
        '--database', database,
        '--schema', SAAS_SCHEMA,
        '--release-id', 'ops-01-drill-local',
      ];
      if (endpoint.loopback) {
        url.searchParams.set('sslmode', 'disable');
        args.push('--allow-local-plaintext');
      }
      // Blocked (exit 1) is a legitimate audit answer parsed below; only a
      // spawn error or exit 2 (usage/transport failure) refuses outright.
      const result = spawnSync(process.execPath, args, {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TMPDIR: process.env.TMPDIR,
          MODEL_ROUTER_SAAS_AUDIT_DATABASE_URL: url.toString(),
        },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.stderr) writeFileSync(join(scratch, 'logs', 'audit.stderr.log'), result.stderr);
      if (result.error || result.status === null || result.status > 1) {
        const error = new Error('migration audit subprocess failed');
        error.reason = 'audit-failed';
        throw error;
      }
      const stdout = result.stdout ?? '';
      const lastLine = stdout.split('\n').filter((line) => line.trim() !== '').at(-1) ?? '';
      let parsed = null;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        parsed = null;
      }
      // The drill supplies no reviewed catalog baseline, so the audit is
      // fail-closed: 'matched' is required, or exactly the baseline-missing
      // blocked shape with every ledger row matching. Anything else refuses.
      const report = parsed?.report ?? null;
      const baselineMissingOnly =
        parsed?.status === 'blocked' &&
        Array.isArray(parsed?.issues ?? report?.issues) &&
        (parsed?.issues ?? report?.issues).length === 1 &&
        (parsed?.issues ?? report?.issues)[0]?.code === 'BASELINE_MISSING' &&
        report?.compatibility === 'unverified' &&
        Array.isArray(report?.migrations) &&
        report.migrations.length > 0 &&
        report.migrations.every((migration) => migration?.state === 'match');
      if (
        parsed === null || parsed.format !== 'saas-migration-audit-command-v1' ||
        !(parsed.status === 'matched' || baselineMissingOnly)
      ) {
        const error = new Error('read-only migration audit did not match the restored database');
        error.reason = 'audit-unmatched';
        throw error;
      }
      return { audit: parsed.status === 'matched' ? 'matched' : 'ledger-matched-baseline-unverified' };
    });
    auditOutcome = detail?.audit ?? 'skipped';
  }

  emit('result', {
    ok: true,
    database,
    migrations: source.ledgerCount,
    tables: source.tableCount,
    ledgerHash: source.ledgerHash,
    audit: auditOutcome,
  });
}

try {
  await main();
} catch {
  // step() already emitted the sanitized refusal; this boundary only guarantees
  // a non-zero exit for unexpected failures outside the step pipeline.
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
}
