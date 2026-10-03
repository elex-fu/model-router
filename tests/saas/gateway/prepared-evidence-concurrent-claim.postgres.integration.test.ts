import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  SaasPreparedRequestEvidenceError,
  type PreparedRequestEvidenceAudit,
  type PreparedRequestEvidenceRecord,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationFixture,
  cancellationPgConfigured,
  cancellationSqlState,
  cancellationTransaction,
  safeCancellationFailure,
} from './pre-dispatch-postgres-fixture.js';

const CLAIM_ACTION = 'saas_prepared_request_evidence.claimed';
const required = process.env[CANCELLATION_PG_REQUIRED]?.trim() ?? '0';
const offline = !cancellationPgConfigured && required === '0';
type Fixture = Awaited<ReturnType<typeof cancellationFixture>>;

test('concurrent-claim fixture excludes the shared local PostgreSQL port', () => {
  const source = readFileSync(resolve(process.cwd(), 'tests/saas/gateway/pre-dispatch-postgres-fixture.ts'), 'utf8');
  assert.match(source, /!\[5432, 6432, 53782\]\.includes\(port\)/);
});

class BeforeClaimLocks {
  readonly pids = new Set<number>();
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private release!: () => void;
  private reject!: (reason: Error) => void;

  constructor() {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.release = resolveReady;
      this.reject = rejectReady;
    });
    this.timer = setTimeout(() => this.reject(new Error('synthetic two-transaction claim barrier timed out')), 4000);
    // A failure before the first arrival must not leave an unhandled timeout.
    void this.ready.catch(() => undefined);
  }

  async arrive(pid: number): Promise<void> {
    assert.ok(!this.pids.has(pid), 'both claims must occupy different pooled PG sessions');
    this.pids.add(pid);
    assert.ok(this.pids.size <= 2, 'barrier accepts exactly two claims');
    if (this.pids.size === 2) { clearTimeout(this.timer); this.release(); }
    await this.ready;
  }

  close(): void { clearTimeout(this.timer); }
}

interface ClaimTransaction {
  readonly pid: number;
  readonly role: string;
  readonly session: string;
  hintReads: number;
  attemptWrites: number;
  evidenceWrites: number;
  auditAttempts: number;
  auditWrites: number;
  outcome: 'running' | 'committed' | 'rolled_back';
}

interface ClaimProbe {
  active: boolean;
  fixture?: Fixture;
  barrier?: BeforeClaimLocks;
  failBeforeAudit?: Error;
  readonly transactions: ClaimTransaction[];
}

/** All statements delegate to the exact restricted gateway pool (max: 4).
 * The sole race barrier follows the real read-only hint, before advisory/row locks.
 * A synthetic audit fault is injected before its SQL; prior claim writes remain real PG writes.
 */
function observedGateway(gateway: SaasDatabase, probe: ClaimProbe): SaasDatabase {
  return {
    ...gateway,
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const captured: { value?: ClaimTransaction } = {};
      try {
        const value = await cancellationTransaction(gateway, async (tx) => {
          if (!probe.active) return work(tx);
          const identity = (await tx.query<{ pid: number; role: string; session: string }>(
            'SELECT pg_backend_pid() AS pid, current_user AS role, session_user AS session',
          )).rows[0];
          assert.ok(identity); assert.equal(identity.role, 'model_router_saas_gateway');
          assert.equal(identity.session, 'model_router_saas_gateway'); assert.ok(Number.isSafeInteger(identity.pid));
          const fact: ClaimTransaction = { ...identity, hintReads: 0, attemptWrites: 0, evidenceWrites: 0,
            auditAttempts: 0, auditWrites: 0, outcome: 'running' };
          captured.value = fact; probe.transactions.push(fact);
          const executor: SqlExecutor = {
            async query<Row>(sql: string, values: readonly unknown[] = []) {
              const claimAudit = sql.startsWith('INSERT INTO saas_audit_events') && values[3] === CLAIM_ACTION;
              if (claimAudit) {
                assert.ok(probe.fixture);
                assert.equal(values[1], probe.fixture.tenantId); assert.equal(values[5], probe.fixture.evidenceId);
                assert.equal(values[10], probe.fixture.requestId);
                fact.auditAttempts++;
                if (probe.failBeforeAudit) throw probe.failBeforeAudit;
              }
              const result = await tx.query<Row>(sql, values);
              if (sql.includes('/* prepared-evidence:evidence-lock-hint */')) {
                fact.hintReads++;
                assert.equal(fact.attemptWrites, 0); assert.equal(fact.evidenceWrites, 0);
                assert.ok(!/FOR\s+(UPDATE|SHARE)/i.test(sql), 'barrier query must remain read-only and unlocked');
                if (probe.barrier) await probe.barrier.arrive(identity.pid);
              }
              if (sql.startsWith('UPDATE saas_attempts ')) { assert.equal(result.rowCount, 1); fact.attemptWrites++; }
              if (sql.startsWith('UPDATE saas_prepared_request_evidence ')) { assert.equal(result.rowCount, 1); fact.evidenceWrites++; }
              if (claimAudit) fact.auditWrites++;
              return result;
            },
          };
          return work(executor);
        });
        if (captured.value) captured.value.outcome = 'committed';
        return value;
      } catch (error) {
        if (captured.value) captured.value.outcome = 'rolled_back';
        throw error;
      }
    },
  };
}

