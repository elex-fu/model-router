/**
 * Classic-mode Codex CLI client-version auto-sync worker (P0-1 parity for
 * the non-managed plane). The classic codex-account transport advertises
 * `buildCanonicalIdentity(versionOverride)`, where the override is fed only
 * by the manual `MODEL_ROUTER_CODEX_CLIENT_VERSION` env pin (see
 * index.ts). Without a poller the advertised version decays as upstream
 * releases move on, which ChatGPT's Codex backend answers with the
 * in-stream `server_is_overloaded` deprioritization sentinel.
 *
 * This worker polls the openai/codex GitHub release feed through the SAME
 * pure feed the SaaS plane uses (`src/saas/supply/codex-version-sync.ts` —
 * verified at runtime to pull no SaaS infra: its import graph is constants,
 * parsers and node:crypto helpers only) and keeps the process-level synced
 * slot (`updateSyncedCodexVersion` in the shared identity module) fresh.
 * One immediate round runs at start, then one round per clamped interval
 * (unref'd timer, the oauth-refresh-engine start() pattern) so the worker
 * never keeps the process alive on its own.
 *
 * Env override precedence: the manual `MODEL_ROUTER_CODEX_CLIENT_VERSION`
 * pin STILL WINS over the synced slot by the identity module's own
 * resolution order (override → synced → baseline). The worker therefore
 * never needs to beat the pin — it only avoids pointless fetch-writes
 * below it: a release at or under the pin leaves the slot untouched.
 *
 * Writes are forward-only: a release older than (or equal to) the current
 * synced slot never writes, so the slot can only ratchet upward. Every
 * failure mode (network error, timeout, malformed feed, ineligible tag)
 * returns null from the feed and is swallowed here — optionally surfaced
 * through `onError` — and the next cycle retries.
 *
 * Opt-out: `MODEL_ROUTER_CODEX_VERSION_SYNC=off` (or `enabled: false`)
 * performs no fetches at all.
 */

import {
  CODEX_MIN_VERSION,
  readSyncedCodexVersion,
  semverGte,
  updateSyncedCodexVersion,
} from '../saas/gateway/codex/identity.js';
import {
  clampCodexVersionSyncIntervalMs,
  type CodexVersionSyncFetch,
  fetchLatestCodexStableVersion,
} from '../saas/supply/codex-version-sync.js';

/** Env value that turns the whole worker off (no fetches at all). */
const CODEX_VERSION_SYNC_OFF_ENV_VALUE = 'off';
/** Env key for the opt-out switch. */
const CODEX_VERSION_SYNC_ENV_KEY = 'MODEL_ROUTER_CODEX_VERSION_SYNC';
/** Env key for the manual client-version pin fed to the codex transport. */
const CODEX_CLIENT_VERSION_ENV_KEY = 'MODEL_ROUTER_CODEX_CLIENT_VERSION';

export interface ClassicCodexVersionSyncOptions {
  /** Delay between completed sync rounds; clamped [1min, 24h], default 6h. */
  readonly intervalMs?: number;
  /** Test seam; production uses the global fetch with pinned URLs. */
  readonly fetchImpl?: CodexVersionSyncFetch;
  /** Test seam for deterministic clocks (drives the interval scheduling). */
  readonly nowMs?: () => number;
  /** Static kill switch; false skips every sync cycle (default true). */
  readonly enabled?: boolean;
  /** Receives only stable cycle codes; never provider or credential data. */
  readonly onError?: (code: 'round_failed') => void;
}

export interface ClassicCodexVersionSyncHandle {
  /** Stops the loop; resolves once the in-flight round has settled. Idempotent. */
  close(): Promise<void>;
  /**
   * Runs one sync round immediately and resolves to whether the process-level
   * synced slot changed (the test surface; the loop itself ignores results).
   */
  runOnce(): Promise<boolean>;
}

/** Bare-stable semver at or above the upstream minimum. */
function isEligibleSyncVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version) && semverGte(version, CODEX_MIN_VERSION);
}

/** Strict `candidate > floor` on already-eligible versions. */
function isGreaterThan(candidate: string, floor: string): boolean {
  return semverGte(candidate, floor) && !semverGte(floor, candidate);
}

function isSyncDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env[CODEX_VERSION_SYNC_ENV_KEY];
  return typeof value === 'string' && value.trim().toLowerCase() === CODEX_VERSION_SYNC_OFF_ENV_VALUE;
}

/**
 * The manual pin, or null when absent/blank/ineligible. An ineligible pin
 * (malformed or below CODEX_MIN_VERSION) is ignored exactly the way the
 * identity module's own resolution ignores it — it can never gate the sync.
 */
function readEnvClientVersionPin(env: NodeJS.ProcessEnv): string | null {
  const value = env[CODEX_CLIENT_VERSION_ENV_KEY];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || !isEligibleSyncVersion(trimmed)) return null;
  return trimmed;
}

/**
 * One sync round: fetch the latest stable release, then — forward-only
 * relative to both the synced slot and the env pin — refresh the
 * process-level identity slot. Never throws; every failure path resolves
 * false.
 */
async function runSyncRound(
  options: ClassicCodexVersionSyncOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (options.enabled === false) return false;
  if (isSyncDisabledByEnv(env)) return false;

  const latest = await fetchLatestCodexStableVersion(options.fetchImpl);
  if (latest === null) return false;
  if (!isEligibleSyncVersion(latest)) return false;

  const synced = readSyncedCodexVersion();
  if (synced !== null && !isGreaterThan(latest, synced)) {
    // Forward-only: an unchanged or older release never writes.
    return false;
  }
  const pin = readEnvClientVersionPin(env);
  if (pin !== null && !isGreaterThan(latest, pin)) {
    // The manual env pin wins at resolution time anyway; never write a
    // value at or below it (that would be a pointless ratchet floor).
    return false;
  }
  return updateSyncedCodexVersion(latest);
}

/**
 * Starts the classic sync loop: one immediate round, then one round per
 * clamped interval. The interval wait is measured against the injected
 * clock and re-checked on short slices, so a deterministic `nowMs` seam
 * can advance virtual time without waiting the real interval. The loop's
 * timers are unref'd so the worker never keeps the process alive.
 */
export function startCodexVersionSyncWorker(
  options: ClassicCodexVersionSyncOptions = {},
): ClassicCodexVersionSyncHandle {
  const frozen: ClassicCodexVersionSyncOptions = Object.freeze({ ...options });
  const intervalMs = clampCodexVersionSyncIntervalMs(options.intervalMs);
  const clock = options.nowMs ?? Date.now;
  const activeRuns = new Set<Promise<boolean>>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const CLOCK_SLICE_MS = 250;

  const runOnce = async (): Promise<boolean> => {
    if (closed) return false;
    // Singleflight: a manual runOnce JOINS the in-flight round instead of
    // racing it (the start() immediate round and a prompt manual call would
    // otherwise double-fetch and race the forward-only slot write).
    const inFlight = activeRuns.values().next();
    if (!inFlight.done) return await inFlight.value;
    const run = runSyncRound(frozen).then(
      (changed) => changed,
      () => {
        // runSyncRound never throws by contract; this guard keeps the loop
        // alive even if a future revision breaks that contract.
        try {
          frozen.onError?.('round_failed');
        } catch {
          // An observer cannot terminate the sync loop.
        }
        return false;
      },
    );
    activeRuns.add(run);
    try {
      return await run;
    } finally {
      activeRuns.delete(run);
    }
  };

  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      const deadline = clock() + durationMs;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        resolveWait = undefined;
        resolve();
      };
      resolveWait = finish;
      const tick = () => {
        if (closed) {
          finish();
          return;
        }
        const remaining = deadline - clock();
        if (remaining <= 0) {
          finish();
          return;
        }
        timer = setTimeout(tick, Math.min(remaining, CLOCK_SLICE_MS));
        timer.unref?.();
      };
      tick();
    });

  const loop = async (): Promise<void> => {
    while (!closed) {
      try {
        await runOnce();
      } catch {
        // runOnce already normalizes every failure to false.
      }
      if (closed) break;
      await delayWithClose(intervalMs);
    }
  };
  const done = loop();
  return {
    runOnce,
    async close() {
      if (closed) return done;
      closed = true;
      resolveWait?.();
      if (timer !== undefined) clearTimeout(timer);
      await Promise.allSettled([done, ...activeRuns]).then(() => undefined);
      return undefined;
    },
  };
}
