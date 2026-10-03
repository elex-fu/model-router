import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import type { GatewayProtocol, SupplyMode } from '../gateway/contracts.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_TIME_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_CURSOR_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_MODEL_LENGTH = 512;
const CURSOR_PREFIX = 'c1.';

const REQUEST_STATUSES = new Set<ConsoleRequestStatus>(['pending', 'succeeded', 'failed', 'unknown']);
const FINANCIAL_STATUSES = new Set<ConsoleFinancialStatus>([
  'not_applicable', 'pending', 'settled', 'released', 'reconciliation_pending',
]);
const RECONCILIATION_STATES = new Set<ConsoleReconciliationState>(['none', 'pending', 'resolved']);
const SUPPLY_MODES = new Set<ConsoleSupplyMode>(['byok', 'platform']);
const PROTOCOLS = new Set<ConsoleProtocol>(['anthropic', 'openai', 'gemini', 'responses']);
const USAGE_STATUSES = new Set<ConsoleUsageStatus>(['reported', 'partial', 'missing', 'estimated']);
const USAGE_SOURCES = new Set<ConsoleUsageSource>(['upstream', 'local-estimate', 'legacy']);
const MEASUREMENT_KINDS = new Set<ConsoleMeasurementKind>(['snapshot', 'delta']);
const BILLABLE_BASES = new Set<ConsoleBillableBasis>(['exact', 'estimated', 'unknown', 'not_billable']);

type Row = Record<string, unknown>;

/** A read-only subset of the database contract used by this service. */
export type ConsoleQueryDatabase = Pick<SqlExecutor, 'query'>;
export type ConsoleProtocol = GatewayProtocol;
export type ConsoleSupplyMode = SupplyMode;
export type ConsoleRequestStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';
export type ConsoleFinancialStatus = 'not_applicable' | 'pending' | 'settled' | 'released' | 'reconciliation_pending';
export type ConsoleReconciliationState = 'none' | 'pending' | 'resolved';
export type ConsoleUsageStatus = 'reported' | 'partial' | 'missing' | 'estimated';
export type ConsoleUsageSource = 'upstream' | 'local-estimate' | 'legacy';
export type ConsoleMeasurementKind = 'snapshot' | 'delta';
export type ConsoleBillableBasis = 'exact' | 'estimated' | 'unknown' | 'not_billable';
export type ConsoleDateInput = string | Date;

export interface ConsoleQueryScope {
  readonly userId: string;
  readonly tenantId: string;
  /** A project selector, never an authorization grant. */
  readonly projectId?: string;
}

export interface ConsoleRequestListQuery extends ConsoleQueryScope {
  readonly model?: string;
  readonly status?: ConsoleRequestStatus;
  readonly supplyMode?: ConsoleSupplyMode;
  /** Inclusive lower bound on request creation time. */
  readonly from?: ConsoleDateInput;
  /** Exclusive upper bound on request creation time. */
  readonly to?: ConsoleDateInput;
  /** Aliases accepted for callers that use start/end terminology. */
  readonly startAt?: ConsoleDateInput;
  readonly endAt?: ConsoleDateInput;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly pageSize?: number;
}

export type ConsoleRequestListOptions = Omit<ConsoleRequestListQuery, 'userId' | 'tenantId'>;

export interface ConsoleRequestDetailQuery {
  readonly userId: string;
  readonly tenantId: string;
  readonly requestId: string;
  /** Optional project selector used to narrow the request lookup. */
  readonly projectId?: string;
}

export interface ConsoleRequestDetailOptions {
  readonly projectId?: string;
}

export interface ConsoleUsageSummaryQuery extends ConsoleQueryScope {
  /** Inclusive lower bound on usage-event creation time. */
  readonly from: ConsoleDateInput;
  /** Exclusive upper bound on usage-event creation time. */
  readonly to: ConsoleDateInput;
  readonly model?: string;
  readonly status?: ConsoleRequestStatus;
  readonly supplyMode?: ConsoleSupplyMode;
}

export type ConsoleUsageSummaryOptions = Omit<ConsoleUsageSummaryQuery, 'userId' | 'tenantId'>;

export interface ConsoleUsageSummaryListQuery extends ConsoleUsageSummaryQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly pageSize?: number;
}

export type ConsoleUsageSummaryListOptions = Omit<ConsoleUsageSummaryListQuery, 'userId' | 'tenantId'>;

