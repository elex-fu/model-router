/**
 * The control-plane user anomaly detection loop (M3 §7.2): runs the migration
 * 153 detector batch on a cadence, turning the saas_user_risk_observations
 * evidence captured by canonical admission into staged enforcement
 * (rate-limit marker → key disposition → account suspension). Runs on the
 * control-plane role next to the retention worker; the gateway role records
 * observations but never enforces.
 */

import type { SaasDatabase } from '../db/types.js';
import {
  PostgresUserAnomalyDetector,
  type UserAnomalyBatchResult,
  type UserAnomalyDetectorOptions,
} from './user-risk.js';

export const DEFAULT_USER_ANOMALY_INTERVAL_MS = 60_000;
export const MIN_USER_ANOMALY_INTERVAL_MS = 15_000;

export interface UserAnomalyWorkerOptions {
  /**
   * Cycle cadence; default 60s. Detection is anchored to fixed epoch buckets
   * of the detector window (5 minutes) and is idempotent per
   * (api_key_id, kind, window_start), so cadence only bounds enforcement lag.
   */
  readonly pollIntervalMs?: number;
  readonly detectorOptions?: UserAnomalyDetectorOptions;
  readonly onError?: (error: unknown) => void;
  /** Result emission seam for tests and operator-facing cycle logging. */
  readonly onCycle?: (result: UserAnomalyBatchResult) => void;
}

export interface UserAnomalyWorkerHandle {
  close(): Promise<void>;
}

function boundedIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_USER_ANOMALY_INTERVAL_MS;
  }
  return Math.max(MIN_USER_ANOMALY_INTERVAL_MS, Math.round(value));
}

export function startUserAnomalyDetectionWorker(
  database: Pick<SaasDatabase, 'query' | 'transaction'>,
  options: UserAnomalyWorkerOptions = {},
): UserAnomalyWorkerHandle {
  const intervalMs = boundedIntervalMs(options.pollIntervalMs);
  const detector = new PostgresUserAnomalyDetector(database, options.detectorOptions ?? {});
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
    // The first batch waits one interval: startup stays read-only and any
    // deployment that never records observations never pays the aggregate.
    await delay(intervalMs);
    while (!stopped) {
      let result: UserAnomalyBatchResult | undefined;
      try {
        result = await detector.runBatch();
        options.onCycle?.(result);
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
