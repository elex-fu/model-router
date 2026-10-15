import { CLAUDE_CLI_BASELINE_VERSION, CLAUDE_CLI_VERSION_ENV } from './constants.js';

/**
 * R5 Claude outbound identity (design: docs/token-resale-implementation-plan-2026-10-15.md
 * §R5). Pure helpers: the CLI version pin (UA + billing attribution must
 * always agree within one process, mirroring the sub2api
 * resolveCLIVersion-once rule), the `claude-cli/{version}` UA shape, and the
 * per-account identity namespace built on the shared oauth-subscription
 * kernel so a failover never exposes one client conversation under two
 * Claude accounts.
 */

export type ClaudeIdentityErrorCode = 'MALFORMED_VERSION' | 'MALFORMED_ACCOUNT';

export class ClaudeIdentityError extends Error {
  constructor(readonly code: ClaudeIdentityErrorCode) {
    super(
      code === 'MALFORMED_VERSION'
        ? 'claude cli version string is malformed'
        : 'claude account coordinates are malformed',
    );
    this.name = 'ClaudeIdentityError';
  }
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseStrictSemver(value: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

function semverGte(left: ParsedSemver, right: ParsedSemver): boolean {
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  return left.patch >= right.patch;
}

/** Whether an operator override is usable: strict three-part semver, >= the built-in pin. */
export function isSupportedClaudeCliVersion(version: string): boolean {
  if (typeof version !== 'string') return false;
  const trimmed = version.trim();
  if (trimmed.length === 0) return false;
  const parsed = parseStrictSemver(trimmed);
  if (parsed === null) return false;
  return semverGte(parsed, parseStrictSemver(CLAUDE_CLI_BASELINE_VERSION) as ParsedSemver);
}

/**
 * Resolves the CLI version this process advertises. An empty override falls
 * back to the built-in pin silently (unconfigured is normal); a non-empty
 * but invalid one also falls back (silently ignoring an explicit override
 * would let an operator believe it took effect — the caller decides how to
 * surface that; production callers log the degradation).
 */
export function resolveClaudeCliVersion(envOverride?: string | undefined): string {
  const raw = typeof envOverride === 'string' ? envOverride.trim() : '';
  if (raw.length === 0) return CLAUDE_CLI_BASELINE_VERSION;
  return isSupportedClaudeCliVersion(raw) ? raw.trim() : CLAUDE_CLI_BASELINE_VERSION;
}

/** Reads the process environment pin (test seam; production reads process.env once). */
export function resolveClaudeCliVersionFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveClaudeCliVersion(env[CLAUDE_CLI_VERSION_ENV]);
}

/** The UA the official CLI sends: `claude-cli/{version}`. */
export function buildClaudeUserAgent(cliVersion: string): string {
  if (!isSupportedClaudeCliVersion(cliVersion) && cliVersion !== CLAUDE_CLI_BASELINE_VERSION) {
    throw new ClaudeIdentityError('MALFORMED_VERSION');
  }
  return `claude-cli/${cliVersion}`;
}

/** Claude account coordinates carried inside the sealed credential envelope. */
export interface ClaudeAccountCoordinates {
  readonly organizationUuid: string;
  readonly accountUuid: string;
}

/**
 * Per-account identity namespace `claude:{organizationUuid}:account:{accountUuid}`.
 * Empty coordinates throw: an account without them must never silently share
 * a namespace with another account.
 */
export function claudeAccountIdentityNamespace(account: ClaudeAccountCoordinates): string {
  if (
    typeof account?.organizationUuid !== 'string' ||
    account.organizationUuid.length === 0 ||
    typeof account?.accountUuid !== 'string' ||
    account.accountUuid.length === 0
  ) {
    throw new ClaudeIdentityError('MALFORMED_ACCOUNT');
  }
  return `claude:${account.organizationUuid}:account:${account.accountUuid}`;
}
