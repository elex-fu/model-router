import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/060_prepared_evidence_claim_generated_account.js';
import { AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION, REQUEUE_WRITER_SOURCE, REQUEUE_COUNTER_SOURCE } from '../../../src/saas/db/migrations/061_audited_credential_validation_requeue.js';
import {
  AuditedCredentialValidationRequeueService, credentialValidationRequeueRequestDigest, REQUEUE_READINESS_SQL,
  REQUEUE_REQUEST_INSERT_COLUMNS, REQUEUE_REQUEST_READ_COLUMNS, REQUEUE_CYCLE_READ_COLUMNS, REQUEUE_JOB_READ_COLUMNS,
} from '../../../src/saas/supply/audited-credential-validation-requeue-service.js';
import {
  CredentialValidationRequeueError, type AuditedCredentialValidationRequeueCommand, type CredentialValidationRequeueActor,
  type CredentialValidationRequeueErrorCode,
} from '../../../src/saas/supply/credential-validation-requeue-types.js';
import { compileApprovedCredentialValidationTargets, credentialValidationJobSnapshotSha256 } from '../../../src/saas/supply/credential-validation-targets.js';
import { approvedTarget, customJob } from './credential-validation-test-fixture.js';

// Deliberately a UNIT SqlExecutor contract harness, not a fake ledger/PG proof.
// Only the separate four-role root can establish real trigger atomicity/CAS.
const migrationChecksum = (migration: Readonly<{ name: string; sql: string }>) =>
  createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
