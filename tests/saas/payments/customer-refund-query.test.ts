import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import {
  type CustomerRefundQueryDatabase,
  CustomerRefundQueryError,
  SaasCustomerRefundQueryService,
} from '../../../src/saas/payments/customer-refund-query.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_ID = 'user-1';
const REFUND_A1 = '00000000-0000-4000-8000-000000000001';
const REFUND_A2 = '00000000-0000-4000-8000-000000000002';
const REFUND_A3 = '00000000-0000-4000-8000-000000000003';
const REFUND_B1 = '00000000-0000-4000-8000-000000000004';
const ORDER_A1 = '10000000-0000-4000-8000-000000000001';
const ORDER_A2 = '10000000-0000-4000-8000-000000000002';
const ORDER_A3 = '10000000-0000-4000-8000-000000000003';
const ORDER_B1 = '10000000-0000-4000-8000-000000000004';

interface FixtureRefund extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly refund_type: 'wallet_topup' | 'byok_service_plan';
  readonly wallet_topup_order_id: string | null;
  readonly service_plan_order_id: string | null;
  readonly amount_minor_units: string;
  readonly currency: string;
  readonly state: 'pending' | 'succeeded';
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

function refund(
  id: string,
  tenantId: string,
  originalOrderId: string,
  createdAt: string,
  refundType: 'wallet_topup' | 'byok_service_plan' = 'wallet_topup',
): FixtureRefund {
  return {
    id,
    tenant_id: tenantId,
    refund_type: refundType,
    wallet_topup_order_id: refundType === 'wallet_topup' ? originalOrderId : null,
    service_plan_order_id: refundType === 'byok_service_plan' ? originalOrderId : null,
    amount_minor_units: '12500',
    currency: 'USD',
    state: refundType === 'wallet_topup' ? 'succeeded' : 'pending',
    created_at: createdAt,
    updated_at: '2026-09-28T12:00:01.123456Z',
    completed_at: refundType === 'wallet_topup' ? '2026-09-28T12:00:02.654321Z' : null,
    // These deliberately sensitive columns must never be selected or returned.
    provider_refund_id: 'psp-refund-secret',
    provider_order_id: 'psp-order-secret',
    authorization_ref: 'authorization-secret',
    failure_code: 'provider-internal-failure',
    blocked_code: 'internal-block-reason',
    reason_code: 'INTERNAL_REASON',
    lease_token: 'worker-lease-secret',
  };
}

class FakeRefundDatabase implements CustomerRefundQueryDatabase {
  readonly queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  readonly tenantRoles = new Map<string, string>([
    [TENANT_A, 'billing'],
    [TENANT_B, 'billing'],
  ]);
  private readonly executor: SqlExecutor;

