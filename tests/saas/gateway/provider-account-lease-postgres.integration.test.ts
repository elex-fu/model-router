import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SaasDatabaseClient, SaasDatabasePool, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresProviderAccountLeaseService,
  ProviderAccountLeaseError,
  type ProviderAccountLease,
} from '../../../src/saas/gateway/provider-account-lease-service.js';
import type { PreparedEvidenceLeaseRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';

const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleUrls = {
  migrator: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL?.trim(),
  control_plane: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL?.trim(),
  gateway: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim(),
};
const anyConfigured = Object.values(roleUrls).some(Boolean);
type SupplyMode = 'byok' | 'platform';

// Same disposable target contract as the commercial HTTP/prelock gates. The
// designated CI service is authorized; a user's ordinary local 5432 is not.
function assertDisposableRoleTargets(): Record<keyof typeof roleUrls, string> {
  let target: string | undefined;
  const validated = {} as Record<keyof typeof roleUrls, string>;
  for (const role of Object.keys(roleUrls) as Array<keyof typeof roleUrls>) {
    const value = roleUrls[role];
    assert.ok(value, `the disposable gateway E2E ${role} URL is required`);
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`the disposable gateway E2E ${role} URL must be a valid PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'the test target must be PostgreSQL');
    assert.equal(decodeURIComponent(parsed.username), `model_router_saas_${role}`);
    assert.equal(parsed.hash, '', 'database URL fragments are not supported');
    assert.equal(parsed.search, '', 'database URLs must not contain connection overrides');
    const hostname = parsed.hostname.toLowerCase();
    const port = Number(parsed.port);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const ciTarget = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const localTarget = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port) &&
      Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ciTarget || localTarget,
      'use the designated CI service or a disposable model_router_saas_ci/model_router_test_* loopback database on an explicit nondefault port');
    const currentTarget = `${hostname}:${port}/${database}`;
    target ??= currentTarget;
    assert.equal(currentTarget, target, 'all three roles must use the same disposable database');
    validated[role] = value;
  }
  return validated;
}

function clientExecutor(client: PoolClient): SaasDatabaseClient {
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    release: (error) => client.release(error),
  };
}

function databasePool(pool: Pool, repeatableReadDefault = false): SaasDatabasePool {
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await pool.query(sql, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    async connect() {
      const client = await pool.connect();
      try {
        if (repeatableReadDefault) {
          await client.query("SET SESSION default_transaction_isolation TO 'repeatable read'");
        }
        return clientExecutor(client);
      } catch (error) { client.release(true); throw error; }
    },
    end: () => pool.end(),
  };
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its bounded deadline`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function pid(executor: SqlExecutor): Promise<number> {
  const result = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.pid;
}

// Prove contention in PostgreSQL's actual lock manager, not via a sleep or a
// synthetic executor. The single-bigint namespace and BOTH PIDs must match.
async function waitForFence(observer: SqlExecutor, waiterPid: number, holderPid: number, key: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks waiter JOIN pg_locks holder
           USING (locktype, database, classid, objid, objsubid)
          WHERE waiter.locktype = 'advisory' AND waiter.pid = $1 AND holder.pid = $2
            AND NOT waiter.granted AND holder.granted
            AND waiter.mode = 'ExclusiveLock' AND holder.mode = 'ExclusiveLock'
            AND holder.objsubid = 1
            AND holder.classid = ((hashtextextended($3::text, 0) >> 32) & 4294967295)::oid
            AND holder.objid = (hashtextextended($3::text, 0) & 4294967295)::oid
       ) AS waiting`, [waiterPid, holderPid, key],
    );
    if (result.rows[0]?.waiting === true) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('the real matching account fence did not block before the deadline');
}

async function withControlTransaction<T>(
  pool: Pool,
  work: (client: PoolClient, commit: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    active = true;
    return await work(client, async () => { await client.query('COMMIT'); active = false; });
  } finally {
    if (active) {
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
    }
    client.release(discard);
  }
}

interface Fixture {
  readonly tenantIds: readonly [string, string];
  readonly accountId: string;
}

// Seed only through the schema owner, preserving every installed guard. No
// grants, DDL, migration/bootstrap reset, credential, network or provider call.
// Fixture facts remain until the external owner disposes of the test database.
async function seedFixture(seed: SaasDatabase): Promise<Fixture> {
  const fixture: Fixture = { tenantIds: [randomUUID(), randomUUID()], accountId: `lease-account:一:${randomUUID()}` };
  const providerId = `lease-provider-${randomUUID()}`;
  const productId = `lease-product-${randomUUID()}`;
  const rightsIds = { byok: `lease-rights-${randomUUID()}`, platform: `lease-rights-${randomUUID()}` };
  await seed.transaction(async (tx) => {
    for (const tenantId of fixture.tenantIds) {
      const inserted = await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)',
        [tenantId, `lease-${tenantId}`]);
      assert.equal(inserted.rowCount, 1);
    }
    assert.equal((await tx.query(
      'INSERT INTO saas_provider_products (provider_id, product_id, display_name) VALUES ($1, $2, $3)',
      [providerId, productId, 'Lease integration fixture'],
    )).rowCount, 1);
    for (const mode of ['byok', 'platform'] as const) {
      assert.equal((await tx.query(
        `INSERT INTO saas_provider_rights
           (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
            model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
         VALUES ($1, 1, $2, $3, 'api-key', $4, 'lease-test', 'inference',
                 ARRAY['lease-test-model'], ARRAY['/v1/chat/completions'],
                 clock_timestamp() - interval '1 minute', $5, 'active', $5, $6)`,
        [rightsIds[mode], providerId, productId, mode, `lease-test-evidence-${rightsIds[mode]}`, 'a'.repeat(64)],
      )).rowCount, 1);
    }
    for (const tenantId of fixture.tenantIds) {
      assert.equal((await tx.query(
        `INSERT INTO saas_tenant_provider_accounts
           (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose,
            rights_id, rights_version, status, validation_state)
         VALUES ($1, $2, 'Lease tenant fixture', $3, $4, 'api-key', 'lease-test', 'inference', $5, 1, 'active', 'verified')`,
        [tenantId, fixture.accountId, providerId, productId, rightsIds.byok],
      )).rowCount, 1);
    }
    assert.equal((await tx.query(
      `INSERT INTO saas_platform_provider_accounts
         (id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, 'Lease platform fixture', $2, $3, 'api-key', 'lease-test', 'inference', $4, 1, 'active', 'verified')`,
      [fixture.accountId, providerId, productId, rightsIds.platform],
    )).rowCount, 1);
  });
  return fixture;
}

function accountKey(fixture: Fixture, mode: SupplyMode, tenantId = fixture.tenantIds[0]): string {
  return mode === 'byok'
    ? saasAdvisoryKey.tenantProviderAccount(tenantId, fixture.accountId)
    : saasAdvisoryKey.platformProviderAccount(fixture.accountId);
}

function request(fixture: Fixture, mode: SupplyMode, tenantId = fixture.tenantIds[0]): PreparedEvidenceLeaseRequest {
  const attemptId = randomUUID();
  // This is the lease port's typed input, not a claim that this focused suite
  // signs/prepares a commercial request. Real account/lease guards still run;
  // full signed dispatch remains covered by the independent HTTP gate.
  const evidence: PreparedRequestEvidenceRecord = {
    evidenceId: randomUUID(), tenantId, projectId: randomUUID(), requestId: randomUUID(), attemptId,
    attemptOrdinal: 1, supplyMode: mode, accountOwnerKind: mode === 'byok' ? 'tenant' : 'platform',
    publicModel: 'lease-test-model', protocol: 'openai', endpoint: '/v1/chat/completions',
    upstreamId: `lease-upstream-${fixture.accountId}`, accountId: fixture.accountId,
    credentialId: 'lease-port-fixture-only', credentialVersion: '1',
    routeTargetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    payloadSha256: 'b'.repeat(64), statementSha256: 'c'.repeat(64), status: 'registered',
    claimedAt: null, claimedAttemptId: null, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { tenantId, accountId: fixture.accountId, upstreamId: evidence.upstreamId, attemptId, evidence };
}

function service(database: SaasDatabase, leaseTtlMs = 30_000): PostgresProviderAccountLeaseService {
  return new PostgresProviderAccountLeaseService({ database, maxConcurrency: 1, leaseTtlMs });
}

interface LeaseRow {
  id: string;
  tenant_id: string;
  owner_kind: string;
  owner_tenant_id: string | null;
  account_id: string;
  attempt_id: string;
  slot: number;
  fencing_token: string;
  status: string;
  lease_expires_at: Date;
  released_at: Date | null;
}

async function leaseRows(gateway: SqlExecutor, fixture: Fixture, mode: SupplyMode, tenantId = fixture.tenantIds[0]): Promise<LeaseRow[]> {
  const result = await gateway.query<LeaseRow>(
    `SELECT id, tenant_id, owner_kind, owner_tenant_id, account_id, attempt_id, slot,
            fencing_token::text, status, lease_expires_at, released_at
       FROM saas_provider_account_leases
      WHERE owner_kind = $1 AND owner_tenant_id IS NOT DISTINCT FROM $2 AND account_id = $3
      ORDER BY saas_provider_account_leases.fencing_token`,
    [mode === 'byok' ? 'tenant' : 'platform', mode === 'byok' ? tenantId : null, fixture.accountId],
  );
  assert.equal(result.rowCount, result.rows.length);
  return result.rows;
}

type Acquisition = { readonly ok: true; readonly lease: ProviderAccountLease | null } |
  { readonly ok: false; readonly error: unknown };

function observe(operation: Promise<ProviderAccountLease | null>): Promise<Acquisition> {
  // Observe rejections immediately, including while waiting for a lock witness.
  // Neither this helper nor a test executor changes service/driver results.
  return operation.then((lease) => ({ ok: true as const, lease }), (error: unknown) => ({ ok: false as const, error }));
}

function success(result: Acquisition): ProviderAccountLease | null {
  assert.equal(result.ok, true, 'the real restricted acquisition must not throw');
  if (!result.ok) assert.fail('the real restricted acquisition failed');
  return result.lease;
}

function assertLeaseError(error: unknown, code: 'ACCOUNT_UNAVAILABLE' | 'STALE_LEASE'): true {
  assert.ok(error instanceof ProviderAccountLeaseError, 'expected a typed lease error');
  assert.equal(error.code, code);
  return true;
}

function assertPermissionDenied(error: unknown): true {
  assert.equal(error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined,
    '42501', 'the exact existing restricted ACL must deny this operation');
  return true;
}

async function finishAcquisitions(operations: readonly Promise<Acquisition>[]): Promise<void> {
  const results = await within(Promise.all(operations), 'acquisition cleanup', 12_000);
  await within(Promise.all(results.map(async (result) => {
    if (result.ok && result.lease) {
      try { await result.lease.release(); }
      catch (error) { assertLeaseError(error, 'STALE_LEASE'); }
    }
  })), 'lease cleanup', 12_000);
}

async function revoke(client: PoolClient, fixture: Fixture, mode: SupplyMode): Promise<void> {
  const result = mode === 'byok'
    ? await client.query(
      `UPDATE saas_tenant_provider_accounts SET status = 'revoked', revoked_at = clock_timestamp(),
         authz_version = authz_version + 1, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING id`,
      [fixture.tenantIds[0], fixture.accountId],
    )
    : await client.query(
      `UPDATE saas_platform_provider_accounts SET status = 'revoked', revoked_at = clock_timestamp(),
         authz_version = authz_version + 1, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'active' RETURNING id`, [fixture.accountId],
    );
  assert.equal(result.rowCount, 1, 'the restricted CP must really revoke the active account');
}

async function waitForExpiry(gateway: SqlExecutor, token: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await gateway.query<{ expired: boolean }>(
      'SELECT lease_expires_at <= clock_timestamp() AS expired FROM saas_provider_account_leases WHERE fencing_token = $1::bigint',
      [token],
    );
    assert.equal(result.rows.length, 1);
    if (result.rows[0]?.expired === true) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('the actual PostgreSQL lease clock did not expire before the deadline');
}

test('restricted PostgreSQL account fences serialize lease acquisition without account UPDATE or application EXECUTE', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
    ? `set ${REQUIRED_FLAG}=1 and all three disposable gateway E2E role URLs to require this gate`
    : false,
  timeout: 120_000,
}, async (t) => {
  const urls = assertDisposableRoleTargets();
  const poolOptions = { connectionTimeoutMillis: 5_000, options: '-c statement_timeout=10000 -c lock_timeout=8000' };
  const seedPool = new Pool({ ...poolOptions, connectionString: urls.migrator, max: 1 });
  const controlPool = new Pool({ ...poolOptions, connectionString: urls.control_plane, max: 3 });
  const gatewayPools = [0, 1, 2].map(() => new Pool({ ...poolOptions, connectionString: urls.gateway, max: 1 }));
  const seed = createSaasDatabase({ connectionString: urls.migrator, pool: databasePool(seedPool) });
  const control = createSaasDatabase({ connectionString: urls.control_plane, pool: databasePool(controlPool) });
  // Separate real sessions contend. All acquired gateway sessions deliberately
  // default to REPEATABLE READ; the production transaction must override it.
  const gateways = gatewayPools.map((pool) => createSaasDatabase({ connectionString: urls.gateway, pool: databasePool(pool, true) }));
  const gatewayA = gateways[0]!;
  const gatewayB = gateways[1]!;
  const gatewayC = gateways[2]!;
  t.after(async () => {
    await within(Promise.all([seed, control, ...gateways].map((database) => database.close())), 'database cleanup', 15_000);
  });

  const expectedDatabase = decodeURIComponent(new URL(urls.migrator).pathname.slice(1));
  for (const [database, role] of [[seed, 'migrator'], [control, 'control_plane'], ...gateways.map((database) => [database, 'gateway'] as const)] as const) {
    const identity = await database.query<{ role: string; session: string; schema: string; database: string; version: string; superuser: boolean }>(
      `SELECT current_user AS role, session_user AS session, current_schema() AS schema, current_database() AS database,
              current_setting('server_version_num') AS version, r.rolsuper AS superuser
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    assert.equal(identity.rows.length, 1);
    assert.equal(identity.rows[0]?.role, `model_router_saas_${role}`);
    assert.equal(identity.rows[0]?.session, `model_router_saas_${role}`);
    assert.equal(identity.rows[0]?.schema, 'model_router_saas');
    assert.equal(identity.rows[0]?.database, expectedDatabase);
    assert.equal(identity.rows[0]?.superuser, false);
    assert.ok([15, 18].includes(Math.floor(Number(identity.rows[0]?.version) / 10_000)), 'run this gate on PostgreSQL 15 and 18');
  }
  // The fixture must already be normally migrated and role-provisioned. Never
  // reset/bootstrap it, borrow the migrator for an application operation, or
  // grant a missing privilege just to make a case pass.
  await seed.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
  for (const gateway of gateways) await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');

  await t.test('gateway account authority stays SELECT-only and schema helpers stay non-callable', async () => {
    for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
      const acl = await gatewayA.query<{ reads: boolean; updates: boolean }>(
        `SELECT has_column_privilege(current_user, $1::text, 'id', 'SELECT') AS reads,
                has_any_column_privilege(current_user, $1::text, 'UPDATE') AS updates`, [table],
      );
      assert.deepEqual(acl.rows, [{ reads: true, updates: false }]);
      await assert.rejects(gatewayA.query(`SELECT id FROM ${table} WHERE FALSE FOR UPDATE`), assertPermissionDenied);
      await assert.rejects(gatewayA.query(`UPDATE ${table} SET status = 'disabled' WHERE FALSE`), assertPermissionDenied);
    }
    for (const database of [gatewayA, control]) {
      const functions = await database.query<{ executable: string }>(
        `SELECT count(p.oid)::text AS executable FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'model_router_saas' AND has_function_privilege(current_user, p.oid, 'EXECUTE')`,
      );
      assert.deepEqual(functions.rows, [{ executable: '0' }]);
      await assert.rejects(database.query('SELECT saas_prepared_evidence_writer_lock_layer(ARRAY[]::text[])'), assertPermissionDenied);
    }
  });

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(`${mode}: two real concurrent acquisitions share max=1, including platform NULL ownership`, async () => {
      const fixture = await seedFixture(seed);
      const pending: Promise<Acquisition>[] = [];
      const inputA = request(fixture, mode);
      const inputB = request(fixture, mode, mode === 'platform' ? fixture.tenantIds[1] : fixture.tenantIds[0]);
      const [pidA, pidB] = await Promise.all([pid(gatewayA), pid(gatewayB)]);
      assert.notEqual(pidA, pidB);
      try {
        await withControlTransaction(controlPool, async (client, commit) => {
          const key = accountKey(fixture, mode);
          const holderPid = await pid(clientExecutor(client));
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
          pending.push(observe(service(gatewayA).acquire(inputA)), observe(service(gatewayB).acquire(inputB)));
          await Promise.all([waitForFence(control, pidA, holderPid, key), waitForFence(control, pidB, holderPid, key)]);
          assert.equal((await leaseRows(gatewayC, fixture, mode)).length, 0, 'neither waiter may write while the fence is held');
          await commit();
        });
        const leases = (await within(Promise.all(pending), 'concurrent acquisition')).map(success);
        assert.equal(leases.filter((lease) => lease !== null).length, 1);
        assert.equal(leases.filter((lease) => lease === null).length, 1);
        const held = await leaseRows(gatewayC, fixture, mode);
        assert.equal(held.length, 1, 'no oversell or failed duplicate insert may stand in for a capacity denial');
        assert.equal(held[0]?.status, 'held');
        assert.equal(held[0]?.slot, 0);
        assert.equal(held[0]?.owner_kind, mode === 'byok' ? 'tenant' : 'platform');
        assert.equal(held[0]?.owner_tenant_id, mode === 'byok' ? fixture.tenantIds[0] : null);
        assert.ok([inputA.attemptId, inputB.attemptId].includes(held[0]!.attempt_id));
        assert.equal(held[0]?.fencing_token, leases.find((lease) => lease !== null)!.fencingToken);
      } finally { await finishAcquisitions(pending); }
    });

    await t.test(`${mode}: acquisition waits for the real CP revocation trigger and rejects the freshly committed authority`, async () => {
      const fixture = await seedFixture(seed);
      const pending: Promise<Acquisition>[] = [];
      const waiterPid = await pid(gatewayA);
      try {
        await withControlTransaction(controlPool, async (client, commit) => {
          const holderPid = await pid(clientExecutor(client));
          // No manually acquired fence here: the installed CP UPDATE trigger
          // must hold the exact account key, proving the real writer mapping.
          await revoke(client, fixture, mode);
          pending.push(observe(service(gatewayA).acquire(request(fixture, mode))));
          await waitForFence(control, waiterPid, holderPid, accountKey(fixture, mode));
          assert.equal((await leaseRows(gatewayC, fixture, mode)).length, 0);
          await commit();
        });
        const result = await within(pending[0]!, 'post-revocation acquisition');
        assert.equal(result.ok, false, 'a lock statement snapshot must not hide a committed CP revocation');
        if (result.ok) assert.fail('revoked account unexpectedly admitted a lease');
        assertLeaseError(result.error, 'ACCOUNT_UNAVAILABLE');
        assert.deepEqual(await leaseRows(gatewayC, fixture, mode), []);
      } finally { await finishAcquisitions(pending); }
    });
  }

  for (const blockedMode of ['byok', 'platform'] as const) {
    await t.test(`${blockedMode}: a held account key does not serialize distinct tenants or the other owner family`, async () => {
      const fixture = await seedFixture(seed);
      const pending: Promise<Acquisition>[] = [];
      const waiterPid = await pid(gatewayA);
      try {
        await withControlTransaction(controlPool, async (client, commit) => {
          const holderPid = await pid(clientExecutor(client));
          const key = accountKey(fixture, blockedMode);
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
          pending.push(observe(service(gatewayA).acquire(request(fixture, blockedMode))));
          await waitForFence(control, waiterPid, holderPid, key);
          const independentModes = blockedMode === 'byok' ? ['byok', 'platform'] as const : ['byok', 'byok'] as const;
          pending.push(
            observe(service(gatewayB).acquire(request(fixture, independentModes[0], fixture.tenantIds[1]))),
            observe(service(gatewayC).acquire(request(fixture, independentModes[1], fixture.tenantIds[0]))),
          );
          for (const operation of pending.slice(1)) assert.ok(success(await within(operation, 'independent account acquisition')));
          // The held key remains a real blocker while both independent scopes
          // have committed. Shared account text cannot create a global mutex.
          await waitForFence(control, waiterPid, holderPid, key);
          await commit();
        });
        assert.ok(success(await within(pending[0]!, 'formerly blocked acquisition')));
        for (const [mode, tenantId] of [
          ['byok', fixture.tenantIds[0]], ['byok', fixture.tenantIds[1]], ['platform', fixture.tenantIds[0]],
        ] as const) {
          const rows = await leaseRows(gatewayB, fixture, mode, tenantId);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.status, 'held');
          assert.equal(rows[0]?.owner_tenant_id, mode === 'byok' ? tenantId : null);
        }
      } finally { await finishAcquisitions(pending); }
    });
  }

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(`${mode}: released and naturally expired old fencing tokens cannot mutate a replacement lease`, async () => {
      const fixture = await seedFixture(seed);
      const longLived = service(gatewayA);
      const first = await longLived.acquire(request(fixture, mode));
      assert.ok(first);
      await first.release();
      await first.release(); // Existing release idempotency is intentional.
      await assert.rejects(first.renew(), (error) => assertLeaseError(error, 'STALE_LEASE'));
      const second = await service(gatewayB, 200).acquire(request(fixture, mode));
      assert.ok(second);
      assert.ok(BigInt(second.fencingToken) > BigInt(first.fencingToken));
      await waitForExpiry(gatewayC, second.fencingToken);
      const third = await longLived.acquire(request(fixture, mode));
      assert.ok(third);
      try {
        assert.ok(BigInt(third.fencingToken) > BigInt(second.fencingToken));
        await assert.rejects(second.renew(), (error) => assertLeaseError(error, 'STALE_LEASE'));
        await assert.rejects(second.release(), (error) => assertLeaseError(error, 'STALE_LEASE'));
        await first.release();
        const before = await leaseRows(gatewayC, fixture, mode);
        assert.deepEqual(before.map((row) => row.status), ['released', 'expired', 'held']);
        assert.deepEqual(before.map((row) => row.slot), [0, 0, 0]);
        assert.deepEqual(before.map((row) => row.fencing_token), [first.fencingToken, second.fencingToken, third.fencingToken]);
        assert.ok(before[0]?.released_at instanceof Date);
        assert.ok(before[1]?.released_at instanceof Date);
        assert.equal(before[2]?.released_at, null);
        await delay(5);
        await third.renew();
        const after = await leaseRows(gatewayC, fixture, mode);
        assert.equal(after.length, 3);
        assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'terminal lease facts remain immutable');
        assert.equal(after[2]?.id, before[2]?.id);
        assert.equal(after[2]?.fencing_token, third.fencingToken);
        assert.equal(after[2]?.status, 'held');
        assert.ok(after[2]!.lease_expires_at.getTime() > before[2]!.lease_expires_at.getTime());
      } finally { await third.release(); }
      assert.deepEqual((await leaseRows(gatewayC, fixture, mode)).map((row) => row.status), ['released', 'expired', 'released']);
    });
  }
});
