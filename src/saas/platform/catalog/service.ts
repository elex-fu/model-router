import { createHash } from 'node:crypto';
import { PlatformCatalogGovernanceError, type PlatformCatalogGovernanceErrorCode } from './errors.js';
import type {
  PlatformCatalogCapabilityDiscoverySource,
  PlatformCatalogCapabilityListQuery,
  PlatformCatalogCapabilityPage,
  PlatformCatalogCapabilityRecord,
  PlatformCatalogCapabilitySupportLevel,
  PlatformCatalogCapabilityValidationState,
  PlatformCatalogPage,
  PlatformCatalogProductPage,
  PlatformCatalogProductStatus,
  PlatformCatalogProviderProductListQuery,
  PlatformCatalogProviderProductRecord,
  PlatformCatalogQueryDatabase,
  PlatformCatalogRightsListQuery,
  PlatformCatalogRightsPage,
  PlatformCatalogRightsRecord,
  PlatformCatalogRightsStatus,
} from './types.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_PREFIX = 'pc1.';

const MAX_ID_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_MODEL_LENGTH = 200;
const MAX_ENDPOINT_LENGTH = 120;
const MAX_PROTOCOL_LENGTH = 80;
const MAX_EVIDENCE_VERSION_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 512;
const MAX_SCOPE_VALUES = 100;
const MAX_SCOPE_VALUE_LENGTH = 200;

const PRODUCT_QUERY_KEYS = new Set(['providerId', 'productId', 'status', 'cursor', 'limit', 'pageSize']);
const CAPABILITY_QUERY_KEYS = new Set([
  'providerId',
  'productId',
  'model',
  'endpoint',
  'protocol',
  'version',
  'supportLevel',
  'validationState',
  'evidenceVersion',
  'discoverySource',
  'cursor',
  'limit',
  'pageSize',
]);
const RIGHTS_QUERY_KEYS = new Set([
  'rightsId',
  'providerId',
  'productId',
  'version',
  'credentialType',
  'supplyMode',
  'region',
  'purpose',
  'status',
  'cursor',
  'limit',
  'pageSize',
]);

const PRODUCT_STATUSES = new Set<PlatformCatalogProductStatus>(['active', 'disabled']);
const SUPPORT_LEVELS = new Set<PlatformCatalogCapabilitySupportLevel>(['supported', 'limited', 'unsupported']);
const VALIDATION_STATES = new Set<PlatformCatalogCapabilityValidationState>(['unverified', 'verified', 'failed']);
const DISCOVERY_SOURCES = new Set<PlatformCatalogCapabilityDiscoverySource>(['preset', 'manual']);
const RIGHTS_STATUSES = new Set<PlatformCatalogRightsStatus>(['draft', 'active', 'revoked']);
const SUPPLY_MODES = new Set<'byok' | 'platform'>(['byok', 'platform']);

interface ProviderProductRow {
  provider_id: unknown;
  product_id: unknown;
  display_name: unknown;
  status: unknown;
  created_at: unknown;
}

interface CapabilityRow {
  provider_id: unknown;
  product_id: unknown;
  model: unknown;
  endpoint: unknown;
  protocol: unknown;
  version: unknown;
  support_level: unknown;
  validation_state: unknown;
  evidence_version: unknown;
  discovery_source: unknown;
  evidence_ref: unknown;
  evidence_sha256: unknown;
  created_at: unknown;
}

interface RightsRow {
  rights_id: unknown;
  version: unknown;
  provider_id: unknown;
  product_id: unknown;
  credential_type: unknown;
  supply_mode: unknown;
  region: unknown;
  purpose: unknown;
  model_scope: unknown;
  endpoint_scope: unknown;
  effective_at: unknown;
  expires_at: unknown;
  approval_ref: unknown;
  status: unknown;
  evidence_ref: unknown;
  evidence_sha256: unknown;
  created_at: unknown;
}

interface ProductCursor {
  readonly kind: 'products';
  readonly version: 1;
  readonly filterHash: string;
  readonly providerId: string;
  readonly productId: string;
}

interface CapabilityCursor {
  readonly kind: 'capabilities';
  readonly version: 1;
  readonly filterHash: string;
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly versionValue: number;
}

