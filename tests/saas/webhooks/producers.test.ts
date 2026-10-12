import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type CustomerWebhookEventDrop,
  createCustomerWebhookEventProducer,
} from '../../../src/saas/webhooks/producers.js';

// F3: producer hooks are exercised through the REAL enqueue + the REAL
// Postgres entitlement policy over a fake executor, proving idempotency-key
// composition, drop semantics for non-entitled tenants, and fail-closed
// propagation of real storage faults.

const TENANT = '11111111-1111-4111-8111-111111111111';
const REFUND = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const OCCURRED = '2026-10-10T00:00:00.000Z';

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface StoredEvent {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

class ProducerExecutor implements SqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly events = new Map<string, StoredEvent>();
  policyRow: { enabled: unknown; allowed_event_types: unknown } | undefined = {
    enabled: true,
    allowed_event_types: [
      'refund.status_changed',
      'service_plan_order.status_changed',
      'request.completed',
      'usage.completed',
      'wallet.low_balance',
      'api_key.expiring',
    ],
  };
  resourceExists = true;
  quotaExceeded = false;
  failOnDeliveries = false;
  targetCount = 0;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalize(sql);
    this.calls.push({ sql: statement, values: [...values] });
    if (statement.startsWith('SAVEPOINT') || statement.startsWith('RELEASE SAVEPOINT')) {
      return result([] as Row[], 0);
    }
    if (statement.startsWith('SELECT enabled, allowed_event_types')) {
      return result((this.policyRow ? [this.policyRow] : []) as Row[]);
    }
    if (statement.startsWith('SELECT enabled, max_events_per_minute, max_pending_deliveries')) {
      return result([{ enabled: true, max_events_per_minute: 10, max_pending_deliveries: 100 }] as Row[]);
    }
    if (statement.startsWith('SELECT 1 FROM saas_refund_orders')) {
      return result((this.resourceExists ? [{}] : []) as Row[]);
    }
    if (statement.startsWith('SELECT 1 FROM saas_requests')) {
      return result((this.resourceExists ? [{}] : []) as Row[]);
    }
    if (statement.startsWith('SELECT 1 FROM saas_api_keys')) {
      return result((this.resourceExists ? [{}] : []) as Row[]);
    }
    if (statement.startsWith('SELECT 1 FROM saas_service_plan_orders')) {
      return result((this.resourceExists ? [{}] : []) as Row[]);
    }
    if (statement.startsWith('SELECT count(*) AS target_count')) {
      return result([{ target_count: this.targetCount }] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_tenant_usage')) return result([] as Row[], 0);
    if (statement.startsWith('UPDATE saas_customer_webhook_tenant_usage')) {
      return this.quotaExceeded ? result([] as Row[], 0) : result([{}] as Row[], 1);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_events')) {
      const key = `${String(values[0])}:${String(values[2])}`;
      if (this.events.has(key)) return result([] as Row[], 0);
      this.events.set(key, {
        eventId: String(values[1]),
        type: String(values[3]),
        occurredAt: String(values[4]),
        payload: JSON.parse(String(values[5])),
      });
      return result([{ event_id: values[1] }] as Row[]);
    }
    if (statement.startsWith('SELECT event_id, event_type')) {
      const row = this.events.get(`${String(values[0])}:${String(values[1])}`);
      return result(
        (row
          ? [
              {
                event_id: row.eventId,
                event_type: row.type,
                schema_version: 1,
                occurred_at: row.occurredAt,
                payload: row.payload,
                tenant_id: values[0],
                idempotency_key: values[1],
              },
            ]
          : []) as Row[],
      );
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_deliveries')) {
      if (this.failOnDeliveries) throw new Error('relation does not exist');
      return result([] as Row[], this.targetCount);
    }
    return result([] as Row[]);
  }
}

function refundInput(transitionRef: string) {
  return {
    tenantId: TENANT,
    refundId: REFUND,
    status: 'succeeded' as const,
    amountMinorUnits: 500,
    currency: 'USD',
    occurredAt: OCCURRED,
    transitionRef,
  };
}

function orderInput(
  transitionRef: string,
  status: 'paid' | 'fulfilling' | 'fulfilled' | 'reconciliation_pending' = 'paid',
) {
  return { tenantId: TENANT, orderId: ORDER, status, occurredAt: OCCURRED, transitionRef };
}

test('refund transitions persist the event with the composed idempotency key in-transaction', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
  assert.equal(tx.events.size, 1);
  const stored = tx.events.get(`${TENANT}:refund.status_changed:${REFUND}:succeeded:lease-token-1`);
  assert.ok(stored);
  assert.equal(stored.type, 'refund.status_changed');
  assert.equal(stored.occurredAt, OCCURRED);
  assert.deepEqual(stored.payload, {
    refund_id: REFUND,
    status: 'succeeded',
    amount_minor_units: 500,
    currency: 'USD',
  });
  // The resource-tenant proof runs after the insert inside the savepoint.
  const insertIndex = tx.calls.findIndex(({ sql }) => sql.startsWith('INSERT INTO saas_customer_webhook_events'));
  const resourceIndex = tx.calls.findIndex(({ sql }) => sql.startsWith('SELECT 1 FROM saas_refund_orders'));
  assert.ok(insertIndex >= 0 && resourceIndex > insertIndex);
  const resourceCall = tx.calls[resourceIndex];
  assert.ok(resourceCall);
  assert.deepEqual(resourceCall.values, [TENANT, REFUND, 'succeeded', 500, 'USD']);
});

