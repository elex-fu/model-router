import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import {
  BRAND_SETTINGS_KEY_LIST,
  EMPTY_BRAND_SNAPSHOT,
  type PublicBrandSnapshot,
  parsePublicBrandSnapshot,
  resolveBrandSnapshotFromSettings,
} from './snapshot.js';

/**
 * Batch 5 §5.2 OEM white-label: the public brand snapshot data plane on top
 * of migration 126's `saas_public_brand_settings` single-row table.
 *
 * Workload split (the migration-110 design stance preserved: the gateway
 * holds no grant on the settings store itself):
 *
 * - control plane: `materialize()` reads the `saas.brand.*` rows from
 *   saas_platform_settings, re-validates them with the shared strict parsers
 *   and upserts the public snapshot. The periodic worker here plus the
 *   settings admin surface's eager afterWrite hook keep the row fresh.
 * - gateway / console-serving workload: `read()` selects the snapshot row
 *   through the read-only grant. No secret can be in the row by construction
 *   (only strictly parsed public brand fields are ever materialized).
 *
 * A failed materialization cycle never overwrites the previous snapshot (the
 * upsert runs only after the whole composed snapshot parsed); a failed read
 * fails open to the empty snapshot so the console never breaks on a brand
 * hiccup.
 */

interface SnapshotRow {
  readonly snapshot?: unknown;
  readonly version?: unknown;
}

interface SettingsKeyRow {
  readonly key?: unknown;
  readonly value?: unknown;
}

function innerSettingsValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'value' in value) {
    return (value as { readonly value: unknown }).value;
  }
  return undefined;
}

export interface PublicBrandSnapshotStoreOptions {
  readonly database: SaasDatabase;
  readonly now?: () => Date;
}

export class PublicBrandSnapshotStore {
  private readonly database: SaasDatabase;

  constructor(options: PublicBrandSnapshotStoreOptions) {
    if (!options?.database) throw new TypeError('database is required');
    this.database = options.database;
  }

  /**
   * Control-plane materialization: settings store → public snapshot row.
   * Returns the new snapshot version. A strict-parser failure (a corrupted
   * settings row) propagates fail-closed — the previous snapshot survives.
   */
  async materialize(): Promise<number> {
    const snapshot = await this.composeSnapshot(this.database);
    const result = await this.database.query<{ readonly version?: unknown }>(
      `/* saas-public-brand:materialize */
       INSERT INTO saas_public_brand_settings (singleton, snapshot, materialized_at)
       VALUES (true, $1::jsonb, now())
       ON CONFLICT (singleton) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             version = saas_public_brand_settings.version + 1,
             materialized_at = EXCLUDED.materialized_at
       RETURNING version`,
      [JSON.stringify(snapshot)],
    );
    // pg returns bigint columns as strings; accept every driver spelling.
    const raw = result.rows[0]?.version;
    const version =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'bigint'
          ? Number(raw)
          : typeof raw === 'string' && /^\d+$/.test(raw)
            ? Number(raw)
            : undefined;
    if (version === undefined || !Number.isSafeInteger(version) || version < 1) {
      throw new Error('the public brand snapshot upsert returned no version');
    }
    return version;
  }

  /**
   * Gateway/console read of the materialized snapshot. A missing row yields
   * the empty snapshot; a corrupted row throws (callers decide fail-open vs
   * fail-closed).
   */
  async read(): Promise<PublicBrandSnapshot> {
    const result = await this.database.query<SnapshotRow>(
      `/* saas-public-brand:read */
       SELECT snapshot FROM saas_public_brand_settings WHERE singleton = true`,
    );
    const row = result.rows[0];
    if (row === undefined) return EMPTY_BRAND_SNAPSHOT;
    return parsePublicBrandSnapshot(row.snapshot);
  }

  private async composeSnapshot(executor: SqlExecutor): Promise<PublicBrandSnapshot> {
    const result = await executor.query<SettingsKeyRow>(
      `/* saas-public-brand:compose */
       SELECT key, value FROM saas_platform_settings WHERE key = ANY($1::text[])`,
      [[...BRAND_SETTINGS_KEY_LIST]],
    );
    const values: Record<string, unknown> = {};
    for (const row of result.rows) {
      if (typeof row.key !== 'string') continue;
      values[row.key] = innerSettingsValue(row.value);
    }
    return resolveBrandSnapshotFromSettings(values);
  }
}

