type QueryResult<Row> = { rows: Row[]; rowCount: number | null };
type Query = <Row>(sql: string, values?: readonly unknown[]) => Promise<QueryResult<Row>>;

interface QueryTrace {
  sql: string;
  values: readonly unknown[];
  transactionId: number | null;
}

interface FakeState {
  platformState: { initialized: boolean; initialized_at: string | null };
  users: Array<Record<string, unknown>>;
  tenants: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  projectMemberships: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  platformRoleAssignments: Array<Record<string, unknown>>;
  bootstrapTokens: Array<Record<string, unknown>>;
  invitations: Array<Record<string, unknown>>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[] = []): QueryResult<Row> {
  return { rows: copy(rows), rowCount: rows.length };
}

function uniqueError(): Error & { code: string } {
  return Object.assign(new Error('duplicate key'), { code: '23505' });
}

export class FakeSaasDatabase {
  readonly queryLog: QueryTrace[] = [];
  authorizationFenceHook: ((sql: string, values: readonly unknown[]) => void) | undefined;
  state: FakeState = {
    platformState: { initialized: false, initialized_at: null },
    users: [],
    tenants: [],
    memberships: [],
    projects: [],
    projectMemberships: [],
    sessions: [],
    platformRoleAssignments: [],
    bootstrapTokens: [],
    invitations: [],
  };
  failNextProjectInsert = false;
  failNextProjectMembershipInsert = false;

