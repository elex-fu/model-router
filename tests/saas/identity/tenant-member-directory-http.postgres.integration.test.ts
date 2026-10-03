import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';
import { hashPassword } from '../../../src/saas/identity/password.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { SafeTenantMember, TenantRole } from '../../../src/saas/identity/types.js';

// Real HTTP + restricted CP PostgreSQL proof, not a browser/managed Redis or
// member-mutation acceptance claim. The PG15/18 execution owner independently
// provisions the current registered schema, at least through 059, and roles.
// No migrations, grants, SET ROLE/search_path, DDL, bootstrap reset, manufactured
// sessions, provider/key rows, fixture deletion or external daemon cleanup.
const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configuredUrls = roleConfig.map(([name]) => process.env[name]?.trim());
const anyConfigured = configuredUrls.some(Boolean);
const API = '/console/api/v1';

type Phase = 'target-guard' | 'principal-preflight' | 'schema-preflight' | 'acl-preflight'
  | 'fixture-seed' | 'http-listen' | 'http-request' | 'auth-sql' | 'directory-sql-contract'
  | 'directory-principal' | 'directory-select' | 'directory-lock-proof' | 'http-assertions'
  | 'fixture-state-change' | 'postflight' | 'http-cleanup' | 'pool-cleanup';
interface Diagnostic { phase: Phase; caseName: string; sqlState?: string; lastHttpStatus: number | null }

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
  // Capture only a real numeric/alphanumeric PG SQLSTATE before the identity
  // service redacts storage errors. Never invent 42501 or retain raw causes,
  // assertion operands, SQL/parameters, response bodies, URLs or credentials.
  const state = diagnostic.sqlState ?? sqlState(cause);
  const failure = new Error(`Tenant directory HTTP/PG proof failed (case=${diagnostic.caseName}; phase=${diagnostic.phase}; SQLSTATE=${state ?? 'not-captured'}); details redacted.`);
  failure.stack = failure.message;
  return failure;
}

const SAFE_ERROR_CODES = new Set([
  'ERR_ASSERTION', 'SAAS_RUNTIME_PRIVILEGES_UNSAFE',
  'INVALID_INPUT', 'IDENTITY_STORAGE_ERROR', 'IDENTITY_CONFLICT', 'EMAIL_ALREADY_EXISTS',
  'BOOTSTRAP_ALREADY_COMPLETED', 'BOOTSTRAP_TOKEN_ALREADY_ISSUED', 'BOOTSTRAP_TOKEN_INVALID',
  'TENANT_SLUG_TAKEN', 'TENANT_ACCESS_DENIED', 'INSUFFICIENT_TENANT_ROLE',
  'INVALID_INVITATION_ROLE', 'INVITATION_PENDING', 'INVITATION_INVALID', 'INVITATION_ALREADY_MEMBER',
]);

function failureDiagnostic(t: TestContext, cause: unknown, diagnostic: Diagnostic): void {
  try {
    const state = diagnostic.sqlState ?? sqlState(cause);
    // Labels come only from this root's fixed case/phase assignments. Inspect
    // only an own data code, never arbitrary messages/stacks or HTTP contents.
    const descriptor = cause && typeof cause === 'object' ? Object.getOwnPropertyDescriptor(cause, 'code') : undefined;
    const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    t.diagnostic('member_directory_http_failure ' + JSON.stringify({
      caseName: diagnostic.caseName,
      phase: diagnostic.phase,
      sqlState: typeof state === 'string' && /^[A-Z0-9]{5}$/.test(state) ? state : null,
      errorCode: typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : null,
      lastHttpStatus: typeof diagnostic.lastHttpStatus === 'number' && Number.isInteger(diagnostic.lastHttpStatus)
        ? diagnostic.lastHttpStatus : null,
    }));
  } catch {
    // Passive TAP observation must never replace the original safeFailure.
  }
}

