import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/043_customer_webhook_delivery.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type ClaimedCustomerWebhookDelivery,
  CUSTOMER_WEBHOOK_MAX_ATTEMPTS,
  type CustomerWebhookEventEntitlementPolicy,
  enqueueCustomerWebhookEvent,
  PostgresCustomerWebhookDeliveryStore,
} from '../../../src/saas/webhooks/postgres-store.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const EVENT2 = '33333333-3333-4333-8333-333333333333';
const DELIVERY = '44444444-4444-4444-8444-444444444444';
const ENDPOINT = '55555555-5555-4555-8555-555555555555';
const KEY = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-29T00:00:00.000Z');
const EVENT_DATA = {
  supply_mode: 'platform' as const,
  balance_minor_units: 4200,
  threshold_minor_units: 5000,
  currency: 'USD',
};

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class EnqueueExecutor implements SqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly events = new Map<string, { eventId: string; type: string; occurredAt: Date; payload: unknown }>();
  deliveryCount = 2;
  resourceExists = true;
  quotaExceeded = false;
  private savepointEvents:
    | Map<string, { eventId: string; type: string; occurredAt: Date; payload: unknown }>
    | undefined;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalize(sql);
    this.calls.push({ sql: statement, values: [...values] });
    if (statement === 'SAVEPOINT model_router_customer_webhook_enqueue') {
      this.savepointEvents = new Map(this.events);
      return result([] as Row[], 0);
    }
    if (statement === 'ROLLBACK TO SAVEPOINT model_router_customer_webhook_enqueue') {
      this.events.clear();
      for (const [key, event] of this.savepointEvents ?? []) this.events.set(key, event);
      return result([] as Row[], 0);
    }
    if (statement === 'RELEASE SAVEPOINT model_router_customer_webhook_enqueue') {
      this.savepointEvents = undefined;
      return result([] as Row[], 0);
    }
    if (statement.startsWith('SELECT 1 FROM saas_api_keys')) return result((this.resourceExists ? [{}] : []) as Row[]);
    if (statement.startsWith('SELECT enabled, max_events_per_minute, max_pending_deliveries')) {
      return result([{ enabled: true, max_events_per_minute: 10, max_pending_deliveries: 100 }] as Row[]);
    }
    if (statement.startsWith('SELECT count(*) AS target_count')) return result([{ target_count: 2 }] as Row[]);
    if (statement.startsWith('INSERT INTO saas_customer_webhook_tenant_usage')) return result([] as Row[], 0);
    if (statement.startsWith('UPDATE saas_customer_webhook_tenant_usage')) {
      return this.quotaExceeded ? result([] as Row[], 0) : result([{}] as Row[], 1);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_events')) {
      const tenantId = String(values[0]);
      const eventId = String(values[1]);
      const idempotency = String(values[2]);
      const found = this.events.get(`${tenantId}:${idempotency}`);
      if (found) return result([] as Row[], 0);
      this.events.set(`${tenantId}:${idempotency}`, {
        eventId,
        type: String(values[3]),
        occurredAt: new Date(String(values[4])),
        payload: JSON.parse(String(values[5])),
      });
      return result([{ event_id: eventId }] as Row[]);
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
    if (statement.startsWith('INSERT INTO saas_customer_webhook_deliveries'))
      return result([] as Row[], this.deliveryCount);
    return result([] as Row[]);
  }
}

const entitled: CustomerWebhookEventEntitlementPolicy = {
  async assertEntitled(input) {
    assert.equal(input.tenantId, TENANT);
    assert.equal(input.eventType, 'wallet.low_balance');
    assert.ok(input.tx);
  },
};

