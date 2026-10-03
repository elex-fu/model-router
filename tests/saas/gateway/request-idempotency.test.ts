import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type GatewayRequestIdempotencyClaimInput,
  type GatewayRequestIdempotencyStateInput,
  GatewayRequestIdempotencyStore,
} from '../../../src/saas/gateway/request-idempotency.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const PROXY_KEY_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROXY_KEY_ID = '88888888-8888-4888-8888-888888888888';
const REQUEST_A_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_B_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST_C_ID = '66666666-6666-4666-8666-666666666666';
const REQUEST_D_ID = '99999999-9999-4999-8999-999999999999';
const CLIENT_KEY = 'opaque-client-idempotency-key/keep-private';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const HMAC_KEY = new Uint8Array(32).fill(0x5a);

interface StoredRow {
  tenant_id: string;
  project_id: string;
  proxy_key_id: string;
  key_digest: string;
  request_fingerprint: string;
  request_fingerprint_version: string;
  request_id: string;
  state: 'in_progress' | 'completed' | 'unknown';
  execution_state: 'pending' | 'succeeded' | 'failed' | 'unknown';
}

interface QueryCall {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly executor: FakeSqlExecutor;
}

class TwoPartyGate {
  private arrived = 0;
  private release!: () => void;
  private readonly promise = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived === 2) this.release();
    await this.promise;
  }
}

function mapKey(tenantId: unknown, projectId: unknown, proxyKeyId: unknown, keyDigest: unknown): string {
  return [tenantId, projectId, proxyKeyId, keyDigest].join('|');
}

function sqlResult<Row>(rows: Row[]): SqlResult<Row> {
  return { rows, rowCount: rows.length };
}

function isClaimLookup(statement: string): boolean {
  return statement.startsWith('SELECT ') &&
    statement.includes(' FROM saas_gateway_request_idempotency_keys JOIN saas_requests AS request_row ');
}

function assertClaimLookupContract(statement: string, values: readonly unknown[]): void {
  assert.match(statement,
    /^SELECT saas_gateway_request_idempotency_keys\.request_fingerprint AS request_fingerprint, saas_gateway_request_idempotency_keys\.request_fingerprint_version AS request_fingerprint_version, saas_gateway_request_idempotency_keys\.request_id AS request_id, saas_gateway_request_idempotency_keys\.state AS state, /);
  assert.match(statement,
    /request_row\.execution_state AS execution_state, request_row\.project_id AS canonical_project_id, request_row\.proxy_key_id AS canonical_proxy_key_id, request_row\.request_fingerprint AS canonical_request_fingerprint, request_row\.request_fingerprint_version AS canonical_request_fingerprint_version FROM /);
  assert.match(statement,
    /JOIN saas_requests AS request_row ON request_row\.tenant_id = saas_gateway_request_idempotency_keys\.tenant_id AND request_row\.id = saas_gateway_request_idempotency_keys\.request_id WHERE /);
  assert.match(statement,
    /WHERE saas_gateway_request_idempotency_keys\.tenant_id = \$1 AND saas_gateway_request_idempotency_keys\.project_id = \$2 AND saas_gateway_request_idempotency_keys\.proxy_key_id = \$3 AND saas_gateway_request_idempotency_keys\.key_digest = \$4 FOR UPDATE OF saas_gateway_request_idempotency_keys, request_row$/);
  assert.equal(values.length, 4);
}

class FakeSqlExecutor implements SqlExecutor {
  constructor(
    private readonly database: FakeSaasDatabase,
    readonly rows: Map<string, StoredRow>,
    private readonly raceGate?: TwoPartyGate,
  ) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim();
    this.database.calls.push({ sql: statement, values: [...values], executor: this });

    if (statement.startsWith('INSERT INTO saas_gateway_request_idempotency_keys')) {
      assert.match(statement,
        /ON CONFLICT \(tenant_id, project_id, proxy_key_id, key_digest\) DO NOTHING RETURNING request_id$/);
      if (this.raceGate) await this.raceGate.wait();
      const [tenantId, projectId, proxyKeyId, keyDigest, fingerprint, version, requestId] = values;
      const key = mapKey(tenantId, projectId, proxyKeyId, keyDigest);
      if (this.rows.has(key)) return sqlResult([] as Row[]);
      const row: StoredRow = {
        tenant_id: String(tenantId),
        project_id: String(projectId),
        proxy_key_id: String(proxyKeyId),
        key_digest: String(keyDigest),
        request_fingerprint: String(fingerprint),
        request_fingerprint_version: String(version),
        request_id: String(requestId),
        state: 'in_progress',
        execution_state: 'pending',
      };
      this.rows.set(key, row);
      return sqlResult([{ request_id: row.request_id }] as Row[]);
    }

