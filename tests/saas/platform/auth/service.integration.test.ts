import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { type CredentialKeyProvider, encryptCredential } from '../../../../src/saas/credentials/crypto.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import { SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL } from '../../../../src/saas/db/advisory-lock-keys.js';
import { runSaasMigrations } from '../../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/043_customer_webhook_delivery.js';
import { PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/044_project_service_key_authorization.js';
import { BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/045_byok_refund_entitlement_effect.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import type {
  SaasDatabase,
  SaasDatabaseClient,
  SaasDatabasePool,
  SqlExecutor,
  SqlResult,
} from '../../../../src/saas/db/types.js';
import { PlatformAuthError } from '../../../../src/saas/platform/auth/errors.js';
import { PlatformAdminAuthService } from '../../../../src/saas/platform/auth/service.js';
import { generateTotpSecret, totpCode } from '../../../../src/saas/platform/auth/totp.js';

const realPostgresUrl = process.env.SAAS_TEST_DATABASE_URL;
const authFenceMigrations = [
  ...SAAS_MIGRATIONS.filter(({ version }) => version < 43),
  CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION,
  PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION,
  BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION,
  PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
];

// This legacy owner-schema fixture is not the restricted-role managed MFA
// gate. Keep its historical migration set intact; never apply 056 here.
function guardedPostgresUrl(): string {
  assert.ok(realPostgresUrl, 'SAAS_TEST_DATABASE_URL must explicitly identify the owned disposable fixture');
  let parsed: URL;
  let database: string;
  let username: string;
  try {
    parsed = new URL(realPostgresUrl);
    database = decodeURIComponent(parsed.pathname.slice(1));
    username = decodeURIComponent(parsed.username);
  } catch { throw new Error('Legacy auth fixture PostgreSQL URL is invalid; details redacted'); }
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'legacy auth fixture requires PostgreSQL');
  assert.ok(username.length > 0, 'legacy auth fixture requires an explicit schema-owner principal');
  assert.ok(parsed.search === '' && parsed.hash === '', 'legacy auth fixture must not contain connection overrides or fragments');
  const hostname = parsed.hostname.toLowerCase();
  const port = Number(parsed.port);
  const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
  const local = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port)
    && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port)
    && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
  assert.ok(ci || local,
    'legacy auth fixture requires designated CI postgres/model_router_saas_ci or an owned disposable exact-loopback database on an explicit nondefault port');
  return realPostgresUrl;
}

