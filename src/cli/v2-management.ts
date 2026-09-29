import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { AdminMaintenance } from '../admin/maintenance.js';
import { offlineRestore } from '../backup/offline-restore.js';
import type { ConfigV2 } from '../config/v2-schema.js';
import { type ConfigIssue, ConfigServiceV2, safeMigrationUrl } from '../config/v2-service.js';
import { ControlService } from '../control/service.js';
import { ControlStore } from '../control/store.js';
import { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { tryV2 } from './v2.js';

type Options = {
  config?: string;
  dryRun?: boolean;
  expectedRevision?: string;
  model?: string;
  baseUrl?: string;
  enable?: boolean;
  disable?: boolean;
  testStdin?: boolean;
};
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const targetPath = (options: Options) => resolve(options.config ?? DEFAULT_CONFIG_PATH);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;
const issueSummary = (issues: ConfigIssue[]) => issues.map((issue) => `${issue.path} [${issue.code}]`).join(', ');

function lock(file: string): () => void {
  const lockPath = `${file}.cli.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Another V2 CLI write is in progress');
  }
  return () => {
    closeSync(fd);
    unlinkSync(lockPath);
  };
}

function exclusiveLock(file: string): () => void {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch {
    throw new Error(`Cannot prove offline exclusivity: lock exists at ${file}`);
  }
  return () => {
    closeSync(fd);
    unlinkSync(file);
  };
}

function regularFile(file: string): void {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error(`Unsafe telemetry/configuration file: ${file}`);
}

/** Stronger than checking writers: reject every other process holding any telemetry SQLite file open. */
function noOtherDatabaseHandles(file: string): void {
  const files = [file, `${file}-wal`, `${file}-shm`].filter(existsSync);
  for (const item of files) regularFile(item);
  let output = '';
  try {
    output = execFileSync('lsof', ['-F', 'p', '--', ...files], { encoding: 'utf8', timeout: 5_000 });
  } catch (error) {
    const failure = error as Error & { status?: number; stdout?: string; stderr?: string };
    if (failure.status === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return;
    throw new Error('Cannot verify telemetry database handles with lsof; refusing offline rebuild');
  }
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  // lsof emits mandatory `f<fd>` records even with `-F p`.
  if (
    lines.some((line) => !/^(?:p\d+|f.+)$/.test(line)) ||
    (lines.length > 0 && !lines.some((line) => /^p\d+$/.test(line)))
  )
    throw new Error('Cannot parse telemetry database handles; refusing offline rebuild');
  const otherPids = lines
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number(line.slice(1)))
    .filter((pid) => pid !== process.pid);
  if (otherPids.length)
    throw new Error(
      `Telemetry database is open in another process (${otherPids.join(',')}); stop it before offline rebuild`,
    );
}

/** Keep the configured listeners reserved throughout migration, preventing a normal server start race. */
async function reserveStoppedListeners(config: ConfigV2): Promise<() => Promise<void>> {
  const listeners: Server[] = [];
  const endpoints = [
    [config.server.bindAddress, config.server.port],
    ...(config.admin.enabled ? [[config.admin.bindAddress, config.admin.port]] : []),
  ] as Array<[string, number]>;
  try {
    for (const [host, port] of endpoints) {
      const server = createServer((socket) => socket.destroy());
      try {
        await new Promise<void>((resolveReady, reject) => {
          server.once('error', reject);
          server.listen({ host, port, exclusive: true }, () => {
            server.off('error', reject);
            resolveReady();
          });
        });
      } catch (error) {
        throw new Error(`Configured listener ${host}:${port} is occupied or unverifiable; stop the instance`, {
          cause: error,
        });
      }
      listeners.push(server);
    }
    return async () => {
      for (const server of listeners.reverse())
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    };
  } catch (error) {
    for (const server of listeners.reverse())
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw error;
  }
}

function address(value: unknown): string {
  const host = value === '0.0.0.0' || value === '::' ? '127.0.0.1' : typeof value === 'string' ? value : '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

async function refuseRunning(raw: Json): Promise<void> {
  const server = object(raw.server) ? raw.server : {};
  const admin = object(raw.admin) ? raw.admin : {};
  const probes = [
    `http://${address(server.bindAddress)}:${Number(server.port ?? 15005)}/healthz`,
    ...(admin.enabled === true
      ? [`http://${address(admin.bindAddress)}:${Number(admin.port ?? 15006)}/admin/api/v1/bootstrap`]
      : []),
  ];
  for (const url of probes) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(400), redirect: 'manual' });
      throw new Error(
        'A server is responding on the configured port; use the admin API or stop it before offline changes',
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('A server is responding')) throw error;
    }
  }
}

