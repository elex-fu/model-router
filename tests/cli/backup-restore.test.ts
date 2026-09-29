import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import { unusedLoopbackPorts } from './loopback-ports.js';

const exec = promisify(execFile);
async function cli(...args: string[]) {
  try {
    const value = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: process.cwd(),
    });
    return { code: 0, stdout: value.stdout, stderr: value.stderr };
  } catch (error) {
    const failure = error as Error & { code: number; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}
async function fixture() {
  const ports = await unusedLoopbackPorts();
  const dir = mkdtempSync(join(tmpdir(), 'mr-backup-restore-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'restore-test');
  config.server.port = ports.server;
  config.server.publicProxyBaseUrl = `http://127.0.0.1:${ports.server}`;
  config.admin.port = ports.admin;
  config.admin.publicAdminBaseUrl = `http://127.0.0.1:${ports.admin}`;
  config.storage.dataDir = dir;
  writeFileSync(configPath, JSON.stringify(config));
  const control = new ControlStore(dir);
  control.close();
  const telemetry = new SQLiteTelemetryStore(join(dir, 'logs.sqlite'));
  await telemetry.init();
  await telemetry.close();
  const created = await cli('backup:create', '--config', configPath);
  assert.equal(created.code, 0, created.stderr);
  const backup = JSON.parse(created.stdout) as { backupId: string; path: string };
  return { dir, configPath, backup, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('offline restore reinstates config, key and both SQLite databases', async () => {
  const f = await fixture();
  try {
    const originalKey = readFileSync(join(f.dir, 'master.key'));
    const edited = JSON.parse(readFileSync(f.configPath, 'utf8')) as ReturnType<typeof defaultConfigV2>;
    edited.revision = 2;
    edited.server.maxAttempts = 3;
    writeFileSync(f.configPath, JSON.stringify(edited));
    writeFileSync(join(f.dir, 'master.key'), randomBytes(32));
    for (const name of ['control.sqlite', 'logs.sqlite']) {
      const db = new Database(join(f.dir, name));
      db.exec('CREATE TABLE after_backup (id INTEGER)');
      db.close();
    }
    const result = await cli('backup:restore', f.backup.backupId, '--config', f.configPath, '--expected-revision', '2');
    assert.equal(result.code, 0, result.stderr);
    const reported = JSON.parse(result.stdout) as { scope: string; safetySnapshot: string; restored: string[] };
    assert.equal(reported.scope, 'config-secrets-control-telemetry');
    assert.deepEqual(reported.restored, ['config', 'master.key', 'control.sqlite', 'logs.sqlite']);
    assert.equal(existsSync(reported.safetySnapshot), true);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).revision, 1);
    assert.deepEqual(readFileSync(join(f.dir, 'master.key')), originalKey);
    for (const name of ['control.sqlite', 'logs.sqlite']) {
      assert.equal(existsSync(join(f.dir, `${name}-wal`)), false);
      assert.equal(existsSync(join(f.dir, `${name}-shm`)), false);
      const db = new Database(join(f.dir, name), { readonly: true });
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='after_backup'").get(), undefined);
      db.close();
    }
    assert.equal(existsSync(`${f.configPath}.restore-journal.json`), false);
  } finally {
    f.close();
  }
});

test('tampered backup or stale CAS refuses without changing current state', async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.configPath);
    const stale = await cli('backup:restore', f.backup.backupId, '--config', f.configPath, '--expected-revision', '2');
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /revision conflict/);
    writeFileSync(join(f.backup.path, 'telemetry.sqlite'), 'corrupt');
    const tampered = await cli(
      'backup:restore',
      f.backup.backupId,
      '--config',
      f.configPath,
      '--expected-revision',
      '1',
    );
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /checksum/);
    assert.deepEqual(readFileSync(f.configPath), original);
    assert.equal(existsSync(`${f.configPath}.restore-journal.json`), false);
  } finally {
    f.close();
  }
});

test('matching checksums cannot hide undecryptable backup secrets', async () => {
  const f = await fixture();
  try {
    const controlPath = join(f.backup.path, 'control.sqlite');
    const db = new Database(controlPath);
    db.prepare(`INSERT INTO secrets(id,nonce,ciphertext,tag,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(
      'bad-secret',
      randomBytes(12),
      randomBytes(16),
      randomBytes(16),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    const manifestPath = join(f.backup.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { controlSha256: string };
    manifest.controlSha256 = createHash('sha256').update(readFileSync(controlPath)).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const refused = await cli(
      'backup:restore',
      f.backup.backupId,
      '--config',
      f.configPath,
      '--expected-revision',
      '1',
    );
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).revision, 1);
    assert.equal(existsSync(`${f.configPath}.restore-journal.json`), false);
  } finally {
    f.close();
  }
});

test('responding configured listener refuses offline restore', async () => {
  const f = await fixture();
  const listener = createServer((_request, response) => {
    response.end('running');
  });
  try {
    const config = JSON.parse(readFileSync(f.configPath, 'utf8')) as ReturnType<typeof defaultConfigV2>;
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    config.server.port = (listener.address() as { port: number }).port;
    writeFileSync(f.configPath, JSON.stringify(config));
    const refused = await cli(
      'backup:restore',
      f.backup.backupId,
      '--config',
      f.configPath,
      '--expected-revision',
      '1',
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /fully stopped/);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    f.close();
  }
});

test('interrupted restore journal rolls back from verified safety snapshot before retry', async () => {
  const f = await fixture();
  try {
    const snapshot = join(f.dir, `restore-safety-${randomUUID()}`);
    mkdirSync(snapshot, { mode: 0o700 });
    const source = [f.configPath, join(f.dir, 'master.key'), join(f.dir, 'control.sqlite'), join(f.dir, 'logs.sqlite')];
    const names = ['config.json', 'master.key', 'control.sqlite', 'telemetry.sqlite'];
    for (let i = 0; i < names.length; i++) {
      if (i < 2) copyFileSync(source[i], join(snapshot, names[i]));
      else {
        const db = new Database(source[i], { readonly: true });
        await db.backup(join(snapshot, names[i]));
        db.close();
      }
    }
    const snapshotSha256 = names.map((name) =>
      createHash('sha256')
        .update(readFileSync(join(snapshot, name)))
        .digest('hex'),
    );
    writeFileSync(
      `${f.configPath}.restore-journal.json`,
      JSON.stringify({
        version: 1,
        configPath: f.configPath,
        dataDir: f.dir,
        snapshot,
        phase: 'installing',
        snapshotSha256,
      }),
    );
    writeFileSync(f.configPath, '{"restoreInProgress":true}');
    writeFileSync(join(f.dir, 'master.key'), randomBytes(32));
    const recovered = await cli(
      'backup:restore',
      f.backup.backupId,
      '--config',
      f.configPath,
      '--expected-revision',
      '1',
    );
    assert.equal(recovered.code, 1);
    assert.match(recovered.stderr, /rolled back/);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).revision, 1);
    assert.deepEqual(readFileSync(join(f.dir, 'master.key')), readFileSync(join(snapshot, 'master.key')));
    assert.equal(existsSync(`${f.configPath}.restore-journal.json`), false);
  } finally {
    f.close();
  }
});
