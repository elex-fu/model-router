import {
  GEMINI_CREDENTIAL_TYPE,
  GEMINI_PRODUCT_ID,
  GEMINI_PROVIDER_ID,
  GEMINI_PURPOSE,
  GEMINI_REGION,
} from '../../gateway/gemini/catalog-identity.js';
import type {
  PlatformProviderAccountCreateInput,
  PlatformProviderCredentialCreateInput,
} from '../../supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCapabilityReference,
  ProviderCredentialWriteResult,
} from '../../supply/types.js';
import type { GeminiCredentialEnvelope } from './binding-service.js';
import type { GeminiCredentialSink } from './http.js';

/**
 * F4 Gemini credential sink (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b): the production
 * persistence seam behind the binding HTTP handler, following the claude
 * supply-sink contract. A completed OAuth binding becomes one platform
 * provider account plus one sealed credential, both through the supply
 * service's audited creation paths — the sink never touches the credential
 * tables directly and never logs token material.
 */

/** Minimal structural view of the supply service the sink needs. */
export interface GeminiSinkSupplyService {
  createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord>;
  createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult>;
}

/** The catalog binding a platform gemini account must reference. */
export interface GeminiPlatformCatalogBinding {
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
}

export type GeminiPlatformCatalogBindingResolver = () => Promise<GeminiPlatformCatalogBinding>;

export class GeminiCredentialSinkError extends Error {
  constructor(readonly code: 'CATALOG_BINDING_MISSING' | 'SUPPLY_WRITE_FAILED') {
    super(
      code === 'CATALOG_BINDING_MISSING'
        ? 'The gemini platform catalog binding is not registered'
        : 'The gemini credential could not be persisted',
    );
    this.name = 'GeminiCredentialSinkError';
  }
}

interface GeminiSinkQueryExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number;
  }>;
}

/**
 * Resolves the platform gemini catalog binding (latest active platform
 * rights plus the verified capabilities) straight from the control-plane
 * database. Fails closed when the registration is missing: an unregistered
 * provider must never receive credentials.
 */
export function createPostgresGeminiCatalogBindingResolver(
  database: GeminiSinkQueryExecutor,
): GeminiPlatformCatalogBindingResolver {
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
      [GEMINI_PROVIDER_ID, GEMINI_PRODUCT_ID, GEMINI_CREDENTIAL_TYPE, GEMINI_REGION, GEMINI_PURPOSE],
    );
    const right = rights.rows[0];
    if (
      rights.rowCount !== 1 ||
      !right ||
      typeof right.rights_id !== 'string' ||
      (typeof right.version !== 'number' && typeof right.version !== 'string')
    ) {
      throw new GeminiCredentialSinkError('CATALOG_BINDING_MISSING');
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
      [GEMINI_PROVIDER_ID, GEMINI_PRODUCT_ID],
    );
    const capabilityReferences: ProviderCapabilityReference[] = [];
    for (const row of capabilities.rows) {
      if (typeof row.model !== 'string' || typeof row.endpoint !== 'string') continue;
      const version = typeof row.version === 'number' ? row.version : Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      capabilityReferences.push({ model: row.model, endpoint: row.endpoint, version });
    }
    if (capabilityReferences.length === 0) throw new GeminiCredentialSinkError('CATALOG_BINDING_MISSING');
    const rightsVersion = typeof right.version === 'number' ? right.version : Number(right.version);
    return {
      rightsId: right.rights_id,
      rightsVersion,
      capabilities: Object.freeze(capabilityReferences),
    };
  };
}

/**
 * Builds the sealed-envelope plaintext for a bound gemini credential. Field
 * names follow the claude envelope contract shape; the R4 refresh worker
 * preserves the gateway-required subset (project_id, tier_id, email,
 * client_id) across rotations. The gateway transport needs the project id
 * for the v1internal dispatch wrap and the tier id for the 429 cooldown.
 */
export function buildGeminiSealedEnvelope(
  envelope: GeminiCredentialEnvelope,
  nowMs: () => number = Date.now,
): { readonly secret: Uint8Array; readonly expiresAt: string | null } {
  let expiresInSeconds: number | null = null;
  if (envelope.expiresAt !== null) {
    const expiresAtMs = Date.parse(envelope.expiresAt);
    if (Number.isFinite(expiresAtMs)) {
      expiresInSeconds = Math.max(1, Math.round((expiresAtMs - nowMs()) / 1000));
    }
  }
  const material: Record<string, unknown> = {
    access_token: envelope.accessToken,
    refresh_token: envelope.refreshToken,
    token_type: 'Bearer',
    expires_at: envelope.expiresAt,
    client_id: envelope.clientId,
    project_id: envelope.projectId,
  };
  if (expiresInSeconds !== null) material.expires_in = expiresInSeconds;
  if (envelope.tierId !== null) material.tier_id = envelope.tierId;
  if (envelope.email !== null) material.email = envelope.email;
  return {
    secret: new TextEncoder().encode(JSON.stringify(material)),
    expiresAt: envelope.expiresAt,
  };
}

export function createProviderSupplyGeminiCredentialSink(options: {
  readonly supply: GeminiSinkSupplyService;
  readonly resolveCatalogBinding: GeminiPlatformCatalogBindingResolver;
  readonly nowMs?: () => number;
}): GeminiCredentialSink {
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
  const nowMs = options.nowMs ?? (() => Date.now());
  return {
    async accept(input) {
      let binding: GeminiPlatformCatalogBinding;
      try {
        binding = await options.resolveCatalogBinding();
      } catch (error) {
        if (error instanceof GeminiCredentialSinkError) throw error;
        throw new GeminiCredentialSinkError('CATALOG_BINDING_MISSING');
      }
      const audit = {
        actorUserId: input.actorUserId,
        entryPoint: 'platform-gemini-oauth',
        ...(input.sourceIp === null ? {} : { sourceIp: input.sourceIp }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      };
      const displayName =
        input.envelope.email !== null && input.envelope.email.length > 0
          ? `Gemini ${input.envelope.email}`
          : `Gemini ${input.envelope.projectId}`;
      try {
        const account = await options.supply.createPlatformProviderAccount({
          displayName,
          providerId: GEMINI_PROVIDER_ID,
          productId: GEMINI_PRODUCT_ID,
          credentialType: GEMINI_CREDENTIAL_TYPE,
          region: GEMINI_REGION,
          purpose: GEMINI_PURPOSE,
          rightsId: binding.rightsId,
          rightsVersion: binding.rightsVersion,
          capabilities: binding.capabilities,
          audit,
        });
        const sealed = buildGeminiSealedEnvelope(input.envelope, nowMs);
        await options.supply.createPlatformProviderCredential({
          accountId: account.id,
          secret: sealed.secret,
          ...(sealed.expiresAt === null ? {} : { expiresAt: sealed.expiresAt }),
          audit,
        });
        return { accountRef: account.id };
      } catch (error) {
        if (error instanceof GeminiCredentialSinkError) throw error;
        throw new GeminiCredentialSinkError('SUPPLY_WRITE_FAILED');
      }
    },
  };
}