  private transactionTail: Promise<void> = Promise.resolve();
  private nextTransactionId = 0;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queryLog.push({ sql, values: [...values], transactionId: null });
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: { query: Query }) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = copy(this.state);
    const transactionId = ++this.nextTransactionId;
    const query: Query = (sql, values = []) => {
      this.queryLog.push({ sql, values: [...values], transactionId });
      return this.execute(sql, values);
    };
    try {
      return await work({ query });
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<QueryResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h] = values;

    if (statement.startsWith('select pg_advisory_xact_lock')) {
      this.authorizationFenceHook?.(sql, values);
      return result<Row>();
    }
    if (statement.startsWith('select set_config(')) return result<Row>();

    if (statement.startsWith('select initialized, initialized_at from saas_platform_state')) {
      return result<Row>([{ ...this.state.platformState } as Row]);
    }
    if (statement.startsWith('update saas_platform_state')) {
      if (this.state.platformState.initialized) return result<Row>();
      this.state.platformState = {
        initialized: true,
        initialized_at: new Date().toISOString(),
      };
      return result<Row>([{ ...this.state.platformState } as Row]);
    }

    if (statement.startsWith('select r.user_id from saas_platform_role_assignments')) {
      const active = this.state.platformRoleAssignments.filter((assignment) => {
        if (assignment.role !== 'superadmin') return false;
        return this.state.users.some((user) => user.id === assignment.user_id && user.disabled_at === null);
      });
      return result<Row>(active as Row[]);
    }
    if (statement.startsWith('select token_hash from saas_bootstrap_tokens')) {
      const now = new Date(String(a)).getTime();
      return result<Row>(
        this.state.bootstrapTokens.filter(
          (row) => row.consumed_at === null && new Date(String(row.expires_at)).getTime() > now,
        ) as Row[],
      );
    }
    if (statement.startsWith('insert into saas_bootstrap_tokens')) {
      this.state.bootstrapTokens.push({
        token_hash: a,
        expires_at: b,
        consumed_at: null,
        created_by_user_id: c,
        created_at: d,
      });
      return result<Row>();
    }
    if (statement.startsWith('update saas_bootstrap_tokens')) {
      const token = this.state.bootstrapTokens.find(
        (row) =>
          row.token_hash === a &&
          row.consumed_at === null &&
          new Date(String(row.expires_at)).getTime() > new Date(String(b)).getTime(),
      );
      if (!token) return result<Row>();
      token.consumed_at = b;
      return result<Row>([{ token_hash: token.token_hash } as Row]);
    }

    if (statement.startsWith('select id, email_canonical as email, display_name, password_hash')) {
      const user = this.state.users.find((row) => row.email_canonical === a);
      return result<Row>(user ? [user as Row] : []);
    }
    if (statement.startsWith('select id from saas_users where email_canonical')) {
      const user = this.state.users.find((row) => row.email_canonical === a);
      return result<Row>(user ? [{ id: user.id } as Row] : []);
    }
    if (statement.startsWith('select id from saas_users where id')) {
      const user = this.state.users.find(
        (row) =>
          row.id === a &&
          row.disabled_at === null &&
          (!statement.includes('email_canonical = $2') || row.email_canonical === b) &&
          (!statement.includes('password_hash = $3') || row.password_hash === c),
      );
      return result<Row>(user ? [{ id: user.id } as Row] : []);
    }
    if (statement.startsWith('insert into saas_users')) {
      const canonical = String(b).trim().toLowerCase();
      if (this.state.users.some((row) => row.email_canonical === canonical)) throw uniqueError();
      const user = {
        id: a,
        email: b,
        email_canonical: canonical,
        password_hash: c,
        display_name: d,
        email_verified_at: null,
        disabled_at: null,
        created_at: e,
        updated_at: e,
      };
      this.state.users.push(user);
      return result<Row>([user as Row]);
    }
    if (statement.startsWith('insert into saas_platform_role_assignments')) {
      this.state.platformRoleAssignments.push({
        user_id: a,
        role: 'superadmin',
        granted_at: b,
        granted_by_user_id: null,
      });
      return result<Row>();
    }

    if (statement.startsWith('insert into saas_sessions')) {
      this.state.sessions.push({
        id: a,
        user_id: b,
        token_hash: c,
        csrf_token_hash: d,
        created_at: e,
        expires_at: f,
        revoked_at: null,
      });
      return result<Row>();
    }
    if (statement.startsWith('select s.user_id, s.expires_at, s.created_at from saas_sessions')) {
      const session = this.validSession(String(a), String(b));
      return result<Row>(
        session
          ? [
              {
                user_id: session.user_id,
                expires_at: session.expires_at,
                created_at: session.created_at,
              } as Row,
            ]
          : [],
      );
    }
    if (statement.startsWith('select s.csrf_token_hash from saas_sessions')) {
      const session = this.validSession(String(a), String(b));
      return result<Row>(session ? [{ csrf_token_hash: session.csrf_token_hash } as Row] : []);
    }
    if (statement.startsWith('update saas_sessions set revoked_at')) {
      const session = this.state.sessions.find((row) => row.token_hash === a);
      if (session && session.revoked_at === null) session.revoked_at = b;
      return result<Row>();
    }

    if (statement.startsWith('insert into saas_tenants')) {
      if (this.state.tenants.some((row) => row.slug === c)) throw uniqueError();
      const tenant = { id: a, name: b, slug: c, status: 'active', created_at: d, updated_at: d };
      this.state.tenants.push(tenant);
      return result<Row>([tenant as Row]);
    }
    if (statement.startsWith('insert into saas_memberships')) {
      const ownerInsert = statement.includes("values ($1, $2, 'owner', $3, $3)");
      const role = ownerInsert ? 'owner' : c;
      const createdAt = ownerInsert ? c : d;
      const updatedAt = ownerInsert ? c : e;
      const membership = {
        tenant_id: a,
        user_id: b,
        role,
        status: 'active',
        revoked_at: null,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      if (this.state.memberships.some((row) => row.tenant_id === a && row.user_id === b)) throw uniqueError();
      this.state.memberships.push(membership);
      return result<Row>();
    }
    if (statement.startsWith('select name, slug_canonical from saas_projects')) {
      const projects = this.state.projects
        .filter((row) => row.tenant_id === a)
        .map((row) => ({ name: row.name, slug_canonical: row.slug_canonical }));
      return result<Row>(projects as Row[]);
    }
    if (statement.startsWith('select id from saas_projects where tenant_id = $1 and is_default = true')) {
      const project = this.state.projects.find((row) => row.tenant_id === a && row.is_default === true);
      return result<Row>(project ? [{ id: project.id } as Row] : []);
    }
    if (statement.startsWith('insert into saas_projects')) {
      if (this.failNextProjectInsert) {
        this.failNextProjectInsert = false;
        throw new Error('injected project insert failure');
      }
      const canonical = String(d).trim().toLowerCase();
      if (this.state.projects.some((row) => row.tenant_id === a && row.slug_canonical === canonical)) {
        throw uniqueError();
      }
      const hasExplicitDefault = statement.includes('is_default');
      const project = {
        tenant_id: a,
        id: b,
        name: c,
        slug: d,
        slug_canonical: canonical,
        is_default: hasExplicitDefault
          ? statement.includes('true')
          : !this.state.projects.some((project) => project.tenant_id === a && project.is_default === true),
        created_at: e,
        updated_at: hasExplicitDefault ? e : f,
      };
      this.state.projects.push(project);
      return statement.includes('returning') ? result<Row>([project as Row]) : result<Row>();
    }
    if (statement.startsWith('insert into saas_project_memberships')) {
      if (this.failNextProjectMembershipInsert) {
        this.failNextProjectMembershipInsert = false;
        throw new Error('injected project membership insert failure');
      }
      const ownerInsert = statement.includes("values ($1, $2, $3, 'owner', $4, $4)");
      const membership = {
        tenant_id: a,
        project_id: b,
        user_id: c,
        role: ownerInsert ? 'owner' : d,
        status: 'active',
        revoked_at: null,
        created_at: ownerInsert ? d : e,
        updated_at: ownerInsert ? d : e,
      };
      if (
        this.state.projectMemberships.some(
          (row) =>
            row.tenant_id === membership.tenant_id &&
            row.project_id === membership.project_id &&
            row.user_id === membership.user_id,
        )
      )
        throw uniqueError();
      this.state.projectMemberships.push(membership);
      return result<Row>();
    }
    if (statement.startsWith('select p.id, p.tenant_id, p.name, p.slug, pm.role')) {
      const tenantId = String(a);
      const userId = String(b);
      const tenant = this.state.tenants.find((row) => row.id === tenantId && row.status === 'active');
      const user = this.state.users.find((row) => row.id === userId && row.disabled_at === null);
      const tenantMembership = this.state.memberships.find(
        (row) =>
          row.tenant_id === tenantId && row.user_id === userId && (row.status === undefined || row.status === 'active'),
      );
      const projects =
        tenant && user && tenantMembership
          ? this.state.projects
              .filter((project) => project.tenant_id === tenantId)
              .flatMap((project) => {
                const membership = this.state.projectMemberships.find(
                  (row) =>
                    row.tenant_id === tenantId &&
                    row.project_id === project.id &&
                    row.user_id === userId &&
                    row.status === 'active',
                );
                return membership
                  ? [
                      {
                        id: project.id,
                        tenant_id: project.tenant_id,
                        name: project.name,
                        slug: project.slug,
                        role: membership.role,
                        created_at: project.created_at,
                        updated_at: project.updated_at,
                      },
                    ]
                  : [];
              })
          : [];
      projects.sort((left, right) => {
        const byName = String(left.name).localeCompare(String(right.name));
        return byName !== 0 ? byName : String(left.id).localeCompare(String(right.id));
      });
      return result<Row>(projects as Row[]);
    }
    if (statement.startsWith('select t.id, t.name, t.slug, t.status, m.role')) {
      const tenants = this.state.memberships
        .filter(
          (membership) =>
            membership.user_id === a && (membership.status === undefined || membership.status === 'active'),
        )
        .flatMap((membership) => {
          const tenant = this.state.tenants.find((row) => row.id === membership.tenant_id && row.status === 'active');
          const user = this.state.users.find((row) => row.id === membership.user_id && row.disabled_at === null);
          const defaultProject = this.state.projects.find(
            (row) => row.tenant_id === membership.tenant_id && row.is_default === true,
          );
          const projectMembership = this.state.projectMemberships.find(
            (row) =>
              row.tenant_id === membership.tenant_id &&
              row.project_id === defaultProject?.id &&
              row.user_id === membership.user_id &&
              row.status === 'active',
          );
          return tenant && user && defaultProject && projectMembership
            ? [{ ...tenant, role: membership.role, default_project_id: defaultProject.id }]
            : [];
        })
        .sort((left, right) =>
          String((left as Record<string, unknown>).name).localeCompare(String((right as Record<string, unknown>).name)),
        );
      return result<Row>(tenants as Row[]);
    }
    if (
      statement.startsWith(
        'select t.id as tenant_id, m.role as tenant_role, pm.role as project_role, default_project.id as project_id',
      )
    ) {
      const tenantId = String(a);
      const userId = String(b);
      const tenant = this.state.tenants.find((row) => row.id === tenantId && row.status === 'active');
      const user = this.state.users.find((row) => row.id === userId && row.disabled_at === null);
      const tenantMembership = this.state.memberships.find(
        (row) =>
          row.tenant_id === tenantId && row.user_id === userId && (row.status === undefined || row.status === 'active'),
      );
      const project = this.state.projects.find((row) => row.tenant_id === tenantId && row.is_default === true);
      const projectMembership = this.state.projectMemberships.find(
        (row) =>
          row.tenant_id === tenantId &&
          row.project_id === project?.id &&
          row.user_id === userId &&
          row.status === 'active',
      );
      const rows =
        tenant && user && tenantMembership && project && projectMembership
          ? [
              {
                tenant_id: tenantId,
                tenant_role: tenantMembership.role,
                project_role: projectMembership.role,
                project_id: project.id,
              },
            ]
          : [];
      return result<Row>(rows as Row[]);
    }
    if (
      statement.startsWith(
        'select t.id as tenant_id, m.role as tenant_role, pm.role as project_role, p.id as project_id',
      )
    ) {
      const tenantId = String(a);
      const userId = String(b);
      const projectId = String(c);
      const tenant = this.state.tenants.find((row) => row.id === tenantId && row.status === 'active');
      const user = this.state.users.find((row) => row.id === userId && row.disabled_at === null);
      const tenantMembership = this.state.memberships.find(
        (row) =>
          row.tenant_id === tenantId && row.user_id === userId && (row.status === undefined || row.status === 'active'),
      );
      const project = this.state.projects.find((row) => row.tenant_id === tenantId && row.id === projectId);
      const projectMembership = this.state.projectMemberships.find(
        (row) =>
          row.tenant_id === tenantId &&
          row.project_id === projectId &&
          row.user_id === userId &&
          row.status === 'active',
      );
      const rows =
        tenant && user && tenantMembership && project && projectMembership
          ? [
              {
                tenant_id: tenantId,
                tenant_role: tenantMembership.role,
                project_role: projectMembership.role,
                project_id: project.id,
              },
            ]
          : [];
      return result<Row>(rows as Row[]);
    }
    if (statement.startsWith('select m.role from saas_memberships')) {
      const membership = this.state.memberships.find(
        (row) => row.tenant_id === a && row.user_id === b && (row.status === undefined || row.status === 'active'),
      );
      const tenant = this.state.tenants.find((row) => row.id === a && row.status === 'active');
      const user = this.state.users.find((row) => row.id === b && row.disabled_at === null);
      return result<Row>(membership && tenant && user ? [{ role: membership.role } as Row] : []);
    }
    if (statement.startsWith('select m.tenant_id from saas_memberships')) {
      const membership = this.state.memberships.find(
        (row) => row.user_id === a && row.tenant_id === b && (row.status === undefined || row.status === 'active'),
      );
      const tenant = this.state.tenants.find((row) => row.id === b && row.status === 'active');
      return result<Row>(membership && tenant ? [{ tenant_id: b } as Row] : []);
    }
    if (statement.startsWith('select m.user_id from saas_memberships')) {
      const user = this.state.users.find((row) => row.email_canonical === b);
      const membership = this.state.memberships.find((row) => row.tenant_id === a && row.user_id === user?.id);
      return result<Row>(membership ? [{ user_id: membership.user_id } as Row] : []);
    }
    if (statement.startsWith('select tenant_id, user_id from saas_memberships')) {
      const membership = this.state.memberships.find((row) => row.tenant_id === a && row.user_id === b);
      return result<Row>(membership ? [{ tenant_id: membership.tenant_id, user_id: membership.user_id } as Row] : []);
    }

    if (statement.startsWith('select id from saas_invitations')) {
      const now = new Date(String(c)).getTime();
      const invitation = this.state.invitations.find(
        (row) =>
          row.tenant_id === a &&
          row.invited_email_canonical === b &&
          row.accepted_at === null &&
          row.revoked_at === null &&
          new Date(String(row.expires_at)).getTime() > now,
      );
      return result<Row>(invitation ? [{ id: invitation.id } as Row] : []);
    }
    if (statement.startsWith('insert into saas_invitations')) {
      this.state.invitations.push({
        tenant_id: a,
        id: b,
        invited_email: c,
        invited_email_canonical: String(c).trim().toLowerCase(),
        role: d,
        token_hash: e,
        created_by_user_id: f,
        accepted_by_user_id: null,
        created_at: g,
        expires_at: h,
        accepted_at: null,
        revoked_at: null,
      });
      return result<Row>();
    }
    if (statement.startsWith('select id, tenant_id, invited_email_canonical as email, role')) {
      const invitation = this.state.invitations.find((row) => row.token_hash === a);
      return result<Row>(
        invitation
          ? [
              {
                id: invitation.id,
                tenant_id: invitation.tenant_id,
                email: invitation.invited_email_canonical,
                role: invitation.role,
                expires_at: invitation.expires_at,
                accepted_at: invitation.accepted_at,
                revoked_at: invitation.revoked_at,
              } as Row,
            ]
          : [],
      );
    }
    if (statement.startsWith('update saas_invitations')) {
      const invitation = this.state.invitations.find(
        (row) =>
          row.tenant_id === a &&
          row.id === b &&
          row.accepted_at === null &&
          row.revoked_at === null &&
          new Date(String(row.expires_at)).getTime() > new Date(String(c)).getTime(),
      );
      if (!invitation) return result<Row>();
      if (!this.state.memberships.some((row) => row.tenant_id === a && row.user_id === d)) {
        throw new Error('accepted user must be a tenant member');
      }
      invitation.accepted_at = c;
      invitation.accepted_by_user_id = d;
      return result<Row>([{ id: invitation.id } as Row]);
    }
    if (statement.startsWith('select id from saas_tenants where id')) {
      const tenant = this.state.tenants.find((row) => row.id === a && row.status === 'active');
      return result<Row>(tenant ? [{ id: tenant.id } as Row] : []);
    }

    throw new Error(`Unimplemented fake SQL: ${statement}`);
  }

  private validSession(tokenHash: string, now: string): Record<string, unknown> | undefined {
    const session = this.state.sessions.find(
      (row) =>
        row.token_hash === tokenHash &&
        row.revoked_at === null &&
        new Date(String(row.expires_at)).getTime() > new Date(now).getTime(),
    );
    if (!session) return undefined;
    const user = this.state.users.find((row) => row.id === session.user_id && row.disabled_at === null);
    return user ? session : undefined;
  }
}
