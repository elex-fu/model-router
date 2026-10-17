/**
 * Batch-3 Grok catalog identity (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三). Single source of truth
 * for the `xai-grok` provider identity shared by the catalog registration
 * (saas/catalog/grok-registration.ts), the credential sink
 * (platform/grok-oauth/supply-sink.ts), the R4 refresh worker binding
 * (supply/oauth-token-refresh-worker.ts `xai-grok-oauth-v1` adapter), the
 * validation worker's api-key adapter and the gateway dispatch split.
 *
 * Identity contract (all sites must agree):
 * - provider `xai-grok`;
 * - OAuth Grok CLI subscription accounts: product `grok-subscription`,
 *   credential type `oauth`, supply mode `platform`, region `global`, purpose
 *   `inference` — bound through platform/grok-oauth and refreshed by the R4
 *   worker's grok adapter;
 * - xAI API-key accounts: product `grok-api`, credential type `api-key` — the
 *   official api.x.ai surface (never the CLI proxy: it rejects CLI identity
 *   headers on OAuth-shaped traffic and vice versa);
 * - protocol `responses` (the native OpenAI Responses wire shape Grok serves
 *   on both bases; `/chat/completions` passthrough rides the same endpoint
 *   scope through the transport's per-request path selection), endpoint scope
 *   `grok-responses`.
 */

export const GROK_PROVIDER_ID = 'xai-grok';
export const GROK_OAUTH_PRODUCT_ID = 'grok-subscription';
export const GROK_API_KEY_PRODUCT_ID = 'grok-api';
export const GROK_CREDENTIAL_TYPE_OAUTH = 'oauth';
export const GROK_CREDENTIAL_TYPE_API_KEY = 'api-key';
export const GROK_SUPPLY_MODE = 'platform' as const;
export const GROK_REGION = 'global';
export const GROK_PURPOSE = 'inference';
export const GROK_PROTOCOL = 'responses' as const;
/** Catalog endpoint scope; also the gateway dispatch split key for grok traffic. */
export const GROK_ENDPOINT = 'grok-responses';
export const GROK_DISPLAY_NAME = 'xAI Grok (Grok CLI subscription)';

/**
 * Placeholder model set for the MVP catalog (the sub2api xai/models.go text
 * table): transform.ts normalizes client aliases (`grok`, `grok-latest`,
 * `-latest` suffixes) onto these.
 *
 * Capability boundary (batch-4 dependency): the media families —
 * grok-imagine images/video, TTS audio and realtime — are deliberately NOT
 * part of this catalog. The image/audio/video endpoints need the batch-4
 * multimodal prerequisites (1MiB body cap lift, non-JSON content types, GET
 * method dispatch) and realtime needs the WS upgrade infrastructure; none of
 * those exist yet. This category serves text generation only until then.
 */
export const GROK_PLACEHOLDER_MODELS: readonly string[] = Object.freeze([
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'grok-code-fast-1',
]);
