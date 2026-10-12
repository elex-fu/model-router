import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { CustomerWebhookNotificationScanner } from '../../../src/saas/webhooks/notification-scanner.js';
import {
  type CustomerWebhookEventDrop,
  createCustomerWebhookEventProducer,
} from '../../../src/saas/webhooks/producers.js';

// F3: the scanner runs the REAL producer + REAL enqueue + REAL Postgres
// entitlement policy over a fake database, proving bucket idempotency,
// conflict-skip on moved balances, entitlement filtering and fail-closed rows.

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-10T08:00:00.000Z');

interface PolicyRow {
  enabled: boolean;
  allowed_event_types: string[];
  low_balance_threshold_minor_units: string | null;
}

interface WalletRow {
  tenant_id: string;
  currency: string;
  posted_balance_minor_units: string;
}

interface KeyRow {
  tenant_id: string;
  id: string;
  status: string;
  expires_at: string | null;
}

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class ScannerDatabase implements SaasDatabase {
  readonly policies = new Map<string, PolicyRow>();
  readonly wallets: WalletRow[] = [];
  readonly apiKeys: KeyRow[] = [];
  readonly events = new Map<string, { payload: unknown; occurredAt: string }>();
  readonly calls: string[] = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalize(sql);
    this.calls.push(statement);
    if (statement.startsWith('SAVEPOINT') || statement.startsWith('RELEASE SAVEPOINT')) {
      return result([] as Row[], 0);
    }
    if (statement.startsWith('SELECT w.tenant_id, w.currency, w.posted_balance_minor_units')) {
      const rows = this.wallets.flatMap((wallet) => {
        const policy = this.policies.get(wallet.tenant_id);
        if (
          !policy ||
          policy.enabled !== true ||
          policy.low_balance_threshold_minor_units === null ||
          !policy.allowed_event_types.includes('wallet.low_balance') ||
          BigInt(wallet.posted_balance_minor_units) > BigInt(policy.low_balance_threshold_minor_units)
        ) {
          return [];
        }
        return [
          {
            tenant_id: wallet.tenant_id,
            currency: wallet.currency,
            posted_balance_minor_units: wallet.posted_balance_minor_units,
            low_balance_threshold_minor_units: policy.low_balance_threshold_minor_units,
          },
        ];
      });
      return result(rows.slice(0, Number(values[0])) as Row[]);
    }
    if (statement.startsWith('SELECT k.tenant_id, k.id, k.expires_at')) {
      const [nowIso, windowEndIso, limit] = values as [string, string, number];
      const nowMs = Date.parse(nowIso);
      const windowEndMs = Date.parse(windowEndIso);
      const rows = this.apiKeys.flatMap((key) => {
        const policy = this.policies.get(key.tenant_id);
        const expiresMs = key.expires_at === null ? null : Date.parse(key.expires_at);
        if (
          !policy ||
          policy.enabled !== true ||
          !policy.allowed_event_types.includes('api_key.expiring') ||
          key.status !== 'active' ||
          expiresMs === null ||
          expiresMs <= nowMs ||
          expiresMs > windowEndMs
        ) {
          return [];
        }
        return [{ tenant_id: key.tenant_id, id: key.id, expires_at: key.expires_at }];
      });
      return result(rows.slice(0, Number(limit)) as Row[]);
    }
    if (statement.startsWith('SELECT enabled, allowed_event_types')) {
      const policy = this.policies.get(String(values[0]));
      return result(
        (policy ? [{ enabled: policy.enabled, allowed_event_types: policy.allowed_event_types }] : []) as Row[],
      );
    }
    if (statement.startsWith('SELECT enabled, max_events_per_minute, max_pending_deliveries')) {
      return result([{ enabled: true, max_events_per_minute: 1000, max_pending_deliveries: 1000 }] as Row[]);
    }
    if (statement.startsWith('SELECT count(*) AS target_count')) {
      return result([{ target_count: 0 }] as Row[]);
    }
    if (statement.startsWith('SELECT 1 FROM saas_api_keys')) {
      const [tenantId, keyId, expiresAt] = values as [string, string, string];
      const key = this.apiKeys.find(
        (row) =>
          row.tenant_id === tenantId &&
          row.id === keyId &&
          row.status === 'active' &&
          row.expires_at !== null &&
          new Date(row.expires_at).toISOString() === new Date(expiresAt).toISOString(),
      );
      return result((key ? [{}] : []) as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_tenant_usage')) return result([] as Row[], 0);
    if (statement.startsWith('UPDATE saas_customer_webhook_tenant_usage')) return result([{}] as Row[], 1);
    if (statement.startsWith('INSERT INTO saas_customer_webhook_events')) {
      const key = `${String(values[0])}:${String(values[2])}`;
      if (this.events.has(key)) return result([] as Row[], 0);
      this.events.set(key, { occurredAt: String(values[4]), payload: JSON.parse(String(values[5])) });
      return result([{ event_id: values[1] }] as Row[]);
    }
    if (statement.startsWith('SELECT event_id, event_type')) {
      const stored = this.events.get(`${String(values[0])}:${String(values[1])}`);
      return result(
        (stored
          ? [
              {
                event_id: '99999999-9999-4999-8999-999999999999',
                event_type: String(values[1]).split(':')[0],
                schema_version: 1,
                occurred_at: stored.occurredAt,
                payload: stored.payload,
                tenant_id: values[0],
                idempotency_key: values[1],
              },
            ]
          : []) as Row[],
      );
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_deliveries')) return result([] as Row[], 0);
    return result([] as Row[]);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.events);
    try {
      return await work(this);
    } catch (error) {
      this.events.clear();
      for (const [key, value] of snapshot) this.events.set(key, value);
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function createScanner(
  database: ScannerDatabase,
  options: {
    onEventDropped?: (drop: CustomerWebhookEventDrop) => void;
    onError?: (code: 'scan_event_failed') => void;
  } = {},
): CustomerWebhookNotificationScanner {
  return new CustomerWebhookNotificationScanner(
    database,
    createCustomerWebhookEventProducer({
      ...(options.onEventDropped ? { onEventDropped: options.onEventDropped } : {}),
    }),
    { now: () => new Date(NOW), ...(options.onError ? { onError: options.onError } : {}) },
  );
}

test('a low platform wallet balance emits one band-bucketed event per day', async () => {
  const database = new ScannerDatabase();
  database.policies.set(TENANT, {
    enabled: true,
    allowed_event_types: ['wallet.low_balance'],
    low_balance_threshold_minor_units: '1000',
  });
  database.wallets.push({ tenant_id: TENANT, currency: 'USD', posted_balance_minor_units: '400' });
  const scanner = createScanner(database);

  const first = await scanner.runOnce();
  assert.deepEqual(first, {
    lowBalanceEmitted: 1,
    lowBalanceSkipped: 0,
    expiringKeysEmitted: 0,
    expiringKeysSkipped: 0,
    failed: 0,
  });
  const key = `${TENANT}:wallet.low_balance:${TENANT}:USD:2026-10-10:band-6`;
  const stored = database.events.get(key);
  assert.ok(stored);
  assert.deepEqual(stored.payload, {
    supply_mode: 'platform',
    balance_minor_units: 400,
    threshold_minor_units: 1000,
    currency: 'USD',
  });
  assert.equal(stored.occurredAt, NOW.toISOString());

  const replay = await scanner.runOnce();
  assert.equal(replay.lowBalanceEmitted, 1, 'same-bucket replay is idempotent at the store');
  assert.equal(database.events.size, 1);
});

test('a balance moving within the same band conflicts and is skipped, a new band emits', async () => {
  const database = new ScannerDatabase();
  database.policies.set(TENANT, {
    enabled: true,
    allowed_event_types: ['wallet.low_balance'],
    low_balance_threshold_minor_units: '1000',
  });
  database.wallets.push({ tenant_id: TENANT, currency: 'USD', posted_balance_minor_units: '400' });
  const scanner = createScanner(database);
  await scanner.runOnce();

  // Same band (6), different balance: payload mismatch on the stored key.
  database.wallets[0]!.posted_balance_minor_units = '350';
  const conflicted = await scanner.runOnce();
  assert.equal(conflicted.lowBalanceSkipped, 1);
  assert.equal(conflicted.lowBalanceEmitted, 0);
  assert.equal(database.events.size, 1);

  // A deeper band emits a second event.
  database.wallets[0]!.posted_balance_minor_units = '150';
  const deeper = await scanner.runOnce();
  assert.equal(deeper.lowBalanceEmitted, 1);
  assert.equal(database.events.size, 2);
});

test('tenants without a threshold or without the whitelist entry never produce rows', async () => {
  const database = new ScannerDatabase();
  database.policies.set(TENANT, {
    enabled: true,
    allowed_event_types: ['wallet.low_balance'],
    low_balance_threshold_minor_units: null,
  });
  database.policies.set(TENANT_B, {
    enabled: true,
    allowed_event_types: ['api_key.expiring'],
    low_balance_threshold_minor_units: '1000',
  });
  database.wallets.push({ tenant_id: TENANT, currency: 'USD', posted_balance_minor_units: '10' });
  database.wallets.push({ tenant_id: TENANT_B, currency: 'USD', posted_balance_minor_units: '10' });
  const outcome = await createScanner(database).runOnce();
  assert.equal(outcome.lowBalanceEmitted, 0);
  assert.equal(database.events.size, 0);
});

test('an active key expiring inside the window emits once per committed expiry', async () => {
  const database = new ScannerDatabase();
  database.policies.set(TENANT, {
    enabled: true,
    allowed_event_types: ['api_key.expiring'],
    low_balance_threshold_minor_units: null,
  });
  const expiresAt = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  database.apiKeys.push({ tenant_id: TENANT, id: KEY_ID, status: 'active', expires_at: expiresAt });
  const scanner = createScanner(database);

  const outcome = await scanner.runOnce();
  assert.equal(outcome.expiringKeysEmitted, 1);
  const key = `${TENANT}:api_key.expiring:${KEY_ID}:expires-${Date.parse(expiresAt)}`;
  const stored = database.events.get(key);
  assert.ok(stored);
  assert.deepEqual(stored.payload, { api_key_id: KEY_ID, expires_at: expiresAt });
  // occurred_at is the deterministic window-entry timestamp.
  assert.equal(stored.occurredAt, new Date(Date.parse(expiresAt) - 7 * 24 * 60 * 60 * 1000).toISOString());

  const replay = await scanner.runOnce();
  assert.equal(replay.expiringKeysEmitted, 1);
  assert.equal(database.events.size, 1);
});

test('keys outside the window, expired, revoked or not whitelisted are excluded', async () => {
  const database = new ScannerDatabase();
  database.policies.set(TENANT, {
    enabled: true,
    allowed_event_types: ['api_key.expiring'],
    low_balance_threshold_minor_units: null,
  });
  database.apiKeys.push(
    {
      tenant_id: TENANT,
      id: KEY_ID,
      status: 'active',
      expires_at: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(),
    },
    {
      tenant_id: TENANT,
      id: KEY_ID,
      status: 'revoked',
      expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
    },
    { tenant_id: TENANT, id: KEY_ID, status: 'active', expires_at: null },
    {
      tenant_id: TENANT_B,
      id: KEY_ID,
      status: 'active',
      expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
    },
  );
  const outcome = await createScanner(database).runOnce();
  assert.equal(outcome.expiringKeysEmitted, 0);
  assert.equal(database.events.size, 0);
});

test('malformed scan rows fail closed and report through onError', async () => {
  const database = new ScannerDatabase();
  // The scan join surfaces this row, but the tenant id cannot pass the
  // producer's UUID validation, so the enqueue fails closed inside its own tx.
  database.policies.set('not-a-uuid', {
    enabled: true,
    allowed_event_types: ['wallet.low_balance'],
    low_balance_threshold_minor_units: '1000',
  });
  database.wallets.push({ tenant_id: 'not-a-uuid', currency: 'USD', posted_balance_minor_units: '10' });
  const errors: string[] = [];
  const scanner = createScanner(database, { onError: (code) => errors.push(code) });
  const outcome = await scanner.runOnce();
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.lowBalanceEmitted, 0);
  assert.deepEqual(errors, ['scan_event_failed']);
  assert.equal(database.events.size, 0);
});

test('an entitlement race drops the event without failing the sweep', async () => {
  const database = new ScannerDatabase();
  database.policies.set(TENANT, {
    enabled: true,
    allowed_event_types: ['wallet.low_balance'],
    low_balance_threshold_minor_units: '1000',
  });
  database.wallets.push({ tenant_id: TENANT, currency: 'USD', posted_balance_minor_units: '10' });
  const drops: CustomerWebhookEventDrop[] = [];
  // The scan SELECT sees the whitelist, but the enqueue-time entitlement check
  // sees a policy without the event (race between scan and policy update).
  const scanner = new CustomerWebhookNotificationScanner(
    database,
    createCustomerWebhookEventProducer({
      onEventDropped: (drop) => drops.push(drop),
      entitlement: {
        assertEntitled: async () => {
          throw new Error('WEBHOOK_ENTITLEMENT_DENIED');
        },
      },
    }),
    { now: () => new Date(NOW) },
  );
  const outcome = await scanner.runOnce();
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.lowBalanceEmitted, 1, 'the drop is swallowed by the producer');
  assert.equal(database.events.size, 0);
  assert.equal(drops[0]?.code, 'WEBHOOK_ENTITLEMENT_DENIED');
});

test('option validation fails closed', () => {
  const database = new ScannerDatabase();
  const producer = createCustomerWebhookEventProducer();
  assert.throws(() => new CustomerWebhookNotificationScanner(database, producer, { batchSize: 0 }), RangeError);
  assert.throws(() => new CustomerWebhookNotificationScanner(database, producer, { batchSize: 501 }), RangeError);
  assert.throws(
    () => new CustomerWebhookNotificationScanner(database, producer, { expiringKeyWindowMs: 60_000 }),
    RangeError,
  );
  assert.throws(() => new CustomerWebhookNotificationScanner(database, {} as never), TypeError);
});