export interface ConsolePage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Only normalized request metadata safe for a customer-facing console. */
export interface ConsoleRequest {
  readonly id: string;
  readonly projectId: string;
  readonly model: string;
  readonly protocol: ConsoleProtocol;
  readonly supplyMode: ConsoleSupplyMode;
  /** Execution state; retained as status for existing clients. */
  readonly status: ConsoleRequestStatus;
  readonly financialStatus: ConsoleFinancialStatus;
  /** Execution reconciliation, independent of financial reconciliation. */
  readonly reconciliationState: ConsoleReconciliationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Provider-internal routing identifiers are intentionally absent. */
export interface ConsoleAttempt {
  readonly id: string;
  readonly sequence: number;
  readonly status: ConsoleRequestStatus;
  readonly responseStarted: boolean;
  readonly responseStartedAt: string | null;
  readonly httpStatus: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Usage facts expose normalized counts, never provider payloads or digests. */
export interface ConsoleUsageEvent {
  readonly id: string;
  readonly supplyMode: ConsoleSupplyMode;
  readonly inputTotal: string | null;
  readonly inputUncached: string | null;
  readonly cacheRead: string | null;
  readonly cacheWrite: string | null;
  readonly cacheWrite5m: string | null;
  readonly cacheWrite1h: string | null;
  readonly outputTotal: string | null;
  readonly reasoningOutput: string | null;
  readonly status: ConsoleUsageStatus;
  readonly source: ConsoleUsageSource;
  readonly measurementKind: ConsoleMeasurementKind;
  readonly billableBasis: ConsoleBillableBasis;
  readonly createdAt: string;
}

export interface ConsoleRequestDetail extends ConsoleRequest {
  readonly attempts: readonly ConsoleAttempt[];
  readonly usageEvents: readonly ConsoleUsageEvent[];
}

/** All token totals are decimal strings; aggregation happens in SQL. */
export interface ConsoleUsageSummary {
  readonly from: string;
  readonly to: string;
  readonly requestCount: string;
  readonly eventCount: string;
  readonly inputTotal: string;
  readonly inputUncached: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly cacheWrite5m: string;
  readonly cacheWrite1h: string;
  readonly outputTotal: string;
  readonly reasoningOutput: string;
  readonly totalTokens: string;
}

/** One daily, model/project/mode/status bucket for a bounded usage query. */
export interface ConsoleUsageSummaryBucket extends ConsoleUsageSummary {
  readonly periodStart: string;
  readonly projectId: string;
  readonly model: string;
  readonly supplyMode: ConsoleSupplyMode;
  readonly status: ConsoleRequestStatus;
}

export type SaasConsoleQueryErrorCode = 'CONSOLE_INVALID_INPUT' | 'CONSOLE_STORAGE_ERROR';

const ERROR_MESSAGES: Record<SaasConsoleQueryErrorCode, string> = {
  CONSOLE_INVALID_INPUT: 'The console query contains invalid data.',
  CONSOLE_STORAGE_ERROR: 'The console query could not be completed.',
};

export class SaasConsoleQueryError extends Error {
  readonly status: number;
  readonly code: SaasConsoleQueryErrorCode;

  constructor(code: SaasConsoleQueryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SaasConsoleQueryError';
    this.status = code === 'CONSOLE_INVALID_INPUT' ? 400 : 500;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface NormalizedScope {
  readonly userId: string;
  readonly tenantId: string;
  readonly projectId?: string;
}

interface NormalizedRange {
  readonly from: string;
  readonly to: string;
}

interface NormalizedFilters extends NormalizedScope {
  readonly model?: string;
  readonly status?: ConsoleRequestStatus;
  readonly supplyMode?: ConsoleSupplyMode;
  readonly range: NormalizedRange | null;
}

interface NormalizedRequestList extends NormalizedFilters {
  readonly limit: number;
  readonly cursor: RequestCursor | null;
}

interface NormalizedUsageList extends NormalizedFilters {
  readonly range: NormalizedRange;
  readonly limit: number;
  readonly cursor: UsageCursor | null;
}

interface RequestCursor {
  readonly kind: 'requests';
  readonly version: 1;
  readonly filterHash: string;
  readonly createdAt: string;
  readonly id: string;
}

interface UsageCursor {
  readonly kind: 'usage';
  readonly version: 1;
  readonly filterHash: string;
  readonly periodStart: string;
  readonly projectId: string;
  readonly model: string;
  readonly supplyMode: ConsoleSupplyMode;
  readonly status: ConsoleRequestStatus;
}

class ParameterBuilder {
  readonly values: unknown[];

  constructor(initial: readonly unknown[]) {
    this.values = [...initial];
  }

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function invalid(): never {
  throw new SaasConsoleQueryError('CONSOLE_INVALID_INPUT');
}

function storage(): never {
  throw new SaasConsoleQueryError('CONSOLE_STORAGE_ERROR');
}

function inputText(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) invalid();
  return normalized;
}

function storageText(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string') storage();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) storage();
  return normalized;
}

function optionalInputText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return inputText(value, maxLength);
}

function inputDate(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalid();
    return value.toISOString();
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid();
  return new Date(parsed).toISOString();
}

function storageDate(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) storage();
    return value.toISOString();
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) storage();
  return new Date(Date.parse(value)).toISOString();
}

function enumInput<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) invalid();
  return value as T;
}

