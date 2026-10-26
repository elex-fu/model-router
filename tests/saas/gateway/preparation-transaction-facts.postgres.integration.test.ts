import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RedisQuotaState } from '../../../src/quota/redis-state.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  readPreparationTransactionRecords,
  takePreparationTransactionFacts,
} from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import { bindPreparationTransactionEvidence } from '../../../src/saas/gateway/preparation-transaction-facts.js';
import { canonicalPreparedRequestEvidencePayload } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { RedisPreparationCapacity } from '../../../src/saas/gateway/redis-preparation-capacity.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';
import { evidenceAuthorityFixture } from './prepared-evidence-authority-postgres-fixture.js';

const skip = process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured;
function traceDatabase(database: SaasDatabase, afterQuery?: (sql: string) => Promise<void>) {
  const trace: { sql: string; ms: number }[] = [];
  let active = false;
  return {
    trace,
    clear() {
      trace.length = 0;
      active = true;
    },
    database: {
      ...database,
      transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
        return database.transaction((tx) =>
          work({
            async query<Row>(sql: string, values?: readonly unknown[]) {
              const started = performance.now();
              try {
                const result = await tx.query<Row>(sql, values);
                await afterQuery?.(sql);
                return result;
              } finally {
                if (active) trace.push({ sql, ms: performance.now() - started });
              }
            },
          }),
        );
      },
    },
  };
}
async function noResidue(database: SaasDatabase, requestId: string) {
  const result = await database.query<{
    requests: string;
    attempts: string;
    reservations: string;
    outbox: string;
    evidence: string;
  }>(
    `SELECT (SELECT count(*)::text FROM saas_requests WHERE id::text=$1::text) AS requests,
      (SELECT count(*)::text FROM saas_attempts WHERE request_id::text=$1::text) AS attempts,
      (SELECT count(*)::text FROM saas_billing_reservations WHERE request_id::text=$1::text) AS reservations,
      (SELECT count(*)::text FROM saas_request_admission_outbox WHERE request_id::text=$1::text) AS outbox,
      (SELECT count(*)::text FROM saas_prepared_request_evidence WHERE request_id::text=$1::text) AS evidence`,
    [requestId],
  );
  assert.deepEqual(result.rows, [{ requests: '0', attempts: '0', reservations: '0', outbox: '0', evidence: '0' }]);
}

test('real PostgreSQL preparation facts: identical register predicates, four fewer SQL calls, fresh claim', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0] });
  const gateway = createSaasDatabase({ connectionString: urls[2] });
  t.after(async () => {
    await Promise.all([migrator.close(), gateway.close()]);
  });
  for (const mode of ['byok', 'platform'] as const)
    await t.test(mode, async () => {
      const baseline = traceDatabase(gateway);
      await evidenceAuthorityFixture(migrator, baseline.database, mode, {
        beforeRegister: async () => baseline.clear(),
      });
      const optimized = traceDatabase(gateway);
      const fixture = await evidenceAuthorityFixture(migrator, optimized.database, mode, {
        reusePreparationFacts: true,
        beforeRegister: async (tx, input) => {
          const first = await readPreparationTransactionRecords(tx, input.tenantId, input.requestId, input.attemptId);
          assert.ok(first, 'successful real guard issued records');
          const canonical = canonicalPreparedRequestEvidencePayload(input);
          bindPreparationTransactionEvidence(tx, canonical);
          assert.equal(
            takePreparationTransactionFacts(tx, { ...input, payloadSha256: '0'.repeat(64) }, canonical, []),
            undefined,
          );
          assert.equal(takePreparationTransactionFacts(tx, input, `${canonical}forged`, []), undefined);
          assert.equal(takePreparationTransactionFacts(tx, input, canonical, ['unheld-fence']), undefined);

          (first.request as unknown as { tenantId: string }).tenantId = 'forged';
          const second = await readPreparationTransactionRecords(tx, input.tenantId, input.requestId, input.attemptId);
          assert.equal(second?.request.tenantId, input.tenantId, 'returned records cannot mutate capability');
          assert.equal(
            await readPreparationTransactionRecords({ ...tx }, input.tenantId, input.requestId, input.attemptId),
            undefined,
          );
          optimized.clear();
        },
      });
      assert.equal(baseline.trace.length, 7);
      assert.equal(optimized.trace.length, 3);
      for (const marker of ['fence-batch', 'authority-batch', 'request */', 'attempt */']) {
        assert.equal(optimized.trace.filter((q) => q.sql.includes(`prepared-evidence:${marker}`)).length, 0);
      }
      assert.equal(optimized.trace.filter((q) => q.sql.includes('prepared-evidence:clock')).length, 1);
      t.diagnostic(
        `${mode} register statements ${baseline.trace.length} -> ${optimized.trace.length}; SQL time ${baseline.trace.reduce((s, q) => s + q.ms, 0).toFixed(2)} -> ${optimized.trace.reduce((s, q) => s + q.ms, 0).toFixed(2)} ms`,
      );
      optimized.clear();
      await fixture.evidenceService.preflightForDispatch(fixture.evidenceId, fixture.input.audit);
      assert.equal(
        optimized.trace.filter((q) => q.sql.includes('prepared-evidence:authority-batch')).length,
        1,
        'no reuse after preparation commit',
      );
      await migrator.query(
        "UPDATE saas_api_keys SET status='revoked',revoked_at=clock_timestamp(),authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixture.input.tenantId, fixture.input.proxyKeyId],
      );
      await assert.rejects(
        fixture.evidenceService.preflightForDispatch(fixture.evidenceId, fixture.input.audit),
        (e) => e instanceof Error && 'code' in e && e.code === 'AUTHORITY_MISMATCH',
      );
    });
  await t.test('Redis receipt invalidates records, two fresh reads are reused by register', async () => {
    const observed = traceDatabase(gateway);
    // receipt() is the production SQL half of Redis reservation; this test
    // intentionally exercises no Redis mutation or background writeback.
    const receipt = new RedisPreparationCapacity({} as RedisQuotaState, gateway, 'receipt-test');
    await evidenceAuthorityFixture(migrator, observed.database, 'platform', {
      reusePreparationFacts: true,
      beforeRegister: async (tx, input) => {
        const before = await readPreparationTransactionRecords(tx, input.tenantId, input.requestId, input.attemptId);
        assert.ok(before);
        await receipt.receipt(tx, input.tenantId, input.requestId, randomUUID(), randomUUID());
        observed.clear();
        const after = await readPreparationTransactionRecords(tx, input.tenantId, input.requestId, input.attemptId);
        assert.ok(after);
        assert.equal(after.request.stateVersion, before.request.stateVersion + 1);
        assert.equal(observed.trace.length, 2, 'refresh only request and attempt, not authority');
        assert.ok(observed.trace[0]?.sql.includes('postgres-request-admission:request'));
        assert.ok(observed.trace[1]?.sql.includes('postgres-request-admission:attempt'));
        observed.clear();
      },
    });
    assert.equal(observed.trace.length, 3, 'receipt path still skips four register queries');
  });
});