interface RightsCursor {
  readonly kind: 'rights';
  readonly version: 1;
  readonly filterHash: string;
  readonly providerId: string;
  readonly productId: string;
  readonly rightsId: string;
  readonly versionValue: number;
}

type QueryCursor = ProductCursor | CapabilityCursor | RightsCursor;

interface NormalizedProductFilters {
  readonly providerId?: string;
  readonly productId?: string;
  readonly status?: PlatformCatalogProductStatus;
}

interface NormalizedCapabilityFilters {
  readonly providerId?: string;
  readonly productId?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly protocol?: string;
  readonly version?: number;
  readonly supportLevel?: PlatformCatalogCapabilitySupportLevel;
  readonly validationState?: PlatformCatalogCapabilityValidationState;
  readonly evidenceVersion?: string;
  readonly discoverySource?: string;
}

interface NormalizedRightsFilters {
  readonly rightsId?: string;
  readonly providerId?: string;
  readonly productId?: string;
  readonly version?: number;
  readonly credentialType?: string;
  readonly supplyMode?: 'byok' | 'platform';
  readonly region?: string;
  readonly purpose?: string;
  readonly status?: string;
}

interface NormalizedList<TFilters, TCursor extends QueryCursor> {
  readonly filters: TFilters;
  readonly limit: number;
  readonly cursor: TCursor | null;
  readonly filterHash: string;
}

class ParameterBuilder {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function fail(code: PlatformCatalogGovernanceErrorCode): never {
  throw new PlatformCatalogGovernanceError(code);
}

function invalid(): never {
  return fail('INVALID_INPUT');
}

function storage(): never {
  return fail('CATALOG_STORAGE_ERROR');
}

function objectInput(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) invalid();
  }
  return candidate;
}

function inputText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    invalid();
  }
  return normalized;
}

function optionalInputText(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : inputText(value, maxLength);
}

function inputVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function optionalInputVersion(value: unknown): number | undefined {
  return value === undefined ? undefined : inputVersion(value);
}

function enumInput<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) invalid();
  return value as T;
}

function optionalEnumInput<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return value === undefined ? undefined : enumInput(value, allowed);
}

function normalizeLimit(candidate: Record<string, unknown>): number {
  if (candidate.limit !== undefined && candidate.pageSize !== undefined && candidate.limit !== candidate.pageSize) {
    invalid();
  }
  const value = candidate.limit === undefined ? candidate.pageSize : candidate.limit;
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) invalid();
  return value;
}

function hashFilters(kind: string, values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, ...values]), 'utf8')
    .digest('hex');
}

function encodeCursor(cursor: QueryCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

function decodeCursor(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) invalid();
  if (!value.startsWith(CURSOR_PREFIX)) invalid();
  const encoded = value.slice(CURSOR_PREFIX.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
    return parsed as Record<string, unknown>;
  } catch {
    invalid();
  }
}

function exactObjectKeys(candidate: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) invalid();
}

function cursorBase(
  candidate: Record<string, unknown>,
  kind: QueryCursor['kind'],
  expectedKeys: ReadonlySet<string>,
  filterHash: string,
): void {
  exactObjectKeys(candidate, expectedKeys);
  if (candidate.kind !== kind || candidate.version !== 1 || candidate.filterHash !== filterHash) invalid();
  if (typeof candidate.filterHash !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.filterHash)) invalid();
}

function normalizeProductCursor(value: unknown, filterHash: string): ProductCursor | null {
  if (value === undefined || value === null) return null;
  const candidate = decodeCursor(value);
  cursorBase(candidate, 'products', new Set(['kind', 'version', 'filterHash', 'providerId', 'productId']), filterHash);
  return {
    kind: 'products',
    version: 1,
    filterHash,
    providerId: inputText(candidate.providerId, MAX_ID_LENGTH),
    productId: inputText(candidate.productId, MAX_ID_LENGTH),
  };
}