interface ClaimSnapshot {
  readonly attempt_fixed: string;
  readonly attempt_version: string;
  readonly attempt_updated_at: string;
  readonly prepared_evidence_id: string | null;
  readonly dispatch_state: string;
  readonly result_state: string;
  readonly response_started: boolean;
  readonly evidence_identity: string;
  readonly evidence_status: string;
  readonly claimed_at: string | null;
  readonly claimed_attempt_id: string | null;
  readonly prepared_bindings: string;
  readonly claim_audits: string;
  readonly registered_audits: string;
  readonly resources: string;
  readonly holds: Array<{ state: string }>;
}

async function snapshot(migrator: SqlExecutor, fixture: Fixture): Promise<ClaimSnapshot> {
  const result = await migrator.query<ClaimSnapshot>(
    // Serialize JSON in PG before it crosses the driver boundary: bigint
    // amounts/revisions must not lose precision in JavaScript JSON numbers.
    `SELECT (to_jsonb(a) - ARRAY['state_version', 'updated_at', 'prepared_evidence_id']::text[])::text AS attempt_fixed,
      a.state_version::text AS attempt_version, a.updated_at::text AS attempt_updated_at, a.prepared_evidence_id,
      a.dispatch_state, a.result_state, a.response_started,
      jsonb_build_array(e.id, e.tenant_id, e.project_id, e.request_id, e.attempt_id, e.attempt_ordinal,
        e.payload_sha256, e.statement_sha256, e.resolved_model, e.model_resolution_requested_model,
        e.model_resolution_mapped_model, e.model_resolution_mapping_source, e.model_resolution_mapping_version)::text AS evidence_identity,
      e.status AS evidence_status, e.claimed_at::text AS claimed_at, e.claimed_attempt_id,
      (SELECT count(*)::text FROM saas_attempts WHERE tenant_id = $1 AND prepared_evidence_id = $4) AS prepared_bindings,
      (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = $1 AND target_id = $4::text
        AND target_type = 'saas_prepared_request_evidence' AND action = '${CLAIM_ACTION}') AS claim_audits,
      (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = $1 AND target_id = $4::text
        AND target_type = 'saas_prepared_request_evidence' AND action = 'saas_prepared_request_evidence.registered') AS registered_audits,
      jsonb_build_object(
        'request', (SELECT to_jsonb(r) FROM saas_requests r WHERE tenant_id = $1 AND id = $2),
        'capacity', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.request_id) FROM saas_gateway_capacity_reservations c
          WHERE tenant_id = $1 AND request_id = $2),
        'idempotency', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.key_digest) FROM saas_gateway_request_idempotency_keys i
          WHERE tenant_id = $1 AND request_id = $2),
        'holds', (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM saas_billing_reservations h WHERE tenant_id = $1 AND request_id = $2),
        'wallets', (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM saas_wallets w WHERE tenant_id = $1),
        'ledger', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM saas_ledger_transactions l WHERE tenant_id = $1)
      )::text AS resources,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('state', state) ORDER BY id)
        FROM saas_billing_reservations WHERE tenant_id = $1 AND request_id = $2), '[]'::jsonb) AS holds
     FROM saas_attempts a JOIN saas_prepared_request_evidence e
       ON e.tenant_id = a.tenant_id AND e.request_id = a.request_id AND e.attempt_id = a.id
     WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3 AND e.id = $4`,
    [fixture.tenantId, fixture.requestId, fixture.attemptId, fixture.evidenceId],
  );
  assert.equal(result.rows.length, 1, 'fresh signed fixture must have one original attempt/evidence identity');
  return result.rows[0]!;
}