type LedgerFixtureState = 'exact' | 'missing' | 'wrong_name' | 'wrong_checksum';
function ledgerFact(migration: Readonly<{ version: number; name: string; sql: string }>, state: LedgerFixtureState) {
  return state === 'missing' ? undefined : { version: migration.version,
    name: state === 'wrong_name' ? 'wrong_migration_name' : migration.name,
    checksum: state === 'wrong_checksum' ? '0'.repeat(64) : migrationChecksum(migration) };
}
function harness(options: { expiresAt?: string | null } = {}) {
  const target = approvedTarget({ expiresAt: options.expiresAt ?? null });
  const current = { ...customJob(target), id: randomUUID(), tenantId: randomUUID() };
  const actor: CredentialValidationRequeueActor = { context: { userId: randomUUID(), tenantId: current.tenantId,
    projectId: randomUUID(), tenantRole: 'owner', projectRole: 'owner' }, sessionToken: 'synthetic-requeue-unit-session' };
  const sessionId = randomUUID();
  const command: AuditedCredentialValidationRequeueCommand = { jobId: current.id, expectedCredentialAuthzVersion: 2,
    expectedLeaseGeneration: current.leaseGeneration, expectedSnapshotSha256: credentialValidationJobSnapshotSha256(current),
    idempotencyKey: 'b'.repeat(64), requestId: randomUUID(), reasonCode: 'retry_provider_validation', reason: 'Synthetic retry explanation' };
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let verify = true; let ready = true; let auth = true; let privileged = true; let authority = true; let bound = true;
  let generated60 = ledgerFact(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION, 'exact');
  let audited61 = ledgerFact(AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION, 'exact');
  let latestVersion = 61;
  let authz: unknown = '2'; let status: unknown = 'failed'; let created: unknown = new Date(current.createdAt);
  let checkedTime = '2034-12-31T23:59:00.000Z'; let postInsertTime = checkedTime;
  let injected: unknown; let inserted = 0; let stored: Record<string, unknown> | undefined;
  const tx: SqlExecutor = { async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    calls.push({ sql, values });
    let rows: unknown[] = [];
    if (sql === REQUEUE_READINESS_SQL) rows = [{ ready: ready && values.length === 10 &&
      audited61?.version === 61 && audited61.name === values[0] && audited61.checksum === values[1] &&
      generated60?.version === 60 && generated60.name === values[8] && generated60.checksum === values[9] && latestVersion <= 61 }];
    else if (sql.includes('FROM saas_sessions s JOIN saas_users')) rows = auth ? [{ id: sessionId, privileged }] : [];
    else if (sql.includes('FROM saas_credential_validation_requeue_requests r')) rows = stored ? [{ ...stored, bound }] : [];
    else if (sql.startsWith('SELECT account_id,credential_id,credential_version')) rows = [{ account_id: current.accountId,
      credential_id: current.credentialId, credential_version: String(current.credentialVersion) }];
    else if (sql.includes('SELECT credential.authz_version')) rows = authority ? [{ authz_version: authz,
      protocol: target.protocol, evidence_sha256: target.evidenceSha256, checked_time: checkedTime }] : [];
    else if (sql.includes('FROM saas_tenant_provider_credential_validation_jobs WHERE')) rows = [{ id: current.id, tenant_id: current.tenantId,
      account_id: current.accountId, credential_id: current.credentialId, credential_version: 1, provider_id: current.providerId,
      product_id: current.productId, credential_type: current.credentialType, allowed_models: current.allowedModels,
      target_model: current.target.model, target_endpoint: current.target.endpoint, capability_version: 1, idempotency_key: current.idempotencyKey,
      status, attempt_count: current.attemptCount, available_at: current.availableAt, lease_until: null,
      lease_generation: String(current.leaseGeneration), last_error_code: current.lastErrorCode, completed_at: current.completedAt,
      created_at: created, updated_at: current.updatedAt, current_cycle_id: null, cycle_start_attempt_count: null, cycle_attempt_limit: null }];
    else if (sql.startsWith('INSERT INTO saas_credential_validation_requeue_requests')) {
      if (injected !== undefined) throw injected;
      inserted += 1;
      stored = { id: values[0], tenant_id: values[1], actor_user_id: values[2], job_id: values[4], idempotency_key: values[5],
        request_digest: values[6], request_id: values[7], target_evidence_sha256: target.evidenceSha256, audit_event_id: randomUUID(),
        result_lease_generation: String(current.leaseGeneration + 1), cycle_start_attempt_count: 5, cycle_attempt_limit: 5,
        recorded_at: new Date('2034-12-31T23:59:00.000Z') };
      rows = [{ id: values[0] }];
    } else if (sql === 'SELECT clock_timestamp() AS now') rows = [{ now: postInsertTime }];
    else assert.ok(sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('SELECT set_config'), 'unexpected unit port SQL');
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  const database: SaasDatabase = {
    query: tx.query.bind(tx), async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      const before = stored;
      try { return await work(tx); } catch (error) { stored = before; throw error; }
    }, async verifySchema() { if (!verify) throw new Error('unit schema unavailable'); },
    async verifyUnknownOutcomeSchema() {}, async migrate() { assert.fail('service must never run migration'); }, async ping() {}, async close() {},
  };
  const service = new AuditedCredentialValidationRequeueService(database, compileApprovedCredentialValidationTargets([target]));
  return { actor, sessionId, current, command, calls, service,
    options: {
      verify(value: boolean) { verify = value; }, ready(value: boolean) { ready = value; }, auth(value: boolean) { auth = value; },
      generated60(value: LedgerFixtureState) { generated60 = ledgerFact(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION, value); },
      audited61(value: LedgerFixtureState) { audited61 = ledgerFact(AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION, value); },
      latestVersion(value: number) { latestVersion = value; },
      privileged(value: boolean) { privileged = value; }, authority(value: boolean) { authority = value; }, bound(value: boolean) { bound = value; },
      authz(value: unknown) { authz = value; }, status(value: unknown) { status = value; }, created(value: unknown) { created = value; },
      time(value: string, after = value) { checkedTime = value; postInsertTime = after; }, inject(value: unknown) { injected = value; },
      corruptDigest() { assert.ok(stored); stored.request_digest = '0'.repeat(64); },
    }, writes: () => inserted, stored: () => stored };
}
async function rejects(code: CredentialValidationRequeueErrorCode, work: () => Promise<unknown>) {
  await assert.rejects(work, (error: unknown) => error instanceof CredentialValidationRequeueError && error.code === code && !('cause' in error));
}

