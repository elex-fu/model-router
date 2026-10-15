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
 * - protocol `openai-compatible` and endpoint scope `opencode-go-zen` for the
 *   R5b-1 catalog rows: the pool's default/test traffic is Chat Completions
 *   (sub2api `DefaultOpenCodeGoTestModel` `glm-5.3` is a Chat Completions
 *   catalog id). R5b-2's per-model protocol routing will re-derive the
 *   upstream protocol per request; it must keep this provider/product/
 *   credential triple stable.
 * - the upstream host is pinned to OPENCODE_GO_BASE_URL
 *   (https://opencode.ai/zen/go); transports must never take a client- or
 *   account-supplied base URL for this provider.
 */

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PRODUCT_ID = 'opencode-go-zen';
/** Platform-pool API key (sealed envelope); deliberately not `oauth`. */
export const OPENCODE_GO_CREDENTIAL_TYPE = 'api-key';
export const OPENCODE_GO_SUPPLY_MODE = 'platform' as const;
export const OPENCODE_GO_REGION = 'global';
export const OPENCODE_GO_PURPOSE = 'inference';
/** Default catalog protocol for the R5b-1 capability rows (Chat Completions). */
export const OPENCODE_GO_PROTOCOL = 'openai-compatible';
/**
 * Catalog endpoint scope; also the R5b-2 dispatch split key for OpenCode Go
 * traffic (mirrors CODEX_ENDPOINT for the codex transport split).
 */
export const OPENCODE_GO_ENDPOINT = 'opencode-go-zen';
/** Pinned upstream base for the OpenCode Zen/Go subscription gateway. */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go';
export const OPENCODE_GO_DISPLAY_NAME = 'OpenCode Go (Zen subscription)';
