import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { createSaasGatewayHandler } from '../../../src/saas/gateway/http-handler.js';
import { PostgresPreDispatchCompensation } from '../../../src/saas/gateway/postgres-pre-dispatch-compensation.js';
import { createPostgresPreparationCapacityPort } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import { GatewayPreDispatchCompensationService } from '../../../src/saas/gateway/pre-dispatch-compensation-service.js';
import {
  SaasPreparedEvidenceDispatchError,
  SaasPreparedEvidenceDispatchService,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { SaasPreparedRequestEvidenceError } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { PostgresProviderAccountLeaseService } from '../../../src/saas/gateway/provider-account-lease-service.js';
import { GatewayRequestIdempotencyStore } from '../../../src/saas/gateway/request-idempotency.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';
import { SaasMeteringError } from '../../../src/saas/metering/errors.js';
import { SaasMeteringService } from '../../../src/saas/metering/service.js';
import type { AttemptRecord } from '../../../src/saas/metering/types.js';
import { createPostgresDispatchLeaseProvider } from '../../../src/server/managed-saas-gateway.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationFixture,
  cancellationPgConfigured,
  cancellationSnapshot,
  cancellationTransaction,
  safeCancellationFailure,
} from './pre-dispatch-postgres-fixture.js';

// Like the established cancellation gate, this root requires the successful
// dual-mode HTTP fixture first on this exact disposable database. No DDL,
// extra grants, provider traffic or synthetic lease-null return is used here.
type Fixture = Awaited<ReturnType<typeof cancellationFixture>>;

class CapacityResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  status: number | undefined;
  headers: Record<string, unknown> = {};
  body = '';
  setHeader() {}
  writeHead(status: number, headers: Record<string, unknown>) {
    assert.equal(this.headersSent, false, 'capacity must reject before starting a response');
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(body?: string) {
    this.body = body ?? '';
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

async function financialSnapshot(observer: SqlExecutor, fixture: Fixture) {
  const result = await observer.query<Record<string, string | null>>(
    `SELECT
      (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1 AND request_id = $2::uuid) AS usage,
      (SELECT count(*)::text FROM saas_usage_settlements s JOIN saas_usage_events u
        ON u.tenant_id = s.tenant_id AND u.id = s.usage_event_id
        WHERE u.tenant_id = $1 AND u.request_id = $2::uuid) AS settlements,
      (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
      (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
        FROM saas_ledger_entries WHERE tenant_id = $1 AND wallet_id IS NOT NULL) AS wallet_ledger,
      (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = $1) AS transactions,
      (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS entries,
      (SELECT count(*)::text FROM (
        SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
        WHERE l.tenant_id = $1 GROUP BY l.id, l.amount_minor_units
        HAVING count(e.id) <> 2 OR
          COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
          COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
      ) invalid) AS unbalanced,
      (SELECT status FROM saas_prepared_request_evidence WHERE tenant_id = $1 AND id = $3::uuid) AS evidence_status,
      (SELECT prepared_evidence_id::text FROM saas_attempts WHERE tenant_id = $1 AND id = $4::uuid) AS binding,
      (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = $1 AND target_id = $3::text
        AND action = 'saas_prepared_request_evidence.claimed') AS claim_audits`,
    [fixture.tenantId, fixture.requestId, fixture.evidenceId, fixture.attemptId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.balance, row.wallet_ledger, 'committed wallet projection must equal its real ledger');
  assert.equal(row.unbalanced, '0');
  assert.equal(row.usage, '0');
  assert.equal(row.settlements, '0');
  assert.equal(row.evidence_status, 'registered');
  assert.equal(row.binding, null);
  assert.equal(row.claim_audits, '0');
  return row;
}

async function heldLeaseSnapshot(observer: SqlExecutor, fixture: Fixture) {
  const result = await observer.query<Record<string, unknown>>(
    `SELECT id, tenant_id, owner_kind, owner_tenant_id, account_id, upstream_id, attempt_id,
      slot::text, fencing_token::text, status, lease_expires_at::text
      FROM saas_provider_account_leases WHERE tenant_id = $1 AND attempt_id = $2::text`,
    [fixture.tenantId, fixture.attemptId],
  );
  assert.equal(result.rows.length, 1, 'A must own exactly one actual PostgreSQL lease');
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.status, 'held');
  return row;
}

test('dispatch account capacity uses real PG leases and fully compensated 429 on restricted PG15/18', {
  skip:
    process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
      ? `set ${CANCELLATION_PG_REQUIRED}=1 and all disposable E2E role URLs`
      : false,
  timeout: 120000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  try {
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: an actually full account never claims/sends and releases B exactly once`, async () => {
        const a = await cancellationFixture(migrator, gateway, mode);
        const b = await cancellationFixture(migrator, gateway, mode);
        assert.equal(a.tenantId, b.tenantId);
        assert.equal(a.prepared.evidence.accountId, b.prepared.evidence.accountId);
        assert.notEqual(a.attemptId, b.attemptId);
        const raw = new PostgresProviderAccountLeaseService({
          database: gateway,
          maxConcurrency: 1,
          leaseTtlMs: 90000,
        });
        const held = await raw.acquire({
          tenantId: a.tenantId,
          accountId: a.prepared.evidence.accountId,
          upstreamId: a.prepared.evidence.upstreamId,
          attemptId: a.attemptId,
          evidence: a.prepared.evidence,
        });
        assert.ok(held, 'the first real acquisition must occupy the sole configured slot');
        try {
          const beforeA = await heldLeaseSnapshot(migrator, a);
          assert.equal(beforeA.fencing_token, held.fencingToken);
          const before = await cancellationSnapshot(migrator, b);
          const beforeFinancial = await financialSnapshot(migrator, b);
          const metering = new SaasMeteringService(gateway);
          const stale: { value: AttemptRecord | null } = { value: null };
          let preflights = 0,
            claims = 0,
            acquires = 0,
            sends = 0,
            cleanups = 0,
            capacityErrors = 0;
          const provider = createPostgresDispatchLeaseProvider(raw);
          const dispatcher = new SaasPreparedEvidenceDispatchService(
            {
              async preflightForDispatch(...args) {
                const value = await b.evidenceService.preflightForDispatch(...args);
                preflights++;
                return value;
              },
              async claimForDispatch(...args) {
                claims++;
                return b.evidenceService.claimForDispatch(...args);
              },
            },
            {
              async getAttempt(...args) {
                stale.value = await metering.getAttempt(...args);
                return stale.value;
              },
              transitionAttempt: (input) => metering.transitionAttempt(input),
              recordKnownNonSuccessHttpResponse: (input) => metering.recordKnownNonSuccessHttpResponse(input),
            },
            {
              async acquire(input) {
                acquires++;
                return provider.acquire(input);
              },
            },
            {
              async send() {
                sends++;
                throw new Error('an actually full account must not reach a provider');
              },
            },
          );
          const compensation = new GatewayPreDispatchCompensationService(
            { transaction: (work) => cancellationTransaction(gateway, work) },
            new PostgresPreDispatchCompensation({
              capacity: createPostgresPreparationCapacityPort(),
              billing: b.billing,
            }),
          );
          const request = Object.assign(Readable.from([Buffer.from('{"model":"synthetic-model"}')]), {
            method: 'POST',
            url: '/v1/chat/completions',
            complete: true,
            aborted: false,
            headers: { authorization: 'Bearer synthetic-pg-capacity-key', 'content-type': 'application/json' },
            socket: { remoteAddress: '127.0.0.1' },
          });
          const response = new CapacityResponse();
          const handler = createSaasGatewayHandler({
            authenticator: {
              async authenticate() {
                return { authorization: { principalId: 'synthetic-actor' } } as AuthenticatedApiKey;
              },
            },
            preparation: {
              async prepare() {
                return b.prepared;
              },
            },
            dispatch: {
              async dispatch(input) {
                try {
                  return await dispatcher.dispatch(input);
                } catch (error) {
                  assert.ok(error instanceof SaasPreparedEvidenceDispatchError);
                  assert.equal(error.code, 'LEASE_CAPACITY_EXHAUSTED');
                  capacityErrors++;
                  throw error;
                }
              },
            },
            preDispatchCompensation: {
              async compensate(input) {
                cleanups++;
                return compensation.compensate(input);
              },
            },
          });
          await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse, {
            requestId: b.requestId,
          });
          assert.equal(response.status, 429);
          assert.equal(response.headers['retry-after'], undefined);
          assert.equal(JSON.parse(response.body).error.code, 'RATE_LIMITED');
          assert.deepEqual(
            { preflights, claims, acquires, sends, cleanups, capacityErrors },
            { preflights: 1, claims: 0, acquires: 1, sends: 0, cleanups: 1, capacityErrors: 1 },
          );
          const after = await cancellationSnapshot(migrator, b);
          assert.equal(after.execution_state, 'failed');
          assert.equal(after.dispatch_state, 'not_sent');
          assert.equal(after.result_state, 'failed');
          assert.equal(after.response_started, false);
          assert.equal(after.financial_status, mode === 'byok' ? 'not_applicable' : 'released');
          assert.equal(after.hold_state, mode === 'byok' ? null : 'released');
          assert.equal(after.capacity_state, 'released');
          assert.equal(after.idempotency_state, 'completed');
          assert.equal(after.released_audits, '1');
          assert.equal(after.settlements, before.settlements);
          assert.deepEqual(after.wallets, before.wallets);
          assert.deepEqual(await financialSnapshot(migrator, b), beforeFinancial);
          assert.deepEqual(await heldLeaseSnapshot(migrator, a), beforeA, 'B cannot release or mutate A lease/token');
          const replay = await compensation.compensate({
            prepared: b.prepared,
            cause: 'dispatch_failed',
            responseMayHaveStarted: false,
          });
          assert.equal(replay.disposition, 'released');
          const binding = b.command.admission.idempotencyBinding;
          assert.ok(binding);
          const idempotency = await cancellationTransaction(gateway, (tx) =>
            new GatewayRequestIdempotencyStore({ hmacKey: new Uint8Array(32).fill(59) }).claim(tx, {
              tenantId: b.tenantId,
              projectId: b.projectId,
              proxyKeyId: b.proxyKeyId,
              requestId: b.requestId,
              clientKey: `pre-dispatch-test:${b.requestId}`,
              requestFingerprint: binding.requestFingerprint,
              requestFingerprintVersion: binding.requestFingerprintVersion,
            }),
          );
          assert.equal(idempotency.kind, 'existing');
          if (idempotency.kind === 'existing') {
            assert.equal(idempotency.state, 'completed');
            assert.equal(idempotency.canonicalRequestId, b.requestId);
          }
          await assert.rejects(
            b.evidenceService.claimForDispatch(b.evidenceId, {
              actorUserId: null,
              entryPoint: 'dispatch-capacity-pg',
              requestId: b.requestId,
            }),
            (error: unknown) =>
              error instanceof SaasPreparedRequestEvidenceError &&
              error.code === 'STORAGE_ERROR' &&
              error.message === 'prepared evidence attempt claim affected an unexpected number of rows' &&
              error.cause === undefined,
          );
          const observed = stale.value;
          assert.ok(observed);
          await assert.rejects(
            metering.transitionAttempt({
              tenantId: b.tenantId,
              requestId: b.requestId,
              attemptId: b.attemptId,
              expectedDispatchState: 'not_sent',
              expectedResultState: 'pending',
              expectedResponseStarted: false,
              expectedStateVersion: observed.stateVersion,
              dispatchState: 'dispatching',
              resultState: 'pending',
              responseStarted: false,
            }),
            (error: unknown) => error instanceof SaasMeteringError && error.code === 'ATTEMPT_TRANSITION_INVALID',
          );
          assert.deepEqual(await cancellationSnapshot(migrator, b), after);
          assert.deepEqual(await financialSnapshot(migrator, b), beforeFinancial);
          assert.deepEqual(await heldLeaseSnapshot(migrator, a), beforeA);
          assert.equal(acquires, 1, 'replays and rejected late claims never acquire again');
        } finally {
          await held.release();
        }
      });
    }
  } catch (error) {
    throw safeCancellationFailure(error);
  } finally {
    await Promise.all(databases.map((database) => database.close()));
  }
});
