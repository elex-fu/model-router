import type { SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';

/**
 * In-memory relational fake for the platform governance services. Routes SQL
 * by shape the way the real statements are written; every branch asserts the
 * statement structure so a drifted query fails the test instead of silently
 * returning wrong data.
 */

export interface FakeUser {
  id: string;
  email_canonical: string;
  display_name: string | null;
  password_hash: string | null;
  email_verified_at: string | null;
  disabled_at: string | null;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FakeTenant {
  id: string;
  name: string;
  slug_canonical: string;
  status: 'active' | 'suspended' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface FakeMembership {
  tenant_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'billing' | 'developer' | 'viewer';
  status: 'active' | 'revoked';
  revoked_at: string | null;
}

export interface FakeRoleAssignment {
  user_id: string;
  role: string;
}

export interface FakePlatformSession {
  id: string;
  user_id: string;
  credential_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface FakeCustomerSession {
  id: string;
  user_id: string;
  revoked_at: string | null;
}

export interface FakeMfaCredential {
  id: string;
  user_id: string;
  kind: 'totp' | 'passkey';
  verified_at: string | null;
  revoked_at: string | null;
}

export interface FakeAuditEvent {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  occurred_at: string;
  entry_point: string;
}

export interface GovernanceFixture {
  users: FakeUser[];
  tenants: FakeTenant[];
  memberships: FakeMembership[];
  roleAssignments: FakeRoleAssignment[];
  platformSessions: FakePlatformSession[];
  customerSessions: FakeCustomerSession[];
  mfaCredentials: FakeMfaCredential[];
  auditEvents: FakeAuditEvent[];
}

export function emptyFixture(): GovernanceFixture {
  return {
    users: [],
    tenants: [],
    memberships: [],
    roleAssignments: [],
    platformSessions: [],
    customerSessions: [],
    mfaCredentials: [],
    auditEvents: [],
  };
}

function rows<T>(value: T[]): SqlResult<T> {
  return { rows: value, rowCount: value.length };
}

function likeMatch(canonical: string, pattern: string): boolean {
  // The services escape %/_/\ before embedding; simulate substring matching.
  const needle = pattern.slice(1, -1).replace(/\\([%_\\])/g, '$1');
  return canonical.includes(needle);
}

export class FakeGovernanceDatabase {
  readonly queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  private readonly executor: SqlExecutor;

  constructor(readonly fixture: GovernanceFixture) {
    this.executor = { query: async (sql, values = []) => this.route(sql, values) };
  }

  query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    return this.executor.query(sql, values);
  }

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.executor);
  }

  private route(sql: string, values: readonly unknown[]): Promise<SqlResult<never>> {
    this.queries.push({ sql, values });
    const f = this.fixture;

    if (sql.startsWith('SET TRANSACTION')) return Promise.resolve(rows([]));
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve(rows([{}]));

    // verifyGovernanceActor: platform session + credential join.
    if (sql.includes('FROM saas_platform_sessions AS s') && sql.includes('WHERE s.id = $1 AND s.user_id = $2')) {
      const [sessionId, userId] = values as [string, string];
      const session = f.platformSessions.filter(
        (s) =>
          s.id === sessionId &&
          s.user_id === userId &&
          s.revoked_at === null &&
          s.expires_at > '2026-01-01' &&
          f.users.some((u) => u.id === s.user_id && u.disabled_at === null) &&
          f.mfaCredentials.some(
            (c) =>
              c.id === s.credential_id &&
              c.user_id === s.user_id &&
              c.kind === 'totp' &&
              c.verified_at !== null &&
              c.revoked_at === null,
          ),
      );
      return Promise.resolve(rows(session.map((s) => ({ id: s.id, user_id: s.user_id }))));
    }

    // verifyGovernanceActor: current role assignments.
    if (sql.includes('FROM saas_platform_role_assignments') && sql.includes('ORDER BY role ASC')) {
      const userId = values[0] as string;
      return Promise.resolve(
        rows(f.roleAssignments.filter((r) => r.user_id === userId).map((r) => ({ role: r.role }))),
      );
    }

    // Platform user directory list.
    if (sql.includes('FROM saas_users') && sql.includes('ORDER BY created_at DESC, id DESC')) {
      const limit = Number(values.at(-1));
      const hasCursor = sql.includes('(created_at, id) <');
      let selected = f.users.filter((u) => u.anonymized_at === null);
      const conditions = sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));
      let valueIndex = 0;
      if (conditions.includes('email_canonical LIKE')) {
        const pattern = String(values[valueIndex++]);
        selected = selected.filter((u) => likeMatch(u.email_canonical, pattern));
      }
      if (conditions.includes('disabled_at IS NULL') && !conditions.includes('disabled_at IS NOT NULL')) {
        selected = selected.filter((u) => u.disabled_at === null);
      } else if (conditions.includes('disabled_at IS NOT NULL')) {
        selected = selected.filter((u) => u.disabled_at !== null);
      }
      if (hasCursor) {
        const cursorCreatedAt = String(values[valueIndex++]);
        const cursorId = String(values[valueIndex++]);
        selected = selected.filter(
          (u) => u.created_at < cursorCreatedAt || (u.created_at === cursorCreatedAt && u.id < cursorId),
        );
      }
      selected = [...selected].sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      );
      return Promise.resolve(
        rows(
          selected.slice(0, limit).map((u) => ({
            id: u.id,
            email: u.email_canonical,
            display_name: u.display_name,
            email_verified_at: u.email_verified_at,
            disabled_at: u.disabled_at,
            created_at: u.created_at,
          })),
        ),
      );
    }

    // lockTargetUser / lockEnabledUser.
    if (sql.includes('FROM saas_users') && sql.includes('FOR UPDATE') && sql.includes('SELECT disabled_at')) {
      const user = f.users.find((u) => u.id === values[0] && u.anonymized_at === null);
      return Promise.resolve(rows(user ? [{ disabled_at: user.disabled_at }] : []));
    }
    if (sql.includes('FROM saas_users') && sql.includes('FOR UPDATE') && sql.includes('disabled_at IS NULL')) {
      const user = f.users.find((u) => u.id === values[0] && u.disabled_at === null && u.anonymized_at === null);
      return Promise.resolve(rows(user ? [{ id: user.id }] : []));
    }

    // Operator user lookup in grantOperatorRole.
    if (sql.includes('FROM saas_users') && sql.includes('FOR UPDATE')) {
      const user = f.users.find((u) => u.id === values[0]);
      return Promise.resolve(rows(user ? [{ id: user.id }] : []));
    }

    // Target platform role presence checks.
    if (
      sql.startsWith('SELECT') &&
      sql.includes('FROM saas_platform_role_assignments WHERE user_id = $1 AND role = $2')
    ) {
      const [userId, role] = values as [string, string];
      return Promise.resolve(
        rows(f.roleAssignments.filter((r) => r.user_id === userId && r.role === role).map((r) => ({ role: r.role }))),
      );
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM saas_platform_role_assignments WHERE user_id = $1 LIMIT 1')) {
      const userId = values[0] as string;
      return Promise.resolve(
        rows(f.roleAssignments.filter((r) => r.user_id === userId).map((r) => ({ role: r.role }))),
      );
    }

    // Superadmin count for the last-superadmin invariant.
    if (sql.includes("role = 'superadmin' AND user_id <> $1")) {
      const userId = values[0] as string;
      const count = f.roleAssignments.filter((r) => r.role === 'superadmin' && r.user_id !== userId).length;
      return Promise.resolve(rows([{ count: String(count) }]));
    }

    // Operator directory join.
    if (sql.includes('FROM saas_platform_role_assignments r') && sql.includes('JOIN saas_users u')) {
      const joined = f.roleAssignments
        .map((r) => {
          const user = f.users.find((u) => u.id === r.user_id);
          return user && user.anonymized_at === null
            ? {
                user_id: user.id,
                email: user.email_canonical,
                display_name: user.display_name,
                disabled_at: user.disabled_at,
                role: r.role,
              }
            : null;
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort(
          (left, right) => left.email.localeCompare(right.email) || String(left.role).localeCompare(String(right.role)),
        );
      return Promise.resolve(rows(joined));
    }

    // Tenant list.
    if (sql.includes('FROM saas_tenants') && sql.includes('ORDER BY created_at DESC, id DESC')) {
      const limit = Number(values.at(-1));
      const hasCursor = sql.includes('(created_at, id) <');
      let selected = [...f.tenants];
      const conditions = sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));
      let valueIndex = 0;
      if (conditions.includes('status = $')) {
        const status = String(values[valueIndex++]);
        selected = selected.filter((t) => t.status === status);
      }
      if (conditions.includes('slug_canonical LIKE')) {
        const pattern = String(values[valueIndex++]);
        selected = selected.filter((t) => likeMatch(t.slug_canonical, pattern));
      }
      if (hasCursor) {
        const cursorCreatedAt = String(values[valueIndex++]);
        const cursorId = String(values[valueIndex++]);
        selected = selected.filter(
          (t) => t.created_at < cursorCreatedAt || (t.created_at === cursorCreatedAt && t.id < cursorId),
        );
      }
      selected = selected.sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      );
      return Promise.resolve(
        rows(
          selected.slice(0, limit).map((t) => ({
            id: t.id,
            name: t.name,
            slug: t.slug_canonical,
            status: t.status,
            created_at: t.created_at,
            updated_at: t.updated_at,
          })),
        ),
      );
    }

    // lockTenant.
    if (sql.includes('SELECT status FROM saas_tenants') && sql.includes('FOR UPDATE')) {
      const tenant = f.tenants.find((t) => t.id === values[0]);
      return Promise.resolve(rows(tenant ? [{ status: tenant.status }] : []));
    }

    // Tenant re-read after lifecycle update.
    if (sql.includes('FROM saas_tenants WHERE id = $1') && sql.includes('slug_canonical AS slug')) {
      const tenant = f.tenants.find((t) => t.id === values[0]);
      return Promise.resolve(
        rows(
          tenant
            ? [
                {
                  id: tenant.id,
                  name: tenant.name,
                  slug: tenant.slug_canonical,
                  status: tenant.status,
                  created_at: tenant.created_at,
                  updated_at: tenant.updated_at,
                },
              ]
            : [],
        ),
      );
    }

    // Tenant status update with optimistic current-status guard.
    if (sql.includes('UPDATE saas_tenants SET status')) {
      const [id, nextStatus, now, expected] = values as [string, FakeTenant['status'], string, string];
      const tenant = f.tenants.find((t) => t.id === id);
      if (!tenant || tenant.status !== expected) return Promise.resolve({ rows: [], rowCount: 0 });
      tenant.status = nextStatus;
      tenant.updated_at = now;
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // Takeover target membership lookup.
    if (sql.includes('FROM saas_memberships m') && sql.includes('FOR UPDATE OF m')) {
      const [tenantId, userId] = values as [string, string];
      const membership = f.memberships.find(
        (m) =>
          m.tenant_id === tenantId &&
          m.user_id === userId &&
          m.status === 'active' &&
          f.users.some((u) => u.id === userId && u.disabled_at === null && u.anonymized_at === null),
      );
      return Promise.resolve(rows(membership ? [{ role: membership.role }] : []));
    }

    // Membership role updates (promote/demote).
    if (sql.includes("UPDATE saas_memberships SET role = 'owner'")) {
      const [tenantId, userId, now] = values as [string, string, string];
      const membership = f.memberships.find(
        (m) => m.tenant_id === tenantId && m.user_id === userId && m.status === 'active',
      );
      if (!membership) return Promise.resolve({ rows: [], rowCount: 0 });
      membership.role = 'owner';
      void now;
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes("UPDATE saas_memberships SET role = 'admin'")) {
      const [tenantId, exceptUserId] = values as [string, string];
      let changed = 0;
      for (const membership of f.memberships) {
        if (
          membership.tenant_id === tenantId &&
          membership.user_id !== exceptUserId &&
          membership.role === 'owner' &&
          membership.status === 'active'
        ) {
          membership.role = 'admin';
          changed += 1;
        }
      }
      return Promise.resolve({ rows: [], rowCount: changed });
    }

    // User mutations.
    if (sql.includes('UPDATE saas_users SET disabled_at')) {
      const [id, disabledAt] = values as [string, string | null];
      const user = f.users.find((u) => u.id === id);
      if (!user) return Promise.resolve({ rows: [], rowCount: 0 });
      user.disabled_at = disabledAt;
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes('UPDATE saas_users SET password_hash')) {
      const [id, passwordHash, now] = values as [string, string, string];
      const user = f.users.find((u) => u.id === id);
      if (!user) return Promise.resolve({ rows: [], rowCount: 0 });
      user.password_hash = passwordHash;
      user.updated_at = now;
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // MFA credential revocation.
    if (sql.includes('UPDATE saas_mfa_credentials SET revoked_at')) {
      const [userId, now] = values as [string, string];
      let changed = 0;
      for (const credential of f.mfaCredentials) {
        if (credential.user_id === userId && credential.revoked_at === null) {
          credential.revoked_at = now;
          changed += 1;
        }
      }
      return Promise.resolve({ rows: [], rowCount: changed });
    }

    // Session revocation.
    if (sql.includes('UPDATE saas_sessions SET revoked_at')) {
      const [userId, now] = values as [string, string];
      let changed = 0;
      for (const session of f.customerSessions) {
        if (session.user_id === userId && session.revoked_at === null) {
          session.revoked_at = now;
          changed += 1;
        }
      }
      return Promise.resolve({ rows: [], rowCount: changed });
    }
    if (sql.includes('UPDATE saas_platform_sessions SET revoked_at')) {
      const [userId, now] = values as [string, string];
      let changed = 0;
      for (const session of f.platformSessions) {
        if (session.user_id === userId && session.revoked_at === null) {
          session.revoked_at = now;
          changed += 1;
        }
      }
      return Promise.resolve({ rows: [], rowCount: changed });
    }

    // Role assignment mutations.
    if (sql.includes('INSERT INTO saas_platform_role_assignments')) {
      const [userId, role, grantedAt, grantedBy] = values as [string, string, string, string];
      void grantedAt;
      void grantedBy;
      const onConflict = sql.includes('ON CONFLICT');
      if (f.roleAssignments.some((r) => r.user_id === userId && r.role === role)) {
        return Promise.resolve({ rows: [], rowCount: onConflict ? 0 : 1 });
      }
      f.roleAssignments.push({ user_id: userId, role });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes('DELETE FROM saas_platform_role_assignments')) {
      const [userId, role] = values as [string, string];
      const index = f.roleAssignments.findIndex((r) => r.user_id === userId && r.role === role);
      if (index < 0) return Promise.resolve({ rows: [], rowCount: 0 });
      f.roleAssignments.splice(index, 1);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // Operator creation.
    if (sql.includes('INSERT INTO saas_users')) {
      const [id, email, passwordHash, displayName, now] = values as [string, string, string, string | null, string];
      if (f.users.some((u) => u.email_canonical === email.toLowerCase())) {
        return Promise.resolve(rows([]));
      }
      f.users.push({
        id,
        email_canonical: email.toLowerCase(),
        display_name: displayName,
        password_hash: passwordHash,
        email_verified_at: null,
        disabled_at: null,
        anonymized_at: null,
        created_at: now,
        updated_at: now,
      });
      return Promise.resolve(rows([{ id }]));
    }

    // Audit append.
    if (sql.includes('INSERT INTO saas_audit_events')) {
      const [id, tenantId, actorUserId, action, targetType, targetId, occurredAt] = values as [
        string,
        string | null,
        string | null,
        string,
        string,
        string | null,
        string,
      ];
      f.auditEvents.push({
        id,
        tenant_id: tenantId,
        actor_user_id: actorUserId,
        action,
        target_type: targetType,
        target_id: targetId,
        occurred_at: occurredAt,
        entry_point: 'platform_governance',
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    throw new Error(`unrouted SQL: ${sql.slice(0, 120)}`);
  }
}