test('enqueue is transaction-executor-only, entitlement-gated, tenant-scoped, and idempotent', async () => {
  const tx = new EnqueueExecutor();
  const input = {
    tenantId: TENANT,
    eventId: EVENT,
    idempotencyKey: 'wallet:low:2026-09-29',
    eventType: 'wallet.low_balance' as const,
    occurredAt: NOW,
    data: EVENT_DATA,
  };
  const first = await enqueueCustomerWebhookEvent(tx, input, entitled);
  const duplicate = await enqueueCustomerWebhookEvent(tx, input, entitled);
  assert.deepEqual(first, { eventId: EVENT, created: true, deliveryCount: 2 });
  assert.deepEqual(duplicate, { eventId: EVENT, created: false, deliveryCount: 0 });
  assert.equal(tx.events.size, 1);
  assert.equal(
    tx.calls.filter((call) => call.sql.startsWith('INSERT INTO saas_customer_webhook_deliveries')).length,
    1,
  );
  assert.match(
    tx.calls.find((call) => call.sql.startsWith('INSERT INTO saas_customer_webhook_events'))?.sql ?? '',
    /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/,
  );

  await assert.rejects(
    enqueueCustomerWebhookEvent(tx, { ...input, data: { ...EVENT_DATA, balance_minor_units: 100 } }, entitled),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    enqueueCustomerWebhookEvent(tx, input, {
      assertEntitled: async () => {
        throw new Error('NOT_ENTITLED');
      },
    }),
    /NOT_ENTITLED/,
  );
});

test('tenant resource references are verified under the transaction tenant before an event is persisted', async () => {
  const tx = new EnqueueExecutor();
  tx.resourceExists = false;
  await assert.rejects(
    enqueueCustomerWebhookEvent(
      tx,
      {
        tenantId: TENANT,
        idempotencyKey: 'key-expiring:1',
        eventType: 'api_key.expiring',
        occurredAt: NOW,
        data: { api_key_id: KEY, expires_at: '2026-10-01T00:00:00.000Z' },
      },
      {
        assertEntitled: async ({ tenantId }) => assert.equal(tenantId, TENANT),
      },
    ),
    /RESOURCE_TENANT_MISMATCH/,
  );
  const lookup = tx.calls.find((call) => call.sql.startsWith('SELECT 1 FROM saas_api_keys'));
  assert.deepEqual(lookup?.values.slice(0, 2), [TENANT, KEY]);
  assert.equal(tx.events.size, 0);
});

test('idempotent resource-event retries survive later business-state changes', async () => {
  const tx = new EnqueueExecutor();
  const input = {
    tenantId: TENANT,
    eventId: EVENT,
    idempotencyKey: 'key-expiring:immutable-event',
    eventType: 'api_key.expiring' as const,
    occurredAt: NOW,
    data: { api_key_id: KEY, expires_at: '2026-10-01T00:00:00.000Z' },
  };
  const entitlement: CustomerWebhookEventEntitlementPolicy = {
    async assertEntitled({ tenantId, eventType }) {
      assert.equal(tenantId, TENANT);
      assert.equal(eventType, 'api_key.expiring');
    },
  };

  assert.equal((await enqueueCustomerWebhookEvent(tx, input, entitlement)).created, true);
  tx.resourceExists = false;
  assert.deepEqual(await enqueueCustomerWebhookEvent(tx, input, entitlement), {
    eventId: EVENT,
    created: false,
    deliveryCount: 0,
  });
  assert.equal(tx.calls.filter((call) => call.sql.startsWith('SELECT 1 FROM saas_api_keys')).length, 1);
  assert.equal(tx.events.size, 1);
});

test('quota failure rolls back the event fact in the caller transaction savepoint', async () => {
  const tx = new EnqueueExecutor();
  tx.quotaExceeded = true;
  await assert.rejects(
    enqueueCustomerWebhookEvent(
      tx,
      {
        tenantId: TENANT,
        eventId: EVENT,
        idempotencyKey: 'quota-limited-event',
        eventType: 'wallet.low_balance',
        occurredAt: NOW,
        data: EVENT_DATA,
      },
      entitled,
    ),
    /WEBHOOK_TENANT_QUOTA_EXCEEDED/,
  );
  assert.equal(tx.events.size, 0);
  assert.ok(tx.calls.some((call) => call.sql === 'ROLLBACK TO SAVEPOINT model_router_customer_webhook_enqueue'));
  assert.equal(
    tx.calls.filter((call) => call.sql.startsWith('INSERT INTO saas_customer_webhook_deliveries')).length,
    0,
  );
});

interface FakeDeliveryState {
  tenantId: string;
  id: string;
  eventId: string;
  endpointId: string;
  endpointVersion: number;
  secretVersion: number;
  overlapSecretVersion: number | null;
  payloadVersion: number;
  attemptCount: number;
  attemptSequence: number;
  fencingToken: number;
  leaseToken: string | null;
  state: 'pending' | 'leased' | 'delivered' | 'dead_lettered';
  lastStatus: number | null;
  lastError: string | null;
}