test('service plan order transitions persist the event with the composed key', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.servicePlanOrderStatusChanged(tx, orderInput('transition-1', 'reconciliation_pending'));
  const stored = tx.events.get(
    `${TENANT}:service_plan_order.status_changed:${ORDER}:reconciliation_pending:transition-1`,
  );
  assert.ok(stored);
  assert.deepEqual(stored.payload, { service_plan_order_id: ORDER, status: 'reconciliation_pending' });
});

test('a replayed transition with the same ref is an idempotent no-op', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
  await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
  assert.equal(tx.events.size, 1);
});

test('re-entering the same status with a fresh transition ref stores a second event', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.servicePlanOrderStatusChanged(tx, orderInput('reconcile-1', 'reconciliation_pending'));
  await producer.servicePlanOrderStatusChanged(tx, orderInput('reconcile-2', 'reconciliation_pending'));
  assert.equal(tx.events.size, 2);
});

test('a missing or disabled policy drops the event and reports the drop', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  for (const policyRow of [undefined, { enabled: false, allowed_event_types: ['refund.status_changed'] }]) {
    const tx = new ProducerExecutor();
    tx.policyRow = policyRow;
    await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
    assert.equal(tx.events.size, 0);
  }
  assert.deepEqual(
    drops.map((drop) => drop.code),
    ['WEBHOOK_ENTITLEMENT_DENIED', 'WEBHOOK_ENTITLEMENT_DENIED'],
  );
  assert.equal(drops[0]?.eventType, 'refund.status_changed');
  assert.equal(drops[0]?.tenantId, TENANT);
  assert.equal(drops[0]?.resourceId, REFUND);
});

test('event types outside the tenant whitelist drop without touching the events table', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const tx = new ProducerExecutor();
  tx.policyRow = { enabled: true, allowed_event_types: ['service_plan_order.status_changed'] };
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
  assert.equal(tx.events.size, 0);
  assert.equal(drops[0]?.code, 'WEBHOOK_ENTITLEMENT_DENIED');
});

test('quota exhaustion drops the event instead of rolling back the business transaction', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const tx = new ProducerExecutor();
  tx.targetCount = 1;
  tx.quotaExceeded = true;
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
  assert.equal(drops[0]?.code, 'WEBHOOK_TENANT_QUOTA_EXCEEDED');
});

test('resource tenant mismatches propagate and are never swallowed', async () => {
  const tx = new ProducerExecutor();
  tx.resourceExists = false;
  const producer = createCustomerWebhookEventProducer();
  await assert.rejects(producer.refundStatusChanged(tx, refundInput('lease-token-1')), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'WEBHOOK_EVENT_RESOURCE_TENANT_MISMATCH');
    return true;
  });
});

test('raw SQL failures propagate and are never swallowed', async () => {
  const tx = new ProducerExecutor();
  tx.failOnDeliveries = true;
  const producer = createCustomerWebhookEventProducer();
  await assert.rejects(producer.refundStatusChanged(tx, refundInput('lease-token-1')), /relation does not exist/);
});

test('the transition ref is validated before any statement runs', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await assert.rejects(producer.refundStatusChanged(tx, refundInput('bad ref!')), TypeError);
  await assert.rejects(producer.refundStatusChanged(tx, refundInput('')), TypeError);
  assert.equal(tx.calls.length, 0);
});