  constructor(private readonly rows: readonly FixtureRefund[]) {
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
            refund_type: row.refund_type,
            original_order_id: row.wallet_topup_order_id ?? row.service_plan_order_id,
            amount_minor_units: row.amount_minor_units,
            currency: row.currency,
            state: row.state,
            created_at: row.created_at,
            updated_at: row.updated_at,
            completed_at: row.completed_at,
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

function fixtureRows(): FixtureRefund[] {
  return [
    refund(REFUND_A1, TENANT_A, ORDER_A1, '2026-09-28T12:00:00.123456Z'),
    refund(REFUND_A2, TENANT_A, ORDER_A2, '2026-09-28T12:00:00.123456Z', 'byok_service_plan'),
    refund(REFUND_A3, TENANT_A, ORDER_A3, '2026-09-28T12:00:00.123455Z'),
    refund(REFUND_B1, TENANT_B, ORDER_B1, '2026-09-29T12:00:00.000000Z'),
  ];
}

test('lists only the resolved tenant with stable microsecond ordering and the exact safe DTO', async () => {
  const database = new FakeRefundDatabase(fixtureRows());
  const service = new SaasCustomerRefundQueryService(database);
  const firstPage = await service.listRefunds(context(TENANT_A), { limit: 2 });

  assert.deepEqual(firstPage.items, [
    {
      id: REFUND_A2,
      refundType: 'byok_service_plan',
      originalOrderId: ORDER_A2,
      amountMinorUnits: '12500',
      currency: 'USD',
      status: 'pending',
      createdAt: '2026-09-28T12:00:00.123456Z',
      updatedAt: '2026-09-28T12:00:01.123456Z',
      completedAt: null,
    },
    {
      id: REFUND_A1,
      refundType: 'wallet_topup',
      originalOrderId: ORDER_A1,
      amountMinorUnits: '12500',
      currency: 'USD',
      status: 'succeeded',
      createdAt: '2026-09-28T12:00:00.123456Z',
      updatedAt: '2026-09-28T12:00:01.123456Z',
      completedAt: '2026-09-28T12:00:02.654321Z',
    },
  ]);
  assert.equal(
    Object.keys(firstPage.items[0]).join(','),
    'id,refundType,originalOrderId,amountMinorUnits,currency,status,createdAt,updatedAt,completedAt',
  );
  assert.ok(firstPage.nextCursor);

  const secondPage = await service.listRefunds(context(TENANT_A), { limit: 2, cursor: firstPage.nextCursor });
  assert.deepEqual(
    secondPage.items.map((item) => item.id),
    [REFUND_A3],
  );
  assert.equal(secondPage.nextCursor, null);

  const selectQueries = database.queries.filter(({ sql }) => sql.includes('FROM saas_refund_orders'));
  assert.equal(selectQueries.length, 2);
  for (const { sql, values } of selectQueries) {
    assert.match(sql, /WHERE tenant_id = \$1/);
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.equal(values[0], TENANT_A);
    const projection = sql.slice(0, sql.indexOf('FROM saas_refund_orders'));
    assert.doesNotMatch(
      projection,
      /provider_refund_id|provider_order_id|authorization_ref|failure_code|blocked_code|reason_code|lease_token|merchant_id/,
    );
  }
  assert.deepEqual(selectQueries[0].values, [TENANT_A, 3]);
  assert.deepEqual(selectQueries[1].values.slice(0, 3), [TENANT_A, '2026-09-28T12:00:00.123456Z', REFUND_A1]);
  assert.match(database.queries[0].sql, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});

test('accepts only billing tenant roles and never queries when the resolved context is not authorized', async () => {
  const database = new FakeRefundDatabase(fixtureRows());
  const service = new SaasCustomerRefundQueryService(database);
  for (const role of ['owner', 'admin', 'billing'] as const) {
    await service.listRefunds(context(TENANT_A, role), { limit: 1 });
  }
  const queryCount = database.queries.length;

  await assert.rejects(
    service.listRefunds(context(TENANT_A, 'viewer'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 403,
  );
  await assert.rejects(
    service.listRefunds(context(TENANT_A, 'developer'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 403,
  );
  assert.equal(database.queries.length, queryCount);
});

test('rechecks the current tenant membership and billing role inside the read-only transaction', async () => {
  const database = new FakeRefundDatabase(fixtureRows());
  const service = new SaasCustomerRefundQueryService(database);

  database.tenantRoles.set(TENANT_A, 'viewer');
  await assert.rejects(
    service.listRefunds(context(TENANT_A, 'billing'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 403,
  );
  assert.equal(database.queries.filter(({ sql }) => sql.includes('FROM saas_refund_orders')).length, 0);

  database.tenantRoles.set(TENANT_A, 'billing');
  await assert.rejects(
    service.listRefunds(context(TENANT_A, 'billing', 'different-user'), { limit: 1 }),
    (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 403,
  );
  assert.equal(database.queries.filter(({ sql }) => sql.includes('FROM saas_refund_orders')).length, 0);
});

test('rejects invalid limits, malformed cursors, and cursors copied from another tenant', async () => {
  const database = new FakeRefundDatabase(fixtureRows());
  const service = new SaasCustomerRefundQueryService(database);
  for (const limit of [0, -1, 1.5, 101, '2']) {
    await assert.rejects(
      service.listRefunds(context(TENANT_A), { limit: limit as number }),
      (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 400,
    );
  }
  for (const cursor of ['', 'not-a-cursor', `r1.${'a'.repeat(2048)}`]) {
    await assert.rejects(
      service.listRefunds(context(TENANT_A), { cursor }),
      (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 400,
    );
  }

  const firstPage = await service.listRefunds(context(TENANT_A), { limit: 1 });
  assert.ok(firstPage.nextCursor);
  const queriesBeforeTenantCursor = database.queries.length;
  await assert.rejects(
    service.listRefunds(context(TENANT_B), { cursor: firstPage.nextCursor }),
    (error: unknown) => error instanceof CustomerRefundQueryError && error.status === 400,
  );
  assert.equal(database.queries.length, queriesBeforeTenantCursor);
});
