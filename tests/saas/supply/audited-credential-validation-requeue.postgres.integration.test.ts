import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../../../src/saas/db/credential-validation-worker-privileges.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../../../src/saas/db/credential-validation-worker-schema-readiness.js';
import {
  AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION, REQUEUE_COUNTER_SOURCE, REQUEUE_WRITER_SOURCE,
} from '../../../src/saas/db/migrations/061_audited_credential_validation_requeue.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/060_prepared_evidence_claim_generated_account.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/runtime-privileges.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import { AuditedCredentialValidationRequeueService, credentialValidationRequeueRequestDigest } from '../../../src/saas/supply/audited-credential-validation-requeue-service.js';
import { CredentialValidationRequeueError, type CredentialValidationRequeueErrorCode } from '../../../src/saas/supply/credential-validation-requeue-types.js';
import { credentialValidationJobSnapshotSha256 } from '../../../src/saas/supply/credential-validation-targets.js';
import { CredentialValidationWorkerError } from '../../../src/saas/supply/credential-validation-worker.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import {
  InvalidationFixtureKms, actualRequeueClaim, actualRequeueTerminal, actualSqlState, deferred,
  invalidationCatalog, invalidationDatabase, observeRequeueFenceWait, permissionDenied, redactedRequeueFailure,
  REQUEUE_PG_CONFIG, REQUEUE_PG_FAILED, REQUEUE_PG_REQUIRED, REQUEUE_PG_VERIFIED,
  requeueCommand, requeuePgIdentity, requeuePgSnapshot, requeuePgUrls, sameFacts, seedRequeuePgFixture,
  tappedRequeueDatabase, type RequeuePgFixture,
} from './audited-credential-validation-requeue-pg-fixture.js';

// STAGED current061 gate, not registered/active until integration GO. Requires
// normal externally applied migrations/role templates AND cycle-aware actual
// worker code. No migrate/bootstrap/grant/reset, handwritten worker CAS,
// privileged requeue, fabricated secret/target or old-global-limit override.
const configured = REQUEUE_PG_CONFIG.map(([name]) => process.env[name]?.trim());
async function child(t: TestContext, name: string, work: () => Promise<void>) {
  await t.test(name, { timeout: 60000 }, async () => {
    try { await work(); } catch (error) { throw redactedRequeueFailure(name, error); }
  });
}
async function refused(code: CredentialValidationRequeueErrorCode, work: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try { await work(); } catch (error) { failed = true; assert.ok(error instanceof CredentialValidationRequeueError && error.code === code,
    'only the exact safe service refusal is accepted'); }
  assert.ok(failed, 'manual requeue must refuse without mutation');
}
async function leaseLost(work: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try { await work(); } catch (error) { failed = true; assert.ok(error instanceof CredentialValidationWorkerError && error.code === 'LEASE_LOST'); }
  assert.ok(failed, 'actual old worker lease must be unusable');
}
async function backend(database: SaasDatabase): Promise<number> {
  const pid = (await database.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid), 'single-connection real workload backend required'); return pid;
}
type Snapshot = Awaited<ReturnType<typeof requeuePgSnapshot>>;
function targetJob(snapshot: Snapshot, fixture: RequeuePgFixture) {
  const matches = snapshot.jobs.filter((row) => row.id === fixture.supply.jobId);
  assert.ok(matches.length === 1 && matches[0]); return matches[0];
}
async function disableAccount(database: SaasDatabase, fixture: RequeuePgFixture) {
  await new PostgresProviderSupplyRepository(database).transaction(async (repository) => {
    const ref = { ownerKind: 'tenant' as const, tenantId: fixture.supply.tenants[0], accountId: fixture.supply.accounts[0] };
    const current = await repository.getAccount(ref); assert.ok(current, 'real CP current account required');
    const now = new Date().toISOString();
    const result = await repository.updateAccountLifecycle({ account: ref, expectedAuthzVersion: current.authzVersion,
      status: 'disabled', disabledAt: now, revokedAt: null, updatedAt: now });
    assert.ok(result?.status === 'disabled' && result.authzVersion === current.authzVersion + 1, 'actual CP disable CAS must succeed');
  });
}

