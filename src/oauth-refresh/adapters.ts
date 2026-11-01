import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_SCOPE,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_OAUTH_TOKEN_USER_AGENT,
} from '../saas/platform/claude-oauth/oauth.js';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REFRESH_SCOPE,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  CODEX_OAUTH_USER_AGENT,
} from '../saas/platform/codex-oauth/oauth.js';
import {
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_TOKEN_ENDPOINT,
  GEMINI_OAUTH_TOKEN_USER_AGENT,
  resolveGeminiOauthClientSecret,
} from '../saas/platform/gemini-oauth/oauth.js';
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_REFRESH_SCOPE,
  GROK_OAUTH_TOKEN_ENDPOINT,
  GROK_OAUTH_TOKEN_USER_AGENT,
} from '../saas/platform/grok-oauth/oauth.js';

/**
 * Unified OAuth refresh provider registry (design:
 * docs/oauth-refresh-engine-unification-plan-20261101.md §2.2).
 *
 * This is the single source of the compile-time-fixed public OAuth client
 * bindings both refresh planes use: the classic engine
 * (src/server/oauth-refresh.ts) resolves its 'codex_oauth' key here, and the
 * SaaS worker's FIXED_OAUTH_TOKEN_ADAPTERS triple keys
 * ('providerId/productId/credentialType') resolve to the same adapter
 * instances. New vendor = one row here, both planes gain refresh capability.
 *
 * The provider constants are imported from the plain platform constant
 * modules (src/saas/platform/*-oauth/oauth.ts — verified pure: node:crypto +
 * the shared pkce helper only), so the classic plane now shares them instead
 * of carrying a drifting copy. Values that exist only inline in the SaaS
 * worker (the legacy anthropic claude-code endpoint/user-agent and the
 * envelope passthrough field lists) are carried here with drift-anchor
 * comments; collapsing the worker's copies onto this module is task R4.
 *
 * Nothing here is confidential: every client id is an RFC 6749 §2.1 public
 * client identifier. The Gemini installed-app client_secret is NOT a source
 * literal — it is resolved from the environment exactly like the worker does.
 */

/**
 * Envelope fields the codex bindings preserve across a rotation. Drift anchor:
 * src/saas/supply/oauth-token-refresh-worker.ts
 * CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS (R4 collapses the copy).
 */
export const CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS: readonly string[] = Object.freeze([
  'chatgpt_account_id',
  'chatgpt_user_id',
  'plan_type',
  'client_id',
]);

/**
 * Envelope fields the Claude subscription binding preserves across a
 * rotation. Drift anchor: CLAUDE_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS in the
 * SaaS worker.
 */
export const CLAUDE_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS: readonly string[] = Object.freeze([
  'organization_uuid',
  'account_uuid',
  'client_id',
  'email',
]);

/**
 * Envelope fields the Grok CLI subscription binding preserves across a
 * rotation. Drift anchor: GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS in the SaaS
 * worker.
 */
export const GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS: readonly string[] = Object.freeze([
  'user_id',
  'team_id',
  'subscription_tier',
  'client_id',
  'email',
]);

/**
 * Envelope fields the Gemini subscription binding preserves across a
 * rotation. Drift anchor: GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS in the
 * SaaS worker.
 */
export const GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS: readonly string[] = Object.freeze([
  'project_id',
  'tier_id',
  'client_id',
  'email',
]);

export interface OAuthRefreshAdapter {
  /** Stable registry id (the SaaS worker's adapterId). */
  readonly id: string;
  readonly tokenEndpoint: string;
  /** Public (non-confidential) OAuth client id required by the refresh grant. */
  readonly clientId: string;
  /**
   * Optional scope narrowing the provider's refresh grant requires; null
   * sends no scope parameter (the endpoint then keeps the original grant's
   * scopes).
   */
  readonly refreshScope: string | null;
  /**
   * User-Agent for the refresh grant. Pinned CLI clients keep the grant off
   * non-CLI fingerprints where the endpoint checks them.
   */
  readonly userAgent: string;
  /**
   * Response fields the binding must preserve across a rotation (the SaaS
   * envelope passthrough contract); absent means none.
   */
  readonly passthroughFields?: readonly string[];
  /**
   * Google's installed-app clients require client_secret in the refresh
   * grant (the Gemini CLI binding). Never a source literal: it arrives from
   * the deployment environment. undefined sends no client_secret parameter
   * so every existing grant stays byte-identical.
   */
  readonly clientSecret?: string;
}

