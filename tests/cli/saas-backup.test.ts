import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saasBackup } from '../../src/cli/saas-backup.js';
import {
  getSaasBackupStatus,
  runSaasBackup,
  SaasBackupFailure,
  verifyPitrEvidence,
} from '../../src/saas/backup/service.js';
import { backupPolicySchema } from '../../src/saas/backup/types.js';
import { SAAS_MIGRATIONS } from '../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool } from '../../src/saas/db/types.js';
import { backupToolFixture, policyFixture } from '../saas/backup/helpers.js';

function fakePool(locked = true): SaasDatabasePool {
  const query: SaasDatabaseClient['query'] = async <Row>() => ({ rows: [{ locked }] as Row[], rowCount: 1 });
  return { query, connect: async () => ({ query, release() {} }), end: async () => undefined };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'model-router-backup-unit-'));
  const policy = policyFixture(directory, 'external-pitr');
  const file = join(directory, 'policy.json');
  await writeFile(file, JSON.stringify(policy));
  const env = {
    MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL: `postgresql://fixture@127.0.0.1:55889/model_router_test_backup_unit?sslmode=disable`,
  };
  return { directory, policy, file, env };
}

test('backup policy requires an explicit feasible RPO, KMS material and safe adapter argv', () => {
  const valid = policyFixture('/private/fixture');
  assert.ok(backupPolicySchema.safeParse(valid).success);
  assert.equal(backupPolicySchema.safeParse({ ...valid, rpoSeconds: 100 }).success, false);
  assert.equal(backupPolicySchema.safeParse({ ...valid, stateDirectory: 'relative' }).success, false);
  assert.equal(backupPolicySchema.safeParse({ ...valid, kms: { ...valid.kms, requiredKeyIds: [] } }).success, false);
  assert.equal(
    backupPolicySchema.safeParse({
      ...valid,
      kms: { ...valid.kms, recoveryCheck: { argv: ['/bin/sh', '-c', 'operation'], envNames: [] } },
    }).success,
    false,
  );
  if (valid.mode === 'pg-dump') {
    assert.equal(
      backupPolicySchema.safeParse({
        ...valid,
        offsite: { ...valid.offsite, endpoint: 'https://user:password@offsite.invalid' },
      }).success,
      false,
    );
  }
});

test('no policy returns an unprotected status and never claims that SQLite covers SaaS', async () => {
  const status = await getSaasBackupStatus({}, { env: {} });
  assert.equal(status.configured, false);
  assert.deepEqual(status.readiness.reasons, ['BACKUP_POLICY_REQUIRED']);
  const output: string[] = [];
  const result = await saasBackup('run', {}, { env: {}, writeLine: (line) => output.push(line) });
  assert.equal(result.exitCode, 1);
  assert.match(output.join(''), /local V2 SQLite backups do not protect SaaS PostgreSQL/);
});

