import {
  MINIMAX_CREDENTIAL_TYPE,
  MINIMAX_DISPLAY_NAME,
  MINIMAX_ENDPOINT,
  MINIMAX_PRODUCT_ID,
  MINIMAX_PROVIDER_ID,
  MINIMAX_PURPOSE,
  MINIMAX_REGION,
  MINIMAX_SUPPLY_MODE,
  ZHIPU_CODING_DISPLAY_NAME,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_CODING_PRODUCT_ID,
  ZHIPU_CREDENTIAL_TYPE,
  ZHIPU_DISPLAY_NAME,
  ZHIPU_ENDPOINT,
  ZHIPU_PRODUCT_ID,
  ZHIPU_PROVIDER_ID,
  ZHIPU_PURPOSE,
  ZHIPU_REGION,
  ZHIPU_SUPPLY_MODE,
} from '../gateway/cn-providers/catalog-identity.js';
import { MINIMAX_FALLBACK_MODEL_IDS, ZHIPU_FALLBACK_MODEL_IDS } from '../gateway/cn-providers/constants.js';
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
  MINIMAX_CREDENTIAL_TYPE,
  MINIMAX_DISPLAY_NAME,
  MINIMAX_ENDPOINT,
  MINIMAX_FALLBACK_MODEL_IDS,
  MINIMAX_PRODUCT_ID,
  MINIMAX_PROVIDER_ID,
  MINIMAX_PURPOSE,
  MINIMAX_REGION,
  MINIMAX_SUPPLY_MODE,
  ZHIPU_CODING_DISPLAY_NAME,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_CODING_PRODUCT_ID,
  ZHIPU_CREDENTIAL_TYPE,
  ZHIPU_DISPLAY_NAME,
  ZHIPU_ENDPOINT,
  ZHIPU_FALLBACK_MODEL_IDS,
  ZHIPU_PRODUCT_ID,
  ZHIPU_PROVIDER_ID,
  ZHIPU_PURPOSE,
  ZHIPU_REGION,
  ZHIPU_SUPPLY_MODE,
};

/**
 * Batch-3 CN-provider catalog registration (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 智谱/MiniMax; sub2api
 * reference: backend/internal/service/domain_constants.go). Mirrors
 * opencode-go-registration.ts, differing where the CN-provider supply shape
 * differs:
 *
 * - THREE products under TWO providers: `zhipu-glm` (payg) and
 *   `zhipu-glm-coding` (Coding Plan — different inference host) under
 *   `zhipu`; one `minimax-m` product under `minimax` (payg and Coding/Token
 *   Plan share the inference domain; the migration-120 account_mode column
 *   distinguishes quota-probing semantics, never the URL);
 * - every capability row registers under BOTH native protocols ('openai'
 *   Chat Completions and 'anthropic' Messages): the adaptive api_protocol
 *   routes the native endpoint per inbound client protocol, so a model is
 *   servable under either client protocol (same-protocol passthrough
 *   bridges; MiniMax's native Responses endpoint is reachable through the
 *   capabilityProtocolForModel protocol set only when the operator adds a
 *   responses-protocol capability row — the default dual registration keeps
 *   to the two Anthropic/OpenAI natives every provider in this category
 *   serves).
 *
 * Identity contract (all sites must agree): credential type `api-key` (the
 * existing sealed envelope, bare-key plaintext), supply mode `platform`,
 * region `cn`, purpose `inference`; endpoint scopes `zhipu-glm` /
 * `zhipu-glm-coding` / `minimax-m`.
 */

/** The two native protocols every CN-provider model registers under. */
export const CN_PROVIDER_CAPABILITY_PROTOCOLS: readonly ('openai' | 'anthropic')[] = Object.freeze([
  'openai',
  'anthropic',
]);

