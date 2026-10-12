import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { CustomerPasskeyService } from '../../../src/saas/identity/customer-passkey-service.js';
import { CustomerPasskeyError } from '../../../src/saas/identity/customer-passkey-types.js';
import { hashPassword } from '../../../src/saas/identity/password.js';
import {
  assertionPayload,
  registrationPayload,
  SIM_ORIGIN,
  SIM_RP_ID,
  simulatePasskey,
} from './customer-passkey-simulator.js';

// Real-PG proof for the E2 customer passkey ceremonies: the restricted
// control-plane role executes registration, assertion (with counter advance
// and clone rejection), removal and the challenge single-use ledger against
// actual triggers/CHECKs/advisory fences from migration 085. Same required
// gate and target contract as the tenant member suites. HTTP envelope
// coverage stays in the unit tests; this file never claims browser evidence.
const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configuredUrls = roleConfig.map(([name]) => process.env[name]?.trim());
const anyConfigured = configuredUrls.some(Boolean);

function safeTargets(): string[] {
  let target: string | undefined;
  const urls = roleConfig.map(([name, role], index) => {
    const value = configuredUrls[index];
    assert.ok(value, `${name} is required for the customer passkey PostgreSQL gate`);
    const parsed = new URL(value);
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL protocol required');
    assert.equal(decodeURIComponent(parsed.username), role, 'exact managed role required');
    assert.equal(parsed.search, '');
    assert.equal(parsed.hash, '');
    const hostname = parsed.hostname.toLowerCase();
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local =
      ['127.0.0.1', '[::1]'].includes(hostname) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432, 53782].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, 'designated CI target or exact loopback disposable database required');
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity;
    assert.equal(identity, target, 'all roles must use the same guarded disposable database');
    return value;
  });
  return urls;
}

const PASSWORD = 'customer-passkey-pg-fixture-not-a-real-password';
/** KMS is never touched: no TOTP factor is seeded in this suite. */
const neverKeys = {
  async getCurrentKey(): Promise<never> {
    throw new Error('KMS lookup must never run without a TOTP factor');
  },
  async getKey(): Promise<never> {
    throw new Error('KMS lookup must never run without a TOTP factor');
  },
  async checkReady(): Promise<void> {},
  async close(): Promise<void> {},
};

interface Account {
  userId: string;
  proof: { sessionToken: string; csrfToken: string; requestId: string };
}

/** Fresh synthetic customer with one live session; hashes are sha256 like the login path. */
async function seedAccount(migrator: SaasDatabase): Promise<Account> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(24).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const passwordHash = await hashPassword(PASSWORD);
  await migrator.transaction(async (tx: SqlExecutor) => {
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query('INSERT INTO saas_users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)', [
      userId,
      `passkey-pg-${randomUUID()}@example.test`,
      'Passkey fixture',
      passwordHash,
    ]);
    await tx.query(
      `INSERT INTO saas_sessions (id, user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 hour')`,
      [sessionId, userId, sha256(sessionToken), sha256(csrfToken)],
    );
  });
  return { userId, proof: { sessionToken, csrfToken, requestId: randomUUID() } };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function expectPasskeyCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (cause: unknown) => {
    assert.ok(cause instanceof CustomerPasskeyError, 'safe passkey error required, never a raw PG error');
    assert.equal(cause.code, code);
    return true;
  });
}

async function expectPgCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (cause: unknown) => {
    assert.equal((cause as { code?: unknown })?.code, code, `PostgreSQL SQLSTATE ${code} required`);
    return true;
  });
}

