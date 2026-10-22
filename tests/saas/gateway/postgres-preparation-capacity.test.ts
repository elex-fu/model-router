import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/038_gateway_request_capacity.js';
import { BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/113_billing_group_rate_counters.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  CONCURRENCY_INFLIGHT_HORIZON_SECONDS,
  PostgresPreparationCapacityAdapter,
} from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import type { PostgresPreparationCapacityReservation } from '../../../src/saas/gateway/postgres-preparation-ports.js';
import type { RequestPreparationDecision } from '../../../src/saas/gateway/request-preparation-service.js';

const capacity = new PostgresPreparationCapacityAdapter();
const baseInput = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  proxyKeyId: 'key-1',
  requestId: 'request-1',
  attemptId: 'attempt-1',
  supplyMode: 'byok' as const,
  payloadBounds: {
    inputTotalUpperBound: '100',
    inputUncachedUpperBound: '100',
    cacheReadUpperBound: '0',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '50',
    reasoningOutputUpperBound: '20',
    feasibleInputBuckets: ['input'],
  },
  idempotencyScopeKey: 'a'.repeat(64),
  requestFingerprint: 'b'.repeat(64),
  requestFingerprintVersion: 'canonical-v1',
};

const allowedAuthority = {
  tenant_status: 'active',
  tenant_requests_per_minute: '10',
  tenant_tokens_per_minute: '10000',
  tenant_max_concurrent_requests: 10,
  project_status: 'active',
  project_policy_version: '3',
  policy_version: '3',
  policy_status: 'active',
  project_requests_per_minute: '8',
  project_tokens_per_minute: '8000',
  project_max_concurrent_requests: 8,
  key_status: 'active',
  key_authz_version: '4',
  supply_mode: 'byok',
  key_expires_at: null,
  key_requests_per_minute: '5',
  key_tokens_per_minute: '5000',
  key_max_concurrent_requests: 2,
};

