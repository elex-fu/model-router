/**
 * Batch 3 CN-provider default endpoint table and shared wire constants
 * (design: docs/capability-parity-roadmap-2026-10-16.md 批次三; sub2api
 * reference: backend/internal/service/domain_constants.go +
 * cn_provider_quota_service.go). The table is lifted verbatim from the
 * sub2api defaults; every downstream consumer (provider-target bindings for
 * the generic transport, the quota probe worker, the credential-validation
 * probe endpoints) imports from here so the probe and the transport can
 * never drift apart (the roadmap's "one shared header/endpoint builder"
 * discipline).
 *
 * Region dimension: domestic-default hosts are open.bigmodel.cn /
 * api.minimaxi.com; the international hosts are api.z.ai (zhipu) and
 * api.minimax.io (minimax). sub2api selects the international host from the
 * account's configured base URL; in this repository the host choice is a
 * deployment provider-target binding decision, so both variants are pinned
 * here and the exported binding set carries the domestic defaults.
 */

import type { ProviderTargetBinding } from '../../runtime/provider-target-resolver.js';
import {
  MINIMAX_ENDPOINT,
  MINIMAX_PRODUCT_ID,
  MINIMAX_PROVIDER_ID,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_CODING_PRODUCT_ID,
  ZHIPU_ENDPOINT,
  ZHIPU_PRODUCT_ID,
  ZHIPU_PROVIDER_ID,
} from './catalog-identity.js';

/** Account mode: payg (API-key metered) or coding (Coding Plan subscription). */
export type CnProviderAccountMode = 'payg' | 'coding';

/**
 * Per-account api_protocol vocabulary (sub2api account.go APIProtocol*):
 * chat_completions | anthropic | responses | adaptive. 'responses' is only
 * honored for providers with a native Responses endpoint (MiniMax; sub2api
 * SupportsNativeCNResponses) — zhipu has none and falls back to
 * chat_completions. 'adaptive' routes the native protocol per inbound client
 * protocol.
 */
export type CnProviderApiProtocol = 'chat_completions' | 'anthropic' | 'responses' | 'adaptive';

/** Default api_protocol when the account column is NULL (the headline mode). */
export const CN_PROVIDER_DEFAULT_API_PROTOCOL: CnProviderApiProtocol = 'adaptive';

/** Default account mode when the account column is NULL (payg semantics). */
export const CN_PROVIDER_DEFAULT_ACCOUNT_MODE: CnProviderAccountMode = 'payg';

/**
 * Zhipu default bases (sub2api DefaultZhipuPayGBaseURL /
 * DefaultZhipuCodingBaseURL / DefaultZhipuAnthropicBaseURL). The Anthropic
 * base is shared by both plan families; only the Chat Completions base
 * differs by account mode. The z.ai international mirror carries the same
 * layout (sub2api zhipuQuotaHost).
 */
export const ZHIPU_PAYG_CHAT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const ZHIPU_CODING_CHAT_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
export const ZHIPU_ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
export const ZHIPU_PAYG_CHAT_BASE_URL_INTL = 'https://api.z.ai/api/paas/v4';
export const ZHIPU_CODING_CHAT_BASE_URL_INTL = 'https://api.z.ai/api/coding/paas/v4';
export const ZHIPU_ANTHROPIC_BASE_URL_INTL = 'https://api.z.ai/api/anthropic';

/**
 * MiniMax default bases (sub2api DefaultMiniMaxBaseURL /
 * DefaultMiniMaxAnthropicBaseURL): payg and Coding/Token Plan share the
 * inference domain, so the base is mode-independent. International mirror:
 * api.minimax.io.
 */
export const MINIMAX_CHAT_BASE_URL = 'https://api.minimaxi.com/v1';
export const MINIMAX_ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic';
export const MINIMAX_CHAT_BASE_URL_INTL = 'https://api.minimax.io/v1';
export const MINIMAX_ANTHROPIC_BASE_URL_INTL = 'https://api.minimax.io/anthropic';

/** Wire paths appended to the bases above. */
export const CN_CHAT_COMPLETIONS_PATH = '/chat/completions';
export const CN_RESPONSES_PATH = '/responses';
export const CN_ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const CN_MODELS_PATH = '/models';