class ScopedClient implements SaasDatabaseClient {
  constructor(private readonly client: import('pg').PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values ? [...values] : undefined);
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

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      const result = await client.query(sql, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
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

  async end(): Promise<void> {
    await this.pool.end();
  }
}

async function withScopedPostgresSchema<T>(work: (pool: ScopedPool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: guardedPostgresUrl(), max: 4 });
  const schema = `saas_platform_auth_lock_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    return await work(new ScopedPool(pool, schema));
  } finally {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
}

function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64, {
    N: 1 << 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

type BlockingStage = 'issuance-writer' | 'user-reader' | 'provisional-session' | 'confirmation-setup';

function blockingStage(statement: string): BlockingStage | undefined {
  if (statement === SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL.toLowerCase()) return 'issuance-writer';
  if (statement.startsWith('select pg_advisory_xact_lock_shared(')) return 'user-reader';
  if (statement.startsWith('insert into saas_platform_sessions')) return 'provisional-session';
  if (statement.includes('from saas_platform_mfa_setup_tokens s') && statement.includes('for update of s')) return 'confirmation-setup';
  return undefined;
}

function observeTransactionalQueries(database: SaasDatabase): {
  database: SaasDatabase;
  waitUntilBlocked(stages: readonly BlockingStage[], pool: ScopedPool, blocker: SaasDatabaseClient): Promise<void>;
} {
  const activeQueries = new Map<number, BlockingStage>();
  const observed: SaasDatabase = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      return database.query<Row>(sql, values);
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        let backendPid: number | undefined;
        return work({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
            // Do not take a snapshot before the service's SET TRANSACTION /
            // timeout preparation. Record the actual backend only afterward.
            if (backendPid === undefined && !statement.startsWith('set ')) {
              const identity = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
              const pid = identity.rows[0]?.pid;
              assert.ok(typeof pid === 'number' && Number.isInteger(pid) && pid > 0, 'the service must use a real PostgreSQL backend');
              backendPid = pid;
            }
            const stage = blockingStage(statement);
            if (backendPid !== undefined && stage) activeQueries.set(backendPid, stage);
            try { return await tx.query<Row>(sql, values); }
            finally { if (backendPid !== undefined) activeQueries.delete(backendPid); }
          },
        });
      });
    },
    migrate: () => database.migrate(),
    verifySchema: () => database.verifySchema(),
    ping: () => database.ping(),
    close: () => database.close(),
  };

  return {
    database: observed,
    async waitUntilBlocked(stages: readonly BlockingStage[], pool: ScopedPool, blocker: SaasDatabaseClient): Promise<void> {
      const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const blockerPid = identity.rows[0]?.pid;
      assert.ok(typeof blockerPid === 'number' && Number.isInteger(blockerPid) && blockerPid > 0, 'the fixture blocker must use a real PostgreSQL backend');
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        for (const [backendPid, stage] of activeQueries) {
          if (!stages.includes(stage)) continue;
          assert.notEqual(backendPid, blockerPid, 'service and fixture blocker must use distinct physical backends');
          const activity = await pool.query<{ blocked_by_fixture: boolean }>(
            'SELECT $2::integer = ANY(pg_catalog.pg_blocking_pids($1::integer)) AS blocked_by_fixture',
            [backendPid, blockerPid],
          );
          if (activity.rows[0]?.blocked_by_fixture === true) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('The service did not block at the expected stage behind the exact fixture backend');
    },
  };
}

async function holdAuthorizationFence(pool: ScopedPool, userId: string): Promise<SaasDatabaseClient> {
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await blocker.query("SET LOCAL lock_timeout = '2s'");
    await blocker.query("SET LOCAL statement_timeout = '10s'");
    await blocker.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    // Match 046's BEFORE STATEMENT -> exclusive user order. DELETE roles
    // below must reenter this writer lock, never acquire it after a user lock.
    await blocker.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
    return blocker;
  } catch (cause) {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release(true);
    throw cause;
  }
}

async function revokeRoleAndCommit(blocker: SaasDatabaseClient, userId: string): Promise<void> {
  const revoked = await blocker.query(
    `DELETE FROM saas_platform_role_assignments
     WHERE user_id = $1 AND role = 'superadmin'`,
    [userId],
  );
  assert.equal(revoked.rowCount, 1, 'the exact fixture superadmin assignment must really be revoked');
  await blocker.query('COMMIT');
}

test('PostgreSQL role revocation serializes MFA enrollment and login', { skip: !realPostgresUrl }, async () => {
  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, authFenceMigrations);

    const userId = randomUUID();
    const credentialId = randomUUID();
    const email = `platform-lock-${userId}@example.com`;
    const password = 'correct horse battery staple';
    const secret = generateTotpSecret();
    const key = Buffer.alloc(32, 7);
    const provider: CredentialKeyProvider = {
      getCurrentKey: () => ({ keyId: 'test-key', key: Buffer.from(key) }),
      getKey: () => Buffer.from(key),
    };
    const envelope = await encryptCredential(secret, { userId, provider: 'platform-totp', credentialId }, provider);
    const encryptedSecret = Buffer.from(JSON.stringify(envelope), 'utf8');
    await pool.query(
      `INSERT INTO saas_users (id, email, password_hash)
       VALUES ($1, $2, $3)`,
      [userId, email, passwordHash(password)],
    );
    await pool.query(
      `INSERT INTO saas_platform_role_assignments (user_id, role)
       VALUES ($1, 'superadmin')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO saas_mfa_credentials
         (id, user_id, kind, encrypted_secret, verified_at)
       VALUES ($1, $2, 'totp', $3, now())`,
      [credentialId, userId, encryptedSecret],
    );

    if (!realPostgresUrl) throw new Error('SAAS_TEST_DATABASE_URL is required');
    const database = createSaasDatabase({ connectionString: realPostgresUrl, pool });
    const observed = observeTransactionalQueries(database);
    let currentTime = new Date(Date.now() + 5_000);
    const service = new PlatformAdminAuthService(observed.database, provider, {
      now: () => new Date(currentTime),
      enrollmentTokenTtlSeconds: 60,
      confirmationTokenTtlSeconds: 60,
      sessionTtlSeconds: 3600,
    });

    const enrollmentBlocker = await holdAuthorizationFence(pool, userId);
    const enrollmentPromise = service.issueMfaEnrollmentToken(email);
    void enrollmentPromise.catch(() => undefined);
    let enrollmentBlockerCommitted = false;
    try {
      await observed.waitUntilBlocked(['issuance-writer'], pool, enrollmentBlocker);
      await revokeRoleAndCommit(enrollmentBlocker, userId);
      enrollmentBlockerCommitted = true;
      await assert.rejects(
        enrollmentPromise,
        (error: unknown) => error instanceof PlatformAuthError && error.code === 'MFA_ENROLLMENT_UNAVAILABLE' && error.status === 403,
      );
      const enrollments = await pool.query<{ id: string }>('SELECT id FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1', [userId]);
      assert.equal(enrollments.rows.length, 0, 'a revoked issuer target must receive no enrollment token');
    } finally {
      if (!enrollmentBlockerCommitted) await enrollmentBlocker.query('ROLLBACK').catch(() => undefined);
      enrollmentBlocker.release();
      await enrollmentPromise.catch(() => undefined);
    }

    await pool.query(
      `INSERT INTO saas_platform_role_assignments (user_id, role)
       VALUES ($1, 'superadmin')`,
      [userId],
    );
    const loginBlocker = await holdAuthorizationFence(pool, userId);
    const loginPromise = service.login(email, password, totpCode(secret, currentTime.getTime()));
    void loginPromise.catch(() => undefined);
    let loginBlockerCommitted = false;
    try {
      // Depending on which service transaction is in flight, login waits at
      // the authority reader or at INSERT's BEFORE STATEMENT writer trigger.
      // Never require the later shared recheck while INSERT is already blocked.
      await observed.waitUntilBlocked(['user-reader', 'provisional-session'], pool, loginBlocker);
      await revokeRoleAndCommit(loginBlocker, userId);
      loginBlockerCommitted = true;
      assert.equal(await loginPromise, undefined);
      const sessions = await pool.query<{ id: string }>('SELECT id FROM saas_platform_sessions');
      assert.equal(sessions.rows.length, 0);
    } finally {
      if (!loginBlockerCommitted) await loginBlocker.query('ROLLBACK').catch(() => undefined);
      loginBlocker.release();
      await loginPromise.catch(() => undefined);
    }

    const confirmationUserId = randomUUID();
    const confirmationEmail = `platform-confirm-lock-${confirmationUserId}@example.com`;
    await pool.query(
      `INSERT INTO saas_users (id, email, password_hash)
       VALUES ($1, $2, $3)`,
      [confirmationUserId, confirmationEmail, passwordHash(password)],
    );
    await pool.query(
      `INSERT INTO saas_platform_role_assignments (user_id, role)
       VALUES ($1, 'superadmin')`,
      [confirmationUserId],
    );
    currentTime = new Date(Date.now() + 5_000);
    const enrollmentToken = await service.issueMfaEnrollmentToken(confirmationEmail);
    const enrollmentStart = await service.beginMfaEnrollment(enrollmentToken.token, 'Model Router');
    const enrollmentSecret = new URL(enrollmentStart.otpauthUri).searchParams.get('secret');
    assert.ok(enrollmentSecret);
    const expiresAt = Date.parse(enrollmentStart.expiresAt);
    currentTime = new Date(expiresAt - 100);

    const setupLock = await pool.connect();
    await setupLock.query('BEGIN');
    await setupLock.query(
      `SELECT id
       FROM saas_platform_mfa_setup_tokens
       WHERE user_id = $1 AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [confirmationUserId],
    );
    const codeBeforeExpiry = totpCode(enrollmentSecret, currentTime.getTime());
    const confirmationPromise = service.confirmMfaEnrollment(enrollmentStart.confirmationToken, codeBeforeExpiry);
    void confirmationPromise.catch(() => undefined);
    let setupLockCommitted = false;
    try {
      await observed.waitUntilBlocked(['confirmation-setup'], pool, setupLock);
      currentTime = new Date(expiresAt + 1);
      await setupLock.query('COMMIT');
      setupLockCommitted = true;
      await assert.rejects(
        confirmationPromise,
        (error: unknown) => error instanceof PlatformAuthError && error.code === 'MFA_CONFIRMATION_INVALID',
      );
      const credentialRows = await pool.query<{ verified_at: Date | null }>(
        `SELECT verified_at FROM saas_mfa_credentials WHERE user_id = $1`,
        [confirmationUserId],
      );
      assert.equal(credentialRows.rows.length, 1);
      assert.equal(credentialRows.rows[0]?.verified_at, null);
      const setupRows = await pool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM saas_platform_mfa_setup_tokens WHERE user_id = $1`,
        [confirmationUserId],
      );
      assert.equal(setupRows.rows.length, 1);
      assert.equal(setupRows.rows[0]?.consumed_at, null);
      const sessions = await pool.query<{ id: string }>(`SELECT id FROM saas_platform_sessions WHERE user_id = $1`, [
        confirmationUserId,
      ]);
      assert.equal(sessions.rows.length, 0);
    } finally {
      if (!setupLockCommitted) await setupLock.query('ROLLBACK').catch(() => undefined);
      setupLock.release();
      await confirmationPromise.catch(() => undefined);
    }

    encryptedSecret.fill(0);
    key.fill(0);
  });
});
