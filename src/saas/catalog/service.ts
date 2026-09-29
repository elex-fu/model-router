import { randomUUID } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import { SaasCatalogError, type SaasCatalogErrorCode } from './errors.js';
import type {
  CatalogTimestamp,
  ProviderCapabilityDiscoverySource,
  ProviderCapabilityRecord,
  ProviderCapabilitySupportLevel,
  ProviderCapabilityValidationState,
  ProviderEligibilityDenied,
  ProviderEligibilityRequest,
  ProviderEligibilityResult,
  ProviderProductRecord,
  ProviderRightsAuditContext,
  ProviderRightsRecord,
  ProviderRightsStatus,
  PublicModelAliasVersionRecord,
  RegisterProviderCapabilityInput,
  RegisterProviderProductInput,
  RegisterProviderRightsVersionInput,
  RegisterPublicModelAliasInput,
  RegisterPublicModelAliasVersionInput,
  RevokeProviderRightsInput,
} from './types.js';

const MAX_ID_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_MODEL_LENGTH = 200;
const MAX_ENDPOINT_LENGTH = 120;
const MAX_PROTOCOL_LENGTH = 80;
const MAX_SCOPE_LENGTH = 200;
const MAX_SCOPE_VALUES = 100;
const MAX_EVIDENCE_REFERENCE_LENGTH = 512;
const MAX_EVIDENCE_VERSION_LENGTH = 128;
const MAX_APPROVAL_REFERENCE_LENGTH = 512;
const MAX_AUDIT_ACTOR_LENGTH = 200;
const MAX_AUDIT_ENTRY_POINT_LENGTH = 128;
const MAX_AUDIT_REQUEST_ID_LENGTH = 128;
const MAX_AUDIT_SOURCE_IP_LENGTH = 128;
const MAX_AUDIT_USER_AGENT_LENGTH = 512;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type StoredTimestamp = string | Date;

interface ProviderProductRow {
  provider_id: string;
  product_id: string;
  display_name: string;
  status: string;
  created_at: StoredTimestamp;
}

interface PublicModelAliasRow {
  public_model_id: string;
  version: number | string;
  alias: string;
  display_name: string;
  provider_id: string;
  product_id: string;
  model: string;
  endpoint_scope: string[];
  status: string;
  created_at: StoredTimestamp;
}

interface CapabilityRow {
  provider_id: string;
  product_id: string;
  model: string;
  endpoint: string;
  protocol: string;
  version: number | string;
  support_level: string;
  validation_state: string;
  evidence_version: string;
  discovery_source: string;
  evidence_ref: string;
  evidence_sha256: string;
  created_at: StoredTimestamp;
}

interface CapabilityEligibilityRow {
  protocol: string;
  version: number | string;
  support_level: string;
  validation_state: string;
}

interface RightsRow {
  rights_id: string;
  version: number | string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  supply_mode: string;
  region: string;
  purpose: string;
  model_scope: string[];
  endpoint_scope: string[];
  effective_at: StoredTimestamp;
  expires_at: StoredTimestamp | null;
  approval_ref: string;
  status: string;
  evidence_ref: string;
  evidence_sha256: string;
  created_at: StoredTimestamp;
}

interface RightsVersionIdentityRow {
  version: number | string;
  status: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  supply_mode: string;
  region: string;
  purpose: string;
}

interface RightsTransitionRow {
  rights_id: string;
  version: number | string;
  status: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  supply_mode: string;
  region: string;
  purpose: string;
  model_scope: string[];
  endpoint_scope: string[];
  effective_at: StoredTimestamp;
  expires_at: StoredTimestamp | null;
  approval_ref: string;
  evidence_ref: string;
  evidence_sha256: string;
  created_at: StoredTimestamp;
}

interface AliasVersionRow {
  public_model_id: string;
  version: number | string;
  alias: string;
  display_name: string;
  provider_id: string;
  product_id: string;
  model: string;
  endpoint_scope: string[];
  status: string;
  created_at: StoredTimestamp;
}

function fail(code: SaasCatalogErrorCode): never {
  throw new SaasCatalogError(code);
}

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') fail('INVALID_INPUT');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    fail('INVALID_INPUT');
  }
  return normalized;
}

function normalizeId(value: unknown): string {
  return normalizeText(value, MAX_ID_LENGTH);
}

function normalizeScope(values: unknown): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_SCOPE_VALUES) {
    fail('INVALID_INPUT');
  }

  const normalized = values.map((value) => normalizeText(value, MAX_SCOPE_LENGTH));
  if (normalized.some((value) => value === '*') || new Set(normalized).size !== normalized.length) {
    fail('INVALID_INPUT');
  }
  return normalized;
}

function normalizeEvidenceHash(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail('INVALID_INPUT');
  return value;
}

