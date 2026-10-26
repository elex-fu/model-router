import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  type PreparedRequestEvidenceRecord,
  SaasPreparedRequestEvidenceError,
  SaasPreparedRequestEvidenceService,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';
import { evidenceAuthorityFixture, rollbackEvidenceDatabase } from './prepared-evidence-authority-postgres-fixture.js';

type Fixture = Awaited<ReturnType<typeof evidenceAuthorityFixture>>;
type DispatchMethod = 'preflightForDispatch' | 'claimForDispatch';
type FenceBatch = { readonly sql: string; readonly keys: readonly string[] };
type FixtureWithFences = Fixture & { readonly fenceBatch: FenceBatch };

const FENCE_BATCH_MARKER = '/* prepared-evidence:fence-batch */';
// The exact individual-lock shape before batching, retained only as a real-query baseline.
const SINGLE_FENCE_BASELINE_SQL =
  '/* prepared-evidence:single-fence-baseline */ SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))';

function fenceBatch(sql: string, values: readonly unknown[] | undefined): FenceBatch | null {
  if (!sql.includes(FENCE_BATCH_MARKER)) return null;
  assert.equal(values?.length, 1);
  const keys = values?.[0];
  assert.ok(Array.isArray(keys) && keys.every((key) => typeof key === 'string'));
  assert.ok(keys.length > 2);
  return { sql, keys: [...keys] };
}

async function fixtureWithFences(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  mode: 'byok' | 'platform',
  options: { readonly evidenceTtlMs?: number } = {},
): Promise<FixtureWithFences> {
  const registrations: Array<{ evidenceId: string; batches: readonly FenceBatch[] }> = [];
  const observed: SaasDatabase = {
    ...gateway,
    async transaction(work) {
      const batches: FenceBatch[] = [];
      const registeredIds: string[] = [];
      const value = await gateway.transaction((tx) =>
        work({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const batch = fenceBatch(sql, values);
            if (batch) batches.push(batch);
            const result = await tx.query<Row>(sql, values);
            if (sql.startsWith('INSERT INTO saas_prepared_request_evidence (')) {
              assert.equal(result.rows.length, 1);
              const registration = result.rows[0];
              assert.ok(
                registration &&
                  typeof registration === 'object' &&
                  'id' in registration &&
                  typeof registration.id === 'string',
              );
              registeredIds.push(registration.id);
            }
            return result;
          },
        }),
      );
      // Publish only successful committed transactions; seed preflight/claim have no INSERT identity.
      for (const evidenceId of registeredIds) registrations.push({ evidenceId, batches: [...batches] });
      return value;
    },
  };
  const fixture = await evidenceAuthorityFixture(migrator, observed, mode, options);
  const target = registrations.filter((registration) => registration.evidenceId === fixture.evidenceId);
  assert.equal(target.length, 1, 'select exactly the target evidence registration transaction');
  const registration = target[0];
  assert.ok(registration);
  assert.equal(registration.batches.length, 1, 'capture only the actual registration fence SQL and bound keys');
  const capturedBatch = registration.batches[0];
  assert.ok(capturedBatch);
  return { ...fixture, fenceBatch: capturedBatch };
}

/** Replace only the new fence statement with its old per-key wire calls, not business reads or checks. */
function singleFenceBaseline(database: SaasDatabase, trace: string[], keys: string[]): SaasDatabase {
  return {
    ...database,
    transaction: (work) =>
      database.transaction((tx) =>
        work({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const batch = fenceBatch(sql, values);
            if (!batch) {
              trace.push(sql);
              return tx.query<Row>(sql, values);
            }
            const rows: Row[] = [];
            for (const key of batch.keys) {
              trace.push(SINGLE_FENCE_BASELINE_SQL);
              keys.push(key);
              rows.push(...(await tx.query<Row>(SINGLE_FENCE_BASELINE_SQL, [key])).rows);
            }
            return { rows, rowCount: rows.length };
          },
        }),
      ),
  };
}

