import { createHash } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { TenantContext } from '../identity/types.js';
import { isSaasBillingError, SaasBillingError } from './errors.js';
import { normalizeCurrency, parseStoredMinorUnits } from './money.js';
import { PlatformWalletLedgerService } from './service.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_PREFIX = 'w1.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QueryRow = Record<string, unknown>;

interface NormalizedContext {
  readonly userId: string;
  readonly tenantId: string;
}

interface WalletLedgerCursor {
  readonly kind: 'wallet-ledger';
  readonly version: 1;
  readonly filterHash: string;
  readonly createdAt: string;
  readonly id: string;
}

interface WalletLedgerRow extends QueryRow {
  readonly id: unknown;
  readonly transaction_id: unknown;
  readonly currency: unknown;
  readonly direction: unknown;
  readonly amount_minor_units: unknown;
  readonly created_at: unknown;
  readonly source_type: unknown;
}

export type CustomerWalletQueryErrorCode =
  | 'CUSTOMER_WALLET_INVALID_INPUT'
  | 'CUSTOMER_WALLET_ACCESS_DENIED'
  | 'CUSTOMER_WALLET_NOT_FOUND'
  | 'CUSTOMER_WALLET_STORAGE_ERROR';

const ERROR_DETAILS: Record<CustomerWalletQueryErrorCode, { readonly status: number; readonly message: string }> = {
  CUSTOMER_WALLET_INVALID_INPUT: {
    status: 400,
    message: 'The customer wallet query contains invalid data.',
  },
  CUSTOMER_WALLET_ACCESS_DENIED: {
    status: 403,
    message: 'The tenant role cannot view the platform wallet.',
  },
  CUSTOMER_WALLET_NOT_FOUND: {
    status: 404,
    message: 'The platform wallet is not available for this tenant and currency.',
  },
  CUSTOMER_WALLET_STORAGE_ERROR: {
    status: 500,
    message: 'The customer wallet query could not be completed.',
  },
};

export class CustomerWalletQueryError extends Error {
  readonly status: number;
  readonly code: CustomerWalletQueryErrorCode;

  constructor(code: CustomerWalletQueryErrorCode) {
    super(ERROR_DETAILS[code].message);
    this.name = 'CustomerWalletQueryError';
    this.status = ERROR_DETAILS[code].status;
    this.code = code;
  }
}

export interface CustomerWalletQuery {
  readonly currency: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface CustomerWalletLedgerEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly currency: string;
  readonly direction: 'credit' | 'debit';
  readonly amountMinorUnits: string;
  readonly type: 'top_up' | 'usage_charge';
  readonly createdAt: string;
}

export interface CustomerWalletSnapshot {
  readonly wallet: {
    readonly currency: string;
    readonly postedBalanceMinorUnits: string;
    readonly activeHoldsMinorUnits: string;
    readonly frozenAmountMinorUnits: string;
    readonly availableMinorUnits: string;
    readonly spendingFrozen: boolean;
  };
  readonly ledger: {
    readonly items: readonly CustomerWalletLedgerEntry[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

export type CustomerWalletQueryDatabase = Pick<SaasDatabase, 'transaction'>;

function invalid(): never {
  throw new CustomerWalletQueryError('CUSTOMER_WALLET_INVALID_INPUT');
}

function storage(): never {
  throw new CustomerWalletQueryError('CUSTOMER_WALLET_STORAGE_ERROR');
}

function normalizeContext(value: unknown): NormalizedContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CustomerWalletQueryError('CUSTOMER_WALLET_ACCESS_DENIED');
  }
  const context = value as Partial<TenantContext>;
  if (
    typeof context.userId !== 'string' ||
    context.userId.trim() === '' ||
    typeof context.tenantId !== 'string' ||
    context.tenantId.trim() === ''
  ) {
    throw new CustomerWalletQueryError('CUSTOMER_WALLET_ACCESS_DENIED');
  }
  if (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') {
    throw new CustomerWalletQueryError('CUSTOMER_WALLET_ACCESS_DENIED');
  }
  return { userId: context.userId, tenantId: context.tenantId };
}

function normalizeInput(value: unknown): {
  readonly currency: string;
  readonly limit: number;
  readonly cursor?: unknown;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  let currency: string;
  try {
    currency = normalizeCurrency(candidate.currency);
  } catch {
    return invalid();
  }

  const limit = candidate.limit === undefined ? DEFAULT_PAGE_SIZE : candidate.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid();
  const cursor = candidate.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH)) {
    invalid();
  }
  return { currency, limit, ...(cursor === undefined ? {} : { cursor }) };
}

function filterHash(context: NormalizedContext, currency: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['wallet-ledger', context.userId, context.tenantId, currency]), 'utf8')
    .digest('hex');
}

function encodeCursor(value: WalletLedgerCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255) storage();
  return value;
}

function storedTimestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  if (!parsed || !Number.isFinite(parsed.getTime())) storage();
  return parsed.toISOString();
}

function decodeCursor(value: unknown, expectedFilterHash: string): WalletLedgerCursor | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    !value.startsWith(CURSOR_PREFIX)
  ) {
    invalid();
  }

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
    row.kind !== 'wallet-ledger' ||
    row.version !== 1 ||
    row.filterHash !== expectedFilterHash ||
    typeof row.createdAt !== 'string' ||
    row.createdAt.length > 128 ||
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id)
  ) {
    invalid();
  }
  const parsed = Date.parse(row.createdAt);
  if (!Number.isFinite(parsed)) invalid();
  return {
    kind: 'wallet-ledger',
    version: 1,
    filterHash: expectedFilterHash,
    createdAt: new Date(parsed).toISOString(),
    id: row.id,
  };
}

