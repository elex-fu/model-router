import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { TenantRole } from '../../../src/saas/identity/types.js';

// Real-PG proof for the E1 member-management mutations: the restricted
// control-plane role executes role change, removal (with the project
// cascade), ownership transfer and the at-least-one-owner invariant against
// actual triggers/CHECKs/advisory fences. Same required gate and target
// contract as the tenant member directory suite. HTTP envelope coverage
// stays in the unit tests; this file never claims browser/HTTP evidence.
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
    assert.ok(value, `${name} is required for the member-management PostgreSQL gate`);
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

async function boundedTransaction<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    return work(tx);
  });
}

interface Seed {
  tenantId: string;
  members: Record<string, string>;
}

/** Fresh synthetic tenant; membership band defaults to owner/admin/developer/viewer. */
async function seedTenant(
  migrator: SaasDatabase,
  roles: readonly TenantRole[] = ['owner', 'admin', 'developer', 'viewer'],
): Promise<Seed> {
  const label = randomUUID();
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const members: Record<string, string> = {};
  await boundedTransaction(migrator, async (tx) => {
    await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $3)', [
      tenantId,
      'Member management fixture',
      `member-mgmt-${label}`,
    ]);
    await tx.query(
      "INSERT INTO saas_projects (tenant_id, id, name, slug, is_default) VALUES ($1, $2, 'Member management default', 'member-mgmt-default', TRUE)",
      [tenantId, projectId],
    );
    for (const [index, role] of roles.entries()) {
      const userId = randomUUID();
      members[role] = userId;
      await tx.query('INSERT INTO saas_users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)', [
        userId,
        `member-mgmt-${label}-${index}@example.test`,
        `Fixture ${role}`,
        'member-management-fixture-not-a-password',
      ]);
      await tx.query('INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
        tenantId,
        userId,
        role,
      ]);
      await tx.query(
        'INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [tenantId, projectId, userId, role],
      );
    }
  });
  return { tenantId, members };
}

async function membershipRow(control: SaasDatabase, tenantId: string, userId: string) {
  const result = await control.query<{ role: string; status: string; revoked_at: string | null }>(
    'SELECT role, status, revoked_at FROM saas_memberships WHERE tenant_id = $1 AND user_id = $2',
    [tenantId, userId],
  );
  assert.equal(result.rows.length, 1, 'the no-delete table keeps exactly one membership row');
  return result.rows[0]!;
}

async function projectMembershipStates(control: SaasDatabase, tenantId: string, userId: string): Promise<string[]> {
  const result = await control.query<{ status: string }>(
    'SELECT status FROM saas_project_memberships WHERE tenant_id = $1 AND user_id = $2',
    [tenantId, userId],
  );
  return result.rows.map((row) => row.status);
}

async function auditActions(control: SaasDatabase, tenantId: string): Promise<string[]> {
  const result = await control.query<{ action: string }>(
    `SELECT action FROM saas_audit_events
     WHERE tenant_id = $1 AND entry_point = 'customer_identity_members' ORDER BY occurred_at, action`,
    [tenantId],
  );
  return result.rows.map((row) => row.action);
}

async function expectCode(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (cause: unknown) => {
    assert.ok(cause instanceof SaasIdentityError, 'safe identity error required, never a raw PG error');
    assert.equal(cause.code, code);
    assert.equal(cause.status, status);
    return true;
  });
}