test('a throwing onEventDropped hook never breaks the producer', async () => {
  const tx = new ProducerExecutor();
  tx.policyRow = undefined;
  const producer = createCustomerWebhookEventProducer({
    onEventDropped: () => {
      throw new Error('metrics exploded');
    },
  });
  await producer.refundStatusChanged(tx, refundInput('lease-token-1'));
  assert.equal(tx.events.size, 0);
});

function requestInput(transitionRef: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    requestId: REQUEST,
    projectId: PROJECT,
    supplyMode: 'platform' as const,
    status: 'succeeded' as const,
    durationMs: 1250,
    occurredAt: OCCURRED,
    transitionRef,
    ...overrides,
  };
}

function usageInput(transitionRef: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    requestId: REQUEST,
    projectId: PROJECT,
    supplyMode: 'byok' as const,
    inputTokens: 120,
    outputTokens: 45,
    occurredAt: OCCURRED,
    transitionRef,
    ...overrides,
  };
}

test('request.completed persists with the request resource proof including execution_state', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.requestCompleted(tx, requestInput('normal-success-settlement'));
  const stored = tx.events.get(`${TENANT}:request.completed:${REQUEST}:succeeded:normal-success-settlement`);
  assert.ok(stored);
  assert.equal(stored.type, 'request.completed');
  assert.deepEqual(stored.payload, {
    request_id: REQUEST,
    project_id: PROJECT,
    supply_mode: 'platform',
    status: 'succeeded',
    duration_ms: 1250,
  });
  const resourceCall = tx.calls.find(({ sql }) => sql.startsWith('SELECT 1 FROM saas_requests'));
  assert.ok(resourceCall);
  assert.ok(resourceCall.sql.includes('execution_state'));
  assert.deepEqual(resourceCall.values, [TENANT, REQUEST, PROJECT, 'platform', 'succeeded']);
});

test('usage.completed persists with total_tokens derived from input plus output', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.usageCompleted(tx, usageInput('normal-success-settlement'));
  const stored = tx.events.get(`${TENANT}:usage.completed:${REQUEST}:normal-success-settlement`);
  assert.ok(stored);
  assert.deepEqual(stored.payload, {
    request_id: REQUEST,
    project_id: PROJECT,
    supply_mode: 'byok',
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165,
  });
  const resourceCall = tx.calls.find(({ sql }) => sql.startsWith('SELECT 1 FROM saas_requests'));
  assert.ok(resourceCall);
  assert.ok(!resourceCall.sql.includes('execution_state'));
  assert.deepEqual(resourceCall.values, [TENANT, REQUEST, PROJECT, 'byok']);
});

test('terminal events with the same ref replay as idempotent no-ops', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.requestCompleted(tx, requestInput('settlement'));
  await producer.requestCompleted(tx, requestInput('settlement'));
  await producer.usageCompleted(tx, usageInput('settlement'));
  await producer.usageCompleted(tx, usageInput('settlement'));
  assert.equal(tx.events.size, 2);
});

test('a failed request completion uses the failed status in key, payload and proof', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.requestCompleted(tx, requestInput('http-failure-502', { status: 'failed' }));
  const stored = tx.events.get(`${TENANT}:request.completed:${REQUEST}:failed:http-failure-502`);
  assert.ok(stored);
  assert.deepEqual(stored.payload, {
    request_id: REQUEST,
    project_id: PROJECT,
    supply_mode: 'platform',
    status: 'failed',
    duration_ms: 1250,
  });
  const resourceCall = tx.calls.find(({ sql }) => sql.startsWith('SELECT 1 FROM saas_requests'));
  assert.deepEqual(resourceCall?.values, [TENANT, REQUEST, PROJECT, 'platform', 'failed']);
});

test('durations beyond the schema cap drop as unrepresentable without touching the store', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  await producer.requestCompleted(tx, requestInput('settlement', { durationMs: 86_400_001 }));
  await producer.requestCompleted(tx, requestInput('settlement', { durationMs: Number.NaN }));
  assert.equal(tx.calls.length, 0);
  assert.deepEqual(
    drops.map((drop) => drop.code),
    ['WEBHOOK_EVENT_UNREPRESENTABLE', 'WEBHOOK_EVENT_UNREPRESENTABLE'],
  );
  assert.equal(drops[0]?.eventType, 'request.completed');
  assert.equal(drops[0]?.resourceId, REQUEST);
});