function mapLedgerEntry(row: WalletLedgerRow, expectedCurrency: string): CustomerWalletLedgerEntry {
  const direction = row.direction;
  const sourceType = row.source_type;
  if (
    row.currency !== expectedCurrency ||
    (direction !== 'credit' && direction !== 'debit') ||
    (sourceType !== 'wallet_funding' && sourceType !== 'billing_settlement')
  ) {
    storage();
  }
  let amount: bigint;
  try {
    amount = parseStoredMinorUnits(row.amount_minor_units);
  } catch {
    return storage();
  }
  if (amount < 1n) storage();
  return {
    id: storedText(row.id),
    transactionId: storedText(row.transaction_id),
    currency: expectedCurrency,
    direction,
    amountMinorUnits: amount.toString(),
    type: sourceType === 'wallet_funding' ? 'top_up' : 'usage_charge',
    createdAt: storedTimestamp(row.created_at),
  };
}

async function ledgerRows(
  executor: SqlExecutor,
  context: NormalizedContext,
  walletId: string,
  currency: string,
  cursor: WalletLedgerCursor | null,
  limit: number,
): Promise<WalletLedgerRow[]> {
  const values: unknown[] = [context.tenantId, walletId, currency];
  const cursorFilter = cursor
    ? (() => {
        values.push(cursor.createdAt, cursor.id);
        return `(e.created_at, e.id) < ($4::timestamptz, $5::uuid)`;
      })()
    : '';
  values.push(limit + 1);
  const result = await executor.query<WalletLedgerRow>(
    `SELECT e.id, e.transaction_id, e.currency, e.direction, e.amount_minor_units::text AS amount_minor_units,
            e.created_at, t.source_type
     FROM saas_ledger_entries AS e
     JOIN saas_ledger_transactions AS t
       ON t.id = e.transaction_id AND t.tenant_id = e.tenant_id AND t.currency = e.currency
     WHERE e.tenant_id = $1 AND e.wallet_id = $2 AND e.currency = $3 AND e.account_type = 'wallet'
       ${cursorFilter ? `AND ${cursorFilter}` : ''}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $${values.length}`,
    values,
  );
  if (!result || !Array.isArray(result.rows)) storage();
  return result.rows;
}

export class SaasCustomerWalletQueryService {
  constructor(
    private readonly database: CustomerWalletQueryDatabase,
    private readonly walletLedger: Pick<PlatformWalletLedgerService, 'getWallet'> = new PlatformWalletLedgerService(),
  ) {
    if (!database || typeof database.transaction !== 'function') {
      throw new TypeError('database must implement the SaaS transaction contract');
    }
  }

  async getWallet(contextInput: TenantContext, queryInput: CustomerWalletQuery): Promise<CustomerWalletSnapshot> {
    const context = normalizeContext(contextInput);
    const query = normalizeInput(queryInput);
    const hash = filterHash(context, query.currency);
    const cursor = decodeCursor(query.cursor, hash);

    try {
      return await this.database.transaction(async (executor) => {
        await executor.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const wallet = await this.walletLedger.getWallet(executor, context.tenantId, query.currency);
        const rows = await ledgerRows(executor, context, wallet.id, query.currency, cursor, query.limit);
        const hasMore = rows.length > query.limit;
        const pageRows = rows.slice(0, query.limit);
        const items = pageRows.map((row) => mapLedgerEntry(row, query.currency));
        const lastRow = pageRows.at(-1);
        const nextCursor =
          hasMore && lastRow
            ? encodeCursor({
                kind: 'wallet-ledger',
                version: 1,
                filterHash: hash,
                createdAt: storedTimestamp(lastRow.created_at),
                id: storedText(lastRow.id),
              })
            : null;
        const frozenAmount = wallet.spendingFrozen ? wallet.availableMinorUnits : 0n;
        const availableAmount = wallet.spendingFrozen ? 0n : wallet.availableMinorUnits;

        return {
          wallet: {
            currency: wallet.currency,
            postedBalanceMinorUnits: wallet.postedBalanceMinorUnits.toString(),
            activeHoldsMinorUnits: wallet.activeHoldsMinorUnits.toString(),
            frozenAmountMinorUnits: frozenAmount.toString(),
            availableMinorUnits: availableAmount.toString(),
            spendingFrozen: wallet.spendingFrozen,
          },
          ledger: { items, nextCursor, hasMore },
        };
      });
    } catch (error) {
      if (error instanceof CustomerWalletQueryError) throw error;
      if (isSaasBillingError(error) && error.code === 'WALLET_NOT_FOUND') {
        throw new CustomerWalletQueryError('CUSTOMER_WALLET_NOT_FOUND');
      }
      if (isSaasBillingError(error) && error.code === 'INVALID_CURRENCY') {
        throw new CustomerWalletQueryError('CUSTOMER_WALLET_INVALID_INPUT');
      }
      if (error instanceof SaasBillingError) throw new CustomerWalletQueryError('CUSTOMER_WALLET_STORAGE_ERROR');
      throw new CustomerWalletQueryError('CUSTOMER_WALLET_STORAGE_ERROR');
    }
  }
}