test('real PostgreSQL preparation facts retain final expiry and roll back money on cancel/revoke', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0] });
  const gateway = createSaasDatabase({ connectionString: urls[2] });
  t.after(async () => {
    await Promise.all([migrator.close(), gateway.close()]);
  });
  await t.test('expired signed evidence is denied using the fresh DB clock even on reuse', async () => {
    const observed = traceDatabase(gateway);
    let requestId = '';
    await assert.rejects(
      evidenceAuthorityFixture(migrator, observed.database, 'platform', {
        reusePreparationFacts: true,
        evidenceTtlMs: 30,
        beforeRegister: async (_tx, input) => {
          requestId = input.requestId;
          observed.clear();
          await delay(60);
        },
      }),
      (e) => e instanceof Error && 'code' in e && e.code === 'EXPIRED',
    );
    assert.ok(requestId);
    assert.equal(observed.trace.length, 1);
    assert.ok(observed.trace[0]?.sql.includes('prepared-evidence:clock'));
    await noResidue(migrator, requestId);
  });
  await t.test('cancellation rolls back request, hold, outbox and evidence', async () => {
    let requestId = '';
    await assert.rejects(
      evidenceAuthorityFixture(migrator, gateway, 'platform', {
        reusePreparationFacts: true,
        beforeRegister: async (_tx, input) => {
          requestId = input.requestId;
          throw new Error('client cancelled');
        },
      }),
      /client cancelled/,
    );
    await noResidue(migrator, requestId);
  });
  await t.test('unknown SQL queued during final clock revokes already-consumed proof', async () => {
    let scoped: SqlExecutor | undefined;
    let requestId = '';
    let armed = false;
    const observed = traceDatabase(gateway, async (sql) => {
      if (armed && sql.includes('prepared-evidence:clock')) {
        armed = false;
        assert.ok(scoped);
        await scoped.query('SELECT 42 AS unreviewed_operation');
      }
    });
    await assert.rejects(
      evidenceAuthorityFixture(migrator, observed.database, 'platform', {
        reusePreparationFacts: true,
        beforeRegister: async (tx, input) => {
          scoped = tx;
          requestId = input.requestId;
          armed = true;
          observed.clear();
        },
      }),
      (e) => e instanceof Error && 'code' in e && e.code === 'AUTHORITY_MISMATCH',
    );
    assert.equal(observed.trace.filter((q) => q.sql.includes('prepared-evidence:authority-batch')).length, 0);
    await noResidue(migrator, requestId);
  });
  await t.test('same-transaction owner revoke invalidates proof and uses fresh authority', async () => {
    // Owner-only synthetic mutation tests invalidation without broadening any
    // runtime grant. Production gateway cannot perform this UPDATE at all.
    const observed = traceDatabase(migrator);
    let requestId = '';
    await assert.rejects(
      evidenceAuthorityFixture(migrator, observed.database, 'platform', {
        reusePreparationFacts: true,
        beforeRegister: async (tx, input) => {
          requestId = input.requestId;
          await tx.query(
            "UPDATE saas_api_keys SET status='revoked',revoked_at=clock_timestamp(),authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2",
            [input.tenantId, input.proxyKeyId],
          );
          observed.clear();
        },
      }),
      (e) => e instanceof Error && 'code' in e && e.code === 'AUTHORITY_MISMATCH',
    );
    assert.equal(observed.trace.filter((q) => q.sql.includes('prepared-evidence:authority-batch')).length, 1);
    await noResidue(migrator, requestId);
  });
});