test('token counts outside the safe-integer range drop as unrepresentable', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  await producer.usageCompleted(tx, usageInput('settlement', { inputTokens: Number.NaN }));
  await producer.usageCompleted(tx, usageInput('settlement', { outputTokens: 2 ** 53 }));
  assert.equal(tx.calls.length, 0);
  assert.deepEqual(
    drops.map((drop) => drop.code),
    ['WEBHOOK_EVENT_UNREPRESENTABLE', 'WEBHOOK_EVENT_UNREPRESENTABLE'],
  );
  assert.equal(drops[0]?.eventType, 'usage.completed');
});

test('non-entitled tenants drop terminal events through the same semantics', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const tx = new ProducerExecutor();
  tx.policyRow = undefined;
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  await producer.requestCompleted(tx, requestInput('settlement'));
  await producer.usageCompleted(tx, usageInput('settlement'));
  assert.equal(tx.events.size, 0);
  assert.deepEqual(
    drops.map((drop) => drop.code),
    ['WEBHOOK_ENTITLEMENT_DENIED', 'WEBHOOK_ENTITLEMENT_DENIED'],
  );
});

test('wallet.low_balance persists with the tenant-scoped bucket key and no resource check', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  await producer.walletLowBalance(tx, {
    tenantId: TENANT,
    currency: 'USD',
    balanceMinorUnits: 400,
    thresholdMinorUnits: 1000,
    occurredAt: OCCURRED,
    transitionRef: '2026-10-10:band-6',
  });
  const stored = tx.events.get(`${TENANT}:wallet.low_balance:${TENANT}:USD:2026-10-10:band-6`);
  assert.ok(stored);
  assert.deepEqual(stored.payload, {
    supply_mode: 'platform',
    balance_minor_units: 400,
    threshold_minor_units: 1000,
    currency: 'USD',
  });
  assert.equal(
    tx.calls.some(({ sql }) => sql.startsWith('SELECT 1 FROM')),
    false,
    'wallet.low_balance references no tenant-scoped resource row',
  );
});

test('wallet.low_balance rejects an inverted or unsafe balance before any statement', async () => {
  const drops: CustomerWebhookEventDrop[] = [];
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
  const base = {
    tenantId: TENANT,
    currency: 'USD',
    thresholdMinorUnits: 1000,
    occurredAt: OCCURRED,
    transitionRef: 'day:band-0',
  };
  await producer.walletLowBalance(tx, { ...base, balanceMinorUnits: 1001 });
  await producer.walletLowBalance(tx, { ...base, balanceMinorUnits: -1 });
  await producer.walletLowBalance(tx, { ...base, balanceMinorUnits: Number.NaN });
  await producer.walletLowBalance(tx, { ...base, balanceMinorUnits: 10, thresholdMinorUnits: 0 });
  assert.equal(tx.calls.length, 0);
  assert.equal(drops.length, 4);
  assert.ok(drops.every((drop) => drop.code === 'WEBHOOK_EVENT_UNREPRESENTABLE'));
  assert.equal(drops[0]?.eventType, 'wallet.low_balance');
});

test('api_key.expiring persists with the key resource proof against saas_api_keys', async () => {
  const tx = new ProducerExecutor();
  const producer = createCustomerWebhookEventProducer();
  const expiresAt = '2026-10-17T08:00:00.000Z';
  await producer.apiKeyExpiring(tx, {
    tenantId: TENANT,
    apiKeyId: REFUND,
    expiresAt,
    occurredAt: OCCURRED,
    transitionRef: `expires-${Date.parse(expiresAt)}`,
  });
  const stored = tx.events.get(`${TENANT}:api_key.expiring:${REFUND}:expires-${Date.parse(expiresAt)}`);
  assert.ok(stored);
  assert.deepEqual(stored.payload, { api_key_id: REFUND, expires_at: expiresAt });
  const resourceCall = tx.calls.find(({ sql }) => sql.startsWith('SELECT 1 FROM saas_api_keys'));
  assert.ok(resourceCall);
  assert.deepEqual(resourceCall.values, [TENANT, REFUND, expiresAt]);
});

const ANNOUNCEMENT = '66666666-6666-4666-8666-666666666666';

function announcementInput(body = 'The control plane is read-only during the window.') {
  return {
    tenantId: TENANT,
    announcementId: ANNOUNCEMENT,
    kind: 'maintenance' as const,
    severity: 'warning' as const,
    title: 'Routers upgrade',
    body,
    publishAt: '2026-10-11T06:00:00.000Z',
    unpublishAt: null,
    occurredAt: '2026-10-11T06:00:00.000Z',
  };
}