    if (isClaimLookup(statement)) {
      assertClaimLookupContract(statement, values);
      const [tenantId, projectId, proxyKeyId, keyDigest] = values;
      const row = this.rows.get(mapKey(tenantId, projectId, proxyKeyId, keyDigest));
      return sqlResult(
        row
          ? [
              {
                request_fingerprint: row.request_fingerprint,
                request_fingerprint_version: row.request_fingerprint_version,
                request_id: row.request_id,
                state: row.state,
                execution_state: row.execution_state,
                canonical_project_id: row.project_id,
                canonical_proxy_key_id: row.proxy_key_id,
                canonical_request_fingerprint: row.request_fingerprint,
                canonical_request_fingerprint_version: row.request_fingerprint_version,
              } as Row,
            ]
          : [],
      );
    }

    if (statement.startsWith('UPDATE saas_gateway_request_idempotency_keys')) {
      const [tenantId, projectId, proxyKeyId, keyDigest, targetState, requestId] = values;
      const row = this.rows.get(mapKey(tenantId, projectId, proxyKeyId, keyDigest));
      if (!row || row.request_id !== requestId || row.state !== 'in_progress') {
        return sqlResult([] as Row[]);
      }
      row.state = targetState as StoredRow['state'];
      row.execution_state = targetState === 'completed' ? 'succeeded' : 'unknown';
      return sqlResult([{ state: row.state }] as Row[]);
    }

    if (statement.startsWith('SELECT state')) {
      const [tenantId, projectId, proxyKeyId, keyDigest, requestId] = values;
      const row = this.rows.get(mapKey(tenantId, projectId, proxyKeyId, keyDigest));
      return sqlResult(row && row.request_id === requestId ? ([{ state: row.state }] as Row[]) : []);
    }

    if (statement.startsWith('INSERT INTO saas_requests')) return sqlResult([] as Row[]);
    if (statement.startsWith('INSERT INTO saas_billing_reservations')) {
      throw new Error('simulated billing hold write failure');
    }
    throw new Error(`Unexpected test SQL: ${statement}`);
  }
}

class FakeSaasDatabase {
  readonly calls: QueryCall[] = [];
  readonly transactionExecutors: FakeSqlExecutor[] = [];
  rows = new Map<string, StoredRow>();
  transactionCount = 0;
  commitCount = 0;
  rollbackCount = 0;

  executor(raceGate?: TwoPartyGate): FakeSqlExecutor {
    return new FakeSqlExecutor(this, this.rows, raceGate);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const pendingRows = new Map([...this.rows].map(([key, row]) => [key, structuredClone(row)]));
    const tx = new FakeSqlExecutor(this, pendingRows);
    this.transactionExecutors.push(tx);
    try {
      const result = await work(tx);
      this.rows = pendingRows;
      this.commitCount += 1;
      return result;
    } catch (error) {
      this.rollbackCount += 1;
      throw error;
    }
  }
}

function store(): GatewayRequestIdempotencyStore {
  return new GatewayRequestIdempotencyStore({ hmacKey: HMAC_KEY });
}

function claimInput(overrides: Partial<GatewayRequestIdempotencyClaimInput> = {}): GatewayRequestIdempotencyClaimInput {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    proxyKeyId: PROXY_KEY_ID,
    clientKey: CLIENT_KEY,
    requestFingerprint: FINGERPRINT_A,
    requestFingerprintVersion: 'gateway-request-v1',
    requestId: REQUEST_A_ID,
    ...overrides,
  };
}

function stateInput(requestId = REQUEST_A_ID): GatewayRequestIdempotencyStateInput {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    proxyKeyId: PROXY_KEY_ID,
    clientKey: CLIENT_KEY,
    requestId,
  };
}

