/**
 * P1a Codex outbound identity (design: docs/sub2api-parity-upgrade-plan-2026-10-15.md
 * §1.4). Pure, allocation-light helpers with zero IO: the gateway transport
 * rewrites every outbound request to a canonical (userAgent, originator,
 * version) trio before it leaves the process, and derives per-account
 * namespaced session identifiers so a client conversation can never appear
 * under two different upstream credentials after a failover.
 *
 * - `buildCanonicalIdentity` pins the Codex CLI baseline UA shape
 *   `{originator}/{version} ({OS} {osver}; {arch}) {terminal}`; an override
 *   below CODEX_MIN_VERSION would be rejected by the upstream with a 404, so
 *   it degrades to the baseline instead of ever emitting an unusable trio.
 * - `accountIdentityNamespace` / `isolateSessionId` implement the mandatory
 *   per-account identity namespace: the same raw client session id hashes to
 *   a different 8-hex identifier under every (proxy key, ChatGPT account)
 *   pair.
 * - Fingerprint convergence is opt-in per account (`FingerprintMode`), with
 *   `deriveStableUUIDv4` providing deterministic, spec-shaped UUIDv4 values
 *   from a persisted per-account seed. Mode `off` (the default) never
 *   rewrites client-provided identifiers.
 */

import {
  type IdentityNamespaceError,
  deriveStableUUIDv4 as sharedDeriveStableUUIDv4,
  isolateSessionId as sharedIsolateSessionId,
} from '../oauth-subscription/identity-namespace.js';

/** Lowest CLI version the upstream still serves; below this the upstream answers 404. */
export const CODEX_MIN_VERSION = '0.144.0';
/** Version the canonical UA advertises when no tracked override is supplied. */
export const CODEX_BASELINE_VERSION = '0.146.0';
/** Default `originator` value reported by the Codex CLI Rust build. */
export const CODEX_DEFAULT_ORIGINATOR = 'codex_cli_rs';

/** Terminal profile embedded in the canonical UA parenthetical. */
export interface CodexTerminalProfile {
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
  readonly terminal: string;
}

/** Conservative default profile: current Codex CLI release on Apple Silicon macOS. */
export const CODEX_DEFAULT_TERMINAL_PROFILE: CodexTerminalProfile = {
  os: 'Mac OS X',
  osVersion: '10.15.7',
  arch: 'arm64',
  terminal: 'Apple_Terminal',
};

/** Self-consistent outbound identity trio. */
export interface CodexCanonicalIdentity {
  readonly userAgent: string;
  readonly originator: string;
  readonly version: string;
}

/** ChatGPT account coordinates carried inside the sealed credential envelope. */
export interface CodexAccountCoordinates {
  readonly chatgptAccountId: string;
  readonly chatgptUserId: string;
}

export type CodexIdentityErrorCode = 'MALFORMED_VERSION' | 'MALFORMED_ACCOUNT' | 'MALFORMED_INPUT';

export class CodexIdentityError extends Error {
  constructor(readonly code: CodexIdentityErrorCode) {
    super(
      code === 'MALFORMED_VERSION'
        ? 'codex version string is malformed'
        : code === 'MALFORMED_ACCOUNT'
          ? 'codex account coordinates are malformed'
          : 'codex identity input is malformed',
    );
    this.name = 'CodexIdentityError';
  }
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

function parseSemver(value: string): ParsedSemver | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch, prerelease: match[4] !== undefined };
}

/**
 * Numeric semver comparison (`candidate >= minimum`). Prerelease tags only
 * break ties: `1.2.3-rc.1 < 1.2.3`. Malformed candidates compare as less
 * than any well-formed minimum so callers fail safe to the baseline.
 */
export function semverGte(candidate: string, minimum: string): boolean {
  const left = parseSemver(candidate);
  const right = parseSemver(minimum);
  if (!left || !right) return false;
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  if (left.patch !== right.patch) return left.patch > right.patch;
  return !left.prerelease || !right.prerelease ? !left.prerelease : true;
}

