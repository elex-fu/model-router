import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { TenantRole } from '../../../src/saas/identity/types.js';
import { FakeSaasDatabase } from './fake-database.js';

const NOW = '2026-10-10T00:00:00.000Z';

function createFixture() {
  const database = new FakeSaasDatabase();
  const service = new SaasIdentityService(database as never, { now: () => new Date(NOW) });
  return { database, service };
}

interface Seed {
  tenantId: string;
  projectId: string;
  ownerId: string;
  adminId: string;
  developerId: string;
  viewerId: string;
}

function user(id: string, name: string): Record<string, unknown> {
  const email = `${name.toLowerCase()}@example.com`;
  return {
    id,
    email,
    email_canonical: email,
    password_hash: 'x',
    display_name: name,
    email_verified_at: null,
    disabled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function membership(tenantId: string, userId: string, role: TenantRole): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    user_id: userId,
    role,
    status: 'active',
    revoked_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** One tenant with a five-role membership band and matching project rows. */
function seed(directory: FakeSaasDatabase): Seed {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const ids = {
    tenantId,
    projectId,
    ownerId: randomUUID(),
    adminId: randomUUID(),
    developerId: randomUUID(),
    viewerId: randomUUID(),
  };
  directory.state.users.push(
    user(ids.ownerId, 'Owner'),
    user(ids.adminId, 'Admin'),
    user(ids.developerId, 'Dev'),
    user(ids.viewerId, 'Viewer'),
  );
  directory.state.tenants.push({
    id: tenantId,
    name: 'Acme',
    slug: 'acme',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  });
  directory.state.memberships.push(
    membership(tenantId, ids.ownerId, 'owner'),
    membership(tenantId, ids.adminId, 'admin'),
    membership(tenantId, ids.developerId, 'developer'),
    membership(tenantId, ids.viewerId, 'viewer'),
  );
  directory.state.projects.push({
    tenant_id: tenantId,
    id: projectId,
    name: 'Default',
    slug: 'default',
    slug_canonical: 'default',
    is_default: true,
    created_at: NOW,
    updated_at: NOW,
  });
  for (const userId of [ids.ownerId, ids.adminId, ids.developerId, ids.viewerId]) {
    const role = directory.state.memberships.find((row) => row.user_id === userId)?.role;
    directory.state.projectMemberships.push({
      tenant_id: tenantId,
      project_id: projectId,
      user_id: userId,
      role,
      status: 'active',
      revoked_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
  }
  return ids;
}

function member(directory: FakeSaasDatabase, tenantId: string, userId: string) {
  return directory.state.memberships.find((row) => row.tenant_id === tenantId && row.user_id === userId);
}

function auditActions(directory: FakeSaasDatabase): string[] {
  return directory.queryLog
    .filter((entry) => entry.sql.toLowerCase().includes('insert into saas_audit_events'))
    .map((entry) => String(entry.values[3]));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SaasIdentityError && error.code === code);
}

test('an owner changes a member role with an audit event, and a same-role write is a silent no-op', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  const updated = await service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.developerId, 'billing');
  assert.deepEqual(updated, { userId: ids.developerId, displayName: 'Dev', role: 'billing', status: 'active' });
  assert.equal(member(database, ids.tenantId, ids.developerId)?.role, 'billing');
  assert.deepEqual(auditActions(database), ['tenant_member.role_updated']);

  const before = database.queryLog.length;
  const noop = await service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.developerId, 'billing');
  assert.deepEqual(noop, updated);
  const tail = database.queryLog.slice(before).map((entry) => entry.sql.toLowerCase());
  assert.equal(
    tail.some((sql) => sql.includes('update saas_memberships set role')),
    false,
  );
  assert.equal(
    tail.some((sql) => sql.includes('insert into saas_audit_events')),
    false,
  );
});

test('an owner promotes a member to owner, growing the owner band', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  const promoted = await service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.adminId, 'owner');
  assert.equal(promoted.role, 'owner');
  assert.equal(member(database, ids.tenantId, ids.adminId)?.role, 'owner');

  // With two active owners, demoting one no longer trips the invariant.
  const demoted = await service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.adminId, 'viewer');
  assert.equal(demoted.role, 'viewer');
  assert.equal(member(database, ids.tenantId, ids.ownerId)?.role, 'owner');
});

test('admin role management is limited to the non-privileged band', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  const updated = await service.updateTenantMemberRole(ids.adminId, ids.tenantId, ids.developerId, 'viewer');
  assert.equal(updated.role, 'viewer');

  await expectCode(
    service.updateTenantMemberRole(ids.adminId, ids.tenantId, ids.developerId, 'admin'),
    'INSUFFICIENT_TENANT_ROLE',
  );
  await expectCode(
    service.updateTenantMemberRole(ids.adminId, ids.tenantId, ids.developerId, 'owner'),
    'INSUFFICIENT_TENANT_ROLE',
  );
  await expectCode(
    service.updateTenantMemberRole(ids.adminId, ids.tenantId, ids.ownerId, 'viewer'),
    'INSUFFICIENT_TENANT_ROLE',
  );
  await expectCode(
    service.updateTenantMemberRole(ids.developerId, ids.tenantId, ids.viewerId, 'billing'),
    'INSUFFICIENT_TENANT_ROLE',
  );
  // Nothing changed after the denied writes.
  assert.equal(member(database, ids.tenantId, ids.developerId)?.role, 'viewer');
  assert.equal(member(database, ids.tenantId, ids.ownerId)?.role, 'owner');
});

