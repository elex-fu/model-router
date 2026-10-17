import {
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
  VERTEX_PURPOSE,
  VERTEX_REGION,
} from '../../gateway/vertex/catalog-identity.js';
import type {
  PlatformProviderAccountCreateInput,
  PlatformProviderCredentialCreateInput,
} from '../../supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCapabilityReference,
  ProviderCredentialWriteResult,
} from '../../supply/types.js';
import type { VertexSaImport } from './import.js';
import { buildVertexSaEnvelopeMaterial } from './service-account.js';

/**
 * Batch-3 Vertex credential sink (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA): the
 * production persistence seam behind the service-account import, following
 * the gemini supply-sink contract. An imported service-account key becomes
 * one platform provider account plus one sealed credential, both through
 * the supply service's audited creation paths — the sink never touches the
 * credential tables directly and never logs key material.
 */

/** Minimal structural view of the supply service the sink needs. */
export interface VertexSinkSupplyService {
  createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord>;
  createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult>;
}

/** The catalog binding a platform vertex account must reference. */
export interface VertexPlatformCatalogBinding {
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
}

export type VertexPlatformCatalogBindingResolver = () => Promise<VertexPlatformCatalogBinding>;

export class VertexCredentialSinkError extends Error {
  constructor(readonly code: 'CATALOG_BINDING_MISSING' | 'SUPPLY_WRITE_FAILED') {
    super(
      code === 'CATALOG_BINDING_MISSING'
        ? 'The vertex platform catalog binding is not registered'
        : 'The vertex credential could not be persisted',
    );
    this.name = 'VertexCredentialSinkError';
  }
}

interface VertexSinkQueryExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number;
  }>;
}

/**
 * Resolves the platform vertex catalog binding (latest active platform
 * rights plus the verified capabilities) straight from the control-plane
 * database. Fails closed when the registration is missing: an unregistered
 * provider must never receive credentials.
 */
export function createPostgresVertexCatalogBindingResolver(
  database: VertexSinkQueryExecutor,
): VertexPlatformCatalogBindingResolver {
  return async () => {
    const rights = await database.query<{ readonly rights_id: unknown; readonly version: unknown }>(
      `SELECT rights_id, version
         FROM saas_provider_rights
        WHERE provider_id = $1 AND product_id = $2 AND credential_type = $3
          AND supply_mode = 'platform' AND region = $4 AND purpose = $5
          AND status = 'active'
          AND effective_at <= clock_timestamp()
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
        ORDER BY version DESC
        LIMIT 1`,
      [VERTEX_PROVIDER_ID, VERTEX_PRODUCT_ID, VERTEX_CREDENTIAL_TYPE, VERTEX_REGION, VERTEX_PURPOSE],
    );
    const right = rights.rows[0];
    if (
      rights.rowCount !== 1 ||
      !right ||
      typeof right.rights_id !== 'string' ||
      (typeof right.version !== 'number' && typeof right.version !== 'string')
    ) {
      throw new VertexCredentialSinkError('CATALOG_BINDING_MISSING');
    }
    const capabilities = await database.query<{
      readonly model: unknown;
      readonly endpoint: unknown;
      readonly version: unknown;
    }>(
      `SELECT c.model, c.endpoint, c.version
         FROM saas_provider_capabilities AS c
        WHERE c.provider_id = $1 AND c.product_id = $2
          AND c.support_level = 'supported' AND c.validation_state = 'verified'
          AND c.version = (
            SELECT MAX(c2.version) FROM saas_provider_capabilities AS c2
             WHERE c2.provider_id = c.provider_id AND c2.product_id = c.product_id
               AND c2.model = c.model AND c2.endpoint = c.endpoint
          )`,
      [VERTEX_PROVIDER_ID, VERTEX_PRODUCT_ID],
    );
    const capabilityReferences: ProviderCapabilityReference[] = [];
    for (const row of capabilities.rows) {
      if (typeof row.model !== 'string' || typeof row.endpoint !== 'string') continue;
      const version = typeof row.version === 'number' ? row.version : Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      capabilityReferences.push({ model: row.model, endpoint: row.endpoint, version });
    }
    if (capabilityReferences.length === 0) throw new VertexCredentialSinkError('CATALOG_BINDING_MISSING');
    const rightsVersion = typeof right.version === 'number' ? right.version : Number(right.version);
    return {
      rightsId: right.rights_id,
      rightsVersion,
      capabilities: Object.freeze(capabilityReferences),
    };
  };
}

/**
 * Builds the sealed-envelope plaintext for an imported service account. The
 * four SA key fields ride flat alongside the location facts; the token
 * refresher's rotations overlay access_token/expires_at on the same shape.
 */
export function buildVertexSealedEnvelope(imported: VertexSaImport): { readonly secret: Uint8Array } {
  const material = buildVertexSaEnvelopeMaterial(imported.key, {
    location: imported.location,
    vertexModelLocations: imported.vertexModelLocations,
  });
  return { secret: new TextEncoder().encode(JSON.stringify(material)) };
}

export interface VertexCredentialSinkInput {
  readonly actorUserId: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly imported: VertexSaImport;
}

export interface VertexCredentialSink {
  accept(input: VertexCredentialSinkInput): Promise<{ readonly accountRef: string }>;
}

export function createProviderSupplyVertexCredentialSink(options: {
  readonly supply: VertexSinkSupplyService;
  readonly resolveCatalogBinding: VertexPlatformCatalogBindingResolver;
}): VertexCredentialSink {
  if (
    !options?.supply ||
    typeof options.supply.createPlatformProviderAccount !== 'function' ||
    typeof options.supply.createPlatformProviderCredential !== 'function'
  ) {
    throw new TypeError('supply service is required');
  }
  if (typeof options.resolveCatalogBinding !== 'function') {
    throw new TypeError('a catalog binding resolver is required');
  }
  return {
    async accept(input) {
      let binding: VertexPlatformCatalogBinding;
      try {
        binding = await options.resolveCatalogBinding();
      } catch (error) {
        if (error instanceof VertexCredentialSinkError) throw error;
        throw new VertexCredentialSinkError('CATALOG_BINDING_MISSING');
      }
      const audit = {
        actorUserId: input.actorUserId,
        entryPoint: 'platform-vertex-sa',
        ...(input.sourceIp === null || input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
        ...(input.userAgent === null || input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      };
      const displayName = `Vertex ${input.imported.key.clientEmail}`;
      try {
        const account = await options.supply.createPlatformProviderAccount({
          displayName,
          providerId: VERTEX_PROVIDER_ID,
          productId: VERTEX_PRODUCT_ID,
          credentialType: VERTEX_CREDENTIAL_TYPE,
          region: VERTEX_REGION,
          purpose: VERTEX_PURPOSE,
          rightsId: binding.rightsId,
          rightsVersion: binding.rightsVersion,
          capabilities: binding.capabilities,
          audit,
        });
        const sealed = buildVertexSealedEnvelope(input.imported);
        await options.supply.createPlatformProviderCredential({
          accountId: account.id,
          secret: sealed.secret,
          audit,
        });
        return { accountRef: account.id };
      } catch (error) {
        if (error instanceof VertexCredentialSinkError) throw error;
        throw new VertexCredentialSinkError('SUPPLY_WRITE_FAILED');
      }
    },
  };
}