/**
 * Process-level slot holding the latest auto-synced Codex CLI version (P0-1
 * codex version auto-sync, the sub2api version-sync port). Only the sync
 * worker writes it; the gateway hot path reads it through
 * `buildCanonicalIdentity` without awaiting a settings row per request.
 */
let syncedCodexVersion: string | null = null;

/**
 * Stores a worker-observed stable version in the process-level synced slot.
 * Validation mirrors the resolution chain (the internal semver parse): the
 * value must be a well-formed, non-prerelease semver at or above
 * CODEX_MIN_VERSION. Never throws — malformed or ineligible input simply
 * returns false and leaves the slot untouched.
 *
 * @returns whether the stored synced version changed.
 */
export function updateSyncedCodexVersion(version: string): boolean {
  if (typeof version !== 'string') return false;
  const candidate = version.trim();
  const parsed = parseSemver(candidate);
  if (parsed === null || parsed.prerelease) return false;
  if (!semverGte(candidate, CODEX_MIN_VERSION)) return false;
  if (syncedCodexVersion === candidate) return false;
  syncedCodexVersion = candidate;
  return true;
}

/** The currently synced version, or null when the worker has not stored one. */
export function readSyncedCodexVersion(): string | null {
  return syncedCodexVersion;
}

/** Test-only: clears the synced slot so suites stay order-independent. */
export function resetSyncedCodexVersionForTests(): void {
  syncedCodexVersion = null;
}

/**
 * Canonical outbound identity trio. Resolution order:
 *
 * 1. `versionOverride` — honored only when well-formed and at or above
 *    CODEX_MIN_VERSION (an explicit per-request override always wins);
 * 2. the process-level synced slot (`updateSyncedCodexVersion`), same
 *    eligibility rule;
 * 3. CODEX_BASELINE_VERSION.
 *
 * Anything else degrades to CODEX_BASELINE_VERSION because a low version is
 * rejected upstream with a plain 404. The three returned values are always
 * mutually consistent.
 */
export function buildCanonicalIdentity(
  versionOverride?: string,
  profile: CodexTerminalProfile = CODEX_DEFAULT_TERMINAL_PROFILE,
): CodexCanonicalIdentity {
  const overrideVersion =
    versionOverride !== undefined && versionOverride !== null && semverGte(versionOverride, CODEX_MIN_VERSION)
      ? versionOverride.trim()
      : null;
  const syncedVersion =
    syncedCodexVersion !== null && semverGte(syncedCodexVersion, CODEX_MIN_VERSION) ? syncedCodexVersion : null;
  const version = overrideVersion ?? syncedVersion ?? CODEX_BASELINE_VERSION;
  const originator = CODEX_DEFAULT_ORIGINATOR;
  const userAgent = `${originator}/${version} (${profile.os} ${profile.osVersion}; ${profile.arch}) ${profile.terminal}`;
  return { userAgent, originator, version };
}

/**
 * Per-account identity namespace `chatgpt:{accountId}:user:{userId}`. Empty
 * coordinates throw: an account without them must never silently share a
 * namespace with another account.
 */
export function accountIdentityNamespace(account: CodexAccountCoordinates): string {
  if (
    typeof account?.chatgptAccountId !== 'string' ||
    account.chatgptAccountId.length === 0 ||
    typeof account?.chatgptUserId !== 'string' ||
    account.chatgptUserId.length === 0
  ) {
    throw new CodexIdentityError('MALFORMED_ACCOUNT');
  }
  return `chatgpt:${account.chatgptAccountId}:user:${account.chatgptUserId}`;
}

/**
 * Namespaced session identifier (shared oauth-subscription kernel behind the
 * codex validation surface): first 8 hex characters of
 * `sha256("u{keyId}:a{namespace}:{raw}")`. Equal raw ids collide only when
 * both the proxy key and the account namespace match, which is exactly the
 * failover isolation guarantee the scheduler relies on.
 */
export function isolateSessionId(keyId: string, namespace: string, raw: string): string {
  try {
    return sharedIsolateSessionId(keyId, namespace, raw);
  } catch (error) {
    if (isIdentityNamespaceError(error)) throw new CodexIdentityError('MALFORMED_INPUT');
    throw error;
  }
}

