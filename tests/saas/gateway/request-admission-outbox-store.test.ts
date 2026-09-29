import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresRequestAdmissionOutboxStore } from '../../../src/saas/gateway/request-admission-outbox-store.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_A_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_B_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_A_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_B_ID = '66666666-6666-4666-8666-666666666666';
const OUTBOX_A_ID = '77777777-7777-4777-8777-777777777777';
const OUTBOX_B_ID = '88888888-8888-4888-8888-888888888888';
const MAX_DELIVERY_ATTEMPTS = 2_147_483_647;
const INITIAL_NOW = new Date('2026-09-28T00:00:00.000Z');
const RETRY_AT = new Date('2026-09-28T00:01:00.000Z');

type SupplyMode = 'byok' | 'platform';
type DeliveryState = 'pending' | 'failed' | 'leased' | 'delivered';

interface StoredOutboxRow {
  id: string;
  tenant_id: string;
  project_id: string;
  request_id: string;
  attempt_id: string;
  supply_mode: SupplyMode;
  event_key: string;
  event_type: 'request.admitted';
  schema_version: number;
  payload: unknown;
  delivery_state: DeliveryState;
  available_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  delivery_attempts: number;
  last_error_code: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface QueryCall {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly inTransaction: boolean;
}

interface RowIdentity {
  readonly id: string;
  readonly request_id: string;
  readonly attempt_id: string;
}

const ROW_A: RowIdentity = {
  id: OUTBOX_A_ID,
  request_id: REQUEST_A_ID,
  attempt_id: ATTEMPT_A_ID,
};

const ROW_B: RowIdentity = {
  id: OUTBOX_B_ID,
  request_id: REQUEST_B_ID,
  attempt_id: ATTEMPT_B_ID,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function metadataPayload(row: StoredOutboxRow): Record<string, unknown> {
  return {
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    request_id: row.request_id,
    attempt_id: row.attempt_id,
    supply_mode: row.supply_mode,
    schema_version: row.schema_version,
  };
}

function makeRow(identity: RowIdentity = ROW_A, overrides: Partial<StoredOutboxRow> = {}): StoredOutboxRow {
  const base: StoredOutboxRow = {
    id: identity.id,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    request_id: identity.request_id,
    attempt_id: identity.attempt_id,
    supply_mode: 'platform',
    event_key: `request-admitted:${identity.request_id}`,
    event_type: 'request.admitted',
    schema_version: 1,
    payload: null,
    delivery_state: 'pending',
    available_at: new Date(INITIAL_NOW),
    lease_token: null,
    lease_expires_at: null,
    delivery_attempts: 0,
    last_error_code: null,
    delivered_at: null,
    created_at: new Date(INITIAL_NOW),
    updated_at: new Date(INITIAL_NOW),
  };
  const row = { ...base, ...overrides };
  return { ...row, payload: overrides.payload ?? metadataPayload(row) };
}

function returningRow(row: StoredOutboxRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    request_id: row.request_id,
    attempt_id: row.attempt_id,
    supply_mode: row.supply_mode,
    event_key: row.event_key,
    event_type: row.event_type,
    schema_version: row.schema_version,
    payload: row.payload,
    lease_token: row.lease_token,
    delivery_attempts: row.delivery_attempts,
  };
}

class FakeSqlExecutor implements SqlExecutor {
  constructor(
    private readonly database: FakeSaasDatabase,
    private readonly inTransaction: boolean,
  ) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalizeSql(sql);
    this.database.calls.push({ sql: statement, values: [...values], inTransaction: this.inTransaction });

    if (statement.startsWith('SELECT id FROM saas_request_admission_outbox')) {
      const limit = Number(values[0]);
      const ready = this.database.rows
        .filter((row) => {
          if (row.delivery_attempts >= MAX_DELIVERY_ATTEMPTS) return false;
          const pendingOrFailed =
            (row.delivery_state === 'pending' || row.delivery_state === 'failed') &&
            row.available_at.getTime() <= this.database.now.getTime();
          const expiredLease =
            row.delivery_state === 'leased' &&
            row.lease_expires_at !== null &&
            row.lease_expires_at.getTime() <= this.database.now.getTime();
          return pendingOrFailed || expiredLease;
        })
        .sort(
          (left, right) => left.created_at.getTime() - right.created_at.getTime() || left.id.localeCompare(right.id),
        )
        .slice(0, limit)
        .map((row) => ({ id: row.id }));
      return result(ready as Row[]);
    }

    if (statement.startsWith("UPDATE saas_request_admission_outbox SET delivery_state = 'leased'")) {
      const [id, leaseToken, leaseMs] = values;
      const row = this.database.rows.find((candidate) => candidate.id === id);
      if (!row) return result([] as Row[]);

      row.delivery_state = 'leased';
      row.lease_token = String(leaseToken);
      row.lease_expires_at = new Date(this.database.now.getTime() + Number(leaseMs));
      row.delivery_attempts += 1;
      row.updated_at = new Date(this.database.now);
      return result([returningRow(row) as Row]);
    }

