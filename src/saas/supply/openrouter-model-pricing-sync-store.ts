/**
 * F6 service-backed default store for the OpenRouter model-pricing sync
 * worker (plan §R8a, task #39).
 *
 * This adapter deliberately contains NO raw SQL: every write and read goes
 * through the existing repository surface —
 * - `SaasCatalogService.registerProviderProduct / registerProviderCapability
 *   / registerProviderRightsVersion / registerPublicModelAlias` for catalog
 *   structure (the exact methods the platform console and the R5b-4
 *   opencode-go registration use);
 * - `SaasPricingService.appendSupplierCostVersion` for supplier cost rows —
 *   the existing append-only, advisory-lock-serialized supplier-cost write
 *   path (the platform console's supplier registration resolves through the
 *   same appendSupplier lineage);
 * - `SaasPricingService.listPlatformPricingTargets` (kind 'customer') as
 *   the read that tells the worker which openrouter models already resolve
 *   as alias + capability + rights pricing targets, and under which
 *   publicModelId / version.
 *
 * Duplicate product/alias registrations are tolerated (idempotent structure
 * seeding); everything else propagates so the worker's round fails closed.
 */

import { createHash } from 'node:crypto';
import { SaasCatalogError } from '../catalog/errors.js';
import {
  openRouterCapabilityInputs,
  openRouterPlatformRightsInput,
  openRouterProviderProductInput,
  openRouterPublicModelAliasInputs,
  openRouterRightsChunkId,
} from '../catalog/openrouter-registration.js';
import { SaasCatalogService } from '../catalog/service.js';
import type { SaasDatabase } from '../db/index.js';
import { OPENROUTER_PRODUCT_ID, OPENROUTER_PROVIDER_ID } from '../gateway/openrouter/catalog-identity.js';
import { SaasPricingService } from '../pricing/service.js';
import type { AppendSupplierCostVersionInput } from '../pricing/types.js';
import type {
  OpenRouterModelPricingSyncStore,
  OpenRouterModelPricingTarget,
} from './openrouter-model-pricing-sync-worker.js';

export const OPENROUTER_SYNC_EVIDENCE_VERSION = 'openrouter-f6-sync-v1';
export const OPENROUTER_SYNC_APPROVAL_REFERENCE = 'token-resale-plan-phase-r8a';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface OpenRouterModelPricingSyncStoreOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * Builds the default sync store over the shared database handle. The worker
 * loop this store backs must run under a role with INSERT privileges on the
 * provider catalog, public-model and supplier-cost tables: the restricted
 * credential-validation-worker role is SELECT-only on the catalog, so
 * deployments mount the loop (managed-saas.ts `openRouterModelPricingSync`)
 * only after granting those writes or wiring a store bound to a privileged
 * role.
 */
export function createOpenRouterModelPricingSyncStore(
  database: SaasDatabase,
  options: OpenRouterModelPricingSyncStoreOptions = {},
): OpenRouterModelPricingSyncStore {
  const catalog = new SaasCatalogService(database, options.now ? { now: options.now } : {});
  const pricing = new SaasPricingService(database, options.idFactory ? { idFactory: options.idFactory } : {});

  const tolerated = (error: unknown, code: 'PROVIDER_PRODUCT_EXISTS' | 'PUBLIC_MODEL_ALIAS_EXISTS'): boolean =>
    error instanceof SaasCatalogError && error.code === code;

  return {
    async ensureProduct(): Promise<void> {
      try {
        await catalog.registerProviderProduct(openRouterProviderProductInput());
      } catch (error) {
        if (tolerated(error, 'PROVIDER_PRODUCT_EXISTS')) return;
        throw error;
      }
    },

    async registerCapability(model: string): Promise<void> {
      const [input] = openRouterCapabilityInputs(
        {
          evidenceVersion: OPENROUTER_SYNC_EVIDENCE_VERSION,
          reference: `${OPENROUTER_PROVIDER_ID}-${OPENROUTER_PRODUCT_ID}-sync`,
          // Per-model content provenance: the capability row's evidence hash
          // is the digest of the exact upstream model id it was seeded from.
          sha256: sha256Hex(model),
        },
        [model],
      );
      if (input === undefined) throw new TypeError('openrouter capability input builder returned no row');
      await catalog.registerProviderCapability(input);
    },

    async registerRightsChunk(chunkIndex: number, models: readonly string[]): Promise<void> {
      await catalog.registerProviderRightsVersion(
        openRouterPlatformRightsInput(
          {
            rightsId: openRouterRightsChunkId(chunkIndex),
            approvalReference: OPENROUTER_SYNC_APPROVAL_REFERENCE,
            evidenceReference: `${OPENROUTER_PROVIDER_ID}-${OPENROUTER_PRODUCT_ID}-rights-sync`,
            // Chunk-content provenance: the digest of the exact model list.
            sha256: sha256Hex(models.join('\n')),
            effectiveAt: new Date(0).toISOString(),
          },
          models,
        ),
      );
    },

    async registerPublicAlias(
      model: string,
    ): Promise<{ readonly publicModelId: string; readonly publicModelVersion: number } | null> {
      const [input] = openRouterPublicModelAliasInputs([model]);
      if (input === undefined) throw new TypeError('openrouter alias input builder returned no row');
      try {
        const record = await catalog.registerPublicModelAlias(input);
        return { publicModelId: record.publicModelId, publicModelVersion: record.version };
      } catch (error) {
        // A pre-existing alias (operator-seeded, or a prior partial round)
        // conflicts on the alias unique key and the catalog service surfaces
        // that duplicate as PUBLIC_MODEL_ALIAS_EXISTS (the conflict mapping is
        // constraint-keyed and survives the shared query wrapper), so this
        // tolerance catches the spelled code.
        if (tolerated(error, 'PUBLIC_MODEL_ALIAS_EXISTS')) return null;
        throw error;
      }
    },

    async listProviderTargets(): Promise<readonly OpenRouterModelPricingTarget[]> {
      const targets: OpenRouterModelPricingTarget[] = [];
      let cursor: string | null = null;
      do {
        const page = await pricing.listPlatformPricingTargets({ kind: 'customer', limit: 100, cursor });
        for (const item of page.items) {
          if (item.providerId !== OPENROUTER_PROVIDER_ID) continue;
          targets.push({
            publicModelId: item.publicModelId,
            publicModelVersion: item.publicModelVersion,
            resolvedModel: item.resolvedModel,
            protocol: item.protocol,
            endpoint: item.endpoint,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return targets;
    },

    async appendSupplierCost(input: AppendSupplierCostVersionInput): Promise<{ readonly version: number }> {
      const record = await pricing.appendSupplierCostVersion(input);
      return { version: record.version };
    },
  };
}
