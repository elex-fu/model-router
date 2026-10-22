import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { PreparedSqlStatement, SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresProviderAccountLeaseService,
  type ProviderAccountLease,
} from '../../../src/saas/gateway/provider-account-lease-service.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import type { ProviderCredentialDispatchProof } from '../../../src/saas/supply/types.js';
import { evidenceAuthorityFixture } from '../gateway/prepared-evidence-authority-postgres-fixture.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';

type Fixture = Awaited<ReturnType<typeof evidenceAuthorityFixture>>;
type DispatchFixture = Fixture & { readonly lease: ProviderAccountLease };
type QueryTag = 'identity' | 'fences' | 'pin' | 'core' | 'reset' | 'authority';
type ProofTrace = {
  tags: QueryTag[];
  keys: string[];
  expandedFenceCount: number;
  rows: Partial<Record<QueryTag, number>>;
  prepared: Array<{ name: string; sqlMd5: string; parameterCount: number }>;
};
const FENCE_MARKER = '/* provider-supply:dispatch-read-fence-batch */';
const SINGLE_FENCE_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
const EXCLUSIVE_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';
const HASHES: Readonly<Record<string, QueryTag>> = {
  '79ded5fbd696c58d2fff96a8d53245f41e87d3f85e6a3cc17fc515e6de0d0d86': 'identity',
  ffec43c87347de54d0d81bd31bbfd4772da54b3f3da258db8e48eb42dbed85d7: 'pin',
  '244e911ca85c3dcc71d374649f358938bf0ece4149fba4d7f986c48fe4f424f0': 'core',
  d96f8b458a00f20fa51dc36e912b91260f11b0778e38b82859425f77b7b1dbfe: 'reset',
  '0374a2b4286ea98c47fa9afffef614dad3c77339b085f815f617cf1162b4a534': 'authority',
  fba39ec87efd00b27785c6ca08a2413370b352ff3f106e00ac15e6c4325db5d0: 'authority',
};
const SQL_STATES = new Set([
  '42501',
  '42P01',
  '42703',
  '42883',
  '42601',
  '22023',
  '22P02',
  '23502',
  '23503',
  '23505',
  '23514',
  '25P02',
  '25006',
  '57014',
  '55P03',
  '40001',
  '40P01',
  '55000',
  '08001',
  '08006',
  '57P01',
  '53300',
  'XX000',
]);
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

function sqlState(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = Object.getOwnPropertyDescriptor(current, 'code')?.value;
    if (typeof code === 'string' && SQL_STATES.has(code)) return code;
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return null;
}

/** Keep raw driver/assertion properties, actual proofs and identities out of TAP. */
async function safeCase(phase: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const state = sqlState(error);
    const assertion =
      error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_ASSERTION';
    const safe = new Error(
      `DISPATCH_PROOF_FENCE_PG phase=${phase} code=${assertion ? 'ASSERTION' : 'FAILURE'} sqlState=${state ?? 'none'}`,
    );
    safe.stack = undefined;
    throw safe;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  // Coordination errors are forwarded to each awaited barrier without unhandled rejections.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function canonical(value: unknown): string {
  if (value === null) return '["null"]';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify([typeof value, value]);
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    return JSON.stringify(['number', Object.is(value, -0) ? '-0' : String(value)]);
  }
  if (typeof value === 'bigint') return JSON.stringify(['bigint', value.toString()]);
  if (value instanceof Date) {
    assert.ok(Number.isFinite(value.getTime()));
    return JSON.stringify(['date', value.toISOString()]);
  }
  if (Buffer.isBuffer(value)) return JSON.stringify(['buffer', value.toString('base64')]);
  if (Array.isArray(value)) return '["array",[' + value.map(canonical).join(',') + ']]';
  assert.ok(
    value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
  assert.equal(Object.getOwnPropertySymbols(value).length, 0);
  return (
    '["object",[' +
    Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
        return '[' + JSON.stringify(key) + ',' + canonical(descriptor.value) + ']';
      })
      .join(',') +
    ']]'
  );
}

function expectedKeys(fixture: Fixture): string[] {
  const input = fixture.input;
  assert.equal(input.supplyMode, 'platform');
  assert.equal(input.accountOwnerKind, 'platform');
  assert.equal(input.principalKind, 'member');
  assert.ok(input.poolId);
  return [
    saasAdvisoryKey.tenant(input.tenantId),
    saasAdvisoryKey.project(input.tenantId, input.projectId),
    saasAdvisoryKey.user(input.principalId),
    saasAdvisoryKey.apiKey(input.tenantId, input.projectId, input.proxyKeyId),
    saasAdvisoryKey.platformPool(input.poolId),
    saasAdvisoryKey.supplyProfile(input.tenantId, input.dispatchProfileId),
    saasAdvisoryKey.platformProviderAccount(input.accountId),
    saasAdvisoryKey.platformProviderCredential(input.credentialId),
    saasAdvisoryKey.credentialVersion('platform', input.accountId, input.credentialId, Number(input.credentialVersion)),
    saasAdvisoryKey.platformPool(input.poolId),
    saasAdvisoryKey.supplyProfile(input.tenantId, input.dispatchProfileId),
  ];
}

