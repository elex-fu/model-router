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
/**
 * User-risk observations (migration 153 evidence) age out after 7 days: the
 * anomaly detector reads at most 2× its 5-minute window, so this bounds the
 * per-admission INSERT growth with orders of magnitude of headroom.
 */
export const DEFAULT_USER_RISK_OBSERVATION_RETENTION_DAYS = 7;

function boundedObservationRetentionDays(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 3650) {
    return DEFAULT_USER_RISK_OBSERVATION_RETENTION_DAYS;
  }
  return Math.round(value);
}

export function resolveUserRiskObservationRetentionDays(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.MODEL_ROUTER_SAAS_USER_RISK_OBSERVATION_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_USER_RISK_OBSERVATION_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!/^\d{1,4}$/.test(raw) || parsed < 1 || parsed > 3650) {
    throw new RangeError('MODEL_ROUTER_SAAS_USER_RISK_OBSERVATION_RETENTION_DAYS must be an integer from 1 to 3650');
  }
  return parsed;
}

export interface RiskControlRetentionWorkerOptions {
  /** Cycle cadence; default 24h (the probe-run retention convention). */
  readonly pollIntervalMs?: number;
  /** Observation retention window in days; default 7. */
  readonly observationRetentionDays?: number;
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
 * deleted, together with blocklist hashes past the hit window and
 * user-risk observations past observationRetentionDays. Returns the
 * per-class deletion counts for tests and the admin surface.
 */
export async function runRiskControlRetentionOnce(
  executor: SqlExecutor,
  now: () => number = Date.now,
  observationRetentionDays: number = DEFAULT_USER_RISK_OBSERVATION_RETENTION_DAYS,
): Promise<{ deletedHit: number; deletedNonHit: number; deletedHashes: number; deletedObservations: number }> {
  const store = new PostgresRiskControlAdminStore(executor);
  const { config } = await store.loadConfig();
  const hitBefore = new Date(now() - config.hitRetentionDays * 86_400_000).toISOString();
  const nonHitBefore = new Date(now() - config.nonHitRetentionDays * 86_400_000).toISOString();
  const observationBefore = new Date(
    now() - boundedObservationRetentionDays(observationRetentionDays) * 86_400_000,
  ).toISOString();
  return store.cleanupExpired(hitBefore, nonHitBefore, observationBefore);
}

export function startRiskControlRetentionWorker(
  executor: SqlExecutor,
  options: RiskControlRetentionWorkerOptions = {},
): RiskControlRetentionWorkerHandle {
  const intervalMs = boundedIntervalMs(options.pollIntervalMs);
  const observationRetentionDays = boundedObservationRetentionDays(options.observationRetentionDays);
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
        await runRiskControlRetentionOnce(executor, Date.now, observationRetentionDays);
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