function onExecutor(database: SaasDatabase, tx: SqlExecutor): SaasDatabase {
  return { ...database, transaction: (work) => work(tx) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function snapshot(database: SqlExecutor, fixture: Fixture) {
  const { tenantId, requestId, attemptId } = fixture.input;
  const result = await database.query<{
    attempt_version: string;
    prepared_evidence_id: string | null;
    evidence_status: string;
    audit_count: string;
    resources: string;
  }>(
    `SELECT a.state_version::text AS attempt_version, a.prepared_evidence_id,
      e.status AS evidence_status,
      (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = $1 AND target_id = $4::text
        AND action = 'saas_prepared_request_evidence.claimed') AS audit_count,
      jsonb_build_object(
        'request', (SELECT to_jsonb(r) FROM saas_requests r WHERE tenant_id = $1 AND id = $2),
        'capacity', (SELECT jsonb_agg(to_jsonb(c)) FROM saas_gateway_capacity_reservations c WHERE tenant_id = $1 AND request_id = $2),
        'holds', (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM saas_billing_reservations h WHERE tenant_id = $1 AND request_id = $2::text),
        'wallets', (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM saas_wallets w WHERE tenant_id = $1),
        'ledger', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM saas_ledger_transactions l WHERE tenant_id = $1)
      )::text AS resources
     FROM saas_attempts a JOIN saas_prepared_request_evidence e ON e.tenant_id = a.tenant_id AND e.attempt_id = a.id
     WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3 AND e.id = $4::uuid`,
    [tenantId, requestId, attemptId, fixture.evidenceId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function expectAuthorityRefusal(action: Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SaasPreparedRequestEvidenceError);
    assert.equal(error.code, 'AUTHORITY_MISMATCH');
    return true;
  });
}

async function revokeKey(tx: SqlExecutor, fixture: Fixture): Promise<void> {
  const changed = await tx.query(
    `UPDATE saas_api_keys SET status = 'revoked', revoked_at = clock_timestamp(),
      authz_version = authz_version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [fixture.input.tenantId, fixture.input.proxyKeyId],
  );
  assert.equal(changed.rowCount, 1);
}

async function assertBlocked(database: SqlExecutor, writerPid: number, readerPid: number): Promise<void> {
  let blocked = false;
  const deadline = Date.now() + 5000;
  do {
    const observed = await database.query<{ blocked: boolean }>(
      'SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked',
      [writerPid, readerPid],
    );
    blocked = observed.rows[0]?.blocked === true;
    if (!blocked) await delay(10);
  } while (!blocked && Date.now() < deadline);
  assert.equal(blocked, true, 'actual PostgreSQL advisory-fence blocking must be observed');
}

async function advisoryLocks(database: SqlExecutor, pid: number, key: string) {
  return (
    await database.query<{ mode: string; granted: boolean }>(
      `SELECT mode, granted FROM pg_locks
        WHERE locktype = 'advisory' AND pid = $1 AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint = ((hashtextextended($2::text, 0) >> 32) & 4294967295::bigint)
          AND objid::bigint = (hashtextextended($2::text, 0) & 4294967295::bigint)`,
      [pid, key],
    )
  ).rows;
}

async function tryExclusive(database: SaasDatabase, key: string): Promise<boolean> {
  return database.transaction(async (tx) => {
    const result = await tx.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0]?.acquired === true;
  });
}

type BlockedReader = {
  readonly reader: Promise<PreparedRequestEvidenceRecord>;
  readonly readerPid: number;
  readonly writer: Promise<void>;
  readonly release: () => void;
  readonly trace: string[];
  readonly firstKey: string;
  readonly middleKey: string;
  readonly laterKey: string;
};

/** All assertions begin after a real pg_blocking_pids observation, never after a guessed sleep. */
async function withBlockedFenceReader(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  fixture: FixtureWithFences,
  method: DispatchMethod,
  work: (blocked: BlockedReader) => Promise<void>,
): Promise<void> {
  const keys = fixture.fenceBatch.keys;
  const firstKey = keys[0];
  const middleKey = keys[Math.floor(keys.length / 2)];
  const laterKey = keys.at(-1);
  assert.ok(firstKey && middleKey && laterKey);
  assert.equal(new Set([firstKey, middleKey, laterKey]).size, 3);
  const writerReady = deferred<number>();
  const readerReady = deferred<number>();
  const release = deferred<void>();
  const trace: string[] = [];
  const writer = migrator.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [middleKey]);
    const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    assert.ok(pid);
    writerReady.resolve(pid);
    await release.promise;
  });
  writer.catch(writerReady.reject);
  let reader: Promise<PreparedRequestEvidenceRecord> | undefined;
  try {
    const writerPid = await writerReady.promise;
    reader = gateway.transaction(async (tx) => {
      const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      assert.ok(pid);
      readerReady.resolve(pid);
      const observed: SqlExecutor = {
        query<Row>(sql: string, values?: readonly unknown[]) {
          trace.push(sql);
          return tx.query<Row>(sql, values);
        },
      };
      return new SaasPreparedRequestEvidenceService(onExecutor(gateway, observed), fixture.options)[method](
        fixture.evidenceId,
        fixture.input.audit,
      );
    });
    reader.catch(readerReady.reject);
    const readerPid = await readerReady.promise;
    await assertBlocked(migrator, writerPid, readerPid);
    await work({
      reader,
      readerPid,
      writer,
      release: () => release.resolve(),
      trace,
      firstKey,
      middleKey,
      laterKey,
    });
  } finally {
    release.resolve();
    await Promise.allSettled(reader ? [reader, writer] : [writer]);
  }
}

async function assertOrderedPrefix(database: SaasDatabase, blocked: BlockedReader): Promise<void> {
  assert.deepEqual(await advisoryLocks(database, blocked.readerPid, blocked.firstKey), [
    { mode: 'ShareLock', granted: true },
  ]);
  assert.deepEqual(await advisoryLocks(database, blocked.readerPid, blocked.middleKey), [
    { mode: 'ShareLock', granted: false },
  ]);
  assert.deepEqual(await advisoryLocks(database, blocked.readerPid, blocked.laterKey), []);
  assert.equal(await tryExclusive(database, blocked.laterKey), true, 'later key is available on another connection');
  assert.equal(blocked.trace.filter((sql) => sql.includes(FENCE_BATCH_MARKER)).length, 1);
  assert.equal(
    blocked.trace.some((sql) => sql.includes('prepared-evidence:authority-batch')),
    false,
  );
}

test('evidence fixture refuses invalid signed TTLs before touching a database', async () => {
  const inert = {
    query() {
      assert.fail('invalid TTL must fail before any fixture query');
    },
  } as unknown as SaasDatabase;
  for (const evidenceTtlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(evidenceAuthorityFixture(inert, inert, 'byok', { evidenceTtlMs }), assert.AssertionError);
  }
});

test('restricted PG dispatch authority batches retain exact reads, claim effects and both revocation fence directions', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? 'disposable E2E role URLs not configured' : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.close(), gateway.close()]);
  });
  await gateway.verifySchema();
  const role = (
    await gateway.query<{ role: string; superuser: boolean }>(
      'SELECT current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    )
  ).rows[0];
  assert.equal(role?.role, 'model_router_saas_gateway');
  assert.equal(role?.superuser, false);

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(
      `${mode}: exact restricted grants, one post-fence batch, read-only preflight and versioned claim`,
      async () => {
        const fixture = await fixtureWithFences(migrator, gateway, mode);
        const before = await snapshot(migrator, fixture);
        const trace: string[] = [];
        const inspected: SaasDatabase = {
          ...gateway,
          transaction: (work) =>
            gateway.transaction((tx) =>
              work({
                async query<Row>(sql: string, values?: readonly unknown[]) {
                  const result = await tx.query<Row>(sql, values);
                  if (sql.includes('prepared-evidence:authority-batch')) {
                    const facts = result.rows as Array<{ stage: string; facts: Array<Record<string, unknown>> }>;
                    for (const [stage, columns] of [
                      ['project', ['inference_policy_version']],
                      ['project-policy', ['version']],
                      [
                        'key',
                        [
                          'authz_version',
                          'entitlement_authz_version',
                          'supply_profile_authz_version',
                          'model_scope_version',
                        ],
                      ],
                      ['account', ['authz_version']],
                      ['credential', ['authz_version']],
                    ] as const) {
                      const fact = facts.find((row) => row.stage === stage)?.facts[0];
                      assert.ok(fact);
                      for (const column of columns)
                        assert.equal(typeof fact[column], 'string', `${stage}.${column} retains exact pg int8 text`);
                    }
                  }
                  return result;
                },
              }),
            ),
        };
        const measured = new SaasPreparedRequestEvidenceService(
          rollbackEvidenceDatabase(inspected, (sql) => trace.push(sql)),
          fixture.options,
        );
        for (const method of ['preflightForDispatch', 'claimForDispatch'] as const) {
          trace.length = 0;
          const record = await measured[method](fixture.evidenceId, fixture.input.audit, {
            payloadSha256: fixture.input.payloadSha256,
          });
          assert.equal(record.providerId, fixture.input.providerId);
          assert.equal(record.productId, fixture.input.productId);
          assert.equal(record.providerProtocol, fixture.input.providerProtocol);
          assert.equal(record.providerOperation, fixture.input.providerOperation);
          assert.equal(record.status, method === 'claimForDispatch' ? 'claimed' : 'registered');
          const batchIndex = trace.findIndex((sql) => sql.includes('prepared-evidence:authority-batch'));
          assert.equal(trace.filter((sql) => sql.includes('prepared-evidence:authority-batch')).length, 1);
          assert.ok(batchIndex > trace.findLastIndex((sql) => sql.includes('pg_advisory_xact_lock_shared')));
          assert.equal(trace.filter((sql) => sql.includes('prepared-evidence:clock')).length, 1);
          assert.equal(trace.filter((sql) => sql.includes(FENCE_BATCH_MARKER)).length, 1);
          assert.equal(trace.length, method === 'preflightForDispatch' ? 7 : 10);
          const batch = trace[batchIndex];
          assert.ok(batch);
          assert.doesNotMatch(batch, /SELECT \*|FOR (?:UPDATE|SHARE)|ciphertext|key_digest/i);
          for (const stage of [
            'request',
            'attempt',
            method === 'preflightForDispatch' ? 'evidence-preflight' : 'evidence-claim',
          ]) {
            const sql = trace.find((statement) => statement.includes(`prepared-evidence:${stage} */`));
            assert.ok(sql);
            if (method === 'claimForDispatch') assert.match(sql, /FOR UPDATE$/);
            else assert.doesNotMatch(sql, /FOR UPDATE/);
          }
          assert.deepEqual(
            await snapshot(migrator, fixture),
            before,
            'isolated claim observation must really roll back',
          );
          const baselineTrace: string[] = [];
          const baselineKeys: string[] = [];
          const baseline = new SaasPreparedRequestEvidenceService(
            singleFenceBaseline(rollbackEvidenceDatabase(inspected), baselineTrace, baselineKeys),
            fixture.options,
          );
          const baselineRecord = await baseline[method](fixture.evidenceId, fixture.input.audit, {
            payloadSha256: fixture.input.payloadSha256,
          });
          assert.deepEqual({ ...baselineRecord, claimedAt: null }, { ...record, claimedAt: null });
          assert.deepEqual(baselineKeys, fixture.fenceBatch.keys);
          assert.equal(baselineTrace.length, method === 'preflightForDispatch' ? 18 : 21);
          assert.equal(baselineTrace.length - trace.length, fixture.fenceBatch.keys.length - 1);
          assert.equal(baselineTrace.filter((sql) => sql === SINGLE_FENCE_BASELINE_SQL).length, 12);
          assert.equal(baselineTrace.filter((sql) => sql.includes('prepared-evidence:authority-batch')).length, 1);
          assert.deepEqual(await snapshot(migrator, fixture), before, 'original per-key baseline also rolls back');
          t.diagnostic(
            `${mode} ${method}: original per-key baseline ${baselineTrace.length} statements; ordered batch ${trace.length}; identical scoped authority result`,
          );
        }
        await fixture.evidenceService.preflightForDispatch(fixture.evidenceId, fixture.input.audit);
        assert.deepEqual(await snapshot(migrator, fixture), before, 'committed preflight is read-only');
        await fixture.evidenceService.claimForDispatch(fixture.evidenceId, fixture.input.audit);
        const claimed = await snapshot(migrator, fixture);
        assert.equal(claimed.attempt_version, (BigInt(before.attempt_version) + 1n).toString());
        assert.equal(claimed.prepared_evidence_id, fixture.evidenceId);
        assert.equal(claimed.evidence_status, 'claimed');
        assert.equal(claimed.audit_count, '1');
        assert.equal(claimed.resources, before.resources);
        await assert.rejects(
          fixture.evidenceService.claimForDispatch(fixture.evidenceId, fixture.input.audit),
          (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'ALREADY_CLAIMED',
        );
        assert.deepEqual(await snapshot(migrator, fixture), claimed);
      },
    );

    await t.test(`${mode}: ordinal fence acquisition stops at the blocked middle key`, async () => {
      const fixture = await fixtureWithFences(migrator, gateway, mode);
      const before = await snapshot(migrator, fixture);
      await withBlockedFenceReader(migrator, gateway, fixture, 'preflightForDispatch', async (blocked) => {
        await assertOrderedPrefix(migrator, blocked);
        blocked.release();
        await blocked.writer;
        assert.equal((await blocked.reader).status, 'registered');
        assert.equal(blocked.trace.filter((sql) => sql.includes('prepared-evidence:authority-batch')).length, 1);
      });
      assert.deepEqual(
        await snapshot(migrator, fixture),
        before,
        'ordered read-only preflight has no resource effects',
      );
    });

    await t.test(
      `${mode}: a partial fence batch failure rolls back before authority reads or claim effects`,
      async () => {
        const fixture = await fixtureWithFences(migrator, gateway, mode);
        const before = await snapshot(migrator, fixture);
        await withBlockedFenceReader(migrator, gateway, fixture, 'claimForDispatch', async (blocked) => {
          await assertOrderedPrefix(migrator, blocked);
          const refusal = assert.rejects(
            blocked.reader,
            (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'STORAGE_ERROR',
          );
          const cancelled = await gateway.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [
            blocked.readerPid,
          ]);
          assert.equal(cancelled.rows[0]?.cancelled, true, 'same restricted role cancels its own blocked backend');
          await refusal;
          assert.equal(blocked.trace.length, 2, 'only lock hint and the failed fence statement were attempted');
          assert.equal(
            blocked.trace.some((sql) => sql.includes('prepared-evidence:authority-batch')),
            false,
          );
          assert.equal(
            blocked.trace.some((sql) => /prepared-evidence:clock|^(?:INSERT|UPDATE)/.test(sql)),
            false,
          );
          assert.deepEqual(await advisoryLocks(migrator, blocked.readerPid, blocked.firstKey), []);
          assert.equal(await tryExclusive(migrator, blocked.firstKey), true, 'rollback releases the acquired prefix');
          assert.deepEqual(
            await snapshot(migrator, fixture),
            before,
            'failed batch cannot change attempt, evidence, funds or capacity',
          );
        });
      },
    );

    await t.test(
      `${mode}: signed dispatch deadline expires while waiting and the fresh database clock refuses claim`,
      async () => {
        const fixture = await fixtureWithFences(migrator, gateway, mode, { evidenceTtlMs: 10_000 });
        const before = await snapshot(migrator, fixture);
        const signedDeadline = fixture.input.dispatchDeadline;
        const deadline = signedDeadline instanceof Date ? signedDeadline.toISOString() : signedDeadline;
        await withBlockedFenceReader(migrator, gateway, fixture, 'claimForDispatch', async (blocked) => {
          await assertOrderedPrefix(migrator, blocked);
          const stillValid = await migrator.query<{ before_deadline: boolean }>(
            'SELECT clock_timestamp() < $1::timestamptz AS before_deadline',
            [deadline],
          );
          assert.equal(
            stillValid.rows[0]?.before_deadline,
            true,
            'must reach the observed lock wait before the signed deadline',
          );
          let expired = false;
          const observationLimit = Date.now() + 15_000;
          do {
            const clock = await migrator.query<{ expired: boolean }>(
              'SELECT clock_timestamp() > $1::timestamptz AS expired',
              [deadline],
            );
            expired = clock.rows[0]?.expired === true;
            if (!expired) await delay(25);
          } while (!expired && Date.now() < observationLimit);
          assert.equal(expired, true, 'same PostgreSQL clock must cross the unchanged signed deadline');
          const refusal = assert.rejects(
            blocked.reader,
            (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'EXPIRED',
          );
          blocked.release();
          await blocked.writer;
          await refusal;
          assert.equal(blocked.trace.filter((sql) => sql.includes('prepared-evidence:authority-batch')).length, 1);
          assert.equal(
            blocked.trace.some((sql) => /^(?:INSERT|UPDATE)/.test(sql)),
            false,
          );
        });
        await assert.rejects(
          fixture.evidenceService.preflightForDispatch(fixture.evidenceId, fixture.input.audit),
          (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'EXPIRED',
        );
        assert.deepEqual(
          await snapshot(migrator, fixture),
          before,
          'expiry cannot change attempt, evidence, funds or capacity',
        );
      },
    );

    await t.test(
      `${mode}: an acquired reader fence blocks the real key writer, then claim sees the committed revoke`,
      async () => {
        const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
        const readerReady = deferred<number>(),
          writerReady = deferred<number>(),
          release = deferred<void>();
        const before = await snapshot(migrator, fixture);
        const reader = gateway.transaction(async (tx) => {
          const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
          assert.ok(pid);
          const observed: SqlExecutor = {
            async query(sql, values) {
              if (sql.includes('prepared-evidence:authority-batch')) {
                readerReady.resolve(pid);
                await release.promise;
              }
              return tx.query(sql, values);
            },
          };
          return new SaasPreparedRequestEvidenceService(
            onExecutor(gateway, observed),
            fixture.options,
          ).preflightForDispatch(fixture.evidenceId, fixture.input.audit);
        });
        reader.catch(readerReady.reject);
        let writer: Promise<void> | undefined;
        try {
          const readerPid = await readerReady.promise;
          writer = migrator.transaction(async (tx) => {
            const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
            assert.ok(pid);
            writerReady.resolve(pid);
            await revokeKey(tx, fixture);
          });
          writer.catch(writerReady.reject);
          const writerPid = await writerReady.promise;
          await assertBlocked(migrator, readerPid, writerPid);
          release.resolve();
          assert.equal((await reader).status, 'registered');
          await writer;
          await expectAuthorityRefusal(
            fixture.evidenceService.claimForDispatch(fixture.evidenceId, fixture.input.audit),
          );
          assert.deepEqual(
            await snapshot(migrator, fixture),
            before,
            'revoked claim leaves evidence, attempt and resources untouched',
          );
        } finally {
          release.resolve();
          await Promise.allSettled(writer ? [reader, writer] : [reader]);
        }
      },
    );

    await t.test(
      `${mode}: a reader waiting behind the key writer reads the committed revoke in a new batch snapshot`,
      async () => {
        const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
        const writerReady = deferred<number>(),
          readerReady = deferred<number>(),
          release = deferred<void>();
        const before = await snapshot(migrator, fixture);
        const writer = migrator.transaction(async (tx) => {
          await revokeKey(tx, fixture);
          const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
          assert.ok(pid);
          writerReady.resolve(pid);
          await release.promise;
        });
        writer.catch(writerReady.reject);
        let reader: Promise<unknown> | undefined;
        try {
          const writerPid = await writerReady.promise;
          reader = gateway.transaction(async (tx) => {
            const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
            assert.ok(pid);
            readerReady.resolve(pid);
            return new SaasPreparedRequestEvidenceService(
              onExecutor(gateway, tx),
              fixture.options,
            ).preflightForDispatch(fixture.evidenceId, fixture.input.audit);
          });
          reader.catch(readerReady.reject);
          const readerPid = await readerReady.promise;
          await assertBlocked(migrator, writerPid, readerPid);
          const refusal = expectAuthorityRefusal(reader);
          release.resolve();
          await writer;
          await refusal;
          await expectAuthorityRefusal(
            fixture.evidenceService.claimForDispatch(fixture.evidenceId, fixture.input.audit),
          );
          assert.deepEqual(await snapshot(migrator, fixture), before);
        } finally {
          release.resolve();
          await Promise.allSettled(reader ? [writer, reader] : [writer]);
        }
      },
    );
  }
});
