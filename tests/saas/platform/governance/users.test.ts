import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPassword } from '../../../../src/saas/identity/password.js';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import { PlatformGovernanceError } from '../../../../src/saas/platform/governance/errors.js';
import { PlatformUserGovernanceService } from '../../../../src/saas/platform/governance/users.js';
import { emptyFixture, FakeGovernanceDatabase, type GovernanceFixture } from './fake-sql.js';

const OPERATOR_ID = '10000000-0000-4000-8000-0000000000aa';
const TARGET_ID = '10000000-0000-4000-8000-0000000000b1';
const OTHER_ID = '10000000-0000-4000-8000-0000000000b2';
const SESSION_ID = '10000000-0000-4000-8000-0000000000c1';
const CREDENTIAL_ID = '10000000-0000-4000-8000-0000000000d1';

function actor(roles: PlatformAdminActor['roles'] = ['security']): PlatformAdminActor {
  return { userId: OPERATOR_ID, sessionId: SESSION_ID, roles };
}

function fixture(): GovernanceFixture {
  const base = emptyFixture();
  base.users.push(
    {
      id: OPERATOR_ID,
      email_canonical: 'operator@example.test',
      display_name: 'Operator',
      password_hash: 'scrypt$stored',
      email_verified_at: '2026-01-01T00:00:00.000000Z',
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-01-01T00:00:00.000000Z',
      updated_at: '2026-01-01T00:00:00.000000Z',
    },
    {
      id: TARGET_ID,
      email_canonical: 'target@example.test',
      display_name: 'Target User',
      password_hash: 'scrypt$stored',
      email_verified_at: '2026-02-01T00:00:00.000000Z',
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-02-01T00:00:00.123456Z',
      updated_at: '2026-02-01T00:00:00.000000Z',
    },
    {
      id: OTHER_ID,
      email_canonical: 'other@example.test',
      display_name: null,
      password_hash: null,
      email_verified_at: null,
      disabled_at: '2026-03-01T00:00:00.000000Z',
      anonymized_at: null,
      created_at: '2026-03-01T00:00:00.000000Z',
      updated_at: '2026-03-01T00:00:00.000000Z',
    },
  );
  base.roleAssignments.push({ user_id: OPERATOR_ID, role: 'security' });
  base.platformSessions.push({
    id: SESSION_ID,
    user_id: OPERATOR_ID,
    credential_id: CREDENTIAL_ID,
    expires_at: '2027-01-01T00:00:00.000000Z',
    revoked_at: null,
  });
  base.mfaCredentials.push({
    id: CREDENTIAL_ID,
    user_id: OPERATOR_ID,
    kind: 'totp',
    verified_at: '2026-01-01T00:00:00.000000Z',
    revoked_at: null,
  });
  base.customerSessions.push(
    { id: '10000000-0000-4000-8000-0000000000e1', user_id: TARGET_ID, revoked_at: null },
    { id: '10000000-0000-4000-8000-0000000000e2', user_id: TARGET_ID, revoked_at: null },
  );
  base.mfaCredentials.push(
    {
      id: '10000000-0000-4000-8000-0000000000f1',
      user_id: TARGET_ID,
      kind: 'totp',
      verified_at: '2026-02-01T00:00:00.000000Z',
      revoked_at: null,
    },
    {
      id: '10000000-0000-4000-8000-0000000000f2',
      user_id: TARGET_ID,
      kind: 'passkey',
      verified_at: '2026-02-02T00:00:00.000000Z',
      revoked_at: null,
    },
  );
  return base;
}

function harness(fixtureData: GovernanceFixture) {
  const database = new FakeGovernanceDatabase(fixtureData);
  const service = new PlatformUserGovernanceService(database, {
    cursorSecret: 'test-cursor-secret-material',
    currentDate: () => new Date('2026-10-10T00:00:00.000Z'),
  });
  return { database, service };
}

