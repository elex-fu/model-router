/**
 * R5b OpenCode Go catalog identity constants (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #21). Single
 * source of truth for the `opencode-go` provider identity shared by the
 * catalog registration (saas/catalog/opencode-go-registration.ts) and the
 * later R5b-2..4 mounts (protocol dispatch, usage worker, /v1/models sync).
 *
 * Identity contract (all sites must agree):
 * - provider `opencode-go`, product `opencode-go-zen`, credential type
 *   `api-key` (platform-pool subscription key in the existing sealed
 *   envelope — no OAuth extension), supply mode `platform`, region `global`,
 *   purpose `inference`;
 * - catalog capability rows carry the model's rule-resolved native protocol
 *   spelled as a `GatewayProtocol` ('responses' | 'openai' | 'anthropic'),
 *   never the supply-validation vocabulary ('openai-compatible'): the
 *   production authority adapter matches `capability.protocol` against the
 *   route's client protocol, which is always a GatewayProtocol. R5b-2's
 *   per-model protocol routing keeps this provider/product/credential triple
 *   stable while re-deriving the upstream protocol per request.
 * - the upstream host is pinned to OPENCODE_GO_BASE_URL
 *   (https://opencode.ai/zen/go); transports must never take a client- or
 *   account-supplied base URL for this provider. The wire paths below are the
 *   sub2api OpenAI-format layout (chat base = base + /v1), so the Chat
 *   Completions and models endpoints are pinned here too.
 */

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PRODUCT_ID = 'opencode-go-zen';
/** Platform-pool API key (sealed envelope); deliberately not `oauth`. */
export const OPENCODE_GO_CREDENTIAL_TYPE = 'api-key';
export const OPENCODE_GO_SUPPLY_MODE = 'platform' as const;
export const OPENCODE_GO_REGION = 'global';
export const OPENCODE_GO_PURPOSE = 'inference';
/**
 * Catalog endpoint scope; also the R5b-2 dispatch split key for OpenCode Go
 * traffic (mirrors CODEX_ENDPOINT for the codex transport split).
 */
export const OPENCODE_GO_ENDPOINT = 'opencode-go-zen';
/** Pinned upstream base for the OpenCode Zen/Go subscription gateway. */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go';
/**
 * Pinned Chat Completions endpoint (R5b-4 probe registration): the sub2api
 * OpenAI-format chat base for the Go plan is base + `/v1`.
 */
export const OPENCODE_GO_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
export const OPENCODE_GO_CHAT_COMPLETIONS_URL = `${OPENCODE_GO_BASE_URL}${OPENCODE_GO_CHAT_COMPLETIONS_PATH}`;
/**
 * Pinned upstream model-list endpoint (R5b-4 catalog sync): the sub2api
 * OpenAI-format models base for the Go plan is base + `/v1`.
 */
export const OPENCODE_GO_MODELS_PATH = '/v1/models';
export const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_BASE_URL}${OPENCODE_GO_MODELS_PATH}`;
export const OPENCODE_GO_DISPLAY_NAME = 'OpenCode Go (Zen subscription)';