function normalizeCapabilityCursor(value: unknown, filterHash: string): CapabilityCursor | null {
  if (value === undefined || value === null) return null;
  const candidate = decodeCursor(value);
  cursorBase(
    candidate,
    'capabilities',
    new Set(['kind', 'version', 'filterHash', 'providerId', 'productId', 'model', 'endpoint', 'versionValue']),
    filterHash,
  );
  return {
    kind: 'capabilities',
    version: 1,
    filterHash,
    providerId: inputText(candidate.providerId, MAX_ID_LENGTH),
    productId: inputText(candidate.productId, MAX_ID_LENGTH),
    model: inputText(candidate.model, MAX_MODEL_LENGTH),
    endpoint: inputText(candidate.endpoint, MAX_ENDPOINT_LENGTH),
    versionValue: inputVersion(candidate.versionValue),
  };
}

function normalizeRightsCursor(value: unknown, filterHash: string): RightsCursor | null {
  if (value === undefined || value === null) return null;
  const candidate = decodeCursor(value);
  cursorBase(
    candidate,
    'rights',
    new Set(['kind', 'version', 'filterHash', 'providerId', 'productId', 'rightsId', 'versionValue']),
    filterHash,
  );
  return {
    kind: 'rights',
    version: 1,
    filterHash,
    providerId: inputText(candidate.providerId, MAX_ID_LENGTH),
    productId: inputText(candidate.productId, MAX_ID_LENGTH),
    rightsId: inputText(candidate.rightsId, MAX_ID_LENGTH),
    versionValue: inputVersion(candidate.versionValue),
  };
}

function normalizeProducts(
  input: PlatformCatalogProviderProductListQuery | undefined,
): NormalizedList<NormalizedProductFilters, ProductCursor> {
  const candidate = objectInput(input, PRODUCT_QUERY_KEYS);
  const filters: NormalizedProductFilters = {
    providerId: optionalInputText(candidate.providerId, MAX_ID_LENGTH),
    productId: optionalInputText(candidate.productId, MAX_ID_LENGTH),
    status: optionalEnumInput(candidate.status, PRODUCT_STATUSES),
  };
  const filterHash = hashFilters('products', [
    filters.providerId ?? null,
    filters.productId ?? null,
    filters.status ?? null,
  ]);
  return {
    filters,
    limit: normalizeLimit(candidate),
    cursor: normalizeProductCursor(candidate.cursor, filterHash),
    filterHash,
  };
}

function normalizeCapabilities(
  input: PlatformCatalogCapabilityListQuery | undefined,
): NormalizedList<NormalizedCapabilityFilters, CapabilityCursor> {
  const candidate = objectInput(input, CAPABILITY_QUERY_KEYS);
  const filters: NormalizedCapabilityFilters = {
    providerId: optionalInputText(candidate.providerId, MAX_ID_LENGTH),
    productId: optionalInputText(candidate.productId, MAX_ID_LENGTH),
    model: optionalInputText(candidate.model, MAX_MODEL_LENGTH),
    endpoint: optionalInputText(candidate.endpoint, MAX_ENDPOINT_LENGTH),
    protocol: optionalInputText(candidate.protocol, MAX_PROTOCOL_LENGTH),
    version: optionalInputVersion(candidate.version),
    supportLevel: optionalEnumInput(candidate.supportLevel, SUPPORT_LEVELS),
    validationState: optionalEnumInput(candidate.validationState, VALIDATION_STATES),
    evidenceVersion: optionalInputText(candidate.evidenceVersion, MAX_EVIDENCE_VERSION_LENGTH),
    discoverySource: optionalEnumInput(candidate.discoverySource, DISCOVERY_SOURCES),
  };
  const filterHash = hashFilters('capabilities', [
    filters.providerId ?? null,
    filters.productId ?? null,
    filters.model ?? null,
    filters.endpoint ?? null,
    filters.protocol ?? null,
    filters.version ?? null,
    filters.supportLevel ?? null,
    filters.validationState ?? null,
    filters.evidenceVersion ?? null,
    filters.discoverySource ?? null,
  ]);
  return {
    filters,
    limit: normalizeLimit(candidate),
    cursor: normalizeCapabilityCursor(candidate.cursor, filterHash),
    filterHash,
  };
}

