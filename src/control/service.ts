import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compileRuntimeConfig } from '../config/v2-runtime.js';
import {
  type ConfigV2,
  configV2Schema,
  type ProxyKeyDefinition,
  type SecretSource,
  type UpstreamDefinition,
} from '../config/v2-schema.js';
import {
  ConfigConflictError,
  type ConfigIssue,
  ConfigServiceV2,
  ConfigValidationError,
  type ValidationResult,
} from '../config/v2-service.js';
import { resolveRoute } from '../router/routes.js';
import type { ControlStore } from './store.js';

export { ConfigConflictError, ConfigValidationError };

export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ConfigDiff {
  path: string;
  before: unknown;
  after: unknown;
}
export interface ControlEvent {
  id: number;
  type:
    | 'config.applied'
    | 'config.persisted'
    | 'config.apply_failed'
    | 'upstream.changed'
    | 'request.completed'
    | 'job.progress';
  data: Record<string, unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type ImportMode = 'replace' | 'merge';
export interface ImportPreview {
  mode: ImportMode;
  baseRevision: number;
  valid: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  conflicts: ConfigIssue[];
  diff: ConfigDiff[];
}

function importMode(value: unknown): ImportMode {
  if (value === undefined) return 'replace';
  if (value === 'replace' || value === 'merge') return value;
  throw new ControlError(400, 'UNSUPPORTED_IMPORT_MODE', 'mode must be replace or merge');
}

function importDiff(before: ConfigV2, after: ConfigV2): ConfigDiff[] {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!object(value)) return value;
    if (value.type === 'inline' && typeof value.value === 'string') return { ...value, value: '[redacted]' };
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, key === 'keyHash' ? '[redacted]' : redact(item)]),
    );
  };
  const changes = Object.keys(before)
    .filter((key) => !['upstreams', 'routes', 'proxyKeys'].includes(key))
    .flatMap((key) => diff(before[key as keyof ConfigV2], after[key as keyof ConfigV2], key));
  for (const kind of ['upstreams', 'routes', 'proxyKeys'] as const) {
    const priorOrder = before[kind].map((item) => item.id);
    const nextOrder = after[kind].map((item) => item.id);
    if (JSON.stringify(priorOrder) !== JSON.stringify(nextOrder))
      changes.push({ path: `${kind}.$order`, before: priorOrder, after: nextOrder });
    const prior = new Map(before[kind].map((item) => [item.id, item]));
    const next = new Map(after[kind].map((item) => [item.id, item]));
    for (const id of new Set([...prior.keys(), ...next.keys()]))
      changes.push(...diff(prior.get(id), next.get(id), `${kind}.${id}`));
  }
  return changes.map((item) => ({
    path: item.path,
    before:
      item.path.endsWith('.keyHash') || isInlineSecretValuePath(item.path)
        ? item.before === undefined
          ? undefined
          : '[redacted]'
        : redact(item.before),
    after:
      item.path.endsWith('.keyHash') || isInlineSecretValuePath(item.path)
        ? item.after === undefined
          ? undefined
          : '[redacted]'
        : redact(item.after),
  }));
}

function isInlineSecretValuePath(path: string): boolean {
  return /(?:\.secret\.value|\.clientSecret\.value)$/.test(path);
}

function redactDiffValues(changes: ConfigDiff[]): ConfigDiff[] {
  return changes.map((item) =>
    isInlineSecretValuePath(item.path)
      ? {
          ...item,
          before: item.before === undefined ? undefined : '[redacted]',
          after: item.after === undefined ? undefined : '[redacted]',
        }
      : item,
  );
}

function secretReferences(
  config: ConfigV2,
): Array<{ path: string; source: SecretSource }> {
  return config.upstreams.flatMap((upstream) => [
    ...upstream.credentials.map((credential) => ({
      path: `upstreams.${upstream.id}.credentials.${credential.id}.secret`,
      source: credential.secret,
    })),
    ...(upstream.auth.clientSecret
      ? [{ path: `upstreams.${upstream.id}.auth.clientSecret`, source: upstream.auth.clientSecret }]
      : []),
  ]);
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const imported = new Map(incoming.map((item) => [item.id, item]));
  const existing = new Set(current.map((item) => item.id));
  return [
    ...current.map((item) => imported.get(item.id) ?? item),
    ...incoming.filter((item) => !existing.has(item.id)),
  ];
}