function enumStorage<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) storage();
  return value as T;
}

function normalizeScope(input: unknown): NormalizedScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const candidate = input as Record<string, unknown>;
  const projectId = optionalInputText(candidate.projectId, MAX_IDENTIFIER_LENGTH);
  return {
    userId: inputText(candidate.userId),
    tenantId: inputText(candidate.tenantId),
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function selectDateAlias(primary: unknown, alias: unknown): unknown {
  if (primary !== undefined && alias !== undefined) invalid();
  return primary === undefined ? alias : primary;
}

function normalizeRange(input: Record<string, unknown>, required: boolean): NormalizedRange | null {
  const fromValue = selectDateAlias(input.from, input.startAt);
  const toValue = selectDateAlias(input.to, input.endAt);
  if (fromValue === undefined && toValue === undefined) {
    if (required) invalid();
    return null;
  }
  if (fromValue === undefined || toValue === undefined) invalid();
  const from = inputDate(fromValue);
  const to = inputDate(toValue);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs || toMs - fromMs > MAX_TIME_RANGE_MS) invalid();
  return { from, to };
}

function normalizeLimit(input: Record<string, unknown>): number {
  if (input.limit !== undefined && input.pageSize !== undefined && input.limit !== input.pageSize) invalid();
  const value = input.limit === undefined ? input.pageSize : input.limit;
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) invalid();
  return value;
}

function normalizeFilters(input: unknown, rangeRequired: boolean): NormalizedFilters {
  const scope = normalizeScope(input);
  const candidate = input as Record<string, unknown>;
  const model = optionalInputText(candidate.model, MAX_MODEL_LENGTH);
  const status = candidate.status === undefined ? undefined : enumInput(candidate.status, REQUEST_STATUSES);
  const supplyMode = candidate.supplyMode === undefined ? undefined : enumInput(candidate.supplyMode, SUPPLY_MODES);
  const range = normalizeRange(candidate, rangeRequired);
  return {
    ...scope,
    ...(model === undefined ? {} : { model }),
    ...(status === undefined ? {} : { status }),
    ...(supplyMode === undefined ? {} : { supplyMode }),
    range,
  };
}

function hashFilters(kind: string, filters: NormalizedFilters): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        kind,
        filters.userId,
        filters.tenantId,
        filters.projectId ?? null,
        filters.model ?? null,
        filters.status ?? null,
        filters.supplyMode ?? null,
        filters.range?.from ?? null,
        filters.range?.to ?? null,
      ]),
      'utf8',
    )
    .digest('hex');
}

function encodeCursor(value: RequestCursor | UsageCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function decodeCursor(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) invalid();
  if (!value.startsWith(CURSOR_PREFIX)) invalid();
  try {
    const decoded = Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
    return parsed as Record<string, unknown>;
  } catch {
    invalid();
  }
}

function normalizeRequestCursor(value: unknown, filterHash: string): RequestCursor | null {
  if (value === undefined || value === null) return null;
  const candidate = decodeCursor(value);
  if (candidate.kind !== 'requests' || candidate.version !== 1 || candidate.filterHash !== filterHash) {
    invalid();
  }
  const createdAt = inputDate(candidate.createdAt);
  const id = inputText(candidate.id);
  return { kind: 'requests', version: 1, filterHash, createdAt, id };
}

function normalizeUsageCursor(value: unknown, filterHash: string): UsageCursor | null {
  if (value === undefined || value === null) return null;
  const candidate = decodeCursor(value);
  if (candidate.kind !== 'usage' || candidate.version !== 1 || candidate.filterHash !== filterHash) {
    invalid();
  }
  return {
    kind: 'usage',
    version: 1,
    filterHash,
    periodStart: inputDate(candidate.periodStart),
    projectId: inputText(candidate.projectId),
    model: inputText(candidate.model, MAX_MODEL_LENGTH),
    supplyMode: enumInput(candidate.supplyMode, SUPPLY_MODES),
    status: enumInput(candidate.status, REQUEST_STATUSES),
  };
}

function normalizeRequestList(input: ConsoleRequestListQuery): NormalizedRequestList {
  const filters = normalizeFilters(input, false);
  const filterHash = hashFilters('requests', filters);
  return {
    ...filters,
    limit: normalizeLimit(input as unknown as Record<string, unknown>),
    cursor: normalizeRequestCursor(input.cursor, filterHash),
  };
}