function normalizeRights(
  input: PlatformCatalogRightsListQuery | undefined,
): NormalizedList<NormalizedRightsFilters, RightsCursor> {
  const candidate = objectInput(input, RIGHTS_QUERY_KEYS);
  const filters: NormalizedRightsFilters = {
    rightsId: optionalInputText(candidate.rightsId, MAX_ID_LENGTH),
    providerId: optionalInputText(candidate.providerId, MAX_ID_LENGTH),
    productId: optionalInputText(candidate.productId, MAX_ID_LENGTH),
    version: optionalInputVersion(candidate.version),
    credentialType: optionalInputText(candidate.credentialType, MAX_ID_LENGTH),
    supplyMode: optionalEnumInput(candidate.supplyMode, SUPPLY_MODES),
    region: optionalInputText(candidate.region, MAX_ID_LENGTH),
    purpose: optionalInputText(candidate.purpose, MAX_ID_LENGTH),
    status: optionalEnumInput(candidate.status, RIGHTS_STATUSES),
  };
  const filterHash = hashFilters('rights', [
    filters.rightsId ?? null,
    filters.providerId ?? null,
    filters.productId ?? null,
    filters.version ?? null,
    filters.credentialType ?? null,
    filters.supplyMode ?? null,
    filters.region ?? null,
    filters.purpose ?? null,
    filters.status ?? null,
  ]);
  return {
    filters,
    limit: normalizeLimit(candidate),
    cursor: normalizeRightsCursor(candidate.cursor, filterHash),
    filterHash,
  };
}

function storedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') storage();
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    storage();
  }
  return value;
}

function storedVersion(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') storage();
  if (typeof value === 'string' && value.trim() === '') storage();
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) storage();
  return version;
}

function storedTimestamp(value: unknown): string {
  if (!(typeof value === 'string' || value instanceof Date)) storage();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) storage();
  return date.toISOString();
}

function storedNullableTimestamp(value: unknown): string | null {
  return value === null ? null : storedTimestamp(value);
}

function storedEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) storage();
  return value as T;
}

function storedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) storage();
  return value;
}

function storedScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_VALUES) storage();
  const result = value.map((entry) => storedText(entry, MAX_SCOPE_VALUE_LENGTH));
  if (result.some((entry) => entry === '*')) storage();
  return result;
}

function mapProduct(row: ProviderProductRow): PlatformCatalogProviderProductRecord {
  return {
    providerId: storedText(row.provider_id, MAX_ID_LENGTH),
    productId: storedText(row.product_id, MAX_ID_LENGTH),
    displayName: storedText(row.display_name, MAX_DISPLAY_NAME_LENGTH),
    status: storedEnum(row.status, PRODUCT_STATUSES),
    createdAt: storedTimestamp(row.created_at),
  };
}

function mapCapability(row: CapabilityRow): PlatformCatalogCapabilityRecord {
  return {
    providerId: storedText(row.provider_id, MAX_ID_LENGTH),
    productId: storedText(row.product_id, MAX_ID_LENGTH),
    model: storedText(row.model, MAX_MODEL_LENGTH),
    endpoint: storedText(row.endpoint, MAX_ENDPOINT_LENGTH),
    protocol: storedText(row.protocol, MAX_PROTOCOL_LENGTH),
    version: storedVersion(row.version),
    supportLevel: storedEnum(row.support_level, SUPPORT_LEVELS),
    validationState: storedEnum(row.validation_state, VALIDATION_STATES),
    evidenceVersion: storedText(row.evidence_version, MAX_EVIDENCE_VERSION_LENGTH),
    discoverySource: storedEnum(row.discovery_source, DISCOVERY_SOURCES),
    evidenceReference: storedText(row.evidence_ref, MAX_REFERENCE_LENGTH),
    evidenceSha256: storedHash(row.evidence_sha256),
    createdAt: storedTimestamp(row.created_at),
  };
}

