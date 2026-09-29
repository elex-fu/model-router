import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { runSaasMigrations } from '../../../src/saas/db/migrate.js';
import type { SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/043_customer_webhook_delivery.js';
import { PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/044_project_service_key_authorization.js';
import { BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/045_byok_refund_entitlement_effect.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import type {
  SaasDatabase,
  SaasDatabaseClient,
  SaasDatabasePool,
  SqlExecutor,
  SqlResult,
} from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  CapacityPolicyError,
  type CapacityPolicyLimits,
  PlatformCapacityPolicyService,
  type SetTenantCapacityPolicyInput,
} from '../../../src/saas/platform/capacity-policy-service.js';

const realPostgresUrl = process.env.SAAS_TEST_DATABASE_URL;
const migrationsBeforeAuthorizationFences: readonly SaasMigration[] = [
  ...SAAS_MIGRATIONS.filter(({ version }) => version < 43),
  CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION,
  PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION,
  BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION,
];
const migrations: readonly SaasMigration[] = [
  ...migrationsBeforeAuthorizationFences,
  PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
];
const POLICY_LIMITS: CapacityPolicyLimits = {
  requestsPerMinute: 120,
  tokensPerMinute: 120_000,
  maxConcurrentRequests: 12,
};

function expectedPreparedEvidenceGuard(source: string): string {
  const newline = String.fromCharCode(10);
  const exact = (lines: readonly string[]) => `${lines.join(newline)}${newline}`;
  const replaceOnce = (body: string, before: string, after: string): string => {
    assert.equal(body.split(before).length - 1, 1, 'expected exactly one occurrence of each approved guard clause');
    return body.replace(before, after);
  };
  const unsupportedService = exact([
    "  IF NEW.principal_kind = 'project_service' THEN",
    "    RAISE EXCEPTION 'Project-service prepared-request evidence is unsupported'",
    "      USING ERRCODE = '55000';",
    '  END IF;',
  ]);
  const supportedService = exact([
    "  IF NEW.principal_kind IS DISTINCT FROM 'member'",
    "    AND NEW.principal_kind IS DISTINCT FROM 'project_service' THEN",
    "    RAISE EXCEPTION 'Prepared-request evidence principal kind is invalid'",
    "      USING ERRCODE = '23514';",
    '  END IF;',
    "  IF NEW.principal_kind = 'project_service'",
    '    AND NEW.principal_id IS DISTINCT FROM NEW.project_id THEN',
    "    RAISE EXCEPTION 'Project-service prepared-request evidence principal must match its project'",
    "      USING ERRCODE = '23514';",
    '  END IF;',
  ]);

  const memberStart = source.indexOf(`  PERFORM 1 FROM saas_users${newline}`);
  const memberEndMessage = source.indexOf(
    "  RAISE EXCEPTION 'Prepared-request evidence project membership is not inference-capable'",
    memberStart,
  );
  const memberEndIf = source.indexOf(`  END IF;${newline}`, memberEndMessage);
  assert.ok(memberStart >= 0 && memberEndMessage >= 0 && memberEndIf >= 0, 'member proof must be present');
  const memberEnd = memberEndIf + `  END IF;${newline}`.length;
  const originalMemberProof = source.slice(memberStart, memberEnd);
  const conditionalMemberProof =
    [
      "  IF NEW.principal_kind = 'member' THEN",
      originalMemberProof
        .trimEnd()
        .split(newline)
        .map((line) => (line ? `  ${line}` : line))
        .join(newline),
      '  END IF;',
    ].join(newline) + newline;

  const keyPrincipal = `    OR key_record.execution_principal_id IS DISTINCT FROM NEW.principal_id${newline}`;
  const keyPrincipalWithShape = exact([
    '    OR key_record.execution_principal_id IS DISTINCT FROM NEW.principal_id',
    "    OR (NEW.principal_kind = 'member'",
    '      AND key_record.principal_user_id IS DISTINCT FROM NEW.principal_id)',
    "    OR (NEW.principal_kind = 'project_service'",
    '      AND key_record.principal_user_id IS NOT NULL)',
  ]);
  const historyLock = /AND version = NEW\.project_policy_version\s+FOR SHARE;/g;

  let expected = replaceOnce(source, unsupportedService, supportedService);
  expected = replaceOnce(expected, originalMemberProof, conditionalMemberProof);
  expected = replaceOnce(expected, keyPrincipal, keyPrincipalWithShape);
  assert.equal([...expected.matchAll(historyLock)].length, 1);
  return expected.replace(historyLock, 'AND version = NEW.project_policy_version;');
}

interface TestActor {
  readonly actor: PlatformAdminActor;
  readonly credentialId: string;
  readonly tenantId: string;
}

class ScopedClient implements SaasDatabaseClient {
  constructor(private readonly client: import('pg').PoolClient) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class ScopedPool implements SaasDatabasePool {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
  ) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const client = await this.connect();
    try {
      return await client.query<Row>(sql, values);
    } finally {
      client.release();
    }
  }

  async connect(): Promise<SaasDatabaseClient> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      return new ScopedClient(client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

class ScopedSaasDatabase implements SaasDatabase {
  constructor(
    private readonly pool: ScopedPool,
    private readonly afterSharedAuthorizationLock?: () => Promise<void>,
  ) {}

  query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    return this.pool.query<Row>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    let released = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const tx: SqlExecutor = {
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(sql, values);
          if (sql.trimStart().toLowerCase().startsWith('select pg_advisory_xact_lock_shared')) {
            await this.afterSharedAuthorizationLock?.();
          }
          return result;
        },
      };
      const value = await work(tx);
      await client.query('COMMIT');
      transactionStarted = false;
      client.release();
      released = true;
      return value;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
          transactionStarted = false;
        } catch {
          client.release(true);
          released = true;
        }
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withScopedPostgresSchema<T>(work: (pool: ScopedPool) => Promise<T>): Promise<T> {
  if (!realPostgresUrl) throw new Error('SAAS_TEST_DATABASE_URL is required');
  const pool = new Pool({ connectionString: realPostgresUrl, max: 8 });
  const schema = `saas_capacity_fence_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const scopedPool = new ScopedPool(pool, schema);
    await runSaasMigrations(scopedPool, migrationsBeforeAuthorizationFences);
    const guardBefore = await scopedPool.query<{ readonly source: string }>(
      `SELECT prosrc AS source
         FROM pg_proc
        WHERE oid = 'saas_prepared_request_evidence_guard()'::regprocedure`,
    );
    const originalGuardSource = guardBefore.rows[0]?.source;
    assert.ok(typeof originalGuardSource === 'string');
    await runSaasMigrations(scopedPool, migrations);
    const guardAfter = await scopedPool.query<{ readonly source: string }>(
      `SELECT prosrc AS source
         FROM pg_proc
        WHERE oid = 'saas_prepared_request_evidence_guard()'::regprocedure`,
    );
    const installedGuardSource = guardAfter.rows[0]?.source;
    assert.ok(typeof installedGuardSource === 'string');

    /* Compare the full live PL/pgSQL body. Only the rejected service proof,
     * member-only identity/membership proof, service key shape binding, and
     * immutable-history FOR SHARE are approved differences. */
    const expectedGuardSource = expectedPreparedEvidenceGuard(originalGuardSource);
    assert.equal(installedGuardSource, expectedGuardSource);
    assert.match(installedGuardSource, /NEW\.principal_id IS DISTINCT FROM NEW\.project_id/);
    assert.match(installedGuardSource, /key_record\.principal_user_id IS NOT NULL/);
    assert.match(installedGuardSource, /role IN \('owner', 'admin', 'developer'\)/);
    assert.doesNotMatch(installedGuardSource, /AND version = NEW\.project_policy_version\s+FOR SHARE;/);

    return await work(scopedPool);
  } finally {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
}

async function seedActor(pool: ScopedPool, label: string): Promise<TestActor> {
  const actor: PlatformAdminActor = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    roles: ['operations'],
  };
  const credentialId = randomUUID();
  const tenantId = randomUUID();
  await pool.query(`INSERT INTO saas_users (id, email) VALUES ($1, $2)`, [
    actor.userId,
    `platform-${label}-${randomUUID()}@example.test`,
  ]);
  await pool.query(`INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, 'operations')`, [
    actor.userId,
  ]);
  await pool.query(
    `INSERT INTO saas_mfa_credentials (id, user_id, kind, encrypted_secret, verified_at)
     VALUES ($1, $2, 'totp', decode('7b7d', 'hex'), clock_timestamp())`,
    [credentialId, actor.userId],
  );
  await pool.query(
    `INSERT INTO saas_platform_sessions
       (id, user_id, credential_id, token_hash, csrf_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '1 hour')`,
    [actor.sessionId, actor.userId, credentialId, randomUUID().replaceAll('-', '').padEnd(64, 'a'), 'b'.repeat(64)],
  );
  await pool.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $3)`, [
    tenantId,
    `Fence test ${label}`,
    `fence-${label}-${randomUUID()}`,
  ]);
  return { actor, credentialId, tenantId };
}