function normalizeRequestDetail(input: ConsoleRequestDetailQuery): ConsoleRequestDetailQuery & NormalizedScope {
  const scope = normalizeScope(input);
  const requestId = inputText(input.requestId);
  return { ...scope, requestId };
}

function normalizeUsageSummary(input: ConsoleUsageSummaryQuery): NormalizedFilters & { range: NormalizedRange } {
  const filters = normalizeFilters(input, true);
  if (!filters.range) invalid();
  return { ...filters, range: filters.range };
}

function normalizeUsageList(input: ConsoleUsageSummaryListQuery): NormalizedUsageList {
  const filters = normalizeUsageSummary(input);
  const filterHash = hashFilters('usage', filters);
  return {
    ...filters,
    limit: normalizeLimit(input as unknown as Record<string, unknown>),
    cursor: normalizeUsageCursor(input.cursor, filterHash),
  };
}

function tenantMembershipPredicate(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM saas_memberships AS tm
    JOIN saas_tenants AS tenant
      ON tenant.id = tm.tenant_id
     AND tenant.status = 'active'
    JOIN saas_users AS user_account
      ON user_account.id = tm.user_id
     AND user_account.disabled_at IS NULL
    WHERE tm.tenant_id = ${alias}.tenant_id
      AND tm.user_id = $1
      AND tm.status = 'active'
  )`;
}

function projectMembershipPredicate(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM saas_project_memberships AS pm
    JOIN saas_projects AS project
      ON project.tenant_id = pm.tenant_id
     AND project.id = pm.project_id
    WHERE pm.tenant_id = ${alias}.tenant_id
      AND pm.project_id = ${alias}.project_id
      AND pm.user_id = $1
      AND pm.status = 'active'
  )`;
}

function authorizedScopeCte(projectParam: string | undefined): string {
  const projectPredicate = projectParam
    ? `
      AND EXISTS (
        SELECT 1
        FROM saas_project_memberships AS pm
        JOIN saas_projects AS project
          ON project.tenant_id = pm.tenant_id
         AND project.id = pm.project_id
        WHERE pm.tenant_id = $2
          AND pm.project_id = ${projectParam}
          AND pm.user_id = $1
          AND pm.status = 'active'
      )`
    : '';
  return `WITH authorized_scope AS (
    SELECT tm.user_id
    FROM saas_memberships AS tm
    JOIN saas_tenants AS tenant
      ON tenant.id = tm.tenant_id
     AND tenant.status = 'active'
    JOIN saas_users AS user_account
      ON user_account.id = tm.user_id
     AND user_account.disabled_at IS NULL
    WHERE tm.tenant_id = $2
      AND tm.user_id = $1
      AND tm.status = 'active'${projectPredicate}
    LIMIT 1
  )`;
}

function addRequestFilters(
  params: ParameterBuilder,
  filters: NormalizedFilters,
  predicates: string[],
  requestAlias: string,
  timeColumn: string,
): void {
  if (filters.projectId !== undefined) {
    const projectParam = params.add(filters.projectId);
    predicates.push(`${requestAlias}.project_id = ${projectParam}`);
  }
  if (filters.model !== undefined) {
    const modelParam = params.add(filters.model);
    predicates.push(`${requestAlias}.public_model = ${modelParam}`);
  }
  if (filters.status !== undefined) {
    const statusParam = params.add(filters.status);
    predicates.push(`${requestAlias}.execution_state = ${statusParam}`);
  }
  if (filters.supplyMode !== undefined) {
    const supplyModeParam = params.add(filters.supplyMode);
    predicates.push(`${requestAlias}.supply_mode = ${supplyModeParam}`);
  }
  if (filters.range) {
    const fromParam = params.add(filters.range.from);
    const toParam = params.add(filters.range.to);
    predicates.push(`${timeColumn} >= ${fromParam}`, `${timeColumn} < ${toParam}`);
  }
}

function requestProjection(alias: string): string {
  return `
    ${alias}.id AS id,
    ${alias}.project_id AS project_id,
    ${alias}.public_model AS model,
    ${alias}.protocol AS protocol,
    ${alias}.supply_mode AS supply_mode,
    ${alias}.execution_state AS status,
    ${alias}.financial_status AS financial_status,
    ${alias}.reconciliation_state AS reconciliation_state,
    ${alias}.created_at AS created_at,
    ${alias}.updated_at AS updated_at`;
}

function attemptProjection(): string {
  return `
    a.id AS attempt_id,
    a.ordinal AS sequence,
    a.result_state AS status,
    a.response_started AS response_started,
    a.response_started_at AS response_started_at,
    a.result_http_status AS http_status,
    a.created_at AS created_at,
    a.updated_at AS updated_at`;
}

