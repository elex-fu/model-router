import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PlatformAuditQueryError } from './errors.js';
import type {
  PlatformAuditDateInput,
  PlatformAuditEventRecord,
  PlatformAuditHistoryListQuery,
  PlatformAuditHistoryPage,
  PlatformAuditQueryDatabase,
  PlatformAuditQueryServiceOptions,
} from './types.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_PREFIX = 'pah1.';
const MAX_UUID_LENGTH = 36;
const MAX_ACTION_LENGTH = 128;
const MAX_ENTITY_TYPE_LENGTH = 128;
const MAX_TARGET_ID_LENGTH = 512;
const MAX_ENTRY_POINT_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_DATE_INPUT_LENGTH = 128;
const MAX_TIME_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

const QUERY_KEYS = new Set([
  'actorId',
  'action',
  'entityType',
  'createdFrom',
  'createdTo',
  'from',
  'to',
  'cursor',
  'limit',
  'pageSize',
]);

const CURSOR_KEYS = new Set(['version', 'filterHash', 'occurredAt', 'id']);

/** A process-local fallback keeps the service usable in tests and local tools. */
const PROCESS_CURSOR_SECRET = randomBytes(32);

function hasSafeTextCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && code !== 0x7f;
  });
}

interface AuditRow {
  readonly id: unknown;
  readonly tenant_id: unknown;
  readonly actor_user_id: unknown;
  readonly action: unknown;
  readonly target_type: unknown;
  readonly target_id: unknown;
  readonly occurred_at: unknown;
  readonly entry_point: unknown;
  readonly request_id: unknown;
}

interface AuditCursor {
  readonly version: 1;
  readonly filterHash: string;
  readonly occurredAt: string;
  readonly id: string;
}

interface NormalizedFilters {
  readonly actorId?: string;
  readonly action?: string;
  readonly entityType?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
}

interface NormalizedList {
  readonly filters: NormalizedFilters;
  readonly filterHash: string;
  readonly limit: number;
  readonly cursor: AuditCursor | null;
}

class ParameterBuilder {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function invalid(): never {
  throw new PlatformAuditQueryError('AUDIT_INVALID_INPUT');
}

function storage(): never {
  throw new PlatformAuditQueryError('AUDIT_STORAGE_ERROR');
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !QUERY_KEYS.has(key)) invalid();
  }
  return candidate;
}

function exactObjectKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) invalid();
}

function inputUuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== MAX_UUID_LENGTH || !UUID_PATTERN.test(value)) invalid();
  return value.toLowerCase();
}

function optionalInputUuid(value: unknown): string | undefined {
  return value === undefined ? undefined : inputUuid(value);
}

function inputAction(value: unknown, maxLength = MAX_ACTION_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !ACTION_PATTERN.test(value)) {
    invalid();
  }
  return value;
}

function optionalInputAction(value: unknown): string | undefined {
  return value === undefined ? undefined : inputAction(value);
}

function inputEntityType(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENTITY_TYPE_LENGTH ||
    !hasSafeTextCharacters(value)
  ) {
    invalid();
  }
  if (value.trim() !== value) invalid();
  return value;
}

function optionalInputEntityType(value: unknown): string | undefined {
  return value === undefined ? undefined : inputEntityType(value);
}

function checkCalendarDate(year: number, month: number, day: number): void {
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) invalid();
}

function normalizeDate(value: PlatformAuditDateInput | unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalid();
    return value.toISOString();
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DATE_INPUT_LENGTH) invalid();
  const match = ISO_DATE_INPUT.exec(value);
  if (!match) invalid();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  checkCalendarDate(year, month, day);

  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) invalid();

    if (match[8] !== 'Z') {
      const offsetHour = Number(match[10]);
      const offsetMinute = Number(match[11]);
      if (offsetHour > 23 || offsetMinute > 59) invalid();
    }
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid();
  return new Date(parsed).toISOString();
}

function selectDateAlias(candidate: Record<string, unknown>, primary: string, alias: string): unknown {
  if (candidate[primary] !== undefined && candidate[alias] !== undefined) invalid();
  return candidate[primary] === undefined ? candidate[alias] : candidate[primary];
}

function normalizeRange(candidate: Record<string, unknown>): Pick<NormalizedFilters, 'createdFrom' | 'createdTo'> {
  const fromValue = selectDateAlias(candidate, 'createdFrom', 'from');
  const toValue = selectDateAlias(candidate, 'createdTo', 'to');
  if (fromValue === undefined && toValue === undefined) return {};

  const createdFrom = fromValue === undefined ? undefined : normalizeDate(fromValue);
  const createdTo = toValue === undefined ? undefined : normalizeDate(toValue);
  if (createdFrom !== undefined && createdTo !== undefined) {
    const fromMs = Date.parse(createdFrom);
    const toMs = Date.parse(createdTo);
    if (fromMs >= toMs || toMs - fromMs > MAX_TIME_RANGE_MS) invalid();
  }
  return {
    ...(createdFrom === undefined ? {} : { createdFrom }),
    ...(createdTo === undefined ? {} : { createdTo }),
  };
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

function hashFilters(filters: NormalizedFilters): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'platform-audit-history',
        filters.actorId ?? null,
        filters.action ?? null,
        filters.entityType ?? null,
        filters.createdFrom ?? null,
        filters.createdTo ?? null,
      ]),
      'utf8',
    )
    .digest('hex');
}