function proof(t: TestContext, diagnostic: Diagnostic, name: string, work: () => Promise<void>): Promise<void> {
  return t.test(name, async child => {
    diagnostic.caseName = name; diagnostic.phase = 'http-assertions'; diagnostic.sqlState = undefined;
    diagnostic.lastHttpStatus = null;
    try { await work(); } catch (cause) {
      failureDiagnostic(child, cause, diagnostic); throw safeFailure(cause, diagnostic);
    }
  });
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned fixture deadline exceeded; details redacted.')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Same FIN/054 exact three-role contract, including shared-port exclusion. */
function safeTargets(): { urls: string[]; database: string } {
  let target: string | undefined; let expectedDatabase: string | undefined;
  const urls = roleConfig.map(([name, role], index) => {
    const value = configuredUrls[index];
    assert.ok(value, `${name} is required for the tenant-directory HTTP/PG gate`);
    let parsed: URL; let username: string; let database: string;
    try {
      parsed = new URL(value);
      username = decodeURIComponent(parsed.username);
      database = decodeURIComponent(parsed.pathname.slice(1));
    } catch { throw new Error('Invalid disposable PostgreSQL target; details redacted.'); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL protocol required');
    assert.ok(username === role, 'exact managed role required');
    assert.ok(parsed.search === '' && parsed.hash === '', 'query/connection/role/search_path overrides and fragments are forbidden');
    const hostname = parsed.hostname.toLowerCase(); const port = Number(parsed.port);
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432, 53782].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, 'designated CI or exact loopback disposable database on an explicit nondefault, nonshared port required');
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity; expectedDatabase ??= database;
    assert.ok(identity === target, 'all three roles must use the same guarded disposable database');
    return value;
  });
  assert.ok(expectedDatabase, 'guarded database required before pool/listener creation');
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

async function principal(executor: SqlExecutor, role: string, database: string): Promise<void> {
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
  assert.ok(row.principal === role && row.session === role, 'direct expected principal/session required, without role switching');
  assert.equal(row.superuser, false, 'superuser forbidden');
  assert.ok(row.database === database, 'backend must match the guarded disposable database');
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
  assert.deepEqual(result.rows, [{ minimum_select: true, direct_execute: 0, schema_create: false }],
    'existing restricted CP SELECT must suffice without helper EXECUTE/schema CREATE');
  return result.rows[0]!;
}

interface Fixture {
  tenantId: string; otherTenantId: string; members: SafeTenantMember[]; otherMembers: SafeTenantMember[];
  password: string; emails: Map<string, string>; privateSentinels: string[];
  actors: { owner: string; admin: string; viewer: string; developer: string; foreignOwner: string;
    rolePage: string; revokePage: string; disablePage: string; suspendPage: string; logoutPage: string };
}

async function seedFixture(migrator: SaasDatabase): Promise<Fixture> {
  const label = randomUUID(); const prefix = randomUUID().slice(0, 24);
  const userId = (index: number) => prefix + index.toString(16).padStart(12, '0');
  const roles: TenantRole[] = ['owner', 'admin', 'viewer', 'developer', 'admin', 'owner', 'admin', 'admin', 'owner'];
  const members: SafeTenantMember[] = Array.from({ length: 26 }, (_, index) => ({
    userId: userId(index + 1), displayName: index === 15 ? null : `HTTP directory fixture member ${index + 1}`,
    role: roles[index] ?? 'viewer', status: index === 9 ? 'disabled' : index === 10 ? 'suspended' : index === 11 ? 'revoked' : 'active',
  }));
  const otherMembers: SafeTenantMember[] = [
    { userId: userId(27), displayName: 'HTTP foreign tenant owner', role: 'owner', status: 'active' },
    { userId: userId(28), displayName: 'HTTP foreign tenant viewer', role: 'viewer', status: 'active' },
  ];
  const password = `Fixture-only-Directory-HTTP-${label}!42`;
  const passwordHash = await hashPassword(password); // Valid real identity scrypt; never plaintext persisted.
  const fixture: Fixture = {
    tenantId: randomUUID(), otherTenantId: randomUUID(), members, otherMembers, password, emails: new Map(),
    privateSentinels: [password, passwordHash],
    actors: { owner: userId(1), admin: userId(2), viewer: userId(3), developer: userId(4),
      rolePage: userId(5), revokePage: userId(6), disablePage: userId(7), suspendPage: userId(8),
      logoutPage: userId(9), foreignOwner: userId(27) },
  };
  await boundedTransaction(migrator, async tx => {
    for (const [index, member] of [...members, ...otherMembers].entries()) {
      const email = `directory-http-${label}-${index}@example.test`;
      fixture.emails.set(member.userId, email); fixture.privateSentinels.push(email);
      await tx.query(`INSERT INTO saas_users (id, email, display_name, password_hash, disabled_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END)`,
      [member.userId, email, member.displayName, passwordHash, member.status === 'disabled']);
    }
    for (const [index, tenantId] of [fixture.tenantId, fixture.otherTenantId].entries()) {
      await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $3)',
        [tenantId, `HTTP directory fixture tenant ${index + 1}`, `directory-http-${label}-${index}`]);
      for (const member of index === 0 ? members : otherMembers) {
        const status = member.status === 'disabled' ? 'active' : member.status;
        await tx.query(`INSERT INTO saas_memberships (tenant_id, user_id, role, status, revoked_at)
          VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'revoked' THEN clock_timestamp() ELSE NULL END)`,
        [tenantId, member.userId, member.role, status]);
      }
    }
  });
  return fixture;
}

