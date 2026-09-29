import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CustomerWalletQueryDatabase } from '../../../src/saas/billing/customer-query.js';
import { CustomerWalletQueryError, SaasCustomerWalletQueryService } from '../../../src/saas/billing/customer-query.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';

type Row = Record<string, unknown>;

interface QueryCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const TENANT_ID = 'tenant-a';
const WALLET_ID = '11111111-1111-4111-8111-111111111111';

function result<RowType>(rows: RowType[]): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    userId: 'user-a',
    tenantId: TENANT_ID,
    projectId: 'project-a',
    tenantRole: 'owner',
    projectRole: 'viewer',
    ...overrides,
  };
}

function ledgerRow(id: string, transactionId: string, createdAt: string, sourceType: string): Row {
  return {
    id,
    transaction_id: transactionId,
    currency: 'USD',
    direction: sourceType === 'wallet_funding' ? 'credit' : 'debit',
    amount_minor_units: '25',
    created_at: createdAt,
    source_type: sourceType,
    account_ref: 'must-not-be-returned',
    metadata_ref: 'internal-metadata-ref',
    merchant_id: 'private-merchant',
    provider_order_id: 'private-psp-order',
    internal_note: 'private note',
  };
}

class RecordingDatabase implements CustomerWalletQueryDatabase {
  readonly calls: QueryCall[] = [];
  transactionCalls = 0;
  walletExists = true;
  readonly walletId = WALLET_ID;
  readonly ledgerEntries: Row[] = [
    ledgerRow(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '2026-09-28T03:00:00.000Z',
      'wallet_funding',
    ),
    ledgerRow(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
      '2026-09-28T02:00:00.000Z',
      'billing_settlement',
    ),
    ledgerRow(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd',
      '2026-09-28T01:00:00.000Z',
      'billing_settlement',
    ),
  ];

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const executor: SqlExecutor = {
      query: async <RowType>(sql: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql, values });
        const statement = sql.replace(/\s+/g, ' ').trim();
        if (statement.startsWith('SET TRANSACTION')) return result<RowType>([]);
        if (statement.includes('FROM saas_wallets')) {
          const [tenantId, currency] = values;
          if (!this.walletExists || tenantId !== TENANT_ID || currency !== 'USD') return result<RowType>([]);
          return result<RowType>([
            {
              id: WALLET_ID,
              tenant_id: TENANT_ID,
              currency: 'USD',
              posted_balance_minor_units: '1000',
              created_at: '2026-09-01T00:00:00.000Z',
              updated_at: '2026-09-28T03:00:00.000Z',
            } as RowType,
          ]);
        }
        if (statement.includes('FROM saas_billing_reservations')) {
          return result<RowType>([{ active_hold_minor_units: '200' } as RowType]);
        }
        if (statement.includes('FROM saas_refund_wallet_freezes')) {
          return result<RowType>([{ active_refund_freeze_minor_units: '0' } as RowType]);
        }
        if (statement.includes('FROM saas_billing_spending_freezes')) {
          return result<RowType>([
            {
              tenant_id: TENANT_ID,
              reason_ref: 'internal-freeze-reconciliation-note',
              frozen_at: '2026-09-28T00:00:00.000Z',
            } as RowType,
          ]);
        }
        if (statement.includes('FROM saas_ledger_entries AS e')) {
          const [tenantId, walletId, currency] = values;
          if (tenantId !== TENANT_ID || walletId !== WALLET_ID || currency !== 'USD') return result<RowType>([]);
          const hasCursor = statement.includes('(e.created_at, e.id) <');
          const cursorAt = hasCursor ? String(values[3]) : undefined;
          const cursorId = hasCursor ? String(values[4]) : undefined;
          const filtered = this.ledgerEntries.filter((row) => {
            if (!hasCursor || !cursorAt || !cursorId) return true;
            const timestamp = String(row.created_at);
            return timestamp < cursorAt || (timestamp === cursorAt && String(row.id) < cursorId);
          });
          return result<RowType>(filtered.slice(0, Number(values.at(-1))) as RowType[]);
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    };
    return work(executor);
  }
}

function isWalletQueryError(code: CustomerWalletQueryError['code']) {
  return (error: unknown): boolean => error instanceof CustomerWalletQueryError && error.code === code;
}

