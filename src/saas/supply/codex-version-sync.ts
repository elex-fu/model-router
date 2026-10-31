/**
 * P0-1 Codex CLI client-version auto-sync (the sub2api version-sync port).
 *
 * ChatGPT's Codex backend deprioritizes stale client identities (HTTP 200
 * with the in-stream `server_is_overloaded` sentinel) and rejects versions
 * below CODEX_MIN_VERSION with a 404. The baseline compiled into
 * `gateway/codex/identity.ts` therefore needs an upstream-release tracker:
 * this module polls GitHub `openai/codex` releases, keeps the latest stable
 * `rust-vX.Y.Z` tag in the `saas.codex.client_version_synced` platform
 * settings key, and mirrors it into the process-level identity slot so the
 * gateway hot path advertises a current version without a settings read per
 * request.
 *
 * The loop follows the F6 OpenRouter pricing-sync worker shape: opt-in at
 * the workload composer, one immediate round then an interval, forward-only
 * writes (a downgrade or an unchanged value never writes), close() drains
 * the in-flight round. Fetching never throws — every failure mode returns
 * null and the next cycle retries.
 */

import {
  CODEX_MIN_VERSION,
  readSyncedCodexVersion,
  semverGte,
  updateSyncedCodexVersion,
} from '../gateway/codex/identity.js';
import {
  CODEX_CLIENT_VERSION_SETTINGS_KEY,
  CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY,
  CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY,
} from '../platform/settings/registry.js';

/** Pinned GitHub API endpoints for the openai/codex release feed. */
export const CODEX_VERSION_SYNC_LATEST_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
export const CODEX_VERSION_SYNC_RELEASES_LIST_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=30';
/** Per-operation fetch deadline (shared by the latest→list fallback pair). */
export const CODEX_VERSION_SYNC_REQUEST_TIMEOUT_MS = 15_000;
/** Response body cap: release documents are a few KiB; 1 MiB is a hard ceiling. */
export const CODEX_VERSION_SYNC_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Default sync cadence: 6 hours. */
export const CODEX_VERSION_SYNC_DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Interval clamp bounds. */
export const CODEX_VERSION_SYNC_MIN_INTERVAL_MS = 60_000;
export const CODEX_VERSION_SYNC_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Audit/observer label the worker stamps on every settings write. */
export const CODEX_VERSION_SYNC_WORKER_LABEL = 'codex-version-sync-worker';

/** Injectable fetch seam (tests); production uses the global fetch. */
export type CodexVersionSyncFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The narrow settings surface the worker needs: read of the synced value,
 * the admin override and the auto-sync switch, plus the worker-exclusive
 * write of the synced value. `managed-saas.ts` adapts PlatformSettingsService
 * to this shape; tests stub it directly.
 */
export interface CodexVersionSyncSettings {
  /** Current stored plain value for a registered settings key. */
  get(key: string): Promise<unknown>;
  /**
   * Writes a plain settings value. The context carries the worker's actor
   * and entryPoint label so the audit trail attributes the write.
   */
  put(key: string, value: string, context: Readonly<{ actor: string; entryPoint: string }>): Promise<void>;
}

export interface CodexVersionSyncWorkerOptions {
  /** Delay between completed sync rounds; clamped [1min, 24h], default 6h. */
  readonly intervalMs?: number;
  /** Test/custom seam; production uses the global fetch with pinned URLs. */
  readonly fetchImpl?: CodexVersionSyncFetch;
  /** Test seam for deterministic clocks (drives the interval scheduling). */
  readonly nowMs?: () => number;
  /** Static kill switch; false skips every sync cycle (default true). */
  readonly enabled?: boolean;
  /** Receives only stable cycle codes; never provider or credential data. */
  readonly onError?: (code: 'round_failed') => void;
}

export function clampCodexVersionSyncIntervalMs(raw: number | undefined): number {
  const parsed = raw ?? CODEX_VERSION_SYNC_DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(parsed) || parsed < CODEX_VERSION_SYNC_MIN_INTERVAL_MS) {
    return CODEX_VERSION_SYNC_MIN_INTERVAL_MS;
  }
  return Math.min(parsed, CODEX_VERSION_SYNC_MAX_INTERVAL_MS);
}

