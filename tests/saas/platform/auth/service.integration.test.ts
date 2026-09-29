import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { type CredentialKeyProvider, encryptCredential } from '../../../../src/saas/credentials/crypto.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
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
  if (!realPostgresUrl) throw new Error('SAAS_TEST_DATABASE_URL is required');
  const pool = new Pool({ connectionString: realPostgresUrl, max: 4 });
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

function observeTransactionalQueries(database: SaasDatabase): {
  database: SaasDatabase;
  waitUntilBlocked(fragment: string, pool: ScopedPool): Promise<void>;
} {
  let waiter: { fragment: string; resolve: () => void } | undefined;
  let backendPid: number | undefined;
  const observed: SaasDatabase = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      return database.query<Row>(sql, values);
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        const process = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        backendPid = Number(process.rows[0]?.pid);
        return work({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const pending = waiter;
            if (pending && sql.toLowerCase().includes(pending.fragment)) {
              waiter = undefined;
              pending.resolve();
            }
            return tx.query<Row>(sql, values);
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
    async waitUntilBlocked(fragment: string, pool: ScopedPool): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiter?.fragment === fragment) waiter = undefined;
          reject(new Error(`Timed out waiting for PostgreSQL query fragment: ${fragment}`));
        }, 3_000);
        waiter = {
          fragment,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
      });

      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (backendPid === undefined) throw new Error('The PostgreSQL service backend PID was not recorded');
        const activity = await pool.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
          [backendPid],
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`PostgreSQL backend ${backendPid ?? 'unknown'} did not block on a lock`);
    },
  };
}

async function holdAuthorizationFence(pool: ScopedPool, userId: string): Promise<SaasDatabaseClient> {
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
  return blocker;
}

async function revokeRoleAndCommit(blocker: SaasDatabaseClient, userId: string): Promise<void> {
  await blocker.query(
    `DELETE FROM saas_platform_role_assignments
     WHERE user_id = $1 AND role = 'superadmin'`,
    [userId],
  );
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
    try {
      await observed.waitUntilBlocked('pg_advisory_xact_lock_shared', pool);
      await revokeRoleAndCommit(enrollmentBlocker, userId);
      await assert.rejects(
        enrollmentPromise,
        (error: unknown) => error instanceof PlatformAuthError && error.code === 'MFA_ENROLLMENT_UNAVAILABLE',
      );
    } finally {
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
    try {
      await observed.waitUntilBlocked('pg_advisory_xact_lock_shared', pool);
      await revokeRoleAndCommit(loginBlocker, userId);
      assert.equal(await loginPromise, undefined);
      const sessions = await pool.query<{ id: string }>('SELECT id FROM saas_platform_sessions');
      assert.equal(sessions.rows.length, 0);
    } finally {
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
    let setupLockCommitted = false;
    try {
      await observed.waitUntilBlocked('for update of s', pool);
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
