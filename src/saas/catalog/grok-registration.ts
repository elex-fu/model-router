import {
  GROK_API_KEY_PRODUCT_ID,
  GROK_CREDENTIAL_TYPE_API_KEY,
  GROK_CREDENTIAL_TYPE_OAUTH,
  GROK_DISPLAY_NAME,
  GROK_ENDPOINT,
  GROK_OAUTH_PRODUCT_ID,
  GROK_PLACEHOLDER_MODELS,
  GROK_PROTOCOL,
  GROK_PROVIDER_ID,
  GROK_PURPOSE,
  GROK_REGION,
  GROK_SUPPLY_MODE,
} from '../gateway/grok/catalog-identity.js';
import { normalizeGrokModelId } from '../gateway/grok/transform.js';
import type { SaasPricingService } from '../pricing/service.js';
import type { PlatformPriceAuditContext, RegisterPlatformPriceVersionInput } from '../pricing/types.js';
import type { SaasCatalogService } from './service.js';
import type {
  ProviderRightsAuditContext,
  RegisterProviderCapabilityInput,
  RegisterProviderProductInput,
  RegisterProviderRightsVersionInput,
  RegisterPublicModelAliasInput,
} from './types.js';

export {
  GROK_API_KEY_PRODUCT_ID,
  GROK_CREDENTIAL_TYPE_API_KEY,
  GROK_CREDENTIAL_TYPE_OAUTH,
  GROK_DISPLAY_NAME,
  GROK_ENDPOINT,
  GROK_OAUTH_PRODUCT_ID,
  GROK_PLACEHOLDER_MODELS,
  GROK_PROTOCOL,
  GROK_PROVIDER_ID,
  GROK_PURPOSE,
  GROK_REGION,
  GROK_SUPPLY_MODE,
};

/**
 * Batch-3 `xai-grok` provider catalog registration (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Grok). Mirrors
 * gemini-registration.ts / codex-registration.ts, differing where the grok
 * supply shape differs: TWO products under one provider —
 *
 * - `grok-subscription` (credential type `oauth`): Grok CLI subscription
 *   accounts bound through platform/grok-oauth and refreshed by the R4
 *   worker's `xai-grok-oauth-v1` adapter;
 * - `grok-api` (credential type `api-key`): xAI API keys on the official
 *   api.x.ai surface (validated by the validation worker's
 *   `xai-grok-api-models-v1` adapter).
 *
 * Both register the same protocol (`responses`) and endpoint scope
 * (`grok-responses`). Capability boundary: the media families
 * (grok-imagine images/video, TTS audio, realtime) are deliberately NOT
 * registered — they wait for the batch-4 multimodal prerequisites (see
 * gateway/grok/catalog-identity.ts).
 *
 * Identity contract (all sites must agree):
 * - provider `xai-grok`, supply mode `platform`, region `global`, purpose
 *   `inference`;
 * - the R4 refresh worker binds the same oauth triple
 *   (supply/oauth-token-refresh-worker.ts `xai-grok-oauth-v1`);
 * - OAuth traffic dials https://cli-chat-proxy.grok.com/v1 (the CLI chat
 *   proxy), API-key traffic dials https://api.x.ai/v1 — both pinned in
 *   gateway/grok/constants.ts.
 */

export function grokProviderProductInputs(): readonly RegisterProviderProductInput[] {
  return [
    {
      providerId: GROK_PROVIDER_ID,
      productId: GROK_OAUTH_PRODUCT_ID,
      displayName: GROK_DISPLAY_NAME,
      status: 'active',
    },
    {
      providerId: GROK_PROVIDER_ID,
      productId: GROK_API_KEY_PRODUCT_ID,
      displayName: 'xAI Grok (API key)',
      status: 'active',
    },
  ];
}

export function grokCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  const products = [GROK_OAUTH_PRODUCT_ID, GROK_API_KEY_PRODUCT_ID];
  const capabilities: RegisterProviderCapabilityInput[] = [];
  for (const productId of products) {
    for (const model of GROK_PLACEHOLDER_MODELS) {
      capabilities.push({
        providerId: GROK_PROVIDER_ID,
        productId,
        model,
        endpoint: GROK_ENDPOINT,
        protocol: GROK_PROTOCOL,
        supportLevel: 'supported' as const,
        validationState: 'verified' as const,
        evidenceVersion: evidence.evidenceVersion,
        discoverySource: 'preset' as const,
        evidenceReference: evidence.reference,
        evidenceSha256: evidence.sha256,
      });
    }
  }
  return capabilities;
}