/** Observation/deadlines only: no mocked DB responses, rewritten business SQL or authority/context seams. */
function actualService(control: SaasDatabase, diagnostic: Diagnostic, databaseName: string) {
  let directoryReads = 0; let lockProofs = 0;
  const capture = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (cause) {
      diagnostic.sqlState ??= sqlState(cause); throw cause;
    }
  };
  const query = <Row>(tx: SqlExecutor, sql: string, values?: readonly unknown[]) => {
    diagnostic.phase = 'auth-sql';
    return capture(() => tx.query<Row>(sql, values));
  };
  const forbidden = async (): Promise<never> => { throw new Error('Unexpected non-business database capability; details redacted.'); };
  const observed: SaasDatabase = {
    query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      const directory = /^\s*WITH authorized AS \(/.test(sql);
      const readOnly = directory || /^\s*SELECT\b/i.test(sql);
      if (readOnly) {
        // Includes the original cookie/session lookup before the directory
        // query. Login's fenced writer transaction is delegated separately.
        assert.ok(!/\b(?:FOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)|pg_advisory\w*|LOCK|CALL|EXECUTE)\b|\bsaas_\w+\s*\(/i.test(sql),
          'standalone identity reads must not acquire row/advisory locks or execute trusted helpers');
      }
      if (directory) {
        directoryReads++; diagnostic.phase = 'directory-sql-contract';
        const normalized = sql.replace(/\s+/g, ' ').trim();
        assert.ok(!/;|\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|GRANT|REVOKE|LOCK|CALL|EXECUTE|FOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)|pg_advisory\w*|pg_sleep|password_hash|email|saas_sessions|saas_api_keys)\b/i.test(normalized),
          'directory authority/page SQL must be read-only and minimal without row/advisory locks');
        assert.ok(!/\bsaas_\w+\s*\(/i.test(normalized), 'no direct trusted-schema helper invocation');
      }
      return capture(() => boundedTransaction(control, async tx => {
        if (!directory) return query<Row>(tx, sql, values);
        diagnostic.phase = 'directory-principal';
        await principal(tx, 'model_router_saas_control_plane', databaseName);
        diagnostic.phase = 'directory-select';
        const result = await tx.query<Row>(sql, values); // Original real CP query/parameters/results, unchanged.
        diagnostic.phase = 'directory-lock-proof';
        const locks = await tx.query<{ prohibited: number }>(`SELECT count(*)::integer AS prohibited
          FROM pg_catalog.pg_locks WHERE pid = pg_backend_pid() AND granted
          AND (locktype IN ('advisory', 'tuple') OR (locktype = 'relation' AND mode <> 'AccessShareLock'))`);
        assert.deepEqual(locks.rows, [{ prohibited: 0 }], 'actual directory transaction holds no row/write/advisory locks');
        lockProofs++; return result;
      }, readOnly));
    },
    transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => capture(() => boundedTransaction(control, tx => work({
      query: <Row>(sql: string, values?: readonly unknown[]) => query<Row>(tx, sql, values),
    }))),
    migrate: forbidden, verifySchema: forbidden, ping: forbidden, close: forbidden,
  };
  return { service: new SaasIdentityService(observed), reads: () => directoryReads, locks: () => lockProofs };
}

interface Reply { status: number; headers: Headers; body: Record<string, unknown> }
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'HTTP object required');
  return value as Record<string, unknown>;
}