function keyAt(keys: readonly string[], index: number): string {
  const key = keys[index];
  assert.ok(typeof key === 'string' && key.length > 0);
  return key;
}

function trace(): ProofTrace {
  return { tags: [], keys: [], expandedFenceCount: 0, rows: {}, prepared: [] };
}

/** Every business query uses its original executor and result. Baseline expands only real shared-lock SQL. */
function observedProofDatabase(
  database: SaasDatabase,
  observation: ProofTrace,
  options: {
    readonly started?: ReturnType<typeof deferred<number>>;
    readonly beforeCore?: () => Promise<void>;
    readonly singleFenceBaseline?: boolean;
  } = {},
): SaasDatabase {
  return {
    ...database,
    transaction: (work) =>
      database.transaction(async (tx) => {
        const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        assert.ok(pid);
        options.started?.resolve(pid);
        const run = async <Row>(
          sql: string,
          values?: readonly unknown[],
          statement?: PreparedSqlStatement,
        ): Promise<SqlResult<Row>> => {
          const digest = sha256(sql);
          const tag = sql.includes(FENCE_MARKER) ? 'fences' : HASHES[digest];
          assert.ok(tag, 'only the original fixed dispatch proof family may execute');
          observation.tags.push(tag);
          if (statement) {
            assert.ok(tag === 'core' || tag === 'authority', 'only three fixed proof reads may be named');
            const label =
              tag === 'core'
                ? 'proof-core'
                : digest === 'fba39ec87efd00b27785c6ca08a2413370b352ff3f106e00ac15e6c4325db5d0'
                  ? 'proof-tenant'
                  : 'proof-platform';
            assert.equal(Object.isFrozen(statement), true);
            assert.equal(statement.name, `mr_${label}_${createHash('sha256').update(sql).digest('base64url')}`);
            assert.ok(Buffer.byteLength(statement.name, 'utf8') <= 63);
            observation.prepared.push({
              name: statement.name,
              sqlMd5: createHash('md5').update(sql).digest('hex'),
              parameterCount: values?.length ?? 0,
            });
          }
          if (tag === 'core') await options.beforeCore?.();
          let result: SqlResult<Row>;
          if (tag === 'fences') {
            assert.equal(digest, '8d56f265e1f7ef261d5f5dc1ee2c79922f3a58db339bf8e21383c53bf06ead53');
            assert.equal(values?.length, 1);
            const keys = values?.[0];
            assert.ok(Array.isArray(keys) && keys.every((key) => typeof key === 'string'));
            observation.keys.push(...keys);
            if (options.singleFenceBaseline) {
              const rows: Row[] = [];
              for (const key of keys) {
                rows.push(...(await tx.query<Row>(SINGLE_FENCE_SQL, [key])).rows);
                observation.expandedFenceCount += 1;
              }
              result = { rows, rowCount: rows.length };
            } else result = await tx.query<Row>(sql, values);
          } else if (statement) {
            assert.ok(tx.queryPrepared);
            result = await tx.queryPrepared<Row>(statement, values);
          } else result = await tx.query<Row>(sql, values);
          observation.rows[tag] = result.rows.length;
          return result;
        };
        const observed: SqlExecutor = { ...tx, query: (sql, values) => run(sql, values) };
        if (typeof tx.queryPrepared === 'function')
          observed.queryPrepared = (statement, values) => run(statement.text, values, statement);
        assert.equal(typeof observed.queryPrepared, typeof tx.queryPrepared);
        return work(observed);
      }),
  };
}

function assertProof(
  fixture: Fixture,
  proof: ProviderCredentialDispatchProof | null,
): asserts proof is ProviderCredentialDispatchProof {
  assert.ok(proof);
  const { input, evidenceId } = fixture;
  assert.ok(
    proof.evidence.evidenceId === evidenceId &&
      proof.evidence.tenantId === input.tenantId &&
      proof.evidence.requestId === input.requestId &&
      proof.evidence.attemptId === input.attemptId &&
      proof.evidence.accountId === input.accountId &&
      proof.evidence.credentialId === input.credentialId &&
      proof.evidence.status === 'claimed' &&
      proof.attempt.preparedEvidenceId === evidenceId &&
      proof.attempt.dispatchState === 'dispatching' &&
      proof.attempt.resultState === 'pending' &&
      proof.attempt.responseStarted === false &&
      proof.account.id === input.accountId &&
      proof.credential.id === input.credentialId &&
      proof.profile.id === input.dispatchProfileId &&
      proof.pool?.id === input.poolId &&
      proof.poolMember?.accountId === input.accountId &&
      proof.poolGrant?.tenantId === input.tenantId &&
      proof.claimAudit.targetId === evidenceId,
  );
}