function mapRights(row: RightsRow): PlatformCatalogRightsRecord {
  const effectiveAt = storedTimestamp(row.effective_at);
  const expiresAt = storedNullableTimestamp(row.expires_at);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(effectiveAt)) storage();
  return {
    rightsId: storedText(row.rights_id, MAX_ID_LENGTH),
    version: storedVersion(row.version),
    providerId: storedText(row.provider_id, MAX_ID_LENGTH),
    productId: storedText(row.product_id, MAX_ID_LENGTH),
    credentialType: storedText(row.credential_type, MAX_ID_LENGTH),
    supplyMode: storedEnum(row.supply_mode, SUPPLY_MODES),
    region: storedText(row.region, MAX_ID_LENGTH),
    purpose: storedText(row.purpose, MAX_ID_LENGTH),
    modelScope: storedScope(row.model_scope),
    endpointScope: storedScope(row.endpoint_scope),
    effectiveAt,
    expiresAt,
    approvalReference: storedText(row.approval_ref, MAX_REFERENCE_LENGTH),
    status: storedEnum(row.status, RIGHTS_STATUSES),
    evidenceReference: storedText(row.evidence_ref, MAX_REFERENCE_LENGTH),
    evidenceSha256: storedHash(row.evidence_sha256),
    createdAt: storedTimestamp(row.created_at),
  };
}

function page<Item>(
  rows: readonly Item[],
  limit: number,
  cursor: QueryCursor | null,
  nextCursor: QueryCursor | null,
): PlatformCatalogPage<Item> {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    items: visible,
    hasMore,
    nextCursor: hasMore && nextCursor && cursor !== nextCursor ? encodeCursor(nextCursor) : null,
  };
}

function storageFromUnknown(error: unknown): never {
  if (error instanceof PlatformCatalogGovernanceError) throw error;
  return storage();
}

