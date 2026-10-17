/**
 * Batch-3 Grok pinned upstream constants (sub2api backend/internal/pkg/xai
 * oauth.go + cli_identity.go + billing.go port). These are the only hosts and
 * identity values the grok category ever dials or advertises in production.
 */

/** OAuth (Grok CLI subscription) default base: the CLI chat proxy surface. */
export const GROK_OAUTH_DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
/** xAI API-key default base: the official public API. */
export const GROK_API_KEY_DEFAULT_BASE_URL = 'https://api.x.ai/v1';

/** The CLI chat proxy hostname that requires the official CLI identity headers. */
export const GROK_CLI_PROXY_HOST = 'cli-chat-proxy.grok.com';

/**
 * Official xAI upstream hosts. OAuth token traffic is ONLY ever sent to these
 * (the SSRF hard gate); regional endpoints (*.api.x.ai) are covered by the
 * wildcard so operators can dodge a single-region outage.
 */
export const GROK_OFFICIAL_API_HOST = 'api.x.ai';
export const GROK_OFFICIAL_HOST_SUFFIX = '.api.x.ai';
export const GROK_OFFICIAL_HOSTS: readonly string[] = Object.freeze([
  GROK_OFFICIAL_API_HOST,
  `*.${GROK_OFFICIAL_API_HOST}`,
  GROK_CLI_PROXY_HOST,
]);

/** Whether a hostname belongs to the official xAI API / regional / CLI-proxy family. */
export function isGrokOfficialHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === GROK_OFFICIAL_API_HOST || host === GROK_CLI_PROXY_HOST) return true;
  return host.endsWith(GROK_OFFICIAL_HOST_SUFFIX) && host.length > GROK_OFFICIAL_HOST_SUFFIX.length;
}

/*
 * Fixed Grok Build / CLI-chat-proxy client identity (sub2api cli_identity.go
 * + billing.go CLIClientVersion). The version is pinned in-source; operators
 * may bump via MODEL_ROUTER_GROK_CLI_VERSION without a release. Keep in sync
 * with the pinned client the CLI proxy still serves.
 */

/** Known-good minimum client version accepted by cli-chat-proxy. */
export const GROK_CLI_STABLE_VERSION = '0.2.93';
/** The pinned Grok CLI client version this router advertises (sub2api CLIClientVersion). */
export const GROK_CLI_CLIENT_VERSION = '0.2.120';
/** Optional operator override for the pinned client version. */
export const GROK_CLI_VERSION_ENV = 'MODEL_ROUTER_GROK_CLI_VERSION';

/** Required by cli-chat-proxy for Grok Build OAuth tokens. */
export const GROK_CLI_TOKEN_AUTH_HEADER = 'x-xai-token-auth';
export const GROK_CLI_TOKEN_AUTH_VALUE = 'xai-grok-cli';
export const GROK_CLI_VERSION_HEADER = 'x-grok-client-version';
export const GROK_CLIENT_IDENTIFIER_HEADER = 'x-grok-client-identifier';
/** The x-grok-client-identifier value used by the Grok shell/CLI. */
export const GROK_CLIENT_IDENTIFIER = 'grok-shell';

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => Number.isSafeInteger(part)) ? (parts as unknown as [number, number, number]) : null;
}

function semverAtLeast(candidate: string, minimum: string): boolean {
  const left = parseSemver(candidate);
  const right = parseSemver(minimum);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

/**
 * Resolves the advertised CLI client version: an operator override is honored
 * only when it is well-formed semver at or above GROK_CLI_STABLE_VERSION;
 * anything else falls back to the pinned GROK_CLI_CLIENT_VERSION (a version
 * below the floor is rejected by the CLI proxy with a plain 404).
 */
export function resolveGrokCliVersion(override?: string | null): string {
  const value = (override ?? process.env[GROK_CLI_VERSION_ENV] ?? '').trim();
  return value !== '' && semverAtLeast(value, GROK_CLI_STABLE_VERSION) ? value : GROK_CLI_CLIENT_VERSION;
}

/** Workspace-style User-Agent for one CLI client version. */
export function grokCliUserAgent(version: string = resolveGrokCliVersion()): string {
  return `xai-grok-workspace/${version.trim() === '' ? GROK_CLI_CLIENT_VERSION : version.trim()}`;
}

/**
 * The fixed Grok CLI identity header set (pure). Stamped only when the request
 * targets the CLI chat proxy host — direct api.x.ai traffic is left unchanged
 * (the official API rejects the CLI token-auth marker on OAuth traffic).
 */
export function grokCliIdentityHeaders(version: string = resolveGrokCliVersion()): Readonly<Record<string, string>> {
  return Object.freeze({
    [GROK_CLI_TOKEN_AUTH_HEADER]: GROK_CLI_TOKEN_AUTH_VALUE,
    [GROK_CLI_VERSION_HEADER]: version,
    [GROK_CLIENT_IDENTIFIER_HEADER]: GROK_CLIENT_IDENTIFIER,
    'user-agent': grokCliUserAgent(version),
  });
}

/**
 * Applies the CLI identity masquerade to an outbound header map (copy-on-write
 * when nothing changes). `hostname` is the request's target host; the identity
 * is stamped only for the CLI proxy host (case-insensitive), never for the
 * official api.x.ai family.
 */
export function applyGrokCliProxyHeaders(
  headers: Readonly<Record<string, string>>,
  hostname: string,
  version: string = resolveGrokCliVersion(),
): Record<string, string> {
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (host !== GROK_CLI_PROXY_HOST) return { ...headers };
  return { ...headers, ...grokCliIdentityHeaders(version) };
}

/*
 * Billing probe surface (sub2api billing.go): weekly credits window plus the
 * monthly billing view, both on the CLI proxy base.
 */
export const GROK_BILLING_WEEKLY_PATH = '/billing?format=credits';
export const GROK_BILLING_MONTHLY_PATH = '/billing';

/** Monthly limit (cents) identifying SuperGrok. */
export const GROK_SUPERGROK_MONTHLY_LIMIT_CENTS = 15_000;
/** Monthly limit (cents) identifying SuperGrok Heavy. */
export const GROK_SUPERGROK_HEAVY_MONTHLY_LIMIT_CENTS = 150_000;

/*
 * Free-tier soft gate (sub2api quota.go GrokFreeRolling24hTokenLimit): the
 * nominal rolling-24h token allowance for subscription_tier=free accounts.
 * Upstream headers may still report historical 1M/2M free snapshots; the
 * local gate uses the nominal value.
 */
export const GROK_FREE_ROLLING_24H_TOKEN_LIMIT = 500_000;
/** Local rolling-24h usage at or above this fraction of the nominal limit excludes a free account. */
export const GROK_FREE_SOFT_GATE_FRACTION = 0.95;