async function verifyLease(
  observer: SqlExecutor,
  fixture: DispatchFixture,
  status: 'held' | 'released',
): Promise<void> {
  const input = fixture.input;
  const ownerKind = input.accountOwnerKind;
  assert.ok(ownerKind === 'tenant' || ownerKind === 'platform');
  const result = await observer.query<{ status: string; unexpired: boolean }>(
    `SELECT status, lease_expires_at > clock_timestamp() AS unexpired
       FROM saas_provider_account_leases
      WHERE tenant_id=$1::uuid AND owner_kind=$6::text AND owner_tenant_id IS NOT DISTINCT FROM $7::uuid
        AND account_id=$2::text AND upstream_id=$3::text AND attempt_id=$4::text AND fencing_token=$5::bigint`,
    [
      input.tenantId,
      input.accountId,
      input.upstreamId,
      input.attemptId,
      fixture.lease.fencingToken,
      ownerKind,
      ownerKind === 'tenant' ? input.tenantId : null,
    ],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.status, status);
  if (status === 'held') assert.equal(result.rows[0]?.unexpired, true);
}

/** Setup commits its actual preparation hold; the owned disposable DB retains it until teardown. */
async function withDispatchFixture(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  work: (fixture: DispatchFixture) => Promise<void>,
  mode: 'byok' | 'platform' = 'platform',
): Promise<void> {
  const fixture = await evidenceAuthorityFixture(migrator, gateway, mode);
  const { input, original, evidenceService, evidenceId } = fixture;
  let lease: ProviderAccountLease | undefined;
  let primary: unknown;
  let cleanup: unknown;
  try {
    assert.notEqual(input.attemptId, original.sent.id);
    assert.notEqual(input.requestId, original.sent.requestId);
    const preflight = await evidenceService.preflightForDispatch(evidenceId, input.audit, {
      payloadSha256: input.payloadSha256,
    });
    assert.equal(preflight.status, 'registered');
    const acquired = await new PostgresProviderAccountLeaseService({
      database: gateway,
      maxConcurrency: 2,
      leaseTtlMs: 30000,
    }).acquire({
      tenantId: input.tenantId,
      accountId: input.accountId,
      upstreamId: input.upstreamId,
      attemptId: input.attemptId,
      evidence: preflight,
    });
    assert.ok(acquired);
    lease = acquired;
    const claimed = await evidenceService.claimForDispatch(evidenceId, input.audit, {
      payloadSha256: input.payloadSha256,
    });
    assert.equal(claimed.status, 'claimed');
    const attempt = await original.metering.getAttempt(input.tenantId, input.requestId, input.attemptId);
    assert.ok(
      attempt &&
        attempt.preparedEvidenceId === evidenceId &&
        attempt.dispatchAuthorityState === 'bound' &&
        attempt.dispatchState === 'not_sent' &&
        attempt.resultState === 'pending' &&
        attempt.responseStarted === false,
    );
    const dispatching = await original.metering.transitionAttempt({
      tenantId: input.tenantId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      expectedDispatchState: 'not_sent',
      expectedResultState: 'pending',
      expectedResponseStarted: false,
      expectedStateVersion: attempt.stateVersion,
      dispatchState: 'dispatching',
    });
    assert.equal(dispatching.dispatchState, 'dispatching');
    await work({ ...fixture, lease });
  } catch (error) {
    primary = error;
  } finally {
    if (lease) {
      try {
        await lease.release();
        await verifyLease(migrator, { ...fixture, lease }, 'released');
      } catch (error) {
        cleanup = error;
      }
    }
  }
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

const STATE_TABLES = [
  ['requests', 'saas_requests'],
  ['attempts', 'saas_attempts'],
  ['preparedEvidence', 'saas_prepared_request_evidence'],
  ['leases', 'saas_provider_account_leases'],
  ['idempotency', 'saas_idempotency_records'],
  ['outbox', 'saas_request_admission_outbox'],
  ['audit', 'saas_audit_events'],
  ['customerSnapshots', 'saas_request_customer_price_snapshots'],
  ['supplierSnapshots', 'saas_attempt_supplier_cost_snapshots'],
  ['holds', 'saas_billing_reservations'],
  ['wallets', 'saas_wallets'],
  ['ledgerTransactions', 'saas_ledger_transactions'],
  ['ledgerEntries', 'saas_ledger_entries'],
  ['usage', 'saas_usage_events'],
  ['settlements', 'saas_usage_settlements'],
  ['capacity', 'saas_gateway_capacity_reservations'],
] as const;
async function stateDigest(observer: SqlExecutor, fixture: Fixture): Promise<string> {
  const tables = [
    ...STATE_TABLES.map(([scope, table]) => ({
      scope: String(scope),
      table: String(table),
      where: 'tenant_id=$1::uuid',
    })),
    { scope: 'rateCounters', table: 'saas_provider_account_rate_counters', where: 'account_id=$2::text' },
  ];
  const sql = tables
    .map(
      ({ scope, table, where }) =>
        `SELECT '${scope}' AS scope, count(*)::text AS records,
       md5(COALESCE(string_agg(to_jsonb(r)::text, E'\\n' ORDER BY to_jsonb(r)::text), '')) AS digest
       FROM (SELECT * FROM ${table} WHERE ${where}) r`,
    )
    .join('\nUNION ALL\n');
  const result = await observer.query<{ scope: string; records: string; digest: string }>(sql, [
    fixture.input.tenantId,
    fixture.input.accountId,
  ]);
  assert.equal(result.rows.length, 17);
  assert.equal(new Set(result.rows.map((row) => row.scope)).size, 17);
  for (const row of result.rows) {
    assert.ok(tables.some((table) => table.scope === row.scope));
    assert.match(row.records, /^\d+$/);
    assert.match(row.digest, /^[a-f0-9]{32}$/);
  }
  return sha256(
    canonical(result.rows.sort((left, right) => (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0))),
  );
}

async function assertBlocked(observer: SqlExecutor, blocker: number, reader: number): Promise<void> {
  let blocked = false;
  const deadline = Date.now() + 5000;
  do {
    blocked =
      (
        await observer.query<{ blocked: boolean }>('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked', [
          blocker,
          reader,
        ])
      ).rows[0]?.blocked === true;
    if (!blocked) await delay(10);
  } while (!blocked && Date.now() < deadline);
  assert.equal(blocked, true, 'observe the actual PostgreSQL blocker before asserting order');
}
async function advisoryLocks(observer: SqlExecutor, pid: number, key: string) {
  return (
    await observer.query<{ mode: string; granted: boolean }>(
      `SELECT mode, granted FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND objsubid=1
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid::bigint=((hashtextextended($2::text,0)>>32)&4294967295::bigint)
      AND objid::bigint=(hashtextextended($2::text,0)&4294967295::bigint)`,
      [pid, key],
    )
  ).rows;
}
async function tryExclusive(controlPlane: SaasDatabase, key: string): Promise<boolean> {
  return controlPlane.transaction(
    async (tx) =>
      (
        await tx.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1::text,0)) AS acquired',
          [key],
        )
      ).rows[0]?.acquired === true,
  );
}

