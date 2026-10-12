import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresCustomerWebhookEntitlementPolicy } from '../../../src/saas/webhooks/entitlement-policy.js';
import {
  CUSTOMER_WEBHOOK_EVENT_TYPES,
  type CustomerWebhookEventDataByType,
  type CustomerWebhookEventType,
} from '../../../src/saas/webhooks/events.js';

// F2: the Postgres entitlement authority reads the tenant policy row inside
// the caller's transaction and fails closed — no row, disabled policy, or an
// event type outside the whitelist all deny with WEBHOOK_ENTITLEMENT_DENIED.

const TENANT = randomUUID();

interface PolicyRow {
  readonly enabled: unknown;
  readonly allowed_event_types: unknown;
}

class FakeTx implements SqlExecutor {
  readonly queries: readonly { sql: string; values: readonly unknown[] }[] = [];
  constructor(private readonly rows: readonly PolicyRow[]) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    (this.queries as { sql: string; values: readonly unknown[] }[]).push({ sql, values });
    return { rows: this.rows as unknown as Row[], rowCount: this.rows.length };
  }
}

const ALL_TYPES = [...CUSTOMER_WEBHOOK_EVENT_TYPES];

async function assertAllowed(tx: SqlExecutor, eventType: CustomerWebhookEventType): Promise<void> {
  // The policy never inspects payload contents; the cast keeps the generic
  // signature satisfied without duplicating every event fixture here.
  const data = {} as CustomerWebhookEventDataByType[typeof eventType];
  await new PostgresCustomerWebhookEntitlementPolicy().assertEntitled({ tx, tenantId: TENANT, eventType, data });
}

async function assertDenied(tx: SqlExecutor, eventType: CustomerWebhookEventType): Promise<void> {
  const data = {} as CustomerWebhookEventDataByType[typeof eventType];
  await assert.rejects(
    new PostgresCustomerWebhookEntitlementPolicy().assertEntitled({ tx, tenantId: TENANT, eventType, data }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'WEBHOOK_ENTITLEMENT_DENIED');
      return true;
    },
  );
}

test('an enabled policy with the seven-type default whitelist admits every event type', async () => {
  const tx = new FakeTx([{ enabled: true, allowed_event_types: ALL_TYPES }]);
  for (const eventType of ALL_TYPES) {
    await assertAllowed(tx, eventType);
  }
  assert.equal(tx.queries.length, ALL_TYPES.length);
  const first = tx.queries[0];
  assert.ok(first);
  assert.match(first.sql, /FROM saas_customer_webhook_tenant_policies/);
  assert.match(first.sql, /SELECT enabled, allowed_event_types/);
  assert.deepEqual(first.values, [TENANT]);
});

test('a missing policy row denies every event type', async () => {
  const tx = new FakeTx([]);
  for (const eventType of ALL_TYPES) {
    await assertDenied(tx, eventType);
  }
});

test('a disabled policy denies even whitelisted event types', async () => {
  const tx = new FakeTx([{ enabled: false, allowed_event_types: ALL_TYPES }]);
  for (const eventType of ALL_TYPES) {
    await assertDenied(tx, eventType);
  }
});

test('event types outside the whitelist are denied while whitelisted ones pass', async () => {
  const subscribed = ['request.completed', 'usage.completed'];
  const tx = new FakeTx([{ enabled: true, allowed_event_types: subscribed }]);
  for (const eventType of ALL_TYPES) {
    if (subscribed.includes(eventType)) {
      await assertAllowed(tx, eventType);
    } else {
      await assertDenied(tx, eventType);
    }
  }
});

test('malformed stored whitelists fail closed instead of widening', async () => {
  const malformed: readonly unknown[] = [
    'request.completed',
    [],
    ['request.completed', 'request.completed'],
    ['request.completed', 'not.a.real.event'],
    ['request.completed', null],
    ['request.completed', ...ALL_TYPES],
    null,
    42,
  ];
  for (const value of malformed) {
    const tx = new FakeTx([{ enabled: true, allowed_event_types: value }]);
    const data = {} as CustomerWebhookEventDataByType['request.completed'];
    await assert.rejects(
      new PostgresCustomerWebhookEntitlementPolicy().assertEntitled({
        tx,
        tenantId: TENANT,
        eventType: 'request.completed',
        data,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Stored webhook policy allowed_event_types is invalid');
        return true;
      },
    );
  }
});

test('non-boolean stored enabled flags fail closed', async () => {
  for (const enabled of [1, 'true', null, undefined]) {
    const tx = new FakeTx([{ enabled, allowed_event_types: ALL_TYPES }]);
    await assertDenied(tx, 'request.completed');
  }
});

test('tenant ids are validated before any query runs', async () => {
  const tx = new FakeTx([{ enabled: true, allowed_event_types: ALL_TYPES }]);
  const data = {} as CustomerWebhookEventDataByType['request.completed'];
  await assert.rejects(
    new PostgresCustomerWebhookEntitlementPolicy().assertEntitled({
      tx,
      tenantId: 'not-a-uuid',
      eventType: 'request.completed',
      data,
    }),
    TypeError,
  );
  assert.equal(tx.queries.length, 0);
});
