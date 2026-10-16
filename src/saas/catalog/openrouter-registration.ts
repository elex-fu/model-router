import {
  OPENROUTER_BASE_URL,
  OPENROUTER_CAPABILITY_PROTOCOL,
  OPENROUTER_CREDENTIAL_TYPE,
  OPENROUTER_DISPLAY_NAME,
  OPENROUTER_ENDPOINT,
  OPENROUTER_PRODUCT_ID,
  OPENROUTER_PROVIDER_ID,
  OPENROUTER_PURPOSE,
  OPENROUTER_REGION,
  OPENROUTER_SUPPLY_MODE,
} from '../gateway/openrouter/catalog-identity.js';
import { normalizeOpenRouterModelId, OPENROUTER_SEED_MODEL_IDS } from '../gateway/openrouter/model-catalog.js';
import type { SaasCatalogService } from './service.js';
import type {
  ProviderRightsAuditContext,
  RegisterProviderCapabilityInput,
  RegisterProviderProductInput,
  RegisterProviderRightsVersionInput,
  RegisterPublicModelAliasInput,
} from './types.js';

export {
  OPENROUTER_BASE_URL,
  OPENROUTER_CAPABILITY_PROTOCOL,
  OPENROUTER_CREDENTIAL_TYPE,
  OPENROUTER_DISPLAY_NAME,
  OPENROUTER_ENDPOINT,
  OPENROUTER_PRODUCT_ID,
  OPENROUTER_PROVIDER_ID,
  OPENROUTER_PURPOSE,
  OPENROUTER_REGION,
  OPENROUTER_SEED_MODEL_IDS,
  OPENROUTER_SUPPLY_MODE,
};

/**
 * F6 `openrouter` provider catalog registration (plan §R8a, task #39). The
 * catalog is database-backed and operator-driven: this module supplies the
 * canonical registration inputs (product, capabilities, platform rights,
 * public-model aliases) plus one-call appliers so the console, migrations
 * tooling, or tests register the exact same identity everywhere. It mirrors
 * opencode-go-registration.ts, differing where the OpenRouter supply shape
 * differs:
 *
 * - OpenRouter is a pay-as-you-go aggregation API, NOT a subscription
 *   category. There is therefore NO placeholder supplier-cost section here:
 *   subscription upstreams register explicit zero rates (opencode-go
 *   precedent) because their per-token supplier cost is structurally zero,
 *   while OpenRouter's supplier costs are real per-token dollar prices.
 *   They arrive exclusively through the pricing sync worker
 *   (supply/openrouter-model-pricing-sync-worker.ts), which fetches the
 *   public https://openrouter.ai/api/v1/models catalog and appends
 *   content-addressed versions into saas_supplier_cost_versions via
 *   SaasPricingService.appendSupplierCostVersion. This module seeds only
 *   capability/rights structure;
 * - every capability row carries the single native protocol `openai`
 *   (OpenAI Chat Completions) spelled as a GatewayProtocol — the exact
 *   value the production authority adapter compares against the route's
 *   client protocol. OpenRouter is a zero-bridge upstream for
 *   openai-protocol clients; the supply-validation vocabulary
 *   (`openai-compatible`) never appears on catalog capability rows;
 * - OpenRouter's normalized usage object is OpenAI-standard
 *   {prompt_tokens, completion_tokens, total_tokens} on the Chat
 *   Completions native, so the generic provider JSON/SSE usage observers
 *   parse it unchanged: no per-provider usage variant exists or is needed
 *   (gateway/provider-json-usage-observer.ts keys on
 *   providerProtocol+providerOperation, never on provider id).
 *
 * Scheduling note (R7): OpenRouter accounts are metered, so their supplier
 * cost rows carry real prices and the cost-priority strategy naturally
 * ranks subscription pools (zero-cost supplier rates) ahead of them. No
 * scheduler wiring belongs to this provider; the parallel R7 task owns the
 * strategy.
 *
 * Identity contract (all sites must agree):
 * - provider `openrouter`, product `openrouter-api`, credential type
 *   `api-key`, supply mode `platform`, region `global`, purpose `inference`;
 * - endpoint scope `openrouter-api` for every catalog row;
 * - the upstream host is pinned to https://openrouter.ai/api/v1
 *   (OPENROUTER_BASE_URL in gateway/openrouter/catalog-identity.ts).
 */