/** Account-level fingerprint convergence mode; `off` is the safe default. */
export type FingerprintMode = 'off' | 'device' | 'session' | 'full';

/** Namespace prefix used to derive the converged installation id from a seed. */
export const CODEX_INSTALL_ID_NAMESPACE = 'mr:codex-install-id:v1:';
/** Namespace prefix used to derive the converged session id (full mode). */
export const CODEX_SESSION_ID_NAMESPACE = 'mr:codex-session-id:v1:';
/** Namespace prefix used to derive converged thread ids. */
export const CODEX_THREAD_ID_NAMESPACE = 'mr:codex-thread-id:v1:';

/**
 * Deterministic UUIDv4 from an arbitrary string (shared
 * oauth-subscription kernel): SHA-256 digest forced onto the RFC 4122
 * version-4/variant-1 grid. Same input always produces the same UUID; the
 * namespace prefixes above keep derivation domains disjoint.
 */
export function deriveStableUUIDv4(input: string): string {
  try {
    return sharedDeriveStableUUIDv4(input);
  } catch (error) {
    if (isIdentityNamespaceError(error)) throw new CodexIdentityError('MALFORMED_INPUT');
    throw error;
  }
}

function isIdentityNamespaceError(error: unknown): error is IdentityNamespaceError {
  return error instanceof Error && error.name === 'IdentityNamespaceError';
}

/** Inputs to fingerprint convergence; the seed is the persisted per-account value. */
export interface ResolveFingerprintIdsInput {
  readonly mode: FingerprintMode;
  readonly seed: string;
  readonly clientSessionId: string | null;
  readonly adminDeviceId?: string | null;
}

/** Converged identifiers; `null` means "pass the client value through untouched". */
export interface ResolvedFingerprintIds {
  readonly installationId: string | null;
  readonly sessionId: string | null;
  readonly threadId: string | null;
}

/**
 * Fingerprint convergence per account mode:
 *
 * - `off`: pass-through — nothing is rewritten; the admin device id (if any)
 *   is echoed back for the installation header.
 * - `device`: only the installation id converges on the seed.
 * - `session`: installation converges and the thread id is derived from the
 *   client session id (stable per client conversation, unique per account).
 * - `full`: all three identifiers are seed-only constants.
 *
 * Non-`off` modes require a non-empty seed; a missing seed throws rather
 * than silently converging every account onto one identity.
 */
export function resolveFingerprintIds(input: ResolveFingerprintIdsInput): ResolvedFingerprintIds {
  if (input?.mode !== 'off' && input?.mode !== 'device' && input?.mode !== 'session' && input?.mode !== 'full') {
    throw new CodexIdentityError('MALFORMED_INPUT');
  }
  const clientSessionId = input.clientSessionId === undefined ? null : input.clientSessionId;
  if (input.mode === 'off') {
    return {
      installationId: input.adminDeviceId ?? null,
      sessionId: clientSessionId,
      threadId: clientSessionId,
    };
  }
  if (typeof input.seed !== 'string' || input.seed.length === 0) throw new CodexIdentityError('MALFORMED_INPUT');
  const installationId = deriveStableUUIDv4(`${CODEX_INSTALL_ID_NAMESPACE}${input.seed}`);
  if (input.mode === 'device') {
    return { installationId, sessionId: clientSessionId, threadId: clientSessionId };
  }
  if (input.mode === 'session') {
    const threadId = deriveStableUUIDv4(`${CODEX_THREAD_ID_NAMESPACE}${input.seed}:${clientSessionId ?? 'none'}`);
    return { installationId, sessionId: clientSessionId, threadId };
  }
  return {
    installationId,
    sessionId: deriveStableUUIDv4(`${CODEX_SESSION_ID_NAMESPACE}${input.seed}`),
    threadId: deriveStableUUIDv4(`${CODEX_THREAD_ID_NAMESPACE}${input.seed}`),
  };
}
