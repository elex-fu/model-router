import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';

// OPS-01 (DOps plan §5.4) upgrade drill: a real migration upgrade on a
// disposable drill database — seeded older release (registry head N-1) →
// saas:upgrade happy path with a pg_dump backup point and a measured
// downtime window; a corrupted-template run must stop at the roles step with
// the database left migrated (safe to re-run); the re-run must heal the
// revoked-grant state; and --rollback-to must refuse the down-migration while
// printing the documented backup-restore path without touching the registry.
const { Client } = pg;
const ADMIN_ENV = 'MODEL_ROUTER_SAAS_DRILL_ADMIN_URL';
const REQUIRED = 'MODEL_ROUTER_SAAS_DRILL_UPGRADE_REQUIRED';
const TOOL = 'scripts/drills/upgrade.mjs';
const SAAS_SCHEMA = 'model_router_saas';

const adminUrl = process.env[ADMIN_ENV]?.trim();

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
    'use the designated CI service or an explicit non-default-port loopback cluster for the upgrade drill',
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
  readonly stdout: string;
}

function runTool(root: string, admin: string, args: readonly string[]): ToolRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', TOOL, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: process.env.TMPDIR, [ADMIN_ENV]: admin },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  assert.ifError(result.error);
  const events = (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, events, stdout: result.stdout ?? '' };
}

test('OPS-01 upgrade drill: real migration upgrade, roles-step failure stops safely, rerun heals, rollback refuses down-migration', {
  skip:
    process.env[REQUIRED] !== '1' && !adminUrl
      ? `set ${REQUIRED}=1 and ${ADMIN_ENV} (drill-scoped cluster administrator URL) to require the upgrade drill`
      : false,
  timeout: 600_000,
  concurrency: false,
}, async (t) => {
  assert.ok(adminUrl, 'the drill administrator URL is required once the drill is not skipped');
  const target = endpoint(adminUrl);
  const root = resolve(process.cwd());
  const scratch = mkdtempSync(join(tmpdir(), 'ops01-upgrade-drill-'));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const database = `model_router_test_drill_upgrade_${suffix}`;
  t.after(async () => {
    try {
      const maintenance = new Client({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: 'postgres',
        connectionTimeoutMillis: 5_000,
      });
      await maintenance.connect();
      try {
        await maintenance.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database],
        );
        await maintenance.query(`DROP DATABASE IF EXISTS "${database}"`);
        // Roles are cluster-global; return the disposable cluster to a clean
        // state for the next drill (same discipline as the deploy IT).
        await maintenance.query(
          'DROP ROLE IF EXISTS model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway, model_router_saas_validation_worker',
        );
      } finally {
        await maintenance.end();
      }
    } catch {
      // Best-effort scratch cleanup; the cluster itself is disposable.
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  const run = runTool(root, adminUrl, ['--database', database, '--workdir', scratch]);
  const result = run.events.find((event) => event.kind === 'result');
  const steps = run.events.filter((event) => event.kind === 'step');
  const stepNames = steps.map((event) => event.step);

  assert.equal(run.status, 0, `the upgrade drill must pass:\n${JSON.stringify(run.events, null, 2)}`);
  assert.ok(result?.ok === true, 'the drill result line must report ok');
  assert.deepEqual(stepNames, [
    'preflight',
    'seed',
    'happy-upgrade',
    'reseed',
    'inject',
    'inject-state',
    'ungrant',
    'heal',
    'rollback-refusal',
  ]);

  // Happy path: real downtime window measured and a backup archive taken.
  const happy = steps.find((event) => event.step === 'happy-upgrade');
  assert.ok(
    typeof happy?.downtimeWindowMs === 'number' && happy.downtimeWindowMs >= 0,
    'a downtime window is measured',
  );
  assert.equal(happy?.backupArchives, 1, 'exactly one pg_dump backup archive per upgrade run');
  assert.ok(typeof result?.registryCount === 'number' && result.registryCount >= 2);
  assert.ok(typeof result?.injectedExit === 'number' && result.injectedExit !== 0, 'the injected run exited non-zero');

  // Terminal database fact: the registry ended at the release head.
  const verify = new Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database,
    connectionTimeoutMillis: 5_000,
  });
  await verify.connect();
  let head: number | null = null;
  try {
    const state = await verify.query<{ head: number }>(
      `SELECT coalesce(max(version), 0)::int AS head FROM ${SAAS_SCHEMA}.saas_schema_migrations`,
    );
    head = state.rows[0]?.head ?? null;
  } finally {
    await verify.end();
  }
  assert.equal(head, result?.headAfter, 'the drill database ends at the release registry head');

  // Secret hygiene: the drill never prints connection strings or passwords.
  assert.ok(!run.stdout.includes('postgresql://'), 'no connection string may appear in the drill output');
  t.diagnostic(
    `upgrade drill passed on ${target.host}:${target.port}/${database} ` +
      `(registry ${result?.registryCount} migrations, ${result?.headBefore} → ${result?.headAfter}, ` +
      `happy downtime window ${happy?.downtimeWindowMs}ms)`,
  );
});