test('unit: fresh request uses only minimal request INSERT after exact fences, with trusted server actor', async () => {
  const f = harness(); const result = await f.service.requeue(f.actor, f.command);
  assert.equal(result.replayed, false); assert.equal(result.cycleStartAttemptCount, 5); assert.equal(result.cycleAttemptLimit, 5);
  assert.equal(result.leaseGeneration, f.current.leaseGeneration + 1); assert.equal(f.writes(), 1);
  const readiness = f.calls[0]; assert.ok(readiness && readiness.sql === REQUEUE_READINESS_SQL);
  assert.deepEqual(readiness.values.slice(0, 8), [AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION.name,
    migrationChecksum(AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION), REQUEUE_REQUEST_INSERT_COLUMNS,
    REQUEUE_REQUEST_READ_COLUMNS, REQUEUE_CYCLE_READ_COLUMNS, REQUEUE_JOB_READ_COLUMNS, REQUEUE_WRITER_SOURCE, REQUEUE_COUNTER_SOURCE],
  'the original eight parameter positions retain their exact meanings');
  assert.deepEqual(readiness.values.slice(8), [PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.name,
    migrationChecksum(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION)]);
  assert.match(REQUEUE_READINESS_SQL, /version=61 AND name=\$1 AND checksum=\$2/);
  assert.match(REQUEUE_READINESS_SQL, /version=60 AND name=\$9 AND checksum=\$10/);
  assert.match(REQUEUE_READINESS_SQL, /NOT EXISTS\(SELECT 1 FROM saas_schema_migrations WHERE version>61\)/);
  const writes = f.calls.filter(({ sql }) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql));
  assert.equal(writes.length, 1); assert.match(writes[0]!.sql, /^INSERT INTO saas_credential_validation_requeue_requests/);
  assert.equal(writes[0]!.values[1], f.actor.context.tenantId); assert.equal(writes[0]!.values[2], f.actor.context.userId);
  assert.equal(result.requestDigest, credentialValidationRequeueRequestDigest(f.actor.context.tenantId, f.actor.context.userId, f.command, result.targetEvidenceSha256));
  assert.deepEqual(writes[0]!.sql.match(/^INSERT INTO saas_credential_validation_requeue_requests\s+\(([^)]+)\)/)?.[1]?.split(','),
    ['id', 'tenant_id', 'actor_user_id', 'actor_session_id', 'job_id', 'idempotency_key', 'request_digest', 'request_id',
      'expected_credential_authz_version', 'expected_lease_generation', 'snapshot_sha256', 'reason_code', 'reason']);
  assert.deepEqual(writes[0]!.values, [result.cycleId, f.actor.context.tenantId, f.actor.context.userId, f.sessionId,
    f.command.jobId, f.command.idempotencyKey, result.requestDigest, f.command.requestId,
    f.command.expectedCredentialAuthzVersion, f.command.expectedLeaseGeneration, f.command.expectedSnapshotSha256,
    f.command.reasonCode, f.command.reason]);
  const exclusive = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';
  const shared = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
  const fences = f.calls.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_xact_lock'));
  assert.deepEqual(fences, [
    { sql: 'SELECT pg_advisory_xact_lock_shared(1396788563, 46)', values: [] },
    { sql: exclusive, values: [saasAdvisoryKey.tenant(f.current.tenantId)] },
    { sql: shared, values: [saasAdvisoryKey.user(f.actor.context.userId)] },
    { sql: exclusive, values: [saasAdvisoryKey.tenantProviderAccount(f.current.tenantId, f.current.accountId)] },
    { sql: exclusive, values: [saasAdvisoryKey.tenantProviderCredential(f.current.tenantId, f.current.credentialId)] },
    { sql: exclusive, values: [saasAdvisoryKey.credentialVersion('tenant', f.current.tenantId, f.current.credentialId, 1)] },
  ]);
  const auth = f.calls.find(({ sql }) => sql.includes('FROM saas_sessions s JOIN saas_users'));
  assert.ok(auth);
  assert.deepEqual(auth.values, [f.actor.context.tenantId,
    createHash('sha256').update(f.actor.sessionToken).digest('hex'), f.actor.context.userId]);
  const rowLocks = f.calls.filter(({ sql }) => /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i.test(sql));
  assert.deepEqual(rowLocks, [auth], 'only the authenticated session can have a CP row lock');
  assert.match(auth.sql, /\bFOR SHARE OF s\s*$/);
  const receipts = f.calls.filter(({ sql }) => sql.includes('FROM saas_credential_validation_requeue_requests r'));
  assert.equal(receipts.length, 2, 'one readonly replay lookup, then one immutable bound receipt lookup');
  const order = [f.calls.findIndex(({ sql }) => sql === REQUEUE_READINESS_SQL),
    f.calls.findIndex(({ sql }) => sql.startsWith('SELECT set_config')), ...fences.slice(0, 3).map((call) => f.calls.indexOf(call)),
    f.calls.indexOf(auth), f.calls.indexOf(receipts[0]!),
    f.calls.findIndex(({ sql }) => sql.startsWith('SELECT account_id,credential_id,credential_version')),
    ...fences.slice(3).map((call) => f.calls.indexOf(call)),
    f.calls.findIndex(({ sql }) => sql.includes('FROM saas_tenant_provider_credential_validation_jobs WHERE')),
    f.calls.findIndex(({ sql }) => sql.includes('SELECT credential.authz_version')), f.calls.indexOf(writes[0]!),
    f.calls.indexOf(receipts[1]!)];
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!)),
    'readiness, auth, readonly replay/ref reads and exact worker fences must precede the one append-only INSERT and bound receipt');
  assert.ok(f.calls.every(({ sql }) => !/SELECT\s+\*|to_jsonb\(s\)/i.test(sql)), 'no whole-row SELECT');
  assert.ok(f.calls.every(({ sql }) => !/^\s*(?:CALL|DO|EXECUTE|EXEC)\b|^\s*SELECT\s+(?:model_router_saas\.)?saas_credential_validation_(?:requeue_request_insert|job_cycle_guard)\s*\(/i.test(sql)),
    'no direct execution of the trusted trigger writer/counter');
});

