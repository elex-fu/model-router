import {
  BEDROCK_CREDENTIAL_TYPE,
  BEDROCK_PRODUCT_ID,
  BEDROCK_PROVIDER_ID,
  BEDROCK_PURPOSE,
  BEDROCK_REGION,
} from '../../gateway/bedrock/catalog-identity.js';
import { BEDROCK_DEFAULT_REGION } from '../../gateway/bedrock/constants.js';
import type {
  PlatformProviderAccountCreateInput,
  PlatformProviderCredentialCreateInput,
} from '../../supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCapabilityReference,
  ProviderCredentialWriteResult,
} from '../../supply/types.js';

/**
 * Batch-3 Bedrock credential pipeline (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 credential pipeline
 * row): the production persistence seam for operator-submitted AWS keys.
 * There is no OAuth flow — an operator imports the access-key pair
 * (optionally an STS session token and a region), the sink seals the exact
 * gateway contract shape into a KMS envelope and creates the platform
 * account plus credential through the supply service's audited paths. The
 * sink never touches the credential tables directly and never logs key
 * material (the gemini supply-sink contract, adapted to key import).
 *
 * Envelope plaintext shape (the gateway transport's
 * parseBedrockCredentialMaterial contract):
 *
 *     {"aws_access_key_id":"...","aws_secret_access_key":"...",
 *      "aws_session_token":"...","aws_region":"us-west-2",
 *      "aws_force_global":"true"}
 *
 * The Bearer API-key mode (Bedrock's newer api-key auth) seals
 * `{"api_key":"...","aws_region":...}`; its catalog rights registration is
 * a follow-up (see the roadmap's static-header note) but the envelope
 * parser accepts the shape so operators can migrate accounts in place.
 */

/** The two auth shapes an operator may import. */
export type BedrockCredentialEnvelope =
  | {
      readonly kind: 'aws-sigv4';
      readonly awsAccessKeyId: string;
      readonly awsSecretAccessKey: string;
      readonly awsSessionToken: string | null;
      readonly awsRegion: string;
      readonly forceGlobal: boolean;
      readonly label: string | null;
    }
  | {
      readonly kind: 'api-key';
      readonly apiKey: string;
      readonly awsRegion: string;
      readonly label: string | null;
    };

/** The operator-facing import JSON this module accepts (camelCase or the envelope's snake_case). */
export interface BedrockCredentialSink {
  accept(input: {
    readonly envelope: BedrockCredentialEnvelope;
    readonly actorUserId: string;
    readonly source: 'operator-import';
    readonly sourceIp: string | null;
    readonly userAgent: string | null;
  }): Promise<{ readonly accountRef: string }>;
}

export class BedrockCredentialSinkError extends Error {
  constructor(readonly code: 'CATALOG_BINDING_MISSING' | 'SUPPLY_WRITE_FAILED' | 'ENVELOPE_INVALID') {
    super(
      code === 'CATALOG_BINDING_MISSING'
        ? 'The bedrock platform catalog binding is not registered'
        : code === 'SUPPLY_WRITE_FAILED'
          ? 'The bedrock credential could not be persisted'
          : 'The bedrock credential envelope is invalid',
    );
    this.name = 'BedrockCredentialSinkError';
  }
}

const AWS_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const MAX_LABEL_BYTES = 128;

/**
 * Parses and validates one operator import payload. Accepts either the
 * snake_case envelope shape (aws_access_key_id/aws_secret_access_key/
 * aws_session_token/aws_region[/aws_force_global]) or an api_key bearer
 * shape; camelCase spellings of the same fields are accepted for console
 * ergonomics. Non-throwing: invalid input returns null (the HTTP surface
 * maps that to a 400).
 */
export function parseBedrockCredentialImport(raw: string): BedrockCredentialEnvelope | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  // The label is operator-supplied only — key material never becomes a
  // display name (not even the access key id, which is not a secret but
  // has no business in operator-visible surfaces).
  const labelRaw = text(record.label) ?? text(record.display_name) ?? null;
  const label = labelRaw !== null && labelRaw.length > 0 && labelRaw.length <= MAX_LABEL_BYTES ? labelRaw : null;

  const regionRaw = text(record.aws_region) ?? text(record.awsRegion) ?? text(record.region) ?? BEDROCK_DEFAULT_REGION;
  if (!AWS_REGION_PATTERN.test(regionRaw)) return null;
  const forceGlobal =
    record.aws_force_global === true ||
    record.aws_force_global === 'true' ||
    record.awsForceGlobal === true ||
    record.forceGlobal === true;

  const accessKeyId = text(record.aws_access_key_id) ?? text(record.awsAccessKeyId) ?? text(record.access_key_id);
  const secretAccessKey =
    text(record.aws_secret_access_key) ?? text(record.awsSecretAccessKey) ?? text(record.secret_access_key);
  if (accessKeyId !== null && accessKeyId !== '' && secretAccessKey !== null && secretAccessKey !== '') {
    if (accessKeyId.length < 16 || accessKeyId.length > 128) return null;
    if (secretAccessKey.length < 16 || secretAccessKey.length > 128) return null;
    const sessionToken = text(record.aws_session_token) ?? text(record.awsSessionToken) ?? text(record.session_token);
    return {
      kind: 'aws-sigv4',
      awsAccessKeyId: accessKeyId,
      awsSecretAccessKey: secretAccessKey,
      awsSessionToken: sessionToken !== null && sessionToken !== '' ? sessionToken : null,
      awsRegion: regionRaw,
      forceGlobal,
      label,
    };
  }
  const apiKey = text(record.api_key) ?? text(record.apiKey);
  if (apiKey !== null && apiKey !== '') {
    if (apiKey.length < 16 || apiKey.length > 256) return null;
    return { kind: 'api-key', apiKey, awsRegion: regionRaw, label };
  }
  return null;
}