export function cnProviderProductInputs(): readonly RegisterProviderProductInput[] {
  return [
    {
      providerId: ZHIPU_PROVIDER_ID,
      productId: ZHIPU_PRODUCT_ID,
      displayName: ZHIPU_DISPLAY_NAME,
      status: 'active',
    },
    {
      providerId: ZHIPU_PROVIDER_ID,
      productId: ZHIPU_CODING_PRODUCT_ID,
      displayName: ZHIPU_CODING_DISPLAY_NAME,
      status: 'active',
    },
    {
      providerId: MINIMAX_PROVIDER_ID,
      productId: MINIMAX_PRODUCT_ID,
      displayName: MINIMAX_DISPLAY_NAME,
      status: 'active',
    },
  ];
}

export function zhipuCapabilityInputs(
  evidence: {
    readonly evidenceVersion: string;
    readonly reference: string;
    readonly sha256: string;
  },
  models: readonly string[] = ZHIPU_FALLBACK_MODEL_IDS,
  endpoint: string = ZHIPU_ENDPOINT,
): readonly RegisterProviderCapabilityInput[] {
  const inputs: RegisterProviderCapabilityInput[] = [];
  for (const model of models) {
    for (const protocol of CN_PROVIDER_CAPABILITY_PROTOCOLS) {
      inputs.push({
        providerId: ZHIPU_PROVIDER_ID,
        productId: ZHIPU_PRODUCT_ID,
        model,
        endpoint,
        protocol,
        supportLevel: 'supported' as const,
        validationState: 'verified' as const,
        evidenceVersion: evidence.evidenceVersion,
        discoverySource: 'preset' as const,
        evidenceReference: evidence.reference,
        evidenceSha256: evidence.sha256,
      });
    }
  }
  return inputs;
}

export function zhipuCodingCapabilityInputs(
  evidence: {
    readonly evidenceVersion: string;
    readonly reference: string;
    readonly sha256: string;
  },
  models: readonly string[] = ZHIPU_FALLBACK_MODEL_IDS,
): readonly RegisterProviderCapabilityInput[] {
  // The Coding Plan product registers the same model set under its own
  // endpoint scope; capabilities are product-scoped rows.
  return zhipuCapabilityInputs(evidence, models, ZHIPU_CODING_ENDPOINT).map((input) => ({
    ...input,
    productId: ZHIPU_CODING_PRODUCT_ID,
  }));
}

export function minimaxCapabilityInputs(
  evidence: {
    readonly evidenceVersion: string;
    readonly reference: string;
    readonly sha256: string;
  },
  models: readonly string[] = MINIMAX_FALLBACK_MODEL_IDS,
): readonly RegisterProviderCapabilityInput[] {
  const inputs: RegisterProviderCapabilityInput[] = [];
  for (const model of models) {
    for (const protocol of CN_PROVIDER_CAPABILITY_PROTOCOLS) {
      inputs.push({
        providerId: MINIMAX_PROVIDER_ID,
        productId: MINIMAX_PRODUCT_ID,
        model,
        endpoint: MINIMAX_ENDPOINT,
        protocol,
        supportLevel: 'supported' as const,
        validationState: 'verified' as const,
        evidenceVersion: evidence.evidenceVersion,
        discoverySource: 'preset' as const,
        evidenceReference: evidence.reference,
        evidenceSha256: evidence.sha256,
      });
    }
  }
  return inputs;
}