function exclusiveOrderProbe(controlPlane: SaasDatabase, key: string) {
  const ready = deferred<number>(),
    release = deferred<void>();
  const done = controlPlane.transaction(async (tx) => {
    await tx.query(EXCLUSIVE_FENCE_SQL, [key]);
    const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    assert.ok(pid);
    ready.resolve(pid);
    await release.promise;
  });
  done.catch(ready.reject);
  return { ready: ready.promise, done, release: () => release.resolve() };
}

/** Normal CP lifecycle API/exclusive fences perform every business write; the seam only pauses its final commit. */
function normalRevoker(controlPlane: SaasDatabase, fixture: Fixture, kind: 'account' | 'credential') {
  const started = deferred<number>(),
    written = deferred<number>(),
    release = deferred<void>();
  const auditRequestId = randomUUID();
  const accountKey = saasAdvisoryKey.platformProviderAccount(fixture.input.accountId);
  const database: SaasDatabase = {
    ...controlPlane,
    transaction: (work) =>
      controlPlane.transaction(async (tx) => {
        const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        assert.ok(pid);
        let mutated = false;
        const observed: SqlExecutor = {
          ...tx,
          async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
            if (sql === EXCLUSIVE_FENCE_SQL && values?.[0] === accountKey) started.resolve(pid);
            const result = await tx.query<Row>(sql, values);
            if (/^\s*UPDATE saas_platform_provider_(?:accounts|credentials)\b/.test(sql)) mutated = true;
            return result;
          },
        };
        const value = await work(observed);
        // Credential lookup transactions complete normally; only the real lifecycle transaction pauses.
        if (mutated) {
          written.resolve(pid);
          await release.promise;
        }
        return value;
      }),
  };
  const service = new ProviderSupplyService(database, {
    deployment: 'dispatch-proof-fence-pg',
    environment: 'test',
    kmsKeyId: 'dispatch-proof-fence-unused-kms',
  });
  const audit = {
    actorUserId: fixture.original.userId,
    entryPoint: 'dispatch-proof-fence-pg',
    requestId: auditRequestId,
  };
  const done =
    kind === 'account'
      ? service.revokePlatformProviderAccount({
          accountId: fixture.input.accountId,
          expectedAuthzVersion: Number(fixture.input.accountAuthzVersion),
          audit,
        })
      : service.revokePlatformProviderCredential({
          credentialId: fixture.input.credentialId,
          expectedAuthzVersion: Number(fixture.input.credentialAuthzVersion),
          audit,
        });
  done.catch((error) => {
    started.reject(error);
    written.reject(error);
  });
  return { started: started.promise, written: written.promise, done, auditRequestId, release: () => release.resolve() };
}