/** Stable release tag grammar: `rust-vMAJOR.MINOR.PATCH` (no prerelease). */
const CODEX_RELEASE_TAG_PATTERN = /^rust-v(\d+\.\d+\.\d+)$/;

/** Inverse of the tag grammar: the release tag a bare semver maps to. */
export function codexReleaseTagFor(version: string): string {
  return `rust-v${version}`;
}

/**
 * Extracts the bare semver from a release `tag_name`, or null when the tag
 * is not a stable `rust-vX.Y.Z` release (non-`rust-v` tags and prerelease
 * suffixes are skipped).
 */
export function parseCodexReleaseTagName(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const match = CODEX_RELEASE_TAG_PATTERN.exec(tag.trim());
  return match === null ? null : match[1];
}

/**
 * Extracts the latest stable version from one GitHub release object: the
 * tag must be a stable `rust-vX.Y.Z` AND the release's `prerelease` and
 * `draft` booleans must both be false. Returns null otherwise.
 */
export function parseCodexReleaseEntry(release: unknown): string | null {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) return null;
  const record = release as { readonly tag_name?: unknown; readonly prerelease?: unknown; readonly draft?: unknown };
  if (record.prerelease === true || record.draft === true) return null;
  return parseCodexReleaseTagName(record.tag_name);
}

type BoundedBodyResult =
  | { readonly state: 'ok'; readonly bytes: Uint8Array }
  | { readonly state: 'too_large' }
  | { readonly state: 'read_error' };

async function readBoundedBody(response: Response): Promise<BoundedBodyResult> {
  try {
    if (!response.body) return { state: 'ok', bytes: new Uint8Array() };
    const reader = response.body.getReader();
    const buffer = new Uint8Array(CODEX_VERSION_SYNC_MAX_RESPONSE_BYTES);
    let bytesRead = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return { state: 'ok', bytes: buffer.subarray(0, bytesRead) };
        if (!(value instanceof Uint8Array)) {
          cancel();
          return { state: 'read_error' };
        }
        if (value.byteLength > buffer.byteLength - bytesRead) {
          cancel();
          return { state: 'too_large' };
        }
        buffer.set(value, bytesRead);
        bytesRead += value.byteLength;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A cancelled or errored stream may already have released its reader.
      }
    }
  } catch {
    return { state: 'read_error' };
  }
}

function discardBody(response: Response): Promise<void> {
  try {
    return Promise.resolve(
      response.body?.cancel().then(
        () => undefined,
        () => undefined,
      ) ?? undefined,
    ).then(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

function parseJsonBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

type ReleaseDocumentResult =
  | { readonly state: 'ok'; readonly bytes: Uint8Array }
  | { readonly state: 'not_found' }
  | { readonly state: 'failed' };

async function fetchReleaseDocument(
  fetchImpl: CodexVersionSyncFetch,
  url: string,
  signal: AbortSignal,
): Promise<ReleaseDocumentResult> {
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'model-router' },
      redirect: 'manual',
      signal,
    });
  } catch {
    return { state: 'failed' };
  }
  if (response.status === 404) {
    await discardBody(response);
    return { state: 'not_found' };
  }
  if (response.status < 200 || response.status >= 300) {
    await discardBody(response);
    return { state: 'failed' };
  }
  const body = await readBoundedBody(response);
  if (body.state !== 'ok') return { state: 'failed' };
  return { state: 'ok', bytes: body.bytes };
}

/**
 * Fetches the latest stable Codex CLI version from GitHub. The
 * `/releases/latest` document is preferred; a 404 (or any other miss on
 * that endpoint) falls back to the `/releases?per_page=30` list and the
 * first stable `rust-v` entry wins (GitHub orders releases newest-first).
 *
 * Never throws: network errors, timeouts, redirects, oversize bodies,
 * malformed JSON and tag-less documents all return null.
 */
