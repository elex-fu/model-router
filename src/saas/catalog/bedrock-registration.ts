import {
  BEDROCK_CREDENTIAL_TYPE,
  BEDROCK_DISPLAY_NAME,
  BEDROCK_ENDPOINT,
  BEDROCK_PLACEHOLDER_MODELS,
  BEDROCK_PRODUCT_ID,
  BEDROCK_PROTOCOL,
  BEDROCK_PROVIDER_ID,
  BEDROCK_PURPOSE,
  BEDROCK_REGION,
  BEDROCK_SUPPLY_MODE,
} from '../gateway/bedrock/catalog-identity.js';
import { normalizeBedrockModelAlias } from '../gateway/bedrock/transform.js';
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
  BEDROCK_CREDENTIAL_TYPE,
  BEDROCK_DISPLAY_NAME,
  BEDROCK_ENDPOINT,
  BEDROCK_PLACEHOLDER_MODELS,
  BEDROCK_PRODUCT_ID,
  BEDROCK_PROTOCOL,
  BEDROCK_PROVIDER_ID,
  BEDROCK_PURPOSE,
  BEDROCK_REGION,
  BEDROCK_SUPPLY_MODE,
};

/**
 * Batch-3 `aws-bedrock` provider catalog registration (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三). Mirrors
 * gemini-registration.ts, differing where the Bedrock supply shape
 * differs: operator-submitted AWS SigV4 keys sealed through the
 * platform/bedrock-keys sink (no OAuth flow), and a per-account region
 * (the envelope's aws_region) with the catalog region a neutral bucket.
 *
 * Identity contract (all sites must agree):
 * - provider `aws-bedrock`, product `bedrock-claude`, credential type
 *   `aws-sigv4`, supply mode `platform`, region `global`, purpose
 *   `inference`;
 * - protocol `anthropic` (the client protocol: clients send Anthropic
 *   Messages bodies and the bedrock transform rewrites them onto the
 *   InvokeModel shape), endpoint scope `bedrock-invoke`;
 * - the account probe (supply/account-probe-service.ts buildBedrockProbe)
 *   and the gateway dispatch split (managed-saas-gateway.ts
 *   bedrockEvidenceTransport) key on this same triple;
 * - the upstream host is pinned per region to
 *   `https://bedrock-runtime.<region>.amazonaws.com`
 *   (buildBedrockInvokeUrl in gateway/bedrock/transform.ts).
 */

export function bedrockProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: BEDROCK_PROVIDER_ID,
    productId: BEDROCK_PRODUCT_ID,
    displayName: BEDROCK_DISPLAY_NAME,
    status: 'active',
  };
}

export function bedrockCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  return BEDROCK_PLACEHOLDER_MODELS.map((model) => ({
    providerId: BEDROCK_PROVIDER_ID,
    productId: BEDROCK_PRODUCT_ID,
    model,
    endpoint: BEDROCK_ENDPOINT,
    protocol: BEDROCK_PROTOCOL,
    supportLevel: 'supported' as const,
    validationState: 'verified' as const,
    evidenceVersion: evidence.evidenceVersion,
    discoverySource: 'preset' as const,
    evidenceReference: evidence.reference,
    evidenceSha256: evidence.sha256,
  }));
}

