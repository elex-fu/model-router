import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createSaasDeployPool, validateDatabaseUrl } from '../../src/cli/saas-deploy-shared.js';
import {
  executeBackupCommand,
  getSaasBackupStatus,
  protectSaasUpgrade,
  runSaasBackup,
  SaasBackupFailure,
  verifySaasBackupRestore,
} from '../../src/saas/backup/service.js';
import { runSaasMigrations } from '../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../../src/saas/db/migrations/001_initial_schema.js';
import { backupToolFixture, policyFixture } from '../saas/backup/helpers.js';

const exec = promisify(execFile);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

test('self-owned PostgreSQL backup downloads its offsite version and restores only a new disposable database', {
  skip:
    process.env.SAAS_BACKUP_ACCEPTANCE !== '1' ? 'set SAAS_BACKUP_ACCEPTANCE=1 with PostgreSQL tools on PATH' : false,
  timeout: 180_000,
}, async (context) => {
  // macOS's default per-user TMPDIR makes UNIX socket paths exceed 104 bytes.
  const scratch = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'mr-backup-'));
  const cluster = join(scratch, 'cluster');
  const socket = join(scratch, 'socket');
  const state = join(scratch, 'state');
  await mkdir(socket, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const port = await availablePort();
  const database = `model_router_test_backup_source_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  let started = false;
  let maintenance: Pool | undefined;
  try {
    await exec('initdb', [
      '--pgdata',
      cluster,
      '--auth=trust',
      '--username=backup_acceptance',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    try {
      await exec('pg_ctl', [
        '--pgdata',
        cluster,
        '--log',
        join(scratch, 'postgres.log'),
        '--options',
        `-h 127.0.0.1 -p ${port} -k ${socket}`,
        '--wait',
        'start',
      ]);
    } catch (error) {
      context.diagnostic(await readFile(join(scratch, 'postgres.log'), 'utf8'));
      throw error;
    }
    started = true;
    maintenance = new Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'backup_acceptance' });
    for (const role of [
      'model_router_saas_migrator',
      'model_router_saas_control_plane',
      'model_router_saas_gateway',
      'model_router_saas_validation_worker',
      'model_router_saas_plugin_host',
    ]) {
      await maintenance.query(`CREATE ROLE "${role}" NOLOGIN`);
    }
    await maintenance.query('ALTER ROLE model_router_saas_migrator LOGIN');
    await maintenance.query(`CREATE DATABASE "${database}"`);
    await maintenance.query(`ALTER DATABASE "${database}" SET search_path TO model_router_saas, public`);
    const url = `postgresql://backup_acceptance@127.0.0.1:${port}/${database}?sslmode=disable`;
    const bootstrap = createSaasDeployPool(url, {
      allowLocalPlaintext: true,
      applicationName: 'backup-owned-bootstrap',
    });
    // Use the deployment's actual default ACL/bootstrap contract. Historical
    // migration 054 correctly refuses PUBLIC executable trigger helpers.
    await bootstrap.query(await readFile('deploy/managed-saas-postgres-roles.sql', 'utf8'));
    await bootstrap.end();
    const migrator = new URL(url);
    migrator.username = 'model_router_saas_migrator';
    const source = createSaasDeployPool(migrator.toString(), {
      allowLocalPlaintext: true,
      applicationName: 'backup-owned-fixture',
    });
    try {
      await runSaasMigrations(source);
      // Extra owned data exercises value fingerprints beyond empty-schema and
      // migration counts, including an embedded quote and a bytea column.
      await source.query(
        'CREATE TABLE model_router_saas.backup_acceptance_payload (id integer PRIMARY KEY, body text, payload bytea)',
      );
      await source.query('INSERT INTO model_router_saas.backup_acceptance_payload VALUES ($1, $2, $3)', [
        1,
        'fixture recovery payload',
        Buffer.from(randomUUID()),
      ]);
    } finally {
      await source.end();
    }
    const policy = policyFixture(state);
    const policyFile = join(scratch, 'policy.json');
    await writeFile(policyFile, JSON.stringify(policy));
    const env = { MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL: url, MODEL_ROUTER_SAAS_BACKUP_POLICY_FILE: policyFile };
    const tools = backupToolFixture(executeBackupCommand);
    const dependencies = { env, execute: tools.execute };
    const backup = await runSaasBackup({ policyFile, allowLocalPlaintext: true }, dependencies);
    assert.equal(backup.status, 'protected');
    assert.ok(backup.receipt.archive);
    assert.equal(backup.receipt.archive.fingerprint.ledgerCount, SAAS_MIGRATIONS.length);
    assert.ok(
      backup.receipt.archive.fingerprint.tables.some(
        (table) => table.name === 'backup_acceptance_payload' && table.rows === '1',
      ),
    );
    assert.equal(tools.objects.size, 2, 'archive and backup receipt are separately verified offsite');
    const before = await getSaasBackupStatus({ policyFile }, { env });
    assert.ok(before.readiness.reasons.includes('RESTORE_VERIFICATION_REQUIRED'));
    await assert.rejects(
      protectSaasUpgrade(
        env,
        validateDatabaseUrl(url, {
          name: 'owned-source',
          allowLocalPlaintext: true,
        }),
        true,
      ),
      (error: unknown) => error instanceof SaasBackupFailure && error.code === 'RESTORE_VERIFICATION_REQUIRED',
    );
    const restore = await verifySaasBackupRestore(
      { policyFile, allowLocalPlaintext: true, backupId: backup.receipt.id },
      dependencies,
    );
    assert.equal(restore.fingerprintSha256, backup.receipt.archive.fingerprint.sha256);
    assert.equal(restore.productionAdmissionApproved, false);
    assert.equal(restore.cleanup, 'dropped-owned-database');
    const remaining = (
      await maintenance.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE 'model_router_test_backup_%'",
      )
    ).rows;
    assert.deepEqual(
      remaining.map((row) => row.datname),
      [database],
    );
    assert.ok(
      tools.calls.some((call) => call.includes('get-object')),
      'drill downloads the recorded remote version',
    );
    assert.equal((await getSaasBackupStatus({ policyFile }, { env })).readiness.ok, true);

    // Corruption is rejected before target creation, and cannot add a passing
    // restore receipt or remove/alter the source database.
    const receiptsBefore = (await readdir(state)).filter((name) => name.endsWith('.restore.json'));
    tools.corruptDownload();
    await assert.rejects(
      verifySaasBackupRestore({ policyFile, allowLocalPlaintext: true, backupId: backup.receipt.id }, dependencies),
      (error: unknown) => error instanceof SaasBackupFailure && error.code === 'ARCHIVE_CHECKSUM_MISMATCH',
    );
    assert.deepEqual(
      (await readdir(state)).filter((name) => name.endsWith('.restore.json')),
      receiptsBefore,
    );
    assert.equal((await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rows.length, 1);

    const server = await maintenance.query<{ version: string }>("SELECT current_setting('server_version') AS version");
    context.diagnostic(
      `PostgreSQL ${server.rows[0].version}; registry ${backup.receipt.archive.fingerprint.ledgerCount}; tables ${backup.receipt.archive.fingerprint.tables.length}; backup ${backup.receipt.id}; restore ${restore.id}; no shared cluster or database touched`,
    );
    if (process.env.SAAS_BACKUP_EVIDENCE_DIR) {
      const evidenceDirectory = process.env.SAAS_BACKUP_EVIDENCE_DIR;
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(evidenceDirectory, 'backup-receipt.json'),
        await readFile(join(state, `${backup.receipt.id}.backup.json`)),
      );
      await writeFile(
        join(evidenceDirectory, 'restore-receipt.json'),
        await readFile(join(state, `${restore.id}.restore.json`)),
      );
      await writeFile(
        join(evidenceDirectory, 'scope.json'),
        JSON.stringify(
          {
            postgresVersion: server.rows[0].version,
            nativePostgresBackupRestore: true,
            cloudObjectStoreAndKms: 'test-double',
            sourceDatabaseOwnedByThisTest: true,
            disposableRestoreDatabaseDropped: true,
            corruptArchiveRejected: true,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await maintenance?.end();
    if (started) await exec('pg_ctl', ['--pgdata', cluster, '--mode', 'fast', '--wait', 'stop']);
    await rm(scratch, { recursive: true, force: true });
  }
});