function auditFor(fixture: Fixture): PreparedRequestEvidenceAudit {
  return { actorUserId: null, entryPoint: 'prepared-evidence-concurrent-claim-pg', requestId: fixture.requestId };
}

function assertEvidenceError(error: unknown, code: 'ALREADY_CLAIMED' | 'AUDIT_FAILED'): asserts error is SaasPreparedRequestEvidenceError {
  assert.ok(error instanceof SaasPreparedRequestEvidenceError, 'SQL/storage/TypeError cannot stand in for the expected domain refusal');
  assert.equal(error.code, code); assert.equal(cancellationSqlState(error), undefined);
}

function assertFresh(before: ClaimSnapshot, mode: 'byok' | 'platform'): void {
  assert.equal(before.prepared_evidence_id, null); assert.equal(before.evidence_status, 'registered');
  assert.equal(before.claimed_at, null); assert.equal(before.claimed_attempt_id, null);
  assert.equal(before.prepared_bindings, '0'); assert.equal(before.claim_audits, '0');
  assert.equal(before.registered_audits, '1'); assert.equal(before.dispatch_state, 'not_sent');
  assert.equal(before.result_state, 'pending'); assert.equal(before.response_started, false);
  assert.deepEqual(before.holds, mode === 'byok' ? [] : [{ state: 'reserved' }]);
}

async function assertOneClaim(migrator: SqlExecutor, fixture: Fixture, before: ClaimSnapshot): Promise<ClaimSnapshot> {
  const after = await snapshot(migrator, fixture);
  assert.equal(after.attempt_version, (BigInt(before.attempt_version) + 1n).toString());
  assert.equal(after.prepared_evidence_id, fixture.evidenceId); assert.equal(after.prepared_bindings, '1');
  assert.equal(after.evidence_status, 'claimed'); assert.equal(after.claimed_attempt_id, fixture.attemptId);
  assert.ok(after.claimed_at); assert.equal(after.claim_audits, '1'); assert.equal(after.registered_audits, '1');
  assert.deepEqual(after.attempt_fixed, before.attempt_fixed); assert.deepEqual(after.evidence_identity, before.evidence_identity);
  assert.deepEqual(after.resources, before.resources, 'claim cannot mutate wallet, hold, capacity, idempotency, request or ledger');
  assert.deepEqual(after.holds, before.holds);
  // No dispatcher or transport exists in this root. Both transactions only
  // claim evidence; durable facts must still show zero dispatch/response.
  assert.equal(after.dispatch_state, 'not_sent'); assert.equal(after.result_state, 'pending'); assert.equal(after.response_started, false);
  const monotonic = (await migrator.query<{ valid: boolean }>(
    'SELECT updated_at >= $4::timestamptz AS valid FROM saas_attempts WHERE tenant_id = $1 AND request_id = $2 AND id = $3',
    [fixture.tenantId, fixture.requestId, fixture.attemptId, before.attempt_updated_at],
  )).rows[0];
  assert.equal(monotonic?.valid, true);
  return after;
}

