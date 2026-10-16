/**
 * F4 Gemini CLI / Code Assist constants (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b; ported from
 * sub2api's backend/internal/pkg/geminicli/constants.go,
 * repository/geminicli_codeassist_client.go and service/gemini_quota.go).
 * Everything here is public client behavior — no secrets.
 *
 * The Gemini CLI OAuth client is Google's public installed-app client (RFC
 * 6749 §2.1: the client id is not a secret). Its published client_secret is
 * NOT embedded in this repo (secret-scanning push protection blocks the
 * provider-shaped literal); operators supply it through the
 * MODEL_ROUTER_GEMINI_OAUTH_CLIENT_SECRET environment variable, mirroring
 * sub2api's GEMINI_CLI_OAUTH_CLIENT_SECRET escape hatch.
 */

/** Gemini CLI (Cloud Code Assist) user agent, pinned byte-for-byte. */
export const GEMINI_CLI_USER_AGENT = 'GeminiCLI/0.1.5 (Windows; AMD64)';

/** Token-endpoint UA for the OAuth binding exchange (Google fingerprints non-CLI callers loosely; the plain client keeps parity with sub2api's req client). */
export const GEMINI_OAUTH_TOKEN_USER_AGENT = 'model-router';

/**
 * The loadCodeAssist/onboardUser metadata block sub2api sends (itself from
 * done-hub's internal Code Assist call): the observed Antigravity/GEMINI
 * fingerprint that keeps the internal endpoint serving CLI traffic.
 */
export const GEMINI_CODE_ASSIST_METADATA: Readonly<Record<string, string>> = Object.freeze({
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
});

/** The onboardUser tier id sub2api defaults to when the account is not yet onboarded. */
export const GEMINI_CODE_ASSIST_DEFAULT_TIER_ID = 'LEGACY';

/** AI Studio request normalization: the built-in search tool's camelCase spelling is rejected by generativelanguage. */
export const GEMINI_GOOGLE_SEARCH_TOOL_KEYS: readonly string[] = Object.freeze(['googleSearch', 'google_search']);

/**
 * Model id alias mapping: the catalog exposes the sub2api model-table ids;
 * clients may also send the dated/preview variants that normalize onto them.
 */
export const GEMINI_MODEL_ID_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'gemini-2.5-pro-latest': 'gemini-2.5-pro',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3.1-pro': 'gemini-3-pro-preview',
});

/** Reverse mapping: restore the catalog id from an overridden alias. */
export const GEMINI_MODEL_ID_REVERSE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(GEMINI_MODEL_ID_OVERRIDES).map(([alias, canonical]) => [canonical, alias])),
);

/** Default maxOutputTokens the gateway pads when the client omits generationConfig.maxOutputTokens. */
export const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

/** Canonical quota tier ids (sub2api service/gemini_oauth_service.go). */
export type GeminiQuotaTierId =
  | 'google_one_free'
  | 'google_ai_pro'
  | 'google_ai_ultra'
  | 'gcp_standard'
  | 'gcp_enterprise'
  | 'aistudio_free'
  | 'aistudio_paid'
  | 'google_one_unknown';

/** One tier's quota policy (sub2api service/gemini_quota.go). */
export interface GeminiTierQuota {
  /**
   * Shared requests-per-day pool across models (Google One / Code Assist
   * tiers). When > 0 the per-class limits do not apply for daily checks.
   */
  readonly sharedRpd: number;
  /** Shared requests-per-minute pool; 0 when the tier uses per-class limits. */
  readonly sharedRpm: number;
  /** Per-model-class daily limits (AI Studio); -1 means unlimited (pay-as-you-go). */
  readonly proRpd: number;
  readonly proRpm: number;
  readonly flashRpd: number;
  readonly flashRpm: number;
  /** Cooldown applied after a 429 RESOURCE_EXHAUSTED observation. */
  readonly cooldownMs: number;
}

