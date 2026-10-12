import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPassword } from '../../../../src/saas/identity/password.js';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import { PlatformGovernanceError } from '../../../../src/saas/platform/governance/errors.js';
import { PlatformOperatorManagementService } from '../../../../src/saas/platform/governance/operators.js';
import { emptyFixture, FakeGovernanceDatabase, type GovernanceFixture } from './fake-sql.js';

const SUPERADMIN_ID = '10000000-0000-4000-8000-0000000000aa';
const SECOND_ADMIN_ID = '10000000-0000-4000-8000-0000000000ab';
const TARGET_ID = '10000000-0000-4000-8000-0000000000b1';
const SESSION_ID = '10000000-0000-4000-8000-0000000000c1';
const CREDENTIAL_ID = '10000000-0000-4000-8000-0000000000d1';

function actor(roles: PlatformAdminActor['roles'] = ['superadmin']): PlatformAdminActor {
  return { userId: SUPERADMIN_ID, sessionId: SESSION_ID, roles };
}

function fixture(): GovernanceFixture {
  const base = emptyFixture();
  base.users.push(
    {
      id: SUPERADMIN_ID,
      email_canonical: 'root@example.test',
      display_name: 'Root',
      password_hash: 'scrypt$stored',
      email_verified_at: '2026-01-01T00:00:00.000000Z',
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-01-01T00:00:00.000000Z',
      updated_at: '2026-01-01T00:00:00.000000Z',
    },
    {
      id: SECOND_ADMIN_ID,
      email_canonical: 'second@example.test',
      display_name: null,
      password_hash: null,
      email_verified_at: null,
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-01-02T00:00:00.000000Z',
      updated_at: '2026-01-02T00:00:00.000000Z',
    },
    {
      id: TARGET_ID,
      email_canonical: 'customer@example.test',
      display_name: 'Customer',
      password_hash: 'scrypt$stored',
      email_verified_at: null,
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-02-01T00:00:00.000000Z',
      updated_at: '2026-02-01T00:00:00.000000Z',
    },
  );
  base.roleAssignments.push(
    { user_id: SUPERADMIN_ID, role: 'superadmin' },
    { user_id: SECOND_ADMIN_ID, role: 'superadmin' },
    { user_id: SECOND_ADMIN_ID, role: 'finance' },
  );
  base.platformSessions.push(
    {
      id: SESSION_ID,
      user_id: SUPERADMIN_ID,
      credential_id: CREDENTIAL_ID,
      expires_at: '2027-01-01T00:00:00.000000Z',
      revoked_at: null,
    },
    {
      id: '10000000-0000-4000-8000-0000000000c2',
      user_id: SECOND_ADMIN_ID,
      credential_id: CREDENTIAL_ID,
      expires_at: '2027-01-01T00:00:00.000000Z',
      revoked_at: null,
    },
  );
  base.mfaCredentials.push({
    id: CREDENTIAL_ID,
    user_id: SUPERADMIN_ID,
    kind: 'totp',
    verified_at: '2026-01-01T00:00:00.000000Z',
    revoked_at: null,
  });
  return base;
}

function harness(fixtureData: GovernanceFixture) {
  const database = new FakeGovernanceDatabase(fixtureData);
  const service = new PlatformOperatorManagementService(database, {
    currentDate: () => new Date('2026-10-10T00:00:00.000Z'),
  });
  return { database, service };
}

