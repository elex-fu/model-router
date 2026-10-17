import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { SaasImageTaskService } from '../../../../src/saas/gateway/images/image-task-service.js';
import {
  InMemoryImageTaskStore,
  PostgresImageTaskStore,
  type SaasImageTaskRecord,
  SaasImageTaskStoreError,
} from '../../../../src/saas/gateway/images/image-task-store.js';

/**
 * Batch 4 §4.2 (task #16, migration 123): the saas_image_tasks table exists
 * on the real disposable PostgreSQL database; the re-applied role template
 * grants the gateway its column-scoped lifecycle (INSERT the create shape,
 * UPDATE the finish transition, dynamic read) and nothing to the control
 * plane; the live privilege probes pass; and the store round-trips the
 * processing → completed/failed state machine under the terminal-shape
 * CHECK. Same env contract as the 121 gate.
 */
const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required for the 123 gate`);
    let url: URL;
    let user: string;
    let database: string;
    try {
      url = new URL(value);
      user = decodeURIComponent(url.username);
      database = decodeURIComponent(url.pathname.slice(1));
    } catch {
      throw new Error(`${name} must be a valid PostgreSQL URL`);
    }
    assert.ok(user === role, `${name} must use its exact managed role`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local =
      ['127.0.0.1', '[::1]'].includes(host) &&
      Boolean(url.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must use designated CI or an explicit disposable exact-loopback target`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all 123 roles must use the same disposable target');
    return value;
  });
}

interface ColumnRow {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
}

interface IndexRow {
  readonly indexname: string;
}

const TASK_ID = `imgtask_${'1a'.repeat(16)}`;

function processingRecord(): SaasImageTaskRecord {
  return {
    id: TASK_ID,
    tenantId: 'tenant-123',
    proxyKeyId: 'key-123',
    status: 'processing',
    httpStatus: null,
    result: null,
    error: null,
    createdAt: new Date('2026-10-17T00:00:00.000Z').toISOString(),
    completedAt: null,
    expiresAt: new Date('2026-10-18T00:00:00.000Z').toISOString(),
  };
}

test('123 image task registry holds on live PostgreSQL with the gateway-only grants', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [migratorUrl, , gatewayUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 1 });
  try {
    const applied = await migrator.query<{ version: number; name: string }>(
      'SELECT version, name FROM model_router_saas.saas_schema_migrations WHERE version = 123',
    );
    assert.equal(applied.rows.length, 1, 'migration 123 must be applied');
    assert.equal(applied.rows[0]?.name, 'image_tasks');

    // The registry columns and their shapes.
    const columns = await migrator.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_image_tasks'`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
    for (const [name, type, nullable] of [
      ['id', 'character varying', 'NO'],
      ['tenant_id', 'text', 'NO'],
      ['proxy_key_id', 'text', 'NO'],
      ['status', 'text', 'NO'],
      ['http_status', 'integer', 'YES'],
      ['result', 'jsonb', 'YES'],
      ['error', 'jsonb', 'YES'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['completed_at', 'timestamp with time zone', 'YES'],
      ['expires_at', 'timestamp with time zone', 'NO'],
    ] as const) {
      const column = byName.get(name);
      assert.ok(column, `column ${name} must exist`);
      assert.equal(column.data_type, type, `column ${name} type`);
      assert.equal(column.is_nullable, nullable, `column ${name} nullability`);
    }

    // The covering indexes.
    const indexes = await migrator.query<IndexRow>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'model_router_saas' AND tablename = 'saas_image_tasks'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of [
      'saas_image_tasks_pkey',
      'saas_image_tasks_owner_idx',
      'saas_image_tasks_expiry_idx',
      'saas_image_tasks_processing_idx',
    ]) {
      assert.ok(indexNames.has(name), `index ${name} must exist`);
    }

    // The terminal-shape CHECK rejects a processing row carrying a result.
    await assert.rejects(
      gateway.query(
        `INSERT INTO model_router_saas.saas_image_tasks
           (id, tenant_id, proxy_key_id, status, result, created_at, expires_at)
         VALUES ($1, $2, $3, 'processing', '"not allowed"'::jsonb, now(), now() + interval '1 day')`,
        [TASK_ID, 'tenant-123', 'key-123'],
      ),
      /saas_image_tasks_terminal_shape/,
    );

    // The gateway store round-trips the lifecycle under the re-applied grants.
    const store = new PostgresImageTaskStore(gateway);
    await store.create(processingRecord());
    const loaded = await store.get(TASK_ID);
    assert.ok(loaded);
    assert.equal(loaded.tenantId, 'tenant-123');
    assert.equal(loaded.status, 'processing');
    assert.equal(loaded.httpStatus, null);

    const finished = await store.finish(TASK_ID, {
      status: 'completed',
      httpStatus: 200,
      result: '{"data":[{"url":"https://cdn.example.com/images/x.png"}]}',
      error: null,
      completedAt: new Date('2026-10-17T00:01:00.000Z').toISOString(),
      expiresAt: new Date('2026-10-18T00:01:00.000Z').toISOString(),
    });
    assert.equal(finished, true);
    // A second finish is a no-op (the processing transition already ran).
    assert.equal(
      await store.finish(TASK_ID, {
        status: 'failed',
        httpStatus: 500,
        result: null,
        error: '{"type":"api_error"}',
        completedAt: new Date('2026-10-17T00:02:00.000Z').toISOString(),
        expiresAt: new Date('2026-10-18T00:02:00.000Z').toISOString(),
      }),
      false,
    );
    const settled = await store.get(TASK_ID);
    assert.equal(settled?.status, 'completed');
    assert.equal(settled?.httpStatus, 200);
    // jsonb normalizes whitespace on the round trip.
    assert.equal(settled?.result, '{"data":[{"url":"https://cdn.example.com/images/x.png"}]}');

    // The live privilege probes pass for the gateway role (the 123 grants
    // mirror runtime-privileges.ts and the re-applied roles template).
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  } finally {
    await gateway
      .query('DELETE FROM model_router_saas.saas_image_tasks WHERE id = $1', [TASK_ID])
      .catch(() => undefined);
    await gateway.close().catch(() => undefined);
    await migrator.close().catch(() => undefined);
  }
});

