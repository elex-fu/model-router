import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { ConfigV2 } from '../config/v2-schema.js';
import { ConfigServiceV2 } from '../config/v2-service.js';
import { SecretStore } from '../secrets/store.js';

type Manifest = {
  schemaVersion: number;
  id: string;
  createdAt: string;
  revision: number;
  configSha256: string;
  masterKeySha256: string;
  controlSha256: string;
  telemetrySha256: string;
  scope: string;
};
type Journal = {
  version: 1;
  configPath: string;
  dataDir: string;
  snapshot: string;
  phase: 'installing' | 'installed';
  snapshotSha256: [string, string, string, string];
};
const names = ['config.json', 'master.key', 'control.sqlite', 'telemetry.sqlite'] as const;
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const idPattern = /^bak_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function regular(file: string): void {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Unsafe file: ${file}`);
}
function privateDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${directory}`);
}
function durableWrite(file: string, contents: string): void {
  const temporary = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}
function replace(source: string, target: string, mode: number): void {
  const temporary = `${target}.restore-${randomUUID()}`;
  copyFileSync(source, temporary);
  const fd = openSync(temporary, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}
function removeSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${file}${suffix}`;
    if (existsSync(sidecar)) {
      regular(sidecar);
      unlinkSync(sidecar);
    }
  }
}
function database(file: string, required: string[]): void {
  regular(file);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error(`SQLite integrity failed: ${file}`);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const table of required) if (!tables.has(table)) throw new Error(`SQLite schema missing ${table}: ${file}`);
  } finally {
    db.close();
  }
}
async function copyDatabase(source: string, target: string): Promise<void> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
}
function noOpenHandles(files: string[]): void {
  const existing = files.filter(existsSync);
  if (!existing.length) return;
  try {
    const output = execFileSync('lsof', ['-F', 'p', '--', ...existing], { encoding: 'utf8', timeout: 5_000 });
    if (output.trim()) throw new Error('Restore requires the service fully stopped: open file handles detected');
  } catch (error) {
    if (error instanceof Error && error.message.includes('open file handles detected')) throw error;
    const failure = error as Error & { status?: number; stdout?: string; stderr?: string };
    if (failure.status !== 1 || failure.stdout?.trim() || failure.stderr?.trim())
      throw new Error('Cannot verify offline state with lsof; refusing restore');
  }
}
async function noListeners(config: ConfigV2): Promise<void> {
  for (const [bind, port] of [
    [config.server.bindAddress, config.server.port],
    [config.admin.bindAddress, config.admin.port],
  ] as const) {
    const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
    const listening = await new Promise<boolean>((resolveResult, reject) => {
      const socket = createConnection({ host, port });
      socket.setTimeout(400);
      socket.once('connect', () => {
        socket.destroy();
        resolveResult(true);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === 'ECONNREFUSED') resolveResult(false);
        else reject(new Error(`Cannot verify offline listener ${host}:${port}: ${error.message}`));
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error(`Cannot verify offline listener ${host}:${port}: timeout`));
      });
    });
    if (listening) throw new Error('Restore requires the service fully stopped: configured listener responds');
  }
}
async function validateConfig(file: string): Promise<ConfigV2> {
  regular(file);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const validation = await new ConfigServiceV2(file).validate(parsed);
  if (!validation.valid || !validation.config || validation.config.schemaVersion !== 2)
    throw new Error(`Invalid V2 backup/current configuration: ${validation.errors.map((e) => e.path).join(', ')}`);
  return validation.config;
}
function verifySecrets(control: string, key: string, config: ConfigV2): void {
  regular(key);
  if (readFileSync(key).length !== 32) throw new Error('Invalid master key length');
  const db = new Database(control, { readonly: true, fileMustExist: true });
  try {
    const secrets = new SecretStore(db, key);
    const ids = new Set<string>();
    for (const upstream of config.upstreams) {
      for (const credential of upstream.credentials)
        if (credential.secret.type === 'secret') ids.add(credential.secret.id);
      if (upstream.auth.clientSecret?.type === 'secret') ids.add(upstream.auth.clientSecret.id);
    }
    for (const id of ids) if (!secrets.get(id)) throw new Error(`Backup secret missing or undecryptable: ${id}`);
    for (const row of db.prepare('SELECT id FROM secrets').all() as Array<{ id: string }>)
      if (!secrets.get(row.id)) throw new Error(`Backup secret undecryptable: ${row.id}`);
  } finally {
    db.close();
  }
}
function locations(configPath: string, dataDir: string) {
  return {
    'config.json': configPath,
    'master.key': join(dataDir, 'master.key'),
    'control.sqlite': join(dataDir, 'control.sqlite'),
    'telemetry.sqlite': join(dataDir, 'logs.sqlite'),
  } as const;
}
function rollback(journal: Journal, marker: string): void {
  const files = locations(journal.configPath, journal.dataDir);
  noOpenHandles(Object.values(files).flatMap((file) => [file, `${file}-wal`, `${file}-shm`]));
  if (names.some((name, index) => sha(join(journal.snapshot, name)) !== journal.snapshotSha256[index]))
    throw new Error('Safety snapshot checksum mismatch; refusing automatic rollback');
  for (const name of ['control.sqlite', 'telemetry.sqlite'] as const) {
    removeSidecars(files[name]);
    replace(join(journal.snapshot, name), files[name], 0o600);
  }
  replace(join(journal.snapshot, 'master.key'), files['master.key'], 0o600);
  replace(join(journal.snapshot, 'config.json'), files['config.json'], 0o600);
  unlinkSync(marker);
}

/** Restore only an explicit, stopped V2 instance. A surviving journal is rolled back on retry. */
export async function offlineRestore(backupId: string, configArgument: string, expectedRevision: number) {
  if (!idPattern.test(backupId)) throw new Error('Invalid backup ID');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new Error('--expected-revision must be a positive integer');
  const configPath = resolve(configArgument);
  const marker = `${configPath}.restore-journal.json`;
  if (existsSync(marker)) {
    regular(marker);
    const journal = JSON.parse(readFileSync(marker, 'utf8')) as Journal;
    if (
      journal.version !== 1 ||
      journal.configPath !== configPath ||
      !isAbsolute(journal.snapshot) ||
      !isAbsolute(journal.dataDir) ||
      resolve(journal.snapshot) !== journal.snapshot ||
      dirname(journal.snapshot) !== journal.dataDir ||
      !/^restore-safety-[0-9a-f-]{36}$/.test(basename(journal.snapshot)) ||
      !Array.isArray(journal.snapshotSha256) ||
      journal.snapshotSha256.length !== 4 ||
      !journal.snapshotSha256.every((value) => /^[0-9a-f]{64}$/.test(value))
    )
      throw new Error('Invalid recovery journal; manual intervention required');
    privateDirectory(journal.snapshot);
    for (const name of names) regular(join(journal.snapshot, name));
    const savedConfig = await validateConfig(join(journal.snapshot, 'config.json'));
    if (resolve(dirname(configPath), savedConfig.storage.dataDir) !== journal.dataDir)
      throw new Error('Recovery journal data directory does not match snapshot configuration');
    await noListeners(savedConfig);
    rollback(journal, marker);
    throw new Error(`Interrupted restore rolled back from ${journal.snapshot}; rerun restore to continue`);
  }
  const current = await validateConfig(configPath);
  if (current.revision !== expectedRevision) throw new Error('Configuration revision conflict');
  const dataDir = resolve(dirname(configPath), current.storage.dataDir);
  privateDirectory(dataDir);
  if (dataDir === resolve('/') || dataDir === dirname(dataDir)) throw new Error('Unsafe data directory');
  const files = locations(configPath, dataDir);
  for (const file of Object.values(files)) regular(file);
  const backup = join(dataDir, 'admin-backups', backupId);
  privateDirectory(join(dataDir, 'admin-backups'));
  privateDirectory(backup);
  for (const name of [...names, 'manifest.json'] as const) regular(join(backup, name));
  const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')) as Manifest;
  const digest = /^[0-9a-f]{64}$/;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== backupId ||
    manifest.scope !== 'config-secrets-control-telemetry' ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 1 ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    ![manifest.configSha256, manifest.masterKeySha256, manifest.controlSha256, manifest.telemetrySha256].every((item) =>
      digest.test(item),
    )
  )
    throw new Error('Invalid backup manifest');
  const expected = [manifest.configSha256, manifest.masterKeySha256, manifest.controlSha256, manifest.telemetrySha256];
  if (names.some((name, index) => sha(join(backup, name)) !== expected[index]))
    throw new Error('Backup checksum verification failed');
  const backed = await validateConfig(join(backup, 'config.json'));
  if (backed.revision !== manifest.revision || resolve(dirname(configPath), backed.storage.dataDir) !== dataDir)
    throw new Error('Backup revision or data directory does not match target');
  database(join(backup, 'control.sqlite'), ['users', 'secrets', 'config_history']);
  database(join(backup, 'telemetry.sqlite'), ['requests', 'attempts']);
  verifySecrets(join(backup, 'control.sqlite'), join(backup, 'master.key'), backed);
  await noListeners(current);
  await noListeners(backed);
  noOpenHandles(Object.values(files).flatMap((file) => [file, `${file}-wal`, `${file}-shm`]));

  const snapshot = join(dataDir, `restore-safety-${randomUUID()}`);
  mkdirSync(snapshot, { mode: 0o700 });
  const staged = join(snapshot, 'staged');
  mkdirSync(staged, { mode: 0o700 });
  let journalWritten = false;
  try {
    copyFileSync(configPath, join(snapshot, 'config.json'));
    copyFileSync(files['master.key'], join(snapshot, 'master.key'));
    await copyDatabase(files['control.sqlite'], join(snapshot, 'control.sqlite'));
    await copyDatabase(files['telemetry.sqlite'], join(snapshot, 'telemetry.sqlite'));
    for (const name of names) copyFileSync(join(backup, name), join(staged, name));
    if (names.some((name, index) => sha(join(staged, name)) !== expected[index]))
      throw new Error('Backup changed while staging; refusing restore');
    database(join(snapshot, 'control.sqlite'), ['users', 'secrets', 'config_history']);
    database(join(snapshot, 'telemetry.sqlite'), ['requests', 'attempts']);
    noOpenHandles(Object.values(files).flatMap((file) => [file, `${file}-wal`, `${file}-shm`]));
    const snapshotSha256 = names.map((name) => sha(join(snapshot, name))) as Journal['snapshotSha256'];
    durableWrite(
      marker,
      JSON.stringify({
        version: 1,
        configPath,
        dataDir,
        snapshot,
        phase: 'installing',
        snapshotSha256,
      } satisfies Journal),
    );
    journalWritten = true;
    // Invalid JSON is a fail-closed startup barrier until every other file is installed.
    durableWrite(configPath, '{"restoreInProgress":true}');
    for (const name of ['control.sqlite', 'telemetry.sqlite'] as const) {
      removeSidecars(files[name]);
      replace(join(staged, name), files[name], 0o600);
    }
    replace(join(staged, 'master.key'), files['master.key'], 0o600);
    replace(join(staged, 'config.json'), configPath, 0o600);
    durableWrite(
      marker,
      JSON.stringify({
        version: 1,
        configPath,
        dataDir,
        snapshot,
        phase: 'installed',
        snapshotSha256,
      } satisfies Journal),
    );
    unlinkSync(marker);
    return {
      backupId,
      revision: backed.revision,
      scope: manifest.scope,
      restored: ['config', 'master.key', 'control.sqlite', 'logs.sqlite'],
      safetySnapshot: snapshot,
    };
  } catch (error) {
    if (journalWritten) {
      try {
        rollback(
          {
            version: 1,
            configPath,
            dataDir,
            snapshot,
            phase: 'installing',
            snapshotSha256: names.map((name) => sha(join(snapshot, name))) as Journal['snapshotSha256'],
          },
          marker,
        );
      } catch (recoveryError) {
        throw new Error(
          `Restore failed and rollback needs manual recovery from ${snapshot}: ${String(recoveryError)}`,
          { cause: error },
        );
      }
    } else rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}