/** Default admin connection-test models (cheapest family member per provider). */
export const ZHIPU_TEST_MODEL = 'glm-5.3-flash';
export const MINIMAX_TEST_MODEL = 'MiniMax-M2';

/**
 * Fallback model directory for the zhipu products (the officially published
 * GLM ids, the same family the opencode-go catalog publishes from the same
 * upstream; operator-driven catalog rows extend/replace these). Frozen:
 * callers must not mutate the shared list.
 */
export const ZHIPU_FALLBACK_MODEL_IDS: readonly string[] = Object.freeze([
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
]);

/**
 * Fallback model directory for the minimax product (the officially published
 * M-series ids — sub2api thinking_protocol.go documents the family
 * MiniMax-M2 / M2.1 / M2.5 / M2.7 / M2.7-highspeed / M3). Frozen.
 */
export const MINIMAX_FALLBACK_MODEL_IDS: readonly string[] = Object.freeze([
  'MiniMax-M2',
  'MiniMax-M2.1',
  'MiniMax-M2.5',
  'MiniMax-M2.7',
]);

/**
 * The default upstream base for one provider × account mode × native
 * protocol (domestic hosts). The optional overrides record models the
 * sub2api adaptive `api_base_urls` per-protocol account configuration; an
 * override present for the requested protocol wins over the table.
 */
export function cnProviderDefaultBase(
  input: {
    readonly providerId: string;
    readonly accountMode: CnProviderAccountMode;
    readonly protocol: 'openai' | 'anthropic' | 'responses';
    readonly overrides?: Readonly<Partial<Record<'openai' | 'anthropic' | 'responses', string>>> | null;
    readonly international?: boolean;
  },
  ): string | null {
  const key: 'openai' | 'anthropic' | 'responses' = input.protocol;
  const override = input.overrides?.[key];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const intl = input.international === true;
  if (input.providerId === ZHIPU_PROVIDER_ID) {
    if (key === 'anthropic') return intl ? ZHIPU_ANTHROPIC_BASE_URL_INTL : ZHIPU_ANTHROPIC_BASE_URL;
    // Zhipu has no native Responses endpoint: chat_completions and a
    // 'responses' api_protocol both land on the Chat Completions base
    // (sub2api account.go GetAPIProtocol zhipu matrix).
    return input.accountMode === 'coding'
      ? intl
        ? ZHIPU_CODING_CHAT_BASE_URL_INTL
        : ZHIPU_CODING_CHAT_BASE_URL
      : intl
        ? ZHIPU_PAYG_CHAT_BASE_URL_INTL
        : ZHIPU_PAYG_CHAT_BASE_URL;
  }
  if (input.providerId === MINIMAX_PROVIDER_ID) {
    if (key === 'anthropic') return intl ? MINIMAX_ANTHROPIC_BASE_URL_INTL : MINIMAX_ANTHROPIC_BASE_URL;
    // MiniMax serves Chat Completions AND native Responses from the same base
    // (sub2api SupportsNativeCNResponses: /v1/responses on api.minimaxi.com).
    return intl ? MINIMAX_CHAT_BASE_URL_INTL : MINIMAX_CHAT_BASE_URL;
  }
  return null;
}

/** Anthropic API version pinned on every Anthropic-native CN-provider request. */
export const CN_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Deployment-spread provider-target bindings for the domestic default hosts
 * (the exact `ProviderTargetBinding` shape the SAAS_PROVIDER_TARGET_BINDINGS
 * module exports). One entry per (provider, product, native protocol,
 * operation); the generic transport resolves its dispatch URL through these
 * bindings, so adaptive routing only ever rewrites the signed
 * providerProtocol/providerOperation pair, never a URL.
 */