/**
 * The catalog service's provider-rights model_scope column accepts at most
 * 100 values per rights version (MAX_SCOPE_VALUES). OpenRouter's live
 * catalog exceeds that, so the sync worker shards the synced model list
 * into deterministic chunks of this size, each under its own chunk-stable
 * rights id.
 */
export const OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE = 100;

export function openRouterProviderProductInput(): RegisterProviderProductInput {
  return {
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    displayName: OPENROUTER_DISPLAY_NAME,
    status: 'active',
  };
}

export function openRouterCapabilityInputs(
  evidence: {
    readonly evidenceVersion: string;
    readonly reference: string;
    readonly sha256: string;
  },
  models: readonly string[] = OPENROUTER_SEED_MODEL_IDS,
): readonly RegisterProviderCapabilityInput[] {
  return models.map((model) => ({
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    model,
    endpoint: OPENROUTER_ENDPOINT,
    // Zero-bridge: the single native protocol as a GatewayProtocol, so the
    // authority's capability/client-protocol equality check passes for
    // openai-protocol clients exactly.
    protocol: OPENROUTER_CAPABILITY_PROTOCOL,
    supportLevel: 'supported' as const,
    validationState: 'verified' as const,
    evidenceVersion: evidence.evidenceVersion,
    discoverySource: 'preset' as const,
    evidenceReference: evidence.reference,
    evidenceSha256: evidence.sha256,
  }));
}

