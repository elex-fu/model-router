/**
 * Batch 3 CN-provider category catalog identity (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三, 智谱/MiniMax; sub2api
 * reference: backend/internal/service/domain_constants.go). Single source of
 * truth for the two provider identities shared by the catalog registration
 * (saas/catalog/cn-providers-registration.ts), the credential-validation
 * adapters, the quota probe worker and the dispatch wiring.
 *
 * This is a brand-new SaaS category, NOT a legacy preset reuse: kimi/deepseek
 * only exist in the BYOK profiles (src/providers/profiles.ts). The precedent
 * is the opencode-go category (catalog + credential + probe + transport +
 * scheduling migration as one unit).
 *
 * Identity contract (all sites must agree):
 * - providers `zhipu` and `minimax`, credential type `api-key` (the existing
 *   sealed envelope with a bare-key plaintext; no OAuth extension), supply
 *   mode `platform`, region `cn` (domestic-default hosts; international
 *   z.ai / minimax.io variants live in constants.ts and are deployment
 *   binding choices, not separate products), purpose `inference`;
 * - zhipu has TWO products because its Coding Plan inference host differs
 *   from the pay-as-you-go host (sub2api DefaultZhipuPayGBaseURL vs
 *   DefaultZhipuCodingBaseURL): `zhipu-glm` (payg) and `zhipu-glm-coding`
 *   (Coding Plan subscription). The product split follows the kimi
 *   kimi-platform / kimi-platform-global precedent for host-distinct plans
 *   and keeps the per-product provider-target binding key
 *   (upstreamId, productId, protocol, operation) sufficient to select the
 *   correct upstream base with no account-derived URL.
 * - minimax has ONE product: payg and Coding/Token Plan share the inference
 *   domain and are distinguished by the API key alone (sub2api
 *   DefaultMiniMaxBaseURL comment). The per-account account_mode column
 *   (migration 120) gates quota probing, never URL routing, for minimax.
 * - catalog capability rows are registered per (model, protocol) under BOTH
 *   native protocols ('openai' Chat Completions and 'anthropic' Messages):
 *   the adaptive api_protocol routes the native protocol per inbound client
 *   protocol, so a model must be servable under either client protocol
 *   (same-protocol passthrough bridges only; the compile layer fails closed
 *   on unsupported cross pairs).
 */

export const ZHIPU_PROVIDER_ID = 'zhipu';
/** Pay-as-you-go (按量付费) product: https://open.bigmodel.cn/api/paas/v4. */
export const ZHIPU_PRODUCT_ID = 'zhipu-glm';
/** GLM Coding Plan product: https://open.bigmodel.cn/api/coding/paas/v4. */
export const ZHIPU_CODING_PRODUCT_ID = 'zhipu-glm-coding';
/** Platform-pool API key (sealed envelope, bare-key plaintext). */
export const ZHIPU_CREDENTIAL_TYPE = 'api-key';
export const ZHIPU_SUPPLY_MODE = 'platform' as const;
export const ZHIPU_REGION = 'cn';
export const ZHIPU_PURPOSE = 'inference';
/** Catalog endpoint scope for the payg product; also a dispatch split key. */
export const ZHIPU_ENDPOINT = 'zhipu-glm';
/** Catalog endpoint scope for the Coding Plan product. */
export const ZHIPU_CODING_ENDPOINT = 'zhipu-glm-coding';
export const ZHIPU_DISPLAY_NAME = 'Zhipu GLM (pay-as-you-go)';
export const ZHIPU_CODING_DISPLAY_NAME = 'Zhipu GLM Coding Plan';

export const MINIMAX_PROVIDER_ID = 'minimax';
/**
 * One product for both plan families: MiniMax payg and Coding/Token Plan
 * share the inference domain (api.minimaxi.com/v1) and are distinguished by
 * the API key (sub2api domain_constants.go DefaultMiniMaxBaseURL).
 */
export const MINIMAX_PRODUCT_ID = 'minimax-m';
export const MINIMAX_CREDENTIAL_TYPE = 'api-key';
export const MINIMAX_SUPPLY_MODE = 'platform' as const;
export const MINIMAX_REGION = 'cn';
export const MINIMAX_PURPOSE = 'inference';
/** Catalog endpoint scope; also a dispatch split key. */
export const MINIMAX_ENDPOINT = 'minimax-m';
export const MINIMAX_DISPLAY_NAME = 'MiniMax M series';

/** The three CN-provider endpoint scopes dispatch keys on. */
export const CN_PROVIDER_ENDPOINTS: readonly string[] = Object.freeze([
  ZHIPU_ENDPOINT,
  ZHIPU_CODING_ENDPOINT,
  MINIMAX_ENDPOINT,
]);

/** True when the endpoint scope belongs to the CN-provider category. */
export function isCnProviderEndpoint(endpoint: string | undefined | null): boolean {
  return typeof endpoint === 'string' && CN_PROVIDER_ENDPOINTS.includes(endpoint);
}

/** True when the provider id belongs to the CN-provider category. */
export function isCnProviderId(providerId: string | undefined | null): boolean {
  return providerId === ZHIPU_PROVIDER_ID || providerId === MINIMAX_PROVIDER_ID;
}