const CODEX_OAUTH_ADAPTER: OAuthRefreshAdapter = Object.freeze({
  id: 'openai-codex-oauth-v2',
  tokenEndpoint: CODEX_OAUTH_TOKEN_ENDPOINT,
  clientId: CODEX_OAUTH_CLIENT_ID,
  refreshScope: CODEX_OAUTH_REFRESH_SCOPE,
  userAgent: CODEX_OAUTH_USER_AGENT,
  passthroughFields: CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
});

const CLAUDE_CODE_OAUTH_ADAPTER: OAuthRefreshAdapter = Object.freeze({
  // Legacy anthropic/claude-code binding. Drift anchor: the first entry of
  // FIXED_OAUTH_TOKEN_ADAPTERS in the SaaS worker (endpoint and user-agent
  // exist only there). Same public OAuth client as the claude-subscription
  // binding but the console.anthropic.com token endpoint.
  id: 'anthropic-claude-code-oauth-v1',
  tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  clientId: CLAUDE_OAUTH_CLIENT_ID,
  refreshScope: null,
  userAgent: 'model-router',
  passthroughFields: [],
});

const CLAUDE_SUBSCRIPTION_OAUTH_ADAPTER: OAuthRefreshAdapter = Object.freeze({
  id: 'anthropic-claude-subscription-oauth-v1',
  tokenEndpoint: CLAUDE_OAUTH_TOKEN_ENDPOINT,
  clientId: CLAUDE_OAUTH_CLIENT_ID,
  refreshScope: CLAUDE_OAUTH_REFRESH_SCOPE,
  userAgent: CLAUDE_OAUTH_TOKEN_USER_AGENT,
  passthroughFields: CLAUDE_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
});

const GROK_OAUTH_ADAPTER: OAuthRefreshAdapter = Object.freeze({
  id: 'xai-grok-oauth-v1',
  tokenEndpoint: GROK_OAUTH_TOKEN_ENDPOINT,
  clientId: GROK_OAUTH_CLIENT_ID,
  refreshScope: GROK_OAUTH_REFRESH_SCOPE,
  userAgent: GROK_OAUTH_TOKEN_USER_AGENT,
  passthroughFields: GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
});

/**
 * The Gemini Code Assist subscription adapter. Google's public installed-app
 * client REQUIRES client_secret in the grant; the value is provider-shaped,
 * so it lives only in the MODEL_ROUTER_GEMINI_OAUTH_CLIENT_SECRET
 * environment variable. When the environment is unconfigured the adapter is
 * absent (fail-closed: no refresh is ever attempted that could burn the
 * refresh token against a grant missing its secret).
 */
export function geminiOAuthRefreshAdapter(
  clientSecret: string | null = resolveGeminiOauthClientSecret(),
): OAuthRefreshAdapter | null {
  if (clientSecret === null) return null;
  return Object.freeze({
    id: 'google-gemini-oauth-v1',
    tokenEndpoint: GEMINI_OAUTH_TOKEN_ENDPOINT,
    clientId: GEMINI_OAUTH_CLIENT_ID,
    refreshScope: null,
    userAgent: GEMINI_OAUTH_TOKEN_USER_AGENT,
    passthroughFields: GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
    clientSecret,
  });
}

