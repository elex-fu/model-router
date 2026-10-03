import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import type { CredentialKeyProvider } from '../../../../src/saas/credentials/crypto.js';
import { PlatformAuthError } from '../../../../src/saas/platform/auth/errors.js';
import { PlatformAdminAuthService } from '../../../../src/saas/platform/auth/service.js';
import { totpCode } from '../../../../src/saas/platform/auth/totp.js';

type QueryResult<Row> = { rows: Row[]; rowCount: number | null };

interface QueryTrace {
  statement: string;
  values: readonly unknown[];
  transactionId: number | undefined;
}

const SUPPORTED_PLATFORM_ROLES = new Set(['superadmin', 'security', 'finance', 'operations', 'support-readonly']);

interface UserState {
  id: string;
  email: string;
  email_canonical: string;
  password_hash: string;
  disabled_at: string | null;
}

interface CredentialState {
  id: string;
  user_id: string;
  encrypted_secret: Buffer;
  verified_at: string | null;
  revoked_at: string | null;
  last_used_step: number | null;
}

interface FakeState {
  users: UserState[];
  roles: Array<{ user_id: string; role: string }>;
  credentials: CredentialState[];
  enrollmentTokens: Array<Record<string, unknown>>;
  setupTokens: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  auditEvents: Array<readonly unknown[]>;
}

function result<Row>(rows: Row[] = []): QueryResult<Row> {
  return { rows: structuredClone(rows), rowCount: rows.length };
}