class CapacityFakeExecutor implements SqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  authority: Record<string, unknown> = { ...allowedAuthority };
  counts: Record<string, unknown> = {
    tenant_rate_count: '0',
    tenant_concurrent_count: '0',
    tenant_token_units: '0',
    project_rate_count: '0',
    project_concurrent_count: '0',
    project_token_units: '0',
    key_rate_count: '0',
    key_concurrent_count: '0',
    key_token_units: '0',
  };
  reservation: Record<string, unknown> | null = null;
  attempt: Record<string, unknown> | null = null;
  insertCount = 0;
  /** R1: the frozen billing-group snapshot row for this request; null = no row. */
  snapshot: Record<string, unknown> | null = null;
  /** R1: requests already counted for the group before this admission. */
  groupRateRequests = 0;
  groupRateUpserts = 0;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push({ sql, values });
    const normalized = sql.trim().toLowerCase();
    let rows: Record<string, unknown>[] = [];

    if (normalized.includes('pg_advisory_xact_lock')) {
      rows = [{ pg_advisory_xact_lock: null }];
    } else if (normalized.startsWith('select clock_timestamp()')) {
      rows = [{ database_now: new Date('2026-09-29T00:00:00.000Z') }];
    } else if (normalized.startsWith('with existing as')) {
      rows = [{ ...this.counts }];
    } else if (normalized.includes('from saas_requests q') && normalized.includes('join saas_attempts a')) {
      rows = this.attempt ? [{ ...this.attempt }] : [];
    } else if (normalized.startsWith('select') && normalized.includes('from saas_gateway_capacity_reservations')) {
      const isMatchingRelease = normalized.includes('quota_reservation_id = $4');
      if (
        this.reservation &&
        (!isMatchingRelease ||
          (this.reservation.tenant_id === values[0] &&
            this.reservation.project_id === values[1] &&
            this.reservation.request_id === values[2] &&
            this.reservation.quota_reservation_id === values[3] &&
            this.reservation.rate_reservation_id === values[4]))
      ) {
        rows = [{ ...this.reservation }];
      }
    } else if (normalized.includes('from saas_request_customer_price_snapshots')) {
      rows = this.snapshot ? [{ ...this.snapshot }] : [];
    } else if (normalized.includes('insert into saas_billing_group_rate_counters')) {
      this.groupRateUpserts += 1;
      this.groupRateRequests += 1;
      rows = [{ requests: this.groupRateRequests }];
    } else if (normalized.includes('from saas_tenants t')) {
      rows = this.authority ? [{ ...this.authority }] : [];
    } else if (normalized.startsWith('insert into saas_gateway_capacity_reservations')) {
      this.insertCount += 1;
      if (!this.reservation) {
        this.reservation = {
          tenant_id: values[0],
          project_id: values[1],
          proxy_key_id: values[2],
          request_id: values[3],
          attempt_id: values[4],
          supply_mode: values[5],
          project_policy_version: values[6],
          key_authz_version: values[7],
          idempotency_scope_key: values[8],
          request_fingerprint: values[9],
          request_fingerprint_version: values[10],
          token_units: values[11],
          quota_reservation_id: values[12],
          rate_reservation_id: values[13],
          state: 'reserved',
        };
        rows = [{ ...this.reservation }];
      }
    } else if (normalized.startsWith('update saas_gateway_capacity_reservations')) {
      if (this.reservation) {
        this.reservation.state = values[5];
        rows = [{ state: values[5] }];
      }
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function allowed<T>(decision: RequestPreparationDecision<T>): T {
  assert.equal(decision.decision, 'allow');
  if (decision.decision !== 'allow') throw new Error('expected capacity allow');
  return decision.value;
}

test('migration 038 remains at its stable registry position and leaves absent limits unset', () => {
  assert.equal(GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.version, 38);
  assert.equal(SAAS_MIGRATIONS[37], GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION);
  assert.equal(
    SAAS_MIGRATIONS.find(({ version }) => version === 38),
    GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION,
  );
  assert.match(GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.sql, /CREATE TABLE saas_gateway_capacity_reservations/);
  assert.match(GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.sql, /FOREIGN KEY \(tenant_id, project_id, proxy_key_id\)/);
  assert.match(GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(
    GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.sql,
    /BEFORE INSERT OR UPDATE OF dispatch_state ON saas_attempts/,
  );
  assert.doesNotMatch(
    GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.sql,
    /ADD COLUMN (?:requests_per_minute|tokens_per_minute|max_concurrent_requests)[^,;]*DEFAULT/i,
  );
});

test('reserve fails closed when tenant, project, or key capacity is not explicitly configured', async () => {
  const executor = new CapacityFakeExecutor();
  executor.authority.key_tokens_per_minute = null;

  const result = await capacity.reserve(executor, baseInput);

  assert.equal(result.decision, 'block');
  assert.equal(executor.insertCount, 0);
  assert.equal(
    executor.statements.some(({ sql }) => sql.includes('clock_timestamp() - INTERVAL')),
    false,
  );
});

test('reserve uses the passed executor, persists exact scope and is idempotent by tenant/request/fingerprint', async () => {
  const executor = new CapacityFakeExecutor();

  const first = allowed(await capacity.reserve(executor, baseInput));
  const second = allowed(await capacity.reserve(executor, baseInput));

  assert.deepEqual(second, first);
  assert.equal(first.usageBudget?.amount, 150);
  assert.equal(first.retryBudget, 0);
  assert.equal(first.remainingAttempts, 1);
  assert.equal(executor.insertCount, 1);
  assert.equal(executor.reservation?.tenant_id, baseInput.tenantId);
  assert.equal(executor.reservation?.project_id, baseInput.projectId);
  assert.equal(executor.reservation?.proxy_key_id, baseInput.proxyKeyId);
  assert.equal(executor.reservation?.request_id, baseInput.requestId);
  const countSql = executor.statements.find(({ sql }) => sql.trimStart().startsWith('WITH existing AS'))?.sql;
  assert.ok(countSql?.includes("q.execution_state IN ('pending', 'unknown')"));
  assert.ok(countSql?.includes("a.result_state IN ('pending', 'unknown')"));
  assert.ok(countSql?.includes('FROM saas_requests q'));
  assert.ok(countSql?.includes('FROM saas_attempts a'));
  assert.ok(countSql?.includes("reserved_at > clock_timestamp() - INTERVAL '60 seconds'"));
  // R9 P10: the in-flight concurrency truth is age-bounded so a crashed
  // gateway or a settle failure can never poison admission forever.
  assert.ok(
    countSql?.includes(`q.updated_at > clock_timestamp() - INTERVAL '${CONCURRENCY_INFLIGHT_HORIZON_SECONDS} seconds'`),
  );
  // The horizon is twice the provider transport's hard timeout ceiling
  // (provider-http-transport.ts MAX_TIMEOUT_MS = 300_000): a merely slow
  // stream always stays inside the window, while a row past the horizon can
  // no longer be legally executing upstream.
  assert.equal(CONCURRENCY_INFLIGHT_HORIZON_SECONDS, 600);
  assert.equal(
    executor.statements.some(({ sql }) => /saas_wallet|billing_reservation|ledger/i.test(sql)),
    false,
  );
  // R9 P4/P16: exactly ONE exclusive fence remains — the tenant scope. The
  // project/key fences were provably redundant (every admission always took
  // the tenant fence first, so the tenant fence alone serializes the same
  // admission pairs; see takeScopeLock). The fence must be acquired AFTER
  // the per-request replay check and the authority read, and BEFORE the
  // shared-counter CTE — only the counter read-check-write needs mutual
  // exclusion.
  const statements = executor.statements.map(({ sql }) => sql);
  const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const authorityIndex = statements.findIndex((sql) => sql.includes('FROM saas_tenants t'));
  const countIndex = statements.findIndex((sql) => sql.trimStart().startsWith('WITH existing AS'));
  assert.ok(lockIndex >= 0, 'expected exactly one capacity advisory lock');
  assert.equal(
    statements.filter((sql) => sql.includes('pg_advisory_xact_lock')).length,
    1,
    'expected the tenant fence to be the only capacity advisory lock',
  );
  assert.equal(executor.statements[lockIndex]?.values[0], `model-router:request-capacity:tenant:${baseInput.tenantId}`);
  assert.ok(authorityIndex >= 0 && authorityIndex < lockIndex, 'authority read must run before the fence');
  assert.ok(countIndex > lockIndex, 'the shared-counter CTE must run inside the fence');
  assert.ok(
    statements.findIndex((sql) => sql.includes('FROM saas_gateway_capacity_reservations')) < lockIndex,
    'the per-request replay check runs before the fence',
  );
});

test('reserve rejects a tenant/request replay bound to another key or request fingerprint', async () => {
  const executor = new CapacityFakeExecutor();
  allowed(await capacity.reserve(executor, baseInput));

  const replay = await capacity.reserve(executor, { ...baseInput, proxyKeyId: 'key-2' });

  assert.deepEqual(replay, {
    decision: 'reject',
    code: 'idempotency_conflict',
    message: 'Request capacity authority could not be established.',
  });
  assert.equal(executor.insertCount, 1);
});

test('capacity reserves input plus output once for independent overlapping TTL bounds', async () => {
  for (const genericWriteBound of ['131072', '0']) {
    const executor = new CapacityFakeExecutor();
    for (const scope of ['tenant', 'project', 'key']) executor.authority[`${scope}_tokens_per_minute`] = '1000000';
    const payloadBounds = {
      inputTotalUpperBound: '131072',
      inputUncachedUpperBound: '131072',
      cacheReadUpperBound: '131072',
      cacheWriteUpperBound: genericWriteBound,
      cacheWrite5mUpperBound: '131072',
      cacheWrite1hUpperBound: '131072',
      outputTotalUpperBound: '32',
      reasoningOutputUpperBound: '32',
      feasibleInputBuckets: ['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'],
    };
    const reservation = allowed(await capacity.reserve(executor, { ...baseInput, payloadBounds }));
    assert.equal(reservation.usageBudget?.amount, 131104);
    assert.equal(String(executor.reservation?.token_units), '131104');
    assert.equal(executor.insertCount, 1);
    assert.equal(payloadBounds.cacheWrite5mUpperBound, '131072');
    assert.equal(payloadBounds.cacheWrite1hUpperBound, '131072');
  }
});

test('capacity rejects individual TTL overbounds and retains exact envelope validation before SQL', async () => {
  for (const damaged of [
    { cacheWrite5mUpperBound: '101' },
    { cacheWrite1hUpperBound: '101' },
    { cacheWrite5mUpperBound: '-1' },
    { cacheWrite1hUpperBound: 1.5 },
    { inputTotalUpperBound: '9223372036854775808' },
    { outputTotalUpperBound: '9223372036854775807' },
    { reasoningOutputUpperBound: '51' },
    { feasibleInputBuckets: [] },
    { feasibleInputBuckets: ['input', 'input'] },
  ]) {
    const executor = new CapacityFakeExecutor();
    const result = await capacity.reserve(executor, {
      ...baseInput,
      payloadBounds: { ...baseInput.payloadBounds, ...damaged },
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'payload_bounds_unavailable');
    assert.equal(executor.statements.length, 0);
  }
});

test('reserve enforces explicit request, token, and concurrency ceilings', async () => {
  const executor = new CapacityFakeExecutor();
  executor.counts.key_rate_count = '5';

  const rateLimited = await capacity.reserve(executor, baseInput);

  assert.equal(rateLimited.decision, 'reject');
  if (rateLimited.decision === 'reject') assert.equal(rateLimited.code, 'rate_limited');
  assert.equal(executor.insertCount, 0);

  executor.counts.key_rate_count = '0';
  executor.counts.project_token_units = '7900';
  const quotaExceeded = await capacity.reserve(executor, baseInput);
  assert.equal(quotaExceeded.decision, 'reject');
  if (quotaExceeded.decision === 'reject') assert.equal(quotaExceeded.code, 'quota_exceeded');
  assert.equal(executor.insertCount, 0);

  executor.counts.project_token_units = '0';
  executor.counts.tenant_concurrent_count = '10';
  const concurrencyExceeded = await capacity.reserve(executor, baseInput);
  assert.equal(concurrencyExceeded.decision, 'reject');
  if (concurrencyExceeded.decision === 'reject') assert.equal(concurrencyExceeded.code, 'rate_limited');
  assert.equal(executor.insertCount, 0);
});

const platformInput = { ...baseInput, supplyMode: 'platform' as const };

function platformExecutor(): CapacityFakeExecutor {
  const executor = new CapacityFakeExecutor();
  executor.authority = { ...allowedAuthority, supply_mode: 'platform' };
  return executor;
}

test('group RPM enforcement reads the frozen snapshot outside the fence and upserts the counter inside it', async () => {
  const executor = platformExecutor();
  executor.snapshot = { billing_group_id: 'vip', group_rpm_limit: 2 };

  const decision = allowed(await capacity.reserve(executor, platformInput));

  assert.equal(decision.retryBudget, 0);
  assert.equal(executor.groupRateUpserts, 1, 'a limited group performs exactly one counter upsert');
  const statements = executor.statements.map(({ sql }) => sql);
  const snapshotIndex = statements.findIndex((sql) => sql.includes('FROM saas_request_customer_price_snapshots'));
  const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const counterIndex = statements.findIndex((sql) => sql.includes('saas_billing_group_rate_counters'));
  const insertIndex = statements.findIndex((sql) => sql.includes('INSERT INTO saas_gateway_capacity_reservations'));
  assert.ok(snapshotIndex >= 0, 'the frozen snapshot terms must be read');
  assert.ok(snapshotIndex < lockIndex, 'the per-request snapshot read runs outside the fence');
  assert.ok(counterIndex > lockIndex, 'the group counter upsert runs inside the fence');
  assert.ok(counterIndex < insertIndex, 'the group check precedes the reservation INSERT');
  // The counter never touches billing state (the wallet-table discipline).
  assert.equal(
    executor.statements.some(({ sql }) => /saas_wallet|billing_reservation|ledger|saas_billing_groups\b/i.test(sql)),
    false,
    'enforcement must never read the mutable group table or billing state',
  );
});

test('group RPM enforcement rejects when the frozen ceiling is already consumed', async () => {
  const executor = platformExecutor();
  executor.snapshot = { billing_group_id: 'vip', group_rpm_limit: 2 };
  executor.groupRateRequests = 2;

  const decision = await capacity.reserve(executor, platformInput);

  assert.equal(decision.decision, 'reject');
  if (decision.decision === 'reject') assert.equal(decision.code, 'rate_limited');
  assert.equal(executor.insertCount, 0, 'a rejection leaves no reservation');
  assert.equal(executor.groupRateUpserts, 1, 'the upsert ran and rolls back with the transaction');
});

test('a frozen zero group RPM ceiling is finite and rejects the first request', async () => {
  const executor = platformExecutor();
  executor.snapshot = { billing_group_id: 'vip', group_rpm_limit: 0 };

  const decision = await capacity.reserve(executor, platformInput);

  assert.equal(decision.decision, 'reject');
  if (decision.decision === 'reject') assert.equal(decision.code, 'rate_limited');
});

test('a group without a frozen RPM ceiling performs no counter write', async () => {
  const executor = platformExecutor();
  executor.snapshot = { billing_group_id: 'default', group_rpm_limit: null };

  allowed(await capacity.reserve(executor, platformInput));

  assert.equal(executor.groupRateUpserts, 0, 'unlimited groups never touch the counter table');
});

test('a platform admission without its price snapshot blocks fail-closed', async () => {
  const executor = platformExecutor();
  executor.snapshot = null;

  const decision = await capacity.reserve(executor, platformInput);

  assert.equal(decision.decision, 'block');
  if (decision.decision === 'block') assert.equal(decision.code, 'capability_unavailable');
  assert.equal(executor.insertCount, 0);
  assert.equal(executor.groupRateUpserts, 0);
});

test('release is idempotent for confirmed pre-dispatch and retains possible dispatches', async () => {
  const executor = new CapacityFakeExecutor();
  const admission = allowed(await capacity.reserve(executor, baseInput));
  executor.attempt = {
    project_id: baseInput.projectId,
    proxy_key_id: baseInput.proxyKeyId,
    supply_mode: 'byok',
    execution_state: 'pending',
    financial_status: 'not_applicable',
    reconciliation_state: 'none',
    dispatch_state: 'not_sent',
    result_state: 'pending',
    response_started: false,
    any_attempt_dispatched: false,
  };
  const releaseInput = {
    tenantId: baseInput.tenantId,
    projectId: baseInput.projectId,
    requestId: baseInput.requestId,
    attemptId: baseInput.attemptId,
    quotaReservation: admission.quotaReservation,
    rateReservation: admission.rateReservation,
  };

  assert.deepEqual(await capacity.release(executor, releaseInput), {
    quotaReservation: 'released',
    rateReservation: 'released',
  });
  assert.deepEqual(await capacity.release(executor, releaseInput), {
    quotaReservation: 'released',
    rateReservation: 'released',
  });

  const unknownExecutor = new CapacityFakeExecutor();
  const unknownAdmission = allowed(await capacity.reserve(unknownExecutor, baseInput));
  unknownExecutor.attempt = {
    ...executor.attempt,
    execution_state: 'unknown',
    reconciliation_state: 'pending',
    dispatch_state: 'unknown',
    result_state: 'unknown',
    any_attempt_dispatched: true,
  };
  const retained = await capacity.release(unknownExecutor, {
    ...releaseInput,
    quotaReservation: unknownAdmission.quotaReservation,
    rateReservation: unknownAdmission.rateReservation,
  });
  assert.deepEqual(retained, {
    quotaReservation: 'retained_for_reconciliation',
    rateReservation: 'retained_for_reconciliation',
  });
  assert.equal(unknownExecutor.reservation?.state, 'retained_for_reconciliation');
});

interface TestDatabaseTarget {
  readonly connectionString?: string;
  readonly skipReason?: string;
}

function isolatedTestDatabaseTarget(value: string | undefined): TestDatabaseTarget {
  if (!value) return { skipReason: 'SAAS_CAPACITY_TEST_DATABASE_URL is not configured' };
  try {
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.port ||
      !Number.isInteger(port) ||
      port === 5432 ||
      port < 1 ||
      port > 65_535 ||
      !/^model_router_test_[a-zA-Z0-9_]+$/.test(databaseName) ||
      parsed.hash ||
      [...parsed.searchParams.keys()].some((key) => ['host', 'port'].includes(key.toLowerCase()))
    ) {
      return {
        skipReason: 'capacity integration requires a dedicated model_router_test_* database and explicit non-5432 port',
      };
    }
    return { connectionString: value };
  } catch {
    return { skipReason: 'SAAS_CAPACITY_TEST_DATABASE_URL is not a valid PostgreSQL URL' };
  }
}

class PgExecutor implements SqlExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
}

async function seedMinimalCapacitySchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE saas_tenants (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE saas_projects (
      tenant_id uuid NOT NULL, id uuid NOT NULL, inference_policy_version bigint NOT NULL,
      inference_policy_status text NOT NULL, PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE saas_project_inference_policy_versions (
      tenant_id uuid NOT NULL, project_id uuid NOT NULL, version bigint NOT NULL, status text NOT NULL,
      PRIMARY KEY (tenant_id, project_id, version),
      FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects (tenant_id, id)
    );
    CREATE TABLE saas_api_keys (
      tenant_id uuid NOT NULL, project_id uuid NOT NULL, id uuid NOT NULL PRIMARY KEY,
      status text NOT NULL, authz_version bigint NOT NULL, supply_mode text NOT NULL, expires_at timestamptz,
      UNIQUE (tenant_id, project_id, id),
      FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects (tenant_id, id)
    );
    CREATE TABLE saas_requests (
      tenant_id uuid NOT NULL, id uuid NOT NULL PRIMARY KEY, project_id uuid NOT NULL,
      proxy_key_id uuid NOT NULL, supply_mode text NOT NULL, execution_state text NOT NULL, financial_status text NOT NULL,
      reconciliation_state text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects (tenant_id, id),
      FOREIGN KEY (tenant_id, project_id, proxy_key_id)
        REFERENCES saas_api_keys (tenant_id, project_id, id)
    );
    CREATE TABLE saas_attempts (
      tenant_id uuid NOT NULL, id uuid NOT NULL PRIMARY KEY, request_id uuid NOT NULL,
      dispatch_state text NOT NULL, result_state text NOT NULL, response_started boolean NOT NULL,
      UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, request_id) REFERENCES saas_requests (tenant_id, id)
    );
  `);
  await client.query(GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION.sql);
}

test('optional PostgreSQL capacity reservation is isolated and concurrent-safe', {
  skip: isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 3 });
  const schema = `capacity_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const keyId = randomUUID();
  const requests = [randomUUID(), randomUUID(), randomUUID()] as const;
  const attempts = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  const legacyActiveRequest = randomUUID();
  const legacyActiveAttempt = randomUUID();
  const staleRequests = [randomUUID(), randomUUID()] as const;
  const staleAttempts = [randomUUID(), randomUUID()] as const;
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schema}"`);
      const scope = await setup.query<{ current_schema: string; schemas: string[] }>(
        'SELECT current_schema() AS current_schema, current_schemas(false)::text[] AS schemas',
      );
      assert.equal(scope.rows[0]?.current_schema, schema);
      assert.deepEqual(scope.rows[0]?.schemas, [schema]);
      await seedMinimalCapacitySchema(setup);
      await setup.query(
        `INSERT INTO saas_tenants
           (id, status, requests_per_minute, tokens_per_minute, max_concurrent_requests)
         VALUES ($1, 'active', 10, 10000, 10)`,
        [tenantId],
      );
      await setup.query(
        `INSERT INTO saas_projects (tenant_id, id, inference_policy_version, inference_policy_status)
         VALUES ($1, $2, 1, 'active')`,
        [tenantId, projectId],
      );
      await setup.query(
        `INSERT INTO saas_project_inference_policy_versions
           (tenant_id, project_id, version, status, requests_per_minute, tokens_per_minute, max_concurrent_requests)
         VALUES ($1, $2, 1, 'active', 10, 10000, 2)`,
        [tenantId, projectId],
      );
      await setup.query(
        `INSERT INTO saas_api_keys
         (tenant_id, project_id, id, status, authz_version, supply_mode,
            requests_per_minute, tokens_per_minute, max_concurrent_requests)
         VALUES ($1, $2, $3, 'active', 1, 'byok', 10, 10000, 2)`,
        [tenantId, projectId, keyId],
      );
      for (let index = 0; index < requests.length; index += 1) {
        // Scenario repair (the in-flight CTE counts seeded pending rows and
        // the attempts trigger forbids seeding dispatched attempts without a
        // reservation): only request 0 starts in-flight. Requests 1 and 2 are
        // the later admission candidates, so their REQUEST rows are seeded
        // terminal — the CTE excludes them via execution_state while their
        // attempts stay trigger-legal 'not_sent'. The original uniform
        // 'pending' seeding predated the attempts-state subquery and made
        // phase 1 over-limit; the gate was always skipped, so the drift went
        // unnoticed.
        const inFlight = index === 0;
        await setup.query(
          `INSERT INTO saas_requests
             (tenant_id, id, project_id, proxy_key_id, supply_mode, execution_state, financial_status, reconciliation_state)
           VALUES ($1, $2, $3, $4, 'byok', $5, 'not_applicable', 'none')`,
          [tenantId, requests[index], projectId, keyId, inFlight ? 'pending' : 'succeeded'],
        );
        await setup.query(
          `INSERT INTO saas_attempts
             (tenant_id, id, request_id, dispatch_state, result_state, response_started)
           VALUES ($1, $2, $3, 'not_sent', 'pending', false)`,
          [tenantId, attempts[index], requests[index]],
        );
      }
      await setup.query(
        `INSERT INTO saas_requests
           (tenant_id, id, project_id, proxy_key_id, supply_mode, execution_state, financial_status, reconciliation_state)
         VALUES ($1, $2, $3, $4, 'byok', 'pending', 'not_applicable', 'none')`,
        [tenantId, legacyActiveRequest, projectId, keyId],
      );
      await setup.query(
        `INSERT INTO saas_attempts
           (tenant_id, id, request_id, dispatch_state, result_state, response_started)
         VALUES ($1, $2, $3, 'not_sent', 'pending', false)`,
        [tenantId, legacyActiveAttempt, legacyActiveRequest],
      );
      // R9 P10: rows stranded past the in-flight horizon (here 700 s old
      // against the 600 s horizon) must stop owning concurrency truth.
      for (const [index, staleRequest] of staleRequests.entries()) {
        await setup.query(
          `INSERT INTO saas_requests
             (tenant_id, id, project_id, proxy_key_id, supply_mode, execution_state, financial_status, reconciliation_state, updated_at)
           VALUES ($1, $2, $3, $4, 'byok', 'pending', 'not_applicable', 'none', clock_timestamp() - interval '700 seconds')`,
          [tenantId, staleRequest, projectId, keyId],
        );
        await setup.query(
          `INSERT INTO saas_attempts
             (tenant_id, id, request_id, dispatch_state, result_state, response_started)
           VALUES ($1, $2, $3, 'not_sent', 'pending', false)`,
          [tenantId, staleAttempts[index], staleRequest],
        );
      }
    } finally {
      setup.release();
    }

    const clientOne = await pool.connect();
    const clientTwo = await pool.connect();
    try {
      await clientOne.query(`SET search_path TO "${schema}"`);
      await clientTwo.query(`SET search_path TO "${schema}"`);
      await clientOne.query('BEGIN');
      await clientTwo.query('BEGIN');
      const firstInput = {
        ...baseInput,
        tenantId,
        projectId,
        proxyKeyId: keyId,
        requestId: requests[0],
        attemptId: attempts[0],
      };
      const secondInput = {
        ...baseInput,
        tenantId,
        projectId,
        proxyKeyId: keyId,
        requestId: requests[1],
        attemptId: attempts[1],
      };
      const firstDecision = await capacity.reserve(new PgExecutor(clientOne), firstInput);
      assert.equal(firstDecision.decision, 'allow');
      const secondDecisionPromise = capacity.reserve(new PgExecutor(clientTwo), secondInput);
      await clientOne.query('COMMIT');
      const secondDecision = await secondDecisionPromise;
      assert.equal(secondDecision.decision, 'reject');
      if (secondDecision.decision === 'reject') assert.equal(secondDecision.code, 'rate_limited');
      await clientTwo.query('ROLLBACK');

      await clientOne.query('BEGIN');
      await clientOne.query(
        `UPDATE saas_requests SET execution_state = 'unknown', reconciliation_state = 'pending'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requests[0]],
      );
      await clientOne.query(
        `UPDATE saas_attempts SET dispatch_state = 'unknown', result_state = 'unknown'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, attempts[0]],
      );
      await clientOne.query('COMMIT');
      await clientTwo.query('BEGIN');
      const unknownStillOccupies = await capacity.reserve(new PgExecutor(clientTwo), secondInput);
      assert.equal(unknownStillOccupies.decision, 'reject');
      await clientTwo.query('ROLLBACK');

      await clientOne.query('BEGIN');
      await clientOne.query(
        `UPDATE saas_requests SET execution_state = 'succeeded', reconciliation_state = 'resolved'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requests[0]],
      );
      await clientOne.query(
        `UPDATE saas_attempts SET dispatch_state = 'sent', result_state = 'succeeded'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, attempts[0]],
      );
      await clientOne.query('COMMIT');
      await clientTwo.query('BEGIN');
      const terminalReleased = await capacity.reserve(new PgExecutor(clientTwo), secondInput);
      assert.equal(terminalReleased.decision, 'allow');
      await clientTwo.query('ROLLBACK');

      // R9 P10: the two stale pending rows must not count against the key
      // concurrency limit of 2 — only the fresh legacy row remains — while a
      // fresh unknown row still occupies (verified above). Without the
      // horizon predicate this reserve would be rejected as rate_limited.
      // Requests 1 and 2 are terminal from the seed (see the scenario repair
      // above); dispatching their attempts here would fire the reservation
      // trigger, and their terminal state is exactly what the scenario needs.
      await clientTwo.query('BEGIN');
      const thirdInput = {
        ...baseInput,
        tenantId,
        projectId,
        proxyKeyId: keyId,
        requestId: requests[2],
        attemptId: attempts[2],
      };
      const staleRowsDoNotBlock = await capacity.reserve(new PgExecutor(clientTwo), thirdInput);
      assert.equal(staleRowsDoNotBlock.decision, 'allow');
      await clientTwo.query('ROLLBACK');
    } finally {
      clientOne.release();
      clientTwo.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

/**
 * R9 P4/P16 fence-semantics proof (live PostgreSQL). These tests exercise the
 * real capacity path — real advisory fence, real count CTE, real reservation
 * INSERT — under genuine cross-connection concurrency. They exist to prove
 * the de-serialized admission design (single tenant-scope exclusive fence,
 * acquired after the per-request replay check and per-scope authority read)
 * preserves the fail-closed limit invariants:
 *   1. N competing admissions against a limit of K admit exactly K — never
 *      more (the double-spend red line).
 *   2. Competing admissions for the SAME request serialize on the fence and
 *      the ON CONFLICT/raced path: exactly one reservation row is created.
 *   3. A rolled-back admission leaves no counter residue.
 *   4. The fence is tenant-scoped: different tenants never serialize on each
 *      other's capacity fence.
 */
async function seedTwoTenantCapacityWorld(
  client: PoolClient,
  options: {
    readonly schema: string;
    readonly tenantIds: readonly string[];
    readonly projectId: string;
    readonly keyIds: readonly string[];
    readonly keyRpm: number;
  },
): Promise<void> {
  await client.query(`SET search_path TO "${options.schema}"`);
  for (const [index, tenantId] of options.tenantIds.entries()) {
    const keyId = options.keyIds[index];
    if (!keyId) throw new Error('seedTwoTenantCapacityWorld requires one key per tenant');
    await client.query(
      `INSERT INTO saas_tenants
         (id, status, requests_per_minute, tokens_per_minute, max_concurrent_requests)
       VALUES ($1, 'active', 1000, 1000000, 1000)`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO saas_projects (tenant_id, id, inference_policy_version, inference_policy_status)
       VALUES ($1, $2, 1, 'active')`,
      [tenantId, options.projectId],
    );
    await client.query(
      `INSERT INTO saas_project_inference_policy_versions
         (tenant_id, project_id, version, status, requests_per_minute, tokens_per_minute, max_concurrent_requests)
       VALUES ($1, $2, 1, 'active', 1000, 1000000, 1000)`,
      [tenantId, options.projectId],
    );
    await client.query(
      `INSERT INTO saas_api_keys
         (tenant_id, project_id, id, status, authz_version, supply_mode,
            requests_per_minute, tokens_per_minute, max_concurrent_requests)
       VALUES ($1, $2, $3, 'active', 1, 'byok', $4, 1000000, 1000)`,
      [tenantId, options.projectId, keyId, options.keyRpm],
    );
  }
}

/**
 * Seeds the metering-side rows a real admission would have created before
 * the capacity reservation runs: saas_gateway_capacity_reservations carries
 * DEFERRABLE foreign keys onto saas_requests and saas_attempts, so every
 * admitted (tenant, request, attempt) needs both rows to exist at COMMIT.
 */
async function seedRequestAndAttempt(
  client: PoolClient,
  options: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly keyId: string;
    readonly requestId: string;
    readonly attemptId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO saas_requests
       (tenant_id, id, project_id, proxy_key_id, supply_mode, execution_state, financial_status, reconciliation_state)
     VALUES ($1, $2, $3, $4, 'byok', 'pending', 'not_applicable', 'none')`,
    [options.tenantId, options.requestId, options.projectId, options.keyId],
  );
  await client.query(
    `INSERT INTO saas_attempts
       (tenant_id, id, request_id, dispatch_state, result_state, response_started)
     VALUES ($1, $2, $3, 'not_sent', 'pending', false)`,
    [options.tenantId, options.attemptId, options.requestId],
  );
}

test('optional PostgreSQL fence proof: 20 competing admissions admit exactly the key RPM limit, never more', {
  skip: isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 24 });
  const schema = `capacity_fence_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const keyId = randomUUID();
  const KEY_RPM_LIMIT = 10;
  const COMPETING = 20;
  const requestIds = Array.from({ length: COMPETING }, () => randomUUID());
  const attemptIds = Array.from({ length: COMPETING }, () => randomUUID());
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schema}"`);
      await seedMinimalCapacitySchema(setup);
      await seedTwoTenantCapacityWorld(setup, {
        schema,
        tenantIds: [tenantId],
        projectId,
        keyIds: [keyId],
        keyRpm: KEY_RPM_LIMIT,
      });
      for (const [index, requestId] of requestIds.entries()) {
        await seedRequestAndAttempt(setup, {
          tenantId,
          projectId,
          keyId,
          requestId,
          attemptId: attemptIds[index] ?? randomUUID(),
        });
      }
    } finally {
      setup.release();
    }

    // COMPETING independent connections each run one full reserve() inside
    // their own transaction and commit as soon as it allows — the same shape
    // as real gateway admissions. All transactions start before any of them
    // commits, so every admission's counter read overlaps the others and the
    // only thing that can prevent over-admission is the exclusive fence.
    const clients = await Promise.all(Array.from({ length: COMPETING }, () => pool.connect()));
    const decisions: RequestPreparationDecision<PostgresPreparationCapacityReservation>[] = [];
    try {
      const tasks = clients.map(async (client, index) => {
        await client.query(`SET search_path TO "${schema}"`);
        await client.query('BEGIN');
        const input = {
          ...baseInput,
          tenantId,
          projectId,
          proxyKeyId: keyId,
          requestId: requestIds[index],
          attemptId: attemptIds[index] ?? randomUUID(),
        };
        const decision = await capacity.reserve(new PgExecutor(client), input);
        if (decision.decision === 'allow') await client.query('COMMIT');
        else await client.query('ROLLBACK');
        return decision;
      });
      decisions.push(...(await Promise.all(tasks)));
    } finally {
      for (const client of clients) client.release();
    }

    const allowed = decisions.filter((decision) => decision.decision === 'allow');
    const rejected = decisions.filter((decision) => decision.decision === 'reject');
    assert.equal(allowed.length, KEY_RPM_LIMIT, 'exactly the limit may be admitted, never more');
    assert.equal(rejected.length, COMPETING - KEY_RPM_LIMIT);
    for (const decision of rejected) {
      if (decision.decision === 'reject') assert.equal(decision.code, 'rate_limited');
    }
    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".saas_gateway_capacity_reservations WHERE tenant_id = $1`,
      [tenantId],
    );
    assert.equal(rows.rows[0]?.count, String(KEY_RPM_LIMIT));
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test('optional PostgreSQL fence proof: competing same-request admissions create exactly one reservation', {
  skip: isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 4 });
  const schema = `capacity_replay_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const keyId = randomUUID();
  const requestId = randomUUID();
  const attemptId = randomUUID();
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schema}"`);
      await seedMinimalCapacitySchema(setup);
      await seedTwoTenantCapacityWorld(setup, {
        schema,
        tenantIds: [tenantId],
        projectId,
        keyIds: [keyId],
        keyRpm: 10,
      });
      await seedRequestAndAttempt(setup, { tenantId, projectId, keyId, requestId, attemptId });
    } finally {
      setup.release();
    }

    const clientOne = await pool.connect();
    const clientTwo = await pool.connect();
    try {
      for (const client of [clientOne, clientTwo]) {
        await client.query(`SET search_path TO "${schema}"`);
        await client.query('BEGIN');
      }
      const input = {
        ...baseInput,
        tenantId,
        projectId,
        proxyKeyId: keyId,
        requestId,
        attemptId,
      };
      // Deterministic fence-serialized replay: the first admission inserts and
      // holds the fence until COMMIT; the second one queues behind it and must
      // observe the committed reservation (via the replay check or the
      // ON CONFLICT raced re-read), never insert a second row.
      const first = await capacity.reserve(new PgExecutor(clientOne), input);
      const secondPromise = capacity.reserve(new PgExecutor(clientTwo), input);
      await clientOne.query('COMMIT');
      const second = await secondPromise;
      await clientTwo.query('COMMIT');

      assert.equal(first.decision, 'allow');
      assert.equal(second.decision, 'allow');
      if (first.decision === 'allow' && second.decision === 'allow') {
        assert.equal(second.value.quotaReservation.reference, first.value.quotaReservation.reference);
        assert.equal(second.value.rateReservation.reference, first.value.rateReservation.reference);
      }
      const rows = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".saas_gateway_capacity_reservations
          WHERE tenant_id = $1 AND request_id = $2`,
        [tenantId, requestId],
      );
      assert.equal(rows.rows[0]?.count, '1');
    } finally {
      clientOne.release();
      clientTwo.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test('optional PostgreSQL fence proof: a rolled-back admission leaves no rate-window residue', {
  skip: isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 4 });
  const schema = `capacity_rollback_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const keyId = randomUUID();
  const abortedRequestId = randomUUID();
  const abortedAttemptId = randomUUID();
  const afterRequestId = randomUUID();
  const afterAttemptId = randomUUID();
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schema}"`);
      await seedMinimalCapacitySchema(setup);
      await seedTwoTenantCapacityWorld(setup, {
        schema,
        tenantIds: [tenantId],
        projectId,
        keyIds: [keyId],
        keyRpm: 1,
      });
      await seedRequestAndAttempt(setup, {
        tenantId,
        projectId,
        keyId,
        requestId: abortedRequestId,
        attemptId: abortedAttemptId,
      });
      await seedRequestAndAttempt(setup, {
        tenantId,
        projectId,
        keyId,
        requestId: afterRequestId,
        attemptId: afterAttemptId,
      });
    } finally {
      setup.release();
    }

    const clientOne = await pool.connect();
    const clientTwo = await pool.connect();
    try {
      for (const client of [clientOne, clientTwo]) {
        await client.query(`SET search_path TO "${schema}"`);
      }
      // Admission 1 reserves against an RPM limit of 1, then the transaction
      // fails and rolls back. The reservation insert must disappear with it.
      await clientOne.query('BEGIN');
      const aborted = await capacity.reserve(new PgExecutor(clientOne), {
        ...baseInput,
        tenantId,
        projectId,
        proxyKeyId: keyId,
        requestId: abortedRequestId,
        attemptId: abortedAttemptId,
      });
      assert.equal(aborted.decision, 'allow');
      await clientOne.query('ROLLBACK');

      // Admission 2, against the same single-request window, must still be
      // admissible: the rolled-back reservation does not consume the limit.
      await clientTwo.query('BEGIN');
      const after = await capacity.reserve(new PgExecutor(clientTwo), {
        ...baseInput,
        tenantId,
        projectId,
        proxyKeyId: keyId,
        requestId: afterRequestId,
        attemptId: afterAttemptId,
      });
      assert.equal(after.decision, 'allow');
      await clientTwo.query('COMMIT');

      const rows = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".saas_gateway_capacity_reservations WHERE tenant_id = $1`,
        [tenantId],
      );
      assert.equal(rows.rows[0]?.count, '1');
    } finally {
      clientOne.release();
      clientTwo.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test('optional PostgreSQL fence proof: different tenants do not serialize on each other', {
  skip: isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 4 });
  const schema = `capacity_tenants_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantIds = [randomUUID(), randomUUID()];
  const projectId = randomUUID();
  const keyIds = [randomUUID(), randomUUID()];
  const seededRequestIds = tenantIds.map(() => randomUUID());
  const seededAttemptIds = tenantIds.map(() => randomUUID());
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schema}"`);
      await seedMinimalCapacitySchema(setup);
      await seedTwoTenantCapacityWorld(setup, { schema, tenantIds, projectId, keyIds, keyRpm: 1 });
      for (const [index, tenantId] of tenantIds.entries()) {
        await seedRequestAndAttempt(setup, {
          tenantId,
          projectId,
          keyId: keyIds[index] ?? randomUUID(),
          requestId: seededRequestIds[index] ?? randomUUID(),
          attemptId: seededAttemptIds[index] ?? randomUUID(),
        });
      }
    } finally {
      setup.release();
    }

    // Both tenants have an RPM limit of 1. Each tenant's first admission is
    // admissible independently; the tenant-scoped fences must not interact.
    const clients = await Promise.all(tenantIds.map(() => pool.connect()));
    try {
      const tasks = clients.map(async (client, index) => {
        await client.query(`SET search_path TO "${schema}"`);
        await client.query('BEGIN');
        const decision = await capacity.reserve(new PgExecutor(client), {
          ...baseInput,
          tenantId: tenantIds[index],
          projectId,
          proxyKeyId: keyIds[index],
          requestId: seededRequestIds[index],
          attemptId: seededAttemptIds[index],
        });
        if (decision.decision === 'allow') await client.query('COMMIT');
        else await client.query('ROLLBACK');
        return decision;
      });
      const decisions = await Promise.all(tasks);
      for (const decision of decisions) assert.equal(decision.decision, 'allow');
    } finally {
      for (const client of clients) client.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

/*
 * R1 (roadmap 1.3, phase 2): the billing-group RPM fence proof. The minimal
 * capacity world gains the frozen snapshot terms (billing_group_id +
 * group_rpm_limit, exactly the columns the adapter reads) and the migration
 * 113 counter table; 20 competing platform admissions on one group with a
 * frozen ceiling of 10 must admit exactly 10 — the counter upsert is
 * serialized by the admission fence plus the counter row lock, and every
 * rejection rolls its increment back with the transaction.
 */
test('optional PostgreSQL fence proof: group RPM admits exactly the frozen ceiling, never more', {
  skip: isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTestDatabaseTarget(process.env.SAAS_CAPACITY_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 24 });
  const schema = `capacity_group_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const keyId = randomUUID();
  const GROUP_RPM_LIMIT = 10;
  const COMPETING = 20;
  const requestIds = Array.from({ length: COMPETING }, () => randomUUID());
  const attemptIds = Array.from({ length: COMPETING }, () => randomUUID());
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schema}"`);
      await seedMinimalCapacitySchema(setup);
      await setup.query(BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION.sql);
      await setup.query(`
        CREATE TABLE saas_request_customer_price_snapshots (
          tenant_id uuid NOT NULL,
          request_id uuid NOT NULL,
          billing_group_id text,
          group_rpm_limit integer,
          UNIQUE (tenant_id, request_id)
        );
      `);
      await seedTwoTenantCapacityWorld(setup, {
        schema,
        tenantIds: [tenantId],
        projectId,
        keyIds: [keyId],
        keyRpm: 1000,
      });
      // The key must be a platform key for a platform admission.
      await setup.query(`UPDATE saas_api_keys SET supply_mode = 'platform' WHERE id = $1`, [keyId]);
      for (const [index, requestId] of requestIds.entries()) {
        await seedRequestAndAttempt(setup, {
          tenantId,
          projectId,
          keyId,
          requestId,
          attemptId: attemptIds[index] ?? randomUUID(),
        });
        await setup.query(
          `INSERT INTO saas_request_customer_price_snapshots (tenant_id, request_id, billing_group_id, group_rpm_limit)
           VALUES ($1, $2, 'vip', $3)`,
          [tenantId, requestId, GROUP_RPM_LIMIT],
        );
      }
      // The requests must be platform-side too (the capacity reservation FK
      // includes supply_mode); seedRequestAndAttempt inserts them as byok.
      await setup.query(`UPDATE saas_requests SET supply_mode = 'platform' WHERE tenant_id = $1`, [tenantId]);
    } finally {
      setup.release();
    }

    const clients = await Promise.all(Array.from({ length: COMPETING }, () => pool.connect()));
    const decisions: RequestPreparationDecision<PostgresPreparationCapacityReservation>[] = [];
    try {
      const tasks = clients.map(async (client, index) => {
        await client.query(`SET search_path TO "${schema}"`);
        await client.query('BEGIN');
        const decision = await capacity.reserve(new PgExecutor(client), {
          ...baseInput,
          supplyMode: 'platform',
          tenantId,
          projectId,
          proxyKeyId: keyId,
          requestId: requestIds[index],
          attemptId: attemptIds[index] ?? randomUUID(),
        });
        if (decision.decision === 'allow') await client.query('COMMIT');
        else await client.query('ROLLBACK');
        return decision;
      });
      decisions.push(...(await Promise.all(tasks)));
    } finally {
      for (const client of clients) client.release();
    }

    const admitted = decisions.filter((decision) => decision.decision === 'allow');
    const rejected = decisions.filter((decision) => decision.decision === 'reject');
    assert.equal(admitted.length, GROUP_RPM_LIMIT, 'exactly the frozen group ceiling may be admitted');
    assert.equal(rejected.length, COMPETING - GROUP_RPM_LIMIT);
    for (const decision of rejected) {
      if (decision.decision === 'reject') assert.equal(decision.code, 'rate_limited');
    }
    // The committed counter holds exactly the admitted requests: every
    // rejection rolled its increment back with the admission transaction.
    const counter = await pool.query<{ requests: number }>(
      `SELECT requests FROM "${schema}".saas_billing_group_rate_counters WHERE group_id = 'vip'`,
    );
    assert.equal(counter.rows.length, 1);
    assert.equal(counter.rows[0]?.requests, GROUP_RPM_LIMIT);
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