function dataDirectory(file: string, config: Json): string {
  const storage = object(config.storage) ? config.storage : {};
  return config.schemaVersion === 2 && typeof storage.dataDir === 'string'
    ? resolve(dirname(file), storage.dataDir)
    : dirname(file);
}

async function withOfflineStore<T>(options: Options, action: (control: ControlService) => Promise<T>): Promise<T> {
  const file = targetPath(options);
  if (!existsSync(file)) throw new Error('Configuration file does not exist');
  const release = lock(file);
  let store: ControlStore | undefined;
  try {
    const raw = readJson(file);
    if (!object(raw)) throw new Error('Configuration must be a JSON object');
    await refuseRunning(raw);
    store = new ControlStore(dataDirectory(file, raw));
    return await action(new ControlService(file, store));
  } finally {
    store?.close();
    release();
  }
}

async function migrationPreview(raw: Json, file: string) {
  if (raw.schemaVersion === 2) {
    return { previewKind: 'v2_candidate', valid: false, blockers: ['Configuration is already V2'], warnings: [] };
  }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > 2) {
    return { previewKind: 'v2_candidate', valid: false, blockers: ['Unsupported future schema version'], warnings: [] };
  }
  const checked = await new ConfigServiceV2(file).previewLegacy(raw);
  const config = checked.config;
  const upstreams = config?.upstreams.map((upstream) => {
    const legacy = (Array.isArray(raw.upstreams) ? raw.upstreams : []).find(
      (item) => object(item) && item.name === upstream.name,
    );
    const legacyBase = object(legacy) && typeof legacy.baseUrl === 'string' ? legacy.baseUrl : undefined;
    const credentials = upstream.credentials.map((credential) => {
    const secret =
      credential.secret.type === 'env'
        ? `env:${credential.secret.name}`
        : credential.secret.type === 'inline'
          ? 'inline value in config file'
          : 'encrypted secret';
      return { id: credential.id, label: credential.label, enabled: credential.enabled, secretSource: secret };
    });
    return {
      id: upstream.id,
      name: upstream.name,
      provider: upstream.provider,
      protocol: upstream.protocol,
      enabled: upstream.enabled,
      urlMigration: {
        sourceBase: safeMigrationUrl(legacyBase),
        legacyEndpoint: upstream.endpoints.generate,
        v2Prefix: safeMigrationUrl(upstream.baseUrl),
        relativeEndpoint: upstream.endpoints.generate,
        finalUrl: safeMigrationUrl(`${upstream.baseUrl.replace(/\/$/, '')}/${upstream.endpoints.generate}`),
      },
      credentials,
      models: upstream.models.map((model) => model.id),
    };
  }) ?? [];
  const routes = config?.routes.map((route) => ({
    id: route.id,
    match: route.match,
    clientProtocols: route.clientProtocols,
    publishedModels: route.publishedModels,
    targets: route.targets,
  })) ?? [];
  const blockers = checked.errors.map(({ path, code }) => `${path} [${code}]`);
  return {
    previewKind: 'v2_candidate',
    schema: 'V1 → V2',
    valid: checked.valid,
    candidateValidated: checked.config !== undefined,
    summary: {
      upstreams,
      credentials: config?.upstreams.reduce((count, upstream) => count + upstream.credentials.length, 0) ?? 0,
      routes,
      proxyKeys: config?.proxyKeys.map((key) => ({
        id: key.id,
        name: key.name,
        enabled: key.enabled,
        prefix: key.keyPrefix,
        allowedUpstreamIds: key.allowedUpstreamIds ?? [],
        allowedModels: key.allowedModels ?? [],
      })) ?? [],
      publicProxyUrl: config?.server.publicProxyBaseUrl,
      legacyLogHandling: 'Existing request_logs are not imported; retain separately as legacy_log_rows.',
    },
    blockers,
    warnings: checked.warnings.map(({ path, code }) => `${path} [${code}]`),
    actualMigration: 'Encrypts V1 backup and secrets, then writes V2 configuration.',
  };
}