export async function fetchLatestCodexStableVersion(
  fetchImpl: CodexVersionSyncFetch = (url, init) => fetch(url, init),
): Promise<string | null> {
  const signal = AbortSignal.timeout(CODEX_VERSION_SYNC_REQUEST_TIMEOUT_MS);
  const latest = await fetchReleaseDocument(fetchImpl, CODEX_VERSION_SYNC_LATEST_RELEASES_URL, signal);
  if (latest.state === 'not_found') {
    const list = await fetchReleaseDocument(fetchImpl, CODEX_VERSION_SYNC_RELEASES_LIST_URL, signal);
    if (list.state !== 'ok') return null;
    const releases = parseJsonBody(list.bytes);
    if (!Array.isArray(releases)) return null;
    for (const release of releases) {
      const version = parseCodexReleaseEntry(release);
      if (version !== null) return version;
    }
    return null;
  }
  if (latest.state !== 'ok') return null;
  return parseCodexReleaseEntry(parseJsonBody(latest.bytes));
}

/** Bare-stable semver at or above the upstream minimum. */
function isEligibleSyncVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version) && semverGte(version, CODEX_MIN_VERSION);
}

/** Strict `candidate > floor` on already-eligible versions. */
function isGreaterThan(candidate: string, floor: string): boolean {
  return semverGte(candidate, floor) && !semverGte(floor, candidate);
}

/**
 * The higher of two candidate version strings, ignoring ineligible values.
 * Returns null when neither candidate is an eligible bare semver.
 */
export function maxEligibleCodexVersion(left: string | null, right: string | null): string | null {
  const leftEligible = left !== null && isEligibleSyncVersion(left) ? left : null;
  const rightEligible = right !== null && isEligibleSyncVersion(right) ? right : null;
  if (leftEligible === null) return rightEligible;
  if (rightEligible === null) return leftEligible;
  return isGreaterThan(rightEligible, leftEligible) ? rightEligible : leftEligible;
}

export type CodexVersionSyncRound =
  | { readonly state: 'synced'; readonly version: string; readonly previousVersion: string | null }
  | { readonly state: 'unchanged'; readonly version: string | null }
  | { readonly state: 'skipped_disabled' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'aborted' };

/**
 * Round-based version sync: check the auto-sync switch, read the stored
 * synced value and the admin override, fetch the latest stable release,
 * then — forward-only relative to max(synced, override) — write the synced
 * settings key and refresh the process-level identity slot. A singleflight
 * guard is unnecessary (one loop), but close() aborts and drains the
 * in-flight round exactly like the pricing-sync worker.
 */
export class CodexVersionSyncWorker {
  readonly intervalMs: number;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<CodexVersionSyncRound>>();
  private closePromise?: Promise<void>;

  constructor(
    private readonly settings: CodexVersionSyncSettings,
    private readonly options: CodexVersionSyncWorkerOptions = {},
  ) {
    if (!settings || typeof settings.get !== 'function' || typeof settings.put !== 'function') {
      throw new TypeError('codex version sync worker requires a settings surface');
    }
    this.options = Object.freeze({ ...options });
    this.intervalMs = clampCodexVersionSyncIntervalMs(options.intervalMs);
  }

