import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { SafeTenantMember, TenantMemberPage, TenantRole } from '../../../src/saas/identity/types.js';

// SQL/ACL proof only. Existing HTTP unit tests cover the session/GET envelope;
// this file does not claim real HTTP/browser coverage. The PG15/18 owner must
// provision the independent disposable target through 059 before execution.
// Never migrate, grant, SET ROLE/search_path, reset bootstrap, bypass triggers,
// seed provider/MFA/session/key rows, or delete fixture/evidence here.
const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configuredUrls = roleConfig.map(([name]) => process.env[name]?.trim());
const anyConfigured = configuredUrls.some(Boolean);

type Phase = 'target-guard' | 'principal-preflight' | 'schema-preflight' | 'acl-preflight' | 'fixture-seed'
  | 'directory-sql-contract' | 'directory-principal' | 'directory-select' | 'directory-lock-proof'
  | 'page-assertions' | 'fixture-state-change' | 'postflight' | 'pool-cleanup';
interface Diagnostic { phase: Phase; sqlState?: string }

function enter(diagnostic: Diagnostic, phase: Phase): void {
  diagnostic.phase = phase; diagnostic.sqlState = undefined;
}

function sqlState(cause: unknown): string | undefined {
  const visited = new Set<object>();
  while (cause && typeof cause === 'object' && !visited.has(cause)) {
    visited.add(cause);
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)) return cause.code;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return undefined;
}

function safeFailure(cause: unknown, diagnostic: Diagnostic): Error {
  // A service storage error deliberately strips its raw cause. The real query
  // delegate captures only the actual SQLSTATE first; never invent one when
  // unavailable, and never attach raw errors/SQL/parameters/assertion operands.
  const state = diagnostic.sqlState ?? sqlState(cause);
  const failure = new Error(`Tenant directory PostgreSQL proof failed (phase=${diagnostic.phase}; SQLSTATE=${state ?? 'not-captured'}); details redacted.`);
  failure.stack = failure.message;
  return failure;
}

function proof(t: TestContext, diagnostic: Diagnostic, name: string, work: () => Promise<void>): Promise<void> {
  return t.test(name, async () => {
    enter(diagnostic, 'page-assertions');
    try { await work(); } catch (cause) { throw safeFailure(cause, diagnostic); }
  });
}

/** FIN/054 exact role/target contract, plus the explicit shared-53782 exclusion. */
function safeTargets(): { urls: string[]; database: string } {
  let target: string | undefined;
  let expectedDatabase: string | undefined;
  const urls = roleConfig.map(([name, role], index) => {
    const value = configuredUrls[index];
    assert.ok(value, `${name} is required for the tenant-directory PostgreSQL gate`);
    let parsed: URL; let username: string; let database: string;
    try {
      parsed = new URL(value);
      username = decodeURIComponent(parsed.username);
      database = decodeURIComponent(parsed.pathname.slice(1));
    } catch { throw new Error('Tenant-directory PostgreSQL target is invalid; details redacted.'); }
    // Boolean assertions cannot render a credential-bearing URL/username.
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL protocol required');
    assert.ok(username === role, 'exact managed role required');
    assert.ok(parsed.search === '' && parsed.hash === '', 'connection/query/role/search_path overrides and fragments are forbidden');
    const hostname = parsed.hostname.toLowerCase(); const port = Number(parsed.port);
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432, 53782].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, 'designated CI target or exact loopback disposable database on an explicit nondefault, nonshared port required');
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity; expectedDatabase ??= database;
    assert.ok(identity === target, 'all three roles must use the same guarded disposable database');
    return value;
  });
  assert.ok(expectedDatabase, 'guarded database required before pool creation');
  return { urls, database: expectedDatabase };
}

async function boundedTransaction<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>, readOnly = false): Promise<T> {
  return database.transaction(async tx => {
    if (readOnly) await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    return work(tx);
  });
}