export const CN_PROVIDER_TARGET_BINDINGS: readonly ProviderTargetBinding[] = Object.freeze([
  Object.freeze({
    upstreamId: ZHIPU_PROVIDER_ID,
    productId: ZHIPU_PRODUCT_ID,
    protocol: 'openai',
    operation: 'chat.completions',
    baseUrl: ZHIPU_PAYG_CHAT_BASE_URL,
    allowedHosts: ['open.bigmodel.cn'],
    allowedPorts: [443],
    path: CN_CHAT_COMPLETIONS_PATH,
    method: 'POST',
  }),
  Object.freeze({
    upstreamId: ZHIPU_PROVIDER_ID,
    productId: ZHIPU_PRODUCT_ID,
    protocol: 'anthropic',
    operation: 'messages',
    baseUrl: ZHIPU_ANTHROPIC_BASE_URL,
    allowedHosts: ['open.bigmodel.cn'],
    allowedPorts: [443],
    path: CN_ANTHROPIC_MESSAGES_PATH,
    method: 'POST',
  }),
  Object.freeze({
    upstreamId: ZHIPU_PROVIDER_ID,
    productId: ZHIPU_CODING_PRODUCT_ID,
    protocol: 'openai',
    operation: 'chat.completions',
    baseUrl: ZHIPU_CODING_CHAT_BASE_URL,
    allowedHosts: ['open.bigmodel.cn'],
    allowedPorts: [443],
    path: CN_CHAT_COMPLETIONS_PATH,
    method: 'POST',
  }),
  Object.freeze({
    upstreamId: ZHIPU_PROVIDER_ID,
    productId: ZHIPU_CODING_PRODUCT_ID,
    protocol: 'anthropic',
    operation: 'messages',
    baseUrl: ZHIPU_ANTHROPIC_BASE_URL,
    allowedHosts: ['open.bigmodel.cn'],
    allowedPorts: [443],
    path: CN_ANTHROPIC_MESSAGES_PATH,
    method: 'POST',
  }),
  Object.freeze({
    upstreamId: MINIMAX_PROVIDER_ID,
    productId: MINIMAX_PRODUCT_ID,
    protocol: 'openai',
    operation: 'chat.completions',
    baseUrl: MINIMAX_CHAT_BASE_URL,
    allowedHosts: ['api.minimaxi.com'],
    allowedPorts: [443],
    path: CN_CHAT_COMPLETIONS_PATH,
    method: 'POST',
  }),
  Object.freeze({
    upstreamId: MINIMAX_PROVIDER_ID,
    productId: MINIMAX_PRODUCT_ID,
    protocol: 'anthropic',
    operation: 'messages',
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    allowedHosts: ['api.minimaxi.com'],
    allowedPorts: [443],
    path: CN_ANTHROPIC_MESSAGES_PATH,
    method: 'POST',
  }),
  Object.freeze({
    upstreamId: MINIMAX_PROVIDER_ID,
    productId: MINIMAX_PRODUCT_ID,
    protocol: 'responses',
    operation: 'responses',
    baseUrl: MINIMAX_CHAT_BASE_URL,
    allowedHosts: ['api.minimaxi.com'],
    allowedPorts: [443],
    path: CN_RESPONSES_PATH,
    method: 'POST',
  }),
]);

/**
 * Credential-validation probe endpoints (the FIXED_ADAPTERS URLs): the
 * OpenAI-format models endpoint on each product's Chat Completions base
 * (sub2api buildUpstreamModelsRequest test matrix).
 */
export const ZHIPU_PAYG_MODELS_URL = `${ZHIPU_PAYG_CHAT_BASE_URL}${CN_MODELS_PATH}`;
export const ZHIPU_CODING_MODELS_URL = `${ZHIPU_CODING_CHAT_BASE_URL}${CN_MODELS_PATH}`;
export const MINIMAX_MODELS_URL = `${MINIMAX_CHAT_BASE_URL}${CN_MODELS_PATH}`;

/**
 * Coding Plan quota probe endpoints (sub2api zhipuQuotaURL /
 * minimaxQuotaURL). Zhipu's monitor host follows the inference domain
 * (open.bigmodel.cn domestic / api.z.ai international); MiniMax's remains
 * endpoint is served from the same api host as inference.
 */
export const ZHIPU_QUOTA_PATH = '/api/monitor/usage/quota/limit';
export const ZHIPU_QUOTA_URL = `https://open.bigmodel.cn${ZHIPU_QUOTA_PATH}`;
export const ZHIPU_QUOTA_URL_INTL = `https://api.z.ai${ZHIPU_QUOTA_PATH}`;
export const MINIMAX_QUOTA_PATH = '/v1/api/openplatform/coding_plan/remains';
export const MINIMAX_QUOTA_URL = `https://api.minimaxi.com${MINIMAX_QUOTA_PATH}`;
export const MINIMAX_QUOTA_URL_INTL = `https://api.minimax.io${MINIMAX_QUOTA_PATH}`;
