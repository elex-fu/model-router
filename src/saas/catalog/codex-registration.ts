import {
  CODEX_CREDENTIAL_TYPE,
  CODEX_DISPLAY_NAME,
  CODEX_ENDPOINT,
  CODEX_PLACEHOLDER_MODELS,
  CODEX_PRODUCT_ID,
  CODEX_PROTOCOL,
  CODEX_PROVIDER_ID,
  CODEX_PURPOSE,
  CODEX_REGION,
  CODEX_SUPPLY_MODE,
} from '../gateway/codex/catalog-identity.js';
import type { SaasPricingService } from '../pricing/service.js';
import type { PlatformPriceAuditContext, RegisterPlatformPriceVersionInput } from '../pricing/types.js';
import type { SaasCatalogService } from './service.js';
import type {
  ProviderRightsAuditContext,
  RegisterProviderCapabilityInput,
  RegisterProviderProductInput,
  RegisterProviderRightsVersionInput,
} from './types.js';

export {
  CODEX_CREDENTIAL_TYPE,
  CODEX_DISPLAY_NAME,
  CODEX_ENDPOINT,
  CODEX_PLACEHOLDER_MODELS,
  CODEX_PRODUCT_ID,
  CODEX_PROTOCOL,
  CODEX_PROVIDER_ID,
  CODEX_PURPOSE,
  CODEX_REGION,
  CODEX_SUPPLY_MODE,
};

/**
 * P1c `openai-codex` provider catalog registration (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.1/1.6). The catalog
 * is database-backed and operator-driven: this module supplies the canonical
 * registration inputs (product, capabilities, platform rights, placeholder
 * pricing) plus one-call appliers so the console, migrations tooling, or
 * tests register the exact same identity everywhere.
 *
 * Identity contract (all sites must agree):
 * - provider `openai-codex`, product `codex-chatgpt`, credential type
 *   `oauth`, supply mode `platform`, region `global`, purpose `inference`;
 * - protocol `responses`, endpoint scope `codex-responses`;
 * - the R4 refresh worker binds this same triple (its
 *   `openai-codex-oauth-v2` adapter) so platform accounts created against
 *   these rights are refreshed automatically.
 */

export function codexProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    displayName: CODEX_DISPLAY_NAME,
    status: 'active',
  };
}

export function codexCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  return CODEX_PLACEHOLDER_MODELS.map((model) => ({
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    model,
    endpoint: CODEX_ENDPOINT,
    protocol: CODEX_PROTOCOL,
    supportLevel: 'supported' as const,
    validationState: 'verified' as const,
    evidenceVersion: evidence.evidenceVersion,
    discoverySource: 'preset' as const,
    evidenceReference: evidence.reference,
    evidenceSha256: evidence.sha256,
  }));
}

export function codexPlatformRightsInput(
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
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    credentialType: CODEX_CREDENTIAL_TYPE,
    supplyMode: CODEX_SUPPLY_MODE,
    region: CODEX_REGION,
    purpose: CODEX_PURPOSE,
    modelScope: [...CODEX_PLACEHOLDER_MODELS],
    endpointScope: [CODEX_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights id; operators may pass their own to `registerCodexProviderCatalog`. */
export const CODEX_DEFAULT_RIGHTS_ID = 'codex-chatgpt-platform-oauth-v1';

/** Registers product, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerCodexProviderCatalog(
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
  const evidenceVersion = options.evidenceVersion ?? 'codex-p1c-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? 'c'.repeat(64);
  await catalog.registerProviderProduct(codexProviderProductInput());
  for (const capability of codexCapabilityInputs({
    evidenceVersion,
    reference: `${CODEX_PROVIDER_ID}-${CODEX_PRODUCT_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  await catalog.registerProviderRightsVersion(
    codexPlatformRightsInput(
      {
        rightsId: options.rightsId ?? CODEX_DEFAULT_RIGHTS_ID,
        approvalReference: 'sub2api-parity-plan-phase-1',
        evidenceReference: `${CODEX_PROVIDER_ID}-${CODEX_PRODUCT_ID}-rights-preset`,
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
}

/**
 * Placeholder pricing (Phase 1.6): the ChatGPT subscription upstream has no
 * per-token supplier cost, so the supplier cost version 1 registers zero
 * rates by design. Customer-facing prices are a business decision and are
 * NOT registered here — the operator registers them through the platform
 * console with the same identity keys.
 */
export const CODEX_PLACEHOLDER_PRICING_VERSION = 1;

export function codexPlaceholderSupplierCostInputs(
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
    protocol: CODEX_PROTOCOL,
    endpoint: CODEX_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${CODEX_PROVIDER_ID}-supplier-cost-v${CODEX_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'codex-placeholder-commercial-v1',
    calculatorVersion: 'codex-placeholder-calculator-v1',
    roundingVersion: 'codex-placeholder-rounding-v1',
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
export async function registerCodexPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof codexPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of codexPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}