test('returns a read-only wallet balance and safe, paginated ledger projection', async () => {
  const database = new RecordingDatabase();
  const service = new SaasCustomerWalletQueryService(database);

  const first = await service.getWallet(context(), { currency: 'USD', limit: 2 });
  assert.deepEqual(first.wallet, {
    currency: 'USD',
    postedBalanceMinorUnits: '1000',
    activeHoldsMinorUnits: '200',
    frozenAmountMinorUnits: '800',
    availableMinorUnits: '0',
    spendingFrozen: true,
  });
  assert.deepEqual(
    first.ledger.items.map(({ id, type, direction }) => ({ id, type, direction })),
    [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'top_up',
        direction: 'credit',
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
        type: 'usage_charge',
        direction: 'debit',
      },
    ],
  );
  assert.equal(first.ledger.hasMore, true);
  assert.ok(first.ledger.nextCursor?.startsWith('w1.'));

  const second = await service.getWallet(context(), {
    currency: 'USD',
    limit: 2,
    cursor: first.ledger.nextCursor,
  });
  assert.deepEqual(
    second.ledger.items.map((entry) => entry.id),
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac'],
  );
  assert.equal(second.ledger.hasMore, false);
  assert.equal(second.ledger.nextCursor, null);

  const serialized = JSON.stringify(first).toLowerCase();
  for (const forbidden of [
    'internal-freeze-reconciliation-note',
    'internal-metadata-ref',
    'must-not-be-returned',
    'private-merchant',
    'private-psp-order',
    'internal_note',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `unexpected sensitive field ${forbidden}`);
  }

  const ledgerCalls = database.calls.filter(({ sql }) => sql.includes('FROM saas_ledger_entries AS e'));
  assert.equal(ledgerCalls.length, 2);
  assert.match(ledgerCalls[0]?.sql ?? '', /e\.tenant_id = \$1 AND e\.wallet_id = \$2 AND e\.currency = \$3/);
  assert.match(ledgerCalls[0]?.sql ?? '', /ORDER BY e\.created_at DESC, e\.id DESC/);
  assert.match(ledgerCalls[1]?.sql ?? '', /\(e\.created_at, e\.id\) < \(\$4::timestamptz, \$5::uuid\)/);
  assert.deepEqual(ledgerCalls[0]?.values.slice(0, 3), [TENANT_ID, WALLET_ID, 'USD']);
  const refundFreezeCalls = database.calls.filter(({ sql }) => sql.includes('FROM saas_refund_wallet_freezes'));
  assert.equal(refundFreezeCalls.length, 2);
  assert.ok(refundFreezeCalls.every(({ sql }) => /WHERE tenant_id = \$1 AND currency = \$2/.test(sql)));
  assert.deepEqual(refundFreezeCalls.map(({ values }) => values), [
    [TENANT_ID, 'USD'],
    [TENANT_ID, 'USD'],
  ]);
  assert.ok(database.calls.every(({ sql }) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));
  assert.ok(database.calls.some(({ sql }) => sql.includes('READ ONLY')));
});

test('binds cursors to the authenticated tenant, actor, and currency', async () => {
  const database = new RecordingDatabase();
  const service = new SaasCustomerWalletQueryService(database);
  const first = await service.getWallet(context(), { currency: 'USD', limit: 1 });
  const queryCount = database.calls.length;

  await assert.rejects(
    service.getWallet(context({ userId: 'user-b' }), {
      currency: 'USD',
      cursor: first.ledger.nextCursor,
    }),
    isWalletQueryError('CUSTOMER_WALLET_INVALID_INPUT'),
  );
  await assert.rejects(
    service.getWallet(context(), { currency: 'EUR', cursor: first.ledger.nextCursor }),
    isWalletQueryError('CUSTOMER_WALLET_INVALID_INPUT'),
  );
  assert.equal(database.calls.length, queryCount);
});

test('denies non-owner/admin contexts and scopes missing wallets to the resolved tenant', async () => {
  const database = new RecordingDatabase();
  const service = new SaasCustomerWalletQueryService(database);
  await assert.rejects(
    service.getWallet(context({ tenantRole: 'developer' }), { currency: 'USD' }),
    isWalletQueryError('CUSTOMER_WALLET_ACCESS_DENIED'),
  );
  assert.equal(database.transactionCalls, 0);

  await assert.rejects(
    service.getWallet(context({ tenantId: 'tenant-b' }), { currency: 'USD' }),
    isWalletQueryError('CUSTOMER_WALLET_NOT_FOUND'),
  );
  const walletLookup = database.calls.find(({ sql }) => sql.includes('FROM saas_wallets'));
  assert.deepEqual(walletLookup?.values, ['tenant-b', 'USD']);

  database.walletExists = false;
  await assert.rejects(
    service.getWallet(context(), { currency: 'USD' }),
    isWalletQueryError('CUSTOMER_WALLET_NOT_FOUND'),
  );
});

test('rejects invalid currencies, page sizes, and malformed cursors', async () => {
  const database = new RecordingDatabase();
  const service = new SaasCustomerWalletQueryService(database);
  for (const input of [
    { currency: 'usd' },
    { currency: 'USD', limit: 0 },
    { currency: 'USD', limit: 101 },
    { currency: 'USD', cursor: 'not-a-cursor' },
  ]) {
    await assert.rejects(service.getWallet(context(), input), isWalletQueryError('CUSTOMER_WALLET_INVALID_INPUT'));
  }
  assert.equal(database.transactionCalls, 0);
});
