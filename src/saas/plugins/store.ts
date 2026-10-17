import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import {
  PLUGIN_CAPABILITY_AUTHORIZATIONS,
  type PluginBindingRecord,
  type PluginCapabilityId,
  type PluginInstallationRecord,
  type PluginInstallationState,
  type PluginKvEntry,
  type PluginManifest,
  type PluginSignatureStatus,
  type PluginStore,
} from './types.js';

/**
 * The PostgresPluginStore is the DB-authoritative half of the batch-5 §5.1
 * plugin system (migration 128; the sub2api plugin_manager store port):
 *
 * - Control plane (install/replace/config/binding edits) and the standalone
 *   plugin-host workload (reconcile CAS transitions + host-service KV) both
 *   run through this class; role separation happens at the PostgreSQL grant
 *   level (runtime-privileges.ts vs plugin-host-privileges.ts), not here.
 * - Every state transition is a CAS on (id, expected state, expected
 *   binary_sha256): 0 rows updated means a concurrent admin/reconcile change
 *   won and the caller must re-read — the store returns null/false and never
 *   throws on that benign conflict (sub2api ErrPluginStateChanged).
 * - `upsertInstallation` refuses to replace a starting/enabled installation
 *   (or one with an enabled binding) with a `plugin_replace_forbidden`
 *   coded error; the caller maps it to "disable before replacing".
 */

/** App-side KV limits mirroring the sub2api host-service KV contract. */
const KV_VALUE_MAX_BYTES = 256 * 1024;
const KV_KEY_CHARSET = /^[A-Za-z0-9._-]+$/;

export class PluginStoreConflictError extends Error {
  constructor(
    readonly code: 'plugin_replace_forbidden' | 'kv_value_too_large' | 'kv_name_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'PluginStoreConflictError';
  }
}

export interface PostgresPluginStoreOptions {
  readonly database: SaasDatabase;
}

interface InstallationRow {
  readonly id?: unknown;
  readonly plugin_key?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
  readonly author?: unknown;
  readonly manifest?: unknown;
  readonly manifest_sha256?: unknown;
  readonly entrypoint_path?: unknown;
  readonly binary_sha256?: unknown;
  readonly signature_status?: unknown;
  readonly state?: unknown;
  readonly config_json?: unknown;
  readonly last_error?: unknown;
  readonly artifact_data?: unknown;
  readonly artifact_sha256?: unknown;
  readonly installed_by?: unknown;
  readonly installed_at?: unknown;
  readonly updated_at?: unknown;
  readonly enabled_at?: unknown;
}

interface BindingRow {
  readonly id?: unknown;
  readonly installation_id?: unknown;
  readonly plugin_key?: unknown;
  readonly capability?: unknown;
  readonly platform?: unknown;
  readonly account_type?: unknown;
  readonly enabled?: unknown;
  readonly rollout_percent?: unknown;
}

interface KvRow {
  readonly namespace?: unknown;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly expires_at?: unknown;
}