test('the last active owner can neither be demoted nor removed', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  await expectCode(
    service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.ownerId, 'admin'),
    'LAST_OWNER_REQUIRED',
  );
  await expectCode(service.removeTenantMember(ids.ownerId, ids.tenantId, ids.ownerId), 'LAST_OWNER_REQUIRED');
  assert.equal(member(database, ids.tenantId, ids.ownerId)?.role, 'owner');
  assert.equal(member(database, ids.tenantId, ids.ownerId)?.status, 'active');
});

test('removal revokes tenant and project memberships with audit; a revoked member is gone', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  const removed = await service.removeTenantMember(ids.ownerId, ids.tenantId, ids.developerId);
  assert.deepEqual(removed, {
    userId: ids.developerId,
    displayName: 'Dev',
    role: 'developer',
    status: 'revoked',
  });
  const row = member(database, ids.tenantId, ids.developerId);
  assert.equal(row?.status, 'revoked');
  assert.equal(row?.revoked_at, NOW);
  for (const projectRow of database.state.projectMemberships) {
    if (projectRow.user_id === ids.developerId) {
      assert.equal(projectRow.status, 'revoked');
      assert.equal(projectRow.revoked_at, NOW);
    }
  }
  assert.deepEqual(auditActions(database), ['tenant_member.removed']);

  // The no-delete table keeps the row; the directory treats it as absent.
  await expectCode(service.removeTenantMember(ids.ownerId, ids.tenantId, ids.developerId), 'MEMBER_NOT_FOUND');
  await expectCode(
    service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.developerId, 'viewer'),
    'MEMBER_NOT_FOUND',
  );
  await expectCode(service.removeTenantMember(ids.ownerId, ids.tenantId, randomUUID()), 'MEMBER_NOT_FOUND');
});

test('self-removal is open to every role but never to the last owner', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  const left = await service.removeTenantMember(ids.viewerId, ids.tenantId, ids.viewerId);
  assert.equal(left.status, 'revoked');
  assert.equal(member(database, ids.tenantId, ids.viewerId)?.status, 'revoked');

  await expectCode(service.removeTenantMember(ids.ownerId, ids.tenantId, ids.ownerId), 'LAST_OWNER_REQUIRED');
});

test('an admin can remove only the non-privileged band', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  await expectCode(service.removeTenantMember(ids.adminId, ids.tenantId, ids.ownerId), 'INSUFFICIENT_TENANT_ROLE');
  await expectCode(service.removeTenantMember(ids.developerId, ids.tenantId, ids.viewerId), 'INSUFFICIENT_TENANT_ROLE');
  const removed = await service.removeTenantMember(ids.adminId, ids.tenantId, ids.viewerId);
  assert.equal(removed.status, 'revoked');
});

test('ownership transfer promotes the target and demotes the actor atomically', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  const transferred = await service.transferTenantOwnership(ids.ownerId, ids.tenantId, ids.adminId);
  assert.deepEqual(transferred, { userId: ids.adminId, displayName: 'Admin', role: 'owner', status: 'active' });
  assert.equal(member(database, ids.tenantId, ids.adminId)?.role, 'owner');
  assert.equal(member(database, ids.tenantId, ids.ownerId)?.role, 'admin');
  assert.deepEqual(auditActions(database), ['tenant_ownership.transferred']);

  // Exactly one owner before and after: the invariant holds by construction.
  const owners = database.state.memberships.filter(
    (row) => row.tenant_id === ids.tenantId && row.role === 'owner' && row.status === 'active',
  );
  assert.equal(owners.length, 1);

  // The demoted founder is now an admin and cannot transfer back.
  await expectCode(
    service.transferTenantOwnership(ids.ownerId, ids.tenantId, ids.viewerId),
    'INSUFFICIENT_TENANT_ROLE',
  );
  // …but the new owner can transfer onward.
  const onward = await service.transferTenantOwnership(ids.adminId, ids.tenantId, ids.viewerId);
  assert.equal(onward.role, 'owner');
  assert.equal(member(database, ids.tenantId, ids.adminId)?.role, 'admin');
});

test('ownership transfer rejects self-transfer, non-members and invalid input', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);

  await expectCode(service.transferTenantOwnership(ids.ownerId, ids.tenantId, ids.ownerId), 'INVALID_INPUT');
  await expectCode(service.transferTenantOwnership(ids.ownerId, ids.tenantId, randomUUID()), 'MEMBER_NOT_FOUND');
  await expectCode(service.transferTenantOwnership(ids.ownerId, ids.tenantId, 'not-a-uuid'), 'INVALID_INPUT');
  await expectCode(
    service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.viewerId, 'root' as never),
    'INVALID_INPUT',
  );
});

test('a fence failure rolls the whole mutation back', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);
  database.authorizationFenceHook = () => {
    throw new Error('fence unavailable');
  };

  await assert.rejects(service.updateTenantMemberRole(ids.ownerId, ids.tenantId, ids.developerId, 'billing'));
  assert.equal(member(database, ids.tenantId, ids.developerId)?.role, 'developer');
  assert.deepEqual(auditActions(database), []);
});

test('a suspended actor membership cannot manage members', async () => {
  const { database, service } = createFixture();
  const ids = seed(database);
  const suspended = member(database, ids.tenantId, ids.adminId);
  assert.ok(suspended);
  suspended.status = 'suspended';

  await expectCode(
    service.updateTenantMemberRole(ids.adminId, ids.tenantId, ids.developerId, 'viewer'),
    'TENANT_ACCESS_DENIED',
  );
  await expectCode(service.removeTenantMember(ids.adminId, ids.tenantId, ids.viewerId), 'TENANT_ACCESS_DENIED');
});