test('customer passkeys: actual PG restricted control-plane ceremonies, counter and ledger guards', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
      ? `offline skip: set ${REQUIRED_FLAG}=1 and the disposable MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs`
      : false,
  timeout: 180_000,
}, async (t) => {
  const [migratorUrl, controlUrl] = safeTargets();
  const migrator = createSaasDatabase({ connectionString: migratorUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const control = createSaasDatabase({ connectionString: controlUrl, max: 1, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await control.close();
    await migrator.close();
  });
  await migrator.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
  const service = new CustomerPasskeyService(control, {
    keyProvider: neverKeys,
    rpId: SIM_RP_ID,
    rpName: 'Passkey PostgreSQL Gate',
    origins: [SIM_ORIGIN],
  });
  await service.checkReady();

  await t.test('registration, assertion counter advance, clone rejection and removal persist with audit', async () => {
    const account = await seedAccount(migrator);
    const key = simulatePasskey();
    const start = await service.startRegistration(account.proof, { password: PASSWORD });
    assert.match(start.challenge, /^[A-Za-z0-9_-]{43}$/);
    await expectPasskeyCode(
      service.startRegistration({ ...account.proof, requestId: randomUUID() }, { password: PASSWORD }),
      'CEREMONY_INVALID',
    );
    const changed = await service.finishRegistration(account.proof, {
      password: PASSWORD,
      challenge: start.challenge,
      credential: registrationPayload(key, start.challenge),
    });
    assert.equal(changed.credentialId, key.credentialId);
    assert.equal(changed.sessionsRevoked >= 1, true);

    // The consumed challenge is dead even with a fresh session.
    const relogin = await seedAccountSession(migrator, account.userId);
    await expectPasskeyCode(
      service.finishRegistration(relogin, {
        password: PASSWORD,
        challenge: start.challenge,
        credential: registrationPayload(key, start.challenge),
      }),
      'CEREMONY_INVALID',
    );
    const stored = await control.query<{ sign_count: string | null }>(
      `SELECT sign_count::text FROM saas_mfa_credentials
       WHERE user_id = $1 AND kind = 'passkey' AND credential_id = $2`,
      [account.userId, key.credentialId],
    );
    assert.equal(stored.rows.length, 1);

    const assertionStart = await service.startAssertion(relogin, {
      password: PASSWORD,
      credentialId: key.credentialId,
    });
    const verified = await service.finishAssertion(relogin, {
      password: PASSWORD,
      challenge: assertionStart.challenge,
      credential: assertionPayload(key, assertionStart.challenge, 7),
    });
    assert.deepEqual(verified, { verified: true, credentialId: key.credentialId });
    const advanced = await control.query<{ sign_count: string }>(
      `SELECT sign_count::text FROM saas_mfa_credentials
       WHERE user_id = $1 AND kind = 'passkey' AND credential_id = $2`,
      [account.userId, key.credentialId],
    );
    assert.equal(advanced.rows[0]?.sign_count, '7');

    // Equal nonzero counter on a new ceremony is a cloned-authenticator signal.
    const second = await service.startAssertion(relogin, { password: PASSWORD, credentialId: key.credentialId });
    await expectPasskeyCode(
      service.finishAssertion(
        { ...relogin, requestId: randomUUID() },
        {
          password: PASSWORD,
          challenge: second.challenge,
          credential: assertionPayload(key, second.challenge, 7),
        },
      ),
      'PASSKEY_REJECTED',
    );

    const removed = await service.remove(relogin, { password: PASSWORD, credentialId: key.credentialId });
    assert.equal(removed.credentialId, key.credentialId);
    assert.equal(removed.sessionsRevoked >= 1, true);
    const audit = await control.query<{ action: string }>(
      `SELECT action FROM saas_audit_events
       WHERE actor_user_id = $1 AND entry_point = 'customer_passkey' ORDER BY occurred_at, action`,
      [account.userId],
    );
    const actions = audit.rows.map((row) => row.action);
    assert.ok(actions.includes('customer_passkey.start-registration.started'));
    assert.ok(actions.includes('customer_passkey.finish-registration.completed'));
    assert.ok(actions.includes('customer_passkey.finish-assertion.completed'));
    assert.ok(actions.includes('customer_passkey.remove.completed'));
  });

  await t.test('085 guard family rejects history deletion, illegal transitions and authority breaks', async () => {
    const account = await seedAccount(migrator);
    const key = simulatePasskey();
    const start = await service.startRegistration(account.proof, { password: PASSWORD });
    await service.finishRegistration(account.proof, {
      password: PASSWORD,
      challenge: start.challenge,
      credential: registrationPayload(key, start.challenge),
    });

    // Ceremony history is permanent: the restricted role is refused by the ACL
    // layer first, and even the migrator owner hits the 55000 guard trigger.
    await expectPgCode(
      control.query('DELETE FROM saas_customer_passkey_ceremonies WHERE user_id = $1', [account.userId]),
      '42501',
    );
    await expectPgCode(
      migrator.query('DELETE FROM saas_customer_passkey_ceremonies WHERE user_id = $1', [account.userId]),
      '55000',
    );
    // Non-granted columns fail at the ACL layer; the granted closed_at
    // transition reaches the guard and consumed rows stay immutable.
    await expectPgCode(
      control.query(`UPDATE saas_customer_passkey_ceremonies SET challenge_hash = repeat('0', 64) WHERE user_id = $1`, [
        account.userId,
      ]),
      '42501',
    );
    await expectPgCode(
      migrator.query(
        `UPDATE saas_customer_passkey_ceremonies SET challenge_hash = repeat('0', 64) WHERE user_id = $1`,
        [account.userId],
      ),
      '23514',
    );
    await expectPgCode(
      control.query(`UPDATE saas_customer_passkey_ceremonies SET closed_at = NULL WHERE user_id = $1`, [
        account.userId,
      ]),
      '23514',
    );

    // A new pending ceremony cannot pre-bind a credential or a platform user.
    const relogin = await seedAccountSession(migrator, account.userId);
    const digest = sha256(relogin.sessionToken);
    const sessionId = (
      await control.query<{ id: string }>('SELECT id FROM saas_sessions WHERE token_hash = $1', [digest])
    ).rows[0]?.id;
    assert.ok(sessionId);
    const passwordDigest = (
      await control.query<{ password_hash: string }>('SELECT password_hash FROM saas_users WHERE id = $1', [
        account.userId,
      ])
    ).rows[0]?.password_hash;
    assert.ok(passwordDigest);
    await expectPgCode(
      control.query(
        `INSERT INTO saas_customer_passkey_ceremonies
          (id, user_id, session_id, ceremony, challenge_hash, credential_id, password_digest, expires_at)
         VALUES ($1, $2, $3, 'registration', $4, $5, $6, clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), account.userId, sessionId, sha256(randomUUID()), key.credentialId, sha256(passwordDigest)],
      ),
      '23514',
    );
    await expectPgCode(
      control.query(
        `INSERT INTO saas_customer_passkey_ceremonies
          (id, user_id, session_id, ceremony, challenge_hash, password_digest, expires_at)
         VALUES ($1, $2, $3, 'registration', $4, $5, clock_timestamp() - interval '1 minute')`,
        [randomUUID(), account.userId, sessionId, sha256(randomUUID()), sha256(passwordDigest)],
      ),
      '23514',
    );

    // sign_count stays passkey-only and non-negative at the CHECK layer.
    await expectPgCode(
      control.query(
        `INSERT INTO saas_mfa_credentials (id, user_id, kind, encrypted_secret, sign_count)
         VALUES ($1, $2, 'totp', '\\x01', 0)`,
        [randomUUID(), account.userId],
      ),
      '23514',
    );
    await expectPgCode(
      control.query(
        `UPDATE saas_mfa_credentials SET sign_count = -1
         WHERE user_id = $1 AND kind = 'passkey'`,
        [account.userId],
      ),
      '23514',
    );
  });

  await t.test('platform accounts can never hold a ceremony, even with a live session', async () => {
    const account = await seedAccount(migrator);
    await migrator.query('INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, $2)', [
      account.userId,
      'operations',
    ]);
    await expectPasskeyCode(service.list(account.proof), 'MFA_STATE_CONFLICT');
    await expectPasskeyCode(service.startRegistration(account.proof, { password: PASSWORD }), 'MFA_STATE_CONFLICT');
    const count = await control.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM saas_customer_passkey_ceremonies WHERE user_id = $1',
      [account.userId],
    );
    assert.equal(count.rows[0]?.n, '0');
  });
});

/** Additional live session for an existing customer (post factor-change revocation). */
async function seedAccountSession(
  migrator: SaasDatabase,
  userId: string,
): Promise<{ sessionToken: string; csrfToken: string; requestId: string }> {
  const sessionToken = randomBytes(24).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  await migrator.query(
    `INSERT INTO saas_sessions (id, user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 hour')`,
    [randomUUID(), userId, sha256(sessionToken), sha256(csrfToken)],
  );
  return { sessionToken, csrfToken, requestId: randomUUID() };
}