    if (statement.startsWith("UPDATE saas_request_admission_outbox SET delivery_state = 'delivered'")) {
      const [id, leaseToken] = values;
      const row = this.database.rows.find(
        (candidate) =>
          candidate.id === id &&
          candidate.lease_token === leaseToken &&
          candidate.delivery_state === 'leased' &&
          candidate.lease_expires_at !== null &&
          candidate.lease_expires_at.getTime() > this.database.now.getTime(),
      );
      if (!row) return result([] as Row[], 0);

      row.delivery_state = 'delivered';
      row.delivered_at = new Date(this.database.now);
      row.lease_token = null;
      row.lease_expires_at = null;
      row.last_error_code = null;
      row.updated_at = new Date(this.database.now);
      return result([] as Row[], 1);
    }

    if (statement.startsWith("UPDATE saas_request_admission_outbox SET delivery_state = 'failed'")) {
      const [id, leaseToken, availableAt, safeErrorCode] = values;
      const row = this.database.rows.find(
        (candidate) =>
          candidate.id === id &&
          candidate.lease_token === leaseToken &&
          candidate.delivery_state === 'leased' &&
          candidate.lease_expires_at !== null &&
          candidate.lease_expires_at.getTime() > this.database.now.getTime(),
      );
      if (!row) return result([] as Row[], 0);

      row.delivery_state = 'failed';
      row.available_at = new Date((availableAt as Date).getTime());
      row.last_error_code = String(safeErrorCode);
      row.lease_token = null;
      row.lease_expires_at = null;
      row.delivered_at = null;
      row.updated_at = new Date(this.database.now);
      return result([] as Row[], 1);
    }

    throw new Error(`Unexpected outbox SQL: ${statement}`);
  }
}

class FakeSaasDatabase implements SaasDatabase {
  readonly calls: QueryCall[] = [];
  readonly transactionExecutors: SqlExecutor[] = [];
  now = new Date(INITIAL_NOW);
  transactionCount = 0;
  commitCount = 0;
  rollbackCount = 0;