export interface CachedBrandSnapshotReaderOptions {
  /** Cache lifetime of the in-memory snapshot copy (default 15s). */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Called once per failed refresh (throttled by the TTL window). */
  readonly onError?: (error: unknown) => void;
}

export interface CachedBrandSnapshotReader {
  readonly read: () => Promise<PublicBrandSnapshot>;
  /** Drops the cached copy (after an eager materialization, for example). */
  readonly invalidate: () => void;
}

/**
 * Per-process TTL cache around PublicBrandSnapshotStore.read so HTML serving
 * does not hit PostgreSQL on every request. A read failure serves the last
 * good snapshot (or the empty snapshot when none was ever read) — the brand
 * surface is cosmetic and must never take the console down.
 */
export function createCachedBrandSnapshotReader(
  store: Pick<PublicBrandSnapshotStore, 'read'>,
  options: CachedBrandSnapshotReaderOptions = {},
): CachedBrandSnapshotReader {
  const ttlMs = options.ttlMs ?? 15_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 3_600_000) {
    throw new RangeError('brand snapshot cache TTL must be between 0 and 3600000 ms');
  }
  const now = options.now ?? Date.now;
  let cached: { readonly snapshot: PublicBrandSnapshot; readonly at: number } | undefined;
  let pending: Promise<PublicBrandSnapshot> | undefined;

  const load = async (): Promise<PublicBrandSnapshot> => {
    const snapshot = await store.read();
    cached = { snapshot, at: now() };
    return snapshot;
  };

  return {
    async read(): Promise<PublicBrandSnapshot> {
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.snapshot;
      pending ??= load()
        .catch((error: unknown) => {
          options.onError?.(error);
          return cached?.snapshot ?? EMPTY_BRAND_SNAPSHOT;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}

export interface PublicBrandSnapshotWorkerHandle {
  readonly close: () => Promise<void>;
  /** Triggers one immediate materialization cycle (used by the eager afterWrite hook). */
  readonly refresh: () => Promise<void>;
}

export interface PublicBrandSnapshotWorkerOptions {
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_BRAND_SNAPSHOT_INTERVAL_MS = 60_000;
const MIN_BRAND_SNAPSHOT_INTERVAL_MS = 5_000;
const MAX_BRAND_SNAPSHOT_INTERVAL_MS = 3_600_000;

/**
 * The control-plane periodic materializer (the customer-webhook retention
 * pruner's schedule/tick pattern). Cycles run every intervalMs; the first
 * cycle is also delayed by intervalMs so process startup stays read-only
 * (the saas-startup read-route contract) — the eager afterWrite hook on the
 * settings admin surface covers operator-driven changes immediately, and the
 * previously materialized snapshot (or the migration's seeded empty row)
 * serves until the first cycle lands. A failed cycle logs through onError
 * and reschedules — the previously materialized snapshot keeps serving.
 */
export function startPublicBrandSnapshotWorker(
  store: Pick<PublicBrandSnapshotStore, 'materialize'>,
  options: PublicBrandSnapshotWorkerOptions = {},
): PublicBrandSnapshotWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_BRAND_SNAPSHOT_INTERVAL_MS;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_BRAND_SNAPSHOT_INTERVAL_MS ||
    intervalMs > MAX_BRAND_SNAPSHOT_INTERVAL_MS
  ) {
    throw new RangeError(
      `brand snapshot interval must be between ${MIN_BRAND_SNAPSHOT_INTERVAL_MS} and ${MAX_BRAND_SNAPSHOT_INTERVAL_MS} ms`,
    );
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, delayMs);
    timer.unref();
  };
  const tick = (): void => {
    if (stopped || running) return;
    running = store
      .materialize()
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        running = undefined;
      })
      .then(() => schedule(intervalMs));
  };
  schedule(intervalMs);
  return {
    async close(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
    refresh(): Promise<void> {
      return store.materialize().then(() => undefined);
    },
  };
}