test('member management: actual PG restricted control-plane role change, removal cascade, transfer and owner invariant', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
      ? `offline skip: set ${REQUIRED_FLAG}=1 and the disposable MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs`
      : false,
  timeout: 120_000,
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
  const service = new SaasIdentityService(control);

  await t.test('owner role change persists with audit, and admin authority stays band-limited', async () => {
    const seed = await seedTenant(migrator);
    const { tenantId, members } = seed;
    const changed = await service.updateTenantMemberRole(members.owner!, tenantId, members.developer!, 'billing');
    assert.deepEqual(changed, {
      userId: members.developer,
      displayName: 'Fixture developer',
      role: 'billing',
      status: 'active',
    });
    assert.deepEqual(await membershipRow(control, tenantId, members.developer!), {
      role: 'billing',
      status: 'active',
      revoked_at: null,
    });
    assert.deepEqual(await auditActions(control, tenantId), ['tenant_member.role_updated']);

    // Real denials through actual CP SQL: admin cannot grant admin, touch the
    // owner band, and a developer cannot manage at all.
    await expectCode(
      service.updateTenantMemberRole(members.admin!, tenantId, members.viewer!, 'admin'),
      'INSUFFICIENT_TENANT_ROLE',
      403,
    );
    await expectCode(
      service.updateTenantMemberRole(members.admin!, tenantId, members.owner!, 'viewer'),
      'INSUFFICIENT_TENANT_ROLE',
      403,
    );
    await expectCode(
      service.updateTenantMemberRole(members.developer!, tenantId, members.viewer!, 'billing'),
      'INSUFFICIENT_TENANT_ROLE',
      403,
    );
    const managed = await service.updateTenantMemberRole(members.admin!, tenantId, members.viewer!, 'developer');
    assert.equal(managed.role, 'developer');
    assert.deepEqual(await membershipRow(control, tenantId, members.owner!), {
      role: 'owner',
      status: 'active',
      revoked_at: null,
    });
  });

  await t.test('removal revokes tenant and project memberships; the last owner cannot leave', async () => {
    const seed = await seedTenant(migrator);
    const { tenantId, members } = seed;

    const removed = await service.removeTenantMember(members.owner!, tenantId, members.developer!);
    assert.equal(removed.status, 'revoked');
    const row = await membershipRow(control, tenantId, members.developer!);
    assert.equal(row.status, 'revoked');
    assert.ok(row.revoked_at !== null, '035-style revocation shape: revoked implies revoked_at');
    assert.deepEqual(await projectMembershipStates(control, tenantId, members.developer!), ['revoked']);
    assert.deepEqual(await auditActions(control, tenantId), ['tenant_member.removed']);
    await expectCode(service.removeTenantMember(members.owner!, tenantId, members.developer!), 'MEMBER_NOT_FOUND', 404);

    // Sole-owner tenant: self-demotion and self-removal trip the invariant;
    // an admin cannot even address the owner band (policy precedes invariant).
    const solo = await seedTenant(migrator, ['owner', 'admin']);
    await expectCode(
      service.updateTenantMemberRole(solo.members.owner!, solo.tenantId, solo.members.owner!, 'admin'),
      'LAST_OWNER_REQUIRED',
      409,
    );
    await expectCode(
      service.removeTenantMember(solo.members.admin!, solo.tenantId, solo.members.owner!),
      'INSUFFICIENT_TENANT_ROLE',
      403,
    );
    await expectCode(
      service.removeTenantMember(solo.members.owner!, solo.tenantId, solo.members.owner!),
      'LAST_OWNER_REQUIRED',
      409,
    );
    assert.deepEqual(await membershipRow(control, solo.tenantId, solo.members.owner!), {
      role: 'owner',
      status: 'active',
      revoked_at: null,
    });
  });

  await t.test('ownership transfer swaps roles atomically and the band keeps exactly one owner', async () => {
    const seed = await seedTenant(migrator);
    const { tenantId, members } = seed;

    const transferred = await service.transferTenantOwnership(members.owner!, tenantId, members.admin!);
    assert.deepEqual(transferred, {
      userId: members.admin,
      displayName: 'Fixture admin',
      role: 'owner',
      status: 'active',
    });
    assert.deepEqual(await membershipRow(control, tenantId, members.admin!), {
      role: 'owner',
      status: 'active',
      revoked_at: null,
    });
    assert.deepEqual(await membershipRow(control, tenantId, members.owner!), {
      role: 'admin',
      status: 'active',
      revoked_at: null,
    });
    assert.deepEqual(await auditActions(control, tenantId), ['tenant_ownership.transferred']);

    // The demoted founder lost transfer authority; the new owner holds it.
    await expectCode(
      service.transferTenantOwnership(members.owner!, tenantId, members.viewer!),
      'INSUFFICIENT_TENANT_ROLE',
      403,
    );
    await expectCode(service.transferTenantOwnership(members.admin!, tenantId, members.admin!), 'INVALID_INPUT', 400);
    const onward = await service.transferTenantOwnership(members.admin!, tenantId, members.viewer!);
    assert.equal(onward.role, 'owner');
    assert.deepEqual(await membershipRow(control, tenantId, members.admin!), {
      role: 'admin',
      status: 'active',
      revoked_at: null,
    });
  });
});
