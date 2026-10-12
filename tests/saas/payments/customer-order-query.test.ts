import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import {
  type CustomerPaymentOrderQueryDatabase,
  CustomerPaymentOrderQueryError,
  SaasCustomerPaymentOrderQueryService,
} from '../../../src/saas/payments/customer-order-query.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_ID = 'user-1';
const ORDER_A1 = '10000000-0000-4000-8000-000000000001';
const ORDER_A2 = '10000000-0000-4000-8000-000000000002';
const ORDER_A3 = '10000000-0000-4000-8000-000000000003';
const ORDER_B1 = '10000000-0000-4000-8000-000000000004';

interface FixtureOrder extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly order_type: 'wallet_topup';
  readonly amount_minor_units: string;
  readonly currency: string;
  readonly state: 'created' | 'pending' | 'fulfilled';
  readonly created_at: string;
  readonly updated_at: string;
  readonly paid_at: string | null;
  readonly fulfilled_at: string | null;
}

function order(
  id: string,
  tenantId: string,
  createdAt: string,
  state: FixtureOrder['state'] = 'fulfilled',
): FixtureOrder {
  return {
    id,
    tenant_id: tenantId,
    order_type: 'wallet_topup',
    amount_minor_units: '12500',
    currency: 'USD',
    state,
    created_at: createdAt,
    updated_at: '2026-09-28T12:00:01.123456Z',
    paid_at: state === 'created' ? null : '2026-09-28T12:00:02.654321Z',
    fulfilled_at: state === 'fulfilled' ? '2026-09-28T12:00:03.654321Z' : null,
    // These deliberately sensitive columns must never be selected or returned.
    provider_key: 'easypay',
    merchant_id: 'merchant-secret',
    client_request_id: 'client-request-secret',
    local_order_ref: 'local-ref-secret',
    funding_reference: 'funding-ref-secret',
    provider_order_id: 'psp-order-secret',
    provider_attempts: 3,
    provider_failure_code: 'PROVIDER_INTERNAL',
    funding_transaction_id: 'funding-tx-secret',
    checkout_kind: 'redirect',
    checkout_url: 'https://psp.example.test/pay/secret',
    checkout_text: null,
    checkout_expires_at: '2026-09-28T13:00:00.000000Z',
    provider_submission_state: 'submitted',
    provider_submission_lease_token: 'lease-secret',
    provider_submission_lease_expires_at: '2026-09-28T12:30:00.000000Z',
  };
}

class FakePaymentOrderDatabase implements CustomerPaymentOrderQueryDatabase {
  readonly queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  readonly tenantRoles = new Map<string, string>([
    [TENANT_A, 'billing'],
    [TENANT_B, 'billing'],
  ]);
  private readonly executor: SqlExecutor;

  constructor(private readonly rows: readonly FixtureOrder[]) {
    this.executor = {
      query: async <Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> => {
        this.queries.push({ sql, values });
        if (sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM saas_tenants t') && sql.includes('m.role AS tenant_role')) {
          const tenantId = String(values[0]);
          const userId = String(values[1]);
          const role = this.tenantRoles.get(tenantId);
          return {
            rows: userId === USER_ID && role ? ([{ tenant_id: tenantId, tenant_role: role }] as Row[]) : [],
            rowCount: userId === USER_ID && role ? 1 : 0,
          };
        }
        const tenantId = values[0];
        const limit = Number(values.at(-1));
        const hasCursor = sql.includes('AND (created_at, id) <');
        const cursorCreatedAt = hasCursor ? String(values[1]) : undefined;
        const cursorId = hasCursor ? String(values[2]) : undefined;
        const selected = this.rows
          .filter((row) => row.tenant_id === tenantId)
          .filter(
            (row) =>
              !hasCursor ||
              row.created_at < (cursorCreatedAt as string) ||
              (row.created_at === cursorCreatedAt && row.id < (cursorId as string)),
          )
          .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
          .slice(0, limit)
          .map((row) => ({
            id: row.id,
            order_type: row.order_type,
            amount_minor_units: row.amount_minor_units,
            currency: row.currency,
            state: row.state,
            created_at: row.created_at,
            updated_at: row.updated_at,
            paid_at: row.paid_at,
            fulfilled_at: row.fulfilled_at,
          }));
        return { rows: selected as Row[], rowCount: selected.length };
      },
    };
  }

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.executor);
  }
}

function context(
  tenantId: string,
  tenantRole: TenantContext['tenantRole'] = 'billing',
  userId = USER_ID,
): TenantContext {
  return {
    userId,
    tenantId,
    projectId: 'project-1',
    tenantRole,
    projectRole: tenantRole,
  };
}

function fixtureRows(): FixtureOrder[] {
  return [
    order(ORDER_A1, TENANT_A, '2026-09-28T12:00:00.123456Z'),
    order(ORDER_A2, TENANT_A, '2026-09-28T12:00:00.123456Z', 'pending'),
    order(ORDER_A3, TENANT_A, '2026-09-28T12:00:00.123455Z', 'created'),
    order(ORDER_B1, TENANT_B, '2026-09-29T12:00:00.000000Z'),
  ];
}

