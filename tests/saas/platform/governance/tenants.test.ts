import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import { PlatformGovernanceError } from '../../../../src/saas/platform/governance/errors.js';
import { PlatformTenantLifecycleService } from '../../../../src/saas/platform/governance/tenants.js';
import { emptyFixture, FakeGovernanceDatabase, type GovernanceFixture } from './fake-sql.js';

const OPERATOR_ID = '10000000-0000-4000-8000-0000000000aa';
const OWNER_ID = '10000000-0000-4000-8000-0000000000b1';
const MEMBER_ID = '10000000-0000-4000-8000-0000000000b2';
const TENANT_A = '20000000-0000-4000-8000-0000000000a1';
const TENANT_B = '20000000-0000-4000-8000-0000000000a2';
const SESSION_ID = '10000000-0000-4000-8000-0000000000c1';
const CREDENTIAL_ID = '10000000-0000-4000-8000-0000000000d1';

function actor(roles: PlatformAdminActor['roles'] = ['operations']): PlatformAdminActor {
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
      id: OWNER_ID,
      email_canonical: 'owner@example.test',
      display_name: null,
      password_hash: null,
      email_verified_at: null,
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-02-01T00:00:00.000000Z',
      updated_at: '2026-02-01T00:00:00.000000Z',
    },
    {
      id: MEMBER_ID,
      email_canonical: 'member@example.test',
      display_name: null,
      password_hash: null,
      email_verified_at: null,
      disabled_at: null,
      anonymized_at: null,
      created_at: '2026-02-02T00:00:00.000000Z',
      updated_at: '2026-02-02T00:00:00.000000Z',
    },
  );
  base.roleAssignments.push({ user_id: OPERATOR_ID, role: 'operations' });
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
  base.tenants.push(
    {
      id: TENANT_A,
      name: 'Alpha Tenant',
      slug_canonical: 'alpha-tenant',
      status: 'active',
      created_at: '2026-03-01T00:00:00.123456Z',
      updated_at: '2026-03-01T00:00:00.000000Z',
    },
    {
      id: TENANT_B,
      name: 'Beta Tenant',
      slug_canonical: 'beta-tenant',
      status: 'suspended',
      created_at: '2026-04-01T00:00:00.000000Z',
      updated_at: '2026-04-01T00:00:00.000000Z',
    },
  );
  base.memberships.push(
    { tenant_id: TENANT_A, user_id: OWNER_ID, role: 'owner', status: 'active', revoked_at: null },
    { tenant_id: TENANT_A, user_id: MEMBER_ID, role: 'developer', status: 'active', revoked_at: null },
  );
  return base;
}

function harness(fixtureData: GovernanceFixture) {
  const database = new FakeGovernanceDatabase(fixtureData);
  const service = new PlatformTenantLifecycleService(database, {
    cursorSecret: 'test-cursor-secret-material',
    currentDate: () => new Date('2026-10-10T00:00:00.000Z'),
  });
  return { database, service };
}

test('lists tenants with status/slug filters, keyset pagination, and the exact safe projection', async () => {
  const { service } = harness(fixture());
  const all = await service.listTenants(actor(), { limit: 1 });
  assert.equal(all.items.length, 1);
  assert.deepEqual(Object.keys(all.items[0]).sort(), ['createdAt', 'id', 'name', 'slug', 'status', 'updatedAt']);
  assert.equal(all.items[0].id, TENANT_B);
  assert.ok(all.nextCursor);

  const rest = await service.listTenants(actor(), { limit: 1, cursor: all.nextCursor });
  assert.deepEqual(
    rest.items.map((item) => item.id),
    [TENANT_A],
  );
  assert.equal(rest.nextCursor, null);

  const suspended = await service.listTenants(actor(), { status: 'suspended' });
  assert.deepEqual(
    suspended.items.map((item) => item.id),
    [TENANT_B],
  );
  const search = await service.listTenants(actor(), { slugContains: 'alpha' });
  assert.deepEqual(
    search.items.map((item) => item.id),
    [TENANT_A],
  );

  await assert.rejects(
    service.listTenants(actor(), { status: 'deleted' as 'active' }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
  await assert.rejects(
    service.listTenants(actor(['finance'])),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
});

test('suspend/resume/close follow the state machine and audit every transition', async () => {
  const data = fixture();
  const { service } = harness(data);

  const suspended = await service.setTenantStatus(actor(), TENANT_A, 'suspend');
  assert.equal(suspended.status, 'suspended');
  assert.equal(data.tenants.find((t) => t.id === TENANT_A)?.status, 'suspended');
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_tenant.suspended'],
  );
  assert.equal(data.auditEvents[0].tenant_id, TENANT_A);

  await assert.rejects(
    service.setTenantStatus(actor(), TENANT_A, 'suspend'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );

  const resumed = await service.setTenantStatus(actor(), TENANT_A, 'resume');
  assert.equal(resumed.status, 'active');

  await assert.rejects(
    service.setTenantStatus(actor(), TENANT_A, 'resume'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );

  const closed = await service.setTenantStatus(actor(), TENANT_A, 'close');
  assert.equal(closed.status, 'closed');
  await assert.rejects(
    service.setTenantStatus(actor(), TENANT_A, 'close'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  await assert.rejects(
    service.setTenantStatus(actor(), TENANT_A, 'resume'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );

  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_tenant.suspended', 'platform_tenant.resumed', 'platform_tenant.closed'],
  );

  await assert.rejects(
    service.setTenantStatus(actor(['support-readonly']), TENANT_B, 'resume'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  await assert.rejects(
    service.setTenantStatus(actor(), '20000000-0000-4000-8000-0000000000ff', 'close'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 404,
  );
  await assert.rejects(
    service.setTenantStatus(actor(), TENANT_B, 'wipe'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
});

test('takeover promotes the target and demotes every owner atomically with audit', async () => {
  const data = fixture();
  data.roleAssignments.splice(0, data.roleAssignments.length, { user_id: OPERATOR_ID, role: 'superadmin' });
  const { service } = harness(data);

  await service.takeoverTenant(actor(['superadmin']), TENANT_A, MEMBER_ID);
  assert.equal(data.memberships.find((m) => m.user_id === MEMBER_ID)?.role, 'owner');
  assert.equal(data.memberships.find((m) => m.user_id === OWNER_ID)?.role, 'admin');
  assert.deepEqual(
    data.auditEvents.map((event) => event.action),
    ['platform_tenant.ownership_taken_over'],
  );
  assert.equal(data.auditEvents[0].actor_user_id, OPERATOR_ID);

  await assert.rejects(
    service.takeoverTenant(actor(['superadmin']), TENANT_A, MEMBER_ID),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
  await assert.rejects(
    service.takeoverTenant(actor(['superadmin']), TENANT_A, '10000000-0000-4000-8000-0000000000ff'),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 404,
  );
  // Non-superadmin with matching fresh assignments hits the takeover role gate.
  data.roleAssignments.splice(0, data.roleAssignments.length, { user_id: OPERATOR_ID, role: 'operations' });
  await assert.rejects(
    service.takeoverTenant(actor(), TENANT_A, OWNER_ID),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 403,
  );
  data.roleAssignments.splice(0, data.roleAssignments.length, { user_id: OPERATOR_ID, role: 'superadmin' });
  await assert.rejects(
    service.takeoverTenant(actor(['superadmin']), TENANT_A, OPERATOR_ID),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );

  data.tenants.find((t) => t.id === TENANT_A)!.status = 'closed';
  await assert.rejects(
    service.takeoverTenant(actor(['superadmin']), TENANT_A, OWNER_ID),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
});
