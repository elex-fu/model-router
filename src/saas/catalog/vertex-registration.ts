import {
  VERTEX_ANTHROPIC_MODELS,
  VERTEX_ANTHROPIC_PROTOCOL,
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_DISPLAY_NAME,
  VERTEX_ENDPOINT,
  VERTEX_GEMINI_MODELS,
  VERTEX_GEMINI_PROTOCOL,
  VERTEX_PLACEHOLDER_MODELS,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
  VERTEX_PURPOSE,
  VERTEX_REGION,
  VERTEX_SUPPLY_MODE,
} from '../gateway/vertex/catalog-identity.js';
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
  VERTEX_ANTHROPIC_MODELS,
  VERTEX_ANTHROPIC_PROTOCOL,
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_DISPLAY_NAME,
  VERTEX_ENDPOINT,
  VERTEX_GEMINI_MODELS,
  VERTEX_GEMINI_PROTOCOL,
  VERTEX_PLACEHOLDER_MODELS,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
  VERTEX_PURPOSE,
  VERTEX_REGION,
  VERTEX_SUPPLY_MODE,
};

/**
 * Batch-3 `google-vertex` provider catalog registration (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA). The
 * catalog is database-backed and operator-driven: this module supplies the
 * canonical registration inputs (product, capabilities, platform rights,
 * placeholder pricing) plus one-call appliers so the console, migrations
 * tooling, or tests register the exact same identity everywhere. It mirrors
 * gemini-registration.ts, differing where the Vertex supply shape differs:
 * a service-account credential imported from a GCP key file
 * (platform/vertex-sa), and a DUAL model catalog — Anthropic-on-Vertex
 * models under provider protocol `anthropic` and Gemini-on-Vertex models
 * under provider protocol `gemini`, both on the single
 * `vertex-raw-predict` endpoint scope (the transport selects the endpoint
 * family from the signed provider protocol).
 *
 * Identity contract (all sites must agree):
 * - provider `google-vertex`, product `vertex-ai`, credential type
 *   `service_account`, supply mode `platform`, region `global`, purpose
 *   `inference`;
 * - endpoint scope `vertex-raw-predict` with per-capability protocol
 *   `anthropic` (claude-* models) or `gemini` (gemini-* models);
 * - the supply sink binds this same triple (platform/vertex-sa/
 *   supply-sink.ts) and the SA token refresher claims it
 *   (platform/vertex-sa/token-service.ts VERTEX_SA_BINDING);
 * - the upstream host is pinned to `{location}-aiplatform.googleapis.com`
 *   (gateway/vertex/transform.ts buildVertex*Url; `global` unprefixed).
 */

export function vertexProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: VERTEX_PROVIDER_ID,
    productId: VERTEX_PRODUCT_ID,
    displayName: VERTEX_DISPLAY_NAME,
    status: 'active',
  };
}