  constructor(public rows: StoredOutboxRow[]) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return new FakeSqlExecutor(this, false).query(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const snapshot = clone(this.rows);
    const executor = new FakeSqlExecutor(this, true);
    this.transactionExecutors.push(executor);
    try {
      const value = await work(executor);
      this.commitCount += 1;
      return value;
    } catch (error) {
      this.rows = snapshot;
      this.rollbackCount += 1;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function createStore(database: FakeSaasDatabase): PostgresRequestAdmissionOutboxStore {
  return new PostgresRequestAdmissionOutboxStore(database);
}

test('claims ready rows in one transaction with row locks, unique lease tokens, and incremented attempts', async () => {
  const database = new FakeSaasDatabase([makeRow(ROW_A), makeRow(ROW_B)]);
  const store = createStore(database);

  const events = await store.claimReady(2, 5_000);

  assert.equal(database.transactionCount, 1);
  assert.equal(database.commitCount, 1);
  assert.equal(database.rollbackCount, 0);
  assert.deepEqual(
    events.map((event) => event.id),
    [OUTBOX_A_ID, OUTBOX_B_ID],
  );
  assert.equal(events[0]?.deliveryAttempts, 1);
  assert.equal(events[1]?.deliveryAttempts, 1);
  assert.notEqual(events[0]?.leaseToken, events[1]?.leaseToken);
  assert.match(events[0]?.leaseToken ?? '', /^[0-9a-f-]{36}$/i);
  assert.match(events[1]?.leaseToken ?? '', /^[0-9a-f-]{36}$/i);

  const select = database.calls.find((call) => call.sql.startsWith('SELECT id FROM saas_request_admission_outbox'));
  assert.ok(select);
  assert.equal(select.inTransaction, true);
  assert.equal(select.values[0], 2);
  assert.match(select.sql, /FOR UPDATE SKIP LOCKED$/);

  const claimUpdates = database.calls.filter((call) =>
    call.sql.startsWith("UPDATE saas_request_admission_outbox SET delivery_state = 'leased'"),
  );
  assert.equal(claimUpdates.length, 2);
  assert.ok(claimUpdates.every((call) => call.inTransaction));
  assert.ok(claimUpdates.every((call) => Number(call.values[2]) === 5_000));

  for (const event of events) {
    assert.deepEqual(event.payload, {
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      request_id: event.requestId,
      attempt_id: event.attemptId,
      supply_mode: 'platform',
      schema_version: 1,
    });
    assert.deepEqual(Object.keys(event.payload).sort(), [
      'attempt_id',
      'project_id',
      'request_id',
      'schema_version',
      'supply_mode',
      'tenant_id',
    ]);
    assert.equal(JSON.stringify(event.payload).includes('email'), false);
    assert.equal(JSON.stringify(event.payload).includes('user_agent'), false);
  }

  assert.ok(database.rows.every((row) => row.delivery_state === 'leased'));
  assert.ok(database.rows.every((row) => row.delivery_attempts === 1));
  assert.ok(database.rows.every((row) => row.lease_token !== null && row.lease_expires_at !== null));
});

test('accepts canonical UUIDs regardless of version and variant', async () => {
  const row = makeRow(ROW_A, {
    id: '77777777-7777-1777-0777-777777777777',
    tenant_id: '11111111-1111-0111-0111-111111111111',
    project_id: '22222222-2222-0222-0222-222222222222',
    request_id: '33333333-3333-1333-0333-333333333333',
    attempt_id: '44444444-4444-1444-0444-444444444444',
  });
  const database = new FakeSaasDatabase([row]);
  const store = createStore(database);

  const [event] = await store.claimReady(1, 1_000);

  assert.ok(event);
  assert.equal(event.id, row.id);
  assert.equal(event.tenantId, row.tenant_id);
  assert.equal(event.projectId, row.project_id);
  assert.equal(event.requestId, row.request_id);
  assert.equal(event.attemptId, row.attempt_id);
});

test('skips int4-saturated attempts without rolling back other claims', async () => {
  const saturatedRow = makeRow(ROW_A, { delivery_attempts: MAX_DELIVERY_ATTEMPTS });
  const database = new FakeSaasDatabase([saturatedRow, makeRow(ROW_B)]);
  const store = createStore(database);

  const events = await store.claimReady(2, 1_000);

  assert.deepEqual(
    events.map((event) => event.id),
    [OUTBOX_B_ID],
  );
  assert.equal(database.commitCount, 1);
  assert.equal(database.rollbackCount, 0);
  assert.equal(saturatedRow.delivery_state, 'pending');
  assert.equal(saturatedRow.delivery_attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(database.rows[1]?.delivery_attempts, 1);

  const select = database.calls.find((call) => call.sql.startsWith('SELECT id FROM saas_request_admission_outbox'));
  assert.ok(select);
  assert.match(select.sql, /delivery_attempts < 2147483647/);
});

test('accepts only the exact identity-matching metadata payload and rejects PII fields', async () => {
  const validRow = makeRow(ROW_A, { payload: JSON.stringify(metadataPayload(makeRow(ROW_A))) });
  const piiRow = makeRow(ROW_B, {
    payload: {
      ...metadataPayload(makeRow(ROW_B)),
      email: 'alice@example.com',
      source_ip: '192.0.2.10',
      user_agent: 'test-agent',
    },
  });
  const database = new FakeSaasDatabase([validRow, piiRow]);
  const before = clone(database.rows);
  const store = createStore(database);

  await assert.rejects(store.claimReady(2, 1_000), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'Outbox payload contains unsupported fields');
    return true;
  });

  assert.equal(database.rollbackCount, 1);
  assert.equal(database.commitCount, 0);
  assert.deepEqual(database.rows, before);
});

test('rejects a payload whose metadata does not match the claimed row identity', async () => {
  const database = new FakeSaasDatabase([makeRow(ROW_B, { payload: metadataPayload(makeRow(ROW_A)) })]);
  const store = createStore(database);

  await assert.rejects(store.claimReady(1, 1_000), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'Outbox payload does not match its row identity');
    return true;
  });
  assert.equal(database.rollbackCount, 1);
  assert.equal(database.rows[0]?.delivery_attempts, 0);
  assert.equal(database.rows[0]?.lease_token, null);
});