/** The catalog binding a platform bedrock account must reference. */
export interface BedrockPlatformCatalogBinding {
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
}

export type BedrockPlatformCatalogBindingResolver = () => Promise<BedrockPlatformCatalogBinding>;

interface BedrockSinkQueryExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number;
  }>;
}

/**
 * Resolves the platform bedrock catalog binding (latest active platform
 * rights plus the verified capabilities) straight from the control-plane
 * database. Fails closed when the registration is missing: an unregistered
 * provider must never receive credentials.
 */
export function createPostgresBedrockCatalogBindingResolver(
  database: BedrockSinkQueryExecutor,
): BedrockPlatformCatalogBindingResolver {
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
      [BEDROCK_PROVIDER_ID, BEDROCK_PRODUCT_ID, BEDROCK_CREDENTIAL_TYPE, BEDROCK_REGION, BEDROCK_PURPOSE],
    );
    const right = rights.rows[0];
    if (
      rights.rowCount !== 1 ||
      !right ||
      typeof right.rights_id !== 'string' ||
      (typeof right.version !== 'number' && typeof right.version !== 'string')
    ) {
      throw new BedrockCredentialSinkError('CATALOG_BINDING_MISSING');
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
      [BEDROCK_PROVIDER_ID, BEDROCK_PRODUCT_ID],
    );
    const capabilityReferences: ProviderCapabilityReference[] = [];
    for (const row of capabilities.rows) {
      if (typeof row.model !== 'string' || typeof row.endpoint !== 'string') continue;
      const version = typeof row.version === 'number' ? row.version : Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      capabilityReferences.push({ model: row.model, endpoint: row.endpoint, version });
    }
    if (capabilityReferences.length === 0) throw new BedrockCredentialSinkError('CATALOG_BINDING_MISSING');
    const rightsVersion = typeof right.version === 'number' ? right.version : Number(right.version);
    return {
      rightsId: right.rights_id,
      rightsVersion,
      capabilities: Object.freeze(capabilityReferences),
    };
  };
}

/**
 * Builds the sealed-envelope plaintext for one imported bedrock credential.
 * Field names are the gateway transport's parseBedrockCredentialMaterial
 * contract; AWS keys carry no expiry (the null the supply path expects).
 */
export function buildBedrockSealedEnvelope(envelope: BedrockCredentialEnvelope): {
  readonly secret: Uint8Array;
  readonly expiresAt: string | null;
} {
  if (envelope.kind === 'api-key') {
    return {
      secret: new TextEncoder().encode(JSON.stringify({ api_key: envelope.apiKey, aws_region: envelope.awsRegion })),
      expiresAt: null,
    };
  }
  const material: Record<string, unknown> = {
    aws_access_key_id: envelope.awsAccessKeyId,
    aws_secret_access_key: envelope.awsSecretAccessKey,
    aws_region: envelope.awsRegion,
  };
  if (envelope.awsSessionToken !== null) material.aws_session_token = envelope.awsSessionToken;
  if (envelope.forceGlobal) material.aws_force_global = 'true';
  return { secret: new TextEncoder().encode(JSON.stringify(material)), expiresAt: null };
}

/** Minimal structural view of the supply service the sink needs. */
export interface BedrockSinkSupplyService {
  createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord>;
  createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult>;
}

export function createProviderSupplyBedrockCredentialSink(options: {
  readonly supply: BedrockSinkSupplyService;
  readonly resolveCatalogBinding: BedrockPlatformCatalogBindingResolver;
}): BedrockCredentialSink {
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
      let binding: BedrockPlatformCatalogBinding;
      try {
        binding = await options.resolveCatalogBinding();
      } catch (error) {
        if (error instanceof BedrockCredentialSinkError) throw error;
        throw new BedrockCredentialSinkError('CATALOG_BINDING_MISSING');
      }
      const audit = {
        actorUserId: input.actorUserId,
        entryPoint: 'platform-bedrock-keys',
        ...(input.sourceIp === null ? {} : { sourceIp: input.sourceIp }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      };
      const displayName =
        input.envelope.label !== null && input.envelope.label.length > 0
          ? `Bedrock ${input.envelope.label}`
          : `Bedrock ${input.envelope.awsRegion}`;
      try {
        const account = await options.supply.createPlatformProviderAccount({
          displayName,
          providerId: BEDROCK_PROVIDER_ID,
          productId: BEDROCK_PRODUCT_ID,
          credentialType: BEDROCK_CREDENTIAL_TYPE,
          region: BEDROCK_REGION,
          purpose: BEDROCK_PURPOSE,
          rightsId: binding.rightsId,
          rightsVersion: binding.rightsVersion,
          capabilities: binding.capabilities,
          audit,
        });
        const sealed = buildBedrockSealedEnvelope(input.envelope);
        await options.supply.createPlatformProviderCredential({
          accountId: account.id,
          secret: sealed.secret,
          ...(sealed.expiresAt === null ? {} : { expiresAt: sealed.expiresAt }),
          audit,
        });
        return { accountRef: account.id };
      } catch (error) {
        if (error instanceof BedrockCredentialSinkError) throw error;
        throw new BedrockCredentialSinkError('SUPPLY_WRITE_FAILED');
      }
    },
  };
}