class DeliveryDatabase implements SaasDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly attempts: Array<Record<string, unknown>> = [];
  delivery: FakeDeliveryState;
  now = new Date(NOW);

  constructor(attemptCount = 0, attemptSequence = attemptCount) {
    this.delivery = {
      tenantId: TENANT,
      id: DELIVERY,
      eventId: EVENT2,
      endpointId: ENDPOINT,
      endpointVersion: 1,
      secretVersion: 1,
      overlapSecretVersion: null,
      payloadVersion: 1,
      attemptCount,
      attemptSequence,
      fencingToken: attemptSequence,
      leaseToken: null,
      state: 'pending',
      lastStatus: null,
      lastError: null,
    };
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: <Row>(sql: string, values: readonly unknown[] = []) => this.execute<Row>(sql, values) });
  }
  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = normalize(sql);
    this.calls.push({ sql: statement, values: [...values] });
    if (statement.startsWith("UPDATE saas_customer_webhook_deliveries d SET state = 'cancelled'"))
      return result([] as Row[], 0);
    if (statement.startsWith("UPDATE saas_customer_webhook_delivery_attempts a SET state = 'dead_lettered'"))
      return result([] as Row[], 0);
    if (
      statement.startsWith('SELECT d.tenant_id, d.id, d.event_id') &&
      !statement.includes('JOIN saas_customer_webhook_events ev')
    ) {
      assert.match(statement, /FOR UPDATE OF d SKIP LOCKED/);
      if (this.delivery.state !== 'pending' || this.delivery.attemptCount >= CUSTOMER_WEBHOOK_MAX_ATTEMPTS)
        return result([] as Row[]);
      return result([
        {
          tenant_id: this.delivery.tenantId,
          id: this.delivery.id,
          event_id: this.delivery.eventId,
          endpoint_id: this.delivery.endpointId,
          endpoint_version: this.delivery.endpointVersion,
          secret_version: this.delivery.secretVersion,
          overlap_secret_version: this.delivery.overlapSecretVersion,
          payload_version: this.delivery.payloadVersion,
          attempt_count: this.delivery.attemptCount,
          attempt_sequence: this.delivery.attemptSequence,
          lease_token: this.delivery.leaseToken,
          fencing_token: String(this.delivery.fencingToken),
        },
      ] as Row[]);
    }
    if (statement.startsWith("UPDATE saas_customer_webhook_deliveries SET state = 'leased'")) {
      const [, id, attempts, sequence, fence, token] = values;
      if (String(id) !== this.delivery.id) return result([] as Row[], 0);
      this.delivery.state = 'leased';
      this.delivery.attemptCount = Number(attempts);
      this.delivery.attemptSequence = Number(sequence);
      this.delivery.fencingToken = Number(fence);
      this.delivery.leaseToken = String(token);
      return result([{ id }] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_delivery_attempts')) {
      this.attempts.push({
        tenant: values[0],
        id: values[1],
        sequence: values[2],
        fence: values[3],
        token: values[4],
        state: 'started',
      });
      return result([{}] as Row[]);
    }
    if (statement.startsWith('SELECT d.tenant_id, d.id, d.event_id, d.endpoint_id, d.endpoint_version')) {
      return result([
        {
          tenant_id: this.delivery.tenantId,
          id: this.delivery.id,
          event_id: this.delivery.eventId,
          endpoint_id: this.delivery.endpointId,
          endpoint_version: this.delivery.endpointVersion,
          secret_version: this.delivery.secretVersion,
          overlap_secret_version: null,
          payload_version: this.delivery.payloadVersion,
          attempt_count: this.delivery.attemptCount,
          attempt_sequence: this.delivery.attemptSequence,
          lease_token: this.delivery.leaseToken,
          fencing_token: String(this.delivery.fencingToken),
          event_type: 'wallet.low_balance',
          schema_version: 1,
          occurred_at: NOW,
          payload: EVENT_DATA,
          target_url: 'https://customer.example.test/webhook',
          secret_envelope: Buffer.from([1, 2, 3]),
          overlap_secret_envelope: null,
        },
      ] as Row[]);
    }
    if (statement.startsWith("UPDATE saas_customer_webhook_deliveries SET state = 'delivered'")) {
      const [tenant, id, token, fence, status] = values;
      if (
        tenant !== this.delivery.tenantId ||
        id !== this.delivery.id ||
        token !== this.delivery.leaseToken ||
        Number(fence) !== this.delivery.fencingToken ||
        this.delivery.state !== 'leased'
      ) {
        return result([] as Row[], 0);
      }
      this.delivery.state = 'delivered';
      this.delivery.lastStatus = Number(status);
      this.delivery.leaseToken = null;
      return result([] as Row[], 1);
    }
    if (statement.startsWith("UPDATE saas_customer_webhook_delivery_attempts SET state = 'delivered'"))
      return result([{}] as Row[], 1);
    if (statement.startsWith('SELECT attempt_count FROM saas_customer_webhook_deliveries')) {
      const [tenant, id, token, fence] = values;
      if (
        tenant !== this.delivery.tenantId ||
        id !== this.delivery.id ||
        token !== this.delivery.leaseToken ||
        Number(fence) !== this.delivery.fencingToken ||
        this.delivery.state !== 'leased'
      )
        return result([] as Row[]);
      return result([{ attempt_count: this.delivery.attemptCount }] as Row[]);
    }
    if (statement.startsWith('UPDATE saas_customer_webhook_deliveries SET state = $5')) {
      const [tenant, id, token, fence, state, status, , errorCode] = values;
      if (
        tenant !== this.delivery.tenantId ||
        id !== this.delivery.id ||
        token !== this.delivery.leaseToken ||
        Number(fence) !== this.delivery.fencingToken ||
        this.delivery.state !== 'leased'
      )
        return result([] as Row[], 0);
      this.delivery.state = state === 'pending' ? 'pending' : 'dead_lettered';
      this.delivery.lastStatus = status === null ? null : Number(status);
      this.delivery.lastError = String(errorCode);
      this.delivery.leaseToken = null;
      return result([] as Row[], 1);
    }
    if (statement.startsWith('UPDATE saas_customer_webhook_delivery_attempts SET state = $5'))
      return result([{}] as Row[], 1);
    if (statement.startsWith('UPDATE saas_customer_webhook_tenant_usage')) return result([{}] as Row[], 1);
    if (statement.startsWith('SELECT tenant_id, id FROM saas_customer_webhook_deliveries')) {
      return result(
        this.delivery.state === 'delivered' || this.delivery.state === 'dead_lettered'
          ? ([{ tenant_id: this.delivery.tenantId, id: this.delivery.id }] as Row[])
          : ([] as Row[]),
      );
    }
    if (statement.startsWith('DELETE FROM saas_customer_webhook_delivery_attempts')) return result([] as Row[], 2);
    if (statement.startsWith('SELECT 1 FROM saas_customer_webhook_delivery_attempts')) return result([] as Row[]);
    if (statement.startsWith('DELETE FROM saas_customer_webhook_deliveries')) return result([] as Row[], 1);
    return result([] as Row[]);
  }
}