test('required four-role schema061 audited requeue persists cycle/history and bounds the ACTUAL worker', {
  timeout: 360000,
  skip: process.env[REQUEUE_PG_REQUIRED] !== '1' && !configured.some(Boolean)
    ? `set ${REQUEUE_PG_REQUIRED}=1 and every requeue E2E role URL` : false,
}, async (t) => {
  const databases: SaasDatabase[] = []; const kms = new InvalidationFixtureKms();
  t.after(async () => { kms.close(); await Promise.allSettled(databases.map((database) => database.close())); });
  try {
    const urls = requeuePgUrls(configured);
    for (const url of urls) databases.push(invalidationDatabase(url));
    const [migrator, control, gateway, worker] = databases;
    assert.ok(migrator && control && gateway && worker);
    const otherControl = invalidationDatabase(urls[1]); databases.push(otherControl);
    const databaseName = decodeURIComponent(new URL(urls[0]).pathname.slice(1));
    for (let index = 0; index < REQUEUE_PG_CONFIG.length; index += 1) await requeuePgIdentity(databases[index]!, REQUEUE_PG_CONFIG[index]![1], databaseName);
    await requeuePgIdentity(otherControl, 'model_router_saas_control_plane', databaseName);
    await migrator.verifySchema(); // READ ONLY, normal central registry through061 required.
    const migration = AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION;
    const generated = PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION;
    const ledger = (await migrator.query<{ exact: boolean }>(`SELECT count(*)=61 AND min(version)=1 AND max(version)=61
      AND bool_and(version BETWEEN 1 AND 61) AND EXISTS(SELECT 1 FROM saas_schema_migrations
        WHERE version=61 AND name=$1 AND checksum=$2)
      AND EXISTS(SELECT 1 FROM saas_schema_migrations WHERE version=60 AND name=$3 AND checksum=$4)
      AS exact FROM saas_schema_migrations`,
    [migration.name, createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex'),
      generated.name, createHash('sha256').update(generated.name).update('\0').update(generated.sql).digest('hex')])).rows[0];
    assert.ok(ledger?.exact === true, 'normal exact through061 deployment must precede this standalone business gate');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifyCredentialValidationWorkerSchemaReadiness(worker);
    await verifyCredentialValidationWorkerRuntimePrivileges(worker);
    await permissionDenied(() => worker.query('SELECT version FROM saas_schema_migrations LIMIT 1'));
    assert.ok((await migrator.query<{ empty: boolean }>(`SELECT NOT EXISTS(SELECT 1
      FROM saas_tenant_provider_credential_validation_jobs WHERE status IN('queued','leased')) AS empty`)).rows[0]?.empty === true,
    'dedicated empty queue required; never share frozen59 HTTP/worker fixtures');
    const catalogBefore = await invalidationCatalog(migrator);
    assert.ok(catalogBefore !== undefined);

    async function terminal(attempts = 1, role: 'owner' | 'admin' | 'viewer' = 'owner') {
      const fixture = await seedRequeuePgFixture(migrator!, worker!, kms, role);
      const oldLease = await actualRequeueTerminal(fixture, attempts);
      return { fixture, oldLease, command: await requeueCommand(migrator!, fixture), before: await requeuePgSnapshot(migrator!, fixture) };
    }
    function service(fixture: RequeuePgFixture, database = control!) { return new AuditedCredentialValidationRequeueService(database, fixture.targets); }

    await child(t, 'all custom function EXECUTE remain0, immutable bindings exact, no direct job/cycle/receipt writes', async () => {
      const exact = (await migrator.query<{ exact: boolean }>(`SELECT NOT EXISTS(SELECT 1 FROM (VALUES
        ('saas_credential_validation_requeue_request_insert()',$1::text,true),('saas_credential_validation_job_cycle_guard()',$2::text,false))
        e(signature,source,definer) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
          WHERE p.oid=to_regprocedure('model_router_saas.'||e.signature) AND p.prosrc=e.source AND p.prosecdef=e.definer
            AND p.proowner='model_router_saas_migrator'::regrole AND p.proconfig=ARRAY['search_path=pg_catalog, model_router_saas, pg_temp']
            AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype AND p.pronargs=0))
        AND NOT EXISTS(SELECT 1 FROM (VALUES
          ('saas_credential_validation_requeue_requests','saas_validation_requeue_requests_immutable',27),
          ('saas_credential_validation_requeue_requests','saas_validation_requeue_requests_no_truncate',34),
          ('saas_credential_validation_cycles','saas_validation_cycles_immutable',27),
          ('saas_credential_validation_cycles','saas_validation_cycles_no_truncate',34)) e(relation,name,type)
          WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('model_router_saas.'||e.relation)
            AND t.tgname=e.name AND t.tgtype=e.type AND t.tgenabled='O' AND NOT t.tgisinternal
            AND t.tgfoid='saas_reject_immutable_change()'::regprocedure AND t.tgnargs=0 AND t.tgargs=decode('','hex')
            AND t.tgattr::text='' AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred)) AS exact`,
      [REQUEUE_WRITER_SOURCE, REQUEUE_COUNTER_SOURCE])).rows[0];
      assert.ok(exact?.exact === true, 'actual owner/source/security/fixed path and whole-row/truncate immutable bindings required');
      const fixture = await seedRequeuePgFixture(migrator, worker, kms);
      await actualRequeueTerminal(fixture);
      const before = await requeuePgSnapshot(migrator, fixture);
      for (const actor of [control, gateway, worker]) {
        assert.ok((await actor.query<{ zero: boolean }>(`SELECT NOT EXISTS(SELECT 1 FROM pg_proc p
          WHERE p.pronamespace='model_router_saas'::regnamespace AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS zero`)).rows[0]?.zero === true);
        for (const signature of ['saas_credential_validation_requeue_request_insert()', 'saas_credential_validation_job_cycle_guard()',
          'saas_invalidate_account_credential_validation_jobs()', 'saas_invalidate_credential_validation_jobs()']) {
          await permissionDenied(() => actor.query(`SELECT model_router_saas.${signature}`));
        }
        for (const relation of ['saas_credential_validation_requeue_requests', 'saas_credential_validation_cycles']) {
          await permissionDenied(() => actor.query(`UPDATE ${relation} SET id=id WHERE tenant_id=$1::uuid`, [fixture.supply.tenants[0]]));
          await permissionDenied(() => actor.query(`DELETE FROM ${relation} WHERE tenant_id=$1::uuid`, [fixture.supply.tenants[0]]));
          await permissionDenied(() => actor.query(`TRUNCATE ${relation}`));
        }
      }
      for (const actor of [control, gateway]) await permissionDenied(() => actor.query(
        'UPDATE saas_tenant_provider_credential_validation_jobs SET status=status WHERE id=$1::uuid', [fixture.supply.jobId]));
      await permissionDenied(() => control.query('INSERT INTO saas_credential_validation_cycles(id) VALUES($1::uuid)', [randomUUID()]));
      await permissionDenied(() => control.query('INSERT INTO saas_credential_validation_requeue_requests(audit_event_id) VALUES($1::uuid)', [randomUUID()]));
      await permissionDenied(() => worker.query('UPDATE saas_tenant_provider_credential_validation_jobs SET cycle_start_attempt_count=0 WHERE id=$1::uuid', [fixture.supply.jobId]));
      await permissionDenied(() => gateway.query('UPDATE saas_api_keys SET status=status WHERE tenant_id=$1::uuid', [fixture.supply.tenants[0]]));
      sameFacts(await requeuePgSnapshot(migrator, fixture), before, 'ACL negatives cannot alter any job/history/authority/audit');
    });

    await child(t, 'real cumulative5 legacy -> immutable cycle -> five new actual retries; second cycle and old receipt remain stable', async () => {
      const { fixture, oldLease, command, before } = await terminal(5);
      const priorJob = targetJob(before, fixture);
      assert.ok(priorJob.attempt_count === 5 && priorJob.current_cycle_id === null, 'real original five attempts retained without fixture reset');
      const receipt = await service(fixture).requeue(fixture.actor, command);
      const after = await requeuePgSnapshot(migrator, fixture); const queued = targetJob(after, fixture);
      assert.ok(!receipt.replayed && receipt.cycleStartAttemptCount === 5 && receipt.cycleAttemptLimit === 5 &&
        queued.status === 'queued' && queued.attempt_count === 5 && queued.current_cycle_id === receipt.cycleId && queued.lease_until === null);
      assert.ok(after.requests.length === 1 && after.cycles.length === 1 && after.audit.length === 1, 'single transaction must leave exactly one request/cycle/audit');
      sameFacts(after.cycles[0]?.prior_snapshot, priorJob, 'immutable prior snapshot must be the actual locked original row, not a caller-built history');
      sameFacts(after.supply.outcomes, before.supply.outcomes, 'requeue cannot enable credentials/accounts or change capabilities/rights/envelopes');
      sameFacts(after.jobs.filter((row) => row.id !== fixture.supply.jobId), before.jobs.filter((row) => row.id !== fixture.supply.jobId), 'unrelated tenant/account/job/history unchanged');
      await actualRequeueTerminal(fixture, 5); // Existing global-only worker MUST fail this gate until stage2 integration.
      const completed = await requeuePgSnapshot(migrator, fixture);
      assert.ok(targetJob(completed, fixture).attempt_count === 10 && targetJob(completed, fixture).status === 'failed', 'new cycle is bounded by RELATIVE attempts, not cumulative resets');
      sameFacts(completed.requests, after.requests, 'worker must never change immutable request');
      sameFacts(completed.cycles, after.cycles, 'worker must never rewrite prior cycle/history');
      const replay = await service(fixture).requeue(fixture.actor, command);
      sameFacts(replay, { ...receipt, replayed: true }, 'exact original receipt must survive completion');
      sameFacts(await requeuePgSnapshot(migrator, fixture), completed, 'readonly replay cannot requeue or mutate terminal state');
      assert.ok(await fixture.store.complete(oldLease, REQUEUE_PG_VERIFIED) === false && await fixture.store.complete(oldLease, REQUEUE_PG_FAILED) === false);
      await leaseLost(() => fixture.store.recheckBeforeProviderRequest(oldLease));
      let callback = false; const decrypts = kms.decryptCalls;
      await leaseLost(() => fixture.store.withCredential(oldLease, () => { callback = true; }));
      assert.ok(!callback && kms.decryptCalls === decrypts);
      sameFacts(await requeuePgSnapshot(migrator, fixture), completed, 'old lease CAS/recheck/unseal cannot publish any new outcome');
      const next = await requeueCommand(migrator, fixture); const second = await service(fixture).requeue(fixture.actor, next);
      const secondState = await requeuePgSnapshot(migrator, fixture);
      assert.ok(second.cycleStartAttemptCount === 10 && secondState.cycles.length === 2 && secondState.requests.length === 2 && secondState.audit.length === 2);
      const nextCycle = secondState.cycles.find((row) => row.id === second.cycleId);
      assert.ok(nextCycle?.prior_cycle_id === receipt.cycleId, 'cycles chain immutable history rather than overwriting it');
      await actualRequeueTerminal(fixture);
      const final = await requeuePgSnapshot(migrator, fixture);
      assert.ok(targetJob(final, fixture).attempt_count === 11);
      sameFacts(await service(fixture).requeue(fixture.actor, command), { ...receipt, replayed: true }, 'old-cycle receipt cannot downgrade/replace the newer cycle');
      sameFacts(await requeuePgSnapshot(migrator, fixture), final, 'old-cycle replay cannot modify new terminal facts');
    });

    await child(t, 'parallel identical manual requests serialize on the real matching exclusive fence and create one cycle', async () => {
      const { fixture, command } = await terminal(); const entered = deferred<number>(); const release = deferred<void>();
      const tapped = tappedRequeueDatabase(control, async (tx) => {
        const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        assert.ok(typeof pid === 'number'); entered.resolve(pid); await release.promise;
      });
      const first = service(fixture, tapped).requeue(fixture.actor, command);
      const firstOutcome = first.then((value) => ({ value }), (error: unknown) => { entered.reject(error); return { error }; });
      let secondDone = false; let second: ReturnType<typeof first.then> | undefined;
      try {
        const holder = await entered.promise; const waiter = await backend(otherControl);
        second = service(fixture, otherControl).requeue(fixture.actor, command).then((value) => { secondDone = true; return value; });
        const rejection = second.catch((error: unknown) => { secondDone = true; throw redactedRequeueFailure('parallel-second', error); });
        await observeRequeueFenceWait(migrator, waiter, holder, () => secondDone);
        release.resolve(); const firstResult = await firstOutcome; if ('error' in firstResult) throw firstResult.error;
        const replay = await rejection;
        sameFacts(replay, { ...firstResult.value, replayed: true }, 'concurrent second command returns exact persisted receipt');
        const state = await requeuePgSnapshot(migrator, fixture);
        assert.ok(state.requests.length === 1 && state.cycles.length === 1 && state.audit.length === 1);
      } finally { release.resolve(); await firstOutcome; if (second) await second.catch(() => undefined); }
      await actualRequeueTerminal(fixture);
    });

    await child(t, 'every key/CAS/snapshot/reason conflict and untrusted target/actor body has no second queue/history effect', async () => {
      const { fixture, command } = await terminal(); await service(fixture).requeue(fixture.actor, command);
      const before = await requeuePgSnapshot(migrator, fixture);
      for (const changed of [
        { ...command, expectedLeaseGeneration: command.expectedLeaseGeneration + 1 },
        { ...command, expectedCredentialAuthzVersion: command.expectedCredentialAuthzVersion + 1 },
        { ...command, expectedSnapshotSha256: 'f'.repeat(64) }, { ...command, idempotencyKey: 'f'.repeat(64) },
        { ...command, requestId: randomUUID() }, { ...command, reason: 'A different bounded reason' },
        { ...command, reasonCode: 'target_approved' as const },
      ]) await refused('IDEMPOTENCY_CONFLICT', () => service(fixture).requeue(fixture.actor, changed));
      for (const key of ['actorUserId', 'tenantId', 'target', 'ciphertext', 'cycleAttemptLimit']) {
        const changed = { ...command, [key]: 'caller-body-cannot-control-authority' };
        await refused('INVALID_INPUT', () => service(fixture).requeue(fixture.actor, changed));
      }
      sameFacts(await requeuePgSnapshot(migrator, fixture), before, 'no conflict may upsert a second request or alter the original job/outcome');
      await actualRequeueTerminal(fixture);
    });

    await child(t, 'post-success INSERT pre-COMMIT sentinel atomically rolls back queue/request/cycle/audit; retry succeeds', async () => {
      const { fixture, command, before } = await terminal(); const sentinel = new Error('controlled-requeue-rollback'); let success = false;
      const tapped = tappedRequeueDatabase(control, async (tx) => {
        const visible = (await tx.query<{ exact: boolean }>(`SELECT EXISTS(SELECT 1 FROM saas_credential_validation_requeue_requests r
          JOIN saas_credential_validation_cycles c ON c.id=r.id JOIN saas_audit_events a ON a.id=r.audit_event_id
          JOIN saas_tenant_provider_credential_validation_jobs j ON j.current_cycle_id=c.id
          WHERE r.tenant_id=$1::uuid AND r.idempotency_key=$2 AND c.job_id=$3::uuid AND j.status='queued'
            AND j.attempt_count=c.cycle_start_attempt_count AND a.entry_point='credential-validation-requeue') AS exact`,
        [fixture.supply.tenants[0], command.idempotencyKey, fixture.supply.jobId])).rows[0];
        assert.ok(visible?.exact === true, 'real CP transaction must see all four actual successful trigger effects before injecting failure');
        success = true; throw sentinel;
      });
      await refused('STORAGE_UNAVAILABLE', () => service(fixture, tapped).requeue(fixture.actor, command));
      assert.ok(success, 'original sentinel injected only after real write success');
      sameFacts(await requeuePgSnapshot(migrator, fixture), before, 'real rollback restores all prior history/counters/authority and leaves no audit gap');
      await service(fixture).requeue(fixture.actor, command); await actualRequeueTerminal(fixture);
    });

    await child(t, 'active lease cannot be manually overridden through service OR the guarded minimal CP INSERT', async () => {
      const fixture = await seedRequeuePgFixture(migrator, worker, kms); const live = await actualRequeueClaim(fixture);
      const command = { jobId: live.job.id, expectedCredentialAuthzVersion: 1, expectedLeaseGeneration: live.fencingToken,
        expectedSnapshotSha256: credentialValidationJobSnapshotSha256(live.job), idempotencyKey: 'd'.repeat(64), requestId: randomUUID(),
        reasonCode: 'retry_provider_validation' as const, reason: 'Must not replace a live actual worker lease' };
      const before = await requeuePgSnapshot(migrator, fixture);
      await refused('STATE_CONFLICT', () => service(fixture).requeue(fixture.actor, command));
      let denied = false;
      try { await control.query(`INSERT INTO saas_credential_validation_requeue_requests
        (id,tenant_id,actor_user_id,actor_session_id,job_id,idempotency_key,request_digest,request_id,
          expected_credential_authz_version,expected_lease_generation,snapshot_sha256,reason_code,reason)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), fixture.supply.tenants[0], fixture.supply.actorId, fixture.sessionId, live.job.id, command.idempotencyKey,
        credentialValidationRequeueRequestDigest(fixture.supply.tenants[0], fixture.supply.actorId, command, fixture.supply.target.evidenceSha256),
        command.requestId, 1, live.fencingToken, command.expectedSnapshotSha256, command.reasonCode, command.reason]); }
      catch (error) { denied = true; assert.ok(actualSqlState(error) === '23514' && typeof error === 'object' && error !== null &&
        'constraint' in error && error.constraint === 'saas_requeue_state', 'actual trigger must enforce the terminal/live lease rule'); }
      assert.ok(denied); sameFacts(await requeuePgSnapshot(migrator, fixture), before, 'neither service nor raw permitted request INSERT may override a live lease');
      assert.ok(await fixture.store.complete(live, REQUEUE_PG_FAILED) === true);
    });

    await child(t, 'fresh owner/admin only: cached role, foreign actor/tenant, revoked session and disabled account cannot requeue', async () => {
      for (const role of ['owner', 'admin'] as const) {
        const { fixture, command } = await terminal(1, role); await service(fixture).requeue(fixture.actor, command); await actualRequeueTerminal(fixture);
      }
      const { fixture, command, before } = await terminal(1, 'viewer');
      const cachedOwner = { ...fixture.actor, context: { ...fixture.actor.context, tenantRole: 'owner' as const } };
      await refused('FORBIDDEN', () => service(fixture).requeue(cachedOwner, command));
      await refused('UNAUTHENTICATED', () => service(fixture).requeue({ ...cachedOwner, context: { ...cachedOwner.context, userId: randomUUID() } }, command));
      sameFacts(await requeuePgSnapshot(migrator, fixture), before, 'a caller cannot manufacture tenant/session actor authority');
      const owner = await terminal();
      await new SaasIdentityService(otherControl).logout(owner.fixture.actor.sessionToken);
      await refused('UNAUTHENTICATED', () => service(owner.fixture).requeue(owner.fixture.actor, owner.command));
      assert.ok((await requeuePgSnapshot(migrator, owner.fixture)).requests.length === 0, 'revoked session produces no request/history');
      const disabled = await terminal(); await disableAccount(otherControl, disabled.fixture);
      const afterDisable = await requeuePgSnapshot(migrator, disabled.fixture);
      await refused('TARGET_NOT_AUTHORIZED', () => service(disabled.fixture).requeue(disabled.fixture.actor, disabled.command));
      sameFacts(await requeuePgSnapshot(migrator, disabled.fixture), afterDisable, 'approval/retry must never automatically enable revoked/disabled authority');
    });

    await child(t, 'audited queue transaction blocks real CP disable; post-wait invalidation and old worker CAS preserve history', async () => {
      const { fixture, oldLease, command } = await terminal(); const entered = deferred<number>(); const release = deferred<void>();
      const tapped = tappedRequeueDatabase(control, async (tx) => { const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        assert.ok(typeof pid === 'number'); entered.resolve(pid); await release.promise; });
      const pending = service(fixture, tapped).requeue(fixture.actor, command);
      const outcome = pending.then((value) => ({ value }), (error: unknown) => { entered.reject(error); return { error }; });
      let cpDone = false; let cp: Promise<void> | undefined;
      try {
        const holder = await entered.promise; const waiter = await backend(otherControl);
        cp = disableAccount(otherControl, fixture).finally(() => { cpDone = true; });
        const cpOutcome = cp.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        await observeRequeueFenceWait(migrator, waiter, holder, () => cpDone);
        release.resolve(); const result = await outcome; if ('error' in result) throw result.error;
        const changed = await cpOutcome; if (!changed.ok) throw changed.error;
      } finally { release.resolve(); await outcome; if (cp) await cp.catch(() => undefined); }
      const state = await requeuePgSnapshot(migrator, fixture); const job = targetJob(state, fixture);
      assert.ok(job.status === 'cancelled' && job.attempt_count === 1 && job.lease_until === null && state.cycles.length === 1 && state.audit.length === 1);
      assert.ok(await fixture.store.complete(oldLease, REQUEUE_PG_VERIFIED) === false);
      await leaseLost(() => fixture.store.recheckBeforeProviderRequest(oldLease));
      const current = await requeueCommand(migrator, fixture);
      await refused('TARGET_NOT_AUTHORIZED', () => service(fixture).requeue(fixture.actor, current));
      sameFacts(await requeuePgSnapshot(migrator, fixture), state, 'old CAS/new manual retry cannot rewrite invalidation, history, cumulative counts or rights');
    });

    sameFacts(await invalidationCatalog(migrator), catalogBefore, 'every business/negative case preserves function/catalog/ACL/constraint bindings');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifyCredentialValidationWorkerSchemaReadiness(worker);
    await verifyCredentialValidationWorkerRuntimePrivileges(worker);
  } catch (error) { throw redactedRequeueFailure('root', error); }
});
