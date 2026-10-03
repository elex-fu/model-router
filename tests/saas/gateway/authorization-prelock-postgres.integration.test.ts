import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresSaasRequestAdmissionAuthorizationPrelock,
  SaasAdmissionAuthorizationError,
  type SaasRequestAdmissionAuthenticatedKey,
} from '../../../src/saas/gateway/authorization-prelock.js';
import type { CreateRequestInput } from '../../../src/saas/metering/types.js';

const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleUrls = {
  migrator: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL?.trim(),
  control_plane: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL?.trim(),
  gateway: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim(),
};
const anyConfigured = Object.values(roleUrls).some(Boolean);
const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();

// This suite uses the existing, fully migrated disposable E2E database. It
// neither installs grants nor changes triggers. Immutable fixture rows remain
// until the owner disposes of that database; cleanup must not bypass guards.
function assertDisposableRoleTargets(): Record<keyof typeof roleUrls, string> {
  let target: string | undefined;
  const validated = {} as Record<keyof typeof roleUrls, string>;
  for (const role of Object.keys(roleUrls) as Array<keyof typeof roleUrls>) {
    const value = roleUrls[role];
    assert.ok(value, `the disposable gateway E2E ${role} URL is required`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`the disposable gateway E2E ${role} URL must be a valid PostgreSQL URL`);
    }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'the test target must be PostgreSQL');
    assert.equal(decodeURIComponent(parsed.username), `model_router_saas_${role}`, 'use the exact managed E2E role');
    const hostname = parsed.hostname.toLowerCase();
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    assert.equal(parsed.hash, '', 'database URL fragments are not supported');
    // Reject every query option, including differently cased routing overrides.
    assert.equal(parsed.search, '', 'database URLs must not contain connection overrides');
    const ciTarget = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const localTarget =
      ['127.0.0.1', '[::1]'].includes(hostname) &&
      Boolean(parsed.port) && Number.isInteger(port) && port > 0 && port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ciTarget || localTarget,
      'use postgres:5432/model_router_saas_ci or a disposable model_router_saas_ci/model_router_test_* loopback database on an explicit nondefault port');
    const currentTarget = `${hostname}:${port}/${database}`;
    if (target === undefined) target = currentTarget;
    assert.equal(currentTarget, target, 'all E2E roles must use the same disposable database');
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
      } catch (error) {
        client.release(true);
        throw error;
      }
    },
    end: () => pool.end(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Inspect the actual lock manager rather than infer contention from elapsed
// time. Both PIDs and the exact bigint namespace must match the held fence.
async function waitForFence(
  observer: SqlExecutor,
  waiterPid: number,
  holderPid: number,
  key: string,
  waiterMode: 'ShareLock' | 'ExclusiveLock',
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks waiter JOIN pg_locks holder
           USING (locktype, database, classid, objid, objsubid)
          WHERE waiter.locktype = 'advisory' AND waiter.pid = $1 AND holder.pid = $2
            AND NOT waiter.granted AND holder.granted AND waiter.mode = $4
            AND holder.mode = $5 AND holder.objsubid = 1
            AND holder.classid = ((hashtextextended($3::text, 0) >> 32) & 4294967295)::oid
            AND holder.objid = (hashtextextended($3::text, 0) & 4294967295)::oid
       ) AS waiting`,
      [waiterPid, holderPid, key, waiterMode, waiterMode === 'ShareLock' ? 'ExclusiveLock' : 'ShareLock'],
    );
    if (result.rows[0]?.waiting === true) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('the actual matching advisory fence did not block before the deadline');
}

async function pid(executor: SqlExecutor): Promise<number> {
  const result = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.pid;
}

interface Fixture {
  request: CreateRequestInput;
  authenticatedKey: SaasRequestAdmissionAuthenticatedKey;
  userId: string;
}

async function insertKey(executor: SqlExecutor, fixture: Fixture, keyId = fixture.request.proxyKeyId, version = 1) {
  const { request, userId } = fixture;
  const inserted = await executor.query(
    `INSERT INTO saas_api_keys
       (id, tenant_id, project_id, principal_user_id, execution_principal_type, execution_principal_id,
        created_by_user_id, entitlement_id, supply_profile_id, supply_mode, name, prefix, key_hash,
        model_scopes, authz_version, model_scope_version, entitlement_authz_version, supply_profile_authz_version,
        created_at, expires_at)
     VALUES ($1, $2, $3, $4, 'member', $4, $4, $5, $6, $7, 'Prelock PG test', 'mr_live_prelock_test', $8,
             $9, $10, 1, 1, 1, clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 minutes')
     RETURNING id`,
    [keyId, request.tenantId, request.projectId, userId, request.entitlementId, request.supplyProfileId,
      request.supplyMode, createHash('sha256').update(`prelock-test-only:${keyId}`).digest('hex'),
      [request.publicModel], version],
  );
  assert.equal(inserted.rowCount, 1);
}

async function seedFixture(database: ReturnType<typeof createSaasDatabase>, mode: 'byok' | 'platform'): Promise<Fixture> {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const userId = randomUUID();
  const keyId = randomUUID();
  const entitlementId = randomUUID();
  const profileId = `prelock-${randomUUID()}`;
  const publicModel = `prelock-model-${randomUUID()}`;
  const request: CreateRequestInput = {
    tenantId, projectId, proxyKeyId: keyId, entitlementId, supplyProfileId: profileId,
    supplyProfileVersion: 1, modelScopeVersion: 1, supplyMode: mode, principalKind: 'member',
    principalId: userId, authzVersion: 1, entitlementVersion: 1, configVersion: 1, projectPolicyVersion: 1,
    publicModel, protocol: 'openai', endpoint: '/v1/chat/completions',
    requestFingerprint: 'a'.repeat(64), requestFingerprintVersion: 'canonical-v1',
    idempotencyKey: `prelock-replay-${keyId}`, customerPriceVersion: mode === 'platform' ? 'prelock-price' : null,
  };
  const fixture: Fixture = {
    userId, request,
    authenticatedKey: { authorization: {
      keyId, tenantId, projectId, principalKind: 'member', principalId: userId,
      entitlementId, supplyProfileId: profileId, supplyMode: mode, modelScopes: [publicModel],
      authzVersion: 1, modelScopeVersion: 1, entitlementAuthzVersion: 1, supplyProfileAuthzVersion: 1,
    } },
  };
  await database.transaction(async (tx) => {
    await tx.query('INSERT INTO saas_users (id, email) VALUES ($1, $2)', [userId, `prelock-${userId}@example.test`]);
    await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [tenantId, `prelock-${tenantId}`]);
    await tx.query("INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenantId, userId]);
    await tx.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug, inference_policy_status)
       VALUES ($1, $2, $3, $3, 'active')`, [tenantId, projectId, `prelock-${projectId}`],
    );
    await tx.query(
      "INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
      [tenantId, projectId, userId],
    );
    await tx.query(
      'INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes) VALUES ($1, $2, $3, $4)',
      [tenantId, profileId, mode, [publicModel]],
    );
    await tx.query(
      `INSERT INTO saas_project_entitlements
         (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes, source_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'admin_grant')`,
      [entitlementId, tenantId, projectId, profileId, mode, [publicModel]],
    );
    await insertKey(tx, fixture);
  });
  return fixture;
}