export function zhipuPlatformRightsInput(
  evidence: {
    readonly rightsId: string;
    readonly approvalReference: string;
    readonly evidenceReference: string;
    readonly sha256: string;
    readonly effectiveAt: string;
  },
  audit?: ProviderRightsAuditContext,
): RegisterProviderRightsVersionInput {
  return {
    rightsId: evidence.rightsId,
    providerId: ZHIPU_PROVIDER_ID,
    productId: ZHIPU_PRODUCT_ID,
    credentialType: ZHIPU_CREDENTIAL_TYPE,
    supplyMode: ZHIPU_SUPPLY_MODE,
    region: ZHIPU_REGION,
    purpose: ZHIPU_PURPOSE,
    modelScope: [...ZHIPU_FALLBACK_MODEL_IDS],
    endpointScope: [ZHIPU_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

export function zhipuCodingPlatformRightsInput(
  evidence: {
    readonly rightsId: string;
    readonly approvalReference: string;
    readonly evidenceReference: string;
    readonly sha256: string;
    readonly effectiveAt: string;
  },
  audit?: ProviderRightsAuditContext,
): RegisterProviderRightsVersionInput {
  return {
    rightsId: evidence.rightsId,
    providerId: ZHIPU_PROVIDER_ID,
    productId: ZHIPU_CODING_PRODUCT_ID,
    credentialType: ZHIPU_CREDENTIAL_TYPE,
    supplyMode: ZHIPU_SUPPLY_MODE,
    region: ZHIPU_REGION,
    purpose: ZHIPU_PURPOSE,
    modelScope: [...ZHIPU_FALLBACK_MODEL_IDS],
    endpointScope: [ZHIPU_CODING_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

export function minimaxPlatformRightsInput(
  evidence: {
    readonly rightsId: string;
    readonly approvalReference: string;
    readonly evidenceReference: string;
    readonly sha256: string;
    readonly effectiveAt: string;
  },
  audit?: ProviderRightsAuditContext,
): RegisterProviderRightsVersionInput {
  return {
    rightsId: evidence.rightsId,
    providerId: MINIMAX_PROVIDER_ID,
    productId: MINIMAX_PRODUCT_ID,
    credentialType: MINIMAX_CREDENTIAL_TYPE,
    supplyMode: MINIMAX_SUPPLY_MODE,
    region: MINIMAX_REGION,
    purpose: MINIMAX_PURPOSE,
    modelScope: [...MINIMAX_FALLBACK_MODEL_IDS],
    endpointScope: [MINIMAX_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights ids; operators may pass their own. */
export const ZHIPU_DEFAULT_RIGHTS_ID = 'zhipu-glm-platform-api-key-v1';
export const ZHIPU_CODING_DEFAULT_RIGHTS_ID = 'zhipu-glm-coding-platform-api-key-v1';
export const MINIMAX_DEFAULT_RIGHTS_ID = 'minimax-m-platform-api-key-v1';

/** Registers products, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerCnProvidersCatalog(
  catalog: Pick<
    SaasCatalogService,
    'registerProviderProduct' | 'registerProviderCapability' | 'registerProviderRightsVersion'
  >,
  options: {
    readonly evidenceVersion?: string;
    readonly effectiveAt?: string;
    readonly sha256?: string;
    readonly audit?: ProviderRightsAuditContext;
  } = {},
): Promise<void> {
  const evidenceVersion = options.evidenceVersion ?? 'cn-providers-batch3-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? 'a'.repeat(64);
  for (const product of cnProviderProductInputs()) {
    await catalog.registerProviderProduct(product);
  }
  const evidence = { evidenceVersion, reference: 'cn-providers-batch3-preset', sha256 };
  for (const capability of [
    ...zhipuCapabilityInputs(evidence),
    ...zhipuCodingCapabilityInputs(evidence),
    ...minimaxCapabilityInputs(evidence),
  ]) {
    await catalog.registerProviderCapability(capability);
  }
  await catalog.registerProviderRightsVersion(
    zhipuPlatformRightsInput(
      {
        rightsId: ZHIPU_DEFAULT_RIGHTS_ID,
        approvalReference: 'capability-parity-batch-3',
        evidenceReference: 'zhipu-glm-rights-preset',
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
  await catalog.registerProviderRightsVersion(
    zhipuCodingPlatformRightsInput(
      {
        rightsId: ZHIPU_CODING_DEFAULT_RIGHTS_ID,
        approvalReference: 'capability-parity-batch-3',
        evidenceReference: 'zhipu-glm-coding-rights-preset',
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
  await catalog.registerProviderRightsVersion(
    minimaxPlatformRightsInput(
      {
        rightsId: MINIMAX_DEFAULT_RIGHTS_ID,
        approvalReference: 'capability-parity-batch-3',
        evidenceReference: 'minimax-m-rights-preset',
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
}

/**
 * Placeholder pricing (the opencode-go placeholder precedent): zhipu payg
 * and minimax are per-token metered upstreams, but real supplier rates are
 * operator business decisions registered through the platform console with
 * the same identity keys — the placeholder version registers explicit zero
 * rates (the pricing contract requires defined rates; null is invalid).
 * Coding Plan products have no per-token supplier cost by design.
 */
export const CN_PROVIDERS_PLACEHOLDER_PRICING_VERSION = 1;

export function cnProvidersPlaceholderSupplierCostInputs(
  audit: PlatformPriceAuditContext,
  options: {
    readonly publicModelIds: readonly {
      readonly publicModelId: string;
      readonly publicModelVersion: number;
      /** The backing provider model's capability protocol; defaults to 'openai'. */
      readonly protocol?: 'openai' | 'anthropic';
      readonly endpoint: string;
    }[];
    readonly effectiveAt?: string;
  } = { publicModelIds: [] },
): readonly RegisterPlatformPriceVersionInput[] {
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  return options.publicModelIds.map(({ publicModelId, publicModelVersion, protocol, endpoint }) => ({
    publicModelId,
    publicModelVersion,
    protocol: protocol ?? 'openai',
    endpoint,
    currency: 'USD',
    idempotencyKey: `cn-providers-supplier-cost-v${CN_PROVIDERS_PLACEHOLDER_PRICING_VERSION}-${publicModelId}-${protocol ?? 'openai'}`,
    effectiveAt,
    commercialPolicyVersion: 'cn-providers-placeholder-commercial-v1',
    calculatorVersion: 'cn-providers-placeholder-calculator-v1',
    roundingVersion: 'cn-providers-placeholder-rounding-v1',
    roundingMode: 'half_up' as const,
    roundingBoundary: 'total' as const,
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
export async function registerCnProvidersPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof cnProvidersPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of cnProvidersPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}

/**
 * Public-model alias inputs: one namespaced alias per (provider, model,
 * capability protocol) — `zhipu/<model>` / `zhipu-coding/<model>` /
 * `minimax/<model>` under the product's endpoint scope, so clients may
 * request either the namespaced alias or a bare alias the operator adds
 * separately.
 */
export function cnProvidersPublicModelAliasInputs(
  options: { readonly zhipuModels?: readonly string[]; readonly minimaxModels?: readonly string[] } = {},
): readonly RegisterPublicModelAliasInput[] {
  const zhipuModels = options.zhipuModels ?? ZHIPU_FALLBACK_MODEL_IDS;
  const minimaxModels = options.minimaxModels ?? MINIMAX_FALLBACK_MODEL_IDS;
  const inputs: RegisterPublicModelAliasInput[] = [];
  const seen = new Set<string>();
  for (const model of zhipuModels) {
    const alias = `zhipu/${model}`;
    if (seen.has(alias)) continue;
    seen.add(alias);
    inputs.push({
      alias,
      displayName: `Zhipu GLM ${model}`,
      providerId: ZHIPU_PROVIDER_ID,
      productId: ZHIPU_PRODUCT_ID,
      model,
      endpointScope: [ZHIPU_ENDPOINT],
      status: 'active',
    });
    inputs.push({
      alias: `zhipu-coding/${model}`,
      displayName: `Zhipu GLM Coding ${model}`,
      providerId: ZHIPU_PROVIDER_ID,
      productId: ZHIPU_CODING_PRODUCT_ID,
      model,
      endpointScope: [ZHIPU_CODING_ENDPOINT],
      status: 'active',
    });
  }
  for (const model of minimaxModels) {
    const alias = `minimax/${model}`;
    if (seen.has(alias)) continue;
    seen.add(alias);
    inputs.push({
      alias,
      displayName: `MiniMax ${model}`,
      providerId: MINIMAX_PROVIDER_ID,
      productId: MINIMAX_PRODUCT_ID,
      model,
      endpointScope: [MINIMAX_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per (provider, model, product). */
export async function registerCnProvidersPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  options: Parameters<typeof cnProvidersPublicModelAliasInputs>[0] = {},
): Promise<void> {
  for (const input of cnProvidersPublicModelAliasInputs(options)) {
    await catalog.registerPublicModelAlias(input);
  }
}