function diff(before: unknown, after: unknown, prefix = ''): ConfigDiff[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (object(before) && object(after))
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      diff(before[key], after[key], prefix ? `${prefix}.${key}` : key),
    );
  if (Array.isArray(before) && Array.isArray(after))
    return [...Array(Math.max(before.length, after.length)).keys()].flatMap((index) =>
      diff(before[index], after[index], `${prefix}[${index}]`),
    );
  return [{ path: prefix, before, after }];
}

export function redactConfig(config: ConfigV2): ConfigV2 {
  // Internal raw snapshot copy; management responses use redactInlineSecrets instead.
  return structuredClone(config);
}

/** A management-safe config copy. Inline values are accepted on writes but never returned to clients. */
export function redactInlineSecrets(config: ConfigV2): ConfigV2 {
  const redacted = structuredClone(config);
  for (const upstream of redacted.upstreams) {
    for (const credential of upstream.credentials)
      if (credential.secret.type === 'inline') credential.secret.value = '';
    if (upstream.auth.clientSecret?.type === 'inline') upstream.auth.clientSecret.value = '';
  }
  return redacted;
}

export function configChecksum(config: ConfigV2): string {
  return sha(JSON.stringify(config));
}

function configDiffPaths(before: ConfigV2, after: ConfigV2): string[] {
  return diff(before, after).map((item) => item.path);
}

export class ControlService {
  readonly config: ConfigServiceV2;
  private appliedRevision?: number;
  private lastObservedRevision?: number;
  private restartFields: string[] = [];
  private lastApplyError?: string;
  private eventId = 0;
  private readonly listeners = new Set<(event: ControlEvent) => void>();
  private activeCommit?: { id: string; actor: string; paths: string[] };
  private commitQueue: Promise<unknown> = Promise.resolve();
  private readonly afterRenameForTest?: () => void;
  private readonly afterDurableCommit?: (config: ConfigV2) => void;
  constructor(
    readonly configPath: string,
    readonly store: ControlStore,
    config?: ConfigServiceV2,
    private readonly applyConfig?: (next: ConfigV2, changes: ConfigDiff[]) => Promise<number>,
    options: {
      beforeConfigRename?: () => void;
      afterConfigRename?: () => void;
      afterDurableCommit?: (config: ConfigV2) => void;
    } = {},
  ) {
    this.afterRenameForTest = options.afterConfigRename;
    this.afterDurableCommit = options.afterDurableCommit;
    this.config =
      config ??
      new ConfigServiceV2(configPath, {
        hasSecret: (id) => store.secrets.has(id),
        storeSecret: async (value, _label) => {
          const id = `sec_${randomUUID()}`;
          store.secrets.put(id, value);
          return id;
        },
        backupLegacy: async (raw, label) => {
          store.secrets.put(`backup_${label}`, raw);
          store.audit('system', 'config.v1_encrypted_backup', { label });
        },
      });
    this.config.setCommitHooks({
      beforeConfigWrite: ({ current, candidate, currentChecksum, candidateChecksum }) => {
        const active = this.activeCommit;
        if (!active) throw new Error('Config commit journal context is unavailable');
        this.store.prepareConfigCommit({
          id: active.id,
          baseRevision: current.revision,
          baseChecksum: currentChecksum,
          candidateRevision: candidate.revision,
          candidateChecksum,
          actor: active.actor,
          paths: active.paths,
          baseConfig: current,
        });
      },
      beforeRename: options.beforeConfigRename,
      afterConfigRename: () => this.afterRenameForTest?.(),
    });
    this.config.setLegacyMigrationHooks({
      beforeLegacyMigrationWrite: ({ baseChecksum, candidate, candidateChecksum }) => {
        this.store.recoverLegacy(baseChecksum);
        this.store.prepareLegacyMigration(baseChecksum, { revision: candidate.revision, checksum: candidateChecksum });
      },
      afterLegacyMigrationRename: ({ candidate }) => {
        this.afterRenameForTest?.();
        this.store.finalizeLegacyMigration(candidate);
      },
    });
  }