  /** Performs one sync round; resolves the round outcome. */
  async runOnce(): Promise<CodexVersionSyncRound> {
    if (this.halt.signal.aborted) return { state: 'aborted' };
    const run = this.syncRound();
    this.activeRuns.add(run);
    try {
      return await run;
    } catch (error) {
      if (this.halt.signal.aborted) return { state: 'aborted' };
      throw error;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async syncRound(): Promise<CodexVersionSyncRound> {
    if (this.options.enabled === false) return { state: 'skipped_disabled' };
    if (await this.autoSyncDisabledBySettings()) return { state: 'skipped_disabled' };
    if (this.halt.signal.aborted) return { state: 'aborted' };

    const storedSynced = await this.readSettingString(CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY);
    const override = await this.readSettingString(CODEX_CLIENT_VERSION_SETTINGS_KEY);

    const latest = await fetchLatestCodexStableVersion(this.options.fetchImpl);
    if (latest === null) return { state: 'unavailable' };
    if (this.halt.signal.aborted) return { state: 'aborted' };
    if (!isEligibleSyncVersion(latest)) return { state: 'unchanged', version: latest };

    const current = maxEligibleCodexVersion(storedSynced, override);
    if (current !== null && !isGreaterThan(latest, current)) {
      // Forward-only: an unchanged or older release never writes, and a
      // value below the admin override never downgrades the synced key.
      return { state: 'unchanged', version: latest };
    }

    await this.settings.put(CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY, latest, {
      actor: CODEX_VERSION_SYNC_WORKER_LABEL,
      entryPoint: CODEX_VERSION_SYNC_WORKER_LABEL,
    });
    if (this.halt.signal.aborted) return { state: 'aborted' };
    updateSyncedCodexVersion(latest);
    return { state: 'synced', version: latest, previousVersion: storedSynced };
  }

  private async autoSyncDisabledBySettings(): Promise<boolean> {
    try {
      const value = await this.settings.get(CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY);
      return value === false || value === 'false';
    } catch {
      // An unreadable switch must not mask a working sync path; the value
      // reads below degrade to "absent" the same way.
      return false;
    }
  }

  private async readSettingString(key: string): Promise<string | null> {
    try {
      const value = await this.settings.get(key);
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    } catch {
      return null;
    }
  }

  /** Stops the worker; resolves once the active round has settled. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns]).then(() => undefined);
    return this.closePromise;
  }
}

export interface CodexVersionSyncWorkerHandle {
  close(): Promise<void>;
}

/**
 * Starts the sync loop: one immediate round, then one round per clamped
 * interval. The interval wait is measured against the injected clock and
 * re-checked on short slices, so a deterministic `nowMs` seam can advance
 * virtual time without waiting the real interval.
 */
export function startCodexVersionSyncWorker(
  settings: CodexVersionSyncSettings,
  options: CodexVersionSyncWorkerOptions = {},
): CodexVersionSyncWorkerHandle {
  const worker = new CodexVersionSyncWorker(settings, options);
  const clock = options.nowMs ?? Date.now;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const CLOCK_SLICE_MS = 250;
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
      };
      tick();
    });
  const loop = async (): Promise<void> => {
    while (!closed) {
      try {
        await worker.runOnce();
      } catch {
        if (closed) break;
        try {
          options.onError?.('round_failed');
        } catch {
          // An observer cannot terminate the sync loop.
        }
      }
      if (closed) break;
      await delayWithClose(worker.intervalMs);
    }
  };
  const done = loop();
  return {
    async close() {
      if (closed) return done;
      closed = true;
      const closeWorker = worker.close();
      resolveWait?.();
      if (timer !== undefined) clearTimeout(timer);
      await Promise.all([closeWorker, done]);
    },
  };
}

/**
 * Startup seeding (managed-saas composition): reads the stored synced value
 * and the admin override once and seeds the process-level identity slot
 * with max(synced, override). The existing call sites pass no per-request
 * override, so the synced slot is the only injection point the gateway hot
 * path consults; the worker keeps it fresh from every synced write.
 *
 * @returns the seeded version, or null when nothing eligible is stored.
 */
export async function seedSyncedCodexVersionFromSettings(settings: CodexVersionSyncSettings): Promise<string | null> {
  const synced = await readSettingStringValue(settings, CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY);
  const override = await readSettingStringValue(settings, CODEX_CLIENT_VERSION_SETTINGS_KEY);
  const seed = maxEligibleCodexVersion(synced, override);
  if (seed === null) return readSyncedCodexVersion();
  updateSyncedCodexVersion(seed);
  return seed;
}

async function readSettingStringValue(settings: CodexVersionSyncSettings, key: string): Promise<string | null> {
  try {
    const value = await settings.get(key);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}