export function bedrockPlatformRightsInput(
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
    providerId: BEDROCK_PROVIDER_ID,
    productId: BEDROCK_PRODUCT_ID,
    credentialType: BEDROCK_CREDENTIAL_TYPE,
    supplyMode: BEDROCK_SUPPLY_MODE,
    region: BEDROCK_REGION,
    purpose: BEDROCK_PURPOSE,
    modelScope: [...BEDROCK_PLACEHOLDER_MODELS],
    endpointScope: [BEDROCK_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights id; operators may pass their own to `registerBedrockProviderCatalog`. */
export const BEDROCK_DEFAULT_RIGHTS_ID = 'bedrock-claude-platform-aws-sigv4-v1';

/** Registers product, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerBedrockProviderCatalog(
  catalog: Pick<
    SaasCatalogService,
    'registerProviderProduct' | 'registerProviderCapability' | 'registerProviderRightsVersion'
  >,
  options: {
    readonly evidenceVersion?: string;
    readonly effectiveAt?: string;
    readonly rightsId?: string;
    readonly sha256?: string;
    readonly audit?: ProviderRightsAuditContext;
  } = {},
): Promise<void> {
  const evidenceVersion = options.evidenceVersion ?? 'bedrock-batch3-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? 'b'.repeat(64);
  await catalog.registerProviderProduct(bedrockProviderProductInput());
  for (const capability of bedrockCapabilityInputs({
    evidenceVersion,
    reference: `${BEDROCK_PROVIDER_ID}-${BEDROCK_PRODUCT_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  await catalog.registerProviderRightsVersion(
    bedrockPlatformRightsInput(
      {
        rightsId: options.rightsId ?? BEDROCK_DEFAULT_RIGHTS_ID,
        approvalReference: 'capability-parity-batch-3',
        evidenceReference: `${BEDROCK_PROVIDER_ID}-${BEDROCK_PRODUCT_ID}-rights-preset`,
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
}

/**
 * Placeholder supplier costs (the gemini Phase-F4 precedent): Bedrock
 * on-demand pricing is a deployment's commercial decision and is NOT
 * registered here — the operator registers real per-model rates through
 * the platform console with the same identity keys. Version 1 registers
 * explicit zero rates so the pricing contract stays defined.
 */
export const BEDROCK_PLACEHOLDER_PRICING_VERSION = 1;

export function bedrockPlaceholderSupplierCostInputs(
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
    protocol: BEDROCK_PROTOCOL,
    endpoint: BEDROCK_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${BEDROCK_PROVIDER_ID}-supplier-cost-v${BEDROCK_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'bedrock-placeholder-commercial-v1',
    calculatorVersion: 'bedrock-placeholder-calculator-v1',
    roundingVersion: 'bedrock-placeholder-rounding-v1',
    roundingMode: 'half_up' as const,
    roundingBoundary: 'total' as const,
    // The pricing contract requires defined input/output rates; the
    // placeholder is an explicit zero (operators replace it with the real
    // on-demand per-token rates at registration time).
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
export async function registerBedrockPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof bedrockPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of bedrockPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}

/**
 * modelMap normalization: public-model alias inputs for a Bedrock model
 * list (default: the placeholder catalog). Each provider model gets one
 * namespaced alias `bedrock/<model>` — the prefix
 * `normalizeBedrockModelAlias` strips — so clients may request either the
 * namespaced alias or (with a bare-id alias the operator adds separately)
 * the bare catalog id, and `modelMap` resolution maps the public alias
 * onto the provider model under the `bedrock-invoke` endpoint scope.
 */
export function bedrockPublicModelAliasInputs(
  models: readonly string[] = BEDROCK_PLACEHOLDER_MODELS,
  options: { readonly displayNamePrefix?: string } = {},
): readonly RegisterPublicModelAliasInput[] {
  const seen = new Set<string>();
  const inputs: RegisterPublicModelAliasInput[] = [];
  for (const rawModel of models) {
    const model = normalizeBedrockModelAlias(rawModel);
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    inputs.push({
      alias: `bedrock/${model}`,
      displayName: `${options.displayNamePrefix ?? 'Bedrock'} ${model}`,
      providerId: BEDROCK_PROVIDER_ID,
      productId: BEDROCK_PRODUCT_ID,
      model,
      endpointScope: [BEDROCK_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per model (idempotent per alias identity). */
export async function registerBedrockPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  models?: readonly string[],
): Promise<void> {
  for (const input of bedrockPublicModelAliasInputs(models)) {
    await catalog.registerPublicModelAlias(input);
  }
}
