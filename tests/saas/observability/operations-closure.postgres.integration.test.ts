import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { getMediaTaskOperationsPage } from '../../../src/saas/observability/media-task-operations.js';
import {
  type MediaRequeueCommand,
  OperationsActionError,
  PostgresOperationsActionService,
} from '../../../src/saas/observability/operations-actions.js';
import { getOperationsDiagnosticsPage } from '../../../src/saas/observability/operations-diagnostics.js';
import { getSchedulingHealthPage } from '../../../src/saas/observability/scheduling-health.js';
import {
  anyRoleConfigured,
  REQUIRED_FLAG,
  roleUrls,
  safeCodes,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

// Only the isolated runner's guarded direct principals are accepted by roleUrls.
// Fixtures are synthetic accepted-task records; no provider create, status or content call occurs.
const errorCode = (code: OperationsActionError['code']) => (error: unknown) =>
  error instanceof OperationsActionError && error.code === code;
const hash = () => createHash('sha256').update(randomBytes(32)).digest('hex');

test('operations projections and audited status-poll requeue work under the restricted PostgreSQL control plane', {
  timeout: 120_000,
}, async (t) => {
  if (!anyRoleConfigured) {
    assert.notEqual(process.env[REQUIRED_FLAG], '1', 'required operations PostgreSQL target is missing');
    t.skip('requires the isolated managed PostgreSQL runner');
    return;
  }
  const [migratorUrl, controlPlaneUrl, gatewayUrl] = roleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl, max: 4 });
  const controlPlane = createSaasDatabase({ connectionString: controlPlaneUrl, max: 4 });
  const gateway = createSaasDatabase({ connectionString: gatewayUrl, max: 4 });
  try {
    await t.test('the exact runtime roles and registered schema are ready', async () => {
      assert.equal(
        (await controlPlane.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role,
        'model_router_saas_control_plane',
      );
      await migrator.verifySchema();
      await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');
    });
    const fixture = await seedFixture(migrator, gateway, 'platform');
    const sessionId = randomUUID();
    const mfaId = randomUUID();
    const taskId = `ops-video-${randomUUID()}`;
    const account = (
      await migrator.query<{
        account_id: string;
        credential_id: string;
        credential_version: number | string;
        supplier_cost_version: string;
      }>(
        'SELECT account_id, credential_id, credential_version, supplier_cost_version FROM saas_attempts WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, fixture.input.attemptId],
      )
    ).rows[0]!;
    await migrator.transaction(async (tx) => {
      await tx.query("INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, 'operations')", [
        fixture.userId,
      ]);
      await tx.query(
        "INSERT INTO saas_mfa_credentials (id,user_id,kind,credential_id,public_key,verified_at) VALUES ($1,$2,'passkey',$3,$4,clock_timestamp())",
        [mfaId, fixture.userId, `ops-public-${randomUUID()}`, Buffer.from('synthetic public credential fixture')],
      );
      await tx.query(
        "INSERT INTO saas_platform_sessions (id,user_id,credential_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')",
        [sessionId, fixture.userId, mfaId, hash(), hash()],
      );
    });
    await gateway.query(
      `INSERT INTO saas_video_tasks (request_id,tenant_id,proxy_key_id,provider_account_id,credential_id,credential_version,
         gateway_request_id,gateway_attempt_id,model,resolution,duration_seconds,video_count,billing_state,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ops-fixture-model','720p',1,1,'pending',clock_timestamp()+interval '1 day')`,
      [
        taskId,
        fixture.tenantId,
        fixture.keyId,
        account.account_id,
        account.credential_id,
        String(account.credential_version),
        fixture.input.requestId,
        fixture.input.attemptId,
      ],
    );
    await gateway.query(
      "UPDATE saas_video_tasks SET poll_failures=5,next_poll_at=clock_timestamp()-interval '2 minutes' WHERE request_id=$1",
      [taskId],
    );
    const input: MediaRequeueCommand = {
      actorUserId: fixture.userId,
      actorSessionId: sessionId,
      tenantId: fixture.tenantId,
      taskId,
      expectedLeaseEpoch: 0,
      idempotencyKey: `ops-proof:${randomUUID()}`,
      reason: 'Verified account recovery; query the original accepted task.',
    };
    const service = new PostgresOperationsActionService(controlPlane);
    await t.test('window and freshness diagnostics use exact stored costs and successful observations', async () => {
      await migrator.query(
        `UPDATE saas_platform_provider_accounts SET window_cost_limit_minor_units=100,window_cost_sticky_reserve_minor_units=20,
           claude_session_window_start=clock_timestamp()-interval '1 hour',claude_session_window_end=clock_timestamp()+interval '4 hours',
           kimi_usage_updated_at=clock_timestamp()-interval '2 hours',kimi_usage_attempted_at=clock_timestamp(),
           scheduling_threshold_pause_until=clock_timestamp()+interval '5 minutes',
           scheduling_threshold_pause_reason=$2::jsonb WHERE id=$1`,
        [
          account.account_id,
          JSON.stringify({
            source: 'account_scheduling_threshold',
            platform: 'kimi',
            window: 'rolling',
            threshold_percent: 95,
            body: 'must-not-echo-upstream-body',
          }),
        ],
      );
      await migrator.query(
        "INSERT INTO saas_attempt_supplier_costs (id,tenant_id,attempt_id,supplier_cost_version,amount_minor_units,currency) VALUES ($1,$2,$3,$4,110,'USD')",
        [randomUUID(), fixture.tenantId, fixture.input.attemptId, account.supplier_cost_version],
      );
      const row = (await getSchedulingHealthPage(controlPlane, { onlyConstrained: true })).rows.find(
        (row) => row.accountId === account.account_id,
      );
      assert.equal(row?.windowState, 'sticky_only');
      assert.equal(row?.windowFacts?.usageMinorUnits, '110');
      assert.equal(row?.quotaFreshness, 'stale');
      assert.ok(
        Date.parse(row!.quotaObservedAt!) < Date.now() - 3600_000,
        'attempted_at must not freshen the successful quota observation',
      );
      assert.doesNotMatch(JSON.stringify(row), /must-not-echo|body/);
    });
    await t.test('all three projections read actual nonempty tables without broader runtime grants', async () => {
      const scheduling = await getSchedulingHealthPage(controlPlane);
      assert.ok(scheduling.rows.some((row) => row.accountId === account.account_id));
      const tasks = await getMediaTaskOperationsPage(controlPlane);
      const task = tasks.rows.find((row) => row.taskId === taskId);
      assert.equal(task?.statusSource, 'video_billing');
      assert.equal(task?.diagnostic, 'poll_overdue');
      assert.equal(task?.recovery?.canRequeue, true);
      assert.equal(task?.financialStatus, 'pending');
      const diagnostics = await getOperationsDiagnosticsPage(controlPlane);
      assert.ok(diagnostics.sources.some((row) => row.name === 'channel_metrics_1m' && row.freshness === 'unobserved'));
    });
    await t.test('wrong tenant and stale epoch cannot reschedule the task', async () => {
      await assert.rejects(service.requeueVideo({ ...input, tenantId: randomUUID() }), errorCode('TASK_NOT_FOUND'));
      await assert.rejects(service.requeueVideo({ ...input, expectedLeaseEpoch: 1 }), errorCode('TASK_STATE_CONFLICT'));
    });
    await t.test('a failure after the cursor UPDATE rolls back cursor and receipt', async () => {
      const faultDatabase = {
        ...controlPlane,
        transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) =>
          controlPlane.transaction((tx) =>
            work({
              query: <Row>(sql: string, values?: readonly unknown[]) =>
                sql.includes('INSERT INTO saas_audit_events')
                  ? Promise.reject(new Error('test-only audit storage failure'))
                  : tx.query<Row>(sql, values),
            }),
          ),
      } as SaasDatabase;
      await assert.rejects(new PostgresOperationsActionService(faultDatabase).requeueVideo(input));
      assert.equal(
        (
          await controlPlane.query<{ lease_epoch: string }>(
            'SELECT lease_epoch FROM saas_video_tasks WHERE request_id=$1',
            [taskId],
          )
        ).rows[0]?.lease_epoch,
        '0',
      );
      assert.equal(
        (await controlPlane.query('SELECT id FROM saas_ops_media_requeue_requests WHERE task_id=$1', [taskId])).rows
          .length,
        0,
      );
    });
    await t.test(
      'queued action and retry share one audit, preserve failure ladder, and expose the original receipt',
      async () => {
        const queued = await service.requeueVideo(input);
        const replayed = await service.requeueVideo(input);
        assert.deepEqual(replayed, { ...queued, status: 'replayed' });
        assert.equal(queued.leaseEpoch, 1);
        const task = (
          await controlPlane.query<{ billing_state: string; poll_failures: number; provider_account_id: string }>(
            'SELECT billing_state,poll_failures,provider_account_id FROM saas_video_tasks WHERE request_id=$1',
            [taskId],
          )
        ).rows[0]!;
        assert.equal(task.billing_state, 'pending');
        assert.equal(task.poll_failures, 5);
        assert.equal(task.provider_account_id, account.account_id);
        const receipt = (
          await controlPlane.query<{ reason: string; audit_event_id: string }>(
            'SELECT reason,audit_event_id FROM saas_ops_media_requeue_requests WHERE task_id=$1',
            [taskId],
          )
        ).rows;
        assert.equal(receipt.length, 1);
        assert.equal(receipt[0]?.reason, input.reason);
        assert.equal(receipt[0]?.audit_event_id, queued.auditEventId);
        assert.equal(
          (await controlPlane.query('SELECT id FROM saas_audit_events WHERE id=$1', [queued.auditEventId])).rows.length,
          1,
        );
        assert.equal(
          (await getMediaTaskOperationsPage(controlPlane)).rows.find((row) => row.taskId === taskId)?.latestRequeue
            ?.auditEventId,
          queued.auditEventId,
        );
        await assert.rejects(
          service.requeueVideo({ ...input, reason: 'Different command under the same key.' }),
          errorCode('IDEMPOTENCY_CONFLICT'),
        );
      },
    );
    await t.test('active worker lease and terminal billing cannot be overridden', async () => {
      await gateway.query(
        "UPDATE saas_video_tasks SET lease_owner='ops-test-worker',lease_until=clock_timestamp()+interval '1 minute' WHERE request_id=$1",
        [taskId],
      );
      await assert.rejects(
        service.requeueVideo({ ...input, idempotencyKey: randomUUID(), expectedLeaseEpoch: 1 }),
        errorCode('TASK_STATE_CONFLICT'),
      );
      await gateway.query(
        "UPDATE saas_video_tasks SET billing_state='billed',billed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL WHERE request_id=$1",
        [taskId],
      );
      await assert.rejects(
        service.requeueVideo({ ...input, idempotencyKey: randomUUID(), expectedLeaseEpoch: 1 }),
        errorCode('TASK_STATE_CONFLICT'),
      );
      assert.equal(
        (await getMediaTaskOperationsPage(controlPlane)).rows.find((row) => row.taskId === taskId)?.recovery
          ?.canRequeue,
        false,
      );
    });
    await t.test('revoking the operator role also denies idempotent receipt replay', async () => {
      await migrator.query("DELETE FROM saas_platform_role_assignments WHERE user_id=$1 AND role='operations'", [
        fixture.userId,
      ]);
      await assert.rejects(service.requeueVideo(input), errorCode('FORBIDDEN'));
    });
    await t.test(
      'runtime roles cannot rewrite audit receipts or financial state through the operations grants',
      async () => {
        const denied = (error: unknown) => safeCodes(error).sqlState === '42501';
        await assert.rejects(
          controlPlane.query("UPDATE saas_ops_media_requeue_requests SET reason='rewritten' WHERE task_id=$1", [
            taskId,
          ]),
          denied,
        );
        await assert.rejects(
          controlPlane.query("UPDATE saas_video_tasks SET billing_state='pending',billed_at=NULL WHERE request_id=$1", [
            taskId,
          ]),
          denied,
        );
        await assert.rejects(gateway.query('SELECT reason FROM saas_ops_media_requeue_requests'), denied);
      },
    );
  } catch (error) {
    if (error instanceof assert.AssertionError || error instanceof OperationsActionError) throw error;
    const codes = safeCodes(error);
    throw new Error(`Operations PostgreSQL proof failed (SQLSTATE ${codes.sqlState}); details redacted.`);
  } finally {
    await Promise.all([migrator.close(), controlPlane.close(), gateway.close()]);
  }
});