test('platform.maintenance persists the announcement payload with the fan-out idempotency key', async () => {
  const tx = new ProducerExecutor();
  tx.policyRow = { enabled: true, allowed_event_types: ['platform.maintenance'] };
  const producer = createCustomerWebhookEventProducer();
  await producer.platformMaintenanceAnnouncement(tx, announcementInput());
  const stored = tx.events.get(`${TENANT}:announcement:${ANNOUNCEMENT}:${TENANT}`);
  assert.ok(stored);
  assert.equal(stored.type, 'platform.maintenance');
  assert.equal(stored.occurredAt, '2026-10-11T06:00:00.000Z');
  assert.deepEqual(stored.payload, {
    announcement_id: ANNOUNCEMENT,
    kind: 'maintenance',
    severity: 'warning',
    title: 'Routers upgrade',
    body: 'The control plane is read-only during the window.',
    publish_at: '2026-10-11T06:00:00.000Z',
    unpublish_at: null,
  });
  assert.equal(
    tx.calls.some(({ sql }) => sql.startsWith('SELECT 1 FROM')),
    false,
    'platform.maintenance references no tenant-scoped resource row',
  );
});

test('platform.maintenance replays byte-for-byte and swallows entitlement drops', async () => {
  const tx = new ProducerExecutor();
  tx.policyRow = { enabled: true, allowed_event_types: ['platform.maintenance'] };
  const producer = createCustomerWebhookEventProducer();
  await producer.platformMaintenanceAnnouncement(tx, announcementInput());
  await producer.platformMaintenanceAnnouncement(tx, announcementInput());
  assert.equal(tx.events.size, 1, 'the announcement fan-out key is idempotent');

  const drops: CustomerWebhookEventDrop[] = [];
  const denied = createCustomerWebhookEventProducer({
    onEventDropped: (drop) => drops.push(drop),
    entitlement: {
      assertEntitled: async () => {
        throw new Error('WEBHOOK_ENTITLEMENT_DENIED');
      },
    },
  });
  await denied.platformMaintenanceAnnouncement(new ProducerExecutor(), announcementInput());
  assert.deepEqual(
    drops.map((drop) => [drop.eventType, drop.resourceId, drop.code]),
    [['platform.maintenance', ANNOUNCEMENT, 'WEBHOOK_ENTITLEMENT_DENIED']],
  );
});

test('platform.maintenance truncates oversized bodies deterministically at a code-point boundary', async () => {
  const tx = new ProducerExecutor();
  tx.policyRow = { enabled: true, allowed_event_types: ['platform.maintenance'] };
  const producer = createCustomerWebhookEventProducer();
  // 8000 four-byte characters: far beyond the payload budget.
  const oversized = `${'😀'.repeat(4000)}${'中'.repeat(2667)}x`;
  const input = announcementInput(oversized);
  await producer.platformMaintenanceAnnouncement(tx, input);
  const stored = tx.events.get(`${TENANT}:announcement:${ANNOUNCEMENT}:${TENANT}`);
  assert.ok(stored);
  const payload = stored.payload as { body: string };
  const serialized = JSON.stringify(stored.payload);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 8192 - 256, 'the stored payload fits the data budget');
  assert.ok(oversized.startsWith(payload.body), 'truncation keeps the body prefix');
  assert.notEqual(payload.body, oversized);
  assert.equal([...payload.body].length, payload.body.length - (payload.body.match(/[\uD800-\uDBFF]/g)?.length ?? 0));
  assert.equal(payload.body.includes('�'), false, 'no replacement characters from a split sequence');

  // Same input, fresh executor: identical bytes, so idempotent replays match.
  const second = new ProducerExecutor();
  second.policyRow = { enabled: true, allowed_event_types: ['platform.maintenance'] };
  await createCustomerWebhookEventProducer().platformMaintenanceAnnouncement(second, input);
  const storedSecond = second.events.get(`${TENANT}:announcement:${ANNOUNCEMENT}:${TENANT}`);
  assert.equal(JSON.stringify(storedSecond?.payload), serialized);

  // Bodies inside the budget are never altered.
  const small = new ProducerExecutor();
  small.policyRow = { enabled: true, allowed_event_types: ['platform.maintenance'] };
  await createCustomerWebhookEventProducer().platformMaintenanceAnnouncement(small, announcementInput('short body'));
  const storedSmall = small.events.get(`${TENANT}:announcement:${ANNOUNCEMENT}:${TENANT}`)?.payload as
    | { body: string }
    | undefined;
  assert.equal(storedSmall?.body, 'short body');
});
