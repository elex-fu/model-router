import {
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PURPOSE,
  OPENCODE_GO_REGION,
  OPENCODE_GO_SUPPLY_MODE,
} from '../gateway/opencode-go/catalog-identity.js';
import {
  normalizeOpenCodeGoModelId,
  OPENCODE_GO_FALLBACK_MODEL_IDS,
  OPENCODE_GO_TEST_MODEL,
} from '../gateway/opencode-go/model-catalog.js';
import {
  DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  type OpenCodeGoNativeProtocol,
  type OpenCodeGoProtocolRule,
  resolveOpenCodeGoProtocol,
} from '../gateway/opencode-go/protocol-rules.js';
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
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_FALLBACK_MODEL_IDS,
  OPENCODE_GO_PRODUCT_ID,
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
 * - endpoint scope `opencode-go-zen` for every catalog row;
 * - R5b-4 capability protocol alignment: each capability row's `protocol` is
 *   the model's rule-resolved native protocol spelled as a `GatewayProtocol`
 *   (`responses` | `openai` | `anthropic`) — the exact value the production
 *   authority adapter compares against the route's client protocol
 *   (postgres-request-preparation-authority-adapter.ts
 *   `eligibility.capability.protocol !== input.protocol`, and the preparation
 *   service's SUPPORTED_PROTOCOLS gate). The supply-validation vocabulary
 *   (`openai-compatible`) never appears on catalog capability rows; it is
 *   reserved for the credential-validation adapter registry. A model is
 *   therefore servable exactly under the client protocol its rule-table
 *   protocol resolves to (same-protocol passthrough bridges only); the
 *   compile layer additionally fails closed when a `responses`-routed model
 *   is requested through any other client protocol (R5b-2 gap 3);
 * - the upstream host is pinned to https://opencode.ai/zen/go
 *   (OPENCODE_GO_BASE_URL in gateway/opencode-go/catalog-identity.ts).
 */

/**
 * The capability protocol one model registers under: its rule-table-resolved
 * native protocol as a GatewayProtocol. Registering under the resolved
 * protocol (rather than a single fixed value) keeps the authority's
 * `capability.protocol === client protocol` check meaningful for all three
 * native protocols while never advertising a bridge the generic compiler
 * cannot honor.
 */
export function opencodeGoCapabilityProtocolForModel(
  model: string,
  rules: readonly OpenCodeGoProtocolRule[] = DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
): OpenCodeGoNativeProtocol {
  return resolveOpenCodeGoProtocol(rules, model);
}

export function opencodeGoProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    status: 'active',
  };
}

export function opencodeGoCapabilityInputs(
  evidence: {
    readonly evidenceVersion: string;
    readonly reference: string;
    readonly sha256: string;
  },
  rules: readonly OpenCodeGoProtocolRule[] = DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
): readonly RegisterProviderCapabilityInput[] {
  return OPENCODE_GO_FALLBACK_MODEL_IDS.map((model) => ({
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    model,
    endpoint: OPENCODE_GO_ENDPOINT,
    // R5b-4 alignment: the rule-resolved native protocol as a GatewayProtocol,
    // so the authority's capability/client-protocol equality check passes for
    // every protocol the rule table can route the model to.
    protocol: opencodeGoCapabilityProtocolForModel(model, rules),
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
    /**
     * Rule table the capability protocols are derived from. Defaults to the
     * built-in table; pass the deployment's configured table (the
     * migration-108 `protocol_rules` JSONB column value) so the registered
     * capability protocols track the protocols dispatch will actually route
     * to.
     */
    readonly rules?: readonly OpenCodeGoProtocolRule[];
  } = {},
): Promise<void> {
  const evidenceVersion = options.evidenceVersion ?? 'opencode-go-r5b-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? '9'.repeat(64);
  const rules = options.rules ?? DEFAULT_OPENCODE_GO_PROTOCOL_RULES;
  await catalog.registerProviderProduct(opencodeGoProviderProductInput());
  for (const capability of opencodeGoCapabilityInputs(
    {
      evidenceVersion,
      reference: `${OPENCODE_GO_PROVIDER_ID}-${OPENCODE_GO_PRODUCT_ID}-preset`,
      sha256,
    },
    rules,
  )) {
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

/**
 * Default placeholder supplier-cost protocol: Chat Completions (the fallback
 * routed protocol and the protocol of `OPENCODE_GO_TEST_MODEL`). A public
 * model backed by a Responses- or Anthropic-routed provider model must pass
 * that model's capability protocol instead — price resolution joins on
 * `capability.protocol` and the settlement path compares the request's client
 * protocol, which the R5b-4 capability alignment keeps equal to the routed
 * protocol.
 */
export const OPENCODE_GO_PLACEHOLDER_PRICING_PROTOCOL = 'openai' as const;

export function opencodeGoPlaceholderSupplierCostInputs(
  audit: PlatformPriceAuditContext,
  options: {
    readonly publicModelIds: readonly {
      readonly publicModelId: string;
      readonly publicModelVersion: number;
      /** The backing provider model's capability protocol; defaults to 'openai'. */
      readonly protocol?: OpenCodeGoNativeProtocol;
    }[];
    readonly effectiveAt?: string;
  } = { publicModelIds: [] },
): readonly RegisterPlatformPriceVersionInput[] {
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  return options.publicModelIds.map(({ publicModelId, publicModelVersion, protocol }) => ({
    publicModelId,
    publicModelVersion,
    protocol: protocol ?? OPENCODE_GO_PLACEHOLDER_PRICING_PROTOCOL,
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

/**
 * R5b-4 modelMap normalization: public-model alias inputs for an OpenCode Go
 * model list (default: the built-in fallback catalog; pass the synced
 * upstream list from gateway/opencode-go/model-catalog-sync.ts when fresh).
 * Each provider model gets one namespaced alias `opencode-go/<model>` — the
 * exact prefix `normalizeOpenCodeGoModelId` strips — so clients may request
 * either the namespaced alias or (with a bare-id alias the operator adds
 * separately) the bare catalog id, and `modelMap` resolution maps the public
 * alias onto the provider model under the `opencode-go-zen` endpoint scope.
 */
export function opencodeGoPublicModelAliasInputs(
  models: readonly string[] = OPENCODE_GO_FALLBACK_MODEL_IDS,
  options: { readonly displayNamePrefix?: string } = {},
): readonly RegisterPublicModelAliasInput[] {
  const seen = new Set<string>();
  const inputs: RegisterPublicModelAliasInput[] = [];
  for (const rawModel of models) {
    // Normalize first so a prefixed upstream id (opencode-go/glm-5.3) and the
    // bare catalog id collapse onto one provider model and one alias.
    const model = normalizeOpenCodeGoModelId(rawModel);
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    inputs.push({
      alias: `opencode-go/${model}`,
      displayName: `${options.displayNamePrefix ?? 'OpenCode Go'} ${model}`,
      providerId: OPENCODE_GO_PROVIDER_ID,
      productId: OPENCODE_GO_PRODUCT_ID,
      model,
      endpointScope: [OPENCODE_GO_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per model (idempotent per alias identity). */
export async function registerOpencodeGoPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  models?: readonly string[],
): Promise<void> {
  for (const input of opencodeGoPublicModelAliasInputs(models)) {
    await catalog.registerPublicModelAlias(input);
  }
}