function usageProjection(): string {
  return `
    e.id AS usage_id,
    e.supply_mode AS supply_mode,
    e.input_total AS input_total,
    e.input_uncached AS input_uncached,
    e.cache_read AS cache_read,
    e.cache_write AS cache_write,
    e.cache_write_5m AS cache_write_5m,
    e.cache_write_1h AS cache_write_1h,
    e.output_total AS output_total,
    e.reasoning_output AS reasoning_output,
    e.status AS status,
    e.source AS source,
    e.measurement_kind AS measurement_kind,
    e.billable_basis AS billable_basis,
    e.created_at AS created_at`;
}

function decimalString(value: unknown): string {
  if (typeof value === 'bigint') return value >= 0n ? value.toString(10) : storage();
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  storage();
}

function nullableDecimalString(value: unknown): string | null {
  return value === null || value === undefined ? null : decimalString(value);
}

function protocol(value: unknown): ConsoleProtocol {
  return enumStorage(value, PROTOCOLS);
}

function mapRequest(row: Row): ConsoleRequest {
  const supplyMode = enumStorage(row.supply_mode, SUPPLY_MODES);
  const status = enumStorage(row.status, REQUEST_STATUSES);
  const financialStatus = enumStorage(row.financial_status, FINANCIAL_STATUSES);
  const reconciliationState = enumStorage(row.reconciliation_state, RECONCILIATION_STATES);
  if (
    (supplyMode === 'byok') !== (financialStatus === 'not_applicable') ||
    (status === 'unknown' && reconciliationState !== 'pending')
  ) storage();
  // Read persisted axes independently; success/resolved never implies settled.
  return {
    id: storageText(row.id),
    projectId: storageText(row.project_id),
    model: storageText(row.model, MAX_MODEL_LENGTH),
    protocol: protocol(row.protocol),
    supplyMode,
    status,
    financialStatus,
    reconciliationState,
    createdAt: storageDate(row.created_at),
    updatedAt: storageDate(row.updated_at),
  };
}

function mapAttempt(row: Row): ConsoleAttempt {
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1) storage();
  if (typeof row.response_started !== 'boolean') storage();
  if (
    row.http_status !== null &&
    row.http_status !== undefined &&
    (typeof row.http_status !== 'number' ||
      !Number.isSafeInteger(row.http_status) ||
      row.http_status < 100 ||
      row.http_status > 599)
  ) {
    storage();
  }
  return {
    id: storageText(row.attempt_id),
    sequence: row.sequence,
    status: enumStorage(row.status, REQUEST_STATUSES),
    responseStarted: row.response_started,
    responseStartedAt:
      row.response_started_at === null || row.response_started_at === undefined
        ? null
        : storageDate(row.response_started_at),
    httpStatus: row.http_status === null || row.http_status === undefined ? null : row.http_status,
    createdAt: storageDate(row.created_at),
    updatedAt: storageDate(row.updated_at),
  };
}

function mapUsageEvent(row: Row): ConsoleUsageEvent {
  return {
    id: storageText(row.usage_id),
    supplyMode: enumStorage(row.supply_mode, SUPPLY_MODES),
    inputTotal: nullableDecimalString(row.input_total),
    inputUncached: nullableDecimalString(row.input_uncached),
    cacheRead: nullableDecimalString(row.cache_read),
    cacheWrite: nullableDecimalString(row.cache_write),
    cacheWrite5m: nullableDecimalString(row.cache_write_5m),
    cacheWrite1h: nullableDecimalString(row.cache_write_1h),
    outputTotal: nullableDecimalString(row.output_total),
    reasoningOutput: nullableDecimalString(row.reasoning_output),
    status: enumStorage(row.status, USAGE_STATUSES),
    source: enumStorage(row.source, USAGE_SOURCES),
    measurementKind: enumStorage(row.measurement_kind, MEASUREMENT_KINDS),
    billableBasis: enumStorage(row.billable_basis, BILLABLE_BASES),
    createdAt: storageDate(row.created_at),
  };
}

function mapSummary(row: Row, range: NormalizedRange): ConsoleUsageSummary {
  return {
    from: range.from,
    to: range.to,
    requestCount: decimalString(row.request_count),
    eventCount: decimalString(row.event_count),
    inputTotal: decimalString(row.input_total),
    inputUncached: decimalString(row.input_uncached),
    cacheRead: decimalString(row.cache_read),
    cacheWrite: decimalString(row.cache_write),
    cacheWrite5m: decimalString(row.cache_write_5m),
    cacheWrite1h: decimalString(row.cache_write_1h),
    outputTotal: decimalString(row.output_total),
    reasoningOutput: decimalString(row.reasoning_output),
    totalTokens: decimalString(row.total_tokens),
  };
}