test('123 the image task service runs the full lifecycle against the live gateway role', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [, , gatewayUrl] = safeRoleUrls();
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 1 });
  try {
    const service = new SaasImageTaskService({
      store: new PostgresImageTaskStore(gateway),
      offloader: null,
      idFactory: () => `imgtask_${'2b'.repeat(16)}`,
      now: () => Date.parse('2026-10-17T00:00:00.000Z'),
    });
    const submission = await service.createTask({ tenantId: 'tenant-lc', proxyKeyId: 'key-lc' });
    assert.match(submission.taskId, /^imgtask_[0-9a-f]{32}$/);
    await service.failTask({
      taskId: submission.taskId,
      httpStatus: 502,
      error: '{"type":"api_error","message":"boom"}',
    });
    const view = await service.readTask({ taskId: submission.taskId, tenantId: 'tenant-lc', proxyKeyId: 'key-lc' });
    assert.equal(view?.status, 'failed');
    assert.equal(view?.http_status, 502);
    assert.equal(view?.error?.message, 'boom');
    assert.equal(await service.readTask({ taskId: submission.taskId, tenantId: 'other', proxyKeyId: 'key-lc' }), null);
  } finally {
    await gateway
      .query("DELETE FROM model_router_saas.saas_image_tasks WHERE tenant_id = 'tenant-lc'")
      .catch(() => undefined);
    await gateway.close().catch(() => undefined);
  }
});

test('123 the in-memory store enforces the same contract for unit wiring', async () => {
  const store = new InMemoryImageTaskStore();
  await store.create(processingRecord());
  assert.equal((await store.get(TASK_ID))?.status, 'processing');
  assert.equal(await store.get('imgtask_' + '0'.repeat(32)), null);
  await assert.rejects(store.create(processingRecord()), SaasImageTaskStoreError);
  const finished = await store.finish(TASK_ID, {
    status: 'failed',
    httpStatus: 500,
    result: null,
    error: '{"type":"api_error"}',
    completedAt: new Date('2026-10-17T00:01:00.000Z').toISOString(),
    expiresAt: new Date('2026-10-18T00:01:00.000Z').toISOString(),
  });
  assert.equal(finished, true);
});