test('acknowledges and reschedules through lease-token and active-lease CAS predicates', async () => {
  const database = new FakeSaasDatabase([makeRow(ROW_A), makeRow(ROW_B)]);
  const store = createStore(database);
  const [ackEvent, retryEvent] = await store.claimReady(2, 10_000);
  assert.ok(ackEvent);
  assert.ok(retryEvent);

  assert.equal(await store.markDelivered(ackEvent.id, ackEvent.leaseToken), true);
  assert.equal(await store.rescheduleFailure(retryEvent.id, retryEvent.leaseToken, RETRY_AT, 'UPSTREAM_TIMEOUT'), true);

  const delivered = database.rows.find((row) => row.id === ackEvent.id);
  assert.ok(delivered);
  assert.equal(delivered.delivery_state, 'delivered');
  assert.equal(delivered.lease_token, null);
  assert.equal(delivered.lease_expires_at, null);
  assert.equal(delivered.last_error_code, null);

  const failed = database.rows.find((row) => row.id === retryEvent.id);
  assert.ok(failed);
  assert.equal(failed.delivery_state, 'failed');
  assert.equal(failed.available_at.getTime(), RETRY_AT.getTime());
  assert.equal(failed.last_error_code, 'UPSTREAM_TIMEOUT');
  assert.equal(failed.lease_token, null);
  assert.equal(failed.lease_expires_at, null);
  assert.equal(failed.delivered_at, null);

  const deliveredUpdate = database.calls.find((call) =>
    call.sql.startsWith("UPDATE saas_request_admission_outbox SET delivery_state = 'delivered'"),
  );
  assert.ok(deliveredUpdate);
  assert.deepEqual(deliveredUpdate.values, [ackEvent.id, ackEvent.leaseToken]);
  assert.match(
    deliveredUpdate.sql,
    /WHERE id = \$1 AND lease_token = \$2 AND delivery_state = 'leased' AND lease_expires_at > clock_timestamp\(\)/,
  );

  const failedUpdate = database.calls.find((call) =>
    call.sql.startsWith("UPDATE saas_request_admission_outbox SET delivery_state = 'failed'"),
  );
  assert.ok(failedUpdate);
  assert.deepEqual(failedUpdate.values, [retryEvent.id, retryEvent.leaseToken, RETRY_AT, 'UPSTREAM_TIMEOUT']);
  assert.match(
    failedUpdate.sql,
    /WHERE id = \$1 AND lease_token = \$2 AND delivery_state = 'leased' AND lease_expires_at > clock_timestamp\(\)/,
  );
  assert.equal(database.transactionCount, 3);
});

test('returns false for expired leases and stale tokens without changing the claimed row', async () => {
  const database = new FakeSaasDatabase([makeRow(ROW_A)]);
  const store = createStore(database);
  const [firstEvent] = await store.claimReady(1, 100);
  assert.ok(firstEvent);

  database.now = new Date(INITIAL_NOW.getTime() + 101);
  assert.equal(await store.markDelivered(firstEvent.id, firstEvent.leaseToken), false);
  assert.equal(database.rows[0]?.delivery_state, 'leased');
  assert.equal(database.rows[0]?.lease_token, firstEvent.leaseToken);

  const [renewedEvent] = await store.claimReady(1, 100);
  assert.ok(renewedEvent);
  assert.notEqual(renewedEvent.leaseToken, firstEvent.leaseToken);
  assert.equal(renewedEvent.deliveryAttempts, 2);
  assert.equal(
    await store.rescheduleFailure(renewedEvent.id, firstEvent.leaseToken, RETRY_AT, 'UPSTREAM_TIMEOUT'),
    false,
  );
  assert.equal(database.rows[0]?.delivery_state, 'leased');
  assert.equal(database.rows[0]?.lease_token, renewedEvent.leaseToken);
  assert.equal(database.rows[0]?.delivery_attempts, 2);
});

test('rejects invalid bounds, dates, identifiers, lease tokens, and safe error codes before storage access', async () => {
  const database = new FakeSaasDatabase([makeRow(ROW_A)]);
  const store = createStore(database);

  for (const [limit, leaseMs, message] of [
    [0, 1, 'limit must be a positive safe integer'],
    [1, 0, 'leaseMs must be a positive safe integer'],
    [Number.NaN, 1, 'limit must be a positive safe integer'],
    [Number.MAX_SAFE_INTEGER + 1, 1, 'limit must be a positive safe integer'],
    [101, 1, 'limit must be at most 100'],
    [1, 300_001, 'leaseMs must be at most 300000'],
  ] as const) {
    await assert.rejects(store.claimReady(limit, leaseMs), (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.equal(error.message, message);
      return true;
    });
  }

  await assert.rejects(store.markDelivered('not-a-uuid', 'lease-token'), /Invalid id/);
  await assert.rejects(store.markDelivered(OUTBOX_A_ID, ' lease-token'), /Invalid leaseToken/);
  await assert.rejects(
    store.rescheduleFailure(OUTBOX_A_ID, 'lease-token', new Date(Number.NaN), 'UPSTREAM_TIMEOUT'),
    /availableAt must be a valid Date/,
  );

  for (const safeErrorCode of ['', 'lowercase', '1UPSTREAM', 'UPSTREAM-TIMEOUT', 'A'.repeat(65)]) {
    await assert.rejects(
      store.rescheduleFailure(OUTBOX_A_ID, 'lease-token', RETRY_AT, safeErrorCode),
      /safeErrorCode must match \^\[A-Z\]\[A-Z0-9_\]\{0,63\}\$/,
    );
  }

  assert.equal(database.transactionCount, 0);
  assert.equal(database.calls.length, 0);
});
