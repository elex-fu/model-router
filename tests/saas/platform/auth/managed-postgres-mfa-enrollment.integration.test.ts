import assert, { AssertionError } from 'node:assert/strict';
import { createHash, randomUUID, scryptSync } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CredentialCryptoError, decryptCredential, type CredentialEnvelope, type CredentialKeyProvider,
} from '../../../../src/saas/credentials/crypto.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { PlatformAuthError, type PlatformAuthErrorCode } from '../../../../src/saas/platform/auth/errors.js';
import {
  createPlatformAdminAuthHandler, PLATFORM_ADMIN_AUTH_PREFIX,
  PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_SESSION_COOKIE,
} from '../../../../src/saas/platform/auth/http.js';
import {
  PlatformAdminAuthService, type PlatformMfaEnrollmentIssuanceAudit,
} from '../../../../src/saas/platform/auth/service.js';
import { totpCode } from '../../../../src/saas/platform/auth/totp.js';

// The existing managed PG15/18 gate provisions the schema and these exact
// principals. Never migrate, grant, SET ROLE/search_path, reset bootstrap, or
// clean up immutable evidence here. All fixture data is distinct/disposable.
const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configuredUrls = roleConfig.map(([name]) => process.env[name]?.trim());
const anyConfigured = configuredUrls.some(Boolean);
const PASSWORD = 'managed PG MFA fixture password only';
const KEY_ID = 'managed-pg-mfa-test-only:v1';
const OPERATOR_ID = 'fixture:managed-pg-mfa-operator';
const ISSUER = 'Managed PG MFA Fixture';
const SESSION_TTL = 1800;
const STEP_MS = 30_000;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Exact FIN/054 disposable-target policy; assertion operands never contain URLs. */
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roleConfig.map(([name, role], index) => {
    const value = configuredUrls[index];
    assert.ok(value, `${name} is required for the managed PostgreSQL MFA gate`);
    let parsed: URL;
    let username: string;
    let database: string;
    try {
      parsed = new URL(value);
      username = decodeURIComponent(parsed.username);
      database = decodeURIComponent(parsed.pathname.slice(1));
    } catch { throw new Error(`${name} must be a valid PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), `${name} must be PostgreSQL`);
    assert.ok(username === role, `${name} must use its exact managed role`);
    assert.ok(parsed.search === '', `${name} must not contain connection overrides`);
    assert.ok(parsed.hash === '', `${name} must not contain a fragment`);
    const hostname = parsed.hostname.toLowerCase();
    const port = Number(parsed.port);
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local,
      `${name} must use designated CI postgres:5432/model_router_saas_ci or a disposable model_router_saas_ci/model_router_test_* exact loopback target on an explicit nondefault port`);
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all MFA gate roles must use the same disposable target');
    return value;
  });
}

function safeFailure(cause: unknown): Error {
  if (cause instanceof AssertionError || cause instanceof PlatformAuthError || cause instanceof CredentialCryptoError) return cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return new Error(typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code)
    ? `Managed PostgreSQL MFA operation failed (SQLSTATE ${code}); details redacted.`
    : 'Managed PostgreSQL MFA operation failed; details redacted.');
}
function proof(t: TestContext, name: string, work: () => Promise<void>): Promise<void> {
  return t.test(name, async () => { try { await work(); } catch (cause) { throw safeFailure(cause); } });
}
function authCode(code: PlatformAuthErrorCode, status?: number) {
  return (cause: unknown) => {
    assert.ok(cause instanceof PlatformAuthError, 'expected the safe platform authentication error');
    assert.equal(cause.code, code);
    if (status !== undefined) assert.equal(cause.status, status);
    assert.equal(cause.cause, undefined);
    return true;
  };
}
function sqlState(code: string) {
  return (cause: unknown) => {
    assert.ok(cause && typeof cause === 'object' && 'code' in cause, 'expected a PostgreSQL SQLSTATE');
    assert.ok(cause.code === code, `expected SQLSTATE ${code}; details redacted`);
    return true;
  };
}
function boundedTransaction<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '10s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    return work(tx);
  });
}
function auditContext(reasonCode: PlatformMfaEnrollmentIssuanceAudit['reasonCode'] = 'initial-enrollment'): PlatformMfaEnrollmentIssuanceAudit {
  return { operatorId: OPERATOR_ID, reasonCode, requestId: randomUUID() };
}
function passwordHash(): string {
  const salt = Buffer.alloc(16, 23);
  const hash = scryptSync(PASSWORD, salt, 64, { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
async function seedUser(migrator: SaasDatabase, options: { eligible?: boolean; disabled?: boolean } = {}) {
  const user = { id: randomUUID(), email: `managed-pg-mfa-${randomUUID()}@example.test` };
  // Migrator writes only new fake users and eligible role assignments. It never
  // seeds MFA secrets, enrollment/audit/session rows or initialization facts.
  await boundedTransaction(migrator, async (tx) => {
    await tx.query(
      `INSERT INTO saas_users (id, email, password_hash, disabled_at)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END)`,
      [user.id, user.email, passwordHash(), options.disabled === true]);
    if (options.eligible !== false) await tx.query(
      "INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, 'superadmin')", [user.id]);
  });
  return user;
}

class TestOnlyKeys implements CredentialKeyProvider {
  private readonly key = Buffer.alloc(32, 0x5c);
  encryptionReads = 0;
  decryptionReads = 0;
  getCurrentKey() { this.encryptionReads += 1; return { keyId: KEY_ID, key: Buffer.from(this.key) }; }
  getKey(id: string) { this.decryptionReads += 1; return id === KEY_ID ? Buffer.from(this.key) : undefined; }
  close() { this.key.fill(0); }
}
class Secrets {
  private readonly values = new Set<string>([PASSWORD, Buffer.alloc(32, 0x5c).toString('hex'), Buffer.alloc(32, 0x5c).toString('base64')]);
  remember(value: string) { this.values.add(value); return value; }
  absent(value: unknown) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    assert.ok(typeof serialized === 'string', 'expected inspectable safe metadata');
    for (const secret of this.values) assert.ok(!serialized.includes(secret), 'safe metadata/error response must not contain a fixture credential or token');
  }
}
async function serverNow(database: SaasDatabase): Promise<Date> {
  const live = await database.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = live.rows[0]?.now;
  assert.ok(now instanceof Date && Number.isFinite(now.getTime()), 'real PostgreSQL clock must be available');
  return new Date(now.getTime());
}
async function serviceClock(database: SaasDatabase) {
  const timestamp = (await serverNow(database)).getTime();
  // Use a deterministic step boundary derived from the real server clock. The
  // small future offset keeps SQL clock_timestamp() expiry predicates active;
  // only the existing service clock seam advances, never the database clock.
  let current = Math.ceil(timestamp / STEP_MS) * STEP_MS + 5_000;
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => { current += milliseconds; },
    set: (value: string) => { current = Date.parse(value); assert.ok(Number.isFinite(current), 'fixture expiry must be valid'); },
  };
}
async function waitForPostgresExpiry(database: SaasDatabase, userId: string, kind: 'enrollment' | 'setup'): Promise<string> {
  const sql = kind === 'enrollment'
    ? 'SELECT expires_at <= clock_timestamp() AS expired, clock_timestamp() AS now FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1'
    : 'SELECT expires_at <= clock_timestamp() AS expired, clock_timestamp() AS now FROM saas_platform_mfa_setup_tokens WHERE user_id = $1';
  const until = Date.now() + 3_000;
  do {
    const result = await database.query<{ expired: boolean; now: Date }>(sql, [userId]);
    assert.equal(result.rows.length, 1, 'expiry proof must inspect exactly the intended persisted fixture handoff');
    const row = result.rows[0]!;
    if (row.expired === true) {
      assert.ok(row.now instanceof Date && Number.isFinite(row.now.getTime()), 'PostgreSQL expiry observation must carry a valid server clock');
      return row.now.toISOString();
    }
    await delay(25);
  } while (Date.now() < until);
  throw new Error('the real PostgreSQL handoff deadline did not expire within the bounded fixture window');
}
type Clock = Awaited<ReturnType<typeof serviceClock>>;
function authService(database: SaasDatabase, keys: TestOnlyKeys, clock: Clock) {
  return new PlatformAdminAuthService(database, keys, {
    now: clock.now, enrollmentTokenTtlSeconds: 120, confirmationTokenTtlSeconds: 120, sessionTtlSeconds: SESSION_TTL,
  });
}
function secretFromUri(uri: string, secrets: Secrets): string {
  secrets.remember(uri);
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error('fixture enrollment URI is invalid; details redacted'); }
  assert.ok(parsed.protocol === 'otpauth:' && parsed.hostname === 'totp', 'expected a TOTP enrollment URI');
  const secret = parsed.searchParams.get('secret');
  assert.ok(typeof secret === 'string' && /^[A-Z2-7]{32}$/.test(secret), 'expected a generated test-only TOTP secret');
  return secrets.remember(secret);
}
function freshCode(secret: string, clock: Clock): string {
  // Avoid the rare six-digit collision between neighboring TOTP steps without
  // changing any verification/replay gate or supplying a mocked TOTP code.
  for (let tries = 0; tries < 10; tries += 1) {
    clock.advance(STEP_MS);
    const time = clock.now().getTime();
    const code = totpCode(secret, time);
    if (code !== totpCode(secret, time - STEP_MS) && code !== totpCode(secret, time + STEP_MS)) return code;
  }
  throw new Error('unable to select a distinct deterministic fixture TOTP step');
}

interface AuditRow {
  id: string; tenant_id: string | null; actor_user_id: string | null; action: string;
  target_type: string; target_id: string; entry_point: string; request_id: string; user_agent: string;
}
async function audits(database: SaasDatabase, requestId: string): Promise<AuditRow[]> {
  const rows = await database.query<AuditRow>(
    `SELECT id, tenant_id, actor_user_id, action, target_type, target_id, entry_point, request_id, user_agent
     FROM saas_audit_events WHERE request_id = $1 ORDER BY id`, [requestId]);
  return rows.rows;
}
async function assertAudit(database: SaasDatabase, context: PlatformMfaEnrollmentIssuanceAudit,
  targetId: string, outcome: string, secrets: Secrets, missing = false) {
  const rows = await audits(database, context.requestId);
  assert.equal(rows.length, 1, 'exactly one immutable audit event must commit');
  const row = rows[0]!;
  secrets.absent(rows);
  assert.equal(row.tenant_id, null);
  assert.equal(row.actor_user_id, null, 'an external operator must not be invented as a real platform user');
  assert.equal(row.action, outcome === 'issued' ? 'platform_mfa.enrollment_token.issued' : 'platform_mfa.enrollment_token.denied');
  assert.equal(row.target_type, missing ? 'platform_mfa_enrollment_email_digest' : 'platform_mfa_enrollment_user');
  assert.ok(row.target_id === targetId, 'audit target must identify only the intended fixture');
  assert.equal(row.entry_point, 'trusted_operator_cli:platform_mfa_enroll');
  assert.equal(row.request_id, context.requestId);
  let metadata: unknown;
  try { metadata = JSON.parse(row.user_agent); } catch { throw new Error('operator audit metadata is invalid; details redacted'); }
  assert.deepEqual(metadata, { actor_kind: 'trusted_operator', operator_id: OPERATOR_ID, reason_code: context.reasonCode,
    audience: 'platform', workload_id: 'saas:platform-mfa-enroll', database_role: 'model_router_saas_control_plane', outcome });
  return row;
}
async function counts(database: SaasDatabase, userId: string) {
  const result = await database.query<{ tokens: string; credentials: string; setups: string; sessions: string }>(
    `SELECT (SELECT count(*)::text FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1) AS tokens,
            (SELECT count(*)::text FROM saas_mfa_credentials WHERE user_id = $1) AS credentials,
            (SELECT count(*)::text FROM saas_platform_mfa_setup_tokens WHERE user_id = $1) AS setups,
            (SELECT count(*)::text FROM saas_platform_sessions WHERE user_id = $1) AS sessions`, [userId]);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

interface HttpResult { status: number; headers: IncomingHttpHeaders; body: string }
async function startHttp(service: PlatformAdminAuthService) {
  let handler: ReturnType<typeof createPlatformAdminAuthHandler> = async (_req, res) => {
    res.writeHead(503); res.end(); return true;
  };
  const buckets = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end('fixture HTTP failure; details redacted'); } });
  });
  const close = () => new Promise<void>((resolve, reject) => {
    server.close((cause) => cause ? reject(new Error('fixture HTTP cleanup failed; details redacted')) : resolve());
    server.closeAllConnections();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new Error('fixture HTTP listener failed; details redacted')));
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string', 'fixture HTTP listener must use an ephemeral loopback port');
    const origin = `http://127.0.0.1:${address.port}`;
    handler = createPlatformAdminAuthHandler({ service, publicOrigin: origin, sessionTtlSeconds: SESSION_TTL,
      rateLimiter: { async take(key) {
        assert.ok(/^[0-9a-f]{64}$/.test(key), 'limiter identifiers must be opaque');
        const next = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, next);
        return next > 10 ? 60 : undefined;
      } },
    });
    return {
      close,
      request(method: string, suffix: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
        return new Promise((resolve, reject) => {
          const encoded = body === undefined ? undefined : JSON.stringify(body);
          const req = httpRequest(`${origin}${PLATFORM_ADMIN_AUTH_PREFIX}${suffix}`, {
            method, headers: { origin, ...(encoded === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          }, (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 64 * 1024) req.destroy(new Error('fixture response exceeded its bounded size'));
              else chunks.push(chunk);
            });
            res.on('error', () => reject(new Error('fixture HTTP response failed; details redacted')));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.setTimeout(5_000, () => req.destroy(new Error('fixture HTTP request timed out')));
          req.on('error', () => reject(new Error('fixture HTTP request failed; details redacted')));
          req.end(encoded);
        });
      },
    };
  } catch (cause) { try { await close(); } catch {} throw cause; }
}
function jsonBody(result: HttpResult): Record<string, any> {
  try { return JSON.parse(result.body); } catch { throw new Error('fixture JSON response is invalid; details redacted'); }
}
function httpError(result: HttpResult, status: number, code: string, secrets: Secrets) {
  assert.equal(result.status, status);
  assert.equal(result.headers['cache-control'], 'no-store');
  secrets.absent(result.body);
  const body = jsonBody(result);
  assert.equal(body.error?.code, code);
  assert.ok(body.data === undefined, 'denial/error responses must not return an enrollment or session');
  assert.ok(result.headers['set-cookie'] === undefined, 'denial/error responses must not issue cookies');
}
function cookieToken(result: HttpResult, name: string, secrets: Secrets): string {
  const cookies = result.headers['set-cookie'] ?? [];
  const live = cookies.filter((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`));
  assert.equal(live.length, 1, 'exactly one live cookie per credential must be delivered');
  const cookie = live[0]!;
  assert.ok(cookie.includes('SameSite=Strict') && cookie.includes('Path=/admin/api/v1'), 'session cookie boundary must remain restricted');
  if (name === PLATFORM_ADMIN_SESSION_COOKIE) assert.ok(cookie.includes('HttpOnly'), 'session token must be HttpOnly');
  let value: string;
  try { value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))); }
  catch { throw new Error('fixture cookie is invalid; details redacted'); }
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(value), 'expected an opaque test session credential');
  return secrets.remember(value);
}

/** Only scheduling/receipt seams below; every business query and transaction is PostgreSQL. */
function delegateTransactions(database: SaasDatabase, wrap: (tx: SqlExecutor) => Promise<SqlExecutor> | SqlExecutor): SaasDatabase {
  return {
    query: <Row>(sql: string, values?: readonly unknown[]) => database.query<Row>(sql, values),
    transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => database.transaction(async (tx) => work(await wrap(tx))),
    migrate: () => { throw new Error('the MFA gate must never run migrations'); },
    verifySchema: () => database.verifySchema(), ping: () => database.ping(), close: () => database.close(),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function deadline(wait: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([wait, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function competingIssuances(control: SaasDatabase, keys: TestOnlyKeys, clock: Clock, email: string,
  contexts: readonly PlatformMfaEnrollmentIssuanceAudit[]) {
  const ready = deferred();
  const atPending = deferred();
  const release = deferred();
  const backends = new Set<number>();
  const pendingReaders = new Map<number, number>();
  const observed = delegateTransactions(control, async (tx) => {
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    let backend: number | undefined;
    return { async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (backend === undefined && /^SELECT pg_advisory_xact_lock(?:_shared)?\(/.test(statement)) {
        // The service's SET TRANSACTION / timeout setup must run first. Only
        // observe identity and arrange the contenders before the original fence.
        const identity = await tx.query<{ pid: number; principal: string; session: string }>(
          'SELECT pg_backend_pid() AS pid, current_user AS principal, session_user AS session');
        const row = identity.rows[0]!;
        assert.equal(row.principal, 'model_router_saas_control_plane');
        assert.equal(row.session, 'model_router_saas_control_plane');
        backend = row.pid;
        backends.add(row.pid);
        if (backends.size === 2) ready.resolve();
        await deadline(ready.promise, 'two actual control-plane transactions did not enter the issuance race');
      }
      const result = await tx.query<Row>(sql, values);
      if (/^SELECT id FROM saas_platform_mfa_enrollment_tokens WHERE user_id/.test(statement)) {
        assert.ok(backend !== undefined, 'pending check must remain after the original authorization fence');
        pendingReaders.set(backend, result.rows.length);
        atPending.resolve();
        // Keep the first real pending read open until the peer has either read
        // too, or is demonstrably serialized behind this transaction in PG.
        // No lock or result is fabricated. A shared-fence race must turn red,
        // not pass only because one issuance happened to finish first.
        await deadline(release.promise, 'issuance race was not released after the pending observation');
      }
      return result;
    } };
  });
  const service = authService(observed, keys, clock);
  const attempts = contexts.map((context) => service.issueMfaEnrollmentToken(email, context));
  for (const attempt of attempts) void attempt.catch(() => { ready.resolve(); atPending.resolve(); release.resolve(); });
  let observationFailure: unknown;
  try {
    await deadline(atPending.promise, 'issuance did not reach a real pending check');
    const end = Date.now() + 2_000;
    let observedPeer = false;
    do {
      if (pendingReaders.size === 2) { observedPeer = true; break; }
      const owner = [...pendingReaders.keys()][0];
      const peer = [...backends].find((pid) => pid !== owner);
      if (owner !== undefined && peer !== undefined) {
        const blocked = await control.query<{ serialized: boolean }>(
          'SELECT $1::integer = ANY(pg_catalog.pg_blocking_pids($2::integer)) AS serialized', [owner, peer]);
        if (blocked.rows[0]?.serialized) { observedPeer = true; break; }
      }
      await delay(10);
    } while (Date.now() < end);
    assert.ok(observedPeer, 'the peer must reach the real pending read or block behind the first real backend');
  } catch (cause) { observationFailure = cause; }
  finally { release.resolve(); }
  const results = await Promise.allSettled(attempts);
  if (observationFailure) throw observationFailure;
  assert.equal(backends.size, 2, 'issuance contenders must use distinct PostgreSQL backends');
  return results;
}

test('RUN-01/UI-OPS: real PG15/18 restricted-control-plane MFA issuance audit and enrollment/login proof', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
    ? `offline: set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require the MFA gate` : false,
  timeout: 120_000,
}, async (t) => {
  const urls = safeRoleUrls(); // All three configurations must pass before any pool opens.
  const databases: SaasDatabase[] = [];
  const keys = new TestOnlyKeys();
  const secrets = new Secrets();
  try {
    for (const [index, connectionString] of urls.entries()) databases.push(createSaasDatabase({
      connectionString, max: index === 1 ? 3 : 1,
    }));
    const [migrator, control, gateway] = databases as [SaasDatabase, SaasDatabase, SaasDatabase];
    for (const [index, db] of databases.entries()) {
      const result = await db.query<{
        principal: string; session: string; superuser: boolean; database: string;
        schema: string; path: string; schemas: string[]; version: string;
      }>(`SELECT current_user AS principal, session_user AS session, r.rolsuper AS superuser,
                 current_database() AS database, current_schema() AS schema,
                 current_setting('search_path') AS path, current_schemas(true)::text[] AS schemas,
                 current_setting('server_version_num') AS version
          FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
      assert.equal(result.rows.length, 1);
      const identity = result.rows[0]!;
      assert.ok(identity.principal === roleConfig[index]![1], 'each backend must use its exact configured managed role');
      assert.ok(identity.session === roleConfig[index]![1], 'no runtime role switching is allowed');
      assert.equal(identity.superuser, false);
      assert.ok(identity.database === decodeURIComponent(new URL(urls[0]!).pathname.slice(1)), 'all live backends must use the same guarded disposable database');
      assert.equal(identity.schema, 'model_router_saas');
      assert.equal(identity.path, 'model_router_saas');
      assert.deepEqual(identity.schemas, ['pg_catalog', 'model_router_saas']);
      assert.ok([15, 18].includes(Math.floor(Number(identity.version) / 10_000)), 'MFA gate requires real PG15 or PG18');
    }
    await migrator.verifySchema(); // Dynamic registry/checksums; no fixed migration maximum or historical ledger rewrite.
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    const initialization = await control.query('SELECT initialized, initialized_at FROM saas_platform_state WHERE singleton = TRUE');
    assert.equal(initialization.rows.length, 1);

    await proof(t, 'trusted issuance commits only a digest and operator audit; existing HTTP start/confirm/login/session gates work', async () => {
      const user = await seedUser(migrator);
      const clock = await serviceClock(control);
      const service = authService(control, keys, clock);
      const app = await startHttp(service);
      try {
        httpError(await app.request('POST', '/session', { email: user.email, password: PASSWORD, code: '000000' }),
          401, 'INVALID_CREDENTIALS', secrets);
        httpError(await app.request('POST', '/mfa/enrollment/issue', { email: user.email }), 404, 'NOT_FOUND', secrets);
        assert.deepEqual(await counts(control, user.id), { tokens: '0', credentials: '0', setups: '0', sessions: '0' });

        const context = auditContext();
        const encryptionsBeforeIssue = keys.encryptionReads;
        const enrollment = await service.issueMfaEnrollmentToken(user.email, context);
        secrets.remember(enrollment.token);
        assert.ok(/^[A-Za-z0-9_-]{43}$/.test(enrollment.token), 'trusted issuance must return one opaque challenge');
        assert.equal(enrollment.expiresAt, new Date(clock.now().getTime() + 120_000).toISOString());
        assert.equal(keys.encryptionReads, encryptionsBeforeIssue, 'issuing a challenge must not create a TOTP secret');
        const issuedAudit = await assertAudit(control, context, user.id, 'issued', secrets);
        const tokenRows = await control.query<{ id: string; token_hash: string; consumed_at: Date | null }>(
          'SELECT id, token_hash, consumed_at FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1', [user.id]);
        assert.equal(tokenRows.rows.length, 1);
        assert.ok(tokenRows.rows[0]?.token_hash === digest(enrollment.token), 'PostgreSQL must store only the enrollment token digest');
        assert.equal(tokenRows.rows[0]?.consumed_at, null);
        secrets.absent(tokenRows.rows);
        assert.deepEqual(await counts(control, user.id), { tokens: '1', credentials: '0', setups: '0', sessions: '0' });

        const started = await app.request('POST', '/mfa/enrollment/start', { issuer: ISSUER }, { authorization: `Bearer ${enrollment.token}` });
        assert.equal(started.status, 200);
        assert.equal(started.headers['cache-control'], 'no-store');
        assert.ok(started.headers['set-cookie'] === undefined, 'MFA start must not create a session');
        const setup = jsonBody(started).data;
        assert.ok(setup && typeof setup.otpauthUri === 'string' && typeof setup.confirmationToken === 'string', 'existing start route must return the bounded setup handoff');
        assert.deepEqual(Object.keys(setup).sort(), ['confirmationToken', 'expiresAt', 'otpauthUri']);
        secrets.remember(setup.confirmationToken);
        const secret = secretFromUri(setup.otpauthUri, secrets);
        assert.equal(setup.expiresAt, new Date(clock.now().getTime() + 120_000).toISOString());
        assert.deepEqual(await counts(control, user.id), { tokens: '1', credentials: '1', setups: '1', sessions: '0' });
        const persisted = await control.query<{
          id: string; encrypted_secret: Buffer; verified_at: Date | null; token_hash: string; consumed_at: Date | null;
        }>(`SELECT c.id, c.encrypted_secret, c.verified_at, s.token_hash, s.consumed_at
             FROM saas_mfa_credentials c JOIN saas_platform_mfa_setup_tokens s
               ON s.credential_id = c.id AND s.user_id = c.user_id WHERE c.user_id = $1`, [user.id]);
        assert.equal(persisted.rows.length, 1);
        const pending = persisted.rows[0]!;
        assert.equal(pending.verified_at, null);
        assert.equal(pending.consumed_at, null);
        assert.ok(pending.token_hash === digest(setup.confirmationToken), 'setup handoff must also persist only its digest');
        const envelopeText = pending.encrypted_secret.toString('utf8');
        secrets.absent(envelopeText);
        let envelope: CredentialEnvelope;
        try { envelope = JSON.parse(envelopeText) as CredentialEnvelope; }
        catch { throw new Error('real PostgreSQL TOTP envelope is invalid; details redacted'); }
        assert.equal(envelope.algorithm, 'aes-256-gcm');
        assert.equal(envelope.keyId, KEY_ID);
        const decrypted = await decryptCredential(envelope, { userId: user.id, provider: 'platform-totp', credentialId: pending.id }, keys);
        assert.ok(decrypted === secret, 'real authenticated encryption must round-trip only the intended TOTP secret');
        await assert.rejects(decryptCredential(envelope, { userId: randomUUID(), provider: 'platform-totp', credentialId: pending.id }, keys),
          (cause: unknown) => cause instanceof CredentialCryptoError && cause.code === 'AUTHENTICATION_FAILED');

        httpError(await app.request('POST', '/mfa/enrollment/start', { issuer: ISSUER, token: enrollment.token }),
          401, 'MFA_ENROLLMENT_TOKEN_INVALID', secrets);
        const consumedEnrollment = await control.query<{ consumed: boolean }>(
          'SELECT consumed_at IS NOT NULL AS consumed FROM saas_platform_mfa_enrollment_tokens WHERE id = $1', [tokenRows.rows[0]!.id]);
        assert.equal(consumedEnrollment.rows[0]?.consumed, true);

        const confirmationCode = totpCode(secret, clock.now().getTime());
        const confirmed = await app.request('POST', '/mfa/enrollment/confirm', { code: confirmationCode }, { authorization: `Bearer ${setup.confirmationToken}` });
        assert.equal(confirmed.status, 200);
        secrets.absent(confirmed.body);
        assert.ok(jsonBody(confirmed).data?.confirmed === true, 'confirmation must complete without creating a session');
        assert.ok(confirmed.headers['set-cookie'] === undefined, 'MFA confirmation must not bypass login');
        httpError(await app.request('POST', '/mfa/enrollment/confirm', { confirmationToken: setup.confirmationToken, code: confirmationCode }),
          401, 'MFA_CONFIRMATION_INVALID', secrets);
        httpError(await app.request('POST', '/session', { email: user.email, password: PASSWORD, code: confirmationCode }),
          401, 'INVALID_CREDENTIALS', secrets);
        assert.equal((await counts(control, user.id)).sessions, '0', 'confirmation TOTP replay must not issue a session');

        const loginCode = freshCode(secret, clock);
        httpError(await app.request('POST', '/session', { email: user.email, password: 'incorrect-fixture-password', code: loginCode }),
          401, 'INVALID_CREDENTIALS', secrets);
        httpError(await app.request('POST', '/session', { email: user.email, password: PASSWORD, code: 'not-six-digits' }),
          401, 'INVALID_CREDENTIALS', secrets);
        assert.equal((await counts(control, user.id)).sessions, '0', 'invalid password/MFA must not consume the valid login opportunity or issue a session');
        const attempts = await Promise.all([
          app.request('POST', '/session', { email: user.email, password: PASSWORD, code: loginCode }),
          app.request('POST', '/session', { email: user.email, password: PASSWORD, code: loginCode }),
        ]);
        assert.equal(attempts.filter((result) => result.status === 200).length, 1, 'one TOTP step may issue exactly one login session');
        assert.equal(attempts.filter((result) => result.status === 401).length, 1);
        const login = attempts.find((result) => result.status === 200)!;
        const replay = attempts.find((result) => result.status === 401)!;
        httpError(replay, 401, 'INVALID_CREDENTIALS', secrets);
        const sessionToken = cookieToken(login, PLATFORM_ADMIN_SESSION_COOKIE, secrets);
        const csrfToken = cookieToken(login, PLATFORM_ADMIN_CSRF_COOKIE, secrets);
        assert.ok(!login.body.includes(sessionToken), 'session bearer must be cookie-only, never returned in the JSON body');
        assert.ok(!login.body.includes(secret) && !login.body.includes(PASSWORD), 'login must not disclose TOTP/password secrets');
        const loginData = jsonBody(login).data;
        assert.ok(loginData?.session?.userId === user.id && loginData.csrfToken === csrfToken, 'valid confirmed MFA must produce the intended session/CSRF handoff');
        assert.deepEqual(Object.keys(loginData).sort(), ['csrfToken', 'session']);
        assert.deepEqual(Object.keys(loginData.session).sort(), ['createdAt', 'expiresAt', 'id', 'userId']);
        const sessionRows = await control.query<{ token_hash: string; csrf_token_hash: string; revoked_at: Date | null }>(
          'SELECT token_hash, csrf_token_hash, revoked_at FROM saas_platform_sessions WHERE user_id = $1', [user.id]);
        assert.equal(sessionRows.rows.length, 1);
        assert.ok(sessionRows.rows[0]?.token_hash === digest(sessionToken) && sessionRows.rows[0]?.csrf_token_hash === digest(csrfToken), 'session and CSRF values must persist as digests only');
        secrets.absent(sessionRows.rows);
        const cookies = `${PLATFORM_ADMIN_SESSION_COOKIE}=${sessionToken}; ${PLATFORM_ADMIN_CSRF_COOKIE}=${csrfToken}`;
        const session = await app.request('GET', '/session', undefined, { cookie: cookies });
        assert.equal(session.status, 200);
        secrets.absent(session.body);
        assert.ok(jsonBody(session).data?.session?.userId === user.id, 'authenticated session must resolve to the eligible verified user');
        httpError(await app.request('DELETE', '/session', undefined, { cookie: cookies, 'x-csrf-token': 'incorrect-fixture-csrf' }),
          403, 'CSRF_REJECTED', secrets);
        const afterCsrfDenial = await control.query<{ active: boolean }>(
          'SELECT revoked_at IS NULL AS active FROM saas_platform_sessions WHERE user_id = $1', [user.id]);
        assert.deepEqual(afterCsrfDenial.rows, [{ active: true }], 'failed CSRF must not revoke the real persisted session');
        const logout = await app.request('DELETE', '/session', undefined, { cookie: cookies, 'x-csrf-token': csrfToken });
        assert.equal(logout.status, 200);
        secrets.absent(logout.body);
        assert.ok(jsonBody(logout).data?.loggedOut === true, 'valid CSRF logout must revoke the session');
        httpError(await app.request('GET', '/session', undefined, { cookie: cookies }), 401, 'UNAUTHENTICATED', secrets);
        assert.ok(await service.getSession(sessionToken) === undefined, 'logged-out session bearer must not authenticate');
        assert.equal(await service.verifyCsrfToken(sessionToken, csrfToken), false);

        const beforeDenied = await counts(control, user.id);
        const verifiedContext = auditContext('approved-enrollment');
        await assert.rejects(service.issueMfaEnrollmentToken(user.email, verifiedContext), authCode('MFA_ENROLLMENT_UNAVAILABLE', 409));
        await assertAudit(control, verifiedContext, user.id, 'verified-totp-present', secrets);
        assert.deepEqual(await counts(control, user.id), beforeDenied, 'verified denial must not remint/reset credentials or create another challenge');
        const unchangedSecret = await control.query<{ encrypted_secret: Buffer; verified: boolean; consumed: boolean; step: string }>(
          `SELECT c.encrypted_secret, c.verified_at IS NOT NULL AS verified, s.consumed_at IS NOT NULL AS consumed,
                  c.last_used_step::text AS step FROM saas_mfa_credentials c
             JOIN saas_platform_mfa_setup_tokens s ON s.credential_id = c.id AND s.user_id = c.user_id
           WHERE c.id = $1 AND c.user_id = $2`, [pending.id, user.id]);
        assert.equal(unchangedSecret.rows[0]?.verified, true);
        assert.equal(unchangedSecret.rows[0]?.consumed, true);
        assert.ok(unchangedSecret.rows[0]?.encrypted_secret.equals(pending.encrypted_secret), 'verified enrollment denial must preserve the original encrypted TOTP secret');
        assert.equal(unchangedSecret.rows[0]?.step, String(Math.floor(clock.now().getTime() / STEP_MS)));

        const immutable = await control.query<{ immutable: boolean; can_update: boolean; can_delete: boolean; can_truncate: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'saas_audit_events'::regclass AND tgname = 'saas_audit_events_immutable'
                    AND NOT tgisinternal AND tgenabled IN ('O', 'A')) AS immutable,
                  has_any_column_privilege(current_user, 'saas_audit_events', 'UPDATE') AS can_update,
                  has_table_privilege(current_user, 'saas_audit_events', 'DELETE') AS can_delete,
                  has_table_privilege(current_user, 'saas_audit_events', 'TRUNCATE') AS can_truncate`);
        assert.deepEqual(immutable.rows, [{ immutable: true, can_update: false, can_delete: false, can_truncate: false }]);
        for (const sql of ['UPDATE saas_audit_events SET action = action WHERE id = $1', 'DELETE FROM saas_audit_events WHERE id = $1']) {
          await assert.rejects(boundedTransaction(control, async (tx) => {
            await tx.query(sql, [issuedAudit.id]);
            // Even a regression that permits the attempted mutation must roll
            // back this exact fixture event, never damage other audit evidence.
            throw new Error('restricted control-plane unexpectedly accepted audit mutation');
          }), sqlState('42501'));
        }
        await assertAudit(control, context, user.id, 'issued', secrets);
      } finally { await app.close(); }
    });

    await proof(t, 'ineligible, disabled and missing targets commit denial audits without token issuance', async () => {
      const nonadmin = await seedUser(migrator, { eligible: false });
      const disabled = await seedUser(migrator, { disabled: true });
      for (const user of [nonadmin, disabled]) {
        const service = authService(control, keys, await serviceClock(control));
        const context = auditContext();
        await assert.rejects(service.issueMfaEnrollmentToken(user.email, context), authCode('MFA_ENROLLMENT_UNAVAILABLE', 403));
        await assertAudit(control, context, user.id, 'target-unavailable', secrets);
        assert.ok(await service.login(user.email, PASSWORD, '000000') === undefined, 'ineligible/disabled target must not authenticate');
        assert.deepEqual(await counts(control, user.id), { tokens: '0', credentials: '0', setups: '0', sessions: '0' });
      }
      const missing = `missing-managed-pg-mfa-${randomUUID()}@example.test`;
      const context = auditContext();
      const service = authService(control, keys, await serviceClock(control));
      await assert.rejects(service.issueMfaEnrollmentToken(missing, context), authCode('MFA_ENROLLMENT_UNAVAILABLE', 403));
      const missingAudit = await assertAudit(control, context, digest(missing), 'target-unavailable', secrets, true);
      assert.ok(!JSON.stringify(missingAudit).includes(missing), 'missing target denial must persist a digest, not the raw email');
    });

    await proof(t, 'an existing live challenge denies a second trusted issuance and commits only the pending denial', async () => {
      const user = await seedUser(migrator);
      const service = authService(control, keys, await serviceClock(control));
      const issued = auditContext();
      const enrollment = await service.issueMfaEnrollmentToken(user.email, issued);
      secrets.remember(enrollment.token);
      await assertAudit(control, issued, user.id, 'issued', secrets);
      const denied = auditContext();
      await assert.rejects(service.issueMfaEnrollmentToken(user.email, denied), authCode('MFA_ENROLLMENT_UNAVAILABLE', 409));
      await assertAudit(control, denied, user.id, 'enrollment-pending', secrets);
      const tokenRows = await control.query<{ token_hash: string }>(
        'SELECT token_hash FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1', [user.id]);
      assert.equal(tokenRows.rows.length, 1);
      assert.ok(tokenRows.rows[0]?.token_hash === digest(enrollment.token), 'pending denial must preserve the original and only challenge digest');
      secrets.absent(tokenRows.rows);
      assert.deepEqual(await counts(control, user.id), { tokens: '1', credentials: '0', setups: '0', sessions: '0' });
    });

    await proof(t, 'real token/audit inserts roll back on absent audit receipt or actual PostgreSQL audit failure', async () => {
      for (const fault of ['missing-receipt', 'postgres-error'] as const) {
        const user = await seedUser(migrator);
        const context = auditContext();
        let tokenInserted = false;
        let auditInserted = false;
        let auditAttempts = 0;
        let returnedChallenge = false;
        const failing = delegateTransactions(control, (tx) => ({
          async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
            const statement = sql.replace(/\s+/g, ' ').trim();
            if (statement.startsWith('INSERT INTO saas_audit_events')) {
              auditAttempts += 1;
              if (fault === 'postgres-error') await tx.query('SELECT 1 / 0'); // Real PG 22012; no grants/DDL/trigger bypass.
              const persisted = await tx.query<Row>(sql, values);
              auditInserted = persisted.rowCount === 1 && persisted.rows.length === 1;
              // Only this persistence receipt is lost. Both original INSERTs
              // have executed on the real tx; the service must reject and PG
              // must roll back their physical rows before returning a challenge.
              return { rows: [], rowCount: 0 };
            }
            const result = await tx.query<Row>(sql, values);
            if (statement.startsWith('INSERT INTO saas_platform_mfa_enrollment_tokens')) tokenInserted = result.rowCount === 1;
            return result;
          },
        }));
        const service = authService(failing, keys, await serviceClock(control));
        await assert.rejects(service.issueMfaEnrollmentToken(user.email, context).then((enrollment) => {
          returnedChallenge = true;
          secrets.remember(enrollment.token);
        }), authCode('PLATFORM_AUTH_STORAGE_ERROR', 500));
        assert.equal(tokenInserted, true, 'fault must occur after an actual PostgreSQL token INSERT');
        assert.equal(auditAttempts, 1, 'audit failure must never automatically retry issuance');
        assert.equal(auditInserted, fault === 'missing-receipt');
        assert.equal(returnedChallenge, false);
        assert.deepEqual(await counts(control, user.id), { tokens: '0', credentials: '0', setups: '0', sessions: '0' });
        assert.equal((await audits(control, context.requestId)).length, 0, 'failed issuance transaction must leave no audit or token row');
      }
    });

    await proof(t, 'two actual concurrent issuances yield exactly one token/issuance audit and one committed pending denial', async () => {
      const user = await seedUser(migrator);
      const clock = await serviceClock(control);
      const contexts = [auditContext(), auditContext()] as const;
      const results = await competingIssuances(control, keys, clock, user.email, contexts);
      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const deniedCount = results.filter((result) => result.status === 'rejected').length;
      assert.equal(successCount, 1, 'concurrent issuance must not mint two live challenges');
      assert.equal(deniedCount, 1, 'the losing issuance must be a pending-enrollment denial');
      for (const [index, result] of results.entries()) {
        const context = contexts[index]!;
        if (result.status === 'fulfilled') {
          secrets.remember(result.value.token);
          await assertAudit(control, context, user.id, 'issued', secrets);
          const persisted = await control.query<{ token_hash: string }>(
            'SELECT token_hash FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1', [user.id]);
          assert.equal(persisted.rows.length, 1);
          assert.ok(persisted.rows[0]?.token_hash === digest(result.value.token), 'the sole successful challenge must match the committed digest');
          secrets.absent(persisted.rows);
        } else {
          authCode('MFA_ENROLLMENT_UNAVAILABLE', 409)(result.reason);
          secrets.absent((result.reason as Error).message);
          await assertAudit(control, context, user.id, 'enrollment-pending', secrets);
        }
      }
      assert.deepEqual(await counts(control, user.id), { tokens: '1', credentials: '0', setups: '0', sessions: '0' });
    });

    await proof(t, 'real PostgreSQL enrollment/confirmation deadlines reject without consuming/resetting credentials or creating sessions', async () => {
      const expiredUser = await seedUser(migrator);
      const expiredClock = await serviceClock(control);
      expiredClock.set((await serverNow(control)).toISOString());
      const expiredService = new PlatformAdminAuthService(control, keys, {
        now: expiredClock.now, enrollmentTokenTtlSeconds: 1, confirmationTokenTtlSeconds: 120, sessionTtlSeconds: SESSION_TTL,
      });
      const enrollment = await expiredService.issueMfaEnrollmentToken(expiredUser.email, auditContext());
      secrets.remember(enrollment.token);
      expiredClock.set(await waitForPostgresExpiry(control, expiredUser.id, 'enrollment'));
      await assert.rejects(expiredService.beginMfaEnrollment(enrollment.token, ISSUER), authCode('MFA_ENROLLMENT_TOKEN_INVALID', 401));
      assert.deepEqual(await counts(control, expiredUser.id), { tokens: '1', credentials: '0', setups: '0', sessions: '0' });
      const unconsumed = await control.query<{ consumed: boolean }>(
        'SELECT consumed_at IS NOT NULL AS consumed FROM saas_platform_mfa_enrollment_tokens WHERE user_id = $1', [expiredUser.id]);
      assert.deepEqual(unconsumed.rows, [{ consumed: false }]);

      const setupUser = await seedUser(migrator);
      const setupClock = await serviceClock(control);
      setupClock.set((await serverNow(control)).toISOString());
      const setupService = new PlatformAdminAuthService(control, keys, {
        now: setupClock.now, enrollmentTokenTtlSeconds: 120, confirmationTokenTtlSeconds: 1, sessionTtlSeconds: SESSION_TTL,
      });
      const challenge = await setupService.issueMfaEnrollmentToken(setupUser.email, auditContext());
      secrets.remember(challenge.token);
      const started = await setupService.beginMfaEnrollment(challenge.token, ISSUER);
      secrets.remember(started.confirmationToken);
      const secret = secretFromUri(started.otpauthUri, secrets);
      setupClock.set(await waitForPostgresExpiry(control, setupUser.id, 'setup'));
      await assert.rejects(setupService.confirmMfaEnrollment(started.confirmationToken, totpCode(secret, setupClock.now().getTime())),
        authCode('MFA_CONFIRMATION_INVALID', 401));
      assert.ok(await setupService.login(setupUser.email, PASSWORD, totpCode(secret, setupClock.now().getTime())) === undefined,
        'expired/unverified setup must never authenticate');
      const stillPending = await control.query<{ verified: boolean; revoked: boolean; consumed: boolean; attempts: number }>(
        `SELECT c.verified_at IS NOT NULL AS verified, c.revoked_at IS NOT NULL AS revoked,
                s.consumed_at IS NOT NULL AS consumed, s.attempt_count AS attempts
         FROM saas_mfa_credentials c JOIN saas_platform_mfa_setup_tokens s
           ON s.credential_id = c.id AND s.user_id = c.user_id WHERE c.user_id = $1`, [setupUser.id]);
      assert.deepEqual(stillPending.rows, [{ verified: false, revoked: false, consumed: false, attempts: 0 }]);
      assert.deepEqual(await counts(control, setupUser.id), { tokens: '1', credentials: '1', setups: '1', sessions: '0' });
    });

    const unchanged = await control.query('SELECT initialized, initialized_at FROM saas_platform_state WHERE singleton = TRUE');
    assert.deepEqual(unchanged.rows, initialization.rows, 'MFA handoff must never reset or promote bootstrap initialization');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  } catch (cause) { throw safeFailure(cause); }
  finally {
    keys.close();
    const closed = await Promise.allSettled(databases.map((db) => db.close()));
    assert.ok(closed.every((result) => result.status === 'fulfilled'), 'all managed PostgreSQL fixture pools must close; details redacted');
  }
});