test('lists only the resolved tenant with stable microsecond ordering and the exact safe DTO', async () => {
  const database = new FakePaymentOrderDatabase(fixtureRows());
  const service = new SaasCustomerPaymentOrderQueryService(database);
  const firstPage = await service.listPaymentOrders(context(TENANT_A), { limit: 2 });

  assert.deepEqual(firstPage.items, [
    {
      id: ORDER_A2,
      orderType: 'wallet_topup',
      amountMinorUnits: '12500',
      currency: 'USD',
      status: 'pending',
      createdAt: '2026-09-28T12:00:00.123456Z',
      updatedAt: '2026-09-28T12:00:01.123456Z',
      paidAt: '2026-09-28T12:00:02.654321Z',
      fulfilledAt: null,
    },
    {
      id: ORDER_A1,
      orderType: 'wallet_topup',
      amountMinorUnits: '12500',
      currency: 'USD',
      status: 'fulfilled',
      createdAt: '2026-09-28T12:00:00.123456Z',
      updatedAt: '2026-09-28T12:00:01.123456Z',
      paidAt: '2026-09-28T12:00:02.654321Z',
      fulfilledAt: '2026-09-28T12:00:03.654321Z',
    },
  ]);
  assert.equal(
    Object.keys(firstPage.items[0]).join(','),
    'id,orderType,amountMinorUnits,currency,status,createdAt,updatedAt,paidAt,fulfilledAt',
  );
  assert.ok(firstPage.nextCursor);

  const secondPage = await service.listPaymentOrders(context(TENANT_A), { limit: 2, cursor: firstPage.nextCursor });
  assert.deepEqual(
    secondPage.items.map((item) => item.id),
    [ORDER_A3],
  );
  assert.equal(secondPage.items[0]?.paidAt, null);
  assert.equal(secondPage.nextCursor, null);

  const selectQueries = database.queries.filter(({ sql }) => sql.includes('FROM saas_payment_orders'));
  assert.equal(selectQueries.length, 2);
  for (const { sql, values } of selectQueries) {
    assert.match(sql, /WHERE tenant_id = \$1/);
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.equal(values[0], TENANT_A);
    const projection = sql.slice(0, sql.indexOf('FROM saas_payment_orders'));
    assert.doesNotMatch(
      projection,
      /provider_key|merchant_id|client_request_id|local_order_ref|funding_reference|provider_order_id|provider_attempts|provider_failure_code|funding_transaction_id|checkout_|provider_submission/,
    );
  }
  assert.deepEqual(selectQueries[0].values, [TENANT_A, 3]);
  assert.deepEqual(selectQueries[1].values.slice(0, 3), [TENANT_A, '2026-09-28T12:00:00.123456Z', ORDER_A1]);
  assert.match(database.queries[0].sql, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});

test('accepts only billing tenant roles and never queries when the resolved context is not authorized', async () => {
  const database = new FakePaymentOrderDatabase(fixtureRows());
  const service = new SaasCustomerPaymentOrderQueryService(database);
  for (const role of ['owner', 'admin', 'billing'] as const) {
    await service.listPaymentOrders(context(TENANT_A, role), { limit: 1 });
  }
  const queryCount = database.queries.length;

  await assert.rejects(
    service.listPaymentOrders(context(TENANT_A, 'viewer'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 403,
  );
  await assert.rejects(
    service.listPaymentOrders(context(TENANT_A, 'developer'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 403,
  );
  assert.equal(database.queries.length, queryCount);
});

test('rechecks the current tenant membership and billing role inside the read-only transaction', async () => {
  const database = new FakePaymentOrderDatabase(fixtureRows());
  const service = new SaasCustomerPaymentOrderQueryService(database);

  database.tenantRoles.set(TENANT_A, 'viewer');
  await assert.rejects(
    service.listPaymentOrders(context(TENANT_A, 'billing'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 403,
  );
  assert.equal(database.queries.filter(({ sql }) => sql.includes('FROM saas_payment_orders')).length, 0);

  database.tenantRoles.set(TENANT_A, 'billing');
  await assert.rejects(
    service.listPaymentOrders(context(TENANT_A, 'billing', 'different-user'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 403,
  );
  assert.equal(database.queries.filter(({ sql }) => sql.includes('FROM saas_payment_orders')).length, 0);
});

test('rejects invalid limits, malformed cursors, and cursors copied from another tenant', async () => {
  const database = new FakePaymentOrderDatabase(fixtureRows());
  const service = new SaasCustomerPaymentOrderQueryService(database);
  for (const limit of [0, -1, 1.5, 101, '2']) {
    await assert.rejects(
      service.listPaymentOrders(context(TENANT_A), { limit: limit as number }),
      (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 400,
    );
  }
  for (const cursor of ['', 'not-a-cursor', `p1.${'a'.repeat(2048)}`]) {
    await assert.rejects(
      service.listPaymentOrders(context(TENANT_A), { cursor }),
      (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 400,
    );
  }

  const firstPage = await service.listPaymentOrders(context(TENANT_A), { limit: 1 });
  assert.ok(firstPage.nextCursor);
  const queriesBeforeTenantCursor = database.queries.length;
  await assert.rejects(
    service.listPaymentOrders(context(TENANT_B), { cursor: firstPage.nextCursor }),
    (error: unknown) => error instanceof CustomerPaymentOrderQueryError && error.status === 400,
  );
  assert.equal(database.queries.length, queriesBeforeTenantCursor);
});

test('fail-closed row validation refuses damaged stored shapes instead of mapping them', async () => {
  const damaged: FixtureOrder[] = [
    { ...order(ORDER_A1, TENANT_A, '2026-09-28T12:00:00.123456Z'), state: 'mystery' as 'created' },
  ];
  const database = new FakePaymentOrderDatabase(damaged);
  const service = new SaasCustomerPaymentOrderQueryService(database);
  await assert.rejects(
    service.listPaymentOrders(context(TENANT_A), { limit: 10 }),
    (error: unknown) =>
      error instanceof CustomerPaymentOrderQueryError &&
      error.code === 'CUSTOMER_PAYMENT_ORDER_QUERY_STORAGE_ERROR' &&
      error.status === 500,
  );
});