function cursorPayload(cursor: AuditCursor): string {
  return JSON.stringify({
    version: cursor.version,
    filterHash: cursor.filterHash,
    occurredAt: cursor.occurredAt,
    id: cursor.id,
  });
}

function sign(secret: Uint8Array, payload: string): string {
  return createHmac('sha256', secret).update(`${CURSOR_PREFIX}${payload}`, 'utf8').digest('hex');
}

function encodeCursor(secret: Uint8Array, cursor: AuditCursor): string {
  const payload = Buffer.from(cursorPayload(cursor), 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}${payload}.${sign(secret, Buffer.from(cursorPayload(cursor), 'utf8').toString('base64url'))}`;
}

function decodeCursor(secret: Uint8Array, value: unknown, filterHash: string): AuditCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) invalid();
  if (!value.startsWith(CURSOR_PREFIX)) invalid();
  const body = value.slice(CURSOR_PREFIX.length);
  const separator = body.lastIndexOf('.');
  if (separator <= 0 || separator === body.length - 1) invalid();
  const encodedPayload = body.slice(0, separator);
  const suppliedSignature = body.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[0-9a-f]{64}$/.test(suppliedSignature)) invalid();

  const expectedSignature = sign(secret, encodedPayload);
  const expectedBytes = Buffer.from(expectedSignature, 'hex');
  const suppliedBytes = Buffer.from(suppliedSignature, 'hex');
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) invalid();

  let candidate: unknown;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url');
    if (decoded.length === 0 || decoded.toString('base64url') !== encodedPayload) invalid();
    candidate = JSON.parse(decoded.toString('utf8'));
  } catch {
    invalid();
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) invalid();
  const object = candidate as Record<string, unknown>;
  exactObjectKeys(object, CURSOR_KEYS);
  if (object.version !== 1 || object.filterHash !== filterHash) invalid();
  if (typeof object.filterHash !== 'string' || !/^[0-9a-f]{64}$/.test(object.filterHash)) invalid();

  const occurredAt = normalizeDate(object.occurredAt);
  const id = inputUuid(object.id);
  if (occurredAt !== object.occurredAt || id !== object.id) invalid();
  return { version: 1, filterHash, occurredAt, id };
}

function normalizeList(input: PlatformAuditHistoryListQuery | undefined, secret: Uint8Array): NormalizedList {
  const candidate = objectInput(input);
  const filters: NormalizedFilters = {
    ...(candidate.actorId === undefined ? {} : { actorId: optionalInputUuid(candidate.actorId) }),
    ...(candidate.action === undefined ? {} : { action: optionalInputAction(candidate.action) }),
    ...(candidate.entityType === undefined ? {} : { entityType: optionalInputEntityType(candidate.entityType) }),
    ...normalizeRange(candidate),
  };
  const filterHash = hashFilters(filters);
  return {
    filters,
    filterHash,
    limit: normalizeLimit(candidate),
    cursor: decodeOptionalCursor(secret, candidate.cursor, filterHash),
  };
}

function decodeOptionalCursor(secret: Uint8Array, value: unknown, filterHash: string): AuditCursor | null {
  return value === undefined || value === null ? null : decodeCursor(secret, value, filterHash);
}

function storedText(value: unknown, maxLength: number, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !hasSafeTextCharacters(value)
  ) {
    storage();
  }
  return value;
}

function storedUuid(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length !== MAX_UUID_LENGTH || !UUID_PATTERN.test(value)) storage();
  return value.toLowerCase();
}

function storedAction(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACTION_LENGTH ||
    !ACTION_PATTERN.test(value)
  ) {
    storage();
  }
  return value;
}

function storedEntityType(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENTITY_TYPE_LENGTH ||
    value.trim() !== value ||
    !hasSafeTextCharacters(value)
  ) {
    storage();
  }
  return value;
}

function storedTimestamp(value: unknown): string {
  try {
    return normalizeDate(value as PlatformAuditDateInput);
  } catch (error) {
    if (error instanceof PlatformAuditQueryError && error.code === 'AUDIT_INVALID_INPUT') storage();
    throw error;
  }
}

function mapRow(row: AuditRow): PlatformAuditEventRecord {
  if (row === null || typeof row !== 'object') storage();
  return {
    id: storedUuid(row.id, false) as string,
    tenantId: storedUuid(row.tenant_id, true),
    actorId: storedUuid(row.actor_user_id, true),
    action: storedAction(row.action),
    entityType: storedEntityType(row.target_type),
    entityId: storedText(row.target_id, MAX_TARGET_ID_LENGTH, true),
    occurredAt: storedTimestamp(row.occurred_at),
    entryPoint: storedText(row.entry_point, MAX_ENTRY_POINT_LENGTH, false) as string,
    requestId: storedText(row.request_id, MAX_REQUEST_ID_LENGTH, true),
  };
}

function storageFromUnknown(error: unknown): never {
  if (error instanceof PlatformAuditQueryError) throw error;
  return storage();
}

function secretBytes(options: PlatformAuditQueryServiceOptions | string | Uint8Array | undefined): Uint8Array {
  if (options === undefined) return PROCESS_CURSOR_SECRET;
  const secret =
    typeof options === 'string' || options instanceof Uint8Array
      ? options
      : options.cursorSecret === undefined
        ? undefined
        : options.cursorSecret;
  if (secret === undefined) return PROCESS_CURSOR_SECRET;
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (bytes.length < 16 || bytes.length > 4096) {
    throw new TypeError('cursorSecret must contain between 16 and 4096 bytes');
  }
  return bytes;
}

export class PlatformAuditHistoryQueryService {
  private readonly cursorSecret: Uint8Array;

  constructor(
    private readonly database: PlatformAuditQueryDatabase,
    options?: PlatformAuditQueryServiceOptions | string | Uint8Array,
  ) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('database must implement the read-only platform audit query contract');
    }
    this.cursorSecret = secretBytes(options);
  }

  async list(input: PlatformAuditHistoryListQuery = {}): Promise<PlatformAuditHistoryPage> {
    const normalized = normalizeList(input, this.cursorSecret);
    const params = new ParameterBuilder();
    const predicates: string[] = [];

    if (normalized.filters.actorId !== undefined) {
      predicates.push(`a.actor_user_id = ${params.add(normalized.filters.actorId)}`);
    }
    if (normalized.filters.action !== undefined) {
      predicates.push(`a.action = ${params.add(normalized.filters.action)}`);
    }
    if (normalized.filters.entityType !== undefined) {
      predicates.push(`a.target_type = ${params.add(normalized.filters.entityType)}`);
    }
    if (normalized.filters.createdFrom !== undefined) {
      predicates.push(`a.occurred_at >= ${params.add(normalized.filters.createdFrom)}`);
    }
    if (normalized.filters.createdTo !== undefined) {
      predicates.push(`a.occurred_at < ${params.add(normalized.filters.createdTo)}`);
    }
    if (normalized.cursor !== null) {
      const cursorTime = params.add(normalized.cursor.occurredAt);
      const cursorId = params.add(normalized.cursor.id);
      predicates.push(`(a.occurred_at, a.id) < (${cursorTime}, ${cursorId})`);
    }

    const limit = params.add(normalized.limit + 1);
    const sql = `SELECT a.id, a.tenant_id, a.actor_user_id, a.action,
       a.target_type, a.target_id, a.occurred_at, a.entry_point, a.request_id
      FROM saas_audit_events AS a
      ${predicates.length === 0 ? '' : `WHERE ${predicates.join('\n        AND ')}`}
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT ${limit}`;

    try {
      const result = await this.database.query<AuditRow>(sql, params.values);
      if (!result || !Array.isArray(result.rows)) storage();
      const mapped = result.rows.map(mapRow);
      const visible = mapped.slice(0, normalized.limit);
      const hasMore = mapped.length > normalized.limit;
      const last = visible[visible.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor(this.cursorSecret, {
              version: 1,
              filterHash: normalized.filterHash,
              occurredAt: last.occurredAt,
              id: last.id,
            })
          : null;
      return { items: visible, hasMore, nextCursor };
    } catch (error) {
      return storageFromUnknown(error);
    }
  }

  async listAuditEvents(input: PlatformAuditHistoryListQuery = {}): Promise<PlatformAuditHistoryPage> {
    return this.list(input);
  }

  async listEvents(input: PlatformAuditHistoryListQuery = {}): Promise<PlatformAuditHistoryPage> {
    return this.list(input);
  }

  async listHistory(input: PlatformAuditHistoryListQuery = {}): Promise<PlatformAuditHistoryPage> {
    return this.list(input);
  }
}

export const PlatformAuditQueryService = PlatformAuditHistoryQueryService;
export const SaasPlatformAuditHistoryQueryService = PlatformAuditHistoryQueryService;
export const SaasPlatformAuditQueryService = PlatformAuditHistoryQueryService;

export const PLATFORM_AUDIT_DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const PLATFORM_AUDIT_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
export const PLATFORM_AUDIT_MAX_TIME_RANGE_MS = MAX_TIME_RANGE_MS;
export const PLATFORM_AUDIT_CURSOR_PREFIX = CURSOR_PREFIX;
