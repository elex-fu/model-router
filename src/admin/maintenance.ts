import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { ConfigV2 } from '../config/v2-schema.js';
import { ControlError, type ControlService } from '../control/service.js';
import type { ControlStore } from '../control/store.js';
import { SecretStore } from '../secrets/store.js';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import { AdminRollups, type RollupRebuildPlan } from './rollups.js';

type RollupWorkerMessage =
  | { kind: 'result'; plan: RollupRebuildPlan }
  | { kind: 'error'; message: string; status?: number; code?: string };

function computeRollupsInWorker(dbPath: string, signal: AbortSignal): Promise<RollupRebuildPlan> {
  if (signal.aborted) return Promise.reject(new Error('Aggregate cancelled'));
  return new Promise((resolve, reject) => {
    const sourceMode = __filename.endsWith('.ts');
    const entry = join(__dirname, sourceMode ? 'rollups-worker.ts' : 'rollups-worker.js');
    const worker = new Worker(entry, { workerData: { dbPath }, execArgv: sourceMode ? ['--require', 'tsx/cjs'] : [] });
    let message: RollupWorkerMessage | undefined;
    let workerError: Error | undefined;
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      // Wait for exit before settling. The worker owns only a read-only connection.
      void worker.terminate().catch((error: unknown) => {
        workerError = error instanceof Error ? error : new Error('Aggregate worker termination failed');
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.on('message', (value: RollupWorkerMessage) => {
      message = value;
    });
    worker.once('error', (error) => {
      workerError = error;
    });
    worker.once('exit', (code) => {
      signal.removeEventListener('abort', abort);
      if (cancelled || signal.aborted) reject(new Error('Aggregate cancelled'));
      else if (workerError) reject(workerError);
      else if (code !== 0) reject(new Error(`Aggregate worker exited with code ${code}`));
      else if (message?.kind === 'error')
        reject(
          message.code && message.status
            ? new ControlError(message.status, message.code, message.message)
            : new Error(message.message),
        );
      else if (message?.kind === 'result') resolve(message.plan);
      else reject(new Error('Aggregate worker exited without a result'));
    });
  });
}

interface BackupManifest {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  revision: number;
  configSha256: string;
  masterKeySha256: string;
  controlSha256: string;
  telemetrySha256?: string;
  scope: 'config-secrets-control-telemetry';
}
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^bak_[0-9a-f-]{36}$/.test(id);

export class AdminMaintenance {
  private readonly directory: string;
  private readonly keyPath: string;
  constructor(
    private readonly control: ControlService,
    private readonly store: ControlStore,
    private readonly telemetry?: SQLiteTelemetryStore,
  ) {
    this.directory = join(store.dataDir, 'admin-backups');
    this.keyPath = store.keyPath;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  async backup(signal: AbortSignal) {
    if (!this.telemetry)
      throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Complete backup requires a telemetry store');
    let telemetryDb: Database.Database;
    try {
      telemetryDb = this.telemetry.connection;
    } catch {
      throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Complete backup requires an initialized telemetry store');
    }
    if (!existsSync(this.keyPath))
      throw new ControlError(503, 'MASTER_KEY_FILE_UNAVAILABLE', 'Externally managed master key cannot be bundled');
    const config = await this.control.raw();
    const id = `bak_${randomUUID()}`;
    const destination = join(this.directory, id);
    mkdirSync(destination, { mode: 0o700 });
    const configText = JSON.stringify(config);
    writeFileSync(join(destination, 'config.json'), configText, { flag: 'wx', mode: 0o600 });
    // Preserve the encryption key only in the private backup directory. No static route reaches this directory.
    copyFileSync(this.keyPath, join(destination, 'master.key'));
    const key = readFileSync(this.keyPath);
    await this.store.db.backup(join(destination, 'control.sqlite'));
    if (signal.aborted) throw new Error('Backup cancelled');
    await telemetryDb.backup(join(destination, 'telemetry.sqlite'));
    const manifest: BackupManifest = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      revision: config.revision,
      configSha256: digest(configText),
      masterKeySha256: digest(key),
      controlSha256: await fileDigest(join(destination, 'control.sqlite')),
      telemetrySha256: await fileDigest(join(destination, 'telemetry.sqlite')),
      scope: 'config-secrets-control-telemetry',
    };
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    return {
      backupId: id,
      revision: config.revision,
      scope: manifest.scope,
      restoreMode: 'config-and-secrets-CAS',
      path: destination,
    };
  }

  async restore(backupId: unknown, expectedRevision: unknown, actor: string, signal: AbortSignal) {
    if (!validId(backupId)) throw new ControlError(400, 'INVALID_BACKUP_ID', 'Invalid backup ID');
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
      throw new ControlError(428, 'EXPECTED_REVISION_REQUIRED', 'Expected config revision is required');
    const destination = join(this.directory, backupId);
    if (!existsSync(join(destination, 'manifest.json')))
      throw new ControlError(404, 'BACKUP_NOT_FOUND', 'Backup not found');
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as BackupManifest;
    const configText = readFileSync(join(destination, 'config.json'), 'utf8');
    if (
      manifest.id !== backupId ||
      manifest.schemaVersion !== 1 ||
      digest(configText) !== manifest.configSha256 ||
      digest(readFileSync(this.keyPath)) !== manifest.masterKeySha256 ||
      digest(readFileSync(join(destination, 'master.key'))) !== manifest.masterKeySha256 ||
      (await fileDigest(join(destination, 'control.sqlite'))) !== manifest.controlSha256 ||
      (manifest.telemetrySha256 &&
        (await fileDigest(join(destination, 'telemetry.sqlite'))) !== manifest.telemetrySha256)
    )
      throw new ControlError(409, 'BACKUP_VERIFICATION_FAILED', 'Backup is corrupt or uses a different master key');
    const config = JSON.parse(configText) as ConfigV2;
    if ((await this.control.raw()).revision !== expectedRevision)
      throw new ControlError(412, 'CONFIG_REVISION_CONFLICT', 'Configuration changed since restore was requested');
    if (signal.aborted) throw new Error('Restore cancelled');
    const snapshot = new Database(join(destination, 'control.sqlite'), { readonly: true, fileMustExist: true });
    try {
      const backupSecrets = new SecretStore(snapshot, join(destination, 'master.key'));
      const refs = new Set<string>();
      for (const upstream of config.upstreams ?? []) {
        for (const credential of upstream.credentials)
          if (credential.secret.type === 'secret') refs.add(credential.secret.id);
        if (upstream.auth.clientSecret?.type === 'secret') refs.add(upstream.auth.clientSecret.id);
      }
      const missing: Array<{ id: string; value: string }> = [];
      for (const id of refs) {
        const original = backupSecrets.get(id);
        if (!original) throw new ControlError(409, 'BACKUP_SECRET_MISSING', `Backup secret ${id} is missing`);
        const current = this.store.secrets.get(id);
        if (current && current !== original)
          throw new ControlError(409, 'SECRET_CONFLICT', `Secret ${id} changed since backup; refusing overwrite`);
        if (!current) missing.push({ id, value: original });
      }
      for (const item of missing) this.store.secrets.put(item.id, item.value);
      const validation = await this.control.validate(config);
      if (!validation.valid)
        throw new ControlError(422, 'BACKUP_CONFIG_INVALID', 'Backup configuration is invalid', validation.errors);
      const committed = await this.control.commit(config, Number(expectedRevision), actor);
      this.store.audit(actor, 'backup.restore', {
        backupId,
        fromRevision: manifest.revision,
        toRevision: committed.config.revision,
        scope: 'config-and-secrets',
      });
      return {
        backupId,
        revision: committed.config.revision,
        restoredSecrets: missing.length,
        scope: 'config-and-secrets',
        telemetryRestored: false,
      };
    } finally {
      snapshot.close();
    }
  }

  purge(actor: string, retentionDays: number) {
    if (!this.telemetry) throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Telemetry store is required');
    const result = new AdminRollups(this.telemetry.connection).archiveAndPurge(Date.now() - retentionDays * 86_400_000);
    this.store.audit(actor, 'logs.purge', result);
    return result;
  }

  /** Refresh mutable UTC-day rollups without deleting frozen history. */
  async aggregate(actor: string, signal: AbortSignal) {
    if (!this.telemetry) throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Telemetry store is required');
    if (signal.aborted) throw new Error('Aggregate cancelled');
    const rollups = new AdminRollups(this.telemetry.connection);
    const dbPath = this.telemetry.connection.name;
    if (dbPath === ':memory:' || !dbPath)
      throw new ControlError(
        503,
        'FILE_BACKED_TELEMETRY_REQUIRED',
        'Worker aggregation requires a file-backed telemetry store',
      );
    const plan = await computeRollupsInWorker(dbPath, signal);
    if (signal.aborted) throw new Error('Aggregate cancelled');
    const result = rollups.applyRebuildPlan(plan, signal);
    this.store.audit(actor, 'usage.aggregate_rebuild', result);
    return { ...result, sourceSeparated: true };
  }
}
