import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  type MediaRequeueCommand,
  OperationsActionError,
  PostgresOperationsActionService,
} from '../../../src/saas/observability/operations-actions.js';

const INPUT: MediaRequeueCommand = {
  actorUserId: '10000000-0000-4000-8000-000000000001',
  actorSessionId: '10000000-0000-4000-8000-000000000002',
  tenantId: 'tenant-one',
  taskId: 'accepted-video',
  expectedLeaseEpoch: 7,
  idempotencyKey: 'incident:one',
  reason: 'Upstream account has recovered; poll the original task.',
};
const AT = '2026-10-21T01:00:00.000Z';
function harness(
  options: { authorized?: boolean; eligible?: boolean; epoch?: number; failAudit?: boolean; missing?: boolean } = {},
) {
  const sql: string[] = [];
  let state: { epoch: number; audits: number; receipts: Record<string, unknown>[] } = {
    epoch: options.epoch ?? 7,
    audits: 0,
    receipts: [],
  };
  const database = {
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const draft = structuredClone(state);
      const tx = {
        async query<Row>(statement: string, values: readonly unknown[] = []) {
          sql.push(statement);
          let rows: unknown[] = [];
          if (statement.includes('SELECT 1 AS authorized'))
            rows = options.authorized === false ? [] : [{ authorized: 1 }];
          else if (statement.includes('SELECT request_digest')) rows = draft.receipts;
          else if (statement.includes('SELECT tenant_id, lease_epoch'))
            rows = options.missing
              ? []
              : [{ tenant_id: INPUT.tenantId, lease_epoch: draft.epoch, eligible: options.eligible ?? true }];
          else if (statement.includes('UPDATE saas_video_tasks')) {
            draft.epoch++;
            rows = [{ lease_epoch: draft.epoch, next_poll_at: AT }];
          } else if (statement.includes('INSERT INTO saas_audit_events')) {
            if (options.failAudit) throw new Error('sensitive storage detail');
            draft.audits++;
          } else if (statement.includes('INSERT INTO saas_ops_media_requeue_requests'))
            draft.receipts.push({
              request_digest: values[6],
              audit_event_id: values[10],
              result_lease_epoch: values[8],
              recorded_at: values[11],
            });
          return { rows: rows as Row[], rowCount: rows.length };
        },
      };
      const value = await work(tx);
      state = draft;
      return value;
    },
  } as unknown as SaasDatabase;
  return { service: new PostgresOperationsActionService(database), sql, state: () => state };
}
const code = (wanted: OperationsActionError['code']) => (error: unknown) =>
  error instanceof OperationsActionError && error.code === wanted;

test('video requeue commits cursor, durable reason and audit together, then replays the same receipt', async () => {
  const h = harness();
  const first = await h.service.requeueVideo(INPUT);
  const second = await h.service.requeueVideo(INPUT);
  assert.equal(first.status, 'queued');
  assert.equal(first.leaseEpoch, 8);
  assert.deepEqual(second, { ...first, status: 'replayed' });
  assert.equal(h.state().audits, 1);
  assert.equal(h.state().epoch, 8);
  assert.equal(h.sql[0], 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  assert.match(h.sql[1]!, /pg_advisory_xact_lock_shared/);
  assert.match(h.sql.find((sql) => sql.startsWith('UPDATE'))!, /lease_epoch = lease_epoch \+ 1/);
  assert.doesNotMatch(
    h.sql.find((sql) => sql.startsWith('UPDATE'))!,
    /poll_failures\s*=|billing_state\s*SET|provider_account_id\s*=/,
  );
  assert.match(
    h.sql.find((sql) => sql.includes('INSERT INTO saas_ops_media_requeue_requests'))!,
    /reason, audit_event_id/,
  );
  await assert.rejects(h.service.requeueVideo({ ...INPUT, reason: 'Changed reason' }), code('IDEMPOTENCY_CONFLICT'));
});

test('revoked authorization, active worker/terminal state, stale epoch and wrong tenant are denied before mutation', async () => {
  for (const [options, expected] of [
    [{ authorized: false }, 'FORBIDDEN'],
    [{ eligible: false }, 'TASK_STATE_CONFLICT'],
    [{ epoch: 8 }, 'TASK_STATE_CONFLICT'],
    [{ missing: true }, 'TASK_NOT_FOUND'],
  ] as const) {
    const h = harness(options);
    await assert.rejects(h.service.requeueVideo(INPUT), code(expected));
    assert.equal(h.state().epoch, options.epoch ?? 7);
    assert.equal(h.state().audits, 0);
    assert.equal(
      h.sql.some((sql) => sql.startsWith('UPDATE')),
      false,
    );
  }
});

test('audit failure rolls back scheduling and replay receipt; invalid epochs never open a transaction', async () => {
  const h = harness({ failAudit: true });
  await assert.rejects(h.service.requeueVideo(INPUT));
  assert.equal(h.state().epoch, 7);
  assert.deepEqual(h.state().receipts, []);
  const invalid = harness();
  await assert.rejects(
    invalid.service.requeueVideo({ ...INPUT, expectedLeaseEpoch: Number.MAX_SAFE_INTEGER }),
    code('INVALID_INPUT'),
  );
  assert.deepEqual(invalid.sql, []);
});