const INSTALLATION_COLUMNS = [
  'id',
  'plugin_key',
  'name',
  'version',
  'description',
  'author',
  'manifest',
  'manifest_sha256',
  'entrypoint_path',
  'binary_sha256',
  'signature_status',
  'state',
  'config_json',
  'last_error',
  'artifact_data',
  'artifact_sha256',
  'installed_by',
  'installed_at',
  'updated_at',
  'enabled_at',
] as const;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`stored plugin installation column ${field} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`stored plugin installation column ${field} is invalid`);
  }
  return value;
}

function requireDate(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  throw new Error(`stored plugin installation column ${field} is invalid`);
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireDate(value, field);
}

function requireId(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`stored plugin ${field} is invalid`);
  }
  return parsed;
}

function isCapabilityId(value: string): value is PluginCapabilityId {
  return Object.hasOwn(PLUGIN_CAPABILITY_AUTHORIZATIONS, value);
}

function isInstallationState(value: string): value is PluginInstallationState {
  return (
    value === 'disabled' || value === 'starting' || value === 'enabled' || value === 'error' || value === 'incompatible'
  );
}

function isSignatureStatus(value: string): value is PluginSignatureStatus {
  return value === 'trusted' || value === 'unsigned';
}

/**
 * Defensive parse of a stored manifest jsonb blob. The manifest was strictly
 * validated at install time (package/manifest.ts); this re-parse trusts the
 * DB shape and only re-validates the capability ids against the centralized
 * PLUGIN_CAPABILITY_AUTHORIZATIONS table (fail-closed on any drift) before
 * coercing to the readonly PluginManifest contract type.
 */
function parseStoredManifest(value: unknown): PluginManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('stored plugin manifest is not an object');
  }
  const raw = value as Readonly<Record<string, unknown>>;
  const requires = raw.requires;
  if (typeof requires !== 'object' || requires === null || Array.isArray(requires)) {
    throw new Error('stored plugin manifest requires is not an object');
  }
  const requiresRecord = requires as Readonly<Record<string, unknown>>;
  const capabilities = raw.capabilities;
  if (!Array.isArray(capabilities)) {
    throw new Error('stored plugin manifest capabilities is not an array');
  }
  const files = raw.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error('stored plugin manifest files is not an object');
  }
  const parsedCapabilities: { readonly id: PluginCapabilityId }[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== 'object' || capability === null || Array.isArray(capability)) {
      throw new Error('stored plugin manifest capability entry is invalid');
    }
    const id = (capability as Readonly<Record<string, unknown>>).id;
    if (typeof id !== 'string' || !isCapabilityId(id)) {
      throw new Error(`stored plugin manifest capability ${String(id)} is not authorized`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      parsedCapabilities.push({ id });
    }
  }
  return {
    schemaVersion: raw.schemaVersion as number,
    id: raw.id as string,
    name: raw.name as string,
    version: raw.version as string,
    description: raw.description as string,
    author: raw.author as string,
    requires: {
      modelRouter: requiresRecord.modelRouter as string,
      pluginProtocol: requiresRecord.pluginProtocol as number,
      transportApi: requiresRecord.transportApi as number,
    },
    capabilities: parsedCapabilities,
    entrypoint: raw.entrypoint as string,
    files: files as Readonly<Record<string, string>>,
  };
}

function parseConfigJson(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stored plugin config_json is invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

function mapInstallationRow(row: InstallationRow): PluginInstallationRecord {
  const signatureStatus = requireString(row.signature_status, 'signature_status');
  const state = requireString(row.state, 'state');
  if (!isSignatureStatus(signatureStatus) || !isInstallationState(state)) {
    throw new Error('stored plugin installation enum column is invalid');
  }
  const artifactData = row.artifact_data;
  if (!Buffer.isBuffer(artifactData) && !(artifactData instanceof Uint8Array)) {
    throw new Error('stored plugin artifact_data is invalid');
  }
  return {
    id: requireId(row.id, 'installation id'),
    pluginKey: requireString(row.plugin_key, 'plugin_key'),
    name: requireString(row.name, 'name'),
    version: requireString(row.version, 'version'),
    description: typeof row.description === 'string' ? row.description : '',
    author: typeof row.author === 'string' ? row.author : '',
    manifest: parseStoredManifest(row.manifest),
    manifestSha256: requireString(row.manifest_sha256, 'manifest_sha256'),
    entrypointPath: requireString(row.entrypoint_path, 'entrypoint_path'),
    binarySha256: requireString(row.binary_sha256, 'binary_sha256'),
    signatureStatus,
    state,
    configJson: parseConfigJson(row.config_json),
    lastError: typeof row.last_error === 'string' ? row.last_error : '',
    artifactData: new Uint8Array(artifactData),
    artifactSha256: requireString(row.artifact_sha256, 'artifact_sha256'),
    installedBy: optionalString(row.installed_by, 'installed_by'),
    installedAt: requireDate(row.installed_at, 'installed_at'),
    updatedAt: requireDate(row.updated_at, 'updated_at'),
    enabledAt: optionalDate(row.enabled_at, 'enabled_at'),
  };
}

function mapBindingRow(row: BindingRow): PluginBindingRecord {
  const capability = requireString(row.capability, 'binding capability');
  if (!isCapabilityId(capability)) {
    throw new Error('stored plugin binding capability is not authorized');
  }
  const enabled = row.enabled;
  const rolloutPercent = row.rollout_percent;
  if (typeof enabled !== 'boolean' || typeof rolloutPercent !== 'number') {
    throw new Error('stored plugin binding enabled/rollout column is invalid');
  }
  return {
    id: requireId(row.id, 'binding id'),
    installationId: requireId(row.installation_id, 'binding installation_id'),
    pluginKey: requireString(row.plugin_key, 'binding plugin_key'),
    capability,
    platform: requireString(row.platform, 'binding platform'),
    accountType: requireString(row.account_type, 'binding account_type'),
    enabled,
    rolloutPercent,
  };
}

interface StoredBindingInput {
  readonly capability: PluginCapabilityId;
  readonly platform: string;
  readonly accountType: string;
  readonly enabled: boolean;
  readonly rolloutPercent: number;
}

/** Manifest capabilities → the frozen scope rows (enabled=false on install). */
function bindingsFromManifest(manifest: PluginManifest): StoredBindingInput[] {
  const bindings: StoredBindingInput[] = [];
  const seen = new Set<string>();
  for (const capability of manifest.capabilities) {
    const authorization = PLUGIN_CAPABILITY_AUTHORIZATIONS[capability.id];
    if (!authorization || seen.has(capability.id)) continue;
    seen.add(capability.id);
    bindings.push({
      capability: capability.id,
      platform: authorization.platform,
      accountType: authorization.accountType,
      enabled: false,
      rolloutPercent: 100,
    });
  }
  return bindings;
}

async function insertBindings(
  executor: SqlExecutor,
  installationId: number,
  bindings: readonly StoredBindingInput[],
): Promise<void> {
  for (const binding of bindings) {
    await executor.query(
      `INSERT INTO saas_plugin_bindings
         (installation_id, capability, platform, account_type, enabled, rollout_percent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        installationId,
        binding.capability,
        binding.platform,
        binding.accountType,
        binding.enabled,
        binding.rolloutPercent,
      ],
    );
  }
}