/** The built-in tier policy table (sub2api newGeminiQuotaPolicy). */
export const GEMINI_TIER_QUOTAS: Readonly<Record<GeminiQuotaTierId, GeminiTierQuota>> = Object.freeze({
  google_one_free: {
    sharedRpd: 1_000,
    sharedRpm: 60,
    proRpd: 0,
    proRpm: 0,
    flashRpd: 0,
    flashRpm: 0,
    cooldownMs: 30 * 60_000,
  },
  google_ai_pro: {
    sharedRpd: 1_500,
    sharedRpm: 120,
    proRpd: 0,
    proRpm: 0,
    flashRpd: 0,
    flashRpm: 0,
    cooldownMs: 5 * 60_000,
  },
  google_ai_ultra: {
    sharedRpd: 2_000,
    sharedRpm: 120,
    proRpd: 0,
    proRpm: 0,
    flashRpd: 0,
    flashRpm: 0,
    cooldownMs: 5 * 60_000,
  },
  gcp_standard: {
    sharedRpd: 1_500,
    sharedRpm: 120,
    proRpd: 0,
    proRpm: 0,
    flashRpd: 0,
    flashRpm: 0,
    cooldownMs: 5 * 60_000,
  },
  gcp_enterprise: {
    sharedRpd: 2_000,
    sharedRpm: 120,
    proRpd: 0,
    proRpm: 0,
    flashRpd: 0,
    flashRpm: 0,
    cooldownMs: 5 * 60_000,
  },
  aistudio_free: {
    sharedRpd: 0,
    sharedRpm: 0,
    proRpd: 50,
    proRpm: 2,
    flashRpd: 1_500,
    flashRpm: 15,
    cooldownMs: 30 * 60_000,
  },
  aistudio_paid: {
    sharedRpd: 0,
    sharedRpm: 0,
    proRpd: -1,
    proRpm: 1_000,
    flashRpd: -1,
    flashRpm: 2_000,
    cooldownMs: 5 * 60_000,
  },
  google_one_unknown: {
    sharedRpd: 0,
    sharedRpm: 0,
    proRpd: 0,
    proRpm: 0,
    flashRpd: 0,
    flashRpm: 0,
    cooldownMs: 5 * 60_000,
  },
});

/**
 * Legacy/compat tier spellings (upstream loadCodeAssist responses and
 * historical data) mapped onto the canonical ids.
 */
export const GEMINI_LEGACY_TIER_IDS: Readonly<Record<string, GeminiQuotaTierId>> = Object.freeze({
  AI_PREMIUM: 'google_ai_pro',
  GOOGLE_ONE_UNLIMITED: 'google_ai_ultra',
  FREE: 'google_one_free',
  GOOGLE_ONE_BASIC: 'google_one_free',
  GOOGLE_ONE_STANDARD: 'google_one_free',
  GOOGLE_ONE_UNKNOWN: 'google_one_unknown',
  STANDARD: 'gcp_standard',
  PRO: 'gcp_standard',
  LEGACY: 'gcp_standard',
  ENTERPRISE: 'gcp_enterprise',
  ULTRA: 'gcp_enterprise',
  'standard-tier': 'gcp_standard',
  'pro-tier': 'gcp_standard',
  'ultra-tier': 'gcp_enterprise',
});

/**
 * The daily quota window's timezone: Gemini daily quotas reset at Pacific
 * midnight (sub2api geminiQuotaLocation / geminiDailyResetTime).
 */
export const GEMINI_QUOTA_TIME_ZONE = 'America/Los_Angeles';

/** Fallback 429 cooldown when the tier is unknown (sub2api CooldownForAccount default). */
export const GEMINI_UNKNOWN_TIER_COOLDOWN_MS = 5 * 60_000;

/**
 * google.rpc.Code status names the Gemini upstream returns in its JSON error
 * body, mapped to HTTP statuses (sub2api geminiGoogleStatusToHTTPStatus).
 */
export const GEMINI_GOOGLE_STATUS_TO_HTTP: Readonly<Record<string, number>> = Object.freeze({
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNKNOWN: 500,
  DATA_LOSS: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
});

/** The rate-limit status name the quota classifier keys on. */
export const GEMINI_RESOURCE_EXHAUSTED_STATUS = 'RESOURCE_EXHAUSTED';

/** Maximum model-id length accepted in a /v1beta path segment. */
export const GEMINI_MAX_MODEL_ID_LENGTH = 128;
