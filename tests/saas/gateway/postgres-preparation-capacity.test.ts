import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/038_gateway_request_capacity.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresPreparationCapacityAdapter } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
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
  assert.equal(
    executor.statements.some(({ sql }) => /saas_wallet|billing_reservation|ledger/i.test(sql)),
    false,
  );
  const locks = executor.statements
    .filter(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    .map(({ values }) => String(values[0]));
  assert.deepEqual(locks.slice(0, 3), [
    `model-router:request-capacity:tenant:${baseInput.tenantId}`,
    `model-router:request-capacity:project:${baseInput.tenantId}:${baseInput.projectId}`,
    `model-router:request-capacity:key:${baseInput.tenantId}:${baseInput.projectId}:${baseInput.proxyKeyId}`,
  ]);
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
      proxy_key_id uuid NOT NULL, execution_state text NOT NULL, financial_status text NOT NULL,
      reconciliation_state text NOT NULL, UNIQUE (tenant_id, id),
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
  const requests = [randomUUID(), randomUUID()] as const;
  const attempts = [randomUUID(), randomUUID()] as const;
  const legacyActiveRequest = randomUUID();
  const legacyActiveAttempt = randomUUID();
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
        await setup.query(
          `INSERT INTO saas_requests
             (tenant_id, id, project_id, proxy_key_id, execution_state, financial_status, reconciliation_state)
           VALUES ($1, $2, $3, $4, 'pending', 'not_applicable', 'none')`,
          [tenantId, requests[index], projectId, keyId],
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
           (tenant_id, id, project_id, proxy_key_id, execution_state, financial_status, reconciliation_state)
         VALUES ($1, $2, $3, $4, 'pending', 'not_applicable', 'none')`,
        [tenantId, legacyActiveRequest, projectId, keyId],
      );
      await setup.query(
        `INSERT INTO saas_attempts
           (tenant_id, id, request_id, dispatch_state, result_state, response_started)
         VALUES ($1, $2, $3, 'not_sent', 'pending', false)`,
        [tenantId, legacyActiveAttempt, legacyActiveRequest],
      );
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
    } finally {
      clientOne.release();
      clientTwo.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
