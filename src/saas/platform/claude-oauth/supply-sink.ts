import {
  CLAUDE_CREDENTIAL_TYPE,
  CLAUDE_PRODUCT_ID,
  CLAUDE_PROVIDER_ID,
  CLAUDE_PURPOSE,
  CLAUDE_REGION,
} from '../../gateway/claude/catalog-identity.js';
import type {
  PlatformProviderAccountCreateInput,
  PlatformProviderCredentialCreateInput,
} from '../../supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCapabilityReference,
  ProviderCredentialWriteResult,
} from '../../supply/types.js';
import type { ClaudeCredentialEnvelope } from './binding-service.js';
import type { ClaudeCredentialSink } from './http.js';

/**
 * R5 Claude credential sink (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5): the production
 * persistence seam behind the binding HTTP handler, following the codex
 * supply-sink contract. A completed OAuth binding becomes one platform
 * provider account plus one sealed credential, both through the supply
 * service's audited creation paths — the sink never touches the credential
 * tables directly and never logs token material.
 */

/** Minimal structural view of the supply service the sink needs. */
export interface ClaudeSinkSupplyService {
  createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord>;
  createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult>;
}

/** The catalog binding a platform claude account must reference. */
export interface ClaudePlatformCatalogBinding {
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
}

export type ClaudePlatformCatalogBindingResolver = () => Promise<ClaudePlatformCatalogBinding>;

export class ClaudeCredentialSinkError extends Error {
  constructor(readonly code: 'CATALOG_BINDING_MISSING' | 'SUPPLY_WRITE_FAILED') {
    super(
      code === 'CATALOG_BINDING_MISSING'
        ? 'The claude platform catalog binding is not registered'
        : 'The claude credential could not be persisted',
    );
    this.name = 'ClaudeCredentialSinkError';
  }
}

interface ClaudeSinkQueryExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number | null;
  }>;
}

/**
 * Resolves the platform claude catalog binding (latest active platform
 * rights plus the verified capabilities) straight from the control-plane
 * database. Fails closed when the registration is missing: an unregistered
 * provider must never receive credentials.
 */
export function createPostgresClaudeCatalogBindingResolver(
  database: ClaudeSinkQueryExecutor,
): ClaudePlatformCatalogBindingResolver {
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
      [CLAUDE_PROVIDER_ID, CLAUDE_PRODUCT_ID, CLAUDE_CREDENTIAL_TYPE, CLAUDE_REGION, CLAUDE_PURPOSE],
    );
    const right = rights.rows[0];
    if (
      rights.rowCount !== 1 ||
      !right ||
      typeof right.rights_id !== 'string' ||
      (typeof right.version !== 'number' && typeof right.version !== 'string')
    ) {
      throw new ClaudeCredentialSinkError('CATALOG_BINDING_MISSING');
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
      [CLAUDE_PROVIDER_ID, CLAUDE_PRODUCT_ID],
    );
    const capabilityReferences: ProviderCapabilityReference[] = [];
    for (const row of capabilities.rows) {
      if (typeof row.model !== 'string' || typeof row.endpoint !== 'string') continue;
      const version = typeof row.version === 'number' ? row.version : Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      capabilityReferences.push({ model: row.model, endpoint: row.endpoint, version });
    }
    if (capabilityReferences.length === 0) throw new ClaudeCredentialSinkError('CATALOG_BINDING_MISSING');
    const rightsVersion = typeof right.version === 'number' ? right.version : Number(right.version);
    return {
      rightsId: right.rights_id,
      rightsVersion,
      capabilities: Object.freeze(capabilityReferences),
    };
  };
}

/**
 * Builds the sealed-envelope plaintext for a bound claude credential. Field
 * names follow the codex envelope contract shape; the R4 refresh worker
 * preserves the gateway-required subset (organization_uuid, account_uuid,
 * email, client_id) across rotations. The gateway transport needs
 * organization/account coordinates for the identity namespace.
 */
export function buildClaudeSealedEnvelope(
  envelope: ClaudeCredentialEnvelope,
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
    organization_uuid: envelope.organizationUuid,
  };
  if (expiresInSeconds !== null) material.expires_in = expiresInSeconds;
  if (envelope.accountUuid !== null) material.account_uuid = envelope.accountUuid;
  if (envelope.email !== null) material.email = envelope.email;
  return {
    secret: new TextEncoder().encode(JSON.stringify(material)),
    expiresAt: envelope.expiresAt,
  };
}

export function createProviderSupplyClaudeCredentialSink(options: {
  readonly supply: ClaudeSinkSupplyService;
  readonly resolveCatalogBinding: ClaudePlatformCatalogBindingResolver;
  readonly nowMs?: () => number;
}): ClaudeCredentialSink {
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
      let binding: ClaudePlatformCatalogBinding;
      try {
        binding = await options.resolveCatalogBinding();
      } catch (error) {
        if (error instanceof ClaudeCredentialSinkError) throw error;
        throw new ClaudeCredentialSinkError('CATALOG_BINDING_MISSING');
      }
      const audit = {
        actorUserId: input.actorUserId,
        entryPoint: 'platform-claude-oauth',
        ...(input.sourceIp === null ? {} : { sourceIp: input.sourceIp }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      };
      const displayName =
        input.envelope.email !== null && input.envelope.email.length > 0
          ? `Claude ${input.envelope.email}`
          : `Claude ${input.envelope.organizationUuid}`;
      try {
        const account = await options.supply.createPlatformProviderAccount({
          displayName,
          providerId: CLAUDE_PROVIDER_ID,
          productId: CLAUDE_PRODUCT_ID,
          credentialType: CLAUDE_CREDENTIAL_TYPE,
          region: CLAUDE_REGION,
          purpose: CLAUDE_PURPOSE,
          rightsId: binding.rightsId,
          rightsVersion: binding.rightsVersion,
          capabilities: binding.capabilities,
          audit,
        });
        const sealed = buildClaudeSealedEnvelope(input.envelope, nowMs);
        await options.supply.createPlatformProviderCredential({
          accountId: account.id,
          secret: sealed.secret,
          ...(sealed.expiresAt === null ? {} : { expiresAt: sealed.expiresAt }),
          audit,
        });
        return { accountRef: account.id };
      } catch (error) {
        if (error instanceof ClaudeCredentialSinkError) throw error;
        throw new ClaudeCredentialSinkError('SUPPLY_WRITE_FAILED');
      }
    },
  };
}