test('unit: stable readonly replay binds persisted digest/cycle/audit after job and live target moved', async () => {
  const f = harness(); const first = await f.service.requeue(f.actor, f.command); const count = f.calls.length;
  f.options.authority(false); f.options.status('leased');
  const replay = await f.service.requeue(f.actor, f.command);
  assert.deepEqual(replay, { ...first, replayed: true }); assert.equal(f.writes(), 1);
  assert.ok(f.calls.slice(count).every(({ sql }) => !/^(?:INSERT|UPDATE|DELETE)\b/.test(sql) && !sql.includes('SELECT account_id,credential_id')));
});

for (const field of ['jobId', 'expectedCredentialAuthzVersion', 'expectedLeaseGeneration', 'expectedSnapshotSha256',
  'idempotencyKey', 'requestId', 'reasonCode', 'reason'] as const) test(`unit: replay conflict ${field} cannot create another cycle`, async () => {
  const f = harness(); await f.service.requeue(f.actor, f.command);
  const changed: AuditedCredentialValidationRequeueCommand = { ...f.command,
    ...(field === 'jobId' ? { jobId: randomUUID() } : field === 'expectedCredentialAuthzVersion' ? { expectedCredentialAuthzVersion: 3 } :
      field === 'expectedLeaseGeneration' ? { expectedLeaseGeneration: 8 } : field === 'expectedSnapshotSha256' ? { expectedSnapshotSha256: 'c'.repeat(64) } :
      field === 'idempotencyKey' ? { idempotencyKey: 'c'.repeat(64) } : field === 'requestId' ? { requestId: randomUUID() } :
      field === 'reasonCode' ? { reasonCode: 'target_approved' as const } : { reason: 'Different non-secret reason' }) };
  await rejects('IDEMPOTENCY_CONFLICT', () => f.service.requeue(f.actor, changed)); assert.equal(f.writes(), 1);
});

test('unit: missing immutable binding or corrupted persisted digest fails closed, not an upsert', async () => {
  for (const missing of [true, false]) {
    const f = harness(); await f.service.requeue(f.actor, f.command);
    if (missing) f.options.bound(false); else f.options.corruptDigest();
    await rejects(missing ? 'STORAGE_UNAVAILABLE' : 'IDEMPOTENCY_CONFLICT', () => f.service.requeue(f.actor, f.command));
    assert.equal(f.writes(), 1);
  }
});

test('unit: missing061 or not reconciled worker read contract refuses before any command write', async () => {
  for (const stage of ['verify', 'ready'] as const) {
    const f = harness(); f.options[stage](false);
    await rejects('SCHEMA_NOT_READY', () => f.service.requeue(f.actor, f.command)); assert.equal(f.writes(), 0);
  }
});

for (const dependency of ['generated60', 'audited61'] as const) {
  for (const state of ['missing', 'wrong_name', 'wrong_checksum'] as const) {
    test(`unit: ${dependency} ${state} refuses readiness before any command write`, async () => {
      const f = harness(); f.options[dependency](state);
      await rejects('SCHEMA_NOT_READY', () => f.service.requeue(f.actor, f.command));
      assert.equal(f.writes(), 0); assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]?.sql, REQUEUE_READINESS_SQL);
      assert.ok(f.calls.every(({ sql }) => !/^(?:INSERT|UPDATE|DELETE)\b/.test(sql)), 'no queue/history/command writes');
    });
  }
}
test('unit: a newer-than061 ledger refuses readiness without any command write', async () => {
  const f = harness(); f.options.latestVersion(62);
  await rejects('SCHEMA_NOT_READY', () => f.service.requeue(f.actor, f.command));
  assert.equal(f.writes(), 0); assert.equal(f.calls.length, 1);
});