type BootstrapCredentials = { token: string; name: string; password: string };

async function bootstrapCredentials(testStdin: boolean): Promise<BootstrapCredentials> {
  if (testStdin) {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        lines.push(line);
        if (lines.length === 3) break;
      }
    } finally {
      rl.close();
    }
    if (lines.length !== 3) throw new Error('Test stdin requires token, name, and password on three lines');
    return { token: lines[0] ?? '', name: lines[1] ?? '', password: lines[2] ?? '' };
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Interactive terminal required; run inside the container with docker compose exec -it if applicable',
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = async (prompt: string, hidden: boolean) => {
    const terminal = rl as typeof rl & { _writeToOutput: (value: string) => void };
    const originalWrite = terminal._writeToOutput;
    if (hidden) {
      terminal._writeToOutput = () => {};
      process.stdout.write(prompt);
    } else process.stdout.write(prompt);
    try {
      return await new Promise<string>((resolve, reject) => {
        const clean = () => {
          rl.off('line', line);
          rl.off('SIGINT', interrupt);
          rl.off('close', closed);
        };
        const line = (value: string) => {
          clean();
          resolve(value);
        };
        const closed = () => {
          clean();
          reject(new Error('Input cancelled'));
        };
        const interrupt = () => {
          rl.close();
        };
        rl.once('line', line);
        rl.once('SIGINT', interrupt);
        rl.once('close', closed);
      });
    } finally {
      terminal._writeToOutput = originalWrite;
      if (hidden) process.stdout.write('\n');
    }
  };
  try {
    const token = await ask('One-time bootstrap token: ', true);
    const name = await ask('Administrator name: ', false);
    const password = await ask('Administrator password: ', true);
    const confirmation = await ask('Confirm password: ', true);
    if (password !== confirmation) throw new Error('Passwords do not match');
    return { token, name, password };
  } finally {
    rl.close();
  }
}

function bootstrapFailure(status: number, value: unknown): string {
  const error = object(value) && object(value.error) ? value.error : {};
  const code = typeof error.code === 'string' ? error.code : '';
  if (status === 409 || code === 'ALREADY_INITIALIZED') return 'Administrator is already initialized';
  if (code === 'INVALID_BOOTSTRAP_TOKEN') return 'Invalid or expired one-time bootstrap token';
  if (code === 'LOCAL_ONLY') return 'Bootstrap was rejected because the request was not local';
  if (code === 'ORIGIN_REJECTED') return 'Bootstrap origin was rejected';
  if (code === 'INVALID_BODY')
    return 'Invalid administrator name or password (password must be at least 12 characters)';
  return `Bootstrap failed: HTTP ${status}${code ? ` (${code})` : ''}`;
}

export async function adminBootstrap(options: Options): Promise<void> {
  const file = targetPath(options);
  if (!existsSync(file)) throw new Error('Configuration file does not exist');
  const config = readJson(file);
  if (!object(config) || config.schemaVersion !== 2 || !object(config.admin))
    throw new Error('admin:bootstrap requires V2 configuration');
  if (config.admin.enabled !== true) throw new Error('Admin listener is disabled in configuration');
  const port = config.admin.port;
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid admin port in configuration');
  const endpoint = `http://127.0.0.1:${port}/admin/api/v1/bootstrap`;
  let state: Response;
  try {
    state = await fetch(endpoint, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
  } catch {
    throw new Error('Cannot reach local admin listener; check that the server is running');
  }
  if (!state.ok) throw new Error(`Cannot read bootstrap state: HTTP ${state.status}`);
  const status: unknown = await state.json().catch(() => null);
  if (!object(status) || !object(status.data) || typeof status.data.initialized !== 'boolean')
    throw new Error('Admin listener returned an invalid bootstrap state');
  if (status.data.initialized) throw new Error('Administrator is already initialized');
  const credentials = await bootstrapCredentials(options.testStdin === true);
  if (!credentials.token.trim() || !credentials.name.trim() || credentials.password.length < 12)
    throw new Error('Token and name are required; password must be at least 12 characters');
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
  } catch {
    throw new Error('Bootstrap request could not reach the local admin listener');
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status !== 201) throw new Error(bootstrapFailure(response.status, body));
  if (!object(body) || !object(body.data) || body.data.initialized !== true)
    throw new Error('Admin listener returned an invalid bootstrap success response');
  console.log('Administrator created. Open the admin UI and sign in.');
}