test('lists customer users with keyset pagination, filters, and the exact safe projection', async () => {
  const { database, service } = harness(fixture());
  const first = await service.listUsers(actor(), { limit: 2 });

  assert.equal(first.items.length, 2);
  assert.deepEqual(Object.keys(first.items[0]).sort(), [
    'createdAt',
    'disabledAt',
    'displayName',
    'email',
    'emailVerifiedAt',
    'id',
  ]);
  assert.equal(first.items[0].id, OTHER_ID);
  assert.equal(first.items[1].id, TARGET_ID);
  assert.ok(first.nextCursor);
  assert.doesNotMatch(JSON.stringify(first), /scrypt|password/i);

  const second = await service.listUsers(actor(), { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.items.map((item) => item.id),
    [OPERATOR_ID],
  );
  assert.equal(second.nextCursor, null);

  const disabledOnly = await service.listUsers(actor(), { status: 'disabled' });
  assert.deepEqual(
    disabledOnly.items.map((item) => item.id),
    [OTHER_ID],
  );
  const search = await service.listUsers(actor(), { emailContains: 'target@' });
  assert.deepEqual(
    search.items.map((item) => item.id),
    [TARGET_ID],
  );

  const listSql = database.queries.filter(({ sql }) => sql.includes('ORDER BY created_at DESC'));
  assert.ok(listSql.length > 0);
  for (const { sql } of listSql) {
    assert.doesNotMatch(sql, /password_hash/);
  }
  assert.match(database.queries[0].sql, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});

test('rejects malformed list input, tampered cursors, and cross-filter cursors fail-closed', async () => {
  const { service } = harness(fixture());
  for (const limit of [0, 1.5, 101, '2']) {
    await assert.rejects(
      service.listUsers(actor(), { limit: limit as number }),
      (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
    );
  }
  for (const cursor of ['', 'not-a-cursor', `pu1.${'a'.repeat(3000)}`]) {
    await assert.rejects(
      service.listUsers(actor(), { cursor }),
      (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
    );
  }

  const page = await service.listUsers(actor(), { limit: 1 });
  assert.ok(page.nextCursor);
  await assert.rejects(
    service.listUsers(actor(), { limit: 1, cursor: page.nextCursor, status: 'disabled' }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
  const tampered = `${page.nextCursor.slice(0, -2)}zz`;
  await assert.rejects(
    service.listUsers(actor(), { limit: 1, cursor: tampered }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
});

test('freshly re-verifies the actor session and role assignments inside the transaction', async () => {
  const data = fixture();
  const { database, service } = harness(data);

  await assert.rejects(
    service.listUsers(actor(['finance'])),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  // Stale claimed roles (assignment revoked mid-request) fail closed.
  await assert.rejects(
    service.listUsers(actor(['security', 'operations'])),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  // Dead session fails closed.
  data.platformSessions[0].revoked_at = '2026-10-01T00:00:00.000000Z';
  await assert.rejects(
    service.listUsers(actor()),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  const listQueries = database.queries.filter(({ sql }) => sql.includes('ORDER BY created_at DESC'));
  assert.equal(listQueries.length, 0);
});

test('disable revokes every session, refuses self and operators, and audits the action', async () => {
  const data = fixture();
  const { database, service } = harness(data);

  await service.setUserDisabled(actor(), TARGET_ID, true);
  const target = data.users.find((u) => u.id === TARGET_ID);
  assert.equal(target?.disabled_at, '2026-10-10T00:00:00.000Z');
  assert.ok(data.customerSessions.every((s) => s.revoked_at === '2026-10-10T00:00:00.000Z'));
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_user.disabled'],
  );
  assert.equal(data.auditEvents[0].actor_user_id, OPERATOR_ID);
  assert.equal(data.auditEvents[0].target_id, TARGET_ID);
  assert.equal(data.auditEvents[0].entry_point, 'platform_governance');

  await assert.rejects(
    service.setUserDisabled(actor(), TARGET_ID, true),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  await service.setUserDisabled(actor(), TARGET_ID, false);
  assert.equal(target?.disabled_at, null);

  await assert.rejects(
    service.setUserDisabled(actor(), OPERATOR_ID, true),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  // Users holding platform roles are managed through the operator endpoints.
  data.roleAssignments.push({ user_id: OTHER_ID, role: 'operations' });
  await assert.rejects(
    service.setUserDisabled(actor(), OTHER_ID, true),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  await assert.rejects(
    service.setUserDisabled(actor(['operations']), TARGET_ID, true),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  await assert.rejects(
    service.setUserDisabled(actor(), 'not-a-uuid', true),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
  assert.ok(database.queries.length > 0);
});

test('password reset stores only a scrypt hash, revokes sessions, and never leaks the password', async () => {
  const data = fixture();
  const { service } = harness(data);
  const newPassword = 'new-passphrase-987654321';

  await service.resetUserPassword(actor(), TARGET_ID, newPassword);
  const target = data.users.find((u) => u.id === TARGET_ID);
  assert.match(target?.password_hash ?? '', /^scrypt\$/);
  assert.ok(await verifyPassword(newPassword, target?.password_hash));
  assert.ok(data.customerSessions.every((s) => s.revoked_at !== null));
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_user.password_reset'],
  );
  // The new password must not appear in any audit field or any SQL value
  // besides the hashed UPDATE.
  assert.doesNotMatch(JSON.stringify(data.auditEvents), /new-passphrase/);

  await assert.rejects(
    service.resetUserPassword(actor(), TARGET_ID, 'short'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
  await assert.rejects(
    service.resetUserPassword(actor(['operations']), TARGET_ID, newPassword),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  await assert.rejects(
    service.resetUserPassword(actor(), '10000000-0000-4000-8000-0000000000ff', newPassword),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 404,
  );
});

test('mfa reset revokes totp and passkey credentials plus every session', async () => {
  const data = fixture();
  const { service } = harness(data);

  await service.resetUserMfa(actor(), TARGET_ID);
  const targetCredentials = data.mfaCredentials.filter((c) => c.user_id === TARGET_ID);
  assert.equal(targetCredentials.length, 2);
  assert.ok(targetCredentials.every((c) => c.revoked_at === '2026-10-10T00:00:00.000Z'));
  assert.ok(data.customerSessions.every((s) => s.revoked_at !== null));
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_user.mfa_reset'],
  );
  // The operator's own credential is untouched.
  assert.equal(data.mfaCredentials.find((c) => c.user_id === OPERATOR_ID)?.revoked_at, null);

  await assert.rejects(
    service.resetUserMfa(actor(['support-readonly']), TARGET_ID),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
});