async function revoke(writer: SqlExecutor, fixture: Fixture, rotation = false): Promise<void> {
  const changed = await writer.query(
    `UPDATE saas_api_keys SET status = 'revoked', revoked_at = clock_timestamp(),
       authz_version = authz_version + 1, revoked_by_user_id = $2,
       rotated_by_user_id = CASE WHEN $3 THEN $2::uuid ELSE rotated_by_user_id END
     WHERE id = $1 AND status = 'active' RETURNING id`,
    [fixture.request.proxyKeyId, fixture.userId, rotation],
  );
  assert.equal(changed.rowCount, 1);
  if (rotation) await insertKey(writer, fixture, randomUUID(), 2);
}

async function assertDenied(operation: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof SaasAdmissionAuthorizationError);
    assert.equal(error.code, 'authorization_denied');
    assert.match(error.message, message);
    return true;
  });
}

test('restricted PostgreSQL prelock fences concurrent authorization changes on the disposable E2E target', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
    ? `set ${REQUIRED_FLAG}=1 and all three disposable E2E role URLs to require this gate`
    : false,
  timeout: 120_000,
}, async (t) => {
  const urls = assertDisposableRoleTargets();
  const pools = Object.fromEntries(Object.entries(urls).map(([role, connectionString]) => [role, new Pool({
    connectionString, max: 3, connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=10000 -c lock_timeout=8000',
  })])) as Record<keyof typeof roleUrls, Pool>;
  const seed = createSaasDatabase({ connectionString: urls.migrator, pool: databasePool(pools.migrator) });
  const control = createSaasDatabase({ connectionString: urls.control_plane, pool: databasePool(pools.control_plane) });
  // Every acquired reader session deliberately defaults to REPEATABLE READ.
  // Only the production transaction boundary overrides that default.
  const gateway = createSaasDatabase({ connectionString: urls.gateway, pool: databasePool(pools.gateway, true) });
  try {
    const expectedDatabase = decodeURIComponent(new URL(urls.migrator).pathname.slice(1));
    for (const [database, role] of [[seed, 'migrator'], [control, 'control_plane'], [gateway, 'gateway']] as const) {
      const current = await database.query<{
        role: string; session: string; schema: string; superuser: boolean; database: string; version: string;
      }>(
        `SELECT current_user AS role, session_user AS session, current_schema() AS schema,
                r.rolsuper AS superuser, current_database() AS database,
                current_setting('server_version_num') AS version
           FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
      );
      assert.equal(current.rows.length, 1);
      assert.equal(current.rows[0]?.role, `model_router_saas_${role}`);
      assert.equal(current.rows[0]?.session, `model_router_saas_${role}`);
      assert.equal(current.rows[0]?.schema, 'model_router_saas');
      assert.equal(current.rows[0]?.superuser, false);
      assert.equal(current.rows[0]?.database, expectedDatabase);
      assert.ok([15, 18].includes(Math.floor(Number(current.rows[0]?.version) / 10_000)), 'run this gate on PG15 and PG18');
    }
    await seed.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');

    await t.test('gateway has column SELECT, no API-key UPDATE, and executes the new prelock', async () => {
      const acl = await gateway.query<{ column_select: boolean; table_select: boolean; any_update: boolean; superuser: boolean }>(
        `SELECT has_column_privilege(current_user, 'saas_api_keys', 'id', 'SELECT') AS column_select,
                has_table_privilege(current_user, 'saas_api_keys', 'SELECT') AS table_select,
                has_any_column_privilege(current_user, 'saas_api_keys', 'UPDATE') AS any_update,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
      );
      assert.deepEqual(acl.rows[0], { column_select: true, table_select: false, any_update: false, superuser: false });
      await assert.rejects(gateway.query('SELECT id FROM saas_api_keys LIMIT 1 FOR SHARE'),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
      for (const mode of ['byok', 'platform'] as const) {
        const fixture = await seedFixture(seed, mode);
        await gateway.transaction(async (executor) => {
          const isolation = await executor.query<{ transaction_isolation: string; default_transaction_isolation: string }>(
            "SELECT current_setting('transaction_isolation') AS transaction_isolation, current_setting('default_transaction_isolation') AS default_transaction_isolation",
          );
          assert.deepEqual(isolation.rows[0], { transaction_isolation: 'read committed', default_transaction_isolation: 'repeatable read' });
          await prelock.prelock({ executor, ...fixture });
        });
      }
    });

    for (const mode of ['byok', 'platform'] as const) {
      for (const rotation of [false, true]) {
        await t.test(`${mode}: prelock holds shared fences until commit and blocks a real ${rotation ? 'rotation' : 'revocation'} trigger`, async () => {
          const fixture = await seedFixture(seed, mode);
          const held = deferred();
          const release = deferred();
          let readerPid = 0;
          const reader = gateway.transaction(async (executor) => {
            readerPid = await pid(executor);
            await prelock.prelock({ executor, ...fixture });
            held.resolve();
            await release.promise;
          });
          void reader.catch(() => held.resolve());
          const rawWriter = await pools.control_plane.connect();
          const writer = clientExecutor(rawWriter);
          let mutation: Promise<void> | undefined;
          try {
            await held.promise;
            await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            const writerPid = await pid(writer);
            const businessKey = saasAdvisoryKey.apiKey(
              fixture.request.tenantId, fixture.request.projectId, fixture.request.proxyKeyId,
            );
            const heldKey = await control.query<{ held: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'
                 AND granted AND mode = 'ShareLock' AND objsubid = 1
                 AND classid = ((hashtextextended($2::text, 0) >> 32) & 4294967295)::oid
                 AND objid = (hashtextextended($2::text, 0) & 4294967295)::oid) AS held`,
              [readerPid, businessKey],
            );
            assert.equal(heldKey.rows[0]?.held, true, 'the completed prelock retains its exact shared API-key fence');
            mutation = revoke(writer, fixture, rotation);
            void mutation.catch(() => {});
            // The trigger follows tenant -> project -> user -> key, so a full
            // prelock first blocks its exclusive tenant fence, before key DML.
            // The separate key-only test below proves the business layer too.
            await waitForFence(control, writerPid, readerPid,
              saasAdvisoryKey.tenant(fixture.request.tenantId), 'ExclusiveLock');
            const original = await gateway.query<{ status: string; authz_version: string }>(
              'SELECT status, authz_version FROM saas_api_keys WHERE id = $1', [fixture.request.proxyKeyId],
            );
            assert.deepEqual(original.rows[0], { status: 'active', authz_version: '1' });
            release.resolve();
            await reader;
            await mutation;
            await writer.query('COMMIT');
            // The identical retry input still revalidates current authority.
            await assertDenied(gateway.transaction((executor) => prelock.prelock({ executor, ...fixture })), /API key is not active/);
          } finally {
            release.resolve();
            await reader.catch(() => {});
            await mutation?.catch(() => {});
            await writer.query('ROLLBACK');
            writer.release();
          }
        });
      }
    }

    await t.test('actual writer trigger also blocks on the exact API-key business fence', async () => {
      const fixture = await seedFixture(seed, 'byok');
      const rawReader = await pools.gateway.connect();
      const rawWriter = await pools.control_plane.connect();
      const reader = clientExecutor(rawReader);
      const writer = clientExecutor(rawWriter);
      let mutation: Promise<void> | undefined;
      try {
        await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const key = saasAdvisoryKey.apiKey(fixture.request.tenantId, fixture.request.projectId, fixture.request.proxyKeyId);
        await reader.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [key]);
        await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const readerPid = await pid(reader);
        const writerPid = await pid(writer);
        mutation = revoke(writer, fixture);
        void mutation.catch(() => {});
        await waitForFence(control, writerPid, readerPid, key, 'ExclusiveLock');
        await reader.query('COMMIT');
        await mutation;
        await writer.query('COMMIT');
      } finally {
        await reader.query('ROLLBACK');
        await mutation?.catch(() => {});
        await writer.query('ROLLBACK');
        reader.release();
        writer.release();
      }
    });

    for (const [mode, change] of (['byok', 'platform'] as const).flatMap((mode) =>
      (['revoke', 'rotate', 'expiry'] as const).map((change) => [mode, change] as const),
    )) {
      await t.test(`${mode}: pre-existing snapshot plus actual fence wait sees fresh ${change} under a REPEATABLE READ session default`, async () => {
        const fixture = await seedFixture(seed, mode);
        if (change === 'expiry') {
          await seed.query("UPDATE saas_api_keys SET expires_at = clock_timestamp() + interval '4 seconds' WHERE id = $1", [fixture.request.proxyKeyId]);
        }
        const snapshot = deferred();
        const startPrelock = deferred();
        let readerPid = 0;
        const reader = gateway.transaction(async (executor) => {
          readerPid = await pid(executor);
          const prior = await executor.query<{ status: string; unexpired: boolean }>(
            'SELECT status, expires_at > clock_timestamp() AS unexpired FROM saas_api_keys WHERE id = $1',
            [fixture.request.proxyKeyId],
          );
          assert.deepEqual(prior.rows[0], { status: 'active', unexpired: true });
          snapshot.resolve();
          await startPrelock.promise;
          await prelock.prelock({ executor, ...fixture });
        });
        const rejection = assertDenied(reader, change === 'expiry' ? /API key is expired/ : /API key is not active/);
        void rejection.catch(() => {});
        void reader.catch(() => snapshot.resolve());
        const rawWriter = await pools.control_plane.connect();
        const writer = clientExecutor(rawWriter);
        try {
          await snapshot.promise;
          await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          const writerPid = await pid(writer);
          if (change === 'expiry') {
            await writer.query('UPDATE saas_api_keys SET last_used_at = clock_timestamp() WHERE id = $1', [fixture.request.proxyKeyId]);
          } else {
            await revoke(writer, fixture, change === 'rotate');
          }
          startPrelock.resolve();
          await waitForFence(control, readerPid, writerPid, saasAdvisoryKey.tenant(fixture.request.tenantId), 'ShareLock');
          if (change === 'expiry') {
            const deadline = Date.now() + 5_000;
            let expired = false;
            do {
              const current = await writer.query<{ expired: boolean }>(
                'SELECT expires_at <= clock_timestamp() AS expired FROM saas_api_keys WHERE id = $1', [fixture.request.proxyKeyId],
              );
              expired = current.rows[0]?.expired === true;
              if (!expired) await delay(10);
            } while (!expired && Date.now() < deadline);
            assert.equal(expired, true, 'expiry must pass while the reader is actually waiting');
          }
          await writer.query('COMMIT');
          await rejection;
        } finally {
          startPrelock.resolve();
          await writer.query('ROLLBACK');
          await rejection.catch(() => {});
          writer.release();
        }
      });
    }
  } finally {
    await Promise.all([gateway.close(), control.close(), seed.close()]);
  }
});
