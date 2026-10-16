/**
 * F6 OpenRouter catalog identity constants (plan §R8a, task #39). Single
 * source of truth for the `openrouter` provider identity shared by the
 * catalog registration (saas/catalog/openrouter-registration.ts), the model
 * catalog helpers (gateway/openrouter/model-catalog.ts), the fixed request
 * headers (gateway/openrouter/transport-headers.ts) and the model-pricing
 * sync worker (supply/openrouter-model-pricing-sync-worker.ts).
 *
 * Identity contract (all sites must agree):
 * - provider `openrouter`, product `openrouter-api`, credential type
 *   `api-key` (a metered OpenRouter platform-pool key in the existing sealed
 *   envelope — no OAuth extension), supply mode `platform`, region `global`,
 *   purpose `inference`;
 * - OpenRouter is a pay-as-you-go aggregation API, NOT a subscription
 *   category: its supplier cost rows carry real per-token dollar prices
 *   synced from the public catalog, never placeholder zeros. Because the
 *   rates are real, the R7 cost-priority strategy naturally ranks
 *   zero-rate subscription pools (Claude/Codex/OpenCode Go) ahead of
 *   OpenRouter; nothing is wired in the scheduler for this — see the sync
 *   worker module header;
 * - catalog capability rows carry the native protocol `openai` (Chat
 *   Completions) spelled as a GatewayProtocol: OpenRouter is an OpenAI
 *   wire-format upstream, so an `openai`-protocol client is served through
 *   the same-protocol passthrough bridge (zero bridge). The
 *   supply-validation vocabulary (`openai-compatible`) never appears on
 *   catalog capability rows;
 * - the upstream host is pinned to OPENROUTER_BASE_URL
 *   (https://openrouter.ai/api/v1); transports must never take a client- or
 *   account-supplied base URL for this provider. OpenRouter's API base
 *   already ends in `/api/v1`, so the Chat Completions and models paths are
 *   plain sub-paths.
 */

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_PRODUCT_ID = 'openrouter-api';
/** Platform-pool API key (sealed envelope); deliberately not `oauth`. */
export const OPENROUTER_CREDENTIAL_TYPE = 'api-key';
export const OPENROUTER_SUPPLY_MODE = 'platform' as const;
export const OPENROUTER_REGION = 'global';
export const OPENROUTER_PURPOSE = 'inference';
/**
 * Catalog endpoint scope; also the fixed-request-header resolver's dispatch
 * key (mirrors OPENCODE_GO_ENDPOINT for the opencode-go transport split).
 */
export const OPENROUTER_ENDPOINT = 'openrouter-api';
/** Pinned upstream base for the OpenRouter metered aggregation API. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Pinned Chat Completions endpoint (OpenAI wire format, base + path). */
export const OPENROUTER_CHAT_COMPLETIONS_PATH = '/chat/completions';
export const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}${OPENROUTER_CHAT_COMPLETIONS_PATH}`;
/**
 * Pinned public model-catalog endpoint (F6 pricing sync): the per-token USD
 * pricing source. The endpoint is public — no credential is required.
 */
export const OPENROUTER_MODELS_PATH = '/models';
export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}${OPENROUTER_MODELS_PATH}`;
export const OPENROUTER_DISPLAY_NAME = 'OpenRouter (metered aggregation)';
/**
 * The single native protocol every OpenRouter capability row registers
 * under: OpenAI Chat Completions as a GatewayProtocol.
 */
export const OPENROUTER_CAPABILITY_PROTOCOL = 'openai' as const;