/** One capability input per model, carrying that model family's provider protocol. */
export function vertexCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  const families: ReadonlyArray<{
    readonly models: readonly string[];
    readonly protocol: string;
  }> = [
    { models: VERTEX_ANTHROPIC_MODELS, protocol: VERTEX_ANTHROPIC_PROTOCOL },
    { models: VERTEX_GEMINI_MODELS, protocol: VERTEX_GEMINI_PROTOCOL },
  ];
  const inputs: RegisterProviderCapabilityInput[] = [];
  for (const family of families) {
    for (const model of family.models) {
      inputs.push({
        providerId: VERTEX_PROVIDER_ID,
        productId: VERTEX_PRODUCT_ID,
        model,
        endpoint: VERTEX_ENDPOINT,
        protocol: family.protocol,
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

export function vertexPlatformRightsInput(
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
    providerId: VERTEX_PROVIDER_ID,
    productId: VERTEX_PRODUCT_ID,
    credentialType: VERTEX_CREDENTIAL_TYPE,
    supplyMode: VERTEX_SUPPLY_MODE,
    region: VERTEX_REGION,
    purpose: VERTEX_PURPOSE,
    modelScope: [...VERTEX_PLACEHOLDER_MODELS],
    endpointScope: [VERTEX_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights id; operators may pass their own to `registerVertexProviderCatalog`. */
export const VERTEX_DEFAULT_RIGHTS_ID = 'vertex-ai-platform-service-account-v1';

/** Registers product, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerVertexProviderCatalog(
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
  const evidenceVersion = options.evidenceVersion ?? 'vertex-b3-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? 'e'.repeat(64);
  await catalog.registerProviderProduct(vertexProviderProductInput());
  for (const capability of vertexCapabilityInputs({
    evidenceVersion,
    reference: `${VERTEX_PROVIDER_ID}-${VERTEX_PRODUCT_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  await catalog.registerProviderRightsVersion(
    vertexPlatformRightsInput(
      {
        rightsId: options.rightsId ?? VERTEX_DEFAULT_RIGHTS_ID,
        approvalReference: 'capability-parity-batch-3-vertex',
        evidenceReference: `${VERTEX_PROVIDER_ID}-${VERTEX_PRODUCT_ID}-rights-preset`,
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
}

/**
 * Placeholder pricing (the gemini/codex placeholder precedent): the real
 * Vertex supplier cost is per-token and provider-billed, but registering
 * live rates is the operator's commercial decision through the platform
 * console. Supplier cost version 1 registers zero rates by design so the
 * catalog is complete and overridable; customer-facing prices are NOT
 * registered here.
 */
export const VERTEX_PLACEHOLDER_PRICING_VERSION = 1;

/** The provider protocol a public model id maps onto (gemini default; anthropic for the claude family). */
export function vertexProtocolForModel(model: string): string {
  return VERTEX_ANTHROPIC_MODELS.includes(model) ? VERTEX_ANTHROPIC_PROTOCOL : VERTEX_GEMINI_PROTOCOL;
}

export function vertexPlaceholderSupplierCostInputs(
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
    protocol: vertexProtocolForModel(publicModelId),
    endpoint: VERTEX_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${VERTEX_PROVIDER_ID}-supplier-cost-v${VERTEX_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'vertex-placeholder-commercial-v1',
    calculatorVersion: 'vertex-placeholder-calculator-v1',
    roundingVersion: 'vertex-placeholder-rounding-v1',
    roundingMode: 'half_up' as const,
    roundingBoundary: 'total' as const,
    // Placeholder zero per-token supplier cost (the pricing contract requires
    // defined input/output rates; null is invalid). The operator's real
    // per-token Vertex rates override this version in the console.
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
export async function registerVertexPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof vertexPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of vertexPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}

/**
 * ModelMap normalization: public-model alias inputs for a Vertex model list
 * (default: the placeholder catalog). Each provider model gets one
 * namespaced alias `vertex/<model>` so `modelMap` resolution maps the
 * public alias onto the provider model under the `vertex-raw-predict`
 * endpoint scope.
 */
export function vertexPublicModelAliasInputs(
  models: readonly string[] = VERTEX_PLACEHOLDER_MODELS,
  options: { readonly displayNamePrefix?: string } = {},
): readonly RegisterPublicModelAliasInput[] {
  const seen = new Set<string>();
  const inputs: RegisterPublicModelAliasInput[] = [];
  for (const model of models) {
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    inputs.push({
      alias: `vertex/${model}`,
      displayName: `${options.displayNamePrefix ?? 'Vertex'} ${model}`,
      providerId: VERTEX_PROVIDER_ID,
      productId: VERTEX_PRODUCT_ID,
      model,
      endpointScope: [VERTEX_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per model (idempotent per alias identity). */
export async function registerVertexPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  models?: readonly string[],
): Promise<void> {
  for (const input of vertexPublicModelAliasInputs(models)) {
    await catalog.registerPublicModelAlias(input);
  }
}