function hasEligiblePlatformRoles(state: FakeState, userId: string): boolean {
  const roles = state.roles.filter((role) => role.user_id === userId);
  return roles.length > 0 && roles.every((role) => SUPPORTED_PLATFORM_ROLES.has(role.role));
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

class FakePlatformDatabase {
  onQuery: ((statement: string) => void) | undefined;
  clock: () => Date = () => new Date('2026-01-02T03:04:05.000Z');
  readonly queries: QueryTrace[] = [];
  private transactionId: number | undefined;
  private nextTransactionId = 0;

  readonly state: FakeState = {
    users: [],
    roles: [],
    credentials: [],
    enrollmentTokens: [],
    setupTokens: [],
    sessions: [],
    auditEvents: [],
  };

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: FakePlatformDatabase) => Promise<T>): Promise<T> {
    const before = structuredClone(this.state);
    const previousTransactionId = this.transactionId;
    this.transactionId = ++this.nextTransactionId;
    try {
      return await work(this);
    } catch (error) {
      Object.assign(this.state, before);
      throw error;
    } finally {
      this.transactionId = previousTransactionId;
    }
  }

  async migrate(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<QueryResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queries.push({ statement, values: [...values], transactionId: this.transactionId });
    this.onQuery?.(statement);
    const [a, b, c, d, e, f, g] = values;

    if (
      statement.startsWith('set transaction isolation level') ||
      statement.startsWith('set local ') ||
      statement.startsWith('select pg_advisory_xact_lock_shared') ||
      statement === 'select pg_advisory_xact_lock(1396788563, 46)' ||
      statement === 'select pg_advisory_xact_lock(hashtextextended($1::text, 0))'
    ) {
      return result<Row>();
    }

    if (statement.startsWith('select id from saas_users where email_canonical =')) {
      const user = this.state.users.find((candidate) => candidate.email_canonical === a);
      return result<Row>(user ? [{ id: user.id } as Row] : []);
    }

    if (statement.startsWith('select u.id from saas_users u where u.id =')) {
      const user = this.state.users.find(
        (candidate) =>
          candidate.id === a && candidate.disabled_at === null && hasEligiblePlatformRoles(this.state, candidate.id),
      );
      return result<Row>(user ? [{ id: user.id } as Row] : []);
    }

    if (statement.startsWith('select u.email_canonical as email from saas_users u')) {
      const user = this.state.users.find(
        (candidate) =>
          candidate.id === a && candidate.disabled_at === null && hasEligiblePlatformRoles(this.state, candidate.id),
      );
      return result<Row>(user ? [{ email: user.email_canonical } as Row] : []);
    }

    if (statement.startsWith('select u.id, u.password_hash from saas_users u')) {
      const user = this.state.users.find(
        (candidate) =>
          candidate.email_canonical === a &&
          candidate.disabled_at === null &&
          hasEligiblePlatformRoles(this.state, candidate.id),
      );
      return result<Row>(user ? [{ id: user.id, password_hash: user.password_hash } as Row] : []);
    }

    if (statement.startsWith('select u.id, u.email_canonical as email, u.display_name')) {
      const user = this.state.users.find(
        (candidate) =>
          candidate.email_canonical === a &&
          candidate.disabled_at === null &&
          hasEligiblePlatformRoles(this.state, candidate.id),
      );
      return result<Row>(
        user
          ? [
              {
                id: user.id,
                email: user.email_canonical,
                display_name: null,
                password_hash: user.password_hash,
                disabled_at: null,
                email_verified_at: null,
                created_at: '2026-01-02T03:04:05.000Z',
              } as Row,
            ]
          : [],
      );
    }

    if (statement.startsWith('select u.id from saas_users u join saas_platform_role_assignments')) {
      const user = this.state.users.find(
        (candidate) =>
          candidate.email_canonical === a &&
          candidate.disabled_at === null &&
          hasEligiblePlatformRoles(this.state, candidate.id),
      );
      return result<Row>(user ? [{ id: user.id } as Row] : []);
    }

    if (statement.startsWith('select id from saas_mfa_credentials')) {
      if (statement.includes('where id = $1 and user_id = $2')) {
        const credential = this.state.credentials.find(
          (candidate) =>
            candidate.id === a &&
            candidate.user_id === b &&
            candidate.verified_at === c &&
            candidate.last_used_step === Number(d) &&
            candidate.revoked_at === null,
        );
        return result<Row>(credential ? [{ id: credential.id } as Row] : []);
      }
      const rows = this.state.credentials.filter((credential) => {
        if (credential.user_id !== a || credential.revoked_at !== null) return false;
        if (statement.includes('verified_at is not null')) return credential.verified_at !== null;
        return credential.verified_at === null;
      });
      return result<Row>(rows.slice(0, 1).map(({ id }) => ({ id }) as Row));
    }

    if (statement.startsWith('select id from saas_platform_mfa_enrollment_tokens')) {
      const now = new Date(String(b)).getTime();
      const rows = this.state.enrollmentTokens.filter(
        (token) =>
          token.user_id === a && token.consumed_at === null && new Date(String(token.expires_at)).getTime() > now,
      );
      return result<Row>(rows.slice(0, 1) as Row[]);
    }

    if (statement.startsWith('insert into saas_platform_mfa_enrollment_tokens')) {
      this.state.enrollmentTokens.push({
        id: a,
        user_id: b,
        token_hash: c,
        created_at: d,
        expires_at: e,
        consumed_at: null,
      });
      return result<Row>();
    }

    if (statement.startsWith('insert into saas_audit_events')) {
      this.state.auditEvents.push([...values]);
      return result<Row>([{ id: a } as Row]);
    }

    if (statement.startsWith('select e.id, e.user_id, e.expires_at')) {
      const token = this.state.enrollmentTokens.find(
        (candidate) => candidate.token_hash === a && candidate.consumed_at === null,
      );
      return result<Row>(token ? [{ id: token.id, user_id: token.user_id, expires_at: token.expires_at } as Row] : []);
    }

    if (statement.startsWith('insert into saas_mfa_credentials')) {
      this.state.credentials.push({
        id: a as string,
        user_id: b as string,
        encrypted_secret: Buffer.from(c as Uint8Array),
        verified_at: null,
        revoked_at: null,
        last_used_step: null,
      });
      return result<Row>();
    }

    if (statement.startsWith('with stale_credential as')) {
      const now = new Date(String(b)).getTime();
      for (const credential of [...this.state.credentials].sort((left, right) => left.id.localeCompare(right.id))) {
        const hasLiveSetup = this.state.setupTokens.some(
          (setup) =>
            setup.user_id === credential.user_id &&
            setup.credential_id === credential.id &&
            setup.consumed_at === null &&
            setup.locked_at === null &&
            new Date(String(setup.expires_at)).getTime() > now,
        );
        if (
          credential.user_id === a &&
          credential.verified_at === null &&
          credential.revoked_at === null &&
          !hasLiveSetup
        ) {
          credential.revoked_at = b as string;
          break;
        }
      }
      return result<Row>();
    }

    if (statement.startsWith('update saas_platform_mfa_enrollment_tokens')) {
      const token = this.state.enrollmentTokens.find((candidate) => candidate.id === a);
      if (
        !token ||
        token.consumed_at !== null ||
        new Date(String(token.expires_at)).getTime() <= new Date(String(b)).getTime()
      ) {
        return result<Row>();
      }
      token.consumed_at = b;
      return result<Row>([{ id: token.id } as Row]);
    }

    if (statement.startsWith('insert into saas_platform_mfa_setup_tokens')) {
      this.state.setupTokens.push({
        id: a,
        user_id: b,
        credential_id: c,
        token_hash: d,
        attempt_count: 0,
        attempt_limit: e,
        created_at: f,
        expires_at: g,
        consumed_at: null,
        locked_at: null,
      });
      return result<Row>();
    }

    if (statement.startsWith('select c.id from saas_mfa_credentials c join saas_platform_mfa_setup_tokens s')) {
      const now = new Date(String(b)).getTime();
      const rows = this.state.credentials
        .filter(
          (credential) =>
            credential.user_id === a &&
            credential.verified_at === null &&
            credential.revoked_at === null &&
            this.state.setupTokens.some(
              (setup) =>
                setup.user_id === credential.user_id &&
                setup.credential_id === credential.id &&
                setup.consumed_at === null &&
                setup.locked_at === null &&
                new Date(String(setup.expires_at)).getTime() > now,
            ),
        )
        .slice(0, 1)
        .map(({ id }) => ({ id }) as Row);
      return result<Row>(rows);
    }

    if (statement.startsWith('select s.id, s.user_id, s.credential_id, c.encrypted_secret')) {
      const setup = this.state.setupTokens.find(
        (candidate) => candidate.token_hash === a && candidate.consumed_at === null && candidate.locked_at === null,
      );
      const credential = setup
        ? this.state.credentials.find(
            (candidate) =>
              candidate.id === setup.credential_id &&
              candidate.user_id === setup.user_id &&
              candidate.verified_at === null &&
              candidate.revoked_at === null,
          )
        : undefined;
      return result<Row>(
        setup && credential
          ? [
              {
                id: setup.id,
                user_id: setup.user_id,
                credential_id: setup.credential_id,
                encrypted_secret: Buffer.from(credential.encrypted_secret),
                attempt_count: setup.attempt_count,
                attempt_limit: setup.attempt_limit,
                expires_at: setup.expires_at,
              } as Row,
            ]
          : [],
      );
    }

    if (statement.startsWith('select s.id from saas_platform_mfa_setup_tokens s join saas_mfa_credentials c')) {
      const setup = this.state.setupTokens.find(
        (candidate) =>
          candidate.id === a &&
          candidate.user_id === b &&
          candidate.credential_id === c &&
          candidate.consumed_at === null &&
          candidate.locked_at === null &&
          new Date(String(candidate.expires_at)).getTime() > this.clock().getTime(),
      );
      const credential =
        setup &&
        this.state.credentials.find(
          (candidate) =>
            candidate.id === c &&
            candidate.user_id === b &&
            candidate.verified_at === null &&
            candidate.revoked_at === null,
        );
      return result<Row>(setup && credential ? [{ id: setup.id } as Row] : []);
    }

    if (statement.startsWith('update saas_platform_mfa_setup_tokens set attempt_count')) {
      const setup = this.state.setupTokens.find((candidate) => candidate.id === a);
      if (setup && setup.consumed_at === null && setup.locked_at === null) {
        const next = Number(setup.attempt_count) + 1;
        setup.attempt_count = next;
        if (next >= Number(setup.attempt_limit)) setup.locked_at = b;
        return result<Row>([{ attempt_count: next } as Row]);
      }
      return result<Row>();
    }

    if (statement.startsWith('update saas_mfa_credentials set verified_at')) {
      const credential = this.state.credentials.find(
        (candidate) =>
          candidate.id === a &&
          candidate.user_id === d &&
          candidate.verified_at === null &&
          candidate.revoked_at === null,
      );
      if (!credential) return result<Row>();
      credential.verified_at = b as string;
      credential.last_used_step = Number(c);
      return result<Row>([{ id: credential.id } as Row]);
    }

    if (statement.startsWith('update saas_platform_mfa_setup_tokens set consumed_at')) {
      const now = new Date(String(b)).getTime();
      const setup = this.state.setupTokens.find(
        (candidate) =>
          candidate.id === a &&
          candidate.user_id === c &&
          candidate.credential_id === d &&
          candidate.consumed_at === null &&
          candidate.locked_at === null &&
          new Date(String(candidate.expires_at)).getTime() > now,
      );
      if (!setup) return result<Row>();
      setup.consumed_at = b;
      return result<Row>([{ id: setup.id } as Row]);
    }

    if (statement.startsWith('select c.id as credential_id, c.user_id, c.encrypted_secret')) {
      const rows = this.state.credentials
        .filter(
          (credential) =>
            credential.user_id === a &&
            credential.verified_at !== null &&
            credential.revoked_at === null &&
            this.state.users.some((user) => user.id === credential.user_id && user.disabled_at === null) &&
            hasEligiblePlatformRoles(this.state, credential.user_id),
        )
        .map(
          (credential) =>
            ({
              credential_id: credential.id,
              user_id: credential.user_id,
              encrypted_secret: Buffer.from(credential.encrypted_secret),
            }) as Row,
        );
      return result<Row>(rows);
    }

    if (statement.startsWith('select c.id from saas_mfa_credentials c join saas_users u')) {
      const credential = this.state.credentials.find(
        (candidate) =>
          candidate.id === a &&
          candidate.user_id === b &&
          candidate.verified_at !== null &&
          candidate.revoked_at === null &&
          candidate.last_used_step === Number(c),
      );
      const user = this.state.users.find(
        (candidate) =>
          candidate.id === b &&
          candidate.email_canonical === d &&
          candidate.password_hash === e &&
          candidate.disabled_at === null,
      );
      return result<Row>(
        credential && user && hasEligiblePlatformRoles(this.state, String(b)) ? [{ id: credential.id } as Row] : [],
      );
    }

    if (statement.startsWith('update saas_mfa_credentials set last_used_step')) {
      const credential = this.state.credentials.find((candidate) => candidate.id === a);
      const step = Number(b);
      if (
        !credential ||
        credential.verified_at === null ||
        credential.revoked_at !== null ||
        (credential.last_used_step !== null && credential.last_used_step >= step)
      ) {
        return result<Row>();
      }
      credential.last_used_step = step;
      return result<Row>([{ id: credential.id } as Row]);
    }

    if (statement.startsWith('insert into saas_platform_sessions')) {
      this.state.sessions.push({
        id: a,
        user_id: b,
        credential_id: c,
        token_hash: d,
        csrf_token_hash: e,
        created_at: f,
        expires_at: g,
        revoked_at: null,
      });
      return result<Row>();
    }

    if (statement.startsWith('select user_id from saas_platform_sessions')) {
      const session = this.state.sessions.find((candidate) => candidate.token_hash === a);
      return result<Row>(session ? [{ user_id: session.user_id } as Row] : []);
    }

    if (statement.startsWith('select s.id, s.user_id, s.created_at, s.expires_at')) {
      const now = this.clock().getTime();
      const session = this.state.sessions.find((candidate) => {
        if (candidate.token_hash !== a || candidate.user_id !== b || candidate.revoked_at !== null) return false;
        if (new Date(String(candidate.expires_at)).getTime() <= now) return false;
        const user = this.state.users.find((candidateUser) => candidateUser.id === candidate.user_id);
        const credential = this.state.credentials.find(
          (candidateCredential) => candidateCredential.id === candidate.credential_id,
        );
        return Boolean(
          user &&
            user.disabled_at === null &&
            credential &&
            credential.user_id === user.id &&
            credential.verified_at !== null &&
            credential.revoked_at === null &&
            hasEligiblePlatformRoles(this.state, user.id),
        );
      });
      return result<Row>(session ? [{ ...session } as Row] : []);
    }

    if (statement.startsWith('select s.csrf_token_hash')) {
      const now = this.clock().getTime();
      const session = this.state.sessions.find((candidate) => {
        if (
          candidate.token_hash !== a ||
          candidate.user_id !== b ||
          candidate.revoked_at !== null ||
          new Date(String(candidate.expires_at)).getTime() <= now
        ) {
          return false;
        }
        const user = this.state.users.find((entry) => entry.id === candidate.user_id);
        const credential = this.state.credentials.find((entry) => entry.id === candidate.credential_id);
        return Boolean(
          user &&
            user.disabled_at === null &&
            hasEligiblePlatformRoles(this.state, user.id) &&
            credential &&
            credential.user_id === user.id &&
            credential.verified_at !== null &&
            credential.revoked_at === null,
        );
      });
      return result<Row>(session ? [{ csrf_token_hash: session.csrf_token_hash } as Row] : []);
    }

    if (statement.startsWith('update saas_platform_sessions')) {
      const session = this.state.sessions.find((candidate) => candidate.token_hash === a);
      if (session && session.revoked_at === null) session.revoked_at = this.clock().toISOString();
      return result<Row>();
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

function createFixture(options: { maxAttempts?: number; advanceClockOnGetKeyTo?: string; role?: string | null } = {}) {
  const database = new FakePlatformDatabase();
  const userId = '00000000-0000-0000-0000-000000000001';
  const password = 'correct horse battery staple';
  database.state.users.push({
    id: userId,
    email: 'owner@example.com',
    email_canonical: 'owner@example.com',
    password_hash: passwordHash(password),
    disabled_at: null,
  });
  if (options.role !== null) {
    database.state.roles.push({ user_id: userId, role: options.role ?? 'superadmin' });
  }
  let currentTime = new Date('2026-01-02T03:04:05.000Z');
  database.clock = () => new Date(currentTime);
  const key = Buffer.alloc(32, 7);
  const provider: CredentialKeyProvider = {
    getCurrentKey: () => ({ keyId: 'test-key', key: Buffer.from(key) }),
    getKey: () => {
      if (options.advanceClockOnGetKeyTo) currentTime = new Date(options.advanceClockOnGetKeyTo);
      return Buffer.from(key);
    },
  };
  const service = new PlatformAdminAuthService(database as never, provider, {
    now: () => new Date(currentTime),
    enrollmentTokenTtlSeconds: 60,
    confirmationTokenTtlSeconds: 60,
    sessionTtlSeconds: 3600,
    maxMfaConfirmationAttempts: options.maxAttempts ?? 2,
  });
  return {
    database,
    service,
    password,
    userId,
    setTime(value: string) {
      currentTime = new Date(value);
    },
    now() {
      return currentTime.getTime();
    },
  };
}

function errorCode(error: unknown, code: string): boolean {
  return error instanceof PlatformAuthError && error.code === code;
}

for (const change of ['disabled', 'role-revoked', 'unsupported-role'] as const) {
  test(`issuance rechecks ${change} after the writer/exclusive-user fences and never returns a token`, async () => {
    const fixture = createFixture();
    const statements: string[] = [];
    fixture.database.onQuery = (statement) => {
      statements.push(statement);
      if (statement === 'select pg_advisory_xact_lock(hashtextextended($1::text, 0))') {
        if (change === 'disabled') fixture.database.state.users[0]!.disabled_at = '2026-01-02T03:04:05.000Z';
        else if (change === 'role-revoked') fixture.database.state.roles.length = 0;
        else fixture.database.state.roles[0]!.role = 'unsupported-fixture-role';
      }
    };
    await assert.rejects(fixture.service.issueMfaEnrollmentToken('owner@example.com'),
      (cause: unknown) => cause instanceof PlatformAuthError && cause.code === 'MFA_ENROLLMENT_UNAVAILABLE' && cause.status === 403);
    const writer = statements.indexOf('select pg_advisory_xact_lock(1396788563, 46)');
    const userFence = statements.indexOf('select pg_advisory_xact_lock(hashtextextended($1::text, 0))');
    const eligibility = statements.findIndex((statement) => statement.startsWith('select u.id from saas_users u where u.id ='));
    assert.ok(writer >= 0 && writer < userFence && userFence < eligibility,
      'candidate discovery must not substitute for fresh fenced authority');
    assert.ok(!statements.some((statement) => statement.startsWith('select pg_advisory_xact_lock_shared')));
    assert.equal(fixture.database.state.enrollmentTokens.length, 0);
    assert.equal(fixture.database.state.credentials.length, 0);
    assert.equal(fixture.database.state.setupTokens.length, 0);
    assert.equal(fixture.database.state.sessions.length, 0);
  });
}

async function enroll(
  fixture: ReturnType<typeof createFixture>,
): Promise<{ secret: string; confirmationToken: string }> {
  const enrollment = await fixture.service.issueMfaEnrollmentToken('OWNER@example.com');
  const started = await fixture.service.beginMfaEnrollment(enrollment.token, 'Model Router');
  const uri = new URL(started.otpauthUri);
  const secret = uri.searchParams.get('secret');
  assert.ok(secret);
  await fixture.service.confirmMfaEnrollment(started.confirmationToken, totpCode(secret, fixture.now()));
  return { secret, confirmationToken: started.confirmationToken };
}

test('MFA enrollment tokens and confirmation tokens are one-use, expiring, and attempt limited', async () => {
  const fixture = createFixture({ maxAttempts: 2 });
  const enrollment = await fixture.service.issueMfaEnrollmentToken('owner@example.com');
  assert.equal(fixture.database.state.enrollmentTokens[0]?.token_hash === enrollment.token, false);
  assert.equal(String(fixture.database.state.enrollmentTokens[0]?.token_hash).length, 64);

  const started = await fixture.service.beginMfaEnrollment(enrollment.token, 'Model Router');
  await assert.rejects(fixture.service.beginMfaEnrollment(enrollment.token, 'Model Router'), (error: unknown) =>
    errorCode(error, 'MFA_ENROLLMENT_TOKEN_INVALID'),
  );
  await assert.rejects(fixture.service.confirmMfaEnrollment(started.confirmationToken, '000000'), (error: unknown) =>
    errorCode(error, 'MFA_CONFIRMATION_INVALID'),
  );
  await assert.rejects(fixture.service.confirmMfaEnrollment(started.confirmationToken, '000000'), (error: unknown) =>
    errorCode(error, 'MFA_CONFIRMATION_INVALID'),
  );
  assert.ok(fixture.database.state.setupTokens[0]?.locked_at);

  const expiredFixture = createFixture();
  const expired = await expiredFixture.service.issueMfaEnrollmentToken('owner@example.com');
  expiredFixture.setTime('2026-01-02T03:05:05.001Z');
  await assert.rejects(expiredFixture.service.beginMfaEnrollment(expired.token, 'Model Router'), (error: unknown) =>
    errorCode(error, 'MFA_ENROLLMENT_TOKEN_INVALID'),
  );
});

test('expired and locked unverified credentials do not block a new enrollment', async () => {
  const expiredFixture = createFixture();
  const expiredEnrollment = await expiredFixture.service.issueMfaEnrollmentToken('owner@example.com');
  await expiredFixture.service.beginMfaEnrollment(expiredEnrollment.token, 'Model Router');
  expiredFixture.setTime('2026-01-02T03:05:05.001Z');
  const replacementEnrollment = await expiredFixture.service.issueMfaEnrollmentToken('owner@example.com');
  await expiredFixture.service.beginMfaEnrollment(replacementEnrollment.token, 'Model Router');
  assert.equal(expiredFixture.database.state.credentials[0]?.revoked_at, '2026-01-02T03:05:05.001Z');

  const lockedFixture = createFixture({ maxAttempts: 1 });
  const lockedEnrollment = await lockedFixture.service.issueMfaEnrollmentToken('owner@example.com');
  const lockedStart = await lockedFixture.service.beginMfaEnrollment(lockedEnrollment.token, 'Model Router');
  await assert.rejects(lockedFixture.service.confirmMfaEnrollment(lockedStart.confirmationToken, '000000'));
  assert.ok(lockedFixture.database.state.setupTokens[0]?.locked_at);
  const replacement = await lockedFixture.service.issueMfaEnrollmentToken('owner@example.com');
  await lockedFixture.service.beginMfaEnrollment(replacement.token, 'Model Router');
  assert.equal(lockedFixture.database.state.credentials[0]?.revoked_at !== null, true);
});

test('enrollment and confirmation expiry are rechecked after the lock-bearing query', async () => {
  const issueFixture = createFixture();
  issueFixture.database.state.enrollmentTokens.push({
    id: '00000000-0000-0000-0000-000000000099',
    user_id: issueFixture.userId,
    token_hash: 'a'.repeat(64),
    created_at: '2026-01-02T03:04:04.500Z',
    expires_at: '2026-01-02T03:04:05.500Z',
    consumed_at: null,
  });
  issueFixture.database.onQuery = (statement) => {
    if (statement === 'select pg_advisory_xact_lock(hashtextextended($1::text, 0))') {
      issueFixture.setTime('2026-01-02T03:04:06.000Z');
      issueFixture.database.onQuery = undefined;
    }
  };
  const newlyIssued = await issueFixture.service.issueMfaEnrollmentToken('owner@example.com');
  assert.equal(newlyIssued.expiresAt, '2026-01-02T03:05:06.000Z');

  const beginFixture = createFixture();
  const enrollment = await beginFixture.service.issueMfaEnrollmentToken('owner@example.com');
  beginFixture.setTime('2026-01-02T03:05:04.900Z');
  beginFixture.database.onQuery = (statement) => {
    if (statement.includes('for update of e')) {
      beginFixture.setTime('2026-01-02T03:05:05.100Z');
      beginFixture.database.onQuery = undefined;
    }
  };
  await assert.rejects(beginFixture.service.beginMfaEnrollment(enrollment.token, 'Model Router'), (error: unknown) =>
    errorCode(error, 'MFA_ENROLLMENT_TOKEN_INVALID'),
  );

  const confirmFixture = createFixture();
  const confirmEnrollment = await confirmFixture.service.issueMfaEnrollmentToken('owner@example.com');
  const started = await confirmFixture.service.beginMfaEnrollment(confirmEnrollment.token, 'Model Router');
  const secret = new URL(started.otpauthUri).searchParams.get('secret');
  assert.ok(secret);
  confirmFixture.setTime('2026-01-02T03:05:04.900Z');
  confirmFixture.database.onQuery = (statement) => {
    if (statement.includes('for update of s')) {
      confirmFixture.setTime('2026-01-02T03:05:05.100Z');
      confirmFixture.database.onQuery = undefined;
    }
  };
  await assert.rejects(
    confirmFixture.service.confirmMfaEnrollment(started.confirmationToken, totpCode(secret, confirmFixture.now())),
    (error: unknown) => errorCode(error, 'MFA_CONFIRMATION_INVALID'),
  );
});

test('confirmation rechecks expiry after credential-key lookup and leaves credential unverified', async () => {
  const fixture = createFixture({ advanceClockOnGetKeyTo: '2026-01-02T03:05:05.001Z' });
  const enrollment = await fixture.service.issueMfaEnrollmentToken('owner@example.com');
  const started = await fixture.service.beginMfaEnrollment(enrollment.token, 'Model Router');
  const secret = new URL(started.otpauthUri).searchParams.get('secret');
  assert.ok(secret);

  fixture.setTime('2026-01-02T03:05:04.999Z');
  await assert.rejects(
    fixture.service.confirmMfaEnrollment(started.confirmationToken, totpCode(secret, fixture.now())),
    (error: unknown) => errorCode(error, 'MFA_CONFIRMATION_INVALID'),
  );

  assert.equal(fixture.now(), Date.parse('2026-01-02T03:05:05.001Z'));
  assert.equal(fixture.database.state.credentials[0]?.verified_at, null);
  assert.equal(fixture.database.state.setupTokens[0]?.consumed_at, null);
});

test('missing credential key provider fails closed for MFA and login', async () => {
  const fixture = createFixture();
  const service = new PlatformAdminAuthService(fixture.database as never, undefined);
  await assert.rejects(service.issueMfaEnrollmentToken('owner@example.com'), (error: unknown) =>
    errorCode(error, 'MFA_UNAVAILABLE'),
  );
  assert.equal(await service.login('owner@example.com', fixture.password, '000000'), undefined);
  assert.equal(await service.getSession('a-valid-looking-token'), undefined);
});

test('wrong password and missing MFA state both fail login without creating a session', async () => {
  const fixture = createFixture();
  assert.equal(await fixture.service.login('owner@example.com', 'wrong password value', '000000'), undefined);
  assert.equal(await fixture.service.login('owner@example.com', fixture.password, '000000'), undefined);
  assert.equal(fixture.database.state.sessions.length, 0);
});

test('every supported platform role can enroll MFA, login, and retrieve a session', async (t) => {
  for (const role of SUPPORTED_PLATFORM_ROLES) {
    await t.test(role, async () => {
      const fixture = createFixture({ role });
      const { secret } = await enroll(fixture);
      fixture.setTime('2026-01-02T03:04:35.000Z');
      const login = await fixture.service.login('owner@example.com', fixture.password, totpCode(secret, fixture.now()));
      assert.ok(login);
      assert.deepEqual(await fixture.service.getSession(login.token), login.session);
      assert.equal(await fixture.service.verifyCsrfToken(login.token, login.csrfToken), true);
    });
  }
});

test('users without a platform role or with an unknown role fail closed', async (t) => {
  for (const [label, role] of [
    ['no role', null],
    ['unknown role', 'platform-owner-unknown'],
  ] as const) {
    await t.test(label, async () => {
      const fixture = createFixture({ role });
      assert.equal(await fixture.service.login('owner@example.com', fixture.password, '123456'), undefined);
      assert.equal(fixture.database.state.sessions.length, 0);
      await assert.rejects(fixture.service.issueMfaEnrollmentToken('owner@example.com'), (error: unknown) =>
        errorCode(error, 'MFA_ENROLLMENT_UNAVAILABLE'),
      );
    });
  }
});

test('an unknown or corrupt role invalidates an existing session and CSRF token', async () => {
  const fixture = createFixture({ role: 'security' });
  const { secret } = await enroll(fixture);
  fixture.setTime('2026-01-02T03:04:35.000Z');
  const login = await fixture.service.login('owner@example.com', fixture.password, totpCode(secret, fixture.now()));
  assert.ok(login);

  const role = fixture.database.state.roles[0];
  assert.ok(role);
  role.role = 'corrupt-role';
  assert.equal(await fixture.service.getSession(login.token), undefined);
  assert.equal(await fixture.service.verifyCsrfToken(login.token, login.csrfToken), false);

  fixture.setTime('2026-01-02T03:05:05.000Z');
  assert.equal(
    await fixture.service.login('owner@example.com', fixture.password, totpCode(secret, fixture.now())),
    undefined,
  );
});

test('revoking the final platform role invalidates existing session and CSRF and blocks login', async () => {
  const fixture = createFixture({ role: 'finance' });
  const { secret } = await enroll(fixture);
  fixture.setTime('2026-01-02T03:04:35.000Z');
  const login = await fixture.service.login('owner@example.com', fixture.password, totpCode(secret, fixture.now()));
  assert.ok(login);

  fixture.database.state.roles.length = 0;
  assert.equal(await fixture.service.getSession(login.token), undefined);
  assert.equal(await fixture.service.verifyCsrfToken(login.token, login.csrfToken), false);

  fixture.setTime('2026-01-02T03:05:05.000Z');
  assert.equal(
    await fixture.service.login('owner@example.com', fixture.password, totpCode(secret, fixture.now())),
    undefined,
  );
});

test('correct TOTP creates an isolated session, binds CSRF, and rejects same-step replay', async () => {
  const fixture = createFixture();
  const { secret } = await enroll(fixture);
  const credential = fixture.database.state.credentials[0];
  assert.ok(credential);
  assert.equal(credential.last_used_step, Math.floor(fixture.now() / 30_000));
  const confirmationCode = totpCode(secret, fixture.now());
  assert.equal(await fixture.service.login('owner@example.com', fixture.password, confirmationCode), undefined);

  fixture.setTime('2026-01-02T03:04:35.000Z');
  const code = totpCode(secret, fixture.now());
  const login = await fixture.service.login('owner@example.com', fixture.password, code);
  assert.ok(login);
  assert.equal(fixture.database.state.sessions[0]?.token_hash === login.token, false);
  assert.equal(fixture.database.state.sessions[0]?.csrf_token_hash === login.csrfToken, false);
  assert.deepEqual(await fixture.service.getSession(login.token), login.session);
  assert.equal(await fixture.service.verifyCsrfToken(login.token, login.csrfToken), true);
  assert.equal(await fixture.service.verifyCsrfToken(login.token, 'wrong-csrf-token'), false);
  assert.equal(await fixture.service.login('owner@example.com', fixture.password, code), undefined);
  assert.equal(fixture.database.state.sessions.length, 1);

  fixture.setTime('2026-01-02T03:05:05.000Z');
  const nextLogin = await fixture.service.login('owner@example.com', fixture.password, totpCode(secret, fixture.now()));
  assert.ok(nextLogin);
  assert.notEqual(nextLogin.session.id, login.session.id);

  fixture.database.state.roles.length = 0;
  assert.equal(await fixture.service.getSession(login.token), undefined);
  fixture.database.state.roles.push({ user_id: fixture.userId, role: 'superadmin' });
  const credentialState = fixture.database.state.credentials[0];
  assert.ok(credentialState);
  credentialState.revoked_at = '2026-01-02T03:04:36.000Z';
  assert.equal(await fixture.service.getSession(nextLogin.token), undefined);
  credentialState.revoked_at = null;
  await fixture.service.logout(nextLogin.token);
  assert.equal(await fixture.service.getSession(nextLogin.token), undefined);
});

test('platform auth retains method-scoped writer/read fences without row-locking authority facts', async () => {
  const fixture = createFixture();
  const writerFence = 'select pg_advisory_xact_lock(1396788563, 46)';
  const exclusiveUserFence = 'select pg_advisory_xact_lock(hashtextextended($1::text, 0))';
  const sharedUserFence = 'select pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
  const isolation = 'set transaction isolation level read committed';

  async function trace<T>(work: () => Promise<T>): Promise<{ value: T; queries: QueryTrace[] }> {
    const start = fixture.database.queries.length;
    const value = await work();
    return { value, queries: fixture.database.queries.slice(start) };
  }

  function queryIndex(queries: readonly QueryTrace[], prefix: string): number {
    const matches = queries.flatMap(({ statement }, index) => (statement.startsWith(prefix) ? [index] : []));
    assert.equal(matches.length, 1, `method trace must contain exactly one ${prefix}`);
    return matches[0]!;
  }

  function fences(queries: readonly QueryTrace[]): string[] {
    return queries
      .filter(({ statement }) => /\bpg_(?:try_)?advisory_/.test(statement))
      .map(({ statement }) => statement);
  }

  function assertPreparedTransaction(
    queries: readonly QueryTrace[],
    indices: readonly number[],
    label: string,
  ): number {
    const transactionId = queries[indices[0]!]!.transactionId;
    assert.notEqual(transactionId, undefined, `${label} must be inside a transaction`);
    assert.ok(indices.every((index) => queries[index]!.transactionId === transactionId),
      `${label} must retain its fence and authority reads/writes in the same transaction`);
    const prepared = queries.findIndex((query) => query.transactionId === transactionId && query.statement === isolation);
    assert.ok(prepared >= 0 && prepared < Math.min(...indices), `${label} must explicitly prepare fresh READ COMMITTED`);
    return transactionId!;
  }

  const audit = {
    operatorId: 'unit-fixture:trusted-operator',
    reasonCode: 'initial-enrollment' as const,
    requestId: randomUUID(),
  };
  const issued = await trace(() => fixture.service.issueMfaEnrollmentToken('OWNER@example.com', audit));
  const enrollment = issued.value;
  const issuance = issued.queries;
  assert.deepEqual(fences(issuance), [writerFence, exclusiveUserFence],
    'issuance must take only the matching 046 global writer then exclusive user, never upgrade a shared reader');
  const discovery = queryIndex(issuance, 'select id from saas_users where email_canonical =');
  const writer = queryIndex(issuance, writerFence);
  const exclusive = queryIndex(issuance, exclusiveUserFence);
  const eligibility = queryIndex(issuance, 'select u.id from saas_users u where u.id =');
  const verified = queryIndex(issuance, 'select id from saas_mfa_credentials');
  const pending = queryIndex(issuance, 'select id from saas_platform_mfa_enrollment_tokens');
  const tokenInsert = queryIndex(issuance, 'insert into saas_platform_mfa_enrollment_tokens');
  const auditInsert = queryIndex(issuance, 'insert into saas_audit_events');
  assert.ok(
    discovery < writer && writer < exclusive && exclusive < eligibility && eligibility < verified
      && verified < pending && pending < tokenInsert && tokenInsert < auditInsert,
    'issuance discovery cannot substitute for fresh eligibility/verified/pending reads after both fences',
  );
  assert.equal(issuance[discovery]!.transactionId, undefined);
  assert.deepEqual(issuance[writer]!.values, []);
  assert.deepEqual(issuance[exclusive]!.values, [fixture.userId]);
  assert.deepEqual(issuance[eligibility]!.values, [fixture.userId]);
  assert.deepEqual(issuance[verified]!.values, [fixture.userId]);
  assert.deepEqual(issuance[pending]!.values, [fixture.userId, '2026-01-02T03:04:05.000Z']);
  assertPreparedTransaction(
    issuance, [writer, exclusive, eligibility, verified, pending, tokenInsert, auditInsert], 'issuance',
  );
  assert.equal(fixture.database.state.enrollmentTokens.length, 1);
  assert.notEqual(fixture.database.state.enrollmentTokens[0]!.token_hash, enrollment.token);
  assert.equal(fixture.database.state.auditEvents.length, 1);
  assert.equal(fixture.database.state.auditEvents[0]![1], 'platform_mfa.enrollment_token.issued');
  assert.equal(fixture.database.state.auditEvents[0]![3], fixture.userId);
  assert.deepEqual(fixture.database.state.auditEvents[0]!.slice(5),
    [audit.requestId, audit.operatorId, audit.reasonCode, 'issued']);
  const auditSql = issuance[auditInsert]!.statement;
  assert.match(auditSql, /values \(\$1, null, null,/);
  assert.ok(!JSON.stringify(fixture.database.state.auditEvents).includes(enrollment.token));
  assert.ok(!JSON.stringify(fixture.database.state.auditEvents).includes('owner@example.com'));

  const begun = await trace(() => fixture.service.beginMfaEnrollment(enrollment.token, 'Model Router'));
  const secret = new URL(begun.value.otpauthUri).searchParams.get('secret');
  assert.ok(secret);
  // These unit traces observe service SQL, not database trigger execution.
  // Managed PG tests separately prove the writer fences fired by MFA writes.
  const beginWrite = queryIndex(begun.queries, 'insert into saas_mfa_credentials');
  const beginAuthority = queryIndex(begun.queries, 'select u.email_canonical as email from saas_users u');
  const enrollmentConsume = queryIndex(begun.queries, 'update saas_platform_mfa_enrollment_tokens');
  assert.ok(beginWrite < beginAuthority && beginAuthority < enrollmentConsume);
  assertPreparedTransaction(
    begun.queries, [beginWrite, beginAuthority, enrollmentConsume], 'enrollment start writer recheck',
  );

  // An invalid-format code deterministically takes confirmation's reader path;
  // valid confirmation uses the verified_at writer trigger, not an extra shared lock.
  const rejected = await trace(() => assert.rejects(
    fixture.service.confirmMfaEnrollment(begun.value.confirmationToken, 'not-six-digits'),
    (error: unknown) => errorCode(error, 'MFA_CONFIRMATION_INVALID'),
  ));
  const rejection = rejected.queries;
  assert.deepEqual(
    fences(rejection), [sharedUserFence], 'invalid-code confirmation must independently acquire its shared fence',
  );
  const setupLock = queryIndex(rejection, 'select s.id, s.user_id, s.credential_id, c.encrypted_secret');
  const confirmationShared = queryIndex(rejection, sharedUserFence);
  const confirmationAuthority = queryIndex(rejection, 'select u.id from saas_users u where u.id =');
  const currentSetup = queryIndex(rejection, 'select s.id from saas_platform_mfa_setup_tokens s join saas_mfa_credentials c');
  const attemptUpdate = queryIndex(rejection, 'update saas_platform_mfa_setup_tokens set attempt_count');
  assert.ok(setupLock < confirmationShared && confirmationShared < confirmationAuthority
    && confirmationAuthority < currentSetup && currentSetup < attemptUpdate);
  assert.deepEqual(rejection[confirmationShared]!.values, [fixture.userId]);
  assertPreparedTransaction(
    rejection, [setupLock, confirmationShared, confirmationAuthority, currentSetup, attemptUpdate], 'confirmation reader',
  );
  assert.equal(fixture.database.state.setupTokens[0]!.attempt_count, 1);
  assert.equal(fixture.database.state.setupTokens[0]!.consumed_at, null);
  assert.equal(fixture.database.state.credentials[0]!.verified_at, null);

  const confirmed = await trace(() => fixture.service.confirmMfaEnrollment(
    begun.value.confirmationToken, totpCode(secret, fixture.now()),
  ));
  assert.deepEqual(fences(confirmed.queries), [], 'valid confirmation must not add a shared-to-exclusive upgrade');
  const verificationWrite = queryIndex(confirmed.queries, 'update saas_mfa_credentials set verified_at');
  const verificationAuthority = queryIndex(confirmed.queries, 'select u.id from saas_users u where u.id =');
  const verificationRead = queryIndex(confirmed.queries, 'select id from saas_mfa_credentials');
  const setupConsume = queryIndex(confirmed.queries, 'update saas_platform_mfa_setup_tokens set consumed_at');
  assert.ok(verificationWrite < verificationAuthority && verificationAuthority < verificationRead
    && verificationRead < setupConsume);
  assertPreparedTransaction(
    confirmed.queries, [verificationWrite, verificationAuthority, verificationRead, setupConsume], 'confirmation writer recheck',
  );

  fixture.setTime('2026-01-02T03:04:35.000Z');
  const loggedIn = await trace(() => fixture.service.login(
    'owner@example.com', fixture.password, totpCode(secret, fixture.now()),
  ));
  const login = loggedIn.value;
  assert.ok(login);
  const loginTrace = loggedIn.queries;
  assert.deepEqual(fences(loginTrace), [sharedUserFence, sharedUserFence], 'login must retain both independent reader fences');
  const loginShared = loginTrace.flatMap(({ statement }, index) => (statement === sharedUserFence ? [index] : []));
  const credentialShared = loginShared[0]!;
  const finalShared = loginShared[1]!;
  const loginEligibility = queryIndex(loginTrace, 'select u.id from saas_users u where u.id =');
  const credentialRead = queryIndex(loginTrace, 'select c.id as credential_id, c.user_id, c.encrypted_secret');
  const replayCas = queryIndex(loginTrace, 'update saas_mfa_credentials set last_used_step');
  const provisionalSession = queryIndex(loginTrace, 'insert into saas_platform_sessions');
  const finalAuthority = queryIndex(loginTrace, 'select c.id from saas_mfa_credentials c join saas_users u');
  assert.ok(
    credentialShared < loginEligibility && loginEligibility < credentialRead && credentialRead < replayCas
      && replayCas < provisionalSession && provisionalSession < finalShared && finalShared < finalAuthority,
    'credential read must be fenced; replay CAS runs outside it; provisional INSERT must precede the final fenced authority recheck',
  );
  assert.deepEqual(loginTrace[credentialShared]!.values, [fixture.userId]);
  assert.deepEqual(loginTrace[finalShared]!.values, [fixture.userId]);
  const credentialTransaction = assertPreparedTransaction(
    loginTrace, [credentialShared, loginEligibility, credentialRead], 'login credential reader',
  );
  assert.equal(loginTrace[replayCas]!.transactionId, undefined, 'replay CAS must not hold a shared transaction fence');
  const finalTransaction = assertPreparedTransaction(
    loginTrace, [provisionalSession, finalShared, finalAuthority], 'login final reader',
  );
  assert.notEqual(credentialTransaction, finalTransaction, 'final login authority needs a new READ COMMITTED transaction');

  const session = await trace(() => fixture.service.getSession(login.token));
  assert.deepEqual(session.value, login.session);
  assert.deepEqual(fences(session.queries), [sharedUserFence], 'session must acquire its own shared fence');
  const sessionDiscovery = queryIndex(session.queries, 'select user_id from saas_platform_sessions');
  const sessionShared = queryIndex(session.queries, sharedUserFence);
  const sessionAuthority = queryIndex(session.queries, 'select s.id, s.user_id, s.created_at, s.expires_at');
  assert.ok(sessionDiscovery < sessionShared && sessionShared < sessionAuthority);
  assert.equal(session.queries[sessionDiscovery]!.transactionId, undefined);
  assert.deepEqual(session.queries[sessionShared]!.values, [fixture.userId]);
  assertPreparedTransaction(session.queries, [sessionShared, sessionAuthority], 'session reader');
  assert.match(session.queries[sessionAuthority]!.statement, /s\.expires_at > clock_timestamp\(\)/);

  const csrf = await trace(() => fixture.service.verifyCsrfToken(login.token, login.csrfToken));
  assert.equal(csrf.value, true);
  assert.deepEqual(fences(csrf.queries), [sharedUserFence], 'CSRF must acquire its own shared fence');
  const csrfDiscovery = queryIndex(csrf.queries, 'select user_id from saas_platform_sessions');
  const csrfShared = queryIndex(csrf.queries, sharedUserFence);
  const csrfAuthority = queryIndex(csrf.queries, 'select s.csrf_token_hash');
  assert.ok(csrfDiscovery < csrfShared && csrfShared < csrfAuthority);
  assert.equal(csrf.queries[csrfDiscovery]!.transactionId, undefined);
  assert.deepEqual(csrf.queries[csrfShared]!.values, [fixture.userId]);
  assertPreparedTransaction(csrf.queries, [csrfShared, csrfAuthority], 'CSRF reader');
  assert.match(csrf.queries[csrfAuthority]!.statement, /s\.expires_at > clock_timestamp\(\)/);

  const loggedOut = await trace(() => fixture.service.logout(login.token));
  assert.equal(loggedOut.queries.length, 1);
  assert.equal(loggedOut.queries[0]!.transactionId, undefined);
  assert.equal(fixture.database.state.sessions[0]!.revoked_at, '2026-01-02T03:04:35.000Z');

  const statements = fixture.database.queries.map(({ statement }) => statement);
  assert.doesNotMatch(statements.join('\n'), /FOR SHARE OF (?:u|r|c)|FOR UPDATE OF (?:u|r|c)/i);
  assert.match(statements.join('\n'), /s\.expires_at > clock_timestamp\(\)/);
  assert.match(statements.at(-1) ?? '', /COALESCE\(revoked_at, clock_timestamp\(\)\)/i);
  assert.ok(
    statements
      .filter((statement) => statement.includes('for update'))
      .every((statement) => statement.includes('for update of e') || statement.includes('for update of s')),
  );
});