export function grokPlatformRightsInputs(
  evidence: {
    readonly approvalReference: string;
    readonly evidenceReference: string;
    readonly sha256: string;
    readonly effectiveAt: string;
  },
  audit?: ProviderRightsAuditContext,
): readonly RegisterProviderRightsVersionInput[] {
  const bindings = [
    {
      rightsId: 'grok-subscription-platform-oauth-v1',
      productId: GROK_OAUTH_PRODUCT_ID,
      credentialType: GROK_CREDENTIAL_TYPE_OAUTH,
    },
    {
      rightsId: 'grok-api-platform-api-key-v1',
      productId: GROK_API_KEY_PRODUCT_ID,
      credentialType: GROK_CREDENTIAL_TYPE_API_KEY,
    },
  ] as const;
  return bindings.map((binding) => ({
    rightsId: binding.rightsId,
    providerId: GROK_PROVIDER_ID,
    productId: binding.productId,
    credentialType: binding.credentialType,
    supplyMode: GROK_SUPPLY_MODE,
    region: GROK_REGION,
    purpose: GROK_PURPOSE,
    modelScope: [...GROK_PLACEHOLDER_MODELS],
    endpointScope: [GROK_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  }));
}

/** Stable default rights ids; operators may pass their own to `registerGrokProviderCatalog`. */
export const GROK_DEFAULT_OAUTH_RIGHTS_ID = 'grok-subscription-platform-oauth-v1';
export const GROK_DEFAULT_API_KEY_RIGHTS_ID = 'grok-api-platform-api-key-v1';

/** Registers products, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerGrokProviderCatalog(
  catalog: Pick<
    SaasCatalogService,
    'registerProviderProduct' | 'registerProviderCapability' | 'registerProviderRightsVersion'
  >,
  options: {
    readonly evidenceVersion?: string;
    readonly effectiveAt?: string;
    readonly rightsIds?: { readonly oauth?: string; readonly apiKey?: string };
    readonly sha256?: string;
    readonly audit?: ProviderRightsAuditContext;
  } = {},
): Promise<void> {
  const evidenceVersion = options.evidenceVersion ?? 'grok-b3-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? '7'.repeat(64);
  for (const product of grokProviderProductInputs()) {
    await catalog.registerProviderProduct(product);
  }
  for (const capability of grokCapabilityInputs({
    evidenceVersion,
    reference: `${GROK_PROVIDER_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  const rights = grokPlatformRightsInputs(
    {
      approvalReference: 'capability-parity-batch-3',
      evidenceReference: `${GROK_PROVIDER_ID}-rights-preset`,
      sha256,
      effectiveAt,
    },
    options.audit,
  );
  const oauthId = options.rightsIds?.oauth ?? GROK_DEFAULT_OAUTH_RIGHTS_ID;
  const apiKeyId = options.rightsIds?.apiKey ?? GROK_DEFAULT_API_KEY_RIGHTS_ID;
  for (const input of rights) {
    await catalog.registerProviderRightsVersion(
      input.rightsId === GROK_DEFAULT_OAUTH_RIGHTS_ID
        ? { ...input, rightsId: oauthId }
        : { ...input, rightsId: apiKeyId },
    );
  }
}

/**
 * Placeholder pricing (mirrors the codex/gemini placeholder): the Grok CLI
 * subscription upstream has no per-token supplier cost, so the supplier cost
 * version 1 registers zero rates by design. Customer-facing prices are a
 * business decision and are NOT registered here — the operator registers
 * them through the platform console with the same identity keys.
 */
export const GROK_PLACEHOLDER_PRICING_VERSION = 1;

export function grokPlaceholderSupplierCostInputs(
  audit: PlatformPriceAuditContext,
  options: {
    readonly publicModelIds: readonly { readonly publicModelId: string; readonly publicModelVersion: number }[];
    readonly effectiveAt?: string;
  } = { publicModelIds: [] },
): readonly RegisterPlatformPriceVersionInput[] {
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  return options.publicModelIds.map(({ publicModelId, publicModelVersion }) => ({
    publicModelId,
    publicModelVersion,
    protocol: GROK_PROTOCOL,
    endpoint: GROK_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${GROK_PROVIDER_ID}-supplier-cost-v${GROK_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'grok-placeholder-commercial-v1',
    calculatorVersion: 'grok-placeholder-calculator-v1',
    roundingVersion: 'grok-placeholder-rounding-v1',
    roundingMode: 'half_up' as const,
    roundingBoundary: 'total' as const,
    // Subscription upstream: an explicit zero per-token supplier cost (the
    // pricing contract requires defined input/output rates; null is invalid).
    rates: {
      input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_read: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_write: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    },
    audit,
  }));
}

/** Registers the placeholder supplier cost version 1 for the given public models. */
export async function registerGrokPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof grokPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of grokPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}

/**
 * Public-model alias inputs for a grok model list (default: the placeholder
 * catalog). Each provider model gets one namespaced alias `grok/<model>` —
 * the prefix `normalizeGrokModelId` strips — so clients may request either
 * the namespaced alias or the bare catalog id, and `modelMap` resolution
 * maps the public alias onto the provider model under the `grok-responses`
 * endpoint scope.
 */
export function grokPublicModelAliasInputs(
  models: readonly string[] = GROK_PLACEHOLDER_MODELS,
  options: { readonly displayNamePrefix?: string } = {},
): readonly RegisterPublicModelAliasInput[] {
  const seen = new Set<string>();
  const inputs: RegisterPublicModelAliasInput[] = [];
  for (const rawModel of models) {
    // Normalize first so a prefixed upstream id and the bare catalog id
    // collapse onto one provider model and one alias.
    const model = normalizeGrokModelId(rawModel);
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    inputs.push({
      alias: `grok/${model}`,
      displayName: `${options.displayNamePrefix ?? 'Grok'} ${model}`,
      providerId: GROK_PROVIDER_ID,
      productId: GROK_OAUTH_PRODUCT_ID,
      model,
      endpointScope: [GROK_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per model (idempotent per alias identity). */
export async function registerGrokPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  models?: readonly string[],
): Promise<void> {
  for (const input of grokPublicModelAliasInputs(models)) {
    await catalog.registerPublicModelAlias(input);
  }
}