function writeInput(testActor: TestActor): SetTenantCapacityPolicyInput {
  return {
    tenantId: testActor.tenantId,
    expectedRevision: 1,
    limits: POLICY_LIMITS,
    reason: 'capacity_adjustment',
    requestId: randomUUID(),
    actor: testActor.actor,
  };
}

async function waitForAdvisoryWaiter(pool: ScopedPool): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const result = await pool.query<{ readonly waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected an advisory authorization-lock waiter in PostgreSQL');
}

async function updateSessionRevocation(client: SaasDatabaseClient, sessionId: string): Promise<void> {
  await client.query(
    `UPDATE saas_platform_sessions
        SET revoked_at = clock_timestamp()
      WHERE id = $1`,
    [sessionId],
  );
}

async function expectForbidden(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof CapacityPolicyError);
    assert.equal(error.code, 'FORBIDDEN');
    return true;
  });
}

test('platform authorization fences serialize real PostgreSQL revocation and role changes', {
  skip: !realPostgresUrl,
}, async () => {
  await withScopedPostgresSchema(async (pool) => {
    const evidenceGuard = await pool.query<{ readonly definition: string }>(
      `SELECT pg_get_functiondef('saas_prepared_request_evidence_guard()'::regprocedure) AS definition`,
    );
    const evidenceDefinition = evidenceGuard.rows[0]?.definition;
    assert.ok(typeof evidenceDefinition === 'string');
    const policyHistoryRead = evidenceDefinition.match(/SELECT status INTO policy_record[\s\S]*?;/)?.[0];
    assert.ok(policyHistoryRead);
    assert.doesNotMatch(policyHistoryRead, /FOR SHARE/);
    assert.match(
      evidenceDefinition,
      /FROM saas_projects p[\s\S]*?WHERE p\.tenant_id = NEW\.tenant_id AND p\.id = NEW\.project_id\s+FOR SHARE;/,
    );

    const first = await seedActor(pool, 'revoke-action-first');
    const actionEnteredLock = deferred();
    const resumeAction = deferred();
    let pauseOnce = true;
    const actionDatabase = new ScopedSaasDatabase(pool, async () => {
      if (!pauseOnce) return;
      pauseOnce = false;
      actionEnteredLock.resolve();
      await resumeAction.promise;
    });
    const action = new PlatformCapacityPolicyService(actionDatabase).setTenantPolicy(writeInput(first));
    await actionEnteredLock.promise;

    const revocationStarted = deferred();
    const revokeAfterAction = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        revocationStarted.resolve();
        await updateSessionRevocation(client, first.actor.sessionId);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })();
    await revocationStarted.promise;
    await waitForAdvisoryWaiter(pool);
    resumeAction.resolve();
    assert.equal((await action).revision, '2');
    await revokeAfterAction;

    const second = await seedActor(pool, 'revoke-action-second');
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await updateSessionRevocation(revoker, second.actor.sessionId);
      const actionAfterRevocation = new PlatformCapacityPolicyService(new ScopedSaasDatabase(pool)).setTenantPolicy(
        writeInput(second),
      );
      await waitForAdvisoryWaiter(pool);
      await revoker.query('COMMIT');
      await expectForbidden(actionAfterRevocation);
    } finally {
      revoker.release();
    }

    const roleInsert = await seedActor(pool, 'role-insert');
    const insertingRole = await pool.connect();
    try {
      await insertingRole.query('BEGIN');
      await insertingRole.query(`INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, 'finance')`, [
        roleInsert.actor.userId,
      ]);
      const actionAfterInsert = new PlatformCapacityPolicyService(new ScopedSaasDatabase(pool)).setTenantPolicy(
        writeInput(roleInsert),
      );
      await waitForAdvisoryWaiter(pool);
      await insertingRole.query('COMMIT');
      await expectForbidden(actionAfterInsert);
    } finally {
      insertingRole.release();
    }

    const roleDelete = await seedActor(pool, 'role-delete');
    const deletingRole = await pool.connect();
    try {
      await deletingRole.query('BEGIN');
      await deletingRole.query(
        `DELETE FROM saas_platform_role_assignments WHERE user_id = $1 AND role = 'operations'`,
        [roleDelete.actor.userId],
      );
      const actionAfterDelete = new PlatformCapacityPolicyService(new ScopedSaasDatabase(pool)).setTenantPolicy(
        writeInput(roleDelete),
      );
      await waitForAdvisoryWaiter(pool);
      await deletingRole.query('COMMIT');
      await expectForbidden(actionAfterDelete);
    } finally {
      deletingRole.release();
    }

    const disabled = await seedActor(pool, 'disabled');
    await pool.query(`UPDATE saas_users SET disabled_at = clock_timestamp() WHERE id = $1`, [disabled.actor.userId]);
    await expectForbidden(
      new PlatformCapacityPolicyService(new ScopedSaasDatabase(pool)).setTenantPolicy(writeInput(disabled)),
    );

    const mfaRevoked = await seedActor(pool, 'mfa-revoked');
    await pool.query(`UPDATE saas_mfa_credentials SET revoked_at = clock_timestamp() WHERE id = $1`, [
      mfaRevoked.credentialId,
    ]);
    await expectForbidden(
      new PlatformCapacityPolicyService(new ScopedSaasDatabase(pool)).setTenantPolicy(writeInput(mfaRevoked)),
    );

    const timeoutActor = await seedActor(pool, 'lock-timeout');
    const timeoutLock = await pool.connect();
    try {
      await timeoutLock.query('BEGIN');
      await timeoutLock.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        timeoutActor.actor.userId,
      ]);
      await assert.rejects(
        new PlatformCapacityPolicyService(new ScopedSaasDatabase(pool)).setTenantPolicy(writeInput(timeoutActor)),
        (error: unknown) => {
          assert.ok(error instanceof CapacityPolicyError);
          assert.equal(error.code, 'STORAGE_ERROR');
          return true;
        },
      );
    } finally {
      await timeoutLock.query('ROLLBACK');
      timeoutLock.release();
    }
    const unchanged = await pool.query<{ readonly capacity_policy_revision: unknown }>(
      `SELECT capacity_policy_revision FROM saas_tenants WHERE id = $1`,
      [timeoutActor.tenantId],
    );
    assert.equal(unchanged.rows[0]?.capacity_policy_revision, '1');
  });
});