async function principal(executor: SqlExecutor, expectedRole: string, expectedDatabase: string): Promise<void> {
  const result = await executor.query<{
    principal: string; session: string; superuser: boolean; database: string;
    schema: string; path: string; schemas: string[]; version: string;
  }>(`SELECT current_user AS principal, session_user AS session, r.rolsuper AS superuser,
             current_database() AS database, current_schema() AS schema,
             current_setting('search_path') AS path, current_schemas(true)::text[] AS schemas,
             current_setting('server_version_num') AS version
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
  assert.equal(result.rows.length, 1, 'one direct backend identity required');
  const row = result.rows[0]!;
  assert.ok(row.principal === expectedRole && row.session === expectedRole, 'direct expected principal/session required; no role switching');
  assert.equal(row.superuser, false, 'superuser is forbidden');
  assert.ok(row.database === expectedDatabase, 'backend must match guarded disposable database');
  assert.ok(row.schema === 'model_router_saas' && row.path === 'model_router_saas', 'exact managed schema/search_path required');
  assert.deepEqual(row.schemas, ['pg_catalog', 'model_router_saas']);
  assert.ok([15, 18].includes(Math.floor(Number(row.version) / 10_000)), 'actual PG15 or PG18 required');
}

async function aclEvidence(control: SaasDatabase) {
  const result = await control.query<{ minimum_select: boolean; direct_execute: number; schema_create: boolean }>(
    `WITH needed(relation_name, column_name) AS (VALUES
       ('saas_tenants', 'id'), ('saas_tenants', 'status'),
       ('saas_memberships', 'tenant_id'), ('saas_memberships', 'user_id'),
       ('saas_memberships', 'role'), ('saas_memberships', 'status'),
       ('saas_users', 'id'), ('saas_users', 'display_name'), ('saas_users', 'disabled_at')
     )
     SELECT (SELECT bool_and(pg_catalog.has_column_privilege(current_user, relation_name, column_name, 'SELECT')) FROM needed) AS minimum_select,
       (SELECT count(*)::integer FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'model_router_saas' AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')) AS direct_execute,
       pg_catalog.has_schema_privilege(current_user, 'model_router_saas', 'CREATE') AS schema_create`);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], { minimum_select: true, direct_execute: 0, schema_create: false },
    'existing restricted CP SELECT must suffice without helper EXECUTE or schema CREATE');
  return result.rows[0]!;
}

interface Fixture {
  tenantId: string; otherTenantId: string;
  members: SafeTenantMember[];
  outsiderId: string;
  privateSentinels: string[];
  actors: {
    owner: string; admin: string; viewer: string; developer: string; billing: string;
    disabled: string; suspended: string; revoked: string; foreignOwner: string;
    revokePage: string; changePage: string; disablePage: string; suspendPage: string;
  };
}

async function seedFixture(migrator: SaasDatabase): Promise<Fixture> {
  const label = randomUUID();
  const prefix = randomUUID().slice(0, 24);
  const userId = (index: number) => prefix + index.toString(16).padStart(12, '0');
  const roles: TenantRole[] = ['owner', 'admin', 'viewer', 'developer', 'billing', 'owner', 'owner', 'admin', 'viewer', 'admin', 'admin', 'owner', 'admin'];
  const members: SafeTenantMember[] = Array.from({ length: 113 }, (_, index) => ({
    userId: userId(index + 1), displayName: index === 15 ? null : `Directory fixture member ${index + 1}`,
    role: roles[index] ?? 'viewer', status: index === 5 ? 'disabled' : index === 6 ? 'suspended' : index === 7 ? 'revoked' : 'active',
  }));
  const fixture: Fixture = {
    tenantId: randomUUID(), otherTenantId: randomUUID(), members, outsiderId: userId(114),
    privateSentinels: [`directory-fixture-password-${label}`, `directory-fixture-session-${label}`, `directory-fixture-key-${label}`],
    actors: { owner: userId(1), admin: userId(2), viewer: userId(3), developer: userId(4), billing: userId(5),
      disabled: userId(6), suspended: userId(7), revoked: userId(8), foreignOwner: userId(9),
      revokePage: userId(10), changePage: userId(11), disablePage: userId(12), suspendPage: userId(13) },
  };
  const projects = [randomUUID(), randomUUID()];
  await boundedTransaction(migrator, async tx => {
    // Only fresh, synthetic fixture rows. Password text is a sentinel, never a
    // real account credential; no login/session/key/MFA rows are manufactured.
    for (const [index, member] of [...members, { userId: fixture.outsiderId, displayName: 'Directory outsider', role: 'viewer', status: 'active' }].entries()) {
      const email = `directory-${label}-${index}@example.test`;
      fixture.privateSentinels.push(email);
      await tx.query(`INSERT INTO saas_users (id, email, display_name, password_hash, disabled_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END)`,
      [member.userId, email, member.displayName, fixture.privateSentinels[0], member.status === 'disabled']);
    }
    for (const [index, tenantId] of [fixture.tenantId, fixture.otherTenantId].entries()) {
      await tx.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $3)`,
        [tenantId, `Directory fixture tenant ${index + 1}`, `directory-${label}-${index}`]);
      await tx.query(`INSERT INTO saas_projects (tenant_id, id, name, slug, is_default)
        VALUES ($1, $2, 'Directory default fixture', 'directory-default', TRUE)`, [tenantId, projects[index]]);
    }
    for (const member of members) {
      const status = member.status === 'disabled' ? 'active' : member.status;
      await tx.query(`INSERT INTO saas_memberships (tenant_id, user_id, role, status, revoked_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'revoked' THEN clock_timestamp() ELSE NULL END)`,
      [fixture.tenantId, member.userId, member.role, status]);
      // Project owner is deliberately not a tenant-directory grant. These are
      // MIG-authored fixtures, not a business-owner mutation/transfer API.
      const projectRole = member.userId === fixture.actors.developer ? 'owner' : 'viewer';
      await tx.query(`INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role, status, revoked_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'revoked' THEN clock_timestamp() ELSE NULL END)`,
      [fixture.tenantId, projects[0], member.userId, projectRole, status]);
    }
    for (const [id, role] of [[fixture.actors.foreignOwner, 'owner'], [fixture.outsiderId, 'viewer']] as const) {
      await tx.query(`INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [fixture.otherTenantId, id, role]);
      await tx.query(`INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role)
        VALUES ($1, $2, $3, $4)`, [fixture.otherTenantId, projects[1], id, role]);
    }
  });
  return fixture;
}

/** Observation only: original SQL/parameters/results go to the real CP principal. */
function directoryHarness(control: SaasDatabase, diagnostic: Diagnostic, databaseName: string) {
  let reads = 0;
  const forbidden = () => { throw new Error('Directory service attempted a non-query capability; details redacted.'); };
  const observed: SaasDatabase = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      reads += 1; enter(diagnostic, 'directory-sql-contract');
      const normalized = sql.replace(/\s+/g, ' ').trim();
      assert.ok(/^WITH authorized AS \(/.test(normalized), 'one original directory authorization/page statement required');
      assert.ok(!/;|\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|GRANT|REVOKE|LOCK|CALL|EXECUTE|FOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)|pg_advisory\w*|pg_sleep|password_hash|email|saas_sessions|saas_api_keys)\b/i.test(normalized),
        'directory SQL must stay read-only/minimal, without row/advisory locks or sensitive columns');
      assert.ok(!/\bsaas_\w+\s*\(/i.test(normalized), 'direct trusted-schema helper invocation is forbidden');
      try {
        return await boundedTransaction(control, async tx => {
          enter(diagnostic, 'directory-principal');
          await principal(tx, 'model_router_saas_control_plane', databaseName);
          enter(diagnostic, 'directory-select');
          const result = await tx.query<Row>(sql, values); // No mocked DB, rewrite, fallback or result mutation.
          enter(diagnostic, 'directory-lock-proof');
          const locks = await tx.query<{ prohibited: number }>(`SELECT count(*)::integer AS prohibited
            FROM pg_catalog.pg_locks WHERE pid = pg_backend_pid() AND granted
              AND (locktype IN ('advisory', 'tuple') OR (locktype = 'relation' AND mode <> 'AccessShareLock'))`);
          assert.deepEqual(locks.rows, [{ prohibited: 0 }], 'actual CP read transaction must hold no row/write/advisory locks');
          return result;
        }, true);
      } catch (cause) {
        diagnostic.sqlState = sqlState(cause); // Capture before the service strips its storage cause.
        throw cause;
      }
    },
    transaction: forbidden, migrate: forbidden, verifySchema: forbidden, ping: forbidden, close: forbidden,
  };
  // Reused across pages and all MIG state changes: a new service instance must
  // not hide a hypothetical authorization cache bug between requests.
  const service = new SaasIdentityService(observed);
  return { service, readCount: () => reads };
}

function assertPage(page: TenantMemberPage, expected: readonly SafeTenantMember[], fixture: Fixture, diagnostic: Diagnostic): void {
  enter(diagnostic, 'page-assertions');
  assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
  assert.ok(page.items.length <= 100, 'public page must remain bounded');
  assert.deepEqual(page.items, expected);
  for (const member of page.items) assert.deepEqual(Object.keys(member).sort(), ['displayName', 'role', 'status', 'userId']);
  const output = JSON.stringify(page);
  assert.ok(!fixture.privateSentinels.some(value => output.includes(value)), 'minimal projection/cursor must not contain any fixture email/credential/session/key sentinel');
  if (page.nextCursor !== null) assert.ok(/^tm1\.[A-Za-z0-9_-]+$/.test(page.nextCursor) && page.nextCursor.length <= 1024, 'bounded opaque cursor required');
}

async function denied(work: Promise<unknown>, diagnostic: Diagnostic, code = 'TENANT_ACCESS_DENIED', status = 403): Promise<void> {
  await assert.rejects(work, (cause: unknown) => {
    assert.ok(cause instanceof SaasIdentityError, 'existing safe identity error required, never a raw PG error');
    assert.ok(cause.code === code && cause.status === status, 'exact safe identity denial required; storage/ACL errors must fail, not substitute for denial');
    assert.ok(!('cause' in cause), 'safe identity error must not retain a raw storage cause');
    // Only clear the capture after a genuine expected denial. If a real SELECT
    // failed, retain its phase/SQLSTATE through the sanitized service error.
    enter(diagnostic, 'page-assertions');
    return true;
  });
}

function cursorAfter(actor: string, tenant: string, last: string): string {
  // A cursor is a selector, not approval. Generating a valid scoped selector in
  // the fixture still requires the real current SQL authority predicate.
  const scopeHash = createHash('sha256').update(JSON.stringify(['tenant-members', actor, tenant])).digest('hex');
  return 'tm1.' + Buffer.from(JSON.stringify({ kind: 'tenant-members', version: 1, scopeHash, userId: last })).toString('base64url');
}

test('tenant member directory: actual PG15/18 restricted control-plane SELECT and fresh paginated authority', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
    ? `offline skip: set ${REQUIRED_FLAG}=1 and all three disposable MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs` : false,
  timeout: 120_000,
}, async t => {
  const diagnostic: Diagnostic = { phase: 'target-guard' };
  const databases: SaasDatabase[] = [];
  let workFailed = false;
  try {
    const target = safeTargets(); // All URLs validated before any pool opens.
    for (const connectionString of target.urls) databases.push(createSaasDatabase({ connectionString, max: 1, connectionTimeoutMillis: 5_000 }));
    const [migrator, control, gateway] = databases;
    assert.ok(migrator && control && gateway, 'three exact guarded role pools required');
    enter(diagnostic, 'principal-preflight');
    for (const [index, database] of databases.entries()) await principal(database, roleConfig[index]![1], target.database);
    enter(diagnostic, 'schema-preflight');
    await migrator.verifySchema(); // Dynamic registered ledger/checksum verification; never migrate/repair.
    const through059 = await migrator.query<{ installed: boolean }>('SELECT EXISTS (SELECT 1 FROM saas_schema_migrations WHERE version = 59) AS installed');
    assert.deepEqual(through059.rows, [{ installed: true }], 'independently provisioned through-059 target required');
    enter(diagnostic, 'acl-preflight');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    const beforeAcl = await aclEvidence(control);
    const initialization = await control.query('SELECT initialized, initialized_at FROM saas_platform_state WHERE singleton = TRUE');
    assert.equal(initialization.rows.length, 1, 'existing initialization facts required, never reset');
    enter(diagnostic, 'fixture-seed');
    const fixture = await seedFixture(migrator);
    const harness = directoryHarness(control, diagnostic, target.database);
    const { service } = harness;

    await proof(t, diagnostic, 'owner/admin read real CP columns with exactly the four minimal member fields and default 25 bound', async () => {
      for (const actor of [fixture.actors.owner, fixture.actors.admin]) {
        const before = harness.readCount();
        const page = await service.listTenantMembers(actor, fixture.tenantId);
        assertPage(page, fixture.members.slice(0, 25), fixture, diagnostic);
        assert.equal(harness.readCount() - before, 1, 'one real CP authorization/page statement per request');
        assert.ok(page.nextCursor, 'more than 25 real members must return a next cursor');
        assert.ok(page.items.some(member => member.status === 'disabled'), 'disabled member cannot be mislabeled active');
        assert.ok(page.items.some(member => member.displayName === null), 'nullable names must survive minimal projection');
      }
    });

    await proof(t, diagnostic, '25/100 keyset pages are stable, complete, duplicate-free and scoped to tenant plus actor', async () => {
      const first = await service.listTenantMembers(fixture.actors.owner, fixture.tenantId);
      assert.ok(first.nextCursor);
      const repeated = await service.listTenantMembers(fixture.actors.owner, fixture.tenantId);
      assertPage(repeated, fixture.members.slice(0, 25), fixture, diagnostic);
      assert.equal(repeated.nextCursor, first.nextCursor, 'unchanged first page has stable cursor');
      const all: SafeTenantMember[] = [...first.items];
      let cursor: string | null = first.nextCursor;
      let pages = 1;
      while (cursor !== null) {
        assert.ok(pages < 6, 'bounded fixture pagination must terminate');
        const page = await service.listTenantMembers(fixture.actors.owner, fixture.tenantId, { cursor });
        assertPage(page, fixture.members.slice(pages * 25, (pages + 1) * 25), fixture, diagnostic);
        all.push(...page.items); cursor = page.nextCursor; pages++;
      }
      assert.equal(pages, 5); assert.equal(all.length, 113);
      assert.equal(new Set(all.map(member => member.userId)).size, 113);
      assert.deepEqual(all, fixture.members);
      const hundred = await service.listTenantMembers(fixture.actors.admin, fixture.tenantId, { limit: 100 });
      assertPage(hundred, fixture.members.slice(0, 100), fixture, diagnostic);
      assert.ok(hundred.nextCursor);
      const remainder = await service.listTenantMembers(fixture.actors.admin, fixture.tenantId, { limit: 100, cursor: hundred.nextCursor });
      assertPage(remainder, fixture.members.slice(100), fixture, diagnostic); assert.equal(remainder.nextCursor, null);
      const before = harness.readCount();
      await denied(service.listTenantMembers(fixture.actors.admin, fixture.tenantId, { cursor: first.nextCursor }), diagnostic, 'INVALID_INPUT', 400);
      await denied(service.listTenantMembers(fixture.actors.owner, fixture.otherTenantId, { cursor: first.nextCursor }), diagnostic, 'INVALID_INPUT', 400);
      await denied(service.listTenantMembers(fixture.actors.owner, fixture.tenantId, { limit: 101 }), diagnostic, 'INVALID_INPUT', 400);
      assert.equal(harness.readCount(), before, 'invalid bound/scope must fail before a CP query');
    });

    await proof(t, diagnostic, 'viewer/developer/billing, outsider, disabled/inactive membership and cross-tenant authority are denied', async () => {
      for (const actor of [fixture.actors.viewer, fixture.actors.developer, fixture.actors.billing, fixture.outsiderId,
        fixture.actors.disabled, fixture.actors.suspended, fixture.actors.revoked, fixture.actors.foreignOwner]) {
        const before = harness.readCount();
        await denied(service.listTenantMembers(actor, fixture.tenantId), diagnostic);
        assert.equal(harness.readCount() - before, 1, 'denial must be from actual fresh CP SQL');
      }
      await denied(service.listTenantMembers(fixture.actors.owner, fixture.otherTenantId), diagnostic);
      await denied(service.listTenantMembers(fixture.actors.owner, randomUUID()), diagnostic);
      await denied(service.listTenantMembers(fixture.outsiderId, fixture.otherTenantId), diagnostic);
      const other = await service.listTenantMembers(fixture.actors.foreignOwner, fixture.otherTenantId);
      const foreign = fixture.members.find(member => member.userId === fixture.actors.foreignOwner)!;
      assertPage(other, [{ ...foreign, role: 'owner' }, { userId: fixture.outsiderId, displayName: 'Directory outsider', role: 'viewer', status: 'active' }], fixture, diagnostic);
      assert.equal(other.nextCursor, null);
    });

    await proof(t, diagnostic, 'authorized empty page is not an authorization fallback for a denied actor', async () => {
      const last = fixture.members.at(-1); assert.ok(last);
      const empty = await service.listTenantMembers(fixture.actors.owner, fixture.tenantId, {
        cursor: cursorAfter(fixture.actors.owner, fixture.tenantId, last.userId),
      });
      assertPage(empty, [], fixture, diagnostic); assert.equal(empty.nextCursor, null);
      await denied(service.listTenantMembers(fixture.actors.viewer, fixture.tenantId, {
        cursor: cursorAfter(fixture.actors.viewer, fixture.tenantId, last.userId),
      }), diagnostic);
    });

    await proof(t, diagnostic, 'same service rejects next page after MIG commits revoke, role change, disable or suspension', async () => {
      for (const [actor, change] of [[fixture.actors.revokePage, 'revoke'], [fixture.actors.changePage, 'role'],
        [fixture.actors.disablePage, 'disable'], [fixture.actors.suspendPage, 'suspend']] as const) {
        const first = await service.listTenantMembers(actor, fixture.tenantId);
        assert.ok(first.nextCursor, 'actor is initially authorized with another real page');
        enter(diagnostic, 'fixture-state-change');
        await boundedTransaction(migrator, async tx => {
          const result = change === 'disable'
            ? await tx.query('UPDATE saas_users SET disabled_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1', [actor])
            : change === 'role'
              ? await tx.query("UPDATE saas_memberships SET role = 'viewer', updated_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2", [fixture.tenantId, actor])
              : await tx.query(`UPDATE saas_memberships SET status = $3,
                  revoked_at = CASE WHEN $3 = 'revoked' THEN clock_timestamp() ELSE NULL END,
                  updated_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2`,
                [fixture.tenantId, actor, change === 'revoke' ? 'revoked' : 'suspended']);
          assert.equal(result.rowCount, 1, 'MIG may update only the exact synthetic fixture authority row');
        });
        const before = harness.readCount();
        await denied(service.listTenantMembers(actor, fixture.tenantId, { cursor: first.nextCursor }), diagnostic);
        assert.equal(harness.readCount() - before, 1, 'cached actor/old cursor must not skip a fresh CP authority statement');
      }
    });

    await proof(t, diagnostic, 'tenant suspended/closed between pages rejects previously authorized selectors without restoring it', async () => {
      const first = await service.listTenantMembers(fixture.actors.admin, fixture.tenantId); assert.ok(first.nextCursor);
      for (const status of ['suspended', 'closed']) {
        enter(diagnostic, 'fixture-state-change');
        await boundedTransaction(migrator, async tx => {
          const result = await tx.query('UPDATE saas_tenants SET status = $2, updated_at = clock_timestamp() WHERE id = $1', [fixture.tenantId, status]);
          assert.equal(result.rowCount, 1, 'only synthetic current tenant may change');
        });
        await denied(service.listTenantMembers(fixture.actors.admin, fixture.tenantId, { cursor: first.nextCursor }), diagnostic);
        await denied(service.listTenantMembers(fixture.actors.owner, fixture.tenantId), diagnostic);
      }
    });

    enter(diagnostic, 'postflight');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    assert.deepEqual(await aclEvidence(control), beforeAcl, 'no privilege expansion or direct helper EXECUTE');
    assert.deepEqual((await control.query('SELECT initialized, initialized_at FROM saas_platform_state WHERE singleton = TRUE')).rows,
      initialization.rows, 'directory/fixtures must not reset initialization facts');
    await migrator.verifySchema();
  } catch (cause) {
    workFailed = true; throw safeFailure(cause, diagnostic);
  } finally {
    const closed = await Promise.allSettled(databases.map(database => database.close()));
    if (!workFailed && closed.some(result => result.status === 'rejected')) {
      enter(diagnostic, 'pool-cleanup'); throw safeFailure(undefined, diagnostic);
    }
    // Retain all synthetic rows and any successful/failed evidence in the
    // disposable target. Do not delete rows or stop an external PG daemon.
  }
});