function mapSummaryBucket(row: Row, range: NormalizedRange): ConsoleUsageSummaryBucket {
  const summary = mapSummary(row, range);
  return {
    ...summary,
    periodStart: storageDate(row.period_start),
    projectId: storageText(row.project_id),
    model: storageText(row.model, MAX_MODEL_LENGTH),
    supplyMode: enumStorage(row.supply_mode, SUPPLY_MODES),
    status: enumStorage(row.status, REQUEST_STATUSES),
  };
}

function summaryProjection(): string {
  return `
    COUNT(DISTINCT e.request_id)::text AS request_count,
    COUNT(e.id)::text AS event_count,
    COALESCE(SUM(COALESCE(e.input_total, 0)), 0)::text AS input_total,
    COALESCE(SUM(COALESCE(e.input_uncached, 0)), 0)::text AS input_uncached,
    COALESCE(SUM(COALESCE(e.cache_read, 0)), 0)::text AS cache_read,
    COALESCE(SUM(COALESCE(e.cache_write, 0)), 0)::text AS cache_write,
    COALESCE(SUM(COALESCE(e.cache_write_5m, 0)), 0)::text AS cache_write_5m,
    COALESCE(SUM(COALESCE(e.cache_write_1h, 0)), 0)::text AS cache_write_1h,
    COALESCE(SUM(COALESCE(e.output_total, 0)), 0)::text AS output_total,
    COALESCE(SUM(COALESCE(e.reasoning_output, 0)), 0)::text AS reasoning_output,
    COALESCE(SUM(COALESCE(e.input_total, 0) + COALESCE(e.output_total, 0)), 0)::text AS total_tokens`;
}

function summaryBucketProjection(): string {
  return `
    date_trunc('day', e.created_at) AS period_start,
    r.project_id AS project_id,
    r.public_model AS model,
    r.supply_mode AS supply_mode,
    r.execution_state AS status,${summaryProjection()}`;
}

function page<Item>(rows: readonly Item[], limit: number, nextCursor: string | null): ConsolePage<Item> {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
  };
}