function normalizeTimestamp(value: unknown): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail('INVALID_INPUT');
  return date.toISOString();
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  return value === undefined || value === null ? null : normalizeTimestamp(value);
}

function normalizeVersion(value: unknown): number {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) fail('CATALOG_STORAGE_ERROR');
  return version;
}

function normalizeStatus(value: unknown): ProviderRightsStatus {
  if (value === 'draft' || value === 'active' || value === 'revoked') return value;
  fail('INVALID_INPUT');
}

function normalizeCapabilitySupportLevel(value: unknown): ProviderCapabilitySupportLevel {
  if (value === 'supported' || value === 'limited' || value === 'unsupported') return value;
  fail('INVALID_INPUT');
}

function normalizeCapabilityValidationState(value: unknown): ProviderCapabilityValidationState {
  if (value === 'unverified' || value === 'verified' || value === 'failed') return value;
  fail('INVALID_INPUT');
}

function normalizeCapabilityDiscoverySource(value: unknown): ProviderCapabilityDiscoverySource {
  if (value === 'preset' || value === 'manual') return value;
  fail('INVALID_INPUT');
}

function normalizeSupplyMode(value: unknown): 'byok' | 'platform' {
  if (value === 'byok' || value === 'platform') return value;
  fail('INVALID_INPUT');
}

function normalizeRightsAuditContext(
  value: ProviderRightsAuditContext | undefined,
): (ProviderRightsAuditContext & { readonly sourceIp: string | null; readonly userAgent: string | null }) | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  return {
    actorUserId: normalizeText(value.actorUserId, MAX_AUDIT_ACTOR_LENGTH),
    entryPoint: normalizeText(value.entryPoint, MAX_AUDIT_ENTRY_POINT_LENGTH),
    requestId: normalizeText(value.requestId, MAX_AUDIT_REQUEST_ID_LENGTH),
    sourceIp:
      value.sourceIp === undefined || value.sourceIp === null
        ? null
        : normalizeText(value.sourceIp, MAX_AUDIT_SOURCE_IP_LENGTH),
    userAgent:
      value.userAgent === undefined || value.userAgent === null
        ? null
        : normalizeText(value.userAgent, MAX_AUDIT_USER_AGENT_LENGTH),
  };
}

function normalizeCatalogTimestamp(value: StoredTimestamp): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('CATALOG_STORAGE_ERROR');
  return date.toISOString();
}