export async function configValidate(options: Options): Promise<void> {
  const file = targetPath(options);
  if (!existsSync(file)) throw new Error('Configuration file does not exist');
  const raw = readJson(file);
  if (!object(raw) || raw.schemaVersion !== 2)
    throw new Error('config:validate accepts V2 only; use config:migrate --dry-run for V1');
  const result = await new ConfigServiceV2(file).validate(raw);
  console.log(
    JSON.stringify({
      valid: result.valid,
      errors: result.errors.map(({ path, code }) => ({ path, code })),
      warnings: result.warnings.map(({ path, code }) => ({ path, code })),
    }),
  );
  if (!result.valid) process.exitCode = 1;
}

export async function configMigrate(options: Options): Promise<void> {
  const file = targetPath(options);
  if (!existsSync(file)) throw new Error('Configuration file does not exist');
  const raw = readJson(file);
  if (!object(raw)) throw new Error('Configuration must be a JSON object');
  if (options.dryRun) {
    const preview = await migrationPreview(raw, file);
    console.log(JSON.stringify(preview));
    if (!preview.valid) process.exitCode = 1;
    return;
  }
  if (raw.schemaVersion === 2) throw new Error('Migration blocked: Configuration is already V2');
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > 2)
    throw new Error('Migration blocked: Unsupported future schema version');
  const migrated = await withOfflineStore(options, async (control) => {
    const result = await control.raw();
    await control.reconcileOffline();
    return result;
  });
  console.log(
    `Migrated configuration to V2 revision ${migrated.revision}; original archived in encrypted control store`,
  );
}

export async function configApply(sourcePath: string, options: Options): Promise<void> {
  const file = targetPath(options);
  const source = resolve(sourcePath);
  if (source === file) throw new Error('Source and target configuration paths must differ');
  const incoming = readJson(source);
  if (!object(incoming) || incoming.schemaVersion !== 2) throw new Error('config:apply requires a V2 JSON source');
  const revision = options.expectedRevision === undefined ? undefined : Number(options.expectedRevision);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
    throw new Error('--expected-revision must be a positive integer');
  const result = await withOfflineStore(options, async (control) => {
    const current = await control.raw();
    if (current.schemaVersion !== 2) throw new Error('Migrate the target configuration before config:apply');
    const expected = revision ?? incoming.revision;
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1)
      throw new Error('Source must contain a positive revision or pass --expected-revision');
    const checked = await control.validate(incoming);
    if (!checked.valid) throw new Error(`Invalid V2 configuration: ${issueSummary(checked.errors)}`);
    return control.commit(incoming, expected, 'cli');
  });
  console.log(`Applied V2 configuration revision ${result.persistedRevision}`);
}

export async function upstreamUpdate(name: string, options: Options): Promise<void> {
  if (options.enable && options.disable) throw new Error('--enable and --disable are mutually exclusive');
  if (options.baseUrl === undefined && options.model === undefined && !options.enable && !options.disable)
    throw new Error('Provide --base-url, --model, --enable, or --disable');
  await withOfflineStore(options, async (control) => {
    const current = await control.raw();
    if (current.schemaVersion !== 2) throw new Error('upstream:update requires V2 configuration');
    const upstream = current.upstreams.find((item) => item.id === name || item.name === name);
    if (!upstream) throw new Error(`Upstream "${name}" not found`);
    const patch: Partial<ConfigV2['upstreams'][number]> = {};
    if (options.baseUrl !== undefined) patch.baseUrl = options.baseUrl;
    if (options.enable) patch.enabled = true;
    if (options.disable) patch.enabled = false;
    if (options.model !== undefined) {
      if (!options.model.trim()) throw new Error('--model must not be empty');
      patch.models = upstream.models.some((item) => item.id === options.model)
        ? upstream.models
        : [...upstream.models, { id: options.model, enabled: true, capabilities: {}, capabilitiesSource: 'manual' }];
    }
    await control.entity('upstreams', 'update', upstream.id, patch, current.revision, 'cli');
    console.log(`Updated upstream: ${upstream.name}`);
  });
}

