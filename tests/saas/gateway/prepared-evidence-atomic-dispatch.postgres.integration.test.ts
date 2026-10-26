import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasPreparedEvidenceDispatchService } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import {
  consumePreparedDispatchGrant,
  getAuthoritativePreparedAttempt,
  type PreparedDispatchGrant,
  SaasPreparedRequestEvidenceService,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';
import { evidenceAuthorityFixture } from './prepared-evidence-authority-postgres-fixture.js';

type Fixture = Awaited<ReturnType<typeof evidenceAuthorityFixture>>;
interface Probe {
  readonly transactions: string[][];
  before?: (sql: string, values: readonly unknown[], tx: SqlExecutor) => Promise<void>;
  after?: (
    sql: string,
    result: SqlResult<Record<string, unknown>>,
    tx: SqlExecutor,
  ) => Promise<SqlResult<Record<string, unknown>>>;
  committed?: (sql: readonly string[]) => void;
}
function observed(database: SaasDatabase, probe: Probe): SaasDatabase {
  return {
    ...database,
    async transaction(work) {
      const statements: string[] = [];
      probe.transactions.push(statements);
      const result = await database.transaction((tx) =>
        work({
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            statements.push(sql);
            await probe.before?.(sql, values, tx);
            const result = await tx.query<Row>(sql, values);
            return probe.after
              ? ((await probe.after(sql, result as SqlResult<Record<string, unknown>>, tx)) as SqlResult<Row>)
              : result;
          },
        }),
      );
      probe.committed?.(statements);
      return result;
    },
  };
}
function fused(statements: readonly string[]) {
  return statements.some(
    (sql) => sql.startsWith('UPDATE saas_attempts ') && sql.includes("dispatch_state = 'dispatching'"),
  );
}
function bytes(fixture: Fixture) {
  const payload = new TextEncoder().encode(
    `admission-bench-payload:evidence-authority:${fixture.input.requestId}:${fixture.input.requestId}`,
  );
  assert.equal(sha256Hex(payload), fixture.input.payloadSha256);
  return payload;
}
async function state(db: SqlExecutor, fixture: Fixture) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT a.dispatch_state, a.result_state,
    a.state_version::text AS state_version, a.prepared_evidence_id, e.status AS evidence_status,
    (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = $1 AND target_id = $3::text
      AND action = 'saas_prepared_request_evidence.claimed') AS claim_audits,
    jsonb_build_object(
      'wallets', (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM saas_wallets w WHERE tenant_id = $1),
      'holds', (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM saas_billing_reservations h WHERE tenant_id = $1),
      'ledger', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM saas_ledger_transactions l WHERE tenant_id = $1),
      'usage', (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM saas_usage_events u WHERE tenant_id = $1)
    )::text AS financial
    FROM saas_attempts a JOIN saas_prepared_request_evidence e ON e.tenant_id = a.tenant_id AND e.attempt_id = a.id
    WHERE a.tenant_id = $1 AND a.id = $2 AND e.id = $3::uuid`,
    [fixture.input.tenantId, fixture.input.attemptId, fixture.evidenceId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}
function dispatcher(fixture: Fixture, evidence: SaasPreparedRequestEvidenceService, send: () => Promise<void>) {
  const facts = { sends: 0, reads: 0, dispatchTransitions: 0, releases: 0 };
  const service = new SaasPreparedEvidenceDispatchService(
    evidence,
    {
      async getAttempt() {
        facts.reads++;
        throw new Error('native dispatch must reuse authoritative attempt snapshots');
      },
      async transitionAttempt(input) {
        if (input.dispatchState === 'dispatching') {
          facts.dispatchTransitions++;
          throw new Error('native dispatch must not use a detached dispatch CAS');
        }
        return fixture.original.metering.transitionAttempt(input);
      },
      recordKnownNonSuccessHttpResponse: (input) => fixture.original.metering.recordKnownNonSuccessHttpResponse(input),
    },
    {
      async acquire() {
        return {
          fencingToken: 'fixture-only-fence',
          renewIntervalMs: 60_000,
          async renew() {},
          async release() {
            facts.releases++;
          },
        };
      },
    },
    {
      async send() {
        facts.sends++;
        await send();
        return { responseStarted: true, resultHttpStatus: 200 };
      },
    },
  );
  return {
    service,
    facts,
    input: { evidenceId: fixture.evidenceId, payloadBytes: bytes(fixture), audit: fixture.input.audit },
  };
}

test('restricted PG atomic evidence dispatch preserves fences, commit-before-send, single use and rollback', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? 'disposable E2E role URLs not configured' : false,
  timeout: 180_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.all([migrator.close(), gateway.close()]);
  });
  await gateway.verifySchema();
  assert.equal(
    (
      await gateway.query<{ role: string; superuser: boolean }>(
        'SELECT current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
      )
    ).rows[0]?.role,
    'model_router_saas_gateway',
  );

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(
      `${mode}: commit precedes send, one claim CAS, no detached reads or dispatch CAS, retry sends nothing`,
      async () => {
        const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
        const before = await state(gateway, fixture);
        const probe: Probe = { transactions: [] };
        const evidence = new SaasPreparedRequestEvidenceService(observed(gateway, probe), fixture.options);
        const dispatch = dispatcher(fixture, evidence, async () => {
          const durable = await state(gateway, fixture);
          assert.equal(durable.dispatch_state, 'dispatching');
          assert.equal(durable.evidence_status, 'claimed');
          assert.equal(durable.claim_audits, '1');
          assert.equal(durable.state_version, String(Number(before.state_version) + 1));
        });
        assert.equal((await dispatch.service.dispatch(dispatch.input)).kind, 'sent');
        assert.equal(probe.transactions.length, 2, 'one preflight and one fused claim transaction');
        const claim = probe.transactions.find(fused);
        assert.ok(claim);
        assert.equal(claim.length, 10, 'same ten business calls as old claim; no extra read/dispatch statement');
        assert.equal(claim.filter((sql) => sql.startsWith('UPDATE saas_attempts ')).length, 1);
        assert.ok(
          claim.at(-1)?.startsWith('UPDATE saas_attempts '),
          'expiry-fenced dispatch CAS is after blocking audit work',
        );
        assert.ok(
          claim.findIndex((sql) => sql.startsWith('UPDATE saas_prepared_request_evidence ')) <
            claim.findIndex((sql) => sql.startsWith('UPDATE saas_attempts ')),
        );
        assert.deepEqual(dispatch.facts, { sends: 1, reads: 0, dispatchTransitions: 0, releases: 1 });
        await assert.rejects(dispatch.service.dispatch(dispatch.input));
        assert.equal(dispatch.facts.sends, 1);
        assert.equal(
          (await state(gateway, fixture)).financial,
          before.financial,
          'dispatch/retry never duplicates a financial write',
        );
      },
    );

    await t.test(
      `${mode}: simultaneous native claims yield one unforgeable issuer/request/payload-bound single-use grant`,
      async () => {
        const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
        let arrivals = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const probe: Probe = {
          transactions: [],
          async after(sql, result) {
            if (sql.includes('prepared-evidence:evidence-lock-hint')) {
              arrivals++;
              if (arrivals === 2) release();
              await barrier;
            }
            return result;
          },
        };
        const service = new SaasPreparedRequestEvidenceService(observed(gateway, probe), fixture.options);
        const options = { payloadSha256: fixture.input.payloadSha256 };
        const results = await Promise.allSettled([
          service.claimAndBeginDispatch(fixture.evidenceId, fixture.input.audit, options),
          service.claimAndBeginDispatch(fixture.evidenceId, fixture.input.audit, options),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
        const winner = results.find((result) => result.status === 'fulfilled');
        assert.ok(winner && winner.status === 'fulfilled');
        assert.throws(() =>
          consumePreparedDispatchGrant({} as PreparedDispatchGrant, service, fixture.evidenceId, options.payloadSha256),
        );
        assert.throws(() =>
          consumePreparedDispatchGrant(
            { ...winner.value } as PreparedDispatchGrant,
            service,
            fixture.evidenceId,
            options.payloadSha256,
          ),
        );
        const claimed = consumePreparedDispatchGrant(winner.value, service, fixture.evidenceId, options.payloadSha256);
        assert.equal(getAuthoritativePreparedAttempt(claimed, service)?.dispatchState, 'dispatching');
        assert.ok(Object.isFrozen(claimed));
        assert.throws(() =>
          consumePreparedDispatchGrant(winner.value, service, fixture.evidenceId, options.payloadSha256),
        );
        assert.equal((await state(gateway, fixture)).claim_audits, '1');
      },
    );

    for (const fault of ['audit', 'decode', 'expired-before-attempt', 'expired-at-audit', 'commit-ack'] as const) {
      await t.test(`${mode}: ${fault} returns no grant/send, never retries or double charges`, async () => {
        const fixture = await evidenceAuthorityFixture(
          migrator,
          gateway,
          mode,
          fault.startsWith('expired-') ? { evidenceTtlMs: 1000 } : {},
        );
        const before = await state(gateway, fixture);
        let faultCalls = 0;
        const probe: Probe = {
          transactions: [],
          async before(sql, values) {
            if (
              fault === 'audit' &&
              sql.startsWith('INSERT INTO saas_audit_events') &&
              values[3] === 'saas_prepared_request_evidence.claimed'
            ) {
              faultCalls++;
              throw new Error('synthetic audit failure');
            }
            if (fault === 'expired-at-audit' && sql.startsWith('INSERT INTO saas_audit_events')) {
              faultCalls++;
              await delay(1200);
            }
            if (fault === 'expired-before-attempt' && sql.startsWith('UPDATE saas_attempts ')) {
              faultCalls++;
              await delay(1200);
            }
          },
          async after(sql, result) {
            if (fault === 'decode' && sql.startsWith('UPDATE saas_attempts ')) {
              faultCalls++;
              return { ...result, rows: result.rows.map((row) => ({ ...row, state_version: 'invalid' })) };
            }
            return result;
          },
          committed(statements) {
            if (fault === 'commit-ack' && fused(statements)) {
              faultCalls++;
              throw new Error('synthetic committed acknowledgement lost');
            }
          },
        };
        const evidence = new SaasPreparedRequestEvidenceService(observed(gateway, probe), fixture.options);
        const dispatch = dispatcher(fixture, evidence, async () => {});
        await assert.rejects(dispatch.service.dispatch(dispatch.input));
        assert.equal(faultCalls, 1);
        assert.equal(dispatch.facts.sends, 0);
        assert.equal(dispatch.facts.releases, 1);
        const after = await state(gateway, fixture);
        assert.equal(after.financial, before.financial);
        if (fault === 'commit-ack') {
          assert.equal(after.dispatch_state, 'dispatching');
          assert.equal(after.evidence_status, 'claimed');
          assert.equal(after.claim_audits, '1');
          await assert.rejects(dispatch.service.dispatch(dispatch.input));
          assert.equal(dispatch.facts.sends, 0);
          assert.equal(faultCalls, 1);
        } else assert.deepEqual(after, before, 'evidence, dispatch and audit all roll back');
      });
    }

    await t.test(`${mode}: revocation between preflight and claim refuses the fused write`, async () => {
      const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
      const before = await state(gateway, fixture);
      await fixture.evidenceService.preflightForDispatch(fixture.evidenceId, fixture.input.audit);
      await migrator.query(
        `UPDATE saas_api_keys SET status = 'revoked', revoked_at = clock_timestamp(), authz_version = authz_version + 1 WHERE tenant_id = $1 AND id = $2`,
        [fixture.input.tenantId, fixture.input.proxyKeyId],
      );
      await assert.rejects(
        fixture.evidenceService.claimAndBeginDispatch(fixture.evidenceId, fixture.input.audit, {
          payloadSha256: fixture.input.payloadSha256,
        }),
      );
      assert.deepEqual(await state(gateway, fixture), before);
    });

    await t.test(`${mode}: transport failure after commit retains unknown and replay never sends again`, async () => {
      const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
      const before = await state(gateway, fixture);
      const dispatch = dispatcher(fixture, fixture.evidenceService, async () => {
        throw new Error('synthetic upstream outcome unknown');
      });
      assert.equal((await dispatch.service.dispatch(dispatch.input)).kind, 'unknown');
      assert.equal((await state(gateway, fixture)).dispatch_state, 'unknown');
      await assert.rejects(dispatch.service.dispatch(dispatch.input));
      assert.equal(dispatch.facts.sends, 1);
      assert.equal((await state(gateway, fixture)).financial, before.financial);
    });

    await t.test(
      `${mode}: client abort after COMMIT sends nothing and retains unknown instead of not-sent compensation`,
      async () => {
        const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
        const controller = new AbortController();
        const evidence = new SaasPreparedRequestEvidenceService(
          observed(gateway, {
            transactions: [],
            committed(statements) {
              if (fused(statements)) controller.abort();
            },
          }),
          fixture.options,
        );
        const dispatch = dispatcher(fixture, evidence, async () => {});
        const result = await dispatch.service.dispatch({
          ...dispatch.input,
          client: { signal: controller.signal, start() {}, write() {}, end() {}, abort() {} },
        });
        assert.equal(result.kind, 'unknown');
        assert.equal(dispatch.facts.sends, 0);
        assert.equal((await state(gateway, fixture)).dispatch_state, 'unknown');
      },
    );
  }
});