function normalizeStoredScope(value: unknown): string[] {
  return normalizeScope(value);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function storageError(error: unknown, conflictCode: SaasCatalogErrorCode): SaasCatalogError {
  if (error instanceof SaasCatalogError) return error;
  return new SaasCatalogError(isUniqueViolation(error) ? conflictCode : 'CATALOG_STORAGE_ERROR');
}

function mapProviderProduct(row: ProviderProductRow): ProviderProductRecord {
  if (
    typeof row.provider_id !== 'string' ||
    typeof row.product_id !== 'string' ||
    typeof row.display_name !== 'string' ||
    (row.status !== 'active' && row.status !== 'disabled')
  ) {
    fail('CATALOG_STORAGE_ERROR');
  }
  return {
    providerId: row.provider_id,
    productId: row.product_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: normalizeCatalogTimestamp(row.created_at),
  };
}

function mapAliasVersion(row: PublicModelAliasRow | AliasVersionRow): PublicModelAliasVersionRecord {
  if (row.status !== 'active' && row.status !== 'disabled') fail('CATALOG_STORAGE_ERROR');
  return {
    publicModelId: row.public_model_id,
    version: normalizeVersion(row.version),
    alias: row.alias,
    displayName: row.display_name,
    providerId: row.provider_id,
    productId: row.product_id,
    model: row.model,
    endpointScope: normalizeStoredScope(row.endpoint_scope),
    status: row.status,
    createdAt: normalizeCatalogTimestamp(row.created_at),
  };
}

function mapCapability(row: CapabilityRow): ProviderCapabilityRecord {
  const supportLevel = normalizeCapabilitySupportLevel(row.support_level);
  const validationState = normalizeCapabilityValidationState(row.validation_state);
  const discoverySource = normalizeCapabilityDiscoverySource(row.discovery_source);
  return {
    providerId: row.provider_id,
    productId: row.product_id,
    model: row.model,
    endpoint: row.endpoint,
    protocol: row.protocol,
    version: normalizeVersion(row.version),
    supportLevel,
    validationState,
    evidenceVersion: row.evidence_version,
    discoverySource,
    evidenceReference: row.evidence_ref,
    evidenceSha256: normalizeEvidenceHash(row.evidence_sha256),
    createdAt: normalizeCatalogTimestamp(row.created_at),
  };
}

function mapRights(row: RightsRow | RightsTransitionRow): ProviderRightsRecord {
  const supplyMode = normalizeSupplyMode(row.supply_mode);
  const status = normalizeStatus(row.status);
  const effectiveAt = normalizeCatalogTimestamp(row.effective_at);
  const expiresAt = row.expires_at === null ? null : normalizeCatalogTimestamp(row.expires_at);
  if (expiresAt !== null && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()) {
    fail('CATALOG_STORAGE_ERROR');
  }
  return {
    rightsId: row.rights_id,
    version: normalizeVersion(row.version),
    providerId: row.provider_id,
    productId: row.product_id,
    credentialType: row.credential_type,
    supplyMode,
    region: row.region,
    purpose: row.purpose,
    modelScope: normalizeStoredScope(row.model_scope),
    endpointScope: normalizeStoredScope(row.endpoint_scope),
    effectiveAt,
    expiresAt,
    approvalReference: row.approval_ref,
    status,
    evidenceReference: row.evidence_ref,
    evidenceSha256: normalizeEvidenceHash(row.evidence_sha256),
    createdAt: normalizeCatalogTimestamp(row.created_at),
  };
}

function mapRightsForEligibility(row: RightsRow): {
  rightsId: string;
  version: number;
  providerId: string;
  productId: string;
  credentialType: string;
  supplyMode: 'byok' | 'platform';
  region: string;
  purpose: string;
  modelScope: string[];
  endpointScope: string[];
  effectiveAt: string;
  expiresAt: string | null;
  status: ProviderRightsStatus;
} {
  const mapped = mapRights(row);
  return {
    rightsId: mapped.rightsId,
    version: mapped.version,
    providerId: mapped.providerId,
    productId: mapped.productId,
    credentialType: mapped.credentialType,
    supplyMode: mapped.supplyMode,
    region: mapped.region,
    purpose: mapped.purpose,
    modelScope: [...mapped.modelScope],
    endpointScope: [...mapped.endpointScope],
    effectiveAt: mapped.effectiveAt,
    expiresAt: mapped.expiresAt,
    status: mapped.status,
  };
}

function deny(
  request: ProviderEligibilityRequest,
  reason: ProviderEligibilityDenied['reason'],
  capability?: CapabilityEligibilityRow,
): ProviderEligibilityDenied {
  return {
    decision: 'deny',
    providerId: request.providerId,
    productId: request.productId,
    model: request.model,
    endpoint: request.endpoint,
    reason,
    ...(capability === undefined
      ? {}
      : {
          supportLevel: normalizeCapabilitySupportLevel(capability.support_level),
          validationState: normalizeCapabilityValidationState(capability.validation_state),
          limited: capability.support_level === 'limited',
        }),
  };
}

function sameRightsScope(
  row: ReturnType<typeof mapRightsForEligibility>,
  request: ProviderEligibilityRequest,
): boolean {
  return (
    row.credentialType === request.credentialType &&
    row.supplyMode === request.supplyMode &&
    row.region === request.region &&
    row.purpose === request.purpose &&
    row.modelScope.includes(request.model) &&
    row.endpointScope.includes(request.endpoint)
  );
}

function sameRightsIdentity(
  row: ReturnType<typeof mapRightsForEligibility>,
  request: ProviderEligibilityRequest,
): boolean {
  return (
    row.credentialType === request.credentialType &&
    row.supplyMode === request.supplyMode &&
    row.region === request.region &&
    row.purpose === request.purpose
  );
}

function latestEffectiveRights(rows: readonly RightsRow[], nowMs: number): RightsRow[] {
  const byRightsId = new Map<string, RightsRow[]>();
  for (const row of rows) {
    const list = byRightsId.get(row.rights_id) ?? [];
    list.push(row);
    byRightsId.set(row.rights_id, list);
  }

  const selected: RightsRow[] = [];
  for (const versions of byRightsId.values()) {
    const normalized = versions.map((row) => ({
      row,
      effectiveMs: new Date(normalizeCatalogTimestamp(row.effective_at)).getTime(),
    }));
    const effective = normalized
      .filter(({ effectiveMs }) => effectiveMs <= nowMs)
      .sort(
        (left, right) =>
          right.effectiveMs - left.effectiveMs ||
          normalizeVersion(right.row.version) - normalizeVersion(left.row.version),
      );
    if (effective[0]) {
      selected.push(effective[0].row);
      continue;
    }
    const future = normalized.sort(
      (left, right) =>
        left.effectiveMs - right.effectiveMs ||
        normalizeVersion(left.row.version) - normalizeVersion(right.row.version),
    );
    if (future[0]) selected.push(future[0].row);
  }
  return selected;
}

async function lockCatalogProduct(
  executor: SqlExecutor,
  providerId: string,
  productId: string,
  shared: boolean,
): Promise<void> {
  const lockFunction = shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await executor.query(
    `SELECT ${lockFunction}(
       hashtextextended(
         'saas_catalog_product:' || encode(convert_to($1::text, 'UTF8'), 'hex') || ':' ||
           encode(convert_to($2::text, 'UTF8'), 'hex'),
         0
       )
     )`,
    [providerId, productId],
  );
}

/** Evaluate catalog eligibility through a caller-owned transaction executor. */
export async function evaluateProviderEligibilityInTransaction(
  executor: SqlExecutor,
  input: ProviderEligibilityRequest,
  at: CatalogTimestamp,
): Promise<ProviderEligibilityResult> {
  const request: ProviderEligibilityRequest = {
    providerId: normalizeId(input.providerId),
    productId: normalizeId(input.productId),
    model: normalizeText(input.model, MAX_MODEL_LENGTH),
    endpoint: normalizeText(input.endpoint, MAX_ENDPOINT_LENGTH),
    credentialType: normalizeId(input.credentialType),
    supplyMode: normalizeSupplyMode(input.supplyMode),
    region: normalizeId(input.region),
    purpose: normalizeId(input.purpose),
  };
  const now = normalizeTimestamp(at);
  const nowMs = new Date(now).getTime();
  const query = async <Row>(sql: string, values: readonly unknown[] = []): Promise<Row[]> =>
    (await executor.query<Row>(sql, values)).rows;

  // Readers and writers fence the product's append-only capability and rights history. Migration 048
  // gives database-side version inserts the matching exclusive advisory lock.
  await lockCatalogProduct(executor, request.providerId, request.productId, true);

  const productRows = await query<ProviderProductRow>(
    `SELECT provider_id, product_id, display_name, status, created_at
     FROM saas_provider_products
     WHERE provider_id = $1 AND product_id = $2
     LIMIT 1`,
    [request.providerId, request.productId],
  );
  const product = productRows[0];
  if (!product) return deny(request, 'provider_product_missing');
  if (product.status !== 'active') return deny(request, 'provider_product_disabled');

  const capabilityRows = await query<CapabilityEligibilityRow>(
    `SELECT protocol, version, support_level, validation_state
     FROM saas_provider_capabilities
     WHERE provider_id = $1 AND product_id = $2 AND model = $3 AND endpoint = $4
     ORDER BY version DESC`,
    [request.providerId, request.productId, request.model, request.endpoint],
  );
  const capability = capabilityRows[0];
  if (!capability) return deny(request, 'capability_missing');
  if (capability.support_level === 'unsupported') return deny(request, 'capability_unsupported', capability);
  if (capability.validation_state === 'unverified') return deny(request, 'capability_unverified', capability);
  if (capability.validation_state === 'failed') return deny(request, 'capability_failed', capability);
  if (capability.support_level !== 'supported' && capability.support_level !== 'limited') {
    return deny(request, 'capability_unsupported', capability);
  }

  const rightsRows = await query<RightsRow>(
    `SELECT rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
            model_scope, endpoint_scope, effective_at, expires_at, approval_ref, status,
            evidence_ref, evidence_sha256, created_at
     FROM saas_provider_rights
     WHERE provider_id = $1 AND product_id = $2
     ORDER BY rights_id, version DESC`,
    [request.providerId, request.productId],
  );
  if (rightsRows.length === 0) return deny(request, 'rights_missing', capability);

  const currentRights = latestEffectiveRights(rightsRows, nowMs);
  const identityMatches = currentRights.map(mapRightsForEligibility).filter((row) => sameRightsIdentity(row, request));
  if (identityMatches.length === 0) return deny(request, 'rights_scope_mismatch', capability);
  const scopeMatches = identityMatches.filter((row) => sameRightsScope(row, request));
  if (scopeMatches.length === 0) return deny(request, 'rights_scope_mismatch', capability);

  const activeCandidates = scopeMatches.filter((candidate) => {
    const effectiveMs = new Date(candidate.effectiveAt).getTime();
    return (
      candidate.status === 'active' &&
      effectiveMs <= nowMs &&
      (candidate.expiresAt === null || new Date(candidate.expiresAt).getTime() > nowMs)
    );
  });
  const candidate = activeCandidates.sort(
    (left, right) =>
      new Date(right.effectiveAt).getTime() - new Date(left.effectiveAt).getTime() || right.version - left.version,
  )[0];
  if (!candidate) {
    if (scopeMatches.some((row) => new Date(row.effectiveAt).getTime() > nowMs)) {
      return deny(request, 'rights_not_yet_effective', capability);
    }
    if (scopeMatches.some((row) => row.status === 'revoked')) {
      return deny(request, 'rights_revoked', capability);
    }
    if (
      scopeMatches.some(
        (row) => row.status === 'active' && row.expiresAt !== null && new Date(row.expiresAt).getTime() <= nowMs,
      )
    ) {
      return deny(request, 'rights_expired', capability);
    }
    return deny(request, 'rights_not_active', capability);
  }

  return {
    decision: 'allow',
    providerId: request.providerId,
    productId: request.productId,
    model: request.model,
    endpoint: request.endpoint,
    supportLevel: capability.support_level,
    limited: capability.support_level === 'limited',
    capability: {
      version: normalizeVersion(capability.version),
      protocol: capability.protocol,
      validationState: 'verified',
    },
    rights: {
      rightsId: candidate.rightsId,
      version: candidate.version,
      status: 'active',
      effectiveAt: candidate.effectiveAt,
      expiresAt: candidate.expiresAt,
    },
  };
}

export interface SaasCatalogServiceOptions {
  readonly now?: () => Date;
}

export class SaasCatalogService {
  private readonly now: () => Date;

  constructor(
    private readonly database: SaasDatabase,
    options: SaasCatalogServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private currentDate(): Date {
    const value = this.now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) fail('CATALOG_STORAGE_ERROR');
    return date;
  }

  private async query<Row>(executor: SqlExecutor, sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await executor.query<Row>(sql, values);
      return result.rows;
    } catch (error) {
      throw storageError(error, 'CATALOG_STORAGE_ERROR');
    }
  }

  private async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      throw storageError(error, 'CATALOG_STORAGE_ERROR');
    }
  }

  private async requireProviderProduct(executor: SqlExecutor, providerId: string, productId: string): Promise<void> {
    const rows = await this.query<ProviderProductRow>(
      executor,
      `SELECT provider_id, product_id, display_name, status, created_at
       FROM saas_provider_products
       WHERE provider_id = $1 AND product_id = $2
       LIMIT 1`,
      [providerId, productId],
    );
    if (!rows[0]) fail('PROVIDER_PRODUCT_NOT_FOUND');
  }

  private async fenceActiveProviderProductForWrite(
    executor: SqlExecutor,
    providerId: string,
    productId: string,
    missingProductCode: SaasCatalogErrorCode = 'PROVIDER_PRODUCT_NOT_FOUND',
  ): Promise<void> {
    await lockCatalogProduct(executor, providerId, productId, false);
    const rows = await this.query<ProviderProductRow>(
      executor,
      `SELECT provider_id, product_id, display_name, status, created_at
       FROM saas_provider_products
       WHERE provider_id = $1 AND product_id = $2
       LIMIT 1`,
      [providerId, productId],
    );
    if (!rows[0]) fail(missingProductCode);
    if (rows[0]?.status !== 'active') fail('PROVIDER_PRODUCT_NOT_FOUND');
  }

  private async lockActiveProviderProductForRights(
    executor: SqlExecutor,
    rightsId: string,
  ): Promise<{ readonly providerId: string; readonly productId: string }> {
    const identityRows = await this.query<{ readonly provider_id: string; readonly product_id: string }>(
      executor,
      `SELECT provider_id, product_id
       FROM saas_provider_rights
       WHERE rights_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [rightsId],
    );
    const identity = identityRows[0];
    if (!identity) fail('RIGHTS_NOT_FOUND');
    await this.fenceActiveProviderProductForWrite(
      executor,
      identity.provider_id,
      identity.product_id,
      'RIGHTS_NOT_FOUND',
    );
    return { providerId: identity.provider_id, productId: identity.product_id };
  }

  private async appendProviderRightsAudit(
    executor: SqlExecutor,
    context: ProviderRightsAuditContext & { readonly sourceIp: string | null; readonly userAgent: string | null },
    action: 'provider_rights.version_registered' | 'provider_rights.revoked',
    rightsId: string,
    occurredAt: string,
  ): Promise<void> {
    await this.query(
      executor,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
          source_ip, user_agent, entry_point, request_id)
       VALUES ($1, $2, $3, $4, 'saas_provider_rights', $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        null,
        context.actorUserId,
        action,
        rightsId,
        occurredAt,
        context.sourceIp,
        context.userAgent,
        context.entryPoint,
        context.requestId,
      ],
    );
  }

  async registerProviderProduct(input: RegisterProviderProductInput): Promise<ProviderProductRecord> {
    const providerId = normalizeId(input.providerId);
    const productId = normalizeId(input.productId);
    const displayName = normalizeText(input.displayName, MAX_DISPLAY_NAME_LENGTH);
    const status = input.status ?? 'active';
    if (status !== 'active' && status !== 'disabled') fail('INVALID_INPUT');
    const createdAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      const rows = await this.query<ProviderProductRow>(
        tx,
        `INSERT INTO saas_provider_products
           (provider_id, product_id, display_name, status, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING provider_id, product_id, display_name, status, created_at`,
        [providerId, productId, displayName, status, createdAt],
      );
      const row = rows[0];
      if (!row) fail('CATALOG_STORAGE_ERROR');
      return mapProviderProduct(row);
    }).catch((error) => {
      if (error instanceof SaasCatalogError) throw error;
      throw storageError(error, 'PROVIDER_PRODUCT_EXISTS');
    });
  }

  async registerPublicModelAlias(input: RegisterPublicModelAliasInput): Promise<PublicModelAliasVersionRecord> {
    const publicModelId = normalizeId(input.publicModelId ?? randomUUID());
    const alias = normalizeId(input.alias);
    const displayName = normalizeText(input.displayName, MAX_DISPLAY_NAME_LENGTH);
    const providerId = normalizeId(input.providerId);
    const productId = normalizeId(input.productId);
    const model = normalizeText(input.model, MAX_MODEL_LENGTH);
    const endpointScope = normalizeScope(input.endpointScope);
    const status = input.status ?? 'active';
    if (status !== 'active' && status !== 'disabled') fail('INVALID_INPUT');
    const createdAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      await this.requireProviderProduct(tx, providerId, productId);
      await this.query(
        tx,
        `INSERT INTO saas_public_models
           (id, alias, display_name, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [publicModelId, alias, displayName, status, createdAt],
      );
      await this.query(
        tx,
        `INSERT INTO saas_public_model_versions
           (public_model_id, version, provider_id, product_id, model, endpoint_scope, status, created_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [publicModelId, providerId, productId, model, endpointScope, status, createdAt],
      );
      return {
        publicModelId,
        version: 1,
        alias,
        displayName,
        providerId,
        productId,
        model,
        endpointScope,
        status,
        createdAt,
      };
    }).catch((error) => {
      if (error instanceof SaasCatalogError) throw error;
      throw storageError(error, 'PUBLIC_MODEL_ALIAS_EXISTS');
    });
  }

  async registerPublicModelAliasVersion(
    input: RegisterPublicModelAliasVersionInput,
  ): Promise<PublicModelAliasVersionRecord> {
    const publicModelId = normalizeId(input.publicModelId);
    const providerId = normalizeId(input.providerId);
    const productId = normalizeId(input.productId);
    const model = normalizeText(input.model, MAX_MODEL_LENGTH);
    const endpointScope = normalizeScope(input.endpointScope);
    const status = input.status ?? 'active';
    if (status !== 'active' && status !== 'disabled') fail('INVALID_INPUT');
    const createdAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      await this.requireProviderProduct(tx, providerId, productId);
      // Alias versions are immutable history; serialize appenders on the stable public-model identity.
      await this.query(
        tx,
        `SELECT pg_advisory_xact_lock(
           hashtextextended(
             'saas_public_model:' || encode(convert_to($1::text, 'UTF8'), 'hex'),
             0
           )
         )`,
        [publicModelId],
      );
      const aliasRows = await this.query<AliasVersionRow>(
        tx,
        `SELECT v.public_model_id, v.version, m.alias, m.display_name, v.provider_id, v.product_id, v.model,
                v.endpoint_scope, v.status, v.created_at
         FROM saas_public_model_versions v
         JOIN saas_public_models m ON m.id = v.public_model_id
         WHERE v.public_model_id = $1
         ORDER BY v.version DESC
         LIMIT 1`,
        [publicModelId],
      );
      const latest = aliasRows[0];
      if (!latest) fail('PUBLIC_MODEL_ALIAS_NOT_FOUND');
      const version = normalizeVersion(latest.version) + 1;
      await this.query(
        tx,
        `INSERT INTO saas_public_model_versions
           (public_model_id, version, provider_id, product_id, model, endpoint_scope, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [publicModelId, version, providerId, productId, model, endpointScope, status, createdAt],
      );
      return mapAliasVersion({
        ...latest,
        version,
        provider_id: providerId,
        product_id: productId,
        model,
        endpoint_scope: endpointScope,
        status,
        created_at: createdAt,
      });
    });
  }

  async registerProviderCapability(input: RegisterProviderCapabilityInput): Promise<ProviderCapabilityRecord> {
    const providerId = normalizeId(input.providerId);
    const productId = normalizeId(input.productId);
    const model = normalizeText(input.model, MAX_MODEL_LENGTH);
    const endpoint = normalizeText(input.endpoint, MAX_ENDPOINT_LENGTH);
    const protocol = normalizeText(input.protocol, MAX_PROTOCOL_LENGTH);
    const supportLevel = normalizeCapabilitySupportLevel(input.supportLevel);
    const validationState = normalizeCapabilityValidationState(input.validationState);
    const evidenceVersion = normalizeText(input.evidenceVersion, MAX_EVIDENCE_VERSION_LENGTH);
    const discoverySource = normalizeCapabilityDiscoverySource(input.discoverySource);
    const evidenceReference = normalizeText(input.evidenceReference, MAX_EVIDENCE_REFERENCE_LENGTH);
    const evidenceSha256 = normalizeEvidenceHash(input.evidenceSha256);
    const createdAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      await this.fenceActiveProviderProductForWrite(tx, providerId, productId);
      const latestRows = await this.query<{ version: number | string }>(
        tx,
        `SELECT version
         FROM saas_provider_capabilities
         WHERE provider_id = $1 AND product_id = $2 AND model = $3 AND endpoint = $4
         ORDER BY version DESC
         LIMIT 1`,
        [providerId, productId, model, endpoint],
      );
      const version = latestRows[0] ? normalizeVersion(latestRows[0].version) + 1 : 1;
      const rows = await this.query<CapabilityRow>(
        tx,
        `INSERT INTO saas_provider_capabilities
           (provider_id, product_id, model, endpoint, protocol, version, support_level,
            validation_state, evidence_version, discovery_source, evidence_ref, evidence_sha256, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING provider_id, product_id, model, endpoint, protocol, version, support_level,
                   validation_state, evidence_version, discovery_source, evidence_ref, evidence_sha256, created_at`,
        [
          providerId,
          productId,
          model,
          endpoint,
          protocol,
          version,
          supportLevel,
          validationState,
          evidenceVersion,
          discoverySource,
          evidenceReference,
          evidenceSha256,
          createdAt,
        ],
      );
      const row = rows[0];
      if (!row) fail('CATALOG_STORAGE_ERROR');
      return mapCapability(row);
    }).catch((error) => {
      if (error instanceof SaasCatalogError) throw error;
      throw storageError(error, 'CAPABILITY_VERSION_CONFLICT');
    });
  }

  async registerProviderCapabilityVersion(input: RegisterProviderCapabilityInput): Promise<ProviderCapabilityRecord> {
    return this.registerProviderCapability(input);
  }

  async registerProviderRightsVersion(input: RegisterProviderRightsVersionInput): Promise<ProviderRightsRecord> {
    const rightsId = normalizeId(input.rightsId ?? randomUUID());
    const providerId = normalizeId(input.providerId);
    const productId = normalizeId(input.productId);
    const credentialType = normalizeId(input.credentialType);
    const supplyMode = normalizeSupplyMode(input.supplyMode);
    const region = normalizeId(input.region);
    const purpose = normalizeId(input.purpose);
    const modelScope = normalizeScope(input.modelScope);
    const endpointScope = normalizeScope(input.endpointScope);
    const effectiveAt = normalizeTimestamp(input.effectiveAt);
    const expiresAt = normalizeOptionalTimestamp(input.expiresAt);
    if (expiresAt !== null && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()) fail('INVALID_INPUT');
    const approvalReference = normalizeText(input.approvalReference, MAX_APPROVAL_REFERENCE_LENGTH);
    const evidenceReference = normalizeText(input.evidenceReference, MAX_EVIDENCE_REFERENCE_LENGTH);
    const evidenceSha256 = normalizeEvidenceHash(input.evidenceSha256);
    const status = normalizeStatus(input.status ?? 'active');
    const audit = normalizeRightsAuditContext(input.audit);
    const createdAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      // Migration 047's provider-rights writer trigger takes the same global
      // fence. Acquire it before the product prelock to keep writer ordering
      // global -> product -> rights row/history.
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
      await this.fenceActiveProviderProductForWrite(tx, providerId, productId);
      const latestRows = await this.query<RightsVersionIdentityRow>(
        tx,
        `SELECT version, status, provider_id, product_id, credential_type, supply_mode, region, purpose
         FROM saas_provider_rights
         WHERE rights_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [rightsId],
      );
      const latest = latestRows[0];
      if (latest) {
        if (
          latest.provider_id !== providerId ||
          latest.product_id !== productId ||
          latest.credential_type !== credentialType ||
          latest.supply_mode !== supplyMode ||
          latest.region !== region ||
          latest.purpose !== purpose
        ) {
          fail('RIGHTS_VERSION_CONFLICT');
        }
        if (latest.status === 'revoked' && status !== 'revoked') fail('INVALID_RIGHTS_STATUS_TRANSITION');
      }
      const version = latest ? normalizeVersion(latest.version) + 1 : 1;
      const rows = await this.query<RightsRow>(
        tx,
        `INSERT INTO saas_provider_rights
           (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
            model_scope, endpoint_scope, effective_at, expires_at, approval_ref, status,
            evidence_ref, evidence_sha256, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
                   model_scope, endpoint_scope, effective_at, expires_at, approval_ref, status,
                   evidence_ref, evidence_sha256, created_at`,
        [
          rightsId,
          version,
          providerId,
          productId,
          credentialType,
          supplyMode,
          region,
          purpose,
          modelScope,
          endpointScope,
          effectiveAt,
          expiresAt,
          approvalReference,
          status,
          evidenceReference,
          evidenceSha256,
          createdAt,
        ],
      );
      const row = rows[0];
      if (!row) fail('CATALOG_STORAGE_ERROR');
      await this.query(
        tx,
        `INSERT INTO saas_provider_rights_events
           (id, rights_id, rights_version, from_status, to_status, event_type, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), rightsId, version, latest?.status ?? null, status, latest ? 'versioned' : 'created', createdAt],
      );
      if (audit) {
        await this.appendProviderRightsAudit(tx, audit, 'provider_rights.version_registered', rightsId, createdAt);
      }
      return mapRights(row);
    }).catch((error) => {
      if (error instanceof SaasCatalogError) throw error;
      throw storageError(error, 'RIGHTS_VERSION_CONFLICT');
    });
  }

  async revokeProviderRights(input: RevokeProviderRightsInput): Promise<ProviderRightsRecord> {
    const rightsId = normalizeId(input.rightsId);
    const approvalReference = normalizeText(input.approvalReference, MAX_APPROVAL_REFERENCE_LENGTH);
    const evidenceReference = normalizeText(input.evidenceReference, MAX_EVIDENCE_REFERENCE_LENGTH);
    const evidenceSha256 = normalizeEvidenceHash(input.evidenceSha256);
    const effectiveAt =
      input.effectiveAt === undefined ? this.currentDate().toISOString() : normalizeTimestamp(input.effectiveAt);
    const audit = normalizeRightsAuditContext(input.audit);
    const createdAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      // The INSERT below invokes migration 047's global writer trigger; the
      // global fence must precede the product advisory prelock.
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
      const lockedProduct = await this.lockActiveProviderProductForRights(tx, rightsId);
      const latestRows = await this.query<RightsTransitionRow>(
        tx,
        `SELECT rights_id, version, status, provider_id, product_id, credential_type, supply_mode,
                region, purpose, model_scope, endpoint_scope, effective_at, expires_at, approval_ref,
                evidence_ref, evidence_sha256, created_at
         FROM saas_provider_rights
         WHERE rights_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [rightsId],
      );
      const latest = latestRows[0];
      if (!latest) fail('RIGHTS_NOT_FOUND');
      if (latest.provider_id !== lockedProduct.providerId || latest.product_id !== lockedProduct.productId) {
        fail('RIGHTS_VERSION_CONFLICT');
      }
      if (latest.status === 'revoked') fail('INVALID_RIGHTS_STATUS_TRANSITION');
      const version = normalizeVersion(latest.version) + 1;
      const rows = await this.query<RightsRow>(
        tx,
        `INSERT INTO saas_provider_rights
           (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
            model_scope, endpoint_scope, effective_at, expires_at, approval_ref, status,
            evidence_ref, evidence_sha256, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, 'revoked', $13, $14, $15)
         RETURNING rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
                   model_scope, endpoint_scope, effective_at, expires_at, approval_ref, status,
                   evidence_ref, evidence_sha256, created_at`,
        [
          rightsId,
          version,
          latest.provider_id,
          latest.product_id,
          latest.credential_type,
          latest.supply_mode,
          latest.region,
          latest.purpose,
          latest.model_scope,
          latest.endpoint_scope,
          effectiveAt,
          approvalReference,
          evidenceReference,
          evidenceSha256,
          createdAt,
        ],
      );
      const row = rows[0];
      if (!row) fail('CATALOG_STORAGE_ERROR');
      await this.query(
        tx,
        `INSERT INTO saas_provider_rights_events
           (id, rights_id, rights_version, from_status, to_status, event_type, occurred_at)
         VALUES ($1, $2, $3, $4, 'revoked', 'revoked', $5)`,
        [randomUUID(), rightsId, version, latest.status, createdAt],
      );
      if (audit) {
        await this.appendProviderRightsAudit(tx, audit, 'provider_rights.revoked', rightsId, createdAt);
      }
      return mapRights(row);
    });
  }

  async evaluateProviderEligibility(
    input: ProviderEligibilityRequest,
    at: CatalogTimestamp = this.currentDate(),
    executor?: SqlExecutor,
  ): Promise<ProviderEligibilityResult> {
    if (executor) return evaluateProviderEligibilityInTransaction(executor, input, at);
    return this.transaction((tx) => evaluateProviderEligibilityInTransaction(tx, input, at));
  }

  async checkProviderEligibility(
    input: ProviderEligibilityRequest,
    at: CatalogTimestamp = this.currentDate(),
    executor?: SqlExecutor,
  ): Promise<ProviderEligibilityResult> {
    return this.evaluateProviderEligibility(input, at, executor);
  }
}