function httpFixture(service: SaasIdentityService, diagnostic: Diagnostic) {
  let origin: string | undefined;
  let handler: ReturnType<typeof createSaasIdentityHandler> | undefined;
  let unexpected = 0;
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const work = (async () => {
      try {
        if (!handler) throw new Error('HTTP fixture handler unavailable');
        if (await handler(req, res)) return;
        unexpected++; res.writeHead(404); res.end();
      } catch (cause) {
        unexpected++; diagnostic.sqlState ??= sqlState(cause);
        if (!res.destroyed && !res.writableEnded) {
          try {
            if (res.headersSent) res.destroy();
            else { res.writeHead(500); res.end(); }
          } catch { res.destroy(); }
        }
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => { unexpected++; pending.delete(work); });
  });
  server.requestTimeout = 25_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000;
  server.setTimeout(20_000, socket => socket.destroy());
  return {
    async listen(): Promise<void> {
      diagnostic.phase = 'http-listen';
      await bounded(new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(new Error('Owned HTTP listener failed; details redacted.')));
        server.listen(0, '127.0.0.1', resolve);
      }), 5_000);
      const address = server.address();
      assert.ok(address && typeof address !== 'string', 'ephemeral loopback HTTP listener required');
      origin = `http://127.0.0.1:${address.port}`;
      // The original bounded local limiter is retained, not an always-allow
      // fixture. Exactly ten normal logins fit its source limit; directory
      // requests are also budgeted below ten per real actor. This is not proof
      // of managed multi-instance Redis limits or a production HTTPS endpoint.
      handler = createSaasIdentityHandler({ service, publicOrigin: origin, sessionTtlSeconds: 900 });
    },
    async request(path: string, options: RequestInit = {}): Promise<Reply> {
      diagnostic.lastHttpStatus = null;
      assert.ok(origin, 'owned HTTP listener must be ready');
      diagnostic.phase = 'http-request';
      const response = await fetch(`${origin}${API}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      diagnostic.lastHttpStatus = response.status; // Actual status, before body reads/JSON parsing.
      const text = await response.text();
      assert.ok(Buffer.byteLength(text, 'utf8') <= 128 * 1024, 'bounded HTTP response required');
      const body: unknown = JSON.parse(text);
      return { status: response.status, headers: response.headers, body: object(body) };
    },
    origin(): string { assert.ok(origin, 'owned HTTP origin required'); return origin; },
    unexpected: () => unexpected,
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve, reject) => {
        server.close(cause => {
          if (cause && (!('code' in cause) || cause.code !== 'ERR_SERVER_NOT_RUNNING')) reject(cause);
          else resolve();
        });
        server.closeAllConnections();
      });
      const settled = await Promise.allSettled([
        bounded(closed, 5_000), bounded(Promise.allSettled([...pending]), 25_000),
      ]);
      assert.ok(settled.every(result => result.status === 'fulfilled'), 'owned HTTP listener and requests must finish within cleanup bounds');
    },
  };
}

type App = ReturnType<typeof httpFixture>;
interface Session { userId: string; cookie: string; csrfCookie: string; csrfToken: string }

function setCookies(reply: Reply): string[] {
  const headers = reply.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? (headers.get('set-cookie') ?? '').split(/, (?=[^;,]+=)/).filter(Boolean);
}

function noPrivateBody(reply: Reply, fixture: Fixture): void {
  const output = JSON.stringify(reply.body);
  assert.ok(!fixture.privateSentinels.some(value => output.includes(value)), 'HTTP body must not leak email/password/hash/session/CSRF values');
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(reply.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(reply.headers.get('content-type')?.startsWith('application/json'), 'JSON response required');
}

function successful(reply: Reply, fixture: Fixture): Record<string, unknown> {
  assert.equal(reply.status, 200, 'actual HTTP success required; SQL/ACL errors must fail');
  noPrivateBody(reply, fixture);
  assert.deepEqual(Object.keys(reply.body).sort(), ['data', 'meta']);
  const meta = object(reply.body.meta);
  assert.deepEqual(Object.keys(meta), ['requestId']); assert.equal(typeof meta.requestId, 'string');
  return object(reply.body.data);
}

function denied(reply: Reply, fixture: Fixture, status: 400 | 401 | 403, code: 'REQUEST_REJECTED' | 'UNAUTHENTICATED' | 'FORBIDDEN'): void {
  assert.equal(reply.status, status, 'exact HTTP rejection required, never a 500/SQL error or empty 200 fallback');
  noPrivateBody(reply, fixture);
  assert.deepEqual(Object.keys(reply.body), ['error']);
  const error = object(reply.body.error);
  assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId']);
  assert.equal(error.code, code); assert.equal(typeof error.message, 'string'); assert.equal(typeof error.requestId, 'string');
  assert.equal(reply.headers.get('set-cookie'), null, 'directory denial must not mint/reset cookies');
}

async function login(app: App, fixture: Fixture, userId: string): Promise<Session> {
  const email = fixture.emails.get(userId); assert.ok(email, 'exact synthetic login account required');
  const reply = await app.request('/auth/session', {
    method: 'POST', headers: { origin: app.origin(), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: fixture.password }),
  });
  const cookies = setCookies(reply); assert.equal(cookies.length, 2, 'two real login cookies required');
  const pair = (name: string): { cookie: string; token: string } => {
    const matches = cookies.filter(value => value.startsWith(`${name}=`)); assert.equal(matches.length, 1);
    const value = matches[0]!;
    assert.ok(value.includes('Path=/console/api/v1') && value.includes('SameSite=Strict') && value.includes('Max-Age=900'));
    if (name === 'mr_saas_session') assert.ok(value.includes('HttpOnly'), 'real session cookie must be HttpOnly');
    const cookie = value.split(';', 1)[0]!;
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), 'opaque real customer credential required');
    fixture.privateSentinels.push(token); return { cookie, token };
  };
  const session = pair('mr_saas_session'); const csrf = pair('mr_saas_csrf');
  const data = successful(reply, fixture); assert.deepEqual(Object.keys(data), ['session']);
  const publicSession = object(data.session);
  assert.deepEqual(Object.keys(publicSession).sort(), ['activeTenantId', 'createdAt', 'expiresAt', 'userId']);
  assert.ok(publicSession.userId === userId && publicSession.activeTenantId === null, 'login must resolve the exact synthetic user');
  assert.ok(typeof publicSession.expiresAt === 'string' && Date.parse(publicSession.expiresAt) > Date.now(), 'unexpired real session required');
  assert.equal(typeof publicSession.createdAt, 'string');
  return { userId, cookie: session.cookie, csrfCookie: csrf.cookie, csrfToken: csrf.token };
}

function assertPage(reply: Reply, expected: readonly SafeTenantMember[], fixture: Fixture): string | null {
  const data = successful(reply, fixture);
  assert.deepEqual(Object.keys(data).sort(), ['items', 'nextCursor']);
  assert.ok(Array.isArray(data.items) && data.items.length <= 100, 'bounded public members array required');
  assert.deepEqual(data.items, expected);
  for (const member of data.items) assert.deepEqual(Object.keys(object(member)).sort(), ['displayName', 'role', 'status', 'userId']);
  assert.equal(reply.headers.get('set-cookie'), null, 'directory GET must not mint/reset cookies');
  const cursor = data.nextCursor;
  if (cursor === null) return null;
  assert.ok(typeof cursor === 'string' && /^tm1\.[A-Za-z0-9_-]+$/.test(cursor) && cursor.length <= 1024);
  return cursor;
}

function cursorAfter(actor: string, tenant: string, last: string): string {
  // Public cursor selector only, never an authorization/session substitute.
  const scopeHash = createHash('sha256').update(JSON.stringify(['tenant-members', actor, tenant])).digest('hex');
  return 'tm1.' + Buffer.from(JSON.stringify({ kind: 'tenant-members', version: 1, scopeHash, userId: last })).toString('base64url');
}

test('tenant member directory: real customer HTTP sessions and restricted PG15/18 authorization', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
    ? `offline skip: set ${REQUIRED_FLAG}=1 and all three disposable MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs` : false,
  timeout: 150_000,
}, async t => {
  const diagnostic: Diagnostic = { phase: 'target-guard', caseName: 'preflight', lastHttpStatus: null };
  const databases: SaasDatabase[] = [];
  let app: App | undefined; let workFailed = false;
  try {
    const target = safeTargets(); // REQUIRED/partial/invalid config fails before any pool or HTTP listener.
    for (const connectionString of target.urls) databases.push(createSaasDatabase({ connectionString, max: 1, connectionTimeoutMillis: 5_000 }));
    const [migrator, control, gateway] = databases;
    assert.ok(migrator && control && gateway, 'three guarded direct-role pools required');
    diagnostic.phase = 'principal-preflight';
    for (const [index, database] of databases.entries()) await principal(database, roleConfig[index]![1], target.database);
    diagnostic.phase = 'schema-preflight';
    await migrator.verifySchema(); // Read-only current registry/checksum/unknown-ledger checks, never migrate/repair.
    const through059 = await migrator.query<{ installed: boolean }>('SELECT EXISTS (SELECT 1 FROM saas_schema_migrations WHERE version = 59) AS installed');
    assert.deepEqual(through059.rows, [{ installed: true }], 'independently provisioned through-059 target required');
    diagnostic.phase = 'acl-preflight';
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    const beforeAcl = await aclEvidence(control);
    const initialization = await control.query('SELECT initialized, initialized_at FROM saas_platform_state WHERE singleton = TRUE');
    assert.equal(initialization.rows.length, 1, 'existing initialization facts required, never reset');
    diagnostic.phase = 'fixture-seed';
    const fixture = await seedFixture(migrator);
    const harness = actualService(control, diagnostic, target.database);
    app = httpFixture(harness.service, diagnostic); await app.listen();
    const http = app;
    const sessions = new Map<string, Session>();
    // Every session is created by the original POST login handler/service on
    // CP, never MIG SQL, a stub token, a fake getSession or request actor context.
    for (const [name, userId] of Object.entries(fixture.actors)) {
      diagnostic.caseName = `real-password-login-${name}`; diagnostic.lastHttpStatus = null;
      sessions.set(userId, await login(http, fixture, userId));
    }
    const session = (userId: string): Session => {
      const value = sessions.get(userId); assert.ok(value, 'real previously logged-in session required'); return value;
    };
    const get = async (userId: string, tenant = fixture.tenantId, query = ''): Promise<Reply> => {
      const before = harness.reads();
      const reply = await http.request(`/tenants/${tenant}/members${query}`, { headers: { cookie: session(userId).cookie } });
      // The native fetch sends only the actual session cookie for GET. No
      // CSRF/actor/role/context header, mocked directory or response fallback.
      if (reply.status === 200 || reply.status === 403) assert.equal(harness.reads() - before, 1, 'one real fresh CP directory statement per authorized/permission-denied request');
      else if (reply.status === 400 || reply.status === 401) assert.equal(harness.reads(), before, 'bad selector or invalid session must not run directory SQL');
      assert.equal(harness.locks(), harness.reads(), 'every actual directory SELECT has a successful real lock proof');
      return reply;
    };
    let ownerCursor: string | null = null;

    await proof(t, diagnostic, 'owner-admin-default25-and-next-page-minimal-projection', async () => {
      const before = harness.reads();
      denied(await http.request(`/tenants/${fixture.tenantId}/members`), fixture, 401, 'UNAUTHENTICATED');
      assert.equal(harness.reads(), before, 'anonymous request cannot execute directory SQL');
      const first = await get(fixture.actors.owner);
      const cursor = assertPage(first, fixture.members.slice(0, 25), fixture);
      assert.ok(cursor, '26 real rows require a next cursor at default limit 25');
      ownerCursor = cursor;
      const repeated = assertPage(await get(fixture.actors.owner), fixture.members.slice(0, 25), fixture);
      assert.equal(repeated, cursor, 'unchanged public first page/cursor is stable');
      const last = await get(fixture.actors.owner, fixture.tenantId, `?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(assertPage(last, fixture.members.slice(25), fixture), null);
      const firstItems = object(first.body.data).items; const lastItems = object(last.body.data).items;
      assert.ok(Array.isArray(firstItems) && Array.isArray(lastItems));
      const ids = [...firstItems, ...lastItems].map(member => object(member).userId);
      assert.equal(ids.length, 26, 'actual HTTP pages cover every fixture member');
      assert.equal(new Set(ids).size, 26, 'real keyset pages cannot overlap/omit members');
      assert.ok(fixture.members.slice(0, 25).some(member => member.displayName === null && member.status === 'active'));
      assert.ok(fixture.members.slice(0, 25).some(member => member.status === 'disabled'));
      const adminCursor = assertPage(await get(fixture.actors.admin), fixture.members.slice(0, 25), fixture);
      assert.ok(adminCursor);
      assert.equal(assertPage(await get(fixture.actors.admin, fixture.tenantId, `?cursor=${encodeURIComponent(adminCursor)}`), fixture.members.slice(25), fixture), null);
      assert.equal(assertPage(await get(fixture.actors.admin, fixture.tenantId, '?limit=100'), fixture.members, fixture), null);
    });

    await proof(t, diagnostic, 'real-cookie-tenant-isolation-and-viewer-developer-foreign-denials', async () => {
      for (const actor of [fixture.actors.viewer, fixture.actors.developer, fixture.actors.foreignOwner]) {
        denied(await get(actor), fixture, 403, 'FORBIDDEN');
      }
      denied(await get(fixture.actors.owner, fixture.otherTenantId), fixture, 403, 'FORBIDDEN');
      assert.equal(assertPage(await get(fixture.actors.foreignOwner, fixture.otherTenantId), fixture.otherMembers, fixture), null);
    });

    await proof(t, diagnostic, 'malformed-and-cross-actor-tenant-cursors-exact400-before-directory-select', async () => {
      const cursor = ownerCursor; assert.ok(cursor, 'public owner cursor from a real HTTP page required');
      denied(await get(fixture.actors.admin, fixture.tenantId, `?cursor=${encodeURIComponent(cursor)}`), fixture, 400, 'REQUEST_REJECTED');
      denied(await get(fixture.actors.owner, fixture.otherTenantId, `?cursor=${encodeURIComponent(cursor)}`), fixture, 400, 'REQUEST_REJECTED');
      denied(await get(fixture.actors.owner, fixture.tenantId, '?cursor=tm1.not-json'), fixture, 400, 'REQUEST_REJECTED');
      for (const query of ['?cursor=not-a-cursor', '?limit=101', '?limit=25&limit=25', '?actorUserId=ignored']) {
        denied(await get(fixture.actors.owner, fixture.tenantId, query), fixture, 400, 'REQUEST_REJECTED');
      }
    });

    await proof(t, diagnostic, 'authorized-empty-page-is-not-an-authorization-fallback', async () => {
      const last = fixture.members.at(-1); assert.ok(last);
      const owner = cursorAfter(fixture.actors.owner, fixture.tenantId, last.userId);
      assert.equal(assertPage(await get(fixture.actors.owner, fixture.tenantId, `?cursor=${owner}`), [], fixture), null);
      const viewer = cursorAfter(fixture.actors.viewer, fixture.tenantId, last.userId);
      denied(await get(fixture.actors.viewer, fixture.tenantId, `?cursor=${viewer}`), fixture, 403, 'FORBIDDEN');
    });

    await proof(t, diagnostic, 'same-cookie-next-page-fresh-after-role-revoke-suspend-disable', async () => {
      for (const [actor, change] of [[fixture.actors.rolePage, 'role'], [fixture.actors.revokePage, 'revoke'],
        [fixture.actors.suspendPage, 'suspend'], [fixture.actors.disablePage, 'disable']] as const) {
        diagnostic.caseName = `same-cookie-fresh-after-${change}`; diagnostic.lastHttpStatus = null;
        const cursor = assertPage(await get(actor), fixture.members.slice(0, 25), fixture);
        assert.ok(cursor, 'real authorized actor/cursor before state change required');
        diagnostic.phase = 'fixture-state-change';
        await boundedTransaction(migrator, async tx => {
          const changed = change === 'disable'
            ? await tx.query('UPDATE saas_users SET disabled_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1', [actor])
            : change === 'role'
              ? await tx.query("UPDATE saas_memberships SET role = 'viewer', updated_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2", [fixture.tenantId, actor])
              : await tx.query(`UPDATE saas_memberships SET status = $3,
                revoked_at = CASE WHEN $3 = 'revoked' THEN clock_timestamp() ELSE NULL END,
                updated_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2`,
              [fixture.tenantId, actor, change === 'revoke' ? 'revoked' : 'suspended']);
          assert.equal(changed.rowCount, 1, 'MIG updates only its exact synthetic fixture state row');
        });
        const index = fixture.members.findIndex(member => member.userId === actor);
        assert.ok(index >= 0, 'changed actor belongs to this exact fixture snapshot');
        const member = fixture.members[index]!;
        fixture.members[index] = { ...member, role: change === 'role' ? 'viewer' : member.role,
          status: change === 'revoke' ? 'revoked' : change === 'suspend' ? 'suspended' : change === 'disable' ? 'disabled' : member.status };
        const auth = await http.request('/auth/session', { headers: { cookie: session(actor).cookie } });
        if (change === 'disable') {
          denied(auth, fixture, 401, 'UNAUTHENTICATED');
          denied(await get(actor, fixture.tenantId, `?cursor=${encodeURIComponent(cursor)}`), fixture, 401, 'UNAUTHENTICATED');
          denied(await get(actor), fixture, 401, 'UNAUTHENTICATED');
        } else {
          assert.ok(object(successful(auth, fixture).session).userId === actor, 'membership changes do not fabricate/revoke the user session');
          denied(await get(actor, fixture.tenantId, `?cursor=${encodeURIComponent(cursor)}`), fixture, 403, 'FORBIDDEN');
          denied(await get(actor), fixture, 403, 'FORBIDDEN');
        }
      }
    });

    await proof(t, diagnostic, 'real-public-http-logout-revokes-same-cookie-and-old-cursor', async () => {
      const actor = fixture.actors.logoutPage; const current = session(actor);
      const cursor = assertPage(await get(actor), fixture.members.slice(0, 25), fixture);
      assert.ok(cursor);
      const reply = await http.request('/auth/session', { method: 'DELETE', headers: {
        origin: http.origin(), cookie: `${current.cookie}; ${current.csrfCookie}`, 'x-csrf-token': current.csrfToken,
      } });
      assert.deepEqual(successful(reply, fixture), { loggedOut: true });
      const expired = setCookies(reply);
      assert.equal(expired.length, 2); assert.ok(expired.every(cookie => cookie.includes('Max-Age=0')));
      denied(await http.request('/auth/session', { headers: { cookie: current.cookie } }), fixture, 401, 'UNAUTHENTICATED');
      denied(await get(actor, fixture.tenantId, `?cursor=${encodeURIComponent(cursor)}`), fixture, 401, 'UNAUTHENTICATED');
      denied(await get(actor), fixture, 401, 'UNAUTHENTICATED');
    });

    await proof(t, diagnostic, 'tenant-state-change-rejects-same-real-session-without-empty200', async () => {
      for (const status of ['suspended', 'closed']) {
        diagnostic.caseName = `tenant-state-${status}`; diagnostic.lastHttpStatus = null;
        diagnostic.phase = 'fixture-state-change';
        await boundedTransaction(migrator, async tx => {
          const changed = await tx.query('UPDATE saas_tenants SET status = $2, updated_at = clock_timestamp() WHERE id = $1', [fixture.tenantId, status]);
          assert.equal(changed.rowCount, 1, 'only the exact synthetic tenant changes');
        });
        for (const actor of [fixture.actors.owner, fixture.actors.admin]) denied(await get(actor), fixture, 403, 'FORBIDDEN');
        assert.equal(assertPage(await get(fixture.actors.foreignOwner, fixture.otherTenantId), fixture.otherMembers, fixture), null);
      }
    });

    diagnostic.caseName = 'postflight'; diagnostic.phase = 'postflight'; diagnostic.lastHttpStatus = null;
    assert.equal(http.unexpected(), 0, 'every HTTP request must execute the original handler without outer errors/fallback');
    assert.ok(harness.reads() > 0); assert.equal(harness.locks(), harness.reads());
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    assert.deepEqual(await aclEvidence(control), beforeAcl, 'no ACL expansion or trusted-helper EXECUTE');
    assert.deepEqual((await control.query('SELECT initialized, initialized_at FROM saas_platform_state WHERE singleton = TRUE')).rows,
      initialization.rows, 'HTTP login/directory/fixtures must not reset initialization');
    await migrator.verifySchema();
  } catch (cause) {
    workFailed = true; failureDiagnostic(t, cause, diagnostic); throw safeFailure(cause, diagnostic);
  } finally {
    let httpCleanupFailed = false;
    diagnostic.phase = 'http-cleanup';
    try { await app?.close(); } catch { httpCleanupFailed = true; }
    diagnostic.phase = 'pool-cleanup';
    const closed = await Promise.allSettled(databases.map(database => bounded(database.close(), 5_000)));
    if (!workFailed && (httpCleanupFailed || closed.some(result => result.status === 'rejected'))) {
      diagnostic.caseName = 'cleanup'; diagnostic.phase = httpCleanupFailed ? 'http-cleanup' : 'pool-cleanup'; diagnostic.lastHttpStatus = null;
      failureDiagnostic(t, undefined, diagnostic);
      throw safeFailure(undefined, diagnostic);
    }
    // Retain synthetic rows and execution evidence; never stop an external PG.
  }
});