/**
 * Normalized provider ids (the SaaS 'providerId/productId/credentialType'
 * triple). Classic single keys and the SaaS codex CLI triple alias onto the
 * codex-chatgpt triple: all four spellings resolve to the SAME adapter
 * instance because the underlying public OAuth grant is identical.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  codex_oauth: 'openai-codex/codex-chatgpt/oauth',
  'openai/codex-cli/oauth': 'openai-codex/codex-chatgpt/oauth',
});

const ADAPTERS: ReadonlyMap<string, OAuthRefreshAdapter> = buildAdapterRegistry();

function buildAdapterRegistry(): ReadonlyMap<string, OAuthRefreshAdapter> {
  const entries: Array<[string, OAuthRefreshAdapter]> = [
    ['openai-codex/codex-chatgpt/oauth', CODEX_OAUTH_ADAPTER],
    ['anthropic/claude-code/oauth', CLAUDE_CODE_OAUTH_ADAPTER],
    ['anthropic-claude/claude-subscription/oauth', CLAUDE_SUBSCRIPTION_OAUTH_ADAPTER],
    ['xai-grok/grok-subscription/oauth', GROK_OAUTH_ADAPTER],
  ];
  const gemini = geminiOAuthRefreshAdapter();
  if (gemini !== null) entries.push(['google-gemini/gemini-subscription/oauth', gemini]);
  return new Map(entries);
}

/**
 * Maps any accepted provider spelling (classic key, SaaS triple, or alias)
 * to its canonical normalized registry id, or null when no fixed binding
 * exists for it.
 */
export function normalizeProviderKey(providerKey: string): string | null {
  const normalized = KEY_ALIASES[providerKey] ?? providerKey;
  return ADAPTERS.has(normalized) ? normalized : null;
}

/** Resolves the fixed adapter for any accepted provider spelling; null = unsupported. */
export function resolveAdapter(providerKey: string): OAuthRefreshAdapter | null {
  const normalized = normalizeProviderKey(providerKey);
  return normalized === null ? null : (ADAPTERS.get(normalized) ?? null);
}

// --- Generic account-carried passthrough binding (the classic escape hatch) ---

/** GitHub's public OAuth token endpoint (the github_copilot default binding). */
export const GITHUB_COPILOT_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
/** Default outbound UA for account-carried bindings. */
export const DEFAULT_OAUTH_REFRESH_USER_AGENT = 'model-router';

/**
 * Optional per-account provider binding fields the generic passthrough
 * understands (carried on the classic OAuthAccount).
 */
export interface OAuthRefreshBinding {
  /** Provider key; enables the github_copilot default token endpoint. */
  readonly provider?: string;
  readonly clientId?: unknown;
  readonly tokenEndpoint?: unknown;
  readonly refreshScope?: unknown;
  readonly userAgent?: unknown;
}

/**
 * Fail-closed https token-endpoint validation. Union of both planes' checks
 * with the stricter (SaaS canonicalAdapterUrl) reading winning over the
 * classic httpsUrl: an explicit port, userinfo, query, fragment or a
 * non-canonical spelling (href !== value) is rejected, not attempted.
 */
export function canonicalTokenEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.href !== value
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Builds an adapter from account-carried binding fields (ported from the
 * classic resolveOAuthRefreshProviderSpec passthrough): the account must
 * carry a non-empty clientId, and a non-empty tokenEndpoint — or, for
 * github_copilot only, GitHub's public token endpoint as the default. Every
 * other shape is cleanly unsupported (null), never guessed.
 */
export function resolvePassthroughAdapter(binding: OAuthRefreshBinding): OAuthRefreshAdapter | null {
  const clientId = typeof binding.clientId === 'string' && binding.clientId.length > 0 ? binding.clientId : null;
  if (clientId === null) return null;
  const endpointCandidate =
    typeof binding.tokenEndpoint === 'string' && binding.tokenEndpoint.length > 0 ? binding.tokenEndpoint : null;
  const endpoint = endpointCandidate ?? (binding.provider === 'github_copilot' ? GITHUB_COPILOT_TOKEN_ENDPOINT : null);
  if (endpoint === null || canonicalTokenEndpoint(endpoint) === null) return null;
  return {
    id: 'account-passthrough-oauth',
    tokenEndpoint: endpoint,
    clientId,
    refreshScope:
      typeof binding.refreshScope === 'string' && binding.refreshScope.length > 0 ? binding.refreshScope : null,
    userAgent:
      typeof binding.userAgent === 'string' && binding.userAgent.length > 0
        ? binding.userAgent
        : DEFAULT_OAUTH_REFRESH_USER_AGENT,
    passthroughFields: [],
  };
}