  async raw(): Promise<ConfigV2> {
    return redactConfig(await this.loadConfig());
  }

  reconcileStartup(config: ConfigV2): void {
    // Called by server only after schema validation and runtime snapshot construction.
    this.store.recoverPrepared({ revision: config.revision, checksum: configChecksum(config) }, config);
    this.collectOrphanedSecrets(config);
  }

  private collectOrphanedSecrets(config: ConfigV2): void {
    const references = new Set<string>();
    const collect = (value: unknown): void => {
      const parsed = configV2Schema.safeParse(value);
      if (!parsed.success) throw new Error('Cannot collect orphaned secrets: malformed current or historical config');
      for (const { source } of secretReferences(parsed.data))
        if (source.type === 'secret') references.add(source.id);
    };
    collect(config);
    for (const row of this.store.configHistoryRows()) {
      let historical: unknown;
      try {
        historical = JSON.parse(row.config_json) as unknown;
      } catch {
        throw new Error('Cannot collect orphaned secrets: malformed config history');
      }
      collect(historical);
    }
    this.store.deleteOrphanedGeneratedSecrets(references);
  }

  async reconcileOffline(): Promise<void> {
    await this.reconcileOfflineState(true);
  }

  private async reconcileOfflineState(collectOrphans: boolean): Promise<void> {
    const current = await this.config.loadRaw();
    await compileRuntimeConfig(current, (id) => this.store.secrets.get(id));
    this.store.recoverPrepared({ revision: current.revision, checksum: configChecksum(current) }, current);
    if (collectOrphans) this.collectOrphanedSecrets(current);
  }

  recordObservedExternal(
    previous: ConfigV2,
    candidate: ConfigV2,
    afterJournal?: () => void,
    runtimeState: 'applied' | 'restart_required' = 'applied',
  ): void {
    const id = this.store.prepareObservedExternal({
      baseRevision: previous.revision,
      baseChecksum: configChecksum(previous),
      candidateRevision: candidate.revision,
      candidateChecksum: configChecksum(candidate),
      paths: configDiffPaths(previous, candidate),
      baseConfig: previous,
      candidateConfig: candidate,
    });
    this.store.finalizeObservedExternal(id, runtimeState);
    afterJournal?.();
  }

  isOwnedCommit(previous: ConfigV2, config: ConfigV2): boolean {
    return this.store.hasNonExternalCommit(
      previous.revision,
      configChecksum(previous),
      config.revision,
      configChecksum(config),
    );
  }

