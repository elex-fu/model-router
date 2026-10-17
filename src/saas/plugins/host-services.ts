/**
 * Batch-5 §5.1 plugin host services (sub2api
 * internal/service/plugin_host_services.go port). The reverse JSON-RPC
 * channel a plugin may call into.
 *
 * Scope discipline:
 *
 * - KV: PG-backed (saas_plugin_kv) instead of Redis — model-router runs
 *   stateless replicas against one authoritative Postgres, so the KV store
 *   follows that deployment truth. The pluginKey is bound SERVER-SIDE from
 *   the owning runtime; a plugin can never address another plugin's
 *   namespace, and namespace/key use the sub2api `[A-Za-z0-9._-]` charset
 *   (no glob metacharacters, no `:`).
 *
 * - Account catalog: a read-only metadata snapshot. Credential material
 *   NEVER flows through this channel — the only credential surface is the
 *   per-request session-wrapped envelope in `forward.begin` (see
 *   types.ts decision #2). sub2api's ResolveOutboundIdentity (live token
 *   delivery over the reverse channel) is deliberately NOT ported.
 */

import type { SqlExecutor } from '../db/types.js';
import type { PluginAccountCatalogEntry, PluginKvEntry } from './types.js';
import type { PluginHostServices } from './protocol.js';

export type { PluginHostServices } from './protocol.js';

const KV_NAMESPACE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const KV_KEY_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
export const PLUGIN_KV_MAX_VALUE_BYTES = 256 * 1024;
export const PLUGIN_KV_LIST_DEFAULT_LIMIT = 100;
export const PLUGIN_KV_LIST_MAX_LIMIT = 1000;
/** sub2api TTL bound: 0/absent = persistent, otherwise 1s…90d. */
export const PLUGIN_KV_MAX_TTL_SECONDS = 7_776_000;

export class PluginHostServiceError extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENT' | 'VALUE_TOO_LARGE' | 'STORE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'PluginHostServiceError';
  }
}

/** Storage port for the KV host service (PG-backed in production). */
export interface PluginKvPort {
  get(pluginKey: string, namespace: string, key: string): Promise<PluginKvEntry | null>;
  set(pluginKey: string, namespace: string, key: string, value: string, expiresAt: Date | null): Promise<void>;
  delete(pluginKey: string, namespace: string, key: string): Promise<boolean>;
  list(pluginKey: string, namespace: string, keyPrefix: string, limit: number): Promise<string[]>;
}

/** Read-only account catalog port (metadata snapshot only). */
export interface PluginAccountCatalogPort {
  list(): Promise<PluginAccountCatalogEntry[]>;
}

export interface PluginHostServiceOptions {
  readonly pluginKey: string;
  readonly kv: PluginKvPort;
  readonly accounts: PluginAccountCatalogPort;
}

/**
 * Builds the host-service handler map for one plugin runtime. Every handler
 * validates its params strictly (exact own keys, bounded strings) before
 * touching the store — the plugin is untrusted input. The pluginKey binding
 * is applied here, never taken from plugin params.
 */
export function createPluginHostServices(options: PluginHostServiceOptions): PluginHostServices {
  const pluginKey = options.pluginKey;
  const kv = options.kv;
  const accounts = options.accounts;

  const kvGet = async (params: unknown): Promise<{ found: boolean; value: string | null }> => {
    const input = requireExactKeys(params, ['namespace', 'key']);
    const namespace = validateNamespace(input.namespace);
    const key = validateKey(input.key);
    const entry = await kv.get(pluginKey, namespace, key);
    if (entry === null || (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= Date.now())) {
      return { found: false, value: null };
    }
    return { found: true, value: entry.value };
  };

  const kvSet = async (params: unknown): Promise<Record<string, never>> => {
    const input = requireExactKeys(params, ['namespace', 'key', 'value', 'ttl_seconds']);
    const namespace = validateNamespace(input.namespace);
    const key = validateKey(input.key);
    if (typeof input.value !== 'string') {
      throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv value must be a string');
    }
    if (Buffer.byteLength(input.value, 'utf8') > PLUGIN_KV_MAX_VALUE_BYTES) {
      throw new PluginHostServiceError('VALUE_TOO_LARGE', 'kv value exceeds the size limit');
    }
    let expiresAt: Date | null = null;
    if (input.ttl_seconds !== null && input.ttl_seconds !== undefined) {
      if (typeof input.ttl_seconds !== 'number' || !Number.isInteger(input.ttl_seconds)) {
        throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv ttl_seconds must be an integer or null');
      }
      if (input.ttl_seconds < 1 || input.ttl_seconds > PLUGIN_KV_MAX_TTL_SECONDS) {
        throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv ttl_seconds is out of range');
      }
      expiresAt = new Date(Date.now() + input.ttl_seconds * 1000);
    }
    await kv.set(pluginKey, namespace, key, input.value, expiresAt);
    return {};
  };

  const kvDelete = async (params: unknown): Promise<{ deleted: boolean }> => {
    const input = requireExactKeys(params, ['namespace', 'key']);
    const namespace = validateNamespace(input.namespace);
    const key = validateKey(input.key);
    return { deleted: await kv.delete(pluginKey, namespace, key) };
  };

  const kvList = async (params: unknown): Promise<{ keys: string[] }> => {
    const input = requireExactKeys(params, ['namespace', 'key_prefix', 'limit']);
    const namespace = validateNamespace(input.namespace);
    if (typeof input.key_prefix !== 'string' || input.key_prefix.length > 256) {
      throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv key_prefix must be a bounded string');
    }
    if (input.key_prefix.length > 0 && !KV_KEY_PATTERN.test(input.key_prefix)) {
      throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv key_prefix charset is invalid');
    }
    let limit = PLUGIN_KV_LIST_DEFAULT_LIMIT;
    if (input.limit !== null && input.limit !== undefined) {
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1) {
        throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv limit must be a positive integer or null');
      }
      limit = Math.min(input.limit, PLUGIN_KV_LIST_MAX_LIMIT);
    }
    return { keys: await kv.list(pluginKey, namespace, input.key_prefix, limit) };
  };

  const accountsList = async (params: unknown): Promise<{ accounts: PluginAccountCatalogEntry[] }> => {
    const input = requireExactKeys(params, ['platform', 'account_type']);
    const accountType = optionalBoundedString(input.account_type, 50, 'account_type');
    void optionalBoundedString(input.platform, 50, 'platform');
    const all = await accounts.list();
    const filtered = accountType === null ? all : all.filter((entry) => entry.credentialType === accountType);
    return { accounts: filtered };
  };

  return {
    'kv.get': kvGet,
    'kv.set': kvSet,
    'kv.delete': kvDelete,
    'kv.list': kvList,
    'accounts.list': accountsList,
  };
}