test('PostgreSQL prepared-evidence guard accepts project-service key proof without principal membership', {
  skip: !realPostgresUrl,
}, async () => {
  await withScopedPostgresSchema(async (pool) => {
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const creatorId = randomUUID();
    const entitlementId = randomUUID();
    const apiKeyId = randomUUID();

    await pool.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $3)', [
      tenantId,
      'Project service evidence test',
      `project-service-${tenantId}`,
    ]);
    await pool.query('INSERT INTO saas_users (id, email) VALUES ($1, $2)', [
      creatorId,
      `project-service-creator-${creatorId}@example.test`,
    ]);
    await pool.query('INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
      tenantId,
      creatorId,
      'owner',
    ]);
    await pool.query(
      `INSERT INTO saas_projects
         (tenant_id, id, name, slug, inference_policy_version, inference_policy_status)
       VALUES ($1, $2, $3, $4, 2, 'active')`,
      [tenantId, projectId, 'Project service', `project-service-${projectId}`],
    );
    await pool.query(
      `INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes)
       VALUES ($1, 'service-profile', 'platform', ARRAY['model-a'])`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO saas_project_entitlements
         (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
       VALUES ($1, $2, $3, 'service-profile', 'platform', ARRAY['model-a'])`,
      [entitlementId, tenantId, projectId],
    );
    await pool.query(
      `INSERT INTO saas_api_keys
         (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
          name, prefix, key_hash, model_scopes, entitlement_id, execution_principal_type,
          execution_principal_id, created_by_user_id, entitlement_authz_version,
          supply_profile_authz_version)
       VALUES ($1, $2, $3, NULL, 'service-profile', 'platform', 'service key',
          'mr_live_projectservice', repeat('a', 64), ARRAY['model-a'], $4,
          'project_service', $3, $5, 1, 1)`,
      [apiKeyId, tenantId, projectId, entitlementId, creatorId],
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_prepared_request_evidence
           (id, tenant_id, project_id, request_id, attempt_id, attempt_ordinal,
            proxy_key_id, entitlement_id, entitlement_version, supply_profile_id,
            supply_profile_version, model_scope_version, supply_mode, principal_kind,
            principal_id, authz_version, config_version, project_policy_version)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 1, 'service-profile', 1, 1,
                 'platform', 'project_service', $3, 1, 1, 2)`,
        [randomUUID(), tenantId, projectId, randomUUID(), randomUUID(), apiKeyId, entitlementId],
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Prepared-request evidence request is missing/);
        assert.doesNotMatch(error.message, /project-service prepared-request evidence is unsupported/i);
        return true;
      },
    );
  });
});