  private async loadConfig(): Promise<ConfigV2> {
    const config = await this.config.loadRaw();
    this.lastObservedRevision = config.revision;
    // ConfigServiceV2 currently writes a same-directory V1 backup. Encrypt it and
    // remove that plaintext copy before returning any management response.
    const directory = dirname(this.configPath);
    const prefix = `${basename(this.configPath)}.v1.`;
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !/^\d+\.bak$/.test(name.slice(prefix.length))) continue;
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) continue;
      const id = `legacy_backup_${randomUUID()}`;
      this.store.secrets.put(id, readFileSync(path, 'utf8'));
      unlinkSync(path);
      this.store.audit('system', 'config.legacy_backup_secured', { id, name });
    }
    return config;
  }

  effectiveRevision(currentRevision: number): number {
    return this.appliedRevision ?? currentRevision;
  }
  /** Called by the owner of the live runtime after an out-of-band config watcher applies a snapshot. */
  markExternallyApplied(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('Invalid applied revision');
    this.appliedRevision = revision;
    this.lastApplyError = undefined;
    if (revision >= (this.lastObservedRevision ?? 0)) this.restartFields = [];
  }
  /** Keep a known-good effective revision while disk configuration awaits restart. */
  markExternallyDeferred(restartFields: string[], effectiveRevision?: number): void {
    const effective = effectiveRevision ?? this.appliedRevision ?? this.lastObservedRevision;
    if (!Number.isSafeInteger(effective) || Number(effective) < 1)
      throw new RangeError('Effective revision is required');
    this.appliedRevision = effective;
    this.restartFields = [...new Set(restartFields)];
  }
  restartRequiredFields(): string[] {
    return [...this.restartFields];
  }
  applyError(): string | undefined {
    return this.lastApplyError;
  }

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishEvent(
    type: 'upstream.changed' | 'request.completed' | 'job.progress',
    data: Record<string, unknown>,
  ): ControlEvent {
    const fields = {
      'upstream.changed': ['persistedRevision', 'effectiveRevision', 'changedUpstreamIds'],
      'request.completed': [
        'requestId',
        'outcome',
        'status',
        'model',
        'protocol',
        'source',
        'durationMs',
        'finalUpstreamId',
      ],
      'job.progress': ['jobId', 'type', 'state', 'progress'],
    }[type];
    const event: ControlEvent = {
      id: ++this.eventId,
      type,
      data: Object.fromEntries(fields.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])),
    };
    this.dispatchEvent(event);
    return event;
  }

  publishUpstreamChange(previous: ConfigV2, updated: ConfigV2): void {
    if (JSON.stringify(previous.upstreams) === JSON.stringify(updated.upstreams)) return;
    const before = new Map(previous.upstreams.map((upstream) => [upstream.id, JSON.stringify(upstream)]));
    const after = new Map(updated.upstreams.map((upstream) => [upstream.id, JSON.stringify(upstream)]));
    const changedUpstreamIds = [...new Set([...before.keys(), ...after.keys()])].filter(
      (id) => before.get(id) !== after.get(id),
    );
    this.publishEvent('upstream.changed', {
      persistedRevision: updated.revision,
      effectiveRevision: this.effectiveRevision(updated.revision),
      changedUpstreamIds,
    });
  }

  private dispatchEvent(event: ControlEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  async validate(next: unknown): Promise<ValidationResult & { diff: ConfigDiff[] }> {
    const current = await this.loadConfig();
    const restored = this.restoreInlineValues(next, current);
    const candidate = object(restored) ? { ...restored, revision: current.revision + 1 } : restored;
    const result = await this.config.validate(candidate);
    return {
      ...result,
      ...(result.config ? { config: redactInlineSecrets(result.config) } : {}),
      diff: result.config ? redactDiffValues(diff(current, result.config)) : [],
    };
  }

  private restoreInlineValues(input: unknown, current: ConfigV2): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const candidate = structuredClone(input) as Record<string, unknown>;
    if (!Array.isArray(candidate.upstreams)) return candidate;
    const restore = (source: unknown, previous: SecretSource | undefined) => {
      if (
        object(source) &&
        source.type === 'inline' &&
        (typeof source.value !== 'string' || source.value.length === 0) &&
        previous?.type === 'inline'
      )
        source.value = previous.value;
    };
    for (const item of candidate.upstreams) {
      if (!object(item) || typeof item.id !== 'string') continue;
      const previous = current.upstreams.find((upstream) => upstream.id === item.id);
      if (!previous) continue;
      if (Array.isArray(item.credentials)) {
        for (const credential of item.credentials) {
          if (!object(credential) || typeof credential.id !== 'string') continue;
          const oldCredential = previous.credentials.find((entry) => entry.id === credential.id);
          restore(credential.secret, oldCredential?.secret);
        }
      }
      if (object(item.auth)) restore(item.auth.clientSecret, previous.auth.clientSecret);
    }
    return candidate;
  }

  private async planImport(
    current: ConfigV2,
    input: unknown,
    mode: ImportMode,
  ): Promise<{ preview: ImportPreview; candidate?: ConfigV2 }> {
    input = this.restoreInlineValues(input, current);
    const parsed = configV2Schema.safeParse(input);
    if (!parsed.success) {
      return {
        preview: {
          mode,
          baseRevision: current.revision,
          valid: false,
          warnings: [],
          conflicts: [],
          diff: [],
          errors: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '$',
            code: issue.code,
            message: issue.message,
          })),
        },
      };
    }
    const imported = parsed.data;
    const conflicts: ConfigIssue[] = [];
    const addConflict = (path: string, code: string, message: string) => conflicts.push({ path, code, message });
    const candidate: ConfigV2 =
      mode === 'replace'
        ? { ...imported, instanceId: current.instanceId, revision: current.revision + 1 }
        : {
            ...current,
            revision: current.revision + 1,
            upstreams: mergeById(current.upstreams, imported.upstreams),
            routes: mergeById(current.routes, imported.routes),
            proxyKeys: mergeById(current.proxyKeys, imported.proxyKeys),
          };
    if (mode === 'merge') {
      for (const field of ['server', 'admin', 'storage', 'quota'] as const) {
        if (JSON.stringify(imported[field]) !== JSON.stringify(current[field]))
          addConflict(field, 'merge_settings', `Imported ${field} settings differ; use replace to apply them`);
      }
    }
    const oldUpstreams = new Map(current.upstreams.map((item) => [item.id, item]));
    for (const upstream of candidate.upstreams) {
      const previous = oldUpstreams.get(upstream.id);
      if (!previous) continue;
      if (JSON.stringify(previous.auth.clientSecret) !== JSON.stringify(upstream.auth.clientSecret))
        addConflict(
          `upstreams.${upstream.id}.auth.clientSecret`,
          'secret_reference_change',
          'Change this secret through the credential workflow',
        );
      const oldCredentials = new Map(previous.credentials.map((item) => [item.id, item]));
      const newCredentials = new Map(upstream.credentials.map((item) => [item.id, item]));
      for (const [id, credential] of oldCredentials) {
        const next = newCredentials.get(id);
        if (!next || JSON.stringify(credential.secret) !== JSON.stringify(next.secret))
          addConflict(
            `upstreams.${upstream.id}.credentials.${id}.secret`,
            'secret_reference_change',
            'Change this credential through the credential workflow',
          );
      }
    }
    const oldKeys = new Map(current.proxyKeys.map((item) => [item.id, item]));
    for (const key of candidate.proxyKeys) {
      const previous = oldKeys.get(key.id);
      if (previous && (previous.keyHash !== key.keyHash || previous.keyPrefix !== key.keyPrefix))
        addConflict(
          `proxyKeys.${key.id}.keyHash`,
          'proxy_key_change',
          'Rotate this proxy key through the key workflow',
        );
    }
    for (const { path, source } of secretReferences(candidate)) {
      const available =
        source.type === 'inline'
          ? source.value.length > 0
          : source.type === 'env'
            ? Boolean(process.env[source.name])
            : this.store.secrets.has(source.id);
      if (!available) addConflict(path, 'secret_unavailable', 'Bind this secret before importing');
    }
    const validation = await this.config.validate(candidate);
    if (mode === 'merge') {
      for (const issue of validation.errors) {
        if (issue.code === 'unknown_upstream' || issue.code === 'unknown_model')
          addConflict(issue.path, 'reference_conflict', issue.message);
      }
    }
    return {
      candidate,
      preview: {
        mode,
        baseRevision: current.revision,
        valid: validation.valid && conflicts.length === 0,
        errors: validation.errors,
        warnings: validation.warnings,
        conflicts,
        diff: importDiff(current, candidate),
      },
    };
  }

  async previewImport(input: unknown, requestedMode: unknown): Promise<ImportPreview> {
    const mode = importMode(requestedMode);
    const current = await this.loadConfig();
    return (await this.planImport(current, input, mode)).preview;
  }

  async importConfig(input: unknown, requestedMode: unknown, expected: number, actor: string) {
    const mode = importMode(requestedMode);
    const current = await this.loadConfig();
    if (current.revision !== expected) throw new ConfigConflictError(current.revision, expected);
    const { preview, candidate } = await this.planImport(current, input, mode);
    if (preview.conflicts.length)
      throw new ControlError(409, 'CONFIG_IMPORT_CONFLICT', 'Import requires conflict resolution', preview);
    if (!preview.valid || !candidate) throw new ConfigValidationError(preview.errors);
    const result = await this.commit(candidate, expected, actor);
    this.store.audit(actor, 'config.import', {
      mode,
      revision: result.persistedRevision,
      paths: preview.diff.map((item) => item.path),
    });
    return result;
  }

  async commit(
    next: unknown,
    expected: number,
    actor: string,
  ): Promise<{
    persistedRevision: number;
    effectiveRevision: number;
    restartRequiredFields: string[];
    config: ConfigV2;
    applyError?: string;
  }> {
    const operation = this.commitQueue.then(() => this.commitUnlocked(next, expected, actor));
    this.commitQueue = operation.catch(() => undefined);
    return operation;
  }

  private async commitUnlocked(
    next: unknown,
    expected: number,
    actor: string,
  ): Promise<{
    persistedRevision: number;
    effectiveRevision: number;
    restartRequiredFields: string[];
    config: ConfigV2;
    applyError?: string;
  }> {
    if (!this.applyConfig) await this.reconcileOfflineState(false);
    const previous = await this.loadConfig();
    const restored = this.restoreInlineValues(next, previous);
    const validated = await this.config.validate(object(restored) ? { ...restored, revision: expected + 1 } : restored);
    if (!validated.valid || !validated.config) throw new ConfigValidationError(validated.errors);
    const changes = diff(previous, validated.config);
    const commitId = randomUUID();
    this.activeCommit = { id: commitId, actor, paths: changes.map((item) => item.path) };
    let updated: ConfigV2;
    try {
      updated = await this.config.commit(restored, expected);
    } finally {
      this.activeCommit = undefined;
    }
    this.lastObservedRevision = updated.revision;
    this.appliedRevision ??= previous.revision;
    const restartRequiredFields = changes
      .filter((item) =>
        /^(server\.(port|bindAddress|publicProxyBaseUrl|trustedProxyCidrs)|admin\.(enabled|port|bindAddress|publicAdminBaseUrl)|storage\.)/.test(
          item.path,
        ),
      )
      .map((item) => (item.path.startsWith('server.trustedProxyCidrs') ? 'server.trustedProxyCidrs' : item.path))
      .filter((path, index, paths) => paths.indexOf(path) === index);
    this.restartFields = restartRequiredFields;
    let applyError: string | undefined;
    if (this.applyConfig) {
      try {
        this.appliedRevision = await this.applyConfig(updated, changes);
        this.lastApplyError = undefined;
      } catch (error) {
        applyError = error instanceof Error ? error.message.slice(0, 500) : 'Runtime apply failed';
        this.lastApplyError = applyError;
        this.store.markConfigDegraded(commitId, applyError);
        this.store.history(previous.revision, actor, previous);
        this.store.history(updated.revision, actor, updated);
      }
    } else {
      // Offline CLI still records the durable file commit as finalized; runtime application is deferred to startup.
      this.store.finalizeConfigCommit(
        commitId,
        { revision: previous.revision, config: previous },
        { revision: updated.revision, config: updated },
      );
    }
    if (this.applyConfig && !applyError) {
      this.store.finalizeConfigCommit(
        commitId,
        { revision: previous.revision, config: previous },
        { revision: updated.revision, config: updated },
      );
    }
    if (!applyError) {
      try {
        this.afterDurableCommit?.(updated);
      } catch (error) {
        // The config is already durably committed. Surface ancillary reconciliation
        // failure without pretending the atomic config write was rolled back.
        applyError = error instanceof Error ? error.message.slice(0, 500) : 'Post-commit reconciliation failed';
        this.lastApplyError = applyError;
        this.store.audit(actor, 'config.post_commit_reconcile_failed', {
          revision: updated.revision,
          error: applyError,
        });
      }
    }
    const result = {
      persistedRevision: updated.revision,
      effectiveRevision: this.appliedRevision,
      restartRequiredFields,
      config: redactConfig(updated),
      ...(applyError ? { applyError } : {}),
    };
    const event: ControlEvent = {
      id: ++this.eventId,
      type: applyError
        ? 'config.apply_failed'
        : result.effectiveRevision === result.persistedRevision
          ? 'config.applied'
          : 'config.persisted',
      data: {
        persistedRevision: result.persistedRevision,
        effectiveRevision: result.effectiveRevision,
        restartRequiredFields,
        ...(applyError ? { applyError } : {}),
      },
    };
    this.dispatchEvent(event);
    if (!applyError) this.publishUpstreamChange(previous, updated);
    return result;
  }

  async mutate(expected: number, actor: string, change: (config: ConfigV2) => void) {
    const current = await this.loadConfig();
    if (current.revision !== expected) throw new ConfigConflictError(current.revision, expected);
    const next = structuredClone(current);
    change(next);
    return this.commit(next, expected, actor);
  }

  async entity(
    kind: 'upstreams' | 'routes' | 'proxyKeys',
    method: 'create' | 'update' | 'delete',
    id: string | undefined,
    payload: unknown,
    expected: number,
    actor: string,
  ) {
    if (method !== 'delete' && !object(payload)) throw new ControlError(400, 'INVALID_BODY', 'Expected an object');
    return this.mutate(expected, actor, (config) => {
      const items = config[kind] as Array<{ id: string }>;
      const index = id === undefined ? -1 : items.findIndex((item) => item.id === id);
      if (method === 'create') {
        const value = payload as Record<string, unknown>;
        if (typeof value.id !== 'string') throw new ControlError(400, 'INVALID_ID', 'id is required');
        if (items.some((item) => item.id === value.id))
          throw new ControlError(409, 'ALREADY_EXISTS', 'ID already exists');
        items.push(value as { id: string });
      } else {
        if (index < 0) throw new ControlError(404, 'NOT_FOUND', 'Item not found');
        if (method === 'delete') {
          if (kind === 'upstreams') {
            const references = config.routes
              .filter((route) => route.targets.some((target) => target.upstreamId === id))
              .map((route) => route.id);
            if (references.length)
              throw new ControlError(409, 'REFERENCED', 'Upstream is referenced by routes', { routes: references });
            const keys = config.proxyKeys
              .filter((key) => key.allowedUpstreamIds?.includes(id ?? ''))
              .map((key) => key.id);
            if (keys.length) throw new ControlError(409, 'REFERENCED', 'Upstream is referenced by keys', { keys });
          }
          items.splice(index, 1);
        } else {
          const patch = payload as Record<string, unknown>;
          if ('id' in patch && patch.id !== id) throw new ControlError(400, 'IMMUTABLE_ID', 'id cannot change');
          items[index] = { ...items[index], ...patch };
        }
      }
    });
  }

  async createKey(payload: unknown, expected: number, actor: string) {
    if (!object(payload)) throw new ControlError(400, 'INVALID_BODY', 'Expected an object');
    const token = `mr_${randomBytes(32).toString('base64url')}`;
    const key: ProxyKeyDefinition = {
      ...(payload as Partial<ProxyKeyDefinition>),
      id: typeof payload.id === 'string' ? payload.id : `key_${randomUUID()}`,
      name: String(payload.name ?? ''),
      enabled: payload.enabled !== false,
      createdAt: new Date().toISOString(),
      keyHash: sha(token),
      keyPrefix: token.slice(0, 12),
    };
    const result = await this.entity('proxyKeys', 'create', undefined, key, expected, actor);
    return { ...result, key, secret: token };
  }

  async rotateKey(id: string, expected: number, actor: string) {
    const token = `mr_${randomBytes(32).toString('base64url')}`;
    const result = await this.mutate(expected, actor, (config) => {
      const key = config.proxyKeys.find((item) => item.id === id);
      if (!key) throw new ControlError(404, 'NOT_FOUND', 'Key not found');
      key.keyHash = sha(token);
      key.keyPrefix = token.slice(0, 12);
    });
    return { ...result, secret: token };
  }

  async credential(
    upstreamId: string,
    method: 'create' | 'replace' | 'delete',
    credentialId: string | undefined,
    payload: unknown,
    expected: number,
    actor: string,
  ) {
    if (method !== 'delete' && !object(payload)) throw new ControlError(400, 'INVALID_BODY', 'Expected an object');
    const input = payload as Record<string, unknown> | undefined;
    if (
      method !== 'delete' &&
      input?.value !== undefined &&
      (typeof input.value !== 'string' || !input.value || /^\*+$/.test(input.value))
    ) {
      throw new ControlError(400, 'INVALID_SECRET', 'Provide a new secret value or keep the existing reference');
    }
    const secretId = method !== 'delete' && typeof input?.value === 'string' ? `sec_${randomUUID()}` : undefined;
    if (secretId && typeof input?.value === 'string') this.store.secrets.put(secretId, input.value);
    let committed = false;
    try {
      const result = await this.mutate(expected, actor, (config) => {
        const upstream = config.upstreams.find((item) => item.id === upstreamId);
        if (!upstream) throw new ControlError(404, 'NOT_FOUND', 'Upstream not found');
        const index = upstream.credentials.findIndex((item) => item.id === credentialId);
        if (method === 'create') {
          const id = typeof input?.id === 'string' ? input.id : `cred_${randomUUID()}`;
          if (upstream.credentials.some((item) => item.id === id))
            throw new ControlError(409, 'ALREADY_EXISTS', 'Credential ID exists');
          const secret = secretId ? { type: 'secret' as const, id: secretId } : input?.secret;
          upstream.credentials.push({
            id,
            label: String(input?.label ?? id),
            enabled: input?.enabled !== false,
            secret: secret as UpstreamDefinition['credentials'][number]['secret'],
          });
        } else {
          if (index < 0) throw new ControlError(404, 'NOT_FOUND', 'Credential not found');
          if (method === 'delete') upstream.credentials.splice(index, 1);
          else {
            const old = upstream.credentials[index];
            upstream.credentials[index] = {
              ...old,
              label: typeof input?.label === 'string' ? input.label : old.label,
              enabled: typeof input?.enabled === 'boolean' ? input.enabled : old.enabled,
              secret: secretId
                ? { type: 'secret', id: secretId }
                : ((input?.secret as typeof old.secret | undefined) ?? old.secret),
            };
          }
        }
      });
      committed = true;
      this.store.audit(actor, `credential.${method}`, { upstreamId, credentialId });
      return result;
    } catch (error) {
      if (secretId && !committed) this.store.secrets.delete(secretId);
      throw error;
    }
  }

  async orderRoutes(ids: string[], expected: number, actor: string) {
    return this.mutate(expected, actor, (config) => {
      if (
        ids.length !== config.routes.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !config.routes.some((route) => route.id === id))
      )
        throw new ControlError(422, 'INVALID_ORDER', 'Order must contain every route exactly once');
      for (const [index, id] of ids.entries()) {
        const route = config.routes.find((item) => item.id === id);
        if (route) route.order = index;
      }
    });
  }

  async rollback(revision: number, expected: number, actor: string) {
    const config = this.store.configHistoryConfig(revision);
    if (!config) throw new ControlError(404, 'NOT_FOUND', 'Revision not found');
    return this.commit(config, expected, actor);
  }

  async previewRoute(model: string, protocol: string) {
    const config = await this.raw();
    if (!['openai', 'anthropic', 'responses'].includes(protocol))
      throw new ControlError(422, 'UNSUPPORTED_CLIENT_PROTOCOL', 'Unsupported client protocol');
    // Resolve the winning route before checking protocol, matching runtime behavior.
    const { route, reason } = resolveRoute(model, protocol as Parameters<typeof resolveRoute>[1], {
      routes: config.routes,
      upstreams: [],
    });
    if (!route) return { matched: false, reason: 'model_not_found', candidates: [] };
    if (reason) return { matched: false, reason, routeId: route?.id, candidates: [] };
    return {
      matched: true,
      routeId: route.id,
      candidates: route.targets.map((target) => {
        const upstream = config.upstreams.find((item) => item.id === target.upstreamId);
        return {
          ...target,
          protocol: upstream?.protocol,
          configured: Boolean(upstream?.enabled && upstream.models.find((item) => item.id === target.model)?.enabled),
          availability: 'unknown',
          bridge: upstream?.protocol === protocol ? 'native' : 'bridge',
        };
      }),
    };
  }
}