test('two real restricted-gateway transactions claim one signed evidence exactly once on PG15/18', {
  skip: offline ? 'offline: no disposable E2E role URLs and REQUIRED=0' : false,
  timeout: 120000,
}, async (t) => {
  assert.ok(required === '0' || required === '1', 'PG gate REQUIRED must be 0 or 1');
  // REQUIRED=1 with zero URLs, or any incomplete configured URL set, reaches
  // the real fixture checks and fails closed. There is no always-SKIP branch.
  const { databases, migrator, gateway } = await cancellationDatabases();
  try {
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: concurrent claims have one exact domain loser and no send or financial/capacity effect`, { timeout: 30000 }, async () => {
        const probe: ClaimProbe = { active: false, transactions: [] };
        const fixture = await cancellationFixture(migrator, observedGateway(gateway, probe), mode);
        probe.fixture = fixture;
        const before = await snapshot(migrator, fixture); assertFresh(before, mode);
        const barrier = new BeforeClaimLocks(); probe.barrier = barrier; probe.active = true;
        try {
          const options = { payloadSha256: fixture.prepared.evidence.payloadSha256 };
          const outcomes = await Promise.allSettled([0, 1].map(() =>
            fixture.evidenceService.claimForDispatch(fixture.evidenceId, auditFor(fixture), options)));
          assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1, 'exactly one real transaction commits');
          assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1, 'exactly one real transaction loses');
          for (const outcome of outcomes) {
            if (outcome.status === 'rejected') assertEvidenceError(outcome.reason, 'ALREADY_CLAIMED');
            else {
              const claimed: PreparedRequestEvidenceRecord = outcome.value;
              assert.equal(claimed.evidenceId, fixture.evidenceId); assert.equal(claimed.tenantId, fixture.tenantId);
              assert.equal(claimed.requestId, fixture.requestId); assert.equal(claimed.attemptId, fixture.attemptId);
              assert.equal(claimed.status, 'claimed'); assert.equal(claimed.claimedAttemptId, fixture.attemptId);
            }
          }
          assert.equal(barrier.pids.size, 2); assert.equal(probe.transactions.length, 2);
          assert.ok(probe.transactions.every((fact) => fact.hintReads === 1 && fact.role === 'model_router_saas_gateway' && fact.session === fact.role));
          assert.deepEqual(probe.transactions.map((fact) => [fact.attemptWrites, fact.evidenceWrites, fact.auditWrites, fact.outcome]).sort(),
            [[0, 0, 0, 'rolled_back'], [1, 1, 1, 'committed']]);
          const after = await assertOneClaim(migrator, fixture, before);
          probe.barrier = undefined;
          await assert.rejects(fixture.evidenceService.claimForDispatch(fixture.evidenceId, auditFor(fixture), options),
            (error: unknown) => { assertEvidenceError(error, 'ALREADY_CLAIMED'); return true; });
          assert.deepEqual(await snapshot(migrator, fixture), after, 'duplicate claim creates neither a second binding/bump nor audit/effect');
          const duplicate = probe.transactions[2]; assert.ok(duplicate);
          assert.equal(duplicate.attemptWrites, 0); assert.equal(duplicate.evidenceWrites, 0); assert.equal(duplicate.auditAttempts, 0);
        } finally { barrier.close(); probe.active = false; }
      });

      await t.test(`${mode}: a real claim write followed by a pre-audit fault rolls back atomically and can be claimed once later`, { timeout: 30000 }, async () => {
        const probe: ClaimProbe = { active: false, transactions: [] };
        const fixture = await cancellationFixture(migrator, observedGateway(gateway, probe), mode);
        probe.fixture = fixture;
        const before = await snapshot(migrator, fixture); assertFresh(before, mode);
        const sentinel = new Error('synthetic fault before claim audit SQL'); probe.failBeforeAudit = sentinel; probe.active = true;
        const options = { payloadSha256: fixture.prepared.evidence.payloadSha256 };
        await assert.rejects(fixture.evidenceService.claimForDispatch(fixture.evidenceId, auditFor(fixture), options),
          (error: unknown) => { assertEvidenceError(error, 'AUDIT_FAILED'); assert.equal(error.cause, sentinel); return true; });
        assert.equal(probe.transactions.length, 1, 'no implicit claim retry');
        const failed = probe.transactions[0]; assert.ok(failed);
        assert.deepEqual([failed.attemptWrites, failed.evidenceWrites, failed.auditAttempts, failed.auditWrites, failed.outcome],
          [1, 1, 1, 0, 'rolled_back'], 'fault follows actual PG attempt/evidence writes, before audit SQL');
        assert.deepEqual(await snapshot(migrator, fixture), before, 'actual ROLLBACK restores original version, refs and all resources');
        probe.failBeforeAudit = undefined;
        const claimed = await fixture.evidenceService.claimForDispatch(fixture.evidenceId, auditFor(fixture), options);
        assert.equal(claimed.evidenceId, fixture.evidenceId); assert.equal(claimed.status, 'claimed');
        const after = await assertOneClaim(migrator, fixture, before);
        await assert.rejects(fixture.evidenceService.claimForDispatch(fixture.evidenceId, auditFor(fixture), options),
          (error: unknown) => { assertEvidenceError(error, 'ALREADY_CLAIMED'); return true; });
        assert.deepEqual(await snapshot(migrator, fixture), after);
        assert.equal(probe.transactions.length, 3); probe.active = false;
      });
    }
  } catch (error) { throw safeCancellationFailure(error); }
  finally { await Promise.all(databases.map((database) => database.close())); }
});
