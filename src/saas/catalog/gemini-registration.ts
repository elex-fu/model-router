import {
  GEMINI_CREDENTIAL_TYPE,
  GEMINI_DISPLAY_NAME,
  GEMINI_ENDPOINT,
  GEMINI_PLACEHOLDER_MODELS,
  GEMINI_PRODUCT_ID,
  GEMINI_PROTOCOL,
  GEMINI_PROVIDER_ID,
  GEMINI_PURPOSE,
  GEMINI_REGION,
  GEMINI_SUPPLY_MODE,
} from '../gateway/gemini/catalog-identity.js';
import { normalizeGeminiModelId } from '../gateway/gemini/transform.js';
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
  GEMINI_CREDENTIAL_TYPE,
  GEMINI_DISPLAY_NAME,
  GEMINI_ENDPOINT,
  GEMINI_PLACEHOLDER_MODELS,
  GEMINI_PRODUCT_ID,
  GEMINI_PROTOCOL,
  GEMINI_PROVIDER_ID,
  GEMINI_PURPOSE,
  GEMINI_REGION,
  GEMINI_SUPPLY_MODE,
};

/**
 * F4 `google-gemini` provider catalog registration (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). The catalog is
 * database-backed and operator-driven: this module supplies the canonical
 * registration inputs (product, capabilities, platform rights, placeholder
 * pricing) plus one-call appliers so the console, migrations tooling, or
 * tests register the exact same identity everywhere. It mirrors
 * codex-registration.ts / opencode-go-registration.ts, differing only where
 * the Gemini supply shape differs: an OAuth credential bound through the
 * Code Assist flow (platform/gemini-oauth).
 *
 * Identity contract (all sites must agree):
 * - provider `google-gemini`, product `gemini-subscription`, credential type
 *   `oauth`, supply mode `platform`, region `global`, purpose `inference`;
 * - protocol `gemini` (the native /v1beta client protocol; proxy.ts already
 *   routes /v1beta path roots onto it and the authority adapter's
 *   capability/client-protocol equality check passes only under it),
 *   endpoint scope `gemini-generate-content`;
 * - the R4 refresh worker binds this same triple (its
 *   `google-gemini-oauth-v1` adapter) so platform accounts created against
 *   these rights are refreshed automatically;
 * - the upstream host is pinned to https://cloudcode-pa.googleapis.com
 *   (GEMINI_CLI_BASE_URL in gateway/gemini/catalog-identity.ts).
 */

export function geminiProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: GEMINI_PROVIDER_ID,
    productId: GEMINI_PRODUCT_ID,
    displayName: GEMINI_DISPLAY_NAME,
    status: 'active',
  };
}

export function geminiCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  return GEMINI_PLACEHOLDER_MODELS.map((model) => ({
    providerId: GEMINI_PROVIDER_ID,
    productId: GEMINI_PRODUCT_ID,
    model,
    endpoint: GEMINI_ENDPOINT,
    protocol: GEMINI_PROTOCOL,
    supportLevel: 'supported' as const,
    validationState: 'verified' as const,
    evidenceVersion: evidence.evidenceVersion,
    discoverySource: 'preset' as const,
    evidenceReference: evidence.reference,
    evidenceSha256: evidence.sha256,
  }));
}

export function geminiPlatformRightsInput(
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
    providerId: GEMINI_PROVIDER_ID,
    productId: GEMINI_PRODUCT_ID,
    credentialType: GEMINI_CREDENTIAL_TYPE,
    supplyMode: GEMINI_SUPPLY_MODE,
    region: GEMINI_REGION,
    purpose: GEMINI_PURPOSE,
    modelScope: [...GEMINI_PLACEHOLDER_MODELS],
    endpointScope: [GEMINI_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights id; operators may pass their own to `registerGeminiProviderCatalog`. */
export const GEMINI_DEFAULT_RIGHTS_ID = 'gemini-subscription-platform-oauth-v1';

/** Registers product, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerGeminiProviderCatalog(
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
  const evidenceVersion = options.evidenceVersion ?? 'gemini-f4-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? 'e'.repeat(64);
  await catalog.registerProviderProduct(geminiProviderProductInput());
  for (const capability of geminiCapabilityInputs({
    evidenceVersion,
    reference: `${GEMINI_PROVIDER_ID}-${GEMINI_PRODUCT_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  await catalog.registerProviderRightsVersion(
    geminiPlatformRightsInput(
      {
        rightsId: options.rightsId ?? GEMINI_DEFAULT_RIGHTS_ID,
        approvalReference: 'token-resale-plan-phase-f4',
        evidenceReference: `${GEMINI_PROVIDER_ID}-${GEMINI_PRODUCT_ID}-rights-preset`,
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
}

/**
 * Placeholder pricing (mirrors the codex/claude Phase 1.6 placeholder): the
 * Gemini CLI subscription upstream has no per-token supplier cost, so the
 * supplier cost version 1 registers zero rates by design. Customer-facing
 * prices are a business decision and are NOT registered here — the operator
 * registers them through the platform console with the same identity keys.
 */
export const GEMINI_PLACEHOLDER_PRICING_VERSION = 1;

export function geminiPlaceholderSupplierCostInputs(
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
    protocol: GEMINI_PROTOCOL,
    endpoint: GEMINI_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${GEMINI_PROVIDER_ID}-supplier-cost-v${GEMINI_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'gemini-placeholder-commercial-v1',
    calculatorVersion: 'gemini-placeholder-calculator-v1',
    roundingVersion: 'gemini-placeholder-rounding-v1',
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
export async function registerGeminiPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof geminiPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of geminiPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}

/**
 * F4 modelMap normalization: public-model alias inputs for a Gemini model
 * list (default: the placeholder catalog). Each provider model gets one
 * namespaced alias `gemini/<model>` — the prefix `normalizeGeminiModelId`
 * strips — so clients may request either the namespaced alias or (with a
 * bare-id alias the operator adds separately) the bare catalog id, and
 * `modelMap` resolution maps the public alias onto the provider model under
 * the `gemini-generate-content` endpoint scope.
 */
export function geminiPublicModelAliasInputs(
  models: readonly string[] = GEMINI_PLACEHOLDER_MODELS,
  options: { readonly displayNamePrefix?: string } = {},
): readonly RegisterPublicModelAliasInput[] {
  const seen = new Set<string>();
  const inputs: RegisterPublicModelAliasInput[] = [];
  for (const rawModel of models) {
    // Normalize first so a prefixed upstream id (gemini/gemini-2.5-pro) and
    // the bare catalog id collapse onto one provider model and one alias.
    const model = normalizeGeminiModelId(rawModel);
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    inputs.push({
      alias: `gemini/${model}`,
      displayName: `${options.displayNamePrefix ?? 'Gemini'} ${model}`,
      providerId: GEMINI_PROVIDER_ID,
      productId: GEMINI_PRODUCT_ID,
      model,
      endpointScope: [GEMINI_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per model (idempotent per alias identity). */
export async function registerGeminiPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  models?: readonly string[],
): Promise<void> {
  for (const input of geminiPublicModelAliasInputs(models)) {
    await catalog.registerPublicModelAlias(input);
  }
}