async function assertRevoked(
  observer: SqlExecutor,
  fixture: Fixture,
  kind: 'account' | 'credential',
  requestId: string,
) {
  const result = await observer.query<{
    account_status: string;
    credential_status: string;
    version_status: string;
    audits: string;
  }>(
    `SELECT a.status AS account_status,c.status AS credential_status,v.status AS version_status,
      (SELECT count(*)::text FROM saas_audit_events WHERE request_id=$4::text AND action=$5::text) AS audits
      FROM saas_platform_provider_accounts a JOIN saas_platform_provider_credentials c ON c.account_id=a.id
      JOIN saas_platform_provider_credential_versions v ON v.account_id=a.id AND v.credential_id=c.id
      WHERE a.id=$1::text AND c.id=$2::text AND v.version=$3::bigint`,
    [
      fixture.input.accountId,
      fixture.input.credentialId,
      fixture.input.credentialVersion,
      requestId,
      `provider_supply.${kind}.revoked`,
    ],
  );
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows, [
    {
      account_status: kind === 'account' ? 'revoked' : 'active',
      credential_status: 'revoked',
      version_status: 'revoked',
      audits: '1',
    },
  ]);
}

function assertBoundBatch(fixture: Fixture, observation: ProofTrace): void {
  assert.equal(observation.keys.length, 11);
  // Compare full actual key values only in heap; failure output contains hashes, not account/key IDs.
  assert.equal(sha256(canonical(observation.keys)), sha256(canonical(expectedKeys(fixture))));
  assert.equal(observation.keys[4] === observation.keys[9], true);
  assert.equal(observation.keys[5] === observation.keys[10], true);
}
function assertSuccessfulRead(
  fixture: Fixture,
  observation: ProofTrace,
  proof: ProviderCredentialDispatchProof | null,
): void {
  assertProof(fixture, proof);
  assertBoundBatch(fixture, observation);
  assert.deepEqual(observation.tags, ['identity', 'fences', 'pin', 'core', 'reset', 'authority']);
  assert.equal(observation.rows.fences, 11);
  assert.equal(observation.rows.core, 1);
  assert.equal(observation.rows.authority, 1);
}

