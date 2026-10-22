import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  PlatformCredentialValidationRequeueService,
  type PlatformValidationRequeueCommand,
  PlatformValidationRequeueError,
} from '../../../src/saas/platform/credential-validation-requeue-service.js';

const ACTOR: PlatformAdminActor = {
  userId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  roles: ['operations'],
};
const JOB = '10000000-0000-4000-8000-000000000003';
const AUDIT = '10000000-0000-4000-8000-000000000004';
const command = (): PlatformValidationRequeueCommand => ({
  accountId: 'account-a',
  credentialId: 'credential-a',
  jobId: JOB,
  expectedCredentialVersion: 2,
  expectedCredentialAuthzVersion: 7,
  expectedLeaseGeneration: 3,
  idempotencyKey: 'platform-retry-operation',
  requestId: 'request-a',
  reason: '修复消息签名响应上限后重新验证',
});

// A scripted service seam only. Actual trigger/ACL/atomicity is covered by
// credential-validation-requeue.postgres.integration.test.ts.
class Database implements SaasDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  authorized = true;
  ready = true;
  current: Record<string, unknown> = {
    job_id: JOB,
    current_version: 2,
    authz_version: '7',
    lease_generation: '3',
    eligible: true,
  };
  prior: Record<string, unknown> | null = null;
  inserts = 0;
  failInsert = false;
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ sql, values });
    let rows: unknown[] = [];
    if (sql.includes('AS authorized')) rows = [{ authorized: this.authorized }];
    else if (sql.includes('AS ready')) rows = [{ ready: this.ready }];
    else if (sql.startsWith('SELECT job.id AS job_id')) rows = [this.current];
    else if (sql.includes('FROM saas_platform_credential_validation_requeue_requests'))
      rows = this.prior ? [this.prior] : [];
    else if (sql.startsWith('INSERT INTO saas_platform_credential_validation_requeue_requests')) {
      if (this.failInsert) throw new Error('sensitive-provider-material');
      this.inserts += 1;
      this.prior = {
        actor_user_id: values[0],
        account_id: values[2],
        credential_id: values[3],
        job_id: values[4],
        expected_credential_version: values[5],
        expected_credential_authz_version: values[6],
        expected_lease_generation: values[7],
        idempotency_key: values[8],
        request_id: values[9],
        reason: values[10],
        audit_event_id: AUDIT,
        result_lease_generation: 4,
        recorded_at: '2026-10-21T00:00:00Z',
      };
      rows = [this.prior];
    } else if (!sql.includes('pg_advisory_xact_lock') && !sql.includes('set_config'))
      throw new Error('unexpected service query');
    return { rows: rows as Row[], rowCount: rows.length };
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }
  async verifySchema() {}
  async migrate() {}
  async ping() {}
  async close() {}
}

async function rejected(code: PlatformValidationRequeueError['code'], run: () => Promise<unknown>) {
  await assert.rejects(
    run(),
    (error: unknown) => error instanceof PlatformValidationRequeueError && error.code === code,
  );
}

test('platform retry service publishes only metadata and submits one atomic trigger command', async () => {
  const database = new Database();
  const service = new PlatformCredentialValidationRequeueService(database);
  assert.deepEqual(await service.getStatus(ACTOR, 'account-a', 'credential-a'), {
    state: 'ready',
    jobId: JOB,
    credentialVersion: 2,
    credentialAuthzVersion: 7,
    leaseGeneration: 3,
  });
  const result = await service.requeue(ACTOR, command());
  assert.deepEqual(result, {
    outcome: 'queued',
    jobId: JOB,
    credentialVersion: 2,
    leaseGeneration: 4,
    auditEventId: AUDIT,
    recordedAt: '2026-10-21T00:00:00.000Z',
    replayed: false,
  });
  assert.equal(database.inserts, 1);
  assert.equal(
    database.calls.some(({ sql }) => /^UPDATE|^INSERT INTO saas_audit_events/.test(sql)),
    false,
    'the service cannot update jobs or independently append an audit',
  );
  assert.equal(JSON.stringify(result).includes(command().reason), false);
});

test('replay survives a completed job and a new HTTP request ID; changed semantic input conflicts', async () => {
  const database = new Database();
  const service = new PlatformCredentialValidationRequeueService(database);
  await service.requeue(ACTOR, command());
  database.current.eligible = false;
  database.current.lease_generation = '99';
  assert.equal((await service.requeue(ACTOR, { ...command(), requestId: 'request-b' })).replayed, true);
  await rejected('IDEMPOTENCY_CONFLICT', () => service.requeue(ACTOR, { ...command(), reason: 'different reason' }));
  await rejected('IDEMPOTENCY_CONFLICT', () => service.requeue(ACTOR, { ...command(), accountId: 'other-account' }));
  assert.equal(database.inserts, 1);
});

test('fresh database authority, schema readiness and every expected revision gate a new retry', async () => {
  for (const [field, value] of [
    ['current_version', 3],
    ['authz_version', 8],
    ['lease_generation', 4],
    ['eligible', false],
  ] as const) {
    const database = new Database();
    database.current[field] = value;
    await rejected('STATE_CONFLICT', () =>
      new PlatformCredentialValidationRequeueService(database).requeue(ACTOR, command()),
    );
    assert.equal(database.inserts, 0);
  }
  const denied = new Database();
  denied.authorized = false;
  await rejected('FORBIDDEN', () => new PlatformCredentialValidationRequeueService(denied).requeue(ACTOR, command()));
  assert.equal(denied.inserts, 0, 'cached actor roles cannot restore revoked session/role authority');
  const oldSchema = new Database();
  oldSchema.ready = false;
  await rejected('SCHEMA_NOT_READY', () =>
    new PlatformCredentialValidationRequeueService(oldSchema).requeue(ACTOR, command()),
  );
  assert.equal(oldSchema.inserts, 0);
});

test('invalid reason, owner injection and readonly roles fail before a write; driver errors stay redacted', async () => {
  const database = new Database();
  const service = new PlatformCredentialValidationRequeueService(database);
  for (const reason of ['', ' padded ', 'line\nbreak', 'x'.repeat(513)])
    await rejected('INVALID_INPUT', () => service.requeue(ACTOR, { ...command(), reason }));
  await rejected('INVALID_INPUT', () =>
    service.requeue(ACTOR, { ...command(), tenantId: 'foreign' } as PlatformValidationRequeueCommand),
  );
  await rejected('FORBIDDEN', () => service.requeue({ ...ACTOR, roles: ['support-readonly'] }, command()));
  assert.equal(database.calls.length, 0);
  database.failInsert = true;
  await assert.rejects(
    service.requeue(ACTOR, command()),
    (error: unknown) =>
      error instanceof PlatformValidationRequeueError &&
      error.code === 'STORAGE_UNAVAILABLE' &&
      !String(error.stack).includes('sensitive-provider-material'),
  );
});