test('fresh external PITR creates durable evidence without any pg_dump or upload', async () => {
  const item = await fixture();
  try {
    const tools = backupToolFixture();
    const result = await runSaasBackup(
      { policyFile: item.file, allowLocalPlaintext: true },
      {
        env: item.env,
        execute: tools.execute,
        createPool: () => fakePool(),
      },
    );
    assert.equal(result.status, 'protected');
    assert.equal(result.receipt.archive, null);
    assert.equal(result.receipt.pitr?.walArchiveVerified, true);
    assert.deepEqual(
      tools.calls.map((call) => call[0]),
      ['/fixture/verify-kms', '/fixture/verify-pitr'],
    );
    const durable = JSON.parse(await readFile(join(item.directory, `${result.receipt.id}.backup.json`), 'utf8'));
    assert.equal(durable.id, result.receipt.id);
    const status = await getSaasBackupStatus({ policyFile: item.file }, { env: item.env });
    assert.equal(status.latestBackup?.offsiteVerified, true);
    assert.deepEqual(status.readiness.reasons, ['RESTORE_VERIFICATION_REQUIRED']);
    const due = await runSaasBackup(
      { policyFile: item.file, allowLocalPlaintext: true, ifDue: true },
      {
        env: item.env,
        execute: tools.execute,
        createPool: () => fakePool(),
      },
    );
    assert.equal(due.status, 'not-due');
    assert.equal(tools.calls.length, 2);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('stale PITR and missing KMS recovery keys persist failure without a success receipt', async () => {
  for (const kind of ['pitr', 'kms']) {
    const item = await fixture();
    try {
      const tools = backupToolFixture();
      if (kind === 'pitr') tools.lagPitr(4000);
      else tools.missingRecoveryKey();
      await assert.rejects(
        runSaasBackup(
          { policyFile: item.file, allowLocalPlaintext: true },
          {
            env: item.env,
            execute: tools.execute,
            createPool: () => fakePool(),
          },
        ),
        SaasBackupFailure,
      );
      assert.equal(
        (await readdir(item.directory)).some((name) => name.endsWith('.backup.json')),
        false,
      );
      const attempt = JSON.parse(await readFile(join(item.directory, 'latest-attempt.json'), 'utf8'));
      assert.equal(attempt.status, 'failed');
      const status = await getSaasBackupStatus({ policyFile: item.file }, { env: item.env });
      assert.ok(status.readiness.reasons.includes('LATEST_BACKUP_ATTEMPT_FAILED'));
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  }
});

test('PITR coverage refuses mismatched source, replayed challenge and retention below policy', () => {
  const policy = policyFixture('/private/fixture', 'external-pitr');
  const now = Date.now();
  const challenge = randomUUID();
  const evidence = {
    format: 'saas-pitr-evidence-v1' as const,
    sourceId: policy.sourceId,
    challenge,
    observedAt: new Date(now).toISOString(),
    earliestRecoverableAt: new Date(now - 3600_000).toISOString(),
    latestRecoverableAt: new Date(now).toISOString(),
    baseBackupReference: 'provider:base',
    repositoryReference: 'provider:repository',
    walArchiveVerified: true as const,
    offsiteVerified: true as const,
    encrypted: true as const,
    encryptionKeyIds: ['fixture-recovery-key'],
    retentionDays: 30,
    evidenceSha256: 'a'.repeat(64),
  };
  verifyPitrEvidence(policy, evidence, challenge, now);
  for (const change of [
    { sourceId: 'wrong-source' },
    { challenge: randomUUID() },
    { retentionDays: 1 },
    { encryptionKeyIds: [] },
  ]) {
    assert.throws(() => verifyPitrEvidence(policy, { ...evidence, ...change }, challenge, now), SaasBackupFailure);
  }
});

test('another operation lock owner prevents duplicate backups without invoking tools', async () => {
  const item = await fixture();
  try {
    const tools = backupToolFixture();
    await assert.rejects(
      runSaasBackup(
        { policyFile: item.file, allowLocalPlaintext: true },
        {
          env: item.env,
          execute: tools.execute,
          createPool: () => fakePool(false),
        },
      ),
      (error: unknown) => error instanceof SaasBackupFailure && error.code === 'BACKUP_IN_PROGRESS',
    );
    assert.equal(tools.calls.length, 0);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('control-plane reads only a sanitized projection and recomputes freshness after scheduler stops', async () => {
  const item = await fixture();
  const projectionDirectory = await mkdtemp(join(tmpdir(), 'model-router-backup-projection-'));
  try {
    const path = join(projectionDirectory, 'status.json');
    const tools = backupToolFixture();
    await runSaasBackup(
      { policyFile: item.file, allowLocalPlaintext: true },
      {
        env: { ...item.env, MODEL_ROUTER_SAAS_BACKUP_STATUS_FILE: path },
        execute: tools.execute,
        createPool: () => fakePool(),
      },
    );
    assert.equal((await lstat(path)).mode & 0o777, 0o640);
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes(item.env.MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL));
    assert.ok(!text.includes('recoveryCheck'));
    assert.ok(!text.includes('recoveryMaterialReference'));
    const env = { MODEL_ROUTER_SAAS_BACKUP_STATUS_FILE: path };
    const current = await getSaasBackupStatus({}, { env });
    assert.equal(current.latestBackup?.offsiteVerified, true);
    const later = await getSaasBackupStatus({}, { env, now: () => Date.now() + 4000_000 });
    assert.ok(later.readiness.reasons.includes('BACKUP_RPO_EXCEEDED'));
  } finally {
    await rm(item.directory, { recursive: true, force: true });
    await rm(projectionDirectory, { recursive: true, force: true });
  }
});

test('adapter failures do not leak child errors or credentials into CLI JSON', async () => {
  const item = await fixture();
  try {
    const secret = randomUUID();
    const output: string[] = [];
    const result = await saasBackup(
      'run',
      { policy: item.file, allowLocalPlaintext: true },
      {
        env: item.env,
        createPool: () => fakePool(),
        execute: async () => {
          throw new Error(`sensitive child output ${secret}`);
        },
        writeLine: (line) => output.push(line),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.ok(!output.join('').includes(secret));
    assert.equal(JSON.parse(output[0]).error.code, 'BACKUP_OPERATION_FAILED');
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('malformed COMPLIANCE retention and wrong offsite checksums cannot create a passing receipt', async () => {
  for (const malformed of ['date', 'checksum']) {
    const item = await fixture();
    try {
      await writeFile(item.file, JSON.stringify(policyFixture(item.directory)));
      const first = SAAS_MIGRATIONS[0];
      const query: SaasDatabaseClient['query'] = async <Row>(sql: string) => {
        let rows: unknown[] = [];
        if (sql.includes('pg_try_advisory_lock')) rows = [{ locked: true }];
        else if (sql.includes('pg_export_snapshot')) rows = [{ snapshot: '00000001-00000001-1' }];
        else if (sql.includes('information_schema.tables')) rows = [{ table_name: 'saas_schema_migrations' }];
        else if (sql.includes('count(*)::text AS rows')) rows = [{ rows: '1', digest_a: '1', digest_b: '2' }];
        else if (sql.includes('SELECT version, name, checksum'))
          rows = [
            {
              version: first.version,
              name: first.name,
              checksum: createHash('sha256').update(first.name).update('\0').update(first.sql).digest('hex'),
            },
          ];
        return { rows: rows as Row[], rowCount: rows.length };
      };
      const pool: SaasDatabasePool = {
        query,
        connect: async () => ({ query, release() {} }),
        end: async () => undefined,
      };
      const tools = backupToolFixture(async (argv) => {
        if (argv[0] === 'pg_dump')
          await writeFile(argv.find((arg) => arg.startsWith('--file='))?.slice(7) ?? '', 'unit mock archive');
        else assert.equal(argv[0], 'pg_restore');
        return '';
      });
      if (malformed === 'date') tools.wrongOffsiteRetention();
      else tools.wrongOffsiteChecksum();
      await assert.rejects(
        runSaasBackup(
          { policyFile: item.file, allowLocalPlaintext: true },
          {
            env: item.env,
            execute: tools.execute,
            createPool: () => pool,
          },
        ),
        (error: unknown) => error instanceof SaasBackupFailure && error.code === 'OFFSITE_VERIFICATION_FAILED',
      );
      assert.equal(
        (await readdir(item.directory)).some((name) => name.endsWith('.backup.json')),
        false,
      );
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  }
});
