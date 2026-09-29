import { createHash } from 'node:crypto';
import { normalizeCurrency, parseStoredMinorUnits } from '../billing/money.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { TenantContext } from '../identity/types.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_PREFIX = 'r1.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;

type QueryRow = Record<string, unknown>;

interface RefundCursor {
  readonly kind: 'customer-refunds';
  readonly version: 1;
  readonly scopeHash: string;
  readonly createdAt: string;
  readonly id: string;
}

interface RefundRow extends QueryRow {
  readonly id: unknown;
  readonly refund_type: unknown;
  readonly original_order_id: unknown;
  readonly amount_minor_units: unknown;
  readonly currency: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly completed_at: unknown;
}

export type CustomerRefundType = 'wallet_topup' | 'byok_service_plan';
export type CustomerRefundStatus = 'submitting' | 'pending' | 'succeeded' | 'failed' | 'unknown' | 'blocked';

export type CustomerRefundQueryErrorCode =
  | 'CUSTOMER_REFUND_QUERY_INVALID_INPUT'
  | 'CUSTOMER_REFUND_QUERY_ACCESS_DENIED'
  | 'CUSTOMER_REFUND_QUERY_STORAGE_ERROR';

const ERROR_DETAILS: Record<CustomerRefundQueryErrorCode, { readonly status: number; readonly message: string }> = {
  CUSTOMER_REFUND_QUERY_INVALID_INPUT: {
    status: 400,
    message: 'The customer refund query contains invalid data.',
  },
  CUSTOMER_REFUND_QUERY_ACCESS_DENIED: {
    status: 403,
    message: 'The tenant role cannot view refund history.',
  },
  CUSTOMER_REFUND_QUERY_STORAGE_ERROR: {
    status: 500,
    message: 'The customer refund query could not be completed.',
  },
};

export class CustomerRefundQueryError extends Error {
  readonly status: number;
  readonly code: CustomerRefundQueryErrorCode;

  constructor(code: CustomerRefundQueryErrorCode) {
    super(ERROR_DETAILS[code].message);
    this.name = 'CustomerRefundQueryError';
    this.status = ERROR_DETAILS[code].status;
    this.code = code;
  }
}

export interface CustomerRefundQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
}

export type CustomerRefundQueryContext = Pick<TenantContext, 'userId' | 'tenantId' | 'tenantRole'>;

export interface RefundSummary {
  readonly id: string;
  readonly refundType: CustomerRefundType;
  readonly originalOrderId: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly status: CustomerRefundStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CustomerRefundHistoryPage {
  readonly items: readonly RefundSummary[];
  readonly nextCursor: string | null;
}

export type CustomerRefundQueryDatabase = Pick<SaasDatabase, 'transaction'>;

function invalid(): never {
  throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_INVALID_INPUT');
}

function storage(): never {
  throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_STORAGE_ERROR');
}

function isBillingTenantRole(
  value: unknown,
): value is Extract<TenantContext['tenantRole'], 'owner' | 'admin' | 'billing'> {
  return value === 'owner' || value === 'admin' || value === 'billing';
}

function normalizeContext(value: unknown): CustomerRefundQueryContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_ACCESS_DENIED');
  }
  const context = value as Partial<TenantContext>;
  if (
    typeof context.userId !== 'string' ||
    context.userId.trim() === '' ||
    typeof context.tenantId !== 'string' ||
    context.tenantId.trim() === '' ||
    !isBillingTenantRole(context.tenantRole)
  ) {
    throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_ACCESS_DENIED');
  }
  return { userId: context.userId, tenantId: context.tenantId, tenantRole: context.tenantRole };
}

function normalizeQuery(value: unknown): { readonly limit: number; readonly cursor: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'cursor' && key !== 'limit')) invalid();

  const limit = candidate.limit === undefined ? DEFAULT_PAGE_SIZE : candidate.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid();
  const cursor = candidate.cursor === undefined || candidate.cursor === null ? null : candidate.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)) {
    invalid();
  }
  return { limit, cursor };
}

function scopeHash(context: Pick<CustomerRefundQueryContext, 'userId' | 'tenantId'>): string {
  return createHash('sha256')
    .update(JSON.stringify(['customer-refunds', context.userId, context.tenantId]), 'utf8')
    .digest('hex');
}

function encodeCursor(value: RefundCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function decodeCursor(value: string | null, expectedScopeHash: string): RefundCursor | null {
  if (value === null) return null;
  if (value.length > MAX_CURSOR_LENGTH || !value.startsWith(CURSOR_PREFIX)) invalid();

  let candidate: unknown;
  try {
    const encoded = value.slice(CURSOR_PREFIX.length);
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== encoded) invalid();
    candidate = JSON.parse(json);
  } catch {
    return invalid();
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid();
  const row = candidate as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'createdAt,id,kind,scopeHash,version' ||
    row.kind !== 'customer-refunds' ||
    row.version !== 1 ||
    row.scopeHash !== expectedScopeHash ||
    typeof row.createdAt !== 'string' ||
    row.createdAt.length > 64 ||
    !UTC_TIMESTAMP_PATTERN.test(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id)
  ) {
    invalid();
  }
  return {
    kind: 'customer-refunds',
    version: 1,
    scopeHash: expectedScopeHash,
    createdAt: row.createdAt,
    id: row.id,
  };
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) storage();
  return value;
}

function storedTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) storage();
    return value.toISOString();
  }
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    storage();
  }
  return value;
}

function nullableStoredTimestamp(value: unknown): string | null {
  return value === null ? null : storedTimestamp(value);
}

function mapRefund(row: RefundRow): RefundSummary {
  if (row.refund_type !== 'wallet_topup' && row.refund_type !== 'byok_service_plan') storage();
  const refundType = row.refund_type as CustomerRefundType;
  if (
    row.state !== 'submitting' &&
    row.state !== 'pending' &&
    row.state !== 'succeeded' &&
    row.state !== 'failed' &&
    row.state !== 'unknown' &&
    row.state !== 'blocked'
  ) {
    storage();
  }
  let amount: bigint;
  let currency: string;
  try {
    amount = parseStoredMinorUnits(row.amount_minor_units);
    currency = normalizeCurrency(row.currency);
  } catch {
    return storage();
  }
  if (amount < 1n) storage();

  return {
    id: storedUuid(row.id),
    refundType,
    originalOrderId: storedUuid(row.original_order_id),
    amountMinorUnits: amount.toString(),
    currency,
    status: row.state,
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    completedAt: nullableStoredTimestamp(row.completed_at),
  };
}

async function refundRows(
  executor: SqlExecutor,
  tenantId: string,
  cursor: RefundCursor | null,
  limit: number,
): Promise<RefundRow[]> {
  const values: unknown[] = [tenantId];
  const cursorFilter = cursor
    ? (() => {
        values.push(cursor.createdAt, cursor.id);
        return 'AND (created_at, id) < ($2::timestamptz, $3::uuid)';
      })()
    : '';
  values.push(limit + 1);
  const result = await executor.query<RefundRow>(
    `SELECT id::text AS id,
            refund_type,
            COALESCE(wallet_topup_order_id, service_plan_order_id)::text AS original_order_id,
            amount_minor_units::text AS amount_minor_units,
            currency,
            state,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
            CASE WHEN completed_at IS NULL THEN NULL
              ELSE to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS completed_at
     FROM saas_refund_orders
     WHERE tenant_id = $1
       ${cursorFilter}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  if (!result || !Array.isArray(result.rows)) storage();
  return result.rows;
}

async function verifyCurrentBillingContext(executor: SqlExecutor, context: CustomerRefundQueryContext): Promise<void> {
  const result = await executor.query<{ readonly tenant_id: unknown; readonly tenant_role: unknown }>(
    `SELECT t.id AS tenant_id, m.role AS tenant_role
     FROM saas_tenants t
     JOIN saas_memberships m ON m.tenant_id = t.id
     JOIN saas_users u ON u.id = m.user_id
     WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'
       AND t.status = 'active' AND u.disabled_at IS NULL
     LIMIT 1`,
    [context.tenantId, context.userId],
  );
  if (!result || !Array.isArray(result.rows)) storage();
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.tenant_id !== context.tenantId || !isBillingTenantRole(row?.tenant_role)) {
    throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_ACCESS_DENIED');
  }
}

export class SaasCustomerRefundQueryService {
  constructor(private readonly database: CustomerRefundQueryDatabase) {
    if (!database || typeof database.transaction !== 'function') {
      throw new TypeError('database must implement the SaaS transaction contract');
    }
  }

  async listRefunds(
    contextInput: CustomerRefundQueryContext,
    queryInput: CustomerRefundQuery,
  ): Promise<CustomerRefundHistoryPage> {
    const context = normalizeContext(contextInput);
    const query = normalizeQuery(queryInput);
    const hash = scopeHash(context);
    const cursor = decodeCursor(query.cursor, hash);

    try {
      return await this.database.transaction(async (executor) => {
        await executor.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await verifyCurrentBillingContext(executor, context);
        const rows = await refundRows(executor, context.tenantId, cursor, query.limit);
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit).map(mapRefund);
        const lastItem = items.at(-1);
        return {
          items,
          nextCursor:
            hasMore && lastItem
              ? encodeCursor({
                  kind: 'customer-refunds',
                  version: 1,
                  scopeHash: hash,
                  createdAt: lastItem.createdAt,
                  id: lastItem.id,
                })
              : null,
        };
      });
    } catch (error) {
      if (error instanceof CustomerRefundQueryError) throw error;
      throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_STORAGE_ERROR');
    }
  }
}
