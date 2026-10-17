/**
 * Batch-3 Vertex AI constants (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; ported from
 * sub2api's backend/internal/service/vertex_service_account.go,
 * gateway_upstream_request.go vertexSupportedBetaTokens and
 * gemini_messages_compat_service.go Vertex 429 semantics). Everything here is
 * public client behavior — no secrets.
 */

import type { VertexAccountCoordinates } from './catalog-identity.js';

/**
 * The ONLY token endpoint the Vertex SA JWT-bearer exchange ever dials. The
 * service-account JSON's `token_uri` field is parsed but ALWAYS overridden
 * with this pinned value (sub2api vertex_service_account.go L131 SSRF
 * guard): a crafted token_uri must never steer the exchange at an
 * attacker-chosen host.
 */
export const VERTEX_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The OAuth scope the SA assertion requests (cloud-platform covers Vertex). */
export const VERTEX_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The jwt-bearer grant type identifier (RFC 7523 §4.1). */
export const VERTEX_JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** SA assertion lifetime (JWT `exp` − `iat`): one hour, sub2api parity. */
export const VERTEX_ASSERTION_LIFETIME_MS = 3_600_000;

/** The access-token cache skew subtracted from expires_in (sub2api parity). */
export const VERTEX_TOKEN_CACHE_SKEW_MS = 5 * 60_000;

/** Fallback access-token TTL when the token response omits expires_in. */
export const VERTEX_TOKEN_DEFAULT_TTL_MS = 3_600_000;

/** The default Vertex location when the credential carries none. */
export const VERTEX_DEFAULT_LOCATION = 'us-central1';

/** Location ids are lowercase alphanumerics plus dashes (sub2api pattern). */
export const VERTEX_LOCATION_PATTERN = /^[a-z0-9-]+$/;

/** Maximum accepted location id length. */
export const VERTEX_MAX_LOCATION_LENGTH = 32;

/**
 * `anthropic_version` injected into every Anthropic-on-Vertex request body
 * (the endpoint rejects the request without it; sub2api
 * vertexAnthropicVersion).
 */
export const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';

/**
 * The Anthropic beta tokens the Vertex AI Anthropic endpoint accepts. Vertex
 * answers any unknown token with HTTP 400 (sub2api issue #3358), so the
 * gateway applies this WHITELIST rather than a blacklist: future Claude Code
 * betas Vertex has not shipped are stripped naturally. Explicitly excluded
 * (observed 400s): advisor-tool-2026-03-01, prompt-caching-scope-2026-01-05,
 * redact-thinking-2026-02-12, thinking-token-count-2026-05-13, plus the
 * client-identity betas (claude-code-20250219 / oauth-2025-04-20) — the
 * service-account path authenticates with Bearer, not client identity.
 */
export const VERTEX_SUPPORTED_BETA_TOKENS: readonly string[] = Object.freeze([
  'context-1m-2025-08-07',
  'context-management-2025-06-27',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
]);

/** The context-management beta token (gates body.context_management). */
export const VERTEX_BETA_CONTEXT_MANAGEMENT = 'context-management-2025-06-27';

/**
 * Client request headers forwarded to the Anthropic-on-Vertex endpoint
 * (sub2api allowedHeaders, CRS-derived). `anthropic-version` is stripped —
 * the vertex body carries `anthropic_version` instead — and authentication
 * headers are removed separately so the Bearer injection is the only auth
 * on the wire.
 */
export const VERTEX_ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = Object.freeze(
  new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'anthropic-beta',
    'anthropic-dangerous-direct-browser-access',
    'content-type',
    'sec-fetch-mode',
    'user-agent',
    'x-app',
    'x-client-request-id',
    'x-claude-code-session-id',
    'x-stainless-arch',
    'x-stainless-helper-method',
    'x-stainless-lang',
    'x-stainless-os',
    'x-stainless-package-version',
    'x-stainless-retry-count',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    'x-stainless-timeout',
  ]),
);

/**
 * Authentication/identity headers never forwarded: the transport's Bearer
 * injection is the only upstream authentication (sub2api
 * buildUpstreamRequestAnthropicVertex deletes all four).
 */
export const VERTEX_STRIPPED_AUTH_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
]);

/**
 * Vertex is pay-as-you-go: a 429 is a short-window RPM/TPM throttle with no
 * daily quota, so there is no Pacific-midnight reset for this category
 * (sub2api gemini_messages_compat_service.go: "Vertex 按量付费：短窗限速，无每日
 * 配额"). The RetryInfo retryDelay is honored but capped so a hostile or
 * malformed value cannot park an account for hours.
 */
export const VERTEX_RATE_LIMIT_RETRY_INFO_MAX_MS = 15 * 60_000;

/** Fallback 429 cooldown when the response carries no retry signal (sub2api geminiVertexFallbackCooldown). */
export const VERTEX_RATE_LIMIT_FALLBACK_MS = 60_000;

/** 429 retry deadlines further than this from now are rejected as implausible. */
export const VERTEX_RATE_LIMIT_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/** Maximum model-id length accepted in an aiplatform path segment. */
export const VERTEX_MAX_MODEL_ID_LENGTH = 128;

/** `claude-x-20260101` — dated model id to rewrite onto the Vertex `@` spelling. */
export const VERTEX_ANTHROPIC_DATED_MODEL_PATTERN = /^(.+)-([0-9]{8})$/;

/** `claude-x@20260101` — already-dated Vertex model id, passed through. */
export const VERTEX_ANTHROPIC_ALREADY_DATED_PATTERN = /^[^@]+@[0-9]{8}$/;

/**
 * Location resolution precedence (sub2api Account.VertexLocation):
 * per-model override map → account default → `vertex_location` legacy
 * spelling → us-central1. Returns null only for a malformed override.
 */
export function resolveVertexLocation(
  account: VertexAccountCoordinates | null,
  model: string,
): { readonly location: string; readonly source: 'model' | 'account' | 'default' } | null {
  if (account !== null && typeof model === 'string' && model !== '') {
    const overrides = account.vertexModelLocations;
    if (overrides !== null && overrides !== undefined && typeof overrides === 'object') {
      const override = (overrides as Readonly<Record<string, unknown>>)[model];
      if (typeof override === 'string') {
        const trimmed = override.trim();
        if (trimmed !== '') {
          return isSafeVertexLocation(trimmed) ? { location: trimmed, source: 'model' } : null;
        }
      }
    }
  }
  const accountLocation = account?.location;
  if (typeof accountLocation === 'string' && accountLocation.trim() !== '') {
    const trimmed = accountLocation.trim();
    return isSafeVertexLocation(trimmed) ? { location: trimmed, source: 'account' } : null;
  }
  return { location: VERTEX_DEFAULT_LOCATION, source: 'default' };
}

/** Whether a location id is safe to interpolate into an aiplatform host. */
export function isSafeVertexLocation(location: string): boolean {
  return (
    typeof location === 'string' &&
    location.length > 0 &&
    location.length <= VERTEX_MAX_LOCATION_LENGTH &&
    VERTEX_LOCATION_PATTERN.test(location)
  );
}
