import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SaasIdentityError, SaasIdentityService } from '../../../src/saas/identity/index.js';
import { FakeSaasDatabase } from './fake-database.js';

const initialTime = '2026-01-02T03:04:05.000Z';
const password = 'correct horse battery staple';

type TestQueryResult<Row> = { rows: Row[]; rowCount: number | null };
type TestQuery = <Row>(sql: string, values?: readonly unknown[]) => Promise<TestQueryResult<Row>>;

function customerSessionDatabase(database: FakeSaasDatabase) {
  const run = async <Row>(
    query: TestQuery,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<TestQueryResult<Row>> => {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const handlesSessionQuery =
      statement.startsWith('with authenticated_customer_session as (') ||
      statement.startsWith('select id, user_id from saas_sessions') ||
      statement.startsWith('select id, user_id, expires_at, revoked_at from saas_sessions') ||
      statement.startsWith('select s.id, s.user_id, s.expires_at, s.revoked_at, u.disabled_at as user_disabled_at') ||
      statement.startsWith('with selected_session as (') ||
      statement.startsWith('update saas_sessions set revoked_at = $3') ||
      statement.startsWith('insert into saas_audit_events');
    if (!handlesSessionQuery) return query<Row>(sql, values);
    try {
      await query<Row>(sql, values);
    } catch {
      // The shared fake database records unknown SQL before rejecting it.
    }
    const [first, second, third, fourth] = values;
    const rows: unknown[] = [];

    if (statement.startsWith('select id, user_id from saas_sessions')) {
      const session = database.state.sessions.find((candidate) => candidate.token_hash === first);
      if (session) rows.push({ id: session.id, user_id: session.user_id });
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (statement.startsWith('select id, user_id, expires_at, revoked_at from saas_sessions')) {
      const session = database.state.sessions.find(
        (candidate) => candidate.token_hash === first && candidate.id === second && candidate.user_id === third,
      );
      if (session) {
        rows.push({
          id: session.id,
          user_id: session.user_id,
          expires_at: session.expires_at,
          revoked_at: session.revoked_at,
        });
      }
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (statement.startsWith('with authenticated_customer_session as (')) {
      const caller = database.state.sessions.find((session) => session.token_hash === first);
      const callerUser = database.state.users.find((user) => user.id === caller?.user_id);
      const now = new Date(String(second)).getTime();
      if (
        caller &&
        caller.revoked_at === null &&
        new Date(String(caller.expires_at)).getTime() > now &&
        callerUser?.disabled_at === null
      ) {
        rows.push(
          ...database.state.sessions
            .filter((session) => session.user_id === caller.user_id)
            .sort(
              (left, right) =>
                String(right.created_at).localeCompare(String(left.created_at)) ||
                String(left.id).localeCompare(String(right.id)),
            )
            .map((session) => ({
              id: session.id,
              created_at: session.created_at,
              expires_at: session.expires_at,
              revoked_at: session.revoked_at,
              is_current: session.token_hash === first,
            })),
        );
      }
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (statement.startsWith('select s.id, s.user_id, s.expires_at, s.revoked_at, u.disabled_at as user_disabled_at')) {
      const session = database.state.sessions.find(
        (candidate) => candidate.token_hash === first && candidate.id === second && candidate.user_id === third,
      );
      const user = database.state.users.find((candidate) => candidate.id === session?.user_id);
      if (session && user) {
        rows.push({
          id: session.id,
          user_id: session.user_id,
          expires_at: session.expires_at,
          revoked_at: session.revoked_at,
          user_disabled_at: user.disabled_at,
        });
      }
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (statement.startsWith('with selected_session as (')) {
      const session = database.state.sessions.find(
        (candidate) => candidate.user_id === first && candidate.id === second,
      );
      if (session) {
        const newlyRevoked = session.revoked_at === null;
        session.revoked_at ??= third;
        rows.push({
          id: session.id,
          revoked_at: session.revoked_at,
          is_current: session.id === fourth,
          newly_revoked: newlyRevoked,
        });
      }
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (statement.startsWith('insert into saas_audit_events')) {
      return { rows: [], rowCount: 1 };
    }

    if (statement.startsWith('update saas_sessions set revoked_at = $3')) {
      const now = new Date(String(third)).getTime();
      for (const session of database.state.sessions) {
        if (
          session.user_id === first &&
          session.id !== second &&
          session.revoked_at === null &&
          new Date(String(session.expires_at)).getTime() > now
        ) {
          session.revoked_at = third;
          rows.push({ id: session.id });
        }
      }
      return { rows: rows as Row[], rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query: <Row>(sql: string, values: readonly unknown[] = []) => run<Row>(database.query.bind(database), sql, values),
    transaction: <T>(work: (tx: { query: TestQuery }) => Promise<T>) =>
      database.transaction((tx) => work({ query: (sql, values = []) => run(tx.query, sql, values) })),
  };
}

function createFixture() {
  const database = new FakeSaasDatabase();
  let currentTime = new Date(initialTime);
  const service = new SaasIdentityService(customerSessionDatabase(database) as never, {
    now: () => new Date(currentTime),
  });
  return {
    database,
    service,
    setTime(value: string) {
      currentTime = new Date(value);
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SaasIdentityError && error.code === code);
}

async function createBootstrapAdmin(service: SaasIdentityService, email = 'owner@example.com') {
  const bootstrap = await service.issueBootstrapToken();
  return service.bootstrapPlatformAdmin({
    token: bootstrap.token,
    email,
    password,
    displayName: 'Initial Owner',
  });
}

test('bootstrap status is read-only; bootstrap tokens expire and are single use', async () => {
  const { database, service, setTime } = createFixture();
  assert.deepEqual(await service.bootstrapStatus(), { initialized: false, bootstrapRequired: true });
  assert.equal(database.state.bootstrapTokens.length, 0);

  const expired = await service.issueBootstrapToken();
  assert.equal(expired.expiresAt, '2026-01-02T03:19:05.000Z');
  assert.equal(database.state.bootstrapTokens[0]?.token_hash === expired.token, false);
  assert.equal(String(database.state.bootstrapTokens[0]?.token_hash).length, 64);
  await expectCode(service.issueBootstrapToken(), 'BOOTSTRAP_TOKEN_ALREADY_ISSUED');

  await expectCode(
    service.bootstrapPlatformAdmin({
      token: expired.token,
      email: 'first@example.com',
      password: 'short-pass',
      displayName: 'First Admin',
    }),
    'INVALID_INPUT',
  );
  assert.equal(database.state.bootstrapTokens[0]?.consumed_at, null);

  setTime('2026-01-02T03:19:05.001Z');
  await expectCode(
    service.bootstrapPlatformAdmin({
      token: expired.token,
      email: 'first@example.com',
      password,
      displayName: 'First Admin',
    }),
    'BOOTSTRAP_TOKEN_INVALID',
  );

  const active = await service.issueBootstrapToken();
  const identity = await service.bootstrapPlatformAdmin({
    token: active.token,
    email: ' First@Example.com ',
    password,
    displayName: 'First Admin',
  });
  assert.equal(identity.email, 'first@example.com');
  assert.equal(identity.emailVerifiedAt, null);
  assert.equal(identity.status, 'active');
  assert.equal(database.state.platformRoleAssignments.length, 1);
  assert.equal(database.state.platformRoleAssignments[0]?.role, 'superadmin');
  const platformState = (
    database.state as unknown as {
      platformState: { initialized: boolean; initialized_at: string | null };
    }
  ).platformState;
  assert.equal(platformState.initialized, true);
  assert.ok(platformState.initialized_at);
  assert.equal(database.state.users[0]?.password_hash === password, false);
  assert.deepEqual(await service.bootstrapStatus(), { initialized: true, bootstrapRequired: false });
  await expectCode(service.issueBootstrapToken(), 'BOOTSTRAP_ALREADY_COMPLETED');

  const initialUser = database.state.users[0];
  assert.ok(initialUser);
  initialUser.disabled_at = initialTime;
  assert.deepEqual(await service.bootstrapStatus(), { initialized: true, bootstrapRequired: false });
  await expectCode(service.issueBootstrapToken(), 'BOOTSTRAP_ALREADY_COMPLETED');

  await expectCode(
    service.bootstrapPlatformAdmin({
      token: active.token,
      email: 'first@example.com',
      password,
      displayName: 'First Admin',
    }),
    'BOOTSTRAP_ALREADY_COMPLETED',
  );
});

test('login verifies scrypt passwords and performs password work for unknown users', async () => {
  const { service } = createFixture();
  await createBootstrapAdmin(service);

  assert.equal(
    await service.login({
      email: 'missing@example.com',
      password,
      ttlSeconds: 3600,
    }),
    undefined,
  );
  assert.equal(
    await service.login({
      email: 'owner@example.com',
      password: 'incorrect horse battery staple',
      ttlSeconds: 3600,
    }),
    undefined,
  );

  const login = await service.login({ email: 'OWNER@example.com', password, ttlSeconds: 3600 });
  assert.ok(login);
  assert.equal(login.session.userId.length > 0, true);
  assert.equal(login.session.activeTenantId, null);
  assert.equal('tokenHash' in login.session, false);
  assert.equal('csrfTokenHash' in login.session, false);
  assert.equal(await service.verifyCsrfToken(login.token, login.csrfToken), true);
  assert.equal(await service.verifyCsrfToken(login.token, 'wrong-csrf-token-value'), false);
});

test('bootstrap role assignment takes the global writer fence before bootstrap and state row locks', async () => {
  const { database, service } = createFixture();
  const bootstrap = await service.issueBootstrapToken();
  const bootstrapStart = database.queryLog.length;

  await service.bootstrapPlatformAdmin({
    token: bootstrap.token,
    email: 'bootstrap-order@example.com',
    password,
    displayName: 'Bootstrap Order',
  });

  const transactionQueries = database.queryLog.slice(bootstrapStart);
  const writerFenceIndex = transactionQueries.findIndex((query) =>
    query.sql.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  const bootstrapLockIndex = transactionQueries.findIndex((query) => query.sql.includes('1396789587, 1'));
  const stateRowLockIndex = transactionQueries.findIndex((query) =>
    /FROM saas_platform_state[\s\S]+FOR UPDATE/i.test(query.sql),
  );
  const roleAssignmentIndex = transactionQueries.findIndex((query) =>
    /INSERT INTO saas_platform_role_assignments/i.test(query.sql),
  );
  assert.ok(
    writerFenceIndex >= 0 &&
      bootstrapLockIndex > writerFenceIndex &&
      stateRowLockIndex > bootstrapLockIndex &&
      roleAssignmentIndex > stateRowLockIndex,
  );
});

test('login rechecks a disabled user after the shared user fence wait (fake SQL)', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const loginStart = database.queryLog.length;
  database.authorizationFenceHook = (sql, values) => {
    if (sql.includes('hashtextextended($1::uuid::text') && values[0] === owner.id) {
      const user = database.state.users.find((candidate) => candidate.id === owner.id);
      if (user) user.disabled_at = initialTime;
      database.authorizationFenceHook = undefined;
    }
  };

  assert.equal(await service.login({ email: owner.email, password, ttlSeconds: 3600 }), undefined);
  assert.equal(database.state.sessions.length, 0);
  const loginQueries = database.queryLog.slice(loginStart);
  const writerFenceIndex = loginQueries.findIndex((entry) =>
    entry.sql.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  const fenceIndex = loginQueries.findIndex((entry) => entry.sql.includes('hashtextextended($1::uuid::text'));
  const activeUserIndex = loginQueries.findIndex((entry) =>
    /select id from saas_users[\s\S]+email_canonical = \$2[\s\S]+disabled_at is null/i.test(entry.sql),
  );
  assert.ok(writerFenceIndex >= 0 && writerFenceIndex < fenceIndex && activeUserIndex > fenceIndex);
  assert.doesNotMatch(loginQueries[activeUserIndex]?.sql ?? '', /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

test('login rejects credentials changed after the shared user fence wait (fake SQL)', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);
  let changed = false;
  database.authorizationFenceHook = (sql, values) => {
    if (sql.includes('pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text') && values[0] === owner.id) {
      changed = true;
      const user = database.state.users.find((candidate) => candidate.id === owner.id);
      if (user) {
        user.email_canonical = 'renamed@example.test';
        user.password_hash = 'changed-password-hash';
      }
      database.authorizationFenceHook = undefined;
    }
  };

  assert.equal(await service.login({ email: owner.email, password, ttlSeconds: 3600 }), undefined);
  assert.equal(changed, true);
  const activeUserQuery = database.queryLog.find((query) => query.sql.includes('email_canonical = $2'));
  assert.ok(activeUserQuery);
  assert.match(activeUserQuery.sql, /password_hash = \$3/);
  assert.doesNotMatch(activeUserQuery.sql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

test('session mutation rechecks disablement after its exclusive user fence wait (fake SQL)', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const login = await service.login({ email: owner.email, password, ttlSeconds: 3600 });
  assert.ok(login);
  const customerSession = database.state.sessions[0];
  assert.ok(customerSession);
  let disabled = false;
  database.authorizationFenceHook = (sql, values) => {
    if (sql.includes('pg_advisory_xact_lock(hashtextextended($1::uuid::text') && values[0] === owner.id) {
      disabled = true;
      const user = database.state.users.find((candidate) => candidate.id === owner.id);
      if (user) user.disabled_at = initialTime;
      database.authorizationFenceHook = undefined;
    }
  };

  await assert.rejects(service.revokeOtherSessions(login.token), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
  });
  assert.equal(disabled, true);
  assert.equal(customerSession.revoked_at, null);
  const transactionQueries = database.queryLog.filter((query) => query.transactionId !== null);
  const timeoutIndex = transactionQueries.findIndex((query) =>
    query.sql.includes("set_config('lock_timeout', '2s', TRUE)"),
  );
  const writerFenceIndex = transactionQueries.findIndex((query) =>
    query.sql.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  const sessionLockIndex = transactionQueries.findIndex((query) =>
    /FROM saas_sessions[\s\S]+FOR UPDATE/i.test(query.sql),
  );
  const userFenceIndex = transactionQueries.findIndex((query) =>
    query.sql.includes('pg_advisory_xact_lock(hashtextextended($1::uuid::text'),
  );
  const authorizationRecheckIndex = transactionQueries.findIndex((query) =>
    /JOIN saas_users u ON u.id = s.user_id/i.test(query.sql),
  );
  assert.ok(
    timeoutIndex >= 0 &&
      writerFenceIndex > timeoutIndex &&
      sessionLockIndex > writerFenceIndex &&
      userFenceIndex > sessionLockIndex &&
      authorizationRecheckIndex > userFenceIndex,
  );
});

test('session lookup observes revocation, stores token hashes only, and logout is idempotent', async () => {
  const { service, database } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const login = await service.login({ email: owner.email, password, ttlSeconds: 3600 });
  assert.ok(login);
  assert.deepEqual(await service.getSession(login.token), login.session);
  assert.equal(database.state.sessions[0]?.token_hash === login.token, false);
  assert.equal(database.state.sessions[0]?.csrf_token_hash === login.csrfToken, false);

  await service.logout(login.token);
  assert.equal(await service.getSession(login.token), undefined);
  assert.equal(await service.verifyCsrfToken(login.token, login.csrfToken), false);
  await service.logout(login.token);
});

test('session listing is private to the authenticated customer and classifies revoked and expired sessions safely', async () => {
  const { database, service, setTime } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const current = await service.login({ email: owner.email, password, ttlSeconds: 7200 });
  assert.ok(current);

  setTime('2026-01-02T03:04:10.000Z');
  const activeOther = await service.login({ email: owner.email, password, ttlSeconds: 7200 });
  assert.ok(activeOther);
  setTime('2026-01-02T03:04:20.000Z');
  const revoked = await service.login({ email: owner.email, password, ttlSeconds: 7200 });
  assert.ok(revoked);
  setTime('2026-01-02T03:04:30.000Z');
  const expired = await service.login({ email: owner.email, password, ttlSeconds: 30 });
  assert.ok(expired);

  const tenant = await service.createTenant(owner.id, { name: 'Session Isolation' });
  const invitation = await service.createInvitation(owner.id, tenant.id, {
    email: 'other@example.com',
    role: 'viewer',
  });
  const otherUser = await service.acceptInvitation({
    token: invitation.token,
    email: 'other@example.com',
    displayName: 'Other User',
    password: 'another secure password',
  });
  const otherSession = await service.login({
    email: otherUser.email,
    password: 'another secure password',
    ttlSeconds: 3600,
  });
  assert.ok(otherSession);

  const currentRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(current.token).digest('hex'),
  );
  const activeOtherRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(activeOther.token).digest('hex'),
  );
  const revokedRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(revoked.token).digest('hex'),
  );
  const expiredRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(expired.token).digest('hex'),
  );
  const otherRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(otherSession.token).digest('hex'),
  );
  assert.ok(currentRow && activeOtherRow && revokedRow && expiredRow && otherRow);
  assert.equal(
    database.state.memberships.some(
      (membership) => membership.user_id === otherUser.id && membership.role === 'viewer',
    ),
    true,
  );
  const revokedAt = '2026-01-02T03:04:40.000Z';
  revokedRow.revoked_at = revokedAt;
  setTime('2026-01-02T03:05:01.000Z');

  const listed = await service.listSessions(current.token);
  assert.ok(listed);
  assert.deepEqual(
    new Set(listed.map((session) => session.id)),
    new Set([String(currentRow.id), String(activeOtherRow.id), String(revokedRow.id), String(expiredRow.id)]),
  );
  assert.equal(
    listed.some((session) => session.id === String(otherRow.id)),
    false,
  );
  const viewerSessions = await service.listSessions(otherSession.token);
  assert.deepEqual(
    viewerSessions?.map((session) => session.id),
    [String(otherRow.id)],
  );
  assert.equal(await service.revokeSession(otherSession.token, String(currentRow.id)), undefined);
  assert.equal(currentRow.revoked_at, null);
  const byId = new Map(listed.map((session) => [session.id, session]));
  assert.equal(byId.get(String(currentRow.id))?.status, 'active');
  assert.equal(byId.get(String(currentRow.id))?.current, true);
  assert.equal(byId.get(String(activeOtherRow.id))?.status, 'active');
  assert.equal(byId.get(String(revokedRow.id))?.status, 'revoked');
  assert.equal(byId.get(String(revokedRow.id))?.revokedAt, revokedAt);
  assert.equal(byId.get(String(expiredRow.id))?.status, 'expired');
  for (const session of listed) {
    assert.deepEqual(Object.keys(session).sort(), ['createdAt', 'current', 'expiresAt', 'id', 'revokedAt', 'status']);
  }

  assert.equal(await service.revokeSession(current.token, String(otherRow.id)), undefined);
  assert.equal(otherRow.revoked_at, null);

  const firstRevoke = await service.revokeOtherSessions(current.token);
  assert.deepEqual(firstRevoke, { revokedCount: 1, currentSessionPreserved: true });
  assert.equal(currentRow.revoked_at, null);
  assert.equal(activeOtherRow.revoked_at, '2026-01-02T03:05:01.000Z');
  assert.equal(revokedRow.revoked_at, revokedAt);
  assert.equal(expiredRow.revoked_at, null);
  assert.equal(otherRow.revoked_at, null);
  assert.deepEqual(await service.revokeOtherSessions(current.token), {
    revokedCount: 0,
    currentSessionPreserved: true,
  });
  assert.deepEqual((await service.listSessions(current.token))?.find((session) => session.current)?.id, currentRow.id);

  const currentSessionLocks = database.queryLog.filter(
    (entry) =>
      /SELECT id, user_id, expires_at, revoked_at\s+FROM saas_sessions/i.test(entry.sql) &&
      /FOR UPDATE/i.test(entry.sql),
  );
  assert.equal(currentSessionLocks.length, 4);
  assert.ok(currentSessionLocks.every((entry) => entry.transactionId !== null));
  assert.ok(database.queryLog.some((entry) => /WITH selected_session AS[\s\S]+FOR UPDATE/i.test(entry.sql)));
  const auditWrites = database.queryLog.filter((entry) => /insert into saas_audit_events/i.test(entry.sql));
  assert.equal(auditWrites.length, 1);
  assert.ok(auditWrites[0]?.transactionId !== null);
  assert.equal(auditWrites[0]?.values.includes(current.token), false);
  assert.equal(auditWrites[0]?.values.includes(otherSession.token), false);
});

test('selected session revocation is idempotent and explicitly reports current-session revocation', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const current = await service.login({ email: owner.email, password, ttlSeconds: 3600 });
  const selected = await service.login({ email: owner.email, password, ttlSeconds: 3600 });
  assert.ok(current && selected);

  const selectedRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(selected.token).digest('hex'),
  );
  const currentRow = database.state.sessions.find(
    (session) => session.token_hash === createHash('sha256').update(current.token).digest('hex'),
  );
  assert.ok(selectedRow && currentRow);

  const first = await service.revokeSession(current.token, String(selectedRow.id));
  assert.deepEqual(first, {
    sessionId: selectedRow.id,
    revokedAt: initialTime,
    currentSessionRevoked: false,
  });
  assert.deepEqual(await service.revokeSession(current.token, String(selectedRow.id)), first);
  assert.equal(selectedRow.revoked_at, initialTime);
  assert.equal(await service.getSession(selected.token), undefined);
  assert.notEqual(currentRow.revoked_at, initialTime);

  const currentRevocation = await service.revokeSession(current.token, String(currentRow.id));
  assert.deepEqual(currentRevocation, {
    sessionId: currentRow.id,
    revokedAt: initialTime,
    currentSessionRevoked: true,
  });
  assert.equal(database.queryLog.filter((entry) => /insert into saas_audit_events/i.test(entry.sql)).length, 2);
  assert.equal(await service.getSession(current.token), undefined);
  await assert.rejects(service.revokeOtherSessions(current.token), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
  });
});

test('platform role or platform-session credentials do not create a customer session audience', async () => {
  const { database, service } = createFixture();
  const platformAdmin = await createBootstrapAdmin(service);
  assert.equal(
    database.state.platformRoleAssignments.some((assignment) => assignment.user_id === platformAdmin.id),
    true,
  );

  assert.equal(await service.listSessions('platform-session-token-without-customer-row'), undefined);
  await assert.rejects(service.revokeOtherSessions('platform-session-token-without-customer-row'), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
  });
  assert.equal(
    database.queryLog.some((entry) => /saas_platform_sessions/i.test(entry.sql)),
    false,
  );
});

test('tenant and default project creation is atomic and scoped to the creator', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);

  database.failNextProjectInsert = true;
  await expectCode(service.createTenant(owner.id, { name: 'Rolled Back Workspace' }), 'IDENTITY_STORAGE_ERROR');
  assert.equal(database.state.tenants.length, 0);
  assert.equal(database.state.memberships.length, 0);
  assert.equal(database.state.projects.length, 0);

  const firstTenant = await service.createTenant(owner.id, { name: 'First Workspace' });
  assert.equal(firstTenant.role, 'owner');
  assert.ok(firstTenant.defaultProjectId);
  assert.deepEqual(
    database.state.projects.map(({ id, name, slug }) => ({ id, name, slug })),
    [{ id: firstTenant.defaultProjectId, name: 'Default', slug: 'default' }],
  );
  assert.equal(database.state.projects[0]?.is_default, true);
  assert.deepEqual(
    database.state.projectMemberships.map(({ tenant_id, project_id, user_id, role, status }) => ({
      tenant_id,
      project_id,
      user_id,
      role,
      status,
    })),
    [
      {
        tenant_id: firstTenant.id,
        project_id: firstTenant.defaultProjectId,
        user_id: owner.id,
        role: 'owner',
        status: 'active',
      },
    ],
  );

  const invitation = await service.createInvitation(owner.id, firstTenant.id, {
    email: 'second@example.com',
    role: 'viewer',
  });
  const second = await service.acceptInvitation({
    token: invitation.token,
    email: 'second@example.com',
    displayName: 'Second User',
    password: 'a different secure password',
  });
  assert.deepEqual(
    database.state.projectMemberships.find(
      (membership) =>
        membership.tenant_id === firstTenant.id &&
        membership.project_id === firstTenant.defaultProjectId &&
        membership.user_id === second.id,
    ),
    {
      tenant_id: firstTenant.id,
      project_id: firstTenant.defaultProjectId,
      user_id: second.id,
      role: 'viewer',
      status: 'active',
      revoked_at: null,
      created_at: initialTime,
      updated_at: initialTime,
    },
  );
  const secondTenant = await service.createTenant(second.id, { name: 'Second Workspace' });

  const ownerTenants = await service.listTenants(owner.id);
  assert.deepEqual(
    ownerTenants.map((tenant) => ({ id: tenant.id, defaultProjectId: tenant.defaultProjectId })),
    [{ id: firstTenant.id, defaultProjectId: firstTenant.defaultProjectId }],
  );
  assert.equal(
    (await service.resolveTenantContext({ userId: owner.id, tenantId: firstTenant.id })).projectId,
    firstTenant.defaultProjectId,
  );
  const ownerDefaultMembership = database.state.projectMemberships.find(
    (membership) =>
      membership.tenant_id === firstTenant.id &&
      membership.project_id === firstTenant.defaultProjectId &&
      membership.user_id === owner.id,
  );
  assert.ok(ownerDefaultMembership);
  ownerDefaultMembership.role = 'viewer';
  assert.deepEqual(
    await service.authorizeProjectAccess({
      userId: owner.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
    }),
    {
      userId: owner.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
      tenantRole: 'owner',
      projectRole: 'viewer',
    },
  );
  ownerDefaultMembership.role = 'owner';
  assert.deepEqual(
    (await service.listTenants(second.id)).map(({ id, role, defaultProjectId }) => ({ id, role, defaultProjectId })),
    [
      { id: firstTenant.id, role: 'viewer', defaultProjectId: firstTenant.defaultProjectId },
      { id: secondTenant.id, role: 'owner', defaultProjectId: secondTenant.defaultProjectId },
    ],
  );
  assert.deepEqual(
    await service.authorizeProjectAccess({
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
    }),
    {
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
      tenantRole: 'viewer',
      projectRole: 'viewer',
    },
  );
  const otherProjectId = '20000000-0000-4000-8000-000000000001';
  database.state.projects.push({
    tenant_id: firstTenant.id,
    id: otherProjectId,
    name: 'Isolated project',
    slug: 'isolated-project',
    slug_canonical: 'isolated-project',
    is_default: false,
    created_at: '2026-01-02T03:05:05.000Z',
    updated_at: '2026-01-02T03:05:05.000Z',
  });
  assert.deepEqual(
    (await service.listTenants(second.id)).map(({ id, defaultProjectId }) => ({ id, defaultProjectId })),
    [
      { id: firstTenant.id, defaultProjectId: firstTenant.defaultProjectId },
      { id: secondTenant.id, defaultProjectId: secondTenant.defaultProjectId },
    ],
  );
  assert.equal(
    (await service.resolveTenantContext({ userId: second.id, tenantId: firstTenant.id })).projectId,
    firstTenant.defaultProjectId,
  );
  await expectCode(
    service.authorizeProjectAccess({
      userId: owner.id,
      tenantId: firstTenant.id,
      projectId: otherProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(
    service.authorizeProjectAccess({
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: otherProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(
    service.authorizeProjectAccess({
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: '30000000-0000-4000-8000-000000000001',
    }),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(
    service.authorizeProjectAccess({
      userId: owner.id,
      tenantId: firstTenant.id,
      projectId: secondTenant.defaultProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(
    service.resolveTenantContext({
      userId: owner.id,
      tenantId: firstTenant.id,
      projectId: secondTenant.defaultProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(
    service.resolveTenantContext({
      userId: owner.id,
      tenantId: '40000000-0000-4000-8000-000000000001',
    }),
    'TENANT_ACCESS_DENIED',
  );
  const selectedTenantLogin = await service.login({
    email: owner.email,
    password,
    activeTenantId: firstTenant.id,
    ttlSeconds: 3600,
  });
  assert.ok(selectedTenantLogin);
  assert.equal(selectedTenantLogin?.session.activeTenantId, null);
  const unrelatedTenantLogin = await service.login({
    email: owner.email,
    password,
    activeTenantId: secondTenant.id,
    ttlSeconds: 3600,
  });
  assert.ok(unrelatedTenantLogin);
  assert.equal(unrelatedTenantLogin?.session.activeTenantId, null);
  await expectCode(
    service.createInvitation(owner.id, secondTenant.id, {
      email: 'outsider@example.com',
      role: 'viewer',
    }),
    'TENANT_ACCESS_DENIED',
  );

  const projectMembership = database.state.projectMemberships.find(
    (membership) =>
      membership.tenant_id === firstTenant.id &&
      membership.project_id === firstTenant.defaultProjectId &&
      membership.user_id === second.id,
  );
  assert.ok(projectMembership);
  projectMembership.status = 'suspended';
  assert.deepEqual(
    (await service.listTenants(second.id)).map(({ id }) => id),
    [secondTenant.id],
  );
  await expectCode(
    service.resolveTenantContext({
      userId: second.id,
      tenantId: firstTenant.id,
    }),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(
    service.resolveTenantContext({
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
  projectMembership.status = 'active';
  projectMembership.status = 'revoked';
  projectMembership.revoked_at = initialTime;
  assert.deepEqual(
    (await service.listTenants(second.id)).map(({ id }) => id),
    [secondTenant.id],
  );
  await expectCode(
    service.resolveTenantContext({
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
  projectMembership.status = 'active';
  projectMembership.revoked_at = null;

  const revokedMembership = database.state.memberships.find(
    (membership) => membership.tenant_id === firstTenant.id && membership.user_id === second.id,
  );
  assert.ok(revokedMembership);
  revokedMembership.status = 'revoked';
  assert.deepEqual(
    (await service.listTenants(second.id)).map(({ id }) => id),
    [secondTenant.id],
  );
  await expectCode(
    service.resolveTenantContext({
      userId: second.id,
      tenantId: firstTenant.id,
      projectId: firstTenant.defaultProjectId,
    }),
    'TENANT_ACCESS_DENIED',
  );
});

test('invitations expire, are single use, and never grant owner', async () => {
  const { database, service, setTime } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const tenant = await service.createTenant(owner.id, { name: 'Acme', slug: 'acme' });

  const expired = await service.createInvitation(owner.id, tenant.id, {
    email: 'expired@example.com',
    role: 'viewer',
    ttlSeconds: 30,
  });
  assert.equal(database.state.invitations[0]?.token_hash === expired.token, false);
  assert.equal(String(database.state.invitations[0]?.token_hash).length, 64);
  setTime('2026-01-02T03:04:35.001Z');
  await expectCode(
    service.acceptInvitation({
      token: expired.token,
      email: 'expired@example.com',
      displayName: 'Expired Invite',
      password,
    }),
    'INVITATION_INVALID',
  );

  const adminInvite = await service.createInvitation(owner.id, tenant.id, {
    email: 'admin@example.com',
    role: 'admin',
  });
  assert.equal(database.state.invitations[1]?.token_hash === adminInvite.token, false);
  await expectCode(
    service.acceptInvitation({
      token: adminInvite.token,
      email: 'admin@example.com',
      displayName: 'Tenant Admin',
      password: 'short-pass',
    }),
    'INVALID_INPUT',
  );
  const admin = await service.acceptInvitation({
    token: adminInvite.token,
    email: 'admin@example.com',
    displayName: 'Tenant Admin',
    password: 'admin password 123',
  });
  assert.equal((await service.listTenants(admin.id))[0]?.role, 'admin');

  const invitedRoles = ['developer', 'billing', 'viewer'] as const;
  let viewerUserId: string | undefined;
  for (const role of invitedRoles) {
    const email = `${role}@example.com`;
    const invite = await service.createInvitation(admin.id, tenant.id, { email, role });
    const identity = await service.acceptInvitation({
      token: invite.token,
      email,
      displayName: `${role} User`,
      password: `${role} password with enough length`,
    });
    assert.equal((await service.listTenants(identity.id))[0]?.role, role);
    assert.equal(
      database.state.projectMemberships.find(
        (membership) =>
          membership.tenant_id === tenant.id &&
          membership.project_id === tenant.defaultProjectId &&
          membership.user_id === identity.id,
      )?.role,
      role,
    );
    if (role === 'viewer') viewerUserId = identity.id;
  }
  assert.ok(viewerUserId);

  await expectCode(
    service.createInvitation(owner.id, tenant.id, {
      email: 'additional-owner@example.com',
      role: 'owner' as never,
    }),
    'INVALID_INVITATION_ROLE',
  );
  database.state.invitations.push({
    tenant_id: tenant.id,
    id: 'legacy-owner-invitation',
    invited_email: 'legacy-owner@example.com',
    invited_email_canonical: 'legacy-owner@example.com',
    role: 'owner',
    token_hash: 'legacy-owner-token-hash',
    created_by_user_id: owner.id,
    accepted_by_user_id: null,
    created_at: initialTime,
    expires_at: '2026-01-09T03:04:05.000Z',
    accepted_at: null,
    revoked_at: null,
  });
  await expectCode(
    service.acceptInvitation({
      token: 'legacy-owner-token-hash',
      email: 'legacy-owner@example.com',
      displayName: 'Legacy Owner',
      password: 'legacy owner password',
    }),
    'INVITATION_INVALID',
  );

  await expectCode(
    service.createInvitation(admin.id, tenant.id, {
      email: 'another-admin@example.com',
      role: 'admin',
    }),
    'INSUFFICIENT_TENANT_ROLE',
  );
  await expectCode(
    service.createInvitation(admin.id, tenant.id, {
      email: 'another-owner@example.com',
      role: 'owner' as never,
    }),
    'INVALID_INVITATION_ROLE',
  );
  await expectCode(
    service.createInvitation(viewerUserId, tenant.id, {
      email: 'another-viewer@example.com',
      role: 'viewer',
    }),
    'INSUFFICIENT_TENANT_ROLE',
  );
  const ownerGrantedInvite = await service.createInvitation(owner.id, tenant.id, {
    email: 'valid-owner-grant@example.com',
    role: 'developer',
  });
  assert.ok(ownerGrantedInvite.token);
  await expectCode(
    service.createInvitation(owner.id, tenant.id, {
      email: 'old-role@example.com',
      role: 'member' as never,
    }),
    'INVALID_INVITATION_ROLE',
  );

  await expectCode(
    service.acceptInvitation({
      token: adminInvite.token,
      email: 'admin@example.com',
      displayName: 'Tenant Admin',
      password: 'admin password 123',
    }),
    'INVITATION_INVALID',
  );
});

test('projects are tenant-scoped, role-backed, and atomically created without replacing the default', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const tenant = await service.createTenant(owner.id, { name: 'Project Tenant' });
  const otherTenant = await service.createTenant(owner.id, { name: 'Other Tenant' });

  const firstProject = await service.createProject(owner.id, tenant.id, {
    name: 'Project One',
    slug: 'project-one',
  });
  assert.equal(firstProject.tenantId, tenant.id);
  assert.equal(firstProject.role, 'owner');
  const authorizationQuery = database.queryLog
    .slice()
    .reverse()
    .find((query) =>
      query.sql.replace(/\s+/g, ' ').trim().toLowerCase().startsWith('select m.role from saas_memberships'),
    );
  const projectInsert = database.queryLog
    .slice()
    .reverse()
    .find((query) => query.sql.replace(/\s+/g, ' ').trim().toLowerCase().startsWith('insert into saas_projects'));
  const projectMembershipInsert = database.queryLog
    .slice()
    .reverse()
    .find((query) =>
      query.sql.replace(/\s+/g, ' ').trim().toLowerCase().startsWith('insert into saas_project_memberships'),
    );
  assert.ok(authorizationQuery);
  assert.doesNotMatch(authorizationQuery.sql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  const transactionQueries = database.queryLog.filter(
    (query) => query.transactionId === authorizationQuery.transactionId,
  );
  const tenantFenceIndex = transactionQueries.findIndex((query) => query.sql.includes('saas-authz:tenant:'));
  const userFenceIndex = transactionQueries.findIndex((query) => query.sql.includes('hashtextextended($1::uuid::text'));
  assert.ok(tenantFenceIndex >= 0 && userFenceIndex > tenantFenceIndex);
  assert.ok(userFenceIndex < transactionQueries.indexOf(authorizationQuery));
  assert.ok(projectInsert);
  assert.ok(projectMembershipInsert);
  assert.equal(authorizationQuery.transactionId, projectInsert.transactionId);
  assert.equal(authorizationQuery.transactionId, projectMembershipInsert.transactionId);
  assert.deepEqual(
    (await service.listProjects(owner.id, tenant.id)).map(({ id, tenantId, name, slug, role }) => ({
      id,
      tenantId,
      name,
      slug,
      role,
    })),
    [
      { id: tenant.defaultProjectId, tenantId: tenant.id, name: 'Default', slug: 'default', role: 'owner' },
      { id: firstProject.id, tenantId: tenant.id, name: 'Project One', slug: 'project-one', role: 'owner' },
    ],
  );
  assert.equal(
    database.state.projects.filter((project) => project.tenant_id === tenant.id && project.is_default).length,
    1,
  );
  assert.equal(database.state.projects.find((project) => project.id === firstProject.id)?.is_default, false);
  assert.deepEqual(
    database.state.projectMemberships.find(
      (membership) =>
        membership.tenant_id === tenant.id &&
        membership.project_id === firstProject.id &&
        membership.user_id === owner.id,
    ),
    {
      tenant_id: tenant.id,
      project_id: firstProject.id,
      user_id: owner.id,
      role: 'owner',
      status: 'active',
      revoked_at: null,
      created_at: initialTime,
      updated_at: initialTime,
    },
  );

  const adminInvitation = await service.createInvitation(owner.id, tenant.id, {
    email: 'project-admin@example.com',
    role: 'admin',
  });
  const admin = await service.acceptInvitation({
    token: adminInvitation.token,
    email: 'project-admin@example.com',
    displayName: 'Project Admin',
    password: 'project admin password',
  });
  const adminProject = await service.createProject(admin.id, tenant.id, { name: 'Admin Project' });
  assert.equal(adminProject.role, 'admin');
  assert.equal(
    database.state.projectMemberships.find(
      (membership) => membership.project_id === adminProject.id && membership.user_id === admin.id,
    )?.role,
    'admin',
  );

  const viewerInvitation = await service.createInvitation(owner.id, tenant.id, {
    email: 'project-viewer@example.com',
    role: 'viewer',
  });
  const viewer = await service.acceptInvitation({
    token: viewerInvitation.token,
    email: 'project-viewer@example.com',
    displayName: 'Project Viewer',
    password: 'project viewer password',
  });
  assert.deepEqual(
    (await service.listProjects(viewer.id, tenant.id)).map(({ id, role }) => ({ id, role })),
    [{ id: tenant.defaultProjectId, role: 'viewer' }],
  );
  await expectCode(service.createProject(viewer.id, tenant.id, { name: 'Denied Project' }), 'INSUFFICIENT_TENANT_ROLE');
  await expectCode(service.listProjects(viewer.id, otherTenant.id), 'TENANT_ACCESS_DENIED');
  await expectCode(service.listProjects(owner.id, '40000000-0000-4000-8000-000000000001'), 'TENANT_ACCESS_DENIED');

  await expectCode(
    service.createProject(owner.id, tenant.id, { name: 'Duplicate', slug: 'PROJECT-ONE' }),
    'IDENTITY_CONFLICT',
  );
  await expectCode(service.createProject(owner.id, tenant.id, { name: 'Invalid', slug: 'not valid' }), 'INVALID_INPUT');

  const projectCount = database.state.projects.length;
  const membershipCount = database.state.projectMemberships.length;
  database.failNextProjectMembershipInsert = true;
  await expectCode(
    service.createProject(owner.id, tenant.id, { name: 'Rolled Back Project' }),
    'IDENTITY_STORAGE_ERROR',
  );
  assert.equal(database.state.projects.length, projectCount);
  assert.equal(database.state.projectMemberships.length, membershipCount);
});

test('project creation rechecks tenant membership after a simulated revocation fence wait (fake SQL)', async () => {
  const { database, service } = createFixture();
  const owner = await createBootstrapAdmin(service);
  const tenant = await service.createTenant(owner.id, { name: 'Membership Fence Tenant' });
  const before = database.state.projects.filter((project) => project.tenant_id === tenant.id).length;
  let revoked = false;
  database.authorizationFenceHook = (sql) => {
    if (!revoked && sql.includes('saas-authz:tenant:')) {
      revoked = true;
      const membership = database.state.memberships.find(
        (candidate) => candidate.tenant_id === tenant.id && candidate.user_id === owner.id,
      );
      if (membership) membership.status = 'revoked';
      database.authorizationFenceHook = undefined;
    }
  };

  await expectCode(service.createProject(owner.id, tenant.id, { name: 'Must Not Exist' }), 'TENANT_ACCESS_DENIED');
  assert.equal(database.state.projects.filter((project) => project.tenant_id === tenant.id).length, before);
});