function likePrefix(prefix: string): string {
  return `${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export class PostgresPluginStore implements PluginStore {
  private readonly database: SaasDatabase;

  constructor(options: PostgresPluginStoreOptions) {
    if (!options?.database) throw new TypeError('database is required');
    this.database = options.database;
  }

  async listInstallations(): Promise<PluginInstallationRecord[]> {
    const result = await this.database.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS.join(', ')}
         FROM saas_plugin_installations
        ORDER BY id`,
    );
    return result.rows.map(mapInstallationRow);
  }

  async getInstallation(pluginKey: string): Promise<PluginInstallationRecord | null> {
    const result = await this.database.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS.join(', ')}
         FROM saas_plugin_installations
        WHERE plugin_key = $1`,
      [pluginKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInstallationRow(row);
  }

  async upsertInstallation(input: {
    pluginKey: string;
    name: string;
    version: string;
    description: string;
    author: string;
    manifest: PluginManifest;
    manifestSha256: string;
    entrypointPath: string;
    binarySha256: string;
    signatureStatus: PluginSignatureStatus;
    artifactData: Uint8Array;
    artifactSha256: string;
    installedBy: string | null;
  }): Promise<PluginInstallationRecord> {
    const bindings = bindingsFromManifest(input.manifest);
    return this.database.transaction(async (tx) => {
      const existing = await tx.query<{ readonly id?: unknown; readonly state?: unknown }>(
        `SELECT id, state FROM saas_plugin_installations WHERE plugin_key = $1 FOR UPDATE`,
        [input.pluginKey],
      );
      if (existing.rows.length > 0) {
        const id = requireId(existing.rows[0]?.id, 'installation id');
        const state = requireString(existing.rows[0]?.state, 'state');
        if (state === 'starting' || state === 'enabled') {
          throw new PluginStoreConflictError(
            'plugin_replace_forbidden',
            'a starting/enabled plugin installation must be disabled before it can be replaced',
          );
        }
        const enabledBinding = await tx.query(
          `SELECT 1 FROM saas_plugin_bindings WHERE installation_id = $1 AND enabled`,
          [id],
        );
        if ((enabledBinding.rowCount ?? 0) > 0) {
          throw new PluginStoreConflictError(
            'plugin_replace_forbidden',
            'a plugin installation with an enabled binding must be disabled before it can be replaced',
          );
        }
        // Full content replacement: every package-derived column is
        // rewritten, the lifecycle resets to a fresh disabled install and
        // the binding set is rebuilt from the (new) manifest.
        const updated = await tx.query<InstallationRow>(
          `UPDATE saas_plugin_installations
              SET name = $2,
                  version = $3,
                  description = $4,
                  author = $5,
                  manifest = $6::jsonb,
                  manifest_sha256 = $7,
                  entrypoint_path = $8,
                  binary_sha256 = $9,
                  signature_status = $10,
                  state = 'disabled',
                  config_json = NULL,
                  last_error = '',
                  artifact_data = $11,
                  artifact_sha256 = $12,
                  updated_at = now(),
                  enabled_at = NULL
            WHERE id = $1
            RETURNING ${INSTALLATION_COLUMNS.join(', ')}`,
          [
            id,
            input.name,
            input.version,
            input.description,
            input.author,
            JSON.stringify(input.manifest),
            input.manifestSha256,
            input.entrypointPath,
            input.binarySha256,
            input.signatureStatus,
            Buffer.from(input.artifactData),
            input.artifactSha256,
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) throw new Error('plugin installation replace returned no row');
        await tx.query('DELETE FROM saas_plugin_bindings WHERE installation_id = $1', [id]);
        await insertBindings(tx, id, bindings);
        return mapInstallationRow(row);
      }

      const inserted = await tx.query<InstallationRow>(
        `INSERT INTO saas_plugin_installations
           (plugin_key, name, version, description, author, manifest, manifest_sha256,
            entrypoint_path, binary_sha256, signature_status, state, config_json,
            last_error, artifact_data, artifact_sha256, installed_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, 'disabled', NULL, '', $11, $12, $13)
         RETURNING ${INSTALLATION_COLUMNS.join(', ')}`,
        [
          input.pluginKey,
          input.name,
          input.version,
          input.description,
          input.author,
          JSON.stringify(input.manifest),
          input.manifestSha256,
          input.entrypointPath,
          input.binarySha256,
          input.signatureStatus,
          Buffer.from(input.artifactData),
          input.artifactSha256,
          input.installedBy,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('plugin installation insert returned no row');
      const id = requireId(row.id, 'installation id');
      await insertBindings(tx, id, bindings);
      return mapInstallationRow(row);
    });
  }

  async updateInstallationState(input: {
    id: number;
    expectedState: PluginInstallationState | null;
    expectedBinarySha256: string;
    state: PluginInstallationState;
    lastError?: string;
  }): Promise<PluginInstallationRecord | null> {
    // enabled_at is cleared on every non-serving state; the canonical enable
    // path is markRuntimeHealthy (which stamps it).
    const clearsEnabledAt = input.state === 'disabled' || input.state === 'error' || input.state === 'incompatible';
    const stateClause = input.expectedState === null ? '' : ' AND state = $5';
    const values: unknown[] = [input.id, input.expectedBinarySha256, input.state, input.lastError ?? ''];
    if (input.expectedState !== null) values.push(input.expectedState);
    const result = await this.database.query<InstallationRow>(
      `UPDATE saas_plugin_installations
          SET state = $3,
              last_error = $4,
              updated_at = now(),
              enabled_at = ${clearsEnabledAt ? 'NULL' : 'enabled_at'}
        WHERE id = $1
          AND binary_sha256 = $2${stateClause}
        RETURNING ${INSTALLATION_COLUMNS.join(', ')}`,
      values,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInstallationRow(row);
  }

  async markRuntimeHealthy(input: { id: number; expectedBinarySha256: string }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE saas_plugin_installations
          SET state = 'enabled',
              enabled_at = now(),
              last_error = '',
              updated_at = now()
        WHERE id = $1
          AND binary_sha256 = $2
          AND state IN ('starting', 'error', 'disabled')
          AND EXISTS (
            SELECT 1 FROM saas_plugin_bindings AS binding
             WHERE binding.installation_id = saas_plugin_installations.id
               AND binding.enabled
          )
        RETURNING id`,
      [input.id, input.expectedBinarySha256],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateConfigJson(input: {
    id: number;
    configJson: Readonly<Record<string, unknown>> | null;
  }): Promise<PluginInstallationRecord | null> {
    const result = await this.database.query<InstallationRow>(
      `UPDATE saas_plugin_installations
          SET config_json = $2::jsonb,
              updated_at = now()
        WHERE id = $1
        RETURNING ${INSTALLATION_COLUMNS.join(', ')}`,
      [input.id, input.configJson === null ? null : JSON.stringify(input.configJson)],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInstallationRow(row);
  }

  async replaceBindings(input: {
    installationId: number;
    bindings: readonly {
      capability: PluginCapabilityId;
      platform: string;
      accountType: string;
      enabled: boolean;
      rolloutPercent: number;
    }[];
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query('DELETE FROM saas_plugin_bindings WHERE installation_id = $1', [input.installationId]);
      await insertBindings(tx, input.installationId, input.bindings);
    });
  }

  async listBindings(): Promise<PluginBindingRecord[]> {
    const result = await this.database.query<BindingRow>(
      `SELECT binding.id, binding.installation_id, installation.plugin_key,
              binding.capability, binding.platform, binding.account_type,
              binding.enabled, binding.rollout_percent
         FROM saas_plugin_bindings AS binding
         JOIN saas_plugin_installations AS installation ON installation.id = binding.installation_id
        ORDER BY binding.id`,
    );
    return result.rows.map(mapBindingRow);
  }

  async deleteInstallation(id: number): Promise<boolean> {
    const result = await this.database.query('DELETE FROM saas_plugin_installations WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async kvGet(pluginKey: string, namespace: string, key: string): Promise<PluginKvEntry | null> {
    // Expired rows are absent by contract; the best-effort delete keeps the
    // table from accumulating dead TTL rows on the read path.
    await this.database.query(
      `DELETE FROM saas_plugin_kv
        WHERE plugin_key = $1 AND namespace = $2 AND key = $3
          AND expires_at IS NOT NULL AND expires_at <= now()`,
      [pluginKey, namespace, key],
    );
    const result = await this.database.query<KvRow>(
      `SELECT namespace, key, value, expires_at
         FROM saas_plugin_kv
        WHERE plugin_key = $1 AND namespace = $2 AND key = $3
          AND (expires_at IS NULL OR expires_at > now())`,
      [pluginKey, namespace, key],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      namespace: requireString(row.namespace, 'kv namespace'),
      key: requireString(row.key, 'kv key'),
      value: typeof row.value === 'string' ? row.value : '',
      expiresAt: optionalDate(row.expires_at, 'kv expires_at'),
    };
  }

  async kvSet(
    pluginKey: string,
    namespace: string,
    key: string,
    value: string,
    ttlSeconds: number | null,
  ): Promise<void> {
    for (const [name, field] of [
      [namespace, 'namespace'],
      [key, 'key'],
    ] as const) {
      if (!KV_KEY_CHARSET.test(name)) {
        throw new PluginStoreConflictError('kv_name_invalid', `plugin KV ${field} must match ${KV_KEY_CHARSET.source}`);
      }
    }
    if (Buffer.byteLength(value, 'utf8') > KV_VALUE_MAX_BYTES) {
      throw new PluginStoreConflictError('kv_value_too_large', 'plugin KV value exceeds the 256 KiB limit');
    }
    const expiresAt = ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000);
    await this.database.query(
      `INSERT INTO saas_plugin_kv (plugin_key, namespace, key, value, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (plugin_key, namespace, key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [pluginKey, namespace, key, value, expiresAt],
    );
  }

  async kvDelete(pluginKey: string, namespace: string, key: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM saas_plugin_kv WHERE plugin_key = $1 AND namespace = $2 AND key = $3',
      [pluginKey, namespace, key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async kvList(pluginKey: string, namespace: string, keyPrefix: string, limit: number): Promise<string[]> {
    const result = await this.database.query<{ readonly key?: unknown }>(
      `SELECT key
         FROM saas_plugin_kv
        WHERE plugin_key = $1 AND namespace = $2 AND key LIKE $3 ESCAPE '\\'
        ORDER BY key
        LIMIT $4`,
      [pluginKey, namespace, likePrefix(keyPrefix), limit],
    );
    return result.rows.map((row) => requireString(row.key, 'kv key'));
  }
}