export async function upstreamTest(name: string, options: Options): Promise<void> {
  if (!(await tryV2('test', options, name)))
    throw new Error('upstream:test currently supports V2 configuration only; use test for V1');
}

export async function backupCreate(options: Options): Promise<void> {
  const result = await withOfflineStore(options, async (control) => {
    const config = await control.raw();
    if (config.schemaVersion !== 2) throw new Error('backup:create requires V2 configuration');
    const telemetryPath = join(control.store.dataDir, 'logs.sqlite');
    if (!existsSync(telemetryPath)) throw new Error('Telemetry database is missing; complete backup is unavailable');
    const telemetry = new SQLiteTelemetryStore(telemetryPath);
    await telemetry.init();
    try {
      return await new AdminMaintenance(control, control.store, telemetry).backup(new AbortController().signal);
    } finally {
      await telemetry.close();
    }
  });
  console.log(
    JSON.stringify({ backupId: result.backupId, revision: result.revision, path: result.path, scope: result.scope }),
  );
}

export async function backupRestore(backupId: string, options: Options): Promise<void> {
  if (!options.config) throw new Error('backup:restore requires explicit --config');
  if (options.expectedRevision === undefined || !/^[1-9]\d*$/.test(options.expectedRevision))
    throw new Error('backup:restore requires --expected-revision <positive integer>');
  const result = await offlineRestore(backupId, options.config, Number(options.expectedRevision));
  console.log(JSON.stringify(result));
}

/** Offline-only V2 migration. Does not start automatically in the serving process. */
export async function telemetryRebuildLive(options: Options): Promise<void> {
  if (!options.config) throw new Error('telemetry:rebuild-live requires explicit --config');
  if (options.expectedRevision === undefined || !/^[1-9]\d*$/.test(options.expectedRevision))
    throw new Error('telemetry:rebuild-live requires --expected-revision <positive integer>');
  const expected = Number(options.expectedRevision);
  if (!Number.isSafeInteger(expected)) throw new Error('--expected-revision is out of range');
  const file = targetPath(options);
  if (!existsSync(file)) throw new Error('Configuration file does not exist');
  regularFile(file);
  const releaseCli = lock(file);
  let releaseConfig: (() => void) | undefined;
  let releaseListeners: (() => Promise<void>) | undefined;
  let telemetry: SQLiteTelemetryStore | undefined;
  try {
    releaseConfig = exclusiveLock(`${file}.lock`);
    const bytes = readFileSync(file);
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(raw) || raw.schemaVersion !== 2)
      throw new Error('telemetry:rebuild-live requires an existing V2 configuration');
    const validation = await new ConfigServiceV2(file).validate(raw);
    if (!validation.valid || !validation.config)
      throw new Error(`Invalid V2 configuration: ${issueSummary(validation.errors)}`);
    const config = validation.config;
    if (config.revision !== expected)
      throw new Error(`Configuration revision conflict: expected ${expected}, actual ${config.revision}`);
    const dir = resolve(dirname(file), config.storage.dataDir);
    const dirInfo = lstatSync(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('Unsafe telemetry data directory');
    const database = join(dir, 'logs.sqlite');
    if (!existsSync(database)) throw new Error('Telemetry database is missing');
    regularFile(database);
    releaseListeners = await reserveStoppedListeners(config);
    noOtherDatabaseHandles(database);
    telemetry = new SQLiteTelemetryStore(database);
    await telemetry.init();
    noOtherDatabaseHandles(database);
    if (!readFileSync(file).equals(bytes)) throw new Error('Configuration changed during offline verification');
    const started = performance.now();
    const result = await telemetry.rebuildLiveAggregates({ offline: true });
    const durationMs = performance.now() - started;
    noOtherDatabaseHandles(database);
    if (!readFileSync(file).equals(bytes)) throw new Error('Configuration changed during offline rebuild');
    console.log(
      JSON.stringify({
        rows: result.requests,
        requests: result.requests,
        attempts: result.attempts,
        sequence: result.sequence,
        durationMs: Math.round(durationMs * 100) / 100,
        revision: config.revision,
      }),
    );
  } finally {
    try {
      await telemetry?.close();
    } finally {
      try {
        await releaseListeners?.();
      } finally {
        try {
          releaseConfig?.();
        } finally {
          releaseCli();
        }
      }
    }
  }
}