test('delivery lease is skip-locked, snapshots immutable event/endpoint/secret versions, and fences completion', async () => {
  const database = new DeliveryDatabase();
  const store = new PostgresCustomerWebhookDeliveryStore(database);
  const claimed = await store.claimReady(1, 60_000);
  assert.equal(claimed.length, 1);
  const delivery = claimed[0] as ClaimedCustomerWebhookDelivery;
  assert.equal(delivery.event.event_id, EVENT2);
  assert.equal(delivery.endpointVersion, 1);
  assert.equal(delivery.payloadVersion, 1);
  assert.deepEqual(
    delivery.signingSecrets.map((secret) => secret.version),
    [1],
  );
  assert.equal(delivery.attemptNumber, 1);
  assert.equal(delivery.attemptSequence, 1);
  assert.equal(database.attempts.length, 1);

  assert.equal(
    await store.markDelivered({
      tenantId: TENANT,
      deliveryId: DELIVERY,
      leaseToken: delivery.leaseToken,
      fencingToken: delivery.fencingToken + 1,
      httpStatus: 204,
      latencyMs: 10,
    }),
    false,
  );
  assert.equal(
    await store.recordFailure({
      tenantId: TENANT,
      deliveryId: DELIVERY,
      leaseToken: delivery.leaseToken,
      fencingToken: delivery.fencingToken + 1,
      errorCode: 'NETWORK_ERROR',
      retryable: true,
    }),
    'stale',
  );
  assert.equal(
    await store.markDelivered({
      tenantId: TENANT,
      deliveryId: DELIVERY,
      leaseToken: delivery.leaseToken,
      fencingToken: delivery.fencingToken,
      httpStatus: 204,
      latencyMs: 10,
    }),
    true,
  );
  assert.equal(database.delivery.state, 'delivered');
});