/** PG-backed KV + account-catalog ports (the production host services). */
export function createPostgresPluginHostServicePorts(executor: SqlExecutor): {
  kv: PluginKvPort;
  accounts: PluginAccountCatalogPort;
} {
  return {
    kv: {
      async get(pluginKey, namespace, key) {
        const rows = await executor.query<{
          readonly namespace: string;
          readonly key: string;
          readonly value: string;
          readonly expires_at: string | null;
        }>(
          `SELECT namespace, key, value, expires_at
             FROM saas_plugin_kv
            WHERE plugin_key = $1 AND namespace = $2 AND key = $3
              AND (expires_at IS NULL OR expires_at > now())`,
          [pluginKey, namespace, key],
        );
        const row = rows.rows[0];
        return row === undefined
          ? null
          : { namespace: row.namespace, key: row.key, value: row.value, expiresAt: row.expires_at };
      },
      async set(pluginKey, namespace, key, value, expiresAt) {
        await executor.query(
          `INSERT INTO saas_plugin_kv (plugin_key, namespace, key, value, expires_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (plugin_key, namespace, key)
           DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = now()`,
          [pluginKey, namespace, key, value, expiresAt],
        );
      },
      async delete(pluginKey, namespace, key) {
        const rows = await executor.query(
          `DELETE FROM saas_plugin_kv
            WHERE plugin_key = $1 AND namespace = $2 AND key = $3
            RETURNING key`,
          [pluginKey, namespace, key],
        );
        return rows.rows.length > 0;
      },
      async list(pluginKey, namespace, keyPrefix, limit) {
        const rows = await executor.query<{ key: string }>(
          `SELECT key FROM saas_plugin_kv
            WHERE plugin_key = $1 AND namespace = $2 AND key LIKE $3 ESCAPE '\\'
            ORDER BY key LIMIT $4`,
          [pluginKey, namespace, escapeLikePrefix(keyPrefix), limit],
        );
        return rows.rows.map((row) => row.key);
      },
    },
    accounts: {
      async list() {
        // Read-only metadata snapshot across both account families; the
        // catalog never includes credential columns.
        const tenantRows = await executor.query<AccountRow>(
          `SELECT id, provider_id, product_id, credential_type, status, display_name
             FROM saas_tenant_provider_accounts
            WHERE status <> 'revoked'
            ORDER BY id
            LIMIT 500`,
          [],
        );
        const platformRows = await executor.query<AccountRow>(
          `SELECT id, provider_id, product_id, credential_type, status, display_name
             FROM saas_platform_provider_accounts
            WHERE status <> 'revoked'
            ORDER BY id
            LIMIT 500`,
          [],
        );
        return [
          ...tenantRows.rows.map((row) => toEntry(row, 'tenant')),
          ...platformRows.rows.map((row) => toEntry(row, 'platform')),
        ];
      },
    },
  };
}

interface AccountRow {
  readonly id: string;
  readonly provider_id: string;
  readonly product_id: string;
  readonly credential_type: string;
  readonly status: string;
  readonly display_name: string;
}

function toEntry(row: AccountRow, ownerKind: 'tenant' | 'platform'): PluginAccountCatalogEntry {
  return {
    id: row.id,
    ownerKind,
    providerId: row.provider_id,
    productId: row.product_id,
    credentialType: row.credential_type,
    status: row.status,
    displayName: row.display_name,
  };
}

function requireExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginHostServiceError('INVALID_ARGUMENT', 'params must be an object');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new PluginHostServiceError('INVALID_ARGUMENT', 'params keys are invalid');
  }
  return record;
}

function validateNamespace(value: unknown): string {
  if (typeof value !== 'string' || !KV_NAMESPACE_PATTERN.test(value)) {
    throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv namespace is invalid');
  }
  return value;
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !KV_KEY_PATTERN.test(value)) {
    throw new PluginHostServiceError('INVALID_ARGUMENT', 'kv key is invalid');
  }
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PluginHostServiceError('INVALID_ARGUMENT', `${field} must be a bounded string or null`);
  }
  return value;
}

function escapeLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
