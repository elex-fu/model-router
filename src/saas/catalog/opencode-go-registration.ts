import {
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROTOCOL,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PURPOSE,
  OPENCODE_GO_REGION,
  OPENCODE_GO_SUPPLY_MODE,
} from '../gateway/opencode-go/catalog-identity.js';
import { OPENCODE_GO_FALLBACK_MODEL_IDS, OPENCODE_GO_TEST_MODEL } from '../gateway/opencode-go/model-catalog.js';
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
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_FALLBACK_MODEL_IDS,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROTOCOL,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PURPOSE,
  OPENCODE_GO_REGION,
  OPENCODE_GO_SUPPLY_MODE,
  OPENCODE_GO_TEST_MODEL,
};

/**
 * R5b `opencode-go` provider catalog registration (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #21). The
 * catalog is database-backed and operator-driven: this module supplies the
 * canonical registration inputs (product, capabilities, platform rights,
 * placeholder pricing) plus one-call appliers so the console, migrations
 * tooling, or tests register the exact same identity everywhere. It mirrors
 * codex-registration.ts, differing only where the OpenCode Go supply shape
 * differs: a platform-pool API key (existing sealed envelope, no OAuth
 * binding surface) instead of an OAuth credential.
 *
 * Identity contract (all sites must agree):
 * - provider `opencode-go`, product `opencode-go-zen`, credential type
 *   `api-key`, supply mode `platform`, region `global`, purpose `inference`;
 * - protocol `openai-compatible`, endpoint scope `opencode-go-zen` for the
 *   R5b-1 rows (the pool's default and test traffic is Chat Completions);
 *   R5b-2's per-model protocol routing keeps this provider/product/
 *   credential triple stable while re-deriving the upstream protocol per
 *   request;
 * - the upstream host is pinned to https://opencode.ai/zen/go
 *   (OPENCODE_GO_BASE_URL in gateway/opencode-go/catalog-identity.ts).
 */

export function opencodeGoProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    status: 'active',
  };
}

export function opencodeGoCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  return OPENCODE_GO_FALLBACK_MODEL_IDS.map((model) => ({
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    model,
    endpoint: OPENCODE_GO_ENDPOINT,
    protocol: OPENCODE_GO_PROTOCOL,
    supportLevel: 'supported' as const,
    validationState: 'verified' as const,
    evidenceVersion: evidence.evidenceVersion,
    discoverySource: 'preset' as const,
    evidenceReference: evidence.reference,
    evidenceSha256: evidence.sha256,
  }));
}

export function opencodeGoPlatformRightsInput(
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
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    credentialType: OPENCODE_GO_CREDENTIAL_TYPE,
    supplyMode: OPENCODE_GO_SUPPLY_MODE,
    region: OPENCODE_GO_REGION,
    purpose: OPENCODE_GO_PURPOSE,
    modelScope: [...OPENCODE_GO_FALLBACK_MODEL_IDS],
    endpointScope: [OPENCODE_GO_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights id; operators may pass their own to `registerOpencodeGoProviderCatalog`. */
export const OPENCODE_GO_DEFAULT_RIGHTS_ID = 'opencode-go-zen-platform-api-key-v1';

/** Registers product, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerOpencodeGoProviderCatalog(
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
  const evidenceVersion = options.evidenceVersion ?? 'opencode-go-r5b-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? '9'.repeat(64);
  await catalog.registerProviderProduct(opencodeGoProviderProductInput());
  for (const capability of opencodeGoCapabilityInputs({
    evidenceVersion,
    reference: `${OPENCODE_GO_PROVIDER_ID}-${OPENCODE_GO_PRODUCT_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  await catalog.registerProviderRightsVersion(
    opencodeGoPlatformRightsInput(
      {
        rightsId: options.rightsId ?? OPENCODE_GO_DEFAULT_RIGHTS_ID,
        approvalReference: 'token-resale-plan-phase-r5b',
        evidenceReference: `${OPENCODE_GO_PROVIDER_ID}-${OPENCODE_GO_PRODUCT_ID}-rights-preset`,
        sha256,
        effectiveAt,
      },
      options.audit,
    ),
  );
}

/**
 * Placeholder pricing (mirrors the codex Phase 1.6 placeholder): the OpenCode
 * Zen/Go subscription upstream has no per-token supplier cost, so the supplier
 * cost version 1 registers zero rates by design. Customer-facing prices are a
 * business decision and are NOT registered here — the operator registers them
 * through the platform console with the same identity keys.
 */
export const OPENCODE_GO_PLACEHOLDER_PRICING_VERSION = 1;

export function opencodeGoPlaceholderSupplierCostInputs(
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
    protocol: OPENCODE_GO_PROTOCOL,
    endpoint: OPENCODE_GO_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${OPENCODE_GO_PROVIDER_ID}-supplier-cost-v${OPENCODE_GO_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'opencode-go-placeholder-commercial-v1',
    calculatorVersion: 'opencode-go-placeholder-calculator-v1',
    roundingVersion: 'opencode-go-placeholder-rounding-v1',
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
export async function registerOpencodeGoPlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof opencodeGoPlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of opencodeGoPlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}
