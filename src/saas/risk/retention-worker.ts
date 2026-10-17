/**
 * The control-plane risk-control retention loop (roadmap batch 5 §5.4,
 * task #19): prunes moderation decision logs past the configured hit /
 * non-hit windows and blocklist hashes past the hit window. Runs on the
 * control-plane role (which holds the DELETE grants) next to the
 * observability workers; the gateway role writes logs but never deletes.
 */

import type { SqlExecutor } from '../db/types.js';
import { PostgresRiskControlAdminStore } from './postgres-store.js';

export const DEFAULT_RISK_CONTROL_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
export const MIN_RISK_CONTROL_RETENTION_INTERVAL_MS = 60_000;

export interface RiskControlRetentionWorkerOptions {
  /** Cycle cadence; default 24h (the probe-run retention convention). */
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface RiskControlRetentionWorkerHandle {
  close(): Promise<void>;
}

function boundedIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RISK_CONTROL_RETENTION_INTERVAL_MS;
  }
  return Math.max(MIN_RISK_CONTROL_RETENTION_INTERVAL_MS, Math.round(value));
}

/**
 * One retention sweep: flagged rows older than the config's
 * hitRetentionDays and unflagged rows older than nonHitRetentionDays are
 * deleted, together with blocklist hashes past the hit window. Returns the
 * per-class deletion counts for tests and the admin surface.
 */
export async function runRiskControlRetentionOnce(
  executor: SqlExecutor,
  now: () => number = Date.now,
): Promise<{ deletedHit: number; deletedNonHit: number; deletedHashes: number }> {
  const store = new PostgresRiskControlAdminStore(executor);
  const { config } = await store.loadConfig();
  const hitBefore = new Date(now() - config.hitRetentionDays * 86_400_000).toISOString();
  const nonHitBefore = new Date(now() - config.nonHitRetentionDays * 86_400_000).toISOString();
  return store.cleanupExpired(hitBefore, nonHitBefore);
}

export function startRiskControlRetentionWorker(
  executor: SqlExecutor,
  options: RiskControlRetentionWorkerOptions = {},
): RiskControlRetentionWorkerHandle {
  const intervalMs = boundedIntervalMs(options.pollIntervalMs);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const delay = (durationMs: number): Promise<void> => {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  };
  const loop = (async () => {
    // The first sweep waits one interval: retention is not urgent and eager
    // DELETEs stay off process bootstrap (the probe-run retention convention).
    await delay(intervalMs);
    while (!stopped) {
      try {
        await runRiskControlRetentionOnce(executor);
      } catch (error) {
        options.onError?.(error);
      }
      if (stopped) break;
      await delay(intervalMs);
    }
  })();
  return {
    async close() {
      if (stopped) return loop;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await loop;
    },
  };
}