test('requires a configured cryptographic HMAC key and never sends the client key to SQL', async () => {
  assert.throws(() => new GatewayRequestIdempotencyStore({ hmacKey: new Uint8Array(31) }), /HMAC key/);
  assert.throws(() => new GatewayRequestIdempotencyStore(undefined as unknown as { hmacKey: Uint8Array }), /HMAC key/);

  const database = new FakeSaasDatabase();
  const outcome = await store().claim(database.executor(), claimInput());
  assert.equal(outcome.kind, 'claimed');
  if (outcome.kind !== 'claimed') throw new Error('Expected the first claim to win');
  assert.equal(outcome.canonicalRequestId, REQUEST_A_ID);
  assert.match(outcome.keyDigest, /^[0-9a-f]{64}$/);
  assert.equal(database.calls.length, 1);
  assert.ok(database.calls.every(({ values }) => !values.includes(CLIENT_KEY)));
  assert.equal(database.rows.size, 1);
  assert.ok(!Object.values([...database.rows.values()][0]).includes(CLIENT_KEY));
  assert.match(String(database.calls[0].values[3]), /^[0-9a-f]{64}$/);
});

test('a repeated key and matching server fingerprint returns the original reservation', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();
  const first = await idempotency.claim(database.executor(), claimInput());
  const mappingBefore = structuredClone([...database.rows.entries()]);
  const second = await idempotency.claim(database.executor(), claimInput({ requestId: REQUEST_B_ID }));

  if (first.kind !== 'claimed') throw new Error('Expected the first claim to win');
  assert.equal(first.canonicalRequestId, REQUEST_A_ID);
  assert.match(first.keyDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(second, {
    kind: 'existing',
    state: 'in_progress',
    canonicalRequestId: REQUEST_A_ID,
    canonicalRequestStatus: 'in_progress',
    keyDigest: first.keyDigest,
  });
  assert.equal(database.rows.size, 1);
  assert.equal([...database.rows.values()][0].request_id, REQUEST_A_ID);
  const lookups = database.calls.filter(({ sql }) => isClaimLookup(sql));
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].values, [TENANT_ID, PROJECT_ID, PROXY_KEY_ID, first.keyDigest]);
  assert.deepEqual([...database.rows.entries()], mappingBefore);
  assert.ok(database.calls.every(({ sql }) => !sql.startsWith('UPDATE ')));
  assert.ok(database.calls.every(({ values }) => !values.includes(CLIENT_KEY)));
});

test('a reused key with a different fingerprint or fingerprint version is a safe conflict', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();
  const first = await idempotency.claim(database.executor(), claimInput());
  if (first.kind !== 'claimed') throw new Error('Expected the first claim to win');
  const mappingBefore = structuredClone([...database.rows.entries()]);

  assert.deepEqual(await idempotency.claim(database.executor(), claimInput({
    requestId: REQUEST_B_ID, requestFingerprint: FINGERPRINT_B,
  })), {
    kind: 'fingerprint_conflict',
  });
  assert.deepEqual([...database.rows.entries()], mappingBefore);
  assert.deepEqual(
    await idempotency.claim(database.executor(), claimInput({
      requestId: REQUEST_C_ID, requestFingerprintVersion: 'gateway-request-v2',
    })),
    { kind: 'fingerprint_conflict' },
  );
  assert.equal(database.rows.size, 1);
  assert.deepEqual([...database.rows.entries()], mappingBefore);
  const lookups = database.calls.filter(({ sql }) => isClaimLookup(sql));
  assert.equal(lookups.length, 2);
  for (const lookup of lookups) {
    assert.deepEqual(lookup.values, [TENANT_ID, PROJECT_ID, PROXY_KEY_ID, first.keyDigest]);
  }
  assert.ok(database.calls.every(({ sql }) => !sql.startsWith('UPDATE ')));
});

test('a failed canonical lookup propagates the SQL error without changing the mapping', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();
  await idempotency.claim(database.executor(), claimInput());
  const mappingBefore = structuredClone([...database.rows.entries()]);
  const sqlError = new Error('simulated canonical lookup failure');
  const executor = database.executor();
  const tx: SqlExecutor = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      if (isClaimLookup(sql.replace(/\s+/g, ' ').trim())) throw sqlError;
      return executor.query<Row>(sql, values);
    },
  };

  await assert.rejects(
    idempotency.claim(tx, claimInput({ requestId: REQUEST_B_ID })),
    (error: unknown) => error === sqlError,
  );
  assert.deepEqual([...database.rows.entries()], mappingBefore);
});