export function openRouterPlatformRightsInput(
  evidence: {
    readonly rightsId: string;
    readonly approvalReference: string;
    readonly evidenceReference: string;
    readonly sha256: string;
    readonly effectiveAt: string;
  },
  models: readonly string[] = OPENROUTER_SEED_MODEL_IDS,
  audit?: ProviderRightsAuditContext,
): RegisterProviderRightsVersionInput {
  return {
    rightsId: evidence.rightsId,
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    credentialType: OPENROUTER_CREDENTIAL_TYPE,
    supplyMode: OPENROUTER_SUPPLY_MODE,
    region: OPENROUTER_REGION,
    purpose: OPENROUTER_PURPOSE,
    modelScope: [...models],
    endpointScope: [OPENROUTER_ENDPOINT],
    effectiveAt: evidence.effectiveAt,
    status: 'active',
    approvalReference: evidence.approvalReference,
    evidenceReference: evidence.evidenceReference,
    evidenceSha256: evidence.sha256,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** Stable default rights id; operators may pass their own. */
export const OPENROUTER_DEFAULT_RIGHTS_ID = 'openrouter-api-platform-v1';

/**
 * Deterministic rights id for one model-scope chunk (see
 * OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE). Chunk membership is derived from the
 * sorted model list, so the id is stable across rounds for the same chunk
 * index even when membership shifts. Chunk 0 deliberately keeps the plain
 * OPENROUTER_DEFAULT_RIGHTS_ID so seed-size registrations and the sync
 * worker's first chunk share one identity.
 */
export function openRouterRightsChunkId(chunkIndex: number): string {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new TypeError('openRouterRightsChunkId requires a non-negative chunk index');
  }
  return chunkIndex === 0
    ? OPENROUTER_DEFAULT_RIGHTS_ID
    : `${OPENROUTER_DEFAULT_RIGHTS_ID}-c${String(chunkIndex).padStart(2, '0')}`;
}

/**
 * Shards a model list into deterministic chunks of at most
 * OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE models (input order preserved; callers
 * pass the sorted synced list so chunk membership is stable).
 */
export function chunkOpenRouterRightsScope(models: readonly string[]): readonly (readonly string[])[] {
  if (models.length === 0) return [];
  const chunks: (readonly string[])[] = [];
  for (let index = 0; index < models.length; index += OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE) {
    chunks.push(models.slice(index, index + OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Registers product, capabilities and one platform-rights version in one
 * call (idempotent per catalog versioning). When the model list exceeds one
 * chunk, the rights scope is sharded into chunk-stable rights ids; the
 * plain OPENROUTER_DEFAULT_RIGHTS_ID covers the first chunk so seed-size
 * registrations match the single-rights shape.
 */
export async function registerOpenRouterProviderCatalog(
  catalog: Pick<
    SaasCatalogService,
    'registerProviderProduct' | 'registerProviderCapability' | 'registerProviderRightsVersion'
  >,
  options: {
    readonly evidenceVersion?: string;
    readonly effectiveAt?: string;
    readonly sha256?: string;
    readonly audit?: ProviderRightsAuditContext;
    readonly models?: readonly string[];
  } = {},
): Promise<void> {
  const evidenceVersion = options.evidenceVersion ?? 'openrouter-f6-catalog-v1';
  const effectiveAt = options.effectiveAt ?? new Date(0).toISOString();
  const sha256 = options.sha256 ?? '6'.repeat(64);
  const models = options.models ?? OPENROUTER_SEED_MODEL_IDS;
  await catalog.registerProviderProduct(openRouterProviderProductInput());
  for (const capability of openRouterCapabilityInputs(
    { evidenceVersion, reference: `${OPENROUTER_PROVIDER_ID}-${OPENROUTER_PRODUCT_ID}-preset`, sha256 },
    models,
  )) {
    await catalog.registerProviderCapability(capability);
  }
  for (const [chunkIndex, chunk] of chunkOpenRouterRightsScope(models).entries()) {
    await catalog.registerProviderRightsVersion(
      openRouterPlatformRightsInput(
        {
          rightsId: openRouterRightsChunkId(chunkIndex),
          approvalReference: 'token-resale-plan-phase-r8a',
          evidenceReference: `${OPENROUTER_PROVIDER_ID}-${OPENROUTER_PRODUCT_ID}-rights-preset`,
          sha256,
          effectiveAt,
        },
        chunk,
        options.audit,
      ),
    );
  }
}

/**
 * F6 modelMap normalization: public-model alias inputs for an OpenRouter
 * model list (default: the built-in seed catalog; pass the synced upstream
 * list from the pricing sync worker when fresh). Each provider model gets
 * one namespaced alias `openrouter/<model>` — the exact prefix
 * normalizeOpenRouterModelId strips — so clients may request either the
 * namespaced alias or the bare catalog id, and `modelMap` resolution maps
 * the public alias onto the provider model under the `openrouter-api`
 * endpoint scope.
 */
export function openRouterPublicModelAliasInputs(
  models: readonly string[] = OPENROUTER_SEED_MODEL_IDS,
  options: { readonly displayNamePrefix?: string } = {},
): readonly RegisterPublicModelAliasInput[] {
  const seen = new Set<string>();
  const inputs: RegisterPublicModelAliasInput[] = [];
  for (const rawModel of models) {
    // Normalize first so a prefixed upstream id (openrouter/openai/gpt-4o)
    // and the bare catalog id collapse onto one provider model and one alias.
    const model = normalizeOpenRouterModelId(rawModel);
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    inputs.push({
      alias: `openrouter/${model}`,
      displayName: `${options.displayNamePrefix ?? 'OpenRouter'} ${model}`,
      providerId: OPENROUTER_PROVIDER_ID,
      productId: OPENROUTER_PRODUCT_ID,
      model,
      endpointScope: [OPENROUTER_ENDPOINT],
      status: 'active',
    });
  }
  return inputs;
}

/** Registers one public-model alias per model (idempotent per alias identity). */
export async function registerOpenRouterPublicModelAliases(
  catalog: Pick<SaasCatalogService, 'registerPublicModelAlias'>,
  models?: readonly string[],
): Promise<void> {
  for (const input of openRouterPublicModelAliasInputs(models)) {
    await catalog.registerPublicModelAlias(input);
  }
}