export class SaasConsoleUsageQueryService {
  constructor(private readonly database: ConsoleQueryDatabase) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('database must implement the read-only SaaS query contract');
    }
  }

  private async rows<T extends Row>(sql: string, values: readonly unknown[]): Promise<T[]> {
    try {
      const result = await this.database.query<T>(sql, values);
      if (!result || !Array.isArray(result.rows)) throw new Error('invalid query result');
      return result.rows;
    } catch {
      throw new SaasConsoleQueryError('CONSOLE_STORAGE_ERROR');
    }
  }

  async listRequests(input: ConsoleRequestListQuery): Promise<ConsolePage<ConsoleRequest>>;
  async listRequests(
    userId: string,
    tenantId: string,
    options?: ConsoleRequestListOptions,
  ): Promise<ConsolePage<ConsoleRequest>>;
  async listRequests(
    inputOrUserId: ConsoleRequestListQuery | string,
    tenantId?: string,
    options: ConsoleRequestListOptions = {},
  ): Promise<ConsolePage<ConsoleRequest>> {
    const input: ConsoleRequestListQuery =
      typeof inputOrUserId === 'string'
        ? { ...options, userId: inputOrUserId, tenantId: tenantId as string }
        : inputOrUserId;
    const normalized = normalizeRequestList(input);
    const params = new ParameterBuilder([normalized.userId, normalized.tenantId]);
    const predicates = [`r.tenant_id = $2`, tenantMembershipPredicate('r')];
    if (normalized.projectId !== undefined) predicates.push(projectMembershipPredicate('r'));
    addRequestFilters(params, normalized, predicates, 'r', 'r.created_at');
    if (normalized.cursor) {
      const createdAtParam = params.add(normalized.cursor.createdAt);
      const idParam = params.add(normalized.cursor.id);
      predicates.push(`(r.created_at, r.id) < (${createdAtParam}, ${idParam})`);
    }
    const limitParam = params.add(normalized.limit + 1);
    const sql = `SELECT ${requestProjection('r')}
      FROM saas_requests AS r
      WHERE ${predicates.join('\n        AND ')}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${limitParam}`;
    const resultRows = await this.rows(sql, params.values);
    const mapped = resultRows.map(mapRequest);
    const visible = mapped.slice(0, normalized.limit);
    const last = visible[visible.length - 1];
    const nextCursor =
      resultRows.length > normalized.limit && last
        ? encodeCursor({
            kind: 'requests',
            version: 1,
            filterHash: hashFilters('requests', normalized),
            createdAt: last.createdAt,
            id: last.id,
          })
        : null;
    return page(mapped, normalized.limit, nextCursor);
  }

  async getRequest(input: ConsoleRequestDetailQuery): Promise<ConsoleRequestDetail | null>;
  async getRequest(
    userId: string,
    tenantId: string,
    requestId: string,
    options?: ConsoleRequestDetailOptions,
  ): Promise<ConsoleRequestDetail | null>;
  async getRequest(tenantId: string, requestId: string, actor: ConsoleQueryScope): Promise<ConsoleRequestDetail | null>;
  async getRequest(
    inputOrFirst: ConsoleRequestDetailQuery | string,
    second?: string,
    third?: string | ConsoleQueryScope,
    fourth: ConsoleRequestDetailOptions = {},
  ): Promise<ConsoleRequestDetail | null> {
    let input: ConsoleRequestDetailQuery;
    if (typeof inputOrFirst !== 'string') {
      input = inputOrFirst;
    } else if (typeof third === 'string') {
      input = {
        userId: inputOrFirst,
        tenantId: second as string,
        requestId: third,
        ...fourth,
      };
    } else {
      const actor = third as ConsoleQueryScope;
      input = {
        userId: actor?.userId,
        tenantId: inputOrFirst,
        requestId: second as string,
        projectId: actor?.projectId,
      };
    }
    const normalized = normalizeRequestDetail(input);
    const baseParams = new ParameterBuilder([normalized.userId, normalized.tenantId, normalized.requestId]);
    const basePredicates = [
      `r.tenant_id = $2`,
      `r.id = $3`,
      tenantMembershipPredicate('r'),
      projectMembershipPredicate('r'),
    ];
    if (normalized.projectId !== undefined) {
      const projectParam = baseParams.add(normalized.projectId);
      basePredicates.push(`r.project_id = ${projectParam}`);
    }
    const baseRows = await this.rows(
      `SELECT ${requestProjection('r')}
       FROM saas_requests AS r
       WHERE ${basePredicates.join('\n         AND ')}
       LIMIT 1`,
      baseParams.values,
    );
    const baseRow = baseRows[0];
    if (!baseRow) return null;

    const childParams = [normalized.userId, normalized.tenantId, normalized.requestId];
    const attempts = await this.rows(
      `SELECT ${attemptProjection()}
       FROM saas_attempts AS a
       JOIN saas_requests AS r
         ON r.tenant_id = a.tenant_id
        AND r.id = a.request_id
       WHERE a.tenant_id = $2
         AND a.request_id = $3
         AND ${tenantMembershipPredicate('r')}
         AND ${projectMembershipPredicate('r')}
       ORDER BY a.ordinal ASC`,
      childParams,
    );
    const usageEvents = await this.rows(
      `SELECT ${usageProjection()}
       FROM saas_usage_events AS e
       JOIN saas_requests AS r
         ON r.tenant_id = e.tenant_id
        AND r.id = e.request_id
       WHERE e.tenant_id = $2
         AND e.request_id = $3
         AND ${tenantMembershipPredicate('r')}
         AND ${projectMembershipPredicate('r')}
       ORDER BY e.created_at ASC, e.id ASC`,
      childParams,
    );
    return {
      ...mapRequest(baseRow),
      attempts: attempts.map(mapAttempt),
      usageEvents: usageEvents.map(mapUsageEvent),
    };
  }

  async getRequestDetail(input: ConsoleRequestDetailQuery): Promise<ConsoleRequestDetail | null> {
    return this.getRequest(input);
  }

  async getUsageSummary(input: ConsoleUsageSummaryQuery): Promise<ConsoleUsageSummary | null>;
  async getUsageSummary(
    userId: string,
    tenantId: string,
    options: ConsoleUsageSummaryOptions,
  ): Promise<ConsoleUsageSummary | null>;
  async getUsageSummary(
    inputOrUserId: ConsoleUsageSummaryQuery | string,
    tenantId?: string,
    options?: ConsoleUsageSummaryOptions,
  ): Promise<ConsoleUsageSummary | null> {
    const input: ConsoleUsageSummaryQuery =
      typeof inputOrUserId === 'string'
        ? { ...(options as ConsoleUsageSummaryOptions), userId: inputOrUserId, tenantId: tenantId as string }
        : inputOrUserId;
    const normalized = normalizeUsageSummary(input);
    const params = new ParameterBuilder([normalized.userId, normalized.tenantId]);
    const projectParam = normalized.projectId === undefined ? undefined : params.add(normalized.projectId);
    const predicates = [`r.tenant_id = $2`];
    addRequestFilters(params, { ...normalized, range: null }, predicates, 'r', 'r.created_at');
    const eventFromParam = params.add(normalized.range.from);
    const eventToParam = params.add(normalized.range.to);
    const eventPredicates = [
      `e.tenant_id = r.tenant_id`,
      `e.request_id = r.id`,
      `e.created_at >= ${eventFromParam}`,
      `e.created_at < ${eventToParam}`,
    ];
    const sql = `${authorizedScopeCte(projectParam)}
      SELECT ${summaryProjection()}
      FROM authorized_scope AS auth
      LEFT JOIN saas_requests AS r
        ON ${predicates.join('\n       AND ')}
      LEFT JOIN saas_usage_events AS e
        ON ${eventPredicates.join('\n       AND ')}
      GROUP BY auth.user_id`;
    const rows = await this.rows(sql, params.values);
    const row = rows[0];
    return row ? mapSummary(row, normalized.range) : null;
  }

  async listUsageSummaries(input: ConsoleUsageSummaryListQuery): Promise<ConsolePage<ConsoleUsageSummaryBucket>>;
  async listUsageSummaries(
    userId: string,
    tenantId: string,
    options: ConsoleUsageSummaryListOptions,
  ): Promise<ConsolePage<ConsoleUsageSummaryBucket>>;
  async listUsageSummaries(
    inputOrUserId: ConsoleUsageSummaryListQuery | string,
    tenantId?: string,
    options?: ConsoleUsageSummaryListOptions,
  ): Promise<ConsolePage<ConsoleUsageSummaryBucket>> {
    const input: ConsoleUsageSummaryListQuery =
      typeof inputOrUserId === 'string'
        ? { ...(options as ConsoleUsageSummaryListOptions), userId: inputOrUserId, tenantId: tenantId as string }
        : inputOrUserId;
    const normalized = normalizeUsageList(input);
    const filterHash = hashFilters('usage', normalized);
    const params = new ParameterBuilder([normalized.userId, normalized.tenantId]);
    const projectParam = normalized.projectId === undefined ? undefined : params.add(normalized.projectId);
    const predicates = [`r.tenant_id = $2`];
    addRequestFilters(params, { ...normalized, range: null }, predicates, 'r', 'r.created_at');
    const fromParam = params.add(normalized.range.from);
    const toParam = params.add(normalized.range.to);
    predicates.push(`e.created_at >= ${fromParam}`, `e.created_at < ${toParam}`);
    if (normalized.cursor) {
      const periodParam = params.add(normalized.cursor.periodStart);
      const projectCursorParam = params.add(normalized.cursor.projectId);
      const modelCursorParam = params.add(normalized.cursor.model);
      const supplyCursorParam = params.add(normalized.cursor.supplyMode);
      const statusCursorParam = params.add(normalized.cursor.status);
      predicates.push(
        `(date_trunc('day', e.created_at), r.project_id, r.public_model, r.supply_mode, r.execution_state) < (${periodParam}, ${projectCursorParam}, ${modelCursorParam}, ${supplyCursorParam}, ${statusCursorParam})`,
      );
    }
    const limitParam = params.add(normalized.limit + 1);
    const sql = `${authorizedScopeCte(projectParam)}
      SELECT ${summaryBucketProjection()}
      FROM authorized_scope AS auth
      JOIN saas_requests AS r
        ON r.tenant_id = $2
      JOIN saas_usage_events AS e
        ON e.tenant_id = r.tenant_id
       AND e.request_id = r.id
      WHERE ${predicates.join('\n        AND ')}
      GROUP BY date_trunc('day', e.created_at), r.project_id, r.public_model, r.supply_mode, r.execution_state
      ORDER BY date_trunc('day', e.created_at) DESC,
               r.project_id DESC,
               r.public_model DESC,
               r.supply_mode DESC,
               r.execution_state DESC
      LIMIT ${limitParam}`;
    const resultRows = await this.rows(sql, params.values);
    const mapped = resultRows.map((row) => mapSummaryBucket(row, normalized.range));
    const visible = mapped.slice(0, normalized.limit);
    const last = visible[visible.length - 1];
    const nextCursor =
      resultRows.length > normalized.limit && last
        ? encodeCursor({
            kind: 'usage',
            version: 1,
            filterHash,
            periodStart: last.periodStart,
            projectId: last.projectId,
            model: last.model,
            supplyMode: last.supplyMode,
            status: last.status,
          })
        : null;
    return page(mapped, normalized.limit, nextCursor);
  }

  async getUsage(input: ConsoleUsageSummaryQuery): Promise<ConsoleUsageSummary | null> {
    return this.getUsageSummary(input);
  }
}

export const CONSOLE_DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const CONSOLE_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
export const CONSOLE_MAX_TIME_RANGE_MS = MAX_TIME_RANGE_MS;

export const ConsoleUsageQueryService = SaasConsoleUsageQueryService;
export const CustomerUsageQueryService = SaasConsoleUsageQueryService;
