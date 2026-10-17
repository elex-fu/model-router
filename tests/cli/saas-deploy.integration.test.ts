import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS } from '../../src/saas/db/runtime-privileges.js';

// DOps plan §2.4 acceptance: the full saas:deploy sequence on a disposable
// PostgreSQL — from an empty database to three green runtime probes — plus the
// P15b fault injection: revoking one granted column must make single-role
// verification exit non-zero with the exact table/column/privilege named.
//
// Required environment (disposable cluster; never a developer's real database):
//   MODEL_ROUTER_SAAS_DEPLOY_IT_ADMIN_URL — administrator URL (database
//   "postgres") on the designated CI service or an explicit non-default-port
//   loopback cluster. The test creates and drops its own scratch database.
const { Client } = pg;
const ADMIN_ENV = 'MODEL_ROUTER_SAAS_DEPLOY_IT_ADMIN_URL';
const REQUIRED = 'MODEL_ROUTER_SAAS_DEPLOY_IT_REQUIRED';
const adminUrl = process.env[ADMIN_ENV]?.trim();

interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | undefined;
  readonly ci: boolean;
}

function endpoint(raw: string): Endpoint {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/, '').toLowerCase();
  const port = url.port ? Number(url.port) : 5432;
  const ci = hostname === 'postgres' && port === 5432;
  const loopback =
    ['127.0.0.1', '::1', 'localhost'].includes(hostname) && Boolean(url.port) && ![5432, 6432].includes(port);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'the administrator URL must be PostgreSQL');
  assert.ok(url.username, 'the administrator URL must name a user');
  assert.equal(
    decodeURIComponent(url.pathname.slice(1)),
    'postgres',
    'the administrator URL targets the maintenance database',
  );
  assert.ok(
    ci || loopback,
    'use the designated CI service or an explicit non-default-port loopback cluster for saas:deploy integration testing',
  );
  return {
    host: hostname,
    port,
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ci,
  };
}

function runDeploy(envFile: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', 'saas:deploy', '--env-file', envFile, ...args],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    },
  );
}