export class PlatformCatalogGovernanceQueryService {
  constructor(private readonly database: PlatformCatalogQueryDatabase) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('database must implement the read-only platform catalog query contract');
    }
  }

  private async rows<Row>(sql: string, values: readonly unknown[]): Promise<Row[]> {
    try {
      const result = await this.database.query<Row>(sql, values);
      if (!result || !Array.isArray(result.rows)) throw new Error('invalid query result');
      return result.rows;
    } catch (error) {
      return storageFromUnknown(error);
    }
  }

  async listProviderProducts(input: PlatformCatalogProviderProductListQuery = {}): Promise<PlatformCatalogProductPage> {
    const normalized = normalizeProducts(input);
    const params = new ParameterBuilder();
    const predicates: string[] = [];
    if (normalized.filters.providerId !== undefined) {
      predicates.push(`p.provider_id = ${params.add(normalized.filters.providerId)}`);
    }
    if (normalized.filters.productId !== undefined) {
      predicates.push(`p.product_id = ${params.add(normalized.filters.productId)}`);
    }
    if (normalized.filters.status !== undefined) {
      predicates.push(`p.status = ${params.add(normalized.filters.status)}`);
    }
    if (normalized.cursor) {
      const providerParam = params.add(normalized.cursor.providerId);
      const productParam = params.add(normalized.cursor.productId);
      predicates.push(
        `(p.provider_id > ${providerParam} OR (p.provider_id = ${providerParam} AND p.product_id > ${productParam}))`,
      );
    }
    const limitParam = params.add(normalized.limit + 1);
    const sql = `SELECT p.provider_id, p.product_id, p.display_name, p.status, p.created_at
      FROM saas_provider_products AS p
      ${predicates.length === 0 ? '' : `WHERE ${predicates.join('\n        AND ')}`}
      ORDER BY p.provider_id ASC, p.product_id ASC
      LIMIT ${limitParam}`;
    try {
      const rows = await this.rows<ProviderProductRow>(sql, params.values);
      const mapped = rows.map(mapProduct);
      const last = mapped[normalized.limit - 1];
      const next =
        rows.length > normalized.limit && last
          ? {
              kind: 'products' as const,
              version: 1 as const,
              filterHash: normalized.filterHash,
              providerId: last.providerId,
              productId: last.productId,
            }
          : null;
      return page(mapped, normalized.limit, normalized.cursor, next);
    } catch (error) {
      return storageFromUnknown(error);
    }
  }

  async listCapabilities(input: PlatformCatalogCapabilityListQuery = {}): Promise<PlatformCatalogCapabilityPage> {
    const normalized = normalizeCapabilities(input);
    const params = new ParameterBuilder();
    const predicates: string[] = [];
    if (normalized.filters.providerId !== undefined) {
      predicates.push(`c.provider_id = ${params.add(normalized.filters.providerId)}`);
    }
    if (normalized.filters.productId !== undefined) {
      predicates.push(`c.product_id = ${params.add(normalized.filters.productId)}`);
    }
    if (normalized.filters.model !== undefined) predicates.push(`c.model = ${params.add(normalized.filters.model)}`);
    if (normalized.filters.endpoint !== undefined) {
      predicates.push(`c.endpoint = ${params.add(normalized.filters.endpoint)}`);
    }
    if (normalized.filters.protocol !== undefined) {
      predicates.push(`c.protocol = ${params.add(normalized.filters.protocol)}`);
    }
    if (normalized.filters.version !== undefined) {
      predicates.push(`c.version = ${params.add(normalized.filters.version)}`);
    }
    if (normalized.filters.supportLevel !== undefined) {
      predicates.push(`c.support_level = ${params.add(normalized.filters.supportLevel)}`);
    }
    if (normalized.filters.validationState !== undefined) {
      predicates.push(`c.validation_state = ${params.add(normalized.filters.validationState)}`);
    }
    if (normalized.filters.evidenceVersion !== undefined) {
      predicates.push(`c.evidence_version = ${params.add(normalized.filters.evidenceVersion)}`);
    }
    if (normalized.filters.discoverySource !== undefined) {
      predicates.push(`c.discovery_source = ${params.add(normalized.filters.discoverySource)}`);
    }
    if (normalized.cursor) {
      const providerParam = params.add(normalized.cursor.providerId);
      const productParam = params.add(normalized.cursor.productId);
      const modelParam = params.add(normalized.cursor.model);
      const endpointParam = params.add(normalized.cursor.endpoint);
      const versionParam = params.add(normalized.cursor.versionValue);
      predicates.push(`(
        c.provider_id > ${providerParam}
        OR (c.provider_id = ${providerParam} AND c.product_id > ${productParam})
        OR (c.provider_id = ${providerParam} AND c.product_id = ${productParam} AND c.model > ${modelParam})
        OR (c.provider_id = ${providerParam} AND c.product_id = ${productParam} AND c.model = ${modelParam} AND c.endpoint > ${endpointParam})
        OR (c.provider_id = ${providerParam} AND c.product_id = ${productParam} AND c.model = ${modelParam} AND c.endpoint = ${endpointParam} AND c.version < ${versionParam})
      )`);
    }
    const limitParam = params.add(normalized.limit + 1);
    const sql = `SELECT c.provider_id, c.product_id, c.model, c.endpoint, c.protocol, c.version,
             c.support_level, c.validation_state, c.evidence_version, c.discovery_source,
             c.evidence_ref, c.evidence_sha256, c.created_at
      FROM saas_provider_capabilities AS c
      ${predicates.length === 0 ? '' : `WHERE ${predicates.join('\n        AND ')}`}
      ORDER BY c.provider_id ASC, c.product_id ASC, c.model ASC, c.endpoint ASC, c.version DESC
      LIMIT ${limitParam}`;
    try {
      const rows = await this.rows<CapabilityRow>(sql, params.values);
      const mapped = rows.map(mapCapability);
      const last = mapped[normalized.limit - 1];
      const next =
        rows.length > normalized.limit && last
          ? {
              kind: 'capabilities' as const,
              version: 1 as const,
              filterHash: normalized.filterHash,
              providerId: last.providerId,
              productId: last.productId,
              model: last.model,
              endpoint: last.endpoint,
              versionValue: last.version,
            }
          : null;
      return page(mapped, normalized.limit, normalized.cursor, next);
    } catch (error) {
      return storageFromUnknown(error);
    }
  }

  async listProviderCapabilities(
    input: PlatformCatalogCapabilityListQuery = {},
  ): Promise<PlatformCatalogCapabilityPage> {
    return this.listCapabilities(input);
  }

  async listProviderRights(input: PlatformCatalogRightsListQuery = {}): Promise<PlatformCatalogRightsPage> {
    const normalized = normalizeRights(input);
    const params = new ParameterBuilder();
    const predicates: string[] = [];
    if (normalized.filters.rightsId !== undefined) {
      predicates.push(`r.rights_id = ${params.add(normalized.filters.rightsId)}`);
    }
    if (normalized.filters.providerId !== undefined) {
      predicates.push(`r.provider_id = ${params.add(normalized.filters.providerId)}`);
    }
    if (normalized.filters.productId !== undefined) {
      predicates.push(`r.product_id = ${params.add(normalized.filters.productId)}`);
    }
    if (normalized.filters.version !== undefined) {
      predicates.push(`r.version = ${params.add(normalized.filters.version)}`);
    }
    if (normalized.filters.credentialType !== undefined) {
      predicates.push(`r.credential_type = ${params.add(normalized.filters.credentialType)}`);
    }
    if (normalized.filters.supplyMode !== undefined) {
      predicates.push(`r.supply_mode = ${params.add(normalized.filters.supplyMode)}`);
    }
    if (normalized.filters.region !== undefined) {
      predicates.push(`r.region = ${params.add(normalized.filters.region)}`);
    }
    if (normalized.filters.purpose !== undefined) {
      predicates.push(`r.purpose = ${params.add(normalized.filters.purpose)}`);
    }
    if (normalized.filters.status !== undefined) {
      predicates.push(`r.status = ${params.add(normalized.filters.status)}`);
    }
    if (normalized.cursor) {
      const providerParam = params.add(normalized.cursor.providerId);
      const productParam = params.add(normalized.cursor.productId);
      const rightsParam = params.add(normalized.cursor.rightsId);
      const versionParam = params.add(normalized.cursor.versionValue);
      predicates.push(`(
        r.provider_id > ${providerParam}
        OR (r.provider_id = ${providerParam} AND r.product_id > ${productParam})
        OR (r.provider_id = ${providerParam} AND r.product_id = ${productParam} AND r.rights_id > ${rightsParam})
        OR (r.provider_id = ${providerParam} AND r.product_id = ${productParam} AND r.rights_id = ${rightsParam} AND r.version < ${versionParam})
      )`);
    }
    const limitParam = params.add(normalized.limit + 1);
    const sql = `SELECT r.rights_id, r.version, r.provider_id, r.product_id, r.credential_type,
             r.supply_mode, r.region, r.purpose, r.model_scope, r.endpoint_scope,
             r.effective_at, r.expires_at, r.approval_ref, r.status,
             r.evidence_ref, r.evidence_sha256, r.created_at
      FROM saas_provider_rights AS r
      ${predicates.length === 0 ? '' : `WHERE ${predicates.join('\n        AND ')}`}
      ORDER BY r.provider_id ASC, r.product_id ASC, r.rights_id ASC, r.version DESC
      LIMIT ${limitParam}`;
    try {
      const rows = await this.rows<RightsRow>(sql, params.values);
      const mapped = rows.map(mapRights);
      const last = mapped[normalized.limit - 1];
      const next =
        rows.length > normalized.limit && last
          ? {
              kind: 'rights' as const,
              version: 1 as const,
              filterHash: normalized.filterHash,
              providerId: last.providerId,
              productId: last.productId,
              rightsId: last.rightsId,
              versionValue: last.version,
            }
          : null;
      return page(mapped, normalized.limit, normalized.cursor, next);
    } catch (error) {
      return storageFromUnknown(error);
    }
  }

  async listRights(input: PlatformCatalogRightsListQuery = {}): Promise<PlatformCatalogRightsPage> {
    return this.listProviderRights(input);
  }

  async listProducts(input: PlatformCatalogProviderProductListQuery = {}): Promise<PlatformCatalogProductPage> {
    return this.listProviderProducts(input);
  }
}

export const PlatformCatalogQueryService = PlatformCatalogGovernanceQueryService;
export const SaasPlatformCatalogGovernanceQueryService = PlatformCatalogGovernanceQueryService;
export const SaasPlatformCatalogQueryService = PlatformCatalogGovernanceQueryService;

export const PLATFORM_CATALOG_DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const PLATFORM_CATALOG_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