test('unit: cache owner is insufficient; fresh session/member/tenant/target/state checks still deny', async () => {
  for (const state of ['auth', 'privileged', 'authority', 'status'] as const) {
    const f = harness(); if (state === 'status') f.options.status('leased'); else f.options[state](false);
    await rejects(state === 'auth' ? 'UNAUTHENTICATED' : state === 'privileged' ? 'FORBIDDEN' : state === 'authority' ? 'TARGET_NOT_AUTHORIZED' : 'STATE_CONFLICT',
      () => f.service.requeue(f.actor, f.command)); assert.equal(f.writes(), 0);
  }
});

test('unit: bigint strings normalize strictly; mismatch/malformed/unsafe versions never write', async () => {
  for (const value of [2, '2']) { const f = harness(); f.options.authz(value); await f.service.requeue(f.actor, f.command); assert.equal(f.writes(), 1); }
  for (const value of ['3', ' 2', '02', '2.0', null, undefined, '9007199254740992', Infinity]) {
    const f = harness(); f.options.authz(value);
    await rejects(value === '3' ? 'STATE_CONFLICT' : 'STORAGE_UNAVAILABLE', () => f.service.requeue(f.actor, f.command)); assert.equal(f.writes(), 0);
  }
});

test('unit: raw PG Date is canonicalized with milliseconds before the ORIGINAL snapshot digest', async () => {
  const f = harness(); await f.service.requeue(f.actor, f.command);
  const other = harness(); other.options.created('2026-09-29T00:00:00.123Z');
  await rejects('STATE_CONFLICT', () => other.service.requeue(other.actor, other.command)); assert.equal(other.writes(), 0);
});

test('unit: hostile actor/target/secret/budget body fields and invalid bounded reasons are rejected', async () => {
  for (const field of ['actorUserId', 'tenantId', 'target', 'ciphertext', 'cycleAttemptLimit']) {
    const f = harness(); const command = { ...f.command, [field]: 'untrusted-body-value' };
    await rejects('INVALID_INPUT', () => f.service.requeue(f.actor, command)); assert.equal(f.calls.length, 0);
  }
  for (const reason of ['', ' ', ' leading', 'trailing ', '\n', 'x'.repeat(513), '\u0000']) {
    const f = harness(); await rejects('INVALID_INPUT', () => f.service.requeue(f.actor, { ...f.command, reason })); assert.equal(f.calls.length, 0);
  }
  const f = harness(); const reason = 'Quotes " and slash / are safe non-secret reasons';
  const command = { ...f.command, reason };
  assert.equal(credentialValidationRequeueRequestDigest(f.current.tenantId, f.actor.context.userId, command, 'a'.repeat(64)),
    createHash('sha256').update(JSON.stringify(['model-router-credential-validation-requeue-v1', f.current.tenantId, f.actor.context.userId,
      command.jobId, 2, command.expectedLeaseGeneration, command.expectedSnapshotSha256, command.idempotencyKey, command.requestId,
      command.reasonCode, reason, 'a'.repeat(64)])).digest('hex'));
});

test('unit: late runtime approval expiry rolls back the unit port; actual atomicity remains a required PG proof', async () => {
  const f = harness({ expiresAt: '2035-01-01T00:00:00.000Z' });
  f.options.time('2034-12-31T23:59:00.000Z', '2035-01-01T00:00:00.000Z');
  await rejects('TARGET_NOT_AUTHORIZED', () => f.service.requeue(f.actor, f.command));
  assert.equal(f.writes(), 1); assert.equal(f.stored(), undefined);
});

test('unit: storage failure never exposes raw errors/token/params or fabricates a successful receipt', async () => {
  const f = harness(); f.options.inject({ code: '42501', message: 'do not surface unit raw storage diagnostics' });
  await rejects('STORAGE_UNAVAILABLE', () => f.service.requeue(f.actor, f.command)); assert.equal(f.stored(), undefined);
});
