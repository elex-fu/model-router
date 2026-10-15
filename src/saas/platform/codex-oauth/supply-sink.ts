import {
  CODEX_CREDENTIAL_TYPE,
  CODEX_PRODUCT_ID,
  CODEX_PROVIDER_ID,
  CODEX_PURPOSE,
  CODEX_REGION,
} from '../../gateway/codex/catalog-identity.js';
import type {
  PlatformProviderAccountCreateInput,
  PlatformProviderCredentialCreateInput,
} from '../../supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCapabilityReference,
  ProviderCredentialWriteResult,
} from '../../supply/types.js';
import type { CodexCredentialEnvelope } from './binding-service.js';
import type { CodexCredentialSink } from './http.js';

/**
 * P1c Codex credential sink (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.2 mount): the
 * production persistence seam behind the binding HTTP handler. A completed
 * OAuth binding becomes one platform provider account plus one sealed
 * credential, both through the supply service's audited creation paths — the
 * sink never touches the credential tables directly and never logs token
 * material.
 */

/** Minimal structural view of the supply service the sink needs. */
export interface CodexSinkSupplyService {
  createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord>;
  createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult>;
}

/** The catalog binding a platform codex account must reference. */
export interface CodexPlatformCatalogBinding {
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
}

export type CodexPlatformCatalogBindingResolver = () => Promise<CodexPlatformCatalogBinding>;

export class CodexCredentialSinkError extends Error {
  constructor(readonly code: 'CATALOG_BINDING_MISSING' | 'SUPPLY_WRITE_FAILED') {
    super(
      code === 'CATALOG_BINDING_MISSING'
        ? 'The codex platform catalog binding is not registered'
        : 'The codex credential could not be persisted',
    );
    this.name = 'CodexCredentialSinkError';
  }
}

interface CodexSinkQueryExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number | null;
  }>;
}

/**
 * Resolves the platform codex catalog binding (latest active platform rights
 * plus the verified capabilities) straight from the control-plane database.
 * Fails closed when the registration (catalog/codex-registration.ts) is
 * missing: an unregistered provider must never receive credentials.
 */
export function createPostgresCodexCatalogBindingResolver(
  database: CodexSinkQueryExecutor,
): CodexPlatformCatalogBindingResolver {
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
      [CODEX_PROVIDER_ID, CODEX_PRODUCT_ID, CODEX_CREDENTIAL_TYPE, CODEX_REGION, CODEX_PURPOSE],
    );
    const right = rights.rows[0];
    if (
      rights.rowCount !== 1 ||
      !right ||
      typeof right.rights_id !== 'string' ||
      (typeof right.version !== 'number' && typeof right.version !== 'string')
    ) {
      throw new CodexCredentialSinkError('CATALOG_BINDING_MISSING');
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
      [CODEX_PROVIDER_ID, CODEX_PRODUCT_ID],
    );
    const capabilityReferences: ProviderCapabilityReference[] = [];
    for (const row of capabilities.rows) {
      if (typeof row.model !== 'string' || typeof row.endpoint !== 'string') continue;
      const version = typeof row.version === 'number' ? row.version : Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      capabilityReferences.push({ model: row.model, endpoint: row.endpoint, version });
    }
    if (capabilityReferences.length === 0) throw new CodexCredentialSinkError('CATALOG_BINDING_MISSING');
    const rightsVersion = typeof right.version === 'number' ? right.version : Number(right.version);
    return {
      rightsId: right.rights_id,
      rightsVersion,
      capabilities: Object.freeze(capabilityReferences),
    };
  };
}

/**
 * Builds the sealed-envelope plaintext for a bound codex credential. Field
 * names follow the plan §1.1 envelope contract; the R4 refresh worker
 * preserves the gateway-required subset (chatgpt_account_id, chatgpt_user_id,
 * plan_type, client_id) across rotations. The id_token is intentionally not
 * persisted: it is only needed at binding time and would be dropped by the
 * first rotation anyway.
 */
export function buildCodexSealedEnvelope(
  envelope: CodexCredentialEnvelope,
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
    chatgpt_account_id: envelope.chatgptAccountId,
  };
  if (expiresInSeconds !== null) material.expires_in = expiresInSeconds;
  if (envelope.chatgptUserId !== null) material.chatgpt_user_id = envelope.chatgptUserId;
  if (envelope.planType !== null) material.plan_type = envelope.planType;
  if (envelope.email !== null) material.email = envelope.email;
  return {
    secret: new TextEncoder().encode(JSON.stringify(material)),
    expiresAt: envelope.expiresAt,
  };
}

export function createProviderSupplyCodexCredentialSink(options: {
  readonly supply: CodexSinkSupplyService;
  readonly resolveCatalogBinding: CodexPlatformCatalogBindingResolver;
  readonly nowMs?: () => number;
}): CodexCredentialSink {
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
      let binding: CodexPlatformCatalogBinding;
      try {
        binding = await options.resolveCatalogBinding();
      } catch (error) {
        if (error instanceof CodexCredentialSinkError) throw error;
        throw new CodexCredentialSinkError('CATALOG_BINDING_MISSING');
      }
      const audit = {
        actorUserId: input.actorUserId,
        entryPoint: 'platform-codex-oauth',
        ...(input.sourceIp === null ? {} : { sourceIp: input.sourceIp }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      };
      const displayName =
        input.envelope.email !== null && input.envelope.email.length > 0
          ? `Codex ${input.envelope.email}`
          : `Codex ${input.envelope.chatgptAccountId}`;
      try {
        const account = await options.supply.createPlatformProviderAccount({
          displayName,
          providerId: CODEX_PROVIDER_ID,
          productId: CODEX_PRODUCT_ID,
          credentialType: CODEX_CREDENTIAL_TYPE,
          region: CODEX_REGION,
          purpose: CODEX_PURPOSE,
          rightsId: binding.rightsId,
          rightsVersion: binding.rightsVersion,
          capabilities: binding.capabilities,
          audit,
        });
        const sealed = buildCodexSealedEnvelope(input.envelope, nowMs);
        await options.supply.createPlatformProviderCredential({
          accountId: account.id,
          secret: sealed.secret,
          ...(sealed.expiresAt === null ? {} : { expiresAt: sealed.expiresAt }),
          audit,
        });
        return { accountRef: account.id };
      } catch (error) {
        if (error instanceof CodexCredentialSinkError) throw error;
        throw new CodexCredentialSinkError('SUPPLY_WRITE_FAILED');
      }
    },
  };
}