test('two concurrent claims serialize through INSERT conflict and FOR UPDATE with only one owner', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();
  const gate = new TwoPartyGate();
  const [left, right] = await Promise.all([
    idempotency.claim(database.executor(gate), claimInput()),
    idempotency.claim(database.executor(gate), claimInput({ requestId: REQUEST_B_ID })),
  ]);

  assert.equal([left, right].filter(({ kind }) => kind === 'claimed').length, 1);
  assert.equal([left, right].filter(({ kind }) => kind === 'existing').length, 1);
  assert.equal(database.rows.size, 1);
  assert.equal(database.calls.filter(({ sql }) => sql.includes('FOR UPDATE')).length, 1);
  assert.ok(database.calls.every(({ values }) => !values.includes(CLIENT_KEY)));
});

test('in-progress, unknown, and completed claims retain the first canonical request id', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();
  const first = await idempotency.claim(database.executor(), claimInput());
  if (first.kind !== 'claimed') throw new Error('Expected the first claim to win');
  const inProgress = await idempotency.claim(database.executor(), claimInput({ requestId: REQUEST_B_ID }));
  assert.deepEqual(inProgress, {
    kind: 'existing',
    state: 'in_progress',
    canonicalRequestId: REQUEST_A_ID,
    canonicalRequestStatus: 'in_progress',
    keyDigest: first.keyDigest,
  });

  assert.equal(await idempotency.markUnknown(database.executor(), stateInput()), true);
  assert.equal(await idempotency.markUnknown(database.executor(), stateInput()), true);
  assert.equal(await idempotency.markCompleted(database.executor(), stateInput()), false);
  assert.deepEqual(await idempotency.claim(database.executor(), claimInput({ requestId: REQUEST_B_ID })), {
    kind: 'existing',
    state: 'unknown',
    canonicalRequestId: REQUEST_A_ID,
    canonicalRequestStatus: 'unknown',
    keyDigest: first.keyDigest,
  });

  const completedDatabase = new FakeSaasDatabase();
  const completedStore = store();
  const completedFirst = await completedStore.claim(completedDatabase.executor(), claimInput());
  if (completedFirst.kind !== 'claimed') throw new Error('Expected the completed test claim to win');
  assert.equal(await completedStore.markCompleted(completedDatabase.executor(), stateInput()), true);
  assert.equal(await completedStore.markCompleted(completedDatabase.executor(), stateInput()), true);
  assert.deepEqual(await completedStore.claim(completedDatabase.executor(), claimInput({ requestId: REQUEST_B_ID })), {
    kind: 'existing',
    state: 'completed',
    canonicalRequestId: REQUEST_A_ID,
    canonicalRequestStatus: 'completed',
    keyDigest: completedFirst.keyDigest,
  });
});

test('tenant, project, and proxy key are all included in the HMAC scope', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();
  await idempotency.claim(database.executor(), claimInput());
  await idempotency.claim(database.executor(), claimInput({ tenantId: OTHER_TENANT_ID, requestId: REQUEST_B_ID }));
  await idempotency.claim(database.executor(), claimInput({ projectId: OTHER_PROJECT_ID, requestId: REQUEST_C_ID }));
  await idempotency.claim(database.executor(), claimInput({ proxyKeyId: OTHER_PROXY_KEY_ID, requestId: REQUEST_D_ID }));

  const digests = database.calls
    .filter(({ sql }) => sql.startsWith('INSERT INTO saas_gateway_request_idempotency_keys'))
    .map(({ values }) => values[3]);
  assert.equal(digests.length, 4);
  assert.equal(new Set(digests).size, 4);
});

test('a later request/hold failure rolls back the mapping on the caller-provided executor', async () => {
  const database = new FakeSaasDatabase();
  const idempotency = store();

  await assert.rejects(
    database.transaction(async (tx) => {
      const reservation = await idempotency.claim(tx, claimInput());
      assert.equal(reservation.kind, 'claimed');
      if (reservation.kind !== 'claimed') throw new Error('Expected first reservation to own the key');
      await tx.query('INSERT INTO saas_requests (id) VALUES ($1)', [reservation.canonicalRequestId]);
      await tx.query('INSERT INTO saas_billing_reservations (request_id) VALUES ($1)', [
        reservation.canonicalRequestId,
      ]);
    }),
    /simulated billing hold write failure/,
  );

  assert.equal(database.transactionCount, 1);
  assert.equal(database.commitCount, 0);
  assert.equal(database.rollbackCount, 1);
  assert.equal(database.rows.size, 0);
  assert.ok(database.calls.length >= 3);
  assert.ok(database.calls.every(({ executor }) => executor === database.transactionExecutors[0]));
});