test('retry uses bounded exponential backoff and the final permitted attempt dead-letters', async () => {
  const retryDb = new DeliveryDatabase(1, 1);
  const retryStore = new PostgresCustomerWebhookDeliveryStore(retryDb);
  const [retryDelivery] = await retryStore.claimReady(1, 60_000);
  assert.ok(retryDelivery);
  assert.equal(
    await retryStore.recordFailure(
      {
        tenantId: TENANT,
        deliveryId: DELIVERY,
        leaseToken: retryDelivery.leaseToken,
        fencingToken: retryDelivery.fencingToken,
        errorCode: 'HTTP_STATUS',
        retryable: true,
        httpStatus: 503,
        latencyMs: 120,
      },
      { baseBackoffMs: 1_000, maxBackoffMs: 5_000 },
    ),
    'retrying',
  );
  const retryUpdate = retryDb.calls.find((call) =>
    call.sql.startsWith('UPDATE saas_customer_webhook_deliveries SET state = $5'),
  );
  assert.equal(retryUpdate?.values[8], 2_000);
  assert.equal(retryDb.delivery.state, 'pending');
  assert.equal(retryDb.delivery.eventId, EVENT2);

  const deadDb = new DeliveryDatabase(CUSTOMER_WEBHOOK_MAX_ATTEMPTS - 1, CUSTOMER_WEBHOOK_MAX_ATTEMPTS - 1);
  const deadStore = new PostgresCustomerWebhookDeliveryStore(deadDb);
  const [lastAttempt] = await deadStore.claimReady(1, 60_000);
  assert.equal(lastAttempt?.attemptNumber, CUSTOMER_WEBHOOK_MAX_ATTEMPTS);
  assert.equal(
    await deadStore.recordFailure({
      tenantId: TENANT,
      deliveryId: DELIVERY,
      leaseToken: lastAttempt?.leaseToken ?? '',
      fencingToken: lastAttempt?.fencingToken ?? 0,
      errorCode: 'HTTP_STATUS',
      retryable: true,
      httpStatus: 503,
    }),
    'dead_lettered',
  );
  assert.equal(deadDb.delivery.state, 'dead_lettered');
});

test('terminal delivery details are pruned after bounded retention while immutable event/idempotency facts remain', async () => {
  const database = new DeliveryDatabase();
  database.delivery.state = 'delivered';
  const store = new PostgresCustomerWebhookDeliveryStore(database);
  const result = await store.pruneTerminalHistory({
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    limit: 10,
    now: new Date('2026-10-01T00:00:00.000Z'),
  });
  assert.deepEqual(result, { deliveries: 1, attempts: 2 });
  assert.ok(
    database.calls.some((call) => call.sql.startsWith('SELECT tenant_id, id FROM saas_customer_webhook_deliveries')),
  );
  assert.ok(database.calls.some((call) => call.sql.startsWith('DELETE FROM saas_customer_webhook_delivery_attempts')));
  assert.ok(database.calls.some((call) => call.sql.startsWith('DELETE FROM saas_customer_webhook_deliveries')));
  assert.equal(
    database.calls.some((call) => call.sql.startsWith('DELETE FROM saas_customer_webhook_events')),
    false,
  );
  await assert.rejects(store.pruneTerminalHistory({ retentionMs: 1_000 }), /7 and 365 days/);
});

test('migration encodes append-only facts, tenant composite references, bounded attempts, and a safe payload allowlist', () => {
  const sql = CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION.sql;
  assert.equal(CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION.version, 43);
  assert.match(sql, /saas_customer_webhook_events_immutable/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, api_key_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, service_plan_order_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, refund_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, request_id, project_id, request_supply_mode\)/);
  assert.match(sql, /FOR EACH ROW EXECUTE FUNCTION saas_customer_webhook_attempt_transition_guard/);
  assert.match(sql, /attempt_count BETWEEN 0 AND 12/);
  assert.match(sql, /customer_webhook_events_payload_contract/);
  assert.doesNotMatch(sql, /prompt|response_body|credential_value|payment_secret/i);
});
