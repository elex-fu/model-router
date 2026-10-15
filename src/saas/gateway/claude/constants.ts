/**
 * R5 Claude Code mimicry constants (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5 勘察结论; ported
 * from sub2api's backend/internal/pkg/claude/constants.go and the plan's
 * black-box-verified ordered beta set). Everything here is public client
 * behavior — no secrets.
 *
 * The ordered beta-header set is the load-bearing mimicry signal: missing any
 * beta the official CLI carries gets the request demoted to third-party
 * quota ("Third-party apps now draw from your extra usage, not your plan
 * limits."). The `server-side-fallback-*` family is NEVER auto-added — it
 * swaps models and changes billing.
 */

/** Ordered full Claude Code mimicry beta set (OAuth accounts, every model). */
export const CLAUDE_CODE_MIMICRY_BETAS: readonly string[] = Object.freeze([
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'token-counting-2024-11-01',
  'context-1m-2025-08-07',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'context-management-2025-06-27',
  'extended-cache-ttl-2025-04-11',
]);

/** The beta tokens that must never be auto-added (server-side fallback family). */
export const CLAUDE_SERVER_SIDE_FALLBACK_BETAS: readonly string[] = Object.freeze([
  'server-side-fallback-2026-07-01',
  'fallback-credit-2026-07-01',
  'fallback-credit-2026-06-01',
]);

/** Joined `anthropic-beta` header value for the OAuth mimicry path. */
export const CLAUDE_CODE_MIMICRY_BETA_HEADER = CLAUDE_CODE_MIMICRY_BETAS.join(',');

/** Count-tokens variant: same ordered set (token-counting is already included). */
export const CLAUDE_COUNT_TOKENS_BETA_HEADER = CLAUDE_CODE_MIMICRY_BETA_HEADER;

/** API-key variant: no oauth beta (the account is not OAuth-scoped). */
export const CLAUDE_API_KEY_BETA_HEADER = CLAUDE_CODE_MIMICRY_BETAS.filter((beta) => beta !== 'oauth-2025-04-20').join(
  ',',
);

/**
 * Built-in Claude Code CLI version pin advertised by the UA and embedded in
 * the billing attribution block (must match byte-for-byte or Anthropic flags
 * the request as third-party). Operators may override upward through
 * CLAUDE_CLI_VERSION_ENV when a model demands a newer client floor.
 */
export const CLAUDE_CLI_BASELINE_VERSION = '2.1.258';
/** Environment variable carrying the operator's CLI version override. */
export const CLAUDE_CLI_VERSION_ENV = 'MODEL_ROUTER_CLAUDE_CLI_VERSION';

/** The `x-stainless-*` header family the Claude Code CLI's SDK sends. */
export const CLAUDE_STAINLESS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.94.0',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'arm64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
});

/** Remaining fixed client-identity headers outside the stainless family. */
export const CLAUDE_CLIENT_IDENTITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true',
});

/** Anthropic protocol version pinned by the official CLI. */
export const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';

/** Default cache_control TTL the gateway uses for its own injected blocks. */
export const CLAUDE_DEFAULT_CACHE_CONTROL_TTL = '5m';

/**
 * Model ID date-suffix mapping: the OAuth upstream only accepts the dated
 * form; the catalog exposes the short aliases (reverse map below).
 */
export const CLAUDE_MODEL_ID_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
});

/** Reverse mapping: restore the client-facing short alias from the dated id. */
export const CLAUDE_MODEL_ID_REVERSE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(CLAUDE_MODEL_ID_OVERRIDES).map(([alias, dated]) => [dated, alias])),
);

/**
 * The billing-fingerprint salt (sub2api gateway_billing_block.go, itself from
 * the real CLI capture): part of the public fingerprint algorithm, not a
 * secret.
 */
export const CLAUDE_FINGERPRINT_SALT = '59cf53e54c78';

/** Maximum cache_control blocks the Anthropic upstream accepts. */
export const CLAUDE_MAX_CACHE_CONTROL_BLOCKS = 4;

/** Default max_tokens the real CLI sends when the client omits it. */
export const CLAUDE_DEFAULT_MAX_TOKENS = 128_000;
/** Default temperature the real CLI sends when the client omits it. */
export const CLAUDE_DEFAULT_TEMPERATURE = 1;

/**
 * The context_management default the CLI attaches when thinking is
 * enabled/adaptive and the client did not send its own.
 */
export const CLAUDE_DEFAULT_CONTEXT_MANAGEMENT = Object.freeze({
  edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
});