test('lists operators grouped by user with role sets and safe fields only', async () => {
  const { service } = harness(fixture());
  const operators = await service.listOperators(actor());
  assert.equal(operators.length, 2);
  const second = operators.find((operator) => operator.userId === SECOND_ADMIN_ID);
  assert.deepEqual(second?.roles, ['finance', 'superadmin']);
  assert.deepEqual(Object.keys(operators[0]).sort(), ['disabledAt', 'displayName', 'email', 'roles', 'userId']);
  assert.doesNotMatch(JSON.stringify(operators), /scrypt|password/i);

  const data = fixture();
  data.roleAssignments.splice(0, data.roleAssignments.length, { user_id: SUPERADMIN_ID, role: 'operations' });
  const denied = harness(data).service;
  await assert.rejects(
    denied.listOperators(actor(['operations'])),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
});

test('grants roles idempotently-strict and audits each grant', async () => {
  const data = fixture();
  const { service } = harness(data);

  await service.grantOperatorRole(actor(), TARGET_ID, 'support-readonly');
  assert.ok(data.roleAssignments.some((r) => r.user_id === TARGET_ID && r.role === 'support-readonly'));
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_operator.role_granted'],
  );
  assert.equal(data.auditEvents[0].target_id, `${TARGET_ID}:support-readonly`);

  await assert.rejects(
    service.grantOperatorRole(actor(), TARGET_ID, 'support-readonly'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  await assert.rejects(
    service.grantOperatorRole(actor(), TARGET_ID, 'root'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
  await assert.rejects(
    service.grantOperatorRole(actor(), '10000000-0000-4000-8000-0000000000ff', 'finance'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 404,
  );

  data.users.find((u) => u.id === TARGET_ID)!.disabled_at = '2026-10-01T00:00:00.000000Z';
  await assert.rejects(
    service.grantOperatorRole(actor(), TARGET_ID, 'finance'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 404,
  );
});

test('revocation enforces the last-superadmin invariant and drops platform sessions on final role loss', async () => {
  const data = fixture();
  const { service } = harness(data);

  // Refuse self-revocation.
  await assert.rejects(
    service.revokeOperatorRole(actor(), SUPERADMIN_ID, 'superadmin'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );

  // Missing assignment -> 404.
  await assert.rejects(
    service.revokeOperatorRole(actor(), TARGET_ID, 'finance'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 404,
  );

  // Non-final role loss keeps platform sessions alive.
  await service.revokeOperatorRole(actor(), SECOND_ADMIN_ID, 'finance');
  assert.ok(!data.roleAssignments.some((r) => r.user_id === SECOND_ADMIN_ID && r.role === 'finance'));
  assert.equal(data.platformSessions.find((s) => s.user_id === SECOND_ADMIN_ID)?.revoked_at, null);

  // Final role loss revokes platform sessions.
  await service.revokeOperatorRole(actor(), SECOND_ADMIN_ID, 'superadmin');
  assert.equal(
    data.platformSessions.find((s) => s.user_id === SECOND_ADMIN_ID)?.revoked_at,
    '2026-10-10T00:00:00.000Z',
  );
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_operator.role_revoked', 'platform_operator.role_revoked'],
  );

  // The last remaining superadmin can never be revoked.
  await assert.rejects(
    service.revokeOperatorRole(actor(), SUPERADMIN_ID, 'superadmin'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );

  const deniedData = fixture();
  deniedData.roleAssignments.splice(0, deniedData.roleAssignments.length, {
    user_id: SUPERADMIN_ID,
    role: 'operations',
  });
  const denied = harness(deniedData).service;
  await assert.rejects(
    denied.revokeOperatorRole(actor(['operations']), SECOND_ADMIN_ID, 'finance'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
});

test('createOperator stores a scrypt hash, assigns the role, and audits without the password', async () => {
  const data = fixture();
  const { service } = harness(data);
  const password = 'operator-initial-pass-001';

  const created = await service.createOperator(actor(), {
    email: 'NewOperator@Example.Test',
    displayName: '  New Operator  ',
    password,
    role: 'operations',
  });
  assert.match(created.userId, /^[0-9a-f-]{36}$/);
  assert.equal(created.email, 'newoperator@example.test');
  assert.equal(created.displayName, 'New Operator');
  assert.deepEqual(created.roles, ['operations']);

  const stored = data.users.find((u) => u.id === created.userId);
  assert.ok(stored);
  assert.match(stored.password_hash ?? '', /^scrypt\$/);
  assert.ok(await verifyPassword(password, stored.password_hash));
  assert.ok(data.roleAssignments.some((r) => r.user_id === created.userId && r.role === 'operations'));
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_operator.created'],
  );
  assert.doesNotMatch(JSON.stringify(data.auditEvents), /operator-initial-pass/);

  await assert.rejects(
    service.createOperator(actor(), { email: 'newoperator@example.test', password, role: 'security' }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  for (const bad of [
    { email: 'not-an-email', password, role: 'security' },
    { email: 'valid@example.test', password: 'short', role: 'security' },
    { email: 'valid@example.test', password, role: 'root' },
  ]) {
    await assert.rejects(
      service.createOperator(actor(), bad),
      (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
    );
  }
  await assert.rejects(
    service.createOperator(actor(), { email: 'x@y.test', password, role: 'security', extra: true }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
});