// Independent root: the existing prepared-evidence PG gate and all of its assertions remain untouched.
test('restricted PG dispatch proof batches preserve ordered shared fences and normal CP revocation', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? 'disposable E2E role URLs not configured' : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const controlPlane = createSaasDatabase({ connectionString: urls[1], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4, preparedStatements: 'off' });
  const native = createSaasDatabase({
    connectionString: urls[2],
    max: 1,
    idleTimeoutMillis: 0,
    preparedStatements: 'native',
    env: {},
  });
  t.after(() =>
    safeCase('close', async () => {
      await Promise.all([migrator.close(), controlPlane.close(), gateway.close(), native.close()]);
    }),
  );
  await safeCase('readiness', async () => {
    await gateway.verifySchema();
    for (const [database, role] of [
      [migrator, 'model_router_saas_migrator'],
      [controlPlane, 'model_router_saas_control_plane'],
      [gateway, 'model_router_saas_gateway'],
      [native, 'model_router_saas_gateway'],
    ] as const) {
      const current = (
        await database.query<{ role: string; superuser: boolean }>(
          'SELECT current_user AS role,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0];
      assert.equal(current?.role, role);
      assert.equal(current?.superuser, false);
    }
    await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(native, 'gateway');
  });

  await t.test(
    'native wire prepares only three fixed proof reads and every warm execution reads current authority',
    () =>
      safeCase('native-proof-wire', async () => {
        assert.equal(typeof gateway.queryPrepared, 'undefined');
        assert.equal(typeof native.queryPrepared, 'function');
        const prepared = () =>
          native.query<{
            name: string;
            from_sql: boolean;
            sql_md5: string;
            parameter_count: number;
            generic_plans: string;
            custom_plans: string;
          }>(`SELECT name, from_sql, md5(statement) AS sql_md5,
           cardinality(parameter_types) AS parameter_count,
           generic_plans::text AS generic_plans, custom_plans::text AS custom_plans
         FROM pg_prepared_statements ORDER BY name`);
        assert.deepEqual((await prepared()).rows, []);
        const joinDefault = (
          await native.query<{ setting: string }>("SELECT current_setting('join_collapse_limit') AS setting")
        ).rows[0]?.setting;
        assert.ok(joinDefault);
        const calls: ProofTrace['prepared'] = [];
        for (const mode of ['byok', 'platform'] as const) {
          await withDispatchFixture(
            migrator,
            gateway,
            async (fixture) => {
              const before = await stateDigest(migrator, fixture);
              const anonymous = trace();
              const baseline = await new PostgresProviderSupplyRepository(
                observedProofDatabase(gateway, anonymous),
              ).readDispatchProof(fixture.evidenceId);
              assert.ok(baseline);
              assert.equal(anonymous.prepared.length, 0);
              assert.equal(baseline.account.ownerKind, mode === 'byok' ? 'tenant' : 'platform');
              for (let round = 0; round < 3; round += 1) {
                const observation = trace();
                const proof = await new PostgresProviderSupplyRepository(
                  observedProofDatabase(native, observation),
                ).readDispatchProof(fixture.evidenceId);
                assert.ok(proof);
                assert.equal(sha256(canonical(proof)), sha256(canonical(baseline)));
                assert.deepEqual(observation.tags, ['identity', 'fences', 'pin', 'core', 'reset', 'authority']);
                assert.equal(observation.rows.fences, mode === 'byok' ? 9 : 11);
                assert.equal(observation.rows.core, 1);
                assert.equal(observation.rows.authority, 1);
                assert.equal(observation.prepared.length, 2);
                calls.push(...observation.prepared);
                assert.equal(
                  (await native.query<{ setting: string }>("SELECT current_setting('join_collapse_limit') AS setting"))
                    .rows[0]?.setting,
                  joinDefault,
                );
              }
              // Warm named statements must execute again after a normal committed CP mutation.
              const service = new ProviderSupplyService(controlPlane, {
                deployment: 'dispatch-proof-native-pg',
                environment: 'test',
                kmsKeyId: 'unused-kms',
              });
              const changed = await service.revokeProviderCredential({
                credentialId: fixture.input.credentialId,
                expectedAuthzVersion: Number(fixture.input.credentialAuthzVersion),
              });
              assert.equal(changed.status, 'revoked');
              const refused = trace();
              assert.equal(
                await new PostgresProviderSupplyRepository(observedProofDatabase(native, refused)).readDispatchProof(
                  fixture.evidenceId,
                ),
                null,
              );
              assert.deepEqual(refused.tags, ['identity', 'fences', 'pin', 'core', 'reset', 'authority']);
              assert.equal(refused.rows.core, 1);
              assert.equal(refused.rows.authority, 0);
              assert.equal(refused.prepared.length, 2);
              calls.push(...refused.prepared);
              assert.equal(await stateDigest(migrator, fixture), before);
            },
            mode,
          );
        }
        const rows = (await prepared()).rows;
        assert.equal(rows.length, 3, 'only core, tenant authority and platform authority use this owned connection');
        for (const row of rows) {
          assert.match(row.name, /^mr_proof-(?:core|tenant|platform)_[A-Za-z0-9_-]{43}$/);
          assert.equal(row.from_sql, false, 'actual extended-protocol Parse, never SQL PREPARE');
          const executions = calls.filter((call) => call.name === row.name);
          assert.ok(executions.length > 0);
          assert.ok(
            executions.every((call) => call.sqlMd5 === row.sql_md5 && call.parameterCount === row.parameter_count),
          );
          assert.equal(
            BigInt(row.generic_plans) + BigInt(row.custom_plans),
            BigInt(executions.length),
            'every repeated or revoked-source call executes a new Bind/Execute',
          );
        }
        assert.equal(calls.length, 16);
        assert.equal(
          (await native.query<{ setting: string }>("SELECT current_setting('join_collapse_limit') AS setting")).rows[0]
            ?.setting,
          joinDefault,
        );
      }),
  );

  await t.test('one real six-statement proof equals the original per-key baseline including the sealed envelope', () =>
    safeCase('baseline-equivalence', () =>
      withDispatchFixture(migrator, gateway, async (fixture) => {
        const before = await stateDigest(migrator, fixture);
        await verifyLease(migrator, fixture, 'held');
        const batched = trace(),
          individual = trace();
        const proof = await new PostgresProviderSupplyRepository(
          observedProofDatabase(gateway, batched),
        ).readDispatchProof(fixture.evidenceId);
        assertSuccessfulRead(fixture, batched, proof);
        const baseline = await new PostgresProviderSupplyRepository(
          observedProofDatabase(gateway, individual, { singleFenceBaseline: true }),
        ).readDispatchProof(fixture.evidenceId);
        assertSuccessfulRead(fixture, individual, baseline);
        assert.equal(individual.expandedFenceCount, 11);
        assert.equal(individual.tags.length + individual.expandedFenceCount - 1, 16);
        // Full proofs, envelope fields and canonical bytes remain in heap; persist/print only test counts.
        assert.equal(sha256(canonical(proof)), sha256(canonical(baseline)));
        assert.equal(await stateDigest(migrator, fixture), before);
        await verifyLease(migrator, fixture, 'held');
      }),
    ),
  );

  for (const point of [
    { label: 'first-unique', index: 0 },
    { label: 'middle-unique', index: 6 },
    { label: 'last-unique', index: 8 },
  ] as const) {
    await t.test(`${point.label}: actual blocking stops before each subsequent unique lock`, () =>
      safeCase(point.label, () =>
        withDispatchFixture(migrator, gateway, async (fixture) => {
          const keys = expectedKeys(fixture),
            target = keys[point.index];
          assert.ok(target);
          const before = await stateDigest(migrator, fixture);
          const probe = exclusiveOrderProbe(controlPlane, target);
          const started = deferred<number>(),
            observation = trace();
          let reader: Promise<ProviderCredentialDispatchProof | null> | undefined;
          try {
            const blockerPid = await probe.ready;
            reader = new PostgresProviderSupplyRepository(
              observedProofDatabase(gateway, observation, { started }),
            ).readDispatchProof(fixture.evidenceId);
            reader.catch(started.reject);
            const readerPid = await started.promise;
            await assertBlocked(migrator, blockerPid, readerPid);
            assertBoundBatch(fixture, observation);
            assert.deepEqual(observation.tags, ['identity', 'fences']);
            for (const key of new Set(keys.slice(0, point.index))) {
              assert.deepEqual(await advisoryLocks(migrator, readerPid, key), [{ mode: 'ShareLock', granted: true }]);
            }
            assert.deepEqual(await advisoryLocks(migrator, readerPid, target), [{ mode: 'ShareLock', granted: false }]);
            const beforeKeys = new Set(keys.slice(0, point.index));
            const laterUnique = keys.slice(point.index + 1).find((key) => key !== target && !beforeKeys.has(key));
            if (laterUnique) {
              assert.deepEqual(await advisoryLocks(migrator, readerPid, laterUnique), []);
              assert.equal(await tryExclusive(controlPlane, laterUnique), true);
            } else {
              assert.equal(point.index, 8, 'only version is the final unique key; the tail repeats existing locks');
              assert.equal(new Set(keys.slice(0, point.index + 1)).size, new Set(keys).size);
            }
            probe.release();
            await probe.done;
            assertSuccessfulRead(fixture, observation, await reader);
            assert.equal(await stateDigest(migrator, fixture), before);
            await verifyLease(migrator, fixture, 'held');
          } finally {
            probe.release();
            await Promise.allSettled(reader ? [reader, probe.done] : [probe.done]);
          }
        }),
      ),
    );
  }

  await t.test('cancelling an actual middle-key wait rolls back its acquired prefix without reading authority', () =>
    safeCase('cancel-middle', () =>
      withDispatchFixture(migrator, gateway, async (fixture) => {
        const keys = expectedKeys(fixture);
        const before = await stateDigest(migrator, fixture);
        const probe = exclusiveOrderProbe(controlPlane, keyAt(keys, 6));
        const started = deferred<number>(),
          observation = trace();
        let reader: Promise<ProviderCredentialDispatchProof | null> | undefined;
        try {
          const blockerPid = await probe.ready;
          reader = new PostgresProviderSupplyRepository(
            observedProofDatabase(gateway, observation, { started }),
          ).readDispatchProof(fixture.evidenceId);
          reader.catch(started.reject);
          const readerPid = await started.promise;
          await assertBlocked(migrator, blockerPid, readerPid);
          assertBoundBatch(fixture, observation);
          assert.deepEqual(await advisoryLocks(migrator, readerPid, keyAt(keys, 0)), [
            { mode: 'ShareLock', granted: true },
          ]);
          const refused = reader.then(
            () => assert.fail('the cancelled real reader must fail'),
            (error: unknown) => {
              assert.equal(sqlState(error), '57014');
            },
          );
          const cancelled = await gateway.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [
            readerPid,
          ]);
          assert.equal(cancelled.rows[0]?.cancelled, true);
          await refused;
          assert.deepEqual(observation.tags, ['identity', 'fences']);
          assert.deepEqual(await advisoryLocks(migrator, readerPid, keyAt(keys, 0)), []);
          assert.equal(await tryExclusive(controlPlane, keyAt(keys, 0)), true);
          assert.equal(await stateDigest(migrator, fixture), before);
          await verifyLease(migrator, fixture, 'held');
        } finally {
          probe.release();
          await Promise.allSettled(reader ? [reader, probe.done] : [probe.done]);
        }
      }),
    ),
  );

  for (const kind of ['account', 'credential'] as const) {
    await t.test(`normal CP ${kind} revoke commits during the wait and the fresh proof refuses`, () =>
      safeCase(`writer-before-${kind}`, () =>
        withDispatchFixture(migrator, gateway, async (fixture) => {
          const before = await stateDigest(migrator, fixture);
          const writer = normalRevoker(controlPlane, fixture, kind);
          const started = deferred<number>(),
            observation = trace();
          let reader: Promise<ProviderCredentialDispatchProof | null> | undefined;
          try {
            const writerPid = await writer.written;
            reader = new PostgresProviderSupplyRepository(
              observedProofDatabase(gateway, observation, { started }),
            ).readDispatchProof(fixture.evidenceId);
            reader.catch(started.reject);
            const readerPid = await started.promise;
            await assertBlocked(migrator, writerPid, readerPid);
            assertBoundBatch(fixture, observation);
            assert.deepEqual(observation.tags, ['identity', 'fences']);
            const keys = expectedKeys(fixture);
            assert.deepEqual(await advisoryLocks(migrator, readerPid, keyAt(keys, 0)), [
              { mode: 'ShareLock', granted: true },
            ]);
            assert.deepEqual(await advisoryLocks(migrator, readerPid, keyAt(keys, 6)), [
              { mode: 'ShareLock', granted: false },
            ]);
            assert.deepEqual(await advisoryLocks(migrator, readerPid, keyAt(keys, 7)), []);
            writer.release();
            const changed = await writer.done;
            assert.equal(changed.status, 'revoked');
            assert.equal(await reader, null);
            assert.deepEqual(observation.tags, ['identity', 'fences', 'pin', 'core', 'reset', 'authority']);
            assert.equal(observation.rows.core, 1);
            assert.equal(observation.rows.authority, 0);
            await assertRevoked(migrator, fixture, kind, writer.auditRequestId);
            assert.equal(await stateDigest(migrator, fixture), before);
            await verifyLease(migrator, fixture, 'held');
          } finally {
            writer.release();
            await Promise.allSettled(reader ? [reader, writer.done] : [writer.done]);
          }
        }),
      ),
    );
  }

  await t.test('held reader shared fences block the normal CP writer until the complete public read commits', () =>
    safeCase('reader-before-writer', () =>
      withDispatchFixture(migrator, gateway, async (fixture) => {
        const before = await stateDigest(migrator, fixture);
        const started = deferred<number>(),
          coreReady = deferred<void>(),
          releaseCore = deferred<void>();
        const observation = trace();
        const reader = new PostgresProviderSupplyRepository(
          observedProofDatabase(gateway, observation, {
            started,
            beforeCore: async () => {
              coreReady.resolve();
              await releaseCore.promise;
            },
          }),
        ).readDispatchProof(fixture.evidenceId);
        reader.catch((error) => {
          started.reject(error);
          coreReady.reject(error);
        });
        let writer: ReturnType<typeof normalRevoker> | undefined;
        try {
          const readerPid = await started.promise;
          await coreReady.promise;
          assertBoundBatch(fixture, observation);
          assert.equal(observation.rows.fences, 11);
          assert.equal(observation.rows.core, undefined);
          writer = normalRevoker(controlPlane, fixture, 'account');
          const writerPid = await writer.started;
          await assertBlocked(migrator, readerPid, writerPid);
          const accountKey = keyAt(expectedKeys(fixture), 6);
          assert.deepEqual(await advisoryLocks(migrator, readerPid, accountKey), [
            { mode: 'ShareLock', granted: true },
          ]);
          assert.deepEqual(await advisoryLocks(migrator, writerPid, accountKey), [
            { mode: 'ExclusiveLock', granted: false },
          ]);
          releaseCore.resolve();
          assertSuccessfulRead(fixture, observation, await reader);
          // The public read promise resolves only after its real gateway COMMIT.
          await writer.written;
          writer.release();
          await writer.done;
          await assertRevoked(migrator, fixture, 'account', writer.auditRequestId);
          const refused = trace();
          assert.equal(
            await new PostgresProviderSupplyRepository(observedProofDatabase(gateway, refused)).readDispatchProof(
              fixture.evidenceId,
            ),
            null,
          );
          assertBoundBatch(fixture, refused);
          assert.equal(refused.rows.core, 1);
          assert.equal(refused.rows.authority, 0);
          assert.equal(await stateDigest(migrator, fixture), before);
          await verifyLease(migrator, fixture, 'held');
        } finally {
          releaseCore.resolve();
          writer?.release();
          await Promise.allSettled(writer ? [reader, writer.done] : [reader]);
        }
      }),
    ),
  );
});
