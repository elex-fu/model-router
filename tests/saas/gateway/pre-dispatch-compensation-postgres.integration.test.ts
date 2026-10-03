import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { SaasMeteringService } from '../../../src/saas/metering/service.js';
import type { AttemptRecord } from '../../../src/saas/metering/types.js';
import { SaasPreparedEvidenceDispatchService } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { PostgresPreDispatchCompensation } from '../../../src/saas/gateway/postgres-pre-dispatch-compensation.js';
import { createPostgresPreparationCapacityPort } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import { GatewayPreDispatchCompensationService } from '../../../src/saas/gateway/pre-dispatch-compensation-service.js';
import { createSaasGatewayHandler } from '../../../src/saas/gateway/http-handler.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';
import {
  CANCELLATION_PG_REQUIRED, cancellationPgConfigured, cancellationDatabases, cancellationFixture,
  cancellationSnapshot, cancellationTransaction, safeCancellationFailure,
} from './pre-dispatch-postgres-fixture.js';

test('FIN pre-dispatch cancellation uses restricted gateway transactions on real PG15/18', {
  skip: process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
    ? `set ${CANCELLATION_PG_REQUIRED}=1 and all disposable E2E role URLs` : false,
  timeout: 120000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  try {
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: cancel at preparation completion has zero dispatches and one atomic release`, async () => {
        const fixture = await cancellationFixture(migrator, gateway, mode);
        const before = await cancellationSnapshot(migrator, fixture);
        const port = new PostgresPreDispatchCompensation({ capacity: createPostgresPreparationCapacityPort(), billing: fixture.billing });
        const service = new GatewayPreDispatchCompensationService({ transaction: (work) => cancellationTransaction(gateway, work) }, port);
        const request = Object.assign(Readable.from([Buffer.from('{"model":"synthetic-model"}')]), {
          method: 'POST', url: '/v1/chat/completions', complete: true, aborted: false,
          headers: { authorization: 'Bearer synthetic-pg-test-key', 'content-type': 'application/json' },
          socket: { remoteAddress: '127.0.0.1' },
        });
        const response = Object.assign(new EventEmitter(), {
          headersSent: false, destroyed: false, writableEnded: false, setHeader() {},
        });
        let dispatches = 0; let cleanups = 0;
        const handler = createSaasGatewayHandler({
          authenticator: { async authenticate() { return { authorization: { principalId: 'synthetic-actor' } } as AuthenticatedApiKey; } },
          preparation: { async prepare() { request.aborted = true; response.destroyed = true; return fixture.prepared; } },
          dispatch: { async dispatch() { dispatches++; throw new Error('cancelled request must never dispatch'); } },
          preDispatchCompensation: { async compensate(input) { cleanups++; return service.compensate(input); } },
        });
        await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse, { requestId: fixture.requestId });
        assert.equal(dispatches, 0); assert.equal(cleanups, 1);
        const after = await cancellationSnapshot(migrator, fixture);
        assert.equal(after.execution_state, 'failed'); assert.equal(after.dispatch_state, 'not_sent');
        assert.equal(after.result_state, 'failed'); assert.equal(after.response_started, false);
        assert.equal(after.financial_status, mode === 'byok' ? 'not_applicable' : 'released');
        assert.equal(after.hold_state, mode === 'byok' ? null : 'released');
        assert.equal(after.capacity_state, 'released'); assert.equal(after.idempotency_state, 'completed');
        assert.equal(after.released_audits, '1'); assert.equal(after.settlements, before.settlements);
        assert.deepEqual(after.wallets, before.wallets);
        assert.equal((await service.compensate({ prepared: fixture.prepared, cause: 'dispatch_failed', responseMayHaveStarted: false })).disposition, 'released');
        assert.deepEqual(await cancellationSnapshot(migrator, fixture), after);
      });

      await t.test(`${mode}: pending preflight loses to committed cancellation; claim/CAS reject with zero sends`, async () => {
        const fixture = await cancellationFixture(migrator, gateway, mode);
        const before = await cancellationSnapshot(migrator, fixture);
        const metering = new SaasMeteringService(gateway);
        const port = new PostgresPreDispatchCompensation({ capacity: createPostgresPreparationCapacityPort(), billing: fixture.billing });
        const service = new GatewayPreDispatchCompensationService({ transaction: (work) => cancellationTransaction(gateway, work) }, port);
        let observed: AttemptRecord | null = null; let leasesReleased = 0; let sends = 0;
        let cancelledSnapshot: Awaited<ReturnType<typeof cancellationSnapshot>> | undefined;
        const dispatcher = new SaasPreparedEvidenceDispatchService(fixture.evidenceService, {
          async getAttempt(tenant, request, attempt) {
            observed = await metering.getAttempt(tenant, request, attempt);
            assert.equal(observed?.resultState, 'pending'); assert.equal(observed?.dispatchState, 'not_sent');
            return observed;
          },
          transitionAttempt: (input) => metering.transitionAttempt(input),
          recordKnownNonSuccessHttpResponse: (input) => metering.recordKnownNonSuccessHttpResponse(input),
        }, {
          async acquire() {
            // The production dispatcher has completed preflight and read the
            // pending attempt. This deterministic pause models a separate gateway
            // winning cancellation before the dispatch claim/transition commits.
            assert.ok(observed);
            const outcomes = await Promise.all([1, 2].map(() => service.compensate({
              prepared: fixture.prepared, cause: 'client_cancelled', responseMayHaveStarted: false,
            })));
            assert.ok(outcomes.every((result) => result.disposition === 'released'));
            cancelledSnapshot = await cancellationSnapshot(migrator, fixture);
            assert.equal(cancelledSnapshot.released_audits, '1');
            return { fencingToken: 'synthetic-lease-no-provider-io', renewIntervalMs: 1000,
              async renew() {}, async release() { leasesReleased++; } };
          },
        }, { async send() { sends++; throw new Error('cancelled attempt must never reach upstream'); } });
        await assert.rejects(dispatcher.dispatch({ evidenceId: fixture.evidenceId, payloadBytes: fixture.prepared.payloadBytes,
          audit: { actorUserId: null, entryPoint: 'pre-dispatch-pg-race', requestId: fixture.requestId } }));
        assert.ok(observed); assert.ok(cancelledSnapshot);
        assert.equal(sends, 0); assert.equal(leasesReleased, 1);
        const stale = observed as unknown as AttemptRecord;
        // A caller that already held the old preflight snapshot also loses its
        // durable CAS, independently of evidence-claim rejection.
        await assert.rejects(metering.transitionAttempt({ tenantId: fixture.tenantId, requestId: fixture.requestId,
          attemptId: fixture.attemptId, expectedDispatchState: 'not_sent', expectedResultState: 'pending',
          expectedResponseStarted: false, expectedStateVersion: stale.stateVersion,
          dispatchState: 'dispatching', resultState: 'pending', responseStarted: false }));
        const replay = await service.compensate({ prepared: fixture.prepared, cause: 'dispatch_failed', responseMayHaveStarted: false });
        assert.equal(replay.disposition, 'released');
        const after = await cancellationSnapshot(migrator, fixture);
        assert.deepEqual(after, cancelledSnapshot); assert.equal(after.settlements, before.settlements);
        assert.deepEqual(after.wallets, before.wallets);
      });

      await t.test(`${mode}: audit fault after release SQL rolls back hold, capacity and all terminal state`, async () => {
        const fixture = await cancellationFixture(migrator, gateway, mode);
        const before = await cancellationSnapshot(migrator, fixture);
        const port = new PostgresPreDispatchCompensation({ capacity: createPostgresPreparationCapacityPort(), billing: fixture.billing });
        const sentinel = new Error('synthetic cancellation audit fault');
        let terminalWrites = 0;
        await assert.rejects(cancellationTransaction(gateway, async (tx) => {
          const executor: SqlExecutor = { async query<Row>(sql: string, values?: readonly unknown[]) {
            if (sql.includes('INSERT INTO saas_audit_events')) throw sentinel;
            const result = await tx.query<Row>(sql, values);
            if (sql.startsWith('UPDATE saas_attempts') || sql.startsWith('UPDATE saas_requests') || sql.startsWith('UPDATE saas_gateway_request_idempotency_keys')) {
              assert.equal(result.rowCount, 1); terminalWrites++;
            }
            return result;
          } };
          await port.releasePreDispatch(fixture.command, { executor });
        }), (error: unknown) => error === sentinel);
        assert.equal(terminalWrites, 3, 'fault must occur after real terminal CAS writes');
        assert.deepEqual(await cancellationSnapshot(migrator, fixture), before);
        const result = await cancellationTransaction(gateway, (executor) => port.releasePreDispatch(fixture.command, { executor }));
        assert.equal(result.decision, 'allow');
        if (result.decision === 'allow') assert.equal(result.value.disposition, 'released');
      });

      await t.test(`${mode}: response uncertainty retains capacity and funds with durable audit, never TTL release`, async () => {
        const fixture = await cancellationFixture(migrator, gateway, mode);
        const before = await cancellationSnapshot(migrator, fixture);
        const port = new PostgresPreDispatchCompensation({ capacity: createPostgresPreparationCapacityPort(), billing: fixture.billing });
        const result = await cancellationTransaction(gateway, (executor) => port.releasePreDispatch({ ...fixture.command, responseMayHaveStarted: true }, { executor }));
        assert.equal(result.decision, 'allow');
        if (result.decision === 'allow') assert.equal(result.value.disposition, 'retained_for_reconciliation');
        const after = await cancellationSnapshot(migrator, fixture);
        assert.equal(after.capacity_state, 'retained_for_reconciliation'); assert.equal(after.retained_audits, '1');
        assert.equal(after.execution_state, 'pending'); assert.equal(after.result_state, 'pending');
        assert.equal(after.hold_state, mode === 'byok' ? null : 'reserved');
        assert.equal(after.idempotency_state, 'in_progress'); assert.deepEqual(after.wallets, before.wallets);
        const again = await cancellationTransaction(gateway, (executor) => port.releasePreDispatch(fixture.command, { executor }));
        assert.equal(again.decision, 'allow');
        if (again.decision === 'allow') assert.equal(again.value.disposition, 'retained_for_reconciliation');
      });
    }
  } catch (error) { throw safeCancellationFailure(error); }
  finally { await Promise.all(databases.map((db) => db.close())); }
});