test('saas:deploy integration: empty database to three green probes, idempotent rerun, P15b fault injection', {
  skip:
    process.env[REQUIRED] !== '1' && !adminUrl
      ? `set ${REQUIRED}=1 and ${ADMIN_ENV} (disposable cluster administrator URL) to run the saas:deploy integration test`
      : false,
  timeout: 600_000,
}, async (t) => {
  assert.ok(adminUrl, 'the administrator URL is required once the test is not skipped');
  const target = endpoint(adminUrl);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const database = `model_router_test_saas_deploy_${suffix}`;
  const scratch = mkdtempSync(join(tmpdir(), 'saas-deploy-it-'));
  const envFile = join(scratch, 'deploy.env');
  const rolePassword = (role: string): string => `${role}-${suffix}-it-password`;
  const clients: Array<InstanceType<typeof Client>> = [];

  const connect = async (dbname: string): Promise<InstanceType<typeof Client>> => {
    const client = new Client({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: dbname,
      connectionTimeoutMillis: 5_000,
    });
    clients.push(client);
    await client.connect();
    return client;
  };

  t.after(async () => {
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.end();
        } catch {
          // A client whose database was dropped may already be dead.
        }
      }),
    );
    try {
      const maintenance = await connect('postgres');
      try {
        await maintenance.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database],
        );
        await maintenance.query(`DROP DATABASE IF EXISTS "${database}"`);
        // Roles are cluster-global; dropping them returns the disposable cluster
        // to a true cold-start state for the next run.
        await maintenance.query(
          'DROP ROLE IF EXISTS model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway, model_router_saas_validation_worker',
        );
      } finally {
        // This client is created after the bulk close above; it must be ended
        // or its socket keeps the test child's event loop alive forever.
        await maintenance.end();
      }
    } catch {
      // Best-effort scratch cleanup; the cluster itself is disposable.
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  // Fresh scratch database: no roles, no schema, no migrations.
  const provision = await connect('postgres');
  await provision.query(`DROP DATABASE IF EXISTS "${database}"`);
  await provision.query(`CREATE DATABASE "${database}"`);

  const roleUrl = (role: string): string =>
    `postgresql://${role}:${encodeURIComponent(rolePassword(role))}@${target.host}:${target.port}/${database}?sslmode=disable`;
  const adminTargetUrl = (): string => {
    const credentials =
      target.password === undefined ? target.user : `${target.user}:${encodeURIComponent(target.password)}`;
    return `postgresql://${credentials}@${target.host}:${target.port}/${database}?sslmode=disable`;
  };
  writeFileSync(
    envFile,
    [
      '# saas:deploy integration fixture (disposable cluster)',
      `MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL=${adminTargetUrl()}`,
      `MODEL_ROUTER_SAAS_DATABASE_URL=${roleUrl('model_router_saas_migrator')}`,
      `MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=${roleUrl('model_router_saas_control_plane')}`,
      `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=${roleUrl('model_router_saas_gateway')}`,
      `MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=${roleUrl('model_router_saas_validation_worker')}`,
      'MODEL_ROUTER_SAAS_REDIS_URL=redis://127.0.0.1:6399',
      'MODEL_ROUTER_SAAS_REDIS_PROVIDER=/trusted/modules/redis-provider.mjs',
      'MODEL_ROUTER_SAAS_KMS_PROVIDER=/trusted/modules/credential-provider.mjs',
      'SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE=/trusted/modules/gateway-decrypt.mjs',
      'MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE=/trusted/modules/gateway-runtime.mjs',
      'SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE=/trusted/modules/worker-decrypt.mjs',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  // [1] Full cold start: empty database -> migrate -> templates -> probes.
  const first = runDeploy(envFile, ['--allow-local-plaintext', '--verbose']);
  assert.ifError(first.error);
  const firstOut = `${first.stdout ?? ''}\n${first.stderr ?? ''}`;
  assert.equal(first.status, 0, `the first saas:deploy run must succeed:\n${firstOut}`);
  assert.match(firstOut, /schema model_router_saas absent \(fresh deployment\)/);
  assert.match(firstOut, /bootstrap ok/);
  assert.match(firstOut, /model_router_saas_control_plane: runtime privilege probe green/);
  assert.match(firstOut, /model_router_saas_gateway: runtime privilege probe green/);
  assert.match(firstOut, /model_router_saas_validation_worker: runtime privilege probe green/);
  assert.match(firstOut, /saas:deploy report ok in \d+ms — deployed/);
  // Secret hygiene: no fixture password value is ever printed.
  for (const role of [
    'model_router_saas_migrator',
    'model_router_saas_control_plane',
    'model_router_saas_gateway',
    'model_router_saas_validation_worker',
  ]) {
    assert.ok(!firstOut.includes(rolePassword(role)), 'no role password value may appear in the output');
  }
  if (target.password !== undefined) {
    assert.ok(!firstOut.includes(target.password), 'the administrator password may not appear in the output');
  }

  // The cold start initialized every login password (roles were created by
  // this run; the templates themselves never set credentials). pg_roles masks
  // rolpassword as ********, so the superuser-only pg_authid catalog is used.
  const passwordState = await connect(database);
  const roleNames = [
    'model_router_saas_migrator',
    'model_router_saas_control_plane',
    'model_router_saas_gateway',
    'model_router_saas_validation_worker',
  ];
  const roles = await passwordState.query<{ rolname: string; rolpassword: string }>(
    'SELECT rolname, rolpassword FROM pg_catalog.pg_authid WHERE rolname = ANY($1) ORDER BY rolname',
    [roleNames],
  );
  assert.equal(roles.rows.length, 4, 'the deployment created all four least-privilege logins');
  for (const row of roles.rows) {
    assert.ok(row.rolpassword?.startsWith('SCRAM-'), `${row.rolname} received a password`);
  }
  const passwordsBeforeRerun = roles.rows.map((row) => `${row.rolname}:${row.rolpassword}`);

  // [2] Idempotent rerun: everything is a no-op bootstrap and succeeds again.
  const second = runDeploy(envFile, ['--allow-local-plaintext']);
  assert.ifError(second.error);
  const secondOut = `${second.stdout ?? ''}\n${second.stderr ?? ''}`;
  assert.equal(second.status, 0, `the idempotent rerun must succeed:\n${secondOut}`);
  assert.match(secondOut, /bootstrap skipped/);
  assert.match(secondOut, /probe green/);

  const afterRerun = await connect(database);
  const passwordsAfterRerun = (
    await afterRerun.query<{ rolname: string; rolpassword: string }>(
      'SELECT rolname, rolpassword FROM pg_catalog.pg_authid WHERE rolname = ANY($1) ORDER BY rolname',
      [roleNames],
    )
  ).rows.map((row) => `${row.rolname}:${row.rolpassword}`);
  assert.deepEqual(passwordsAfterRerun, passwordsBeforeRerun, 'an existing deployment never has its passwords reset');

  // [3] P15b fault injection: revoke one granted column and re-run
  // single-role verification — it must fail non-zero naming the exact
  // table/column/privilege (full-deploy template replay would heal it, so
  // the interception point is the per-role verify mode).
  const [grantedTable, grantedColumn] = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS[0];
  await afterRerun.query(
    `REVOKE SELECT ("${grantedColumn}") ON model_router_saas."${grantedTable}" FROM model_router_saas_control_plane`,
  );
  const injected = runDeploy(envFile, ['--allow-local-plaintext', '--role', 'control-plane']);
  assert.ifError(injected.error);
  const injectedOut = `${injected.stdout ?? ''}\n${injected.stderr ?? ''}`;
  assert.notEqual(injected.status, 0, 'single-role verification must fail after a column grant is revoked');
  assert.match(injectedOut, /the model_router_saas_control_plane runtime privilege probe failed/);
  assert.match(injectedOut, new RegExp(`Missing grants:.*${grantedTable}\\.${grantedColumn}:SELECT`));

  t.diagnostic(
    `saas:deploy integration passed on ${target.host}:${target.port}/${database} (P15b column: ${grantedTable}.${grantedColumn})`,
  );
});
