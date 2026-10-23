import {
  CLAUDE_CREDENTIAL_TYPE,
  CLAUDE_DISPLAY_NAME,
  CLAUDE_ENDPOINT,
  CLAUDE_PLACEHOLDER_MODELS,
  CLAUDE_PRODUCT_ID,
  CLAUDE_PROTOCOL,
  CLAUDE_PROVIDER_ID,
  CLAUDE_PURPOSE,
  CLAUDE_REGION,
  CLAUDE_SUPPLY_MODE,
} from '../gateway/claude/catalog-identity.js';
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
  CLAUDE_CREDENTIAL_TYPE,
  CLAUDE_DISPLAY_NAME,
  CLAUDE_ENDPOINT,
  CLAUDE_PLACEHOLDER_MODELS,
  CLAUDE_PRODUCT_ID,
  CLAUDE_PROTOCOL,
  CLAUDE_PROVIDER_ID,
  CLAUDE_PURPOSE,
  CLAUDE_REGION,
  CLAUDE_SUPPLY_MODE,
};

/**
 * R5 `anthropic-claude` provider catalog registration (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Mirrors
 * codex-registration.ts / gemini-registration.ts, differing only where the
 * Claude supply shape differs: a single OAuth subscription product bound
 * through the Claude Code OAuth flow (platform/claude-oauth) — unlike grok
 * there is no api-key sibling product, so every input list carries exactly
 * one entry.
 *
 * Identity contract (all sites must agree):
 * - provider `anthropic-claude`, product `claude-subscription`, credential
 *   type `oauth`, supply mode `platform`, region `global`, purpose
 *   `inference`;
 * - protocol `anthropic` (the native /v1/messages client protocol; proxy.ts
 *   routes /v1/messages onto it and the OAuth probe adapter's
 *   capability/client-protocol equality check passes only under it),
 *   endpoint scope `claude-messages`;
 * - the credential sink (platform/claude-oauth/supply-sink.ts) resolves this
 *   same binding from the control-plane database and fails closed until it
 *   is registered here, so the OAuth import → pending account → automatic
 *   validation chain stays unavailable without this registration;
 * - the upstream host is pinned to https://api.anthropic.com/v1/messages
 *   (CLAUDE_MESSAGES_ENDPOINT in gateway/claude/catalog-identity.ts).
 */

export function claudeProviderProductInputs(): readonly RegisterProviderProductInput[] {
  return [
    {
      providerId: CLAUDE_PROVIDER_ID,
      productId: CLAUDE_PRODUCT_ID,
      displayName: CLAUDE_DISPLAY_NAME,
      status: 'active',
    },
  ];
}

export function claudeCapabilityInputs(evidence: {
  readonly evidenceVersion: string;
  readonly reference: string;
  readonly sha256: string;
}): readonly RegisterProviderCapabilityInput[] {
  return CLAUDE_PLACEHOLDER_MODELS.map((model) => ({
    providerId: CLAUDE_PROVIDER_ID,
    productId: CLAUDE_PRODUCT_ID,
    model,
    endpoint: CLAUDE_ENDPOINT,
    protocol: CLAUDE_PROTOCOL,
    supportLevel: 'supported' as const,
    validationState: 'verified' as const,
    evidenceVersion: evidence.evidenceVersion,
    discoverySource: 'preset' as const,
    evidenceReference: evidence.reference,
    evidenceSha256: evidence.sha256,
  }));
}

export function claudePlatformRightsInputs(
  evidence: {
    readonly rightsId: string;
    readonly approvalReference: string;
    readonly evidenceReference: string;
    readonly sha256: string;
    readonly effectiveAt: string;
  },
  audit?: ProviderRightsAuditContext,
): readonly RegisterProviderRightsVersionInput[] {
  return [
    {
      rightsId: evidence.rightsId,
      providerId: CLAUDE_PROVIDER_ID,
      productId: CLAUDE_PRODUCT_ID,
      credentialType: CLAUDE_CREDENTIAL_TYPE,
      supplyMode: CLAUDE_SUPPLY_MODE,
      region: CLAUDE_REGION,
      purpose: CLAUDE_PURPOSE,
      modelScope: [...CLAUDE_PLACEHOLDER_MODELS],
      endpointScope: [CLAUDE_ENDPOINT],
      effectiveAt: evidence.effectiveAt,
      status: 'active',
      approvalReference: evidence.approvalReference,
      evidenceReference: evidence.evidenceReference,
      evidenceSha256: evidence.sha256,
      ...(audit === undefined ? {} : { audit }),
    },
  ];
}

/** Stable default rights id; operators may pass their own to `registerClaudeProviderCatalog`. */
export const CLAUDE_DEFAULT_RIGHTS_ID = 'claude-subscription-platform-oauth-v1';

/** Registers product, capabilities and platform rights in one call (idempotent per catalog versioning). */
export async function registerClaudeProviderCatalog(
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
  const evidenceVersion = options.evidenceVersion ?? 'claude-r5-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? 'd'.repeat(64);
  for (const product of claudeProviderProductInputs()) {
    await catalog.registerProviderProduct(product);
  }
  for (const capability of claudeCapabilityInputs({
    evidenceVersion,
    reference: `${CLAUDE_PROVIDER_ID}-${CLAUDE_PRODUCT_ID}-preset`,
    sha256,
  })) {
    await catalog.registerProviderCapability(capability);
  }
  for (const input of claudePlatformRightsInputs(
    {
      rightsId: options.rightsId ?? CLAUDE_DEFAULT_RIGHTS_ID,
      approvalReference: 'token-resale-plan-phase-r5',
      evidenceReference: `${CLAUDE_PROVIDER_ID}-${CLAUDE_PRODUCT_ID}-rights-preset`,
      sha256,
      effectiveAt,
    },
    options.audit,
  )) {
    await catalog.registerProviderRightsVersion(input);
  }
}

/**
 * Placeholder pricing (mirrors the codex/gemini Phase 1.6 placeholder): the
 * Claude Code subscription upstream has no per-token supplier cost, so the
 * supplier cost version 1 registers zero rates by design. Customer-facing
 * prices are a business decision and are NOT registered here — the operator
 * registers them through the platform console with the same identity keys.
 */
export const CLAUDE_PLACEHOLDER_PRICING_VERSION = 1;

export function claudePlaceholderSupplierCostInputs(
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
    protocol: CLAUDE_PROTOCOL,
    endpoint: CLAUDE_ENDPOINT,
    currency: 'USD',
    idempotencyKey: `${CLAUDE_PROVIDER_ID}-supplier-cost-v${CLAUDE_PLACEHOLDER_PRICING_VERSION}-${publicModelId}`,
    effectiveAt,
    commercialPolicyVersion: 'claude-placeholder-commercial-v1',
    calculatorVersion: 'claude-placeholder-calculator-v1',
    roundingVersion: 'claude-placeholder-rounding-v1',
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
export async function registerClaudePlaceholderSupplierCosts(
  pricing: Pick<SaasPricingService, 'registerPlatformSupplierCostVersion'>,
  audit: PlatformPriceAuditContext,
  options: Parameters<typeof claudePlaceholderSupplierCostInputs>[1],
): Promise<void> {
  for (const input of claudePlaceholderSupplierCostInputs(audit, options)) {
    await pricing.registerPlatformSupplierCostVersion(input);
  }
}
