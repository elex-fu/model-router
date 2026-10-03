import assert from 'node:assert/strict';
import { IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { SafeSession, TenantMemberQuery, TenantRole } from '../../../src/saas/identity/types.js';

const actorId = '10000000-0000-4000-8000-000000000001';
const memberId = '10000000-0000-4000-8000-000000000002';
const disabledId = '10000000-0000-4000-8000-000000000003';
const tenantA = '20000000-0000-4000-8000-000000000001';
const tenantB = '20000000-0000-4000-8000-000000000002';
const origin = 'https://workspace.example.test';
const privateMarker = 'private-email-password-session-key-must-not-leak';
type Membership = { tenantId: string; userId: string; role: TenantRole; status: 'active' | 'suspended' | 'revoked' };

/** SQL-contract unit fixture, not a claim of real PG/ACL verification. */
class DirectoryDatabase implements SaasDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  memberships: Membership[] = [
    { tenantId: tenantA, userId: actorId, role: 'owner', status: 'active' },
    { tenantId: tenantA, userId: memberId, role: 'viewer', status: 'suspended' },
    { tenantId: tenantA, userId: disabledId, role: 'billing', status: 'active' },
    { tenantId: tenantB, userId: memberId, role: 'owner', status: 'active' },
  ];
  tenants = new Map([[tenantA, 'active'], [tenantB, 'active']]);
  disabled = new Set([disabledId]);
  rowsOverride?: Record<string, unknown>[];
  failure?: Error;
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ sql, values });
    const normalized = sql.replace(/\s+/g, ' ').trim();
    assert.match(normalized, /^WITH authorized AS \(/);
    assert.match(normalized, /tenant.id = \$1 AND actor_membership.user_id = \$2/);
    assert.match(normalized, /tenant.status = 'active' AND actor_membership.status = 'active'/);
    assert.match(normalized, /actor.disabled_at IS NULL AND actor_membership.role IN \('owner', 'admin'\)/);
    assert.match(normalized, /member.tenant_id = \$1 AND \(\$3::uuid IS NULL OR member.user_id > \$3::uuid\)/);
    assert.match(normalized, /ORDER BY member.user_id ASC LIMIT \$4/);
    assert.match(normalized, /LEFT JOIN LATERAL/);
    assert.doesNotMatch(normalized, /\b(?:INSERT|UPDATE|DELETE|ALTER|GRANT|CALL|EXECUTE|password_hash|email|session|saas_.*fence)\b/i);
    if (this.failure) throw this.failure;
    if (this.rowsOverride) return { rows: this.rowsOverride as Row[], rowCount: this.rowsOverride.length };
    const [tenantId, userId, after, size] = values;
    assert.equal(typeof size, 'number');
    const actor = this.memberships.find(member => member.tenantId === tenantId && member.userId === userId && member.status === 'active');
    if (!actor || !['owner', 'admin'].includes(actor.role) || this.disabled.has(String(userId)) || this.tenants.get(String(tenantId)) !== 'active') {
      return { rows: [], rowCount: 0 };
    }
    const rows = this.memberships.filter(member => member.tenantId === tenantId && (after === null || member.userId > String(after)))
      .sort((a, b) => a.userId.localeCompare(b.userId)).slice(0, Number(size)).map(member => ({
        actor_role: actor.role, user_id: member.userId, display_name: member.userId === actorId ? 'Current owner' : null,
        role: member.role, status: this.disabled.has(member.userId) ? 'disabled' : member.status,
        email: privateMarker, password_hash: privateMarker, session: privateMarker, key: privateMarker,
      }));
    const result = rows.length ? rows : [{ actor_role: actor.role, user_id: null, display_name: null, role: null, status: null }];
    return { rows: result as Row[], rowCount: result.length };
  }
  async transaction<T>(_work: (tx: SqlExecutor) => Promise<T>): Promise<T> { throw new Error('Directory must not mutate or open a multi-statement authority window'); }
  async migrate(): Promise<void> { throw new Error('Unexpected migration'); }
  async verifySchema(): Promise<void> { throw new Error('Unexpected schema mutation/probe'); }
  async ping(): Promise<void> { throw new Error('Unexpected ping'); }
  async close(): Promise<void> {}
}

function fixture() {
  const database = new DirectoryDatabase();
  return { database, service: new SaasIdentityService(database) };
}

async function expectCode(work: Promise<unknown>, status: number, code: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof SaasIdentityError);
    assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(String(error).includes(privateMarker), false);
    return true;
  });
}

test('directory authorizes and selects a bounded minimal page in one current-tenant statement', async () => {
  const { database, service } = fixture();
  const page = await service.listTenantMembers(actorId, tenantA);
  assert.deepEqual(page, { items: [
    { userId: actorId, displayName: 'Current owner', role: 'owner', status: 'active' },
    { userId: memberId, displayName: null, role: 'viewer', status: 'suspended' },
    { userId: disabledId, displayName: null, role: 'billing', status: 'disabled' },
  ], nextCursor: null });
  assert.equal(database.calls.length, 1);
  assert.deepEqual(database.calls[0]?.values, [tenantA, actorId, null, 26]);
  assert.equal(JSON.stringify(page).includes(privateMarker), false);
  for (const member of page.items) assert.deepEqual(Object.keys(member).sort(), ['displayName', 'role', 'status', 'userId']);
});

test('active admin can read, but no tenant role or status is inherited from another tenant', async () => {
  const { database, service } = fixture();
  const actor = database.memberships[0]!;
  actor.role = 'admin';
  assert.equal((await service.listTenantMembers(actorId, tenantA)).items.length, 3);
  for (const role of ['developer', 'billing', 'viewer'] as const) {
    actor.role = role; await expectCode(service.listTenantMembers(actorId, tenantA), 403, 'TENANT_ACCESS_DENIED');
  }
  actor.role = 'owner';
  await expectCode(service.listTenantMembers(actorId, tenantB), 403, 'TENANT_ACCESS_DENIED');
  assert.deepEqual((await service.listTenantMembers(memberId, tenantB)).items.map(member => [member.userId, member.role]), [[memberId, 'owner']]);
  await expectCode(service.listTenantMembers(memberId, tenantA), 403, 'TENANT_ACCESS_DENIED');
  for (const status of ['suspended', 'revoked'] as const) {
    actor.status = status; await expectCode(service.listTenantMembers(actorId, tenantA), 403, 'TENANT_ACCESS_DENIED');
  }
  actor.status = 'active'; database.disabled.add(actorId);
  await expectCode(service.listTenantMembers(actorId, tenantA), 403, 'TENANT_ACCESS_DENIED');
  database.disabled.delete(actorId); database.tenants.set(tenantA, 'disabled');
  await expectCode(service.listTenantMembers(actorId, tenantA), 403, 'TENANT_ACCESS_DENIED');
});

test('keyset cursor is stable, canonical, actor/tenant scoped and never substitutes for fresh authority', async () => {
  const { database, service } = fixture();
  const first = await service.listTenantMembers(actorId, tenantA, { limit: 1 });
  assert.ok(first.nextCursor?.startsWith('tm1.'));
  const cursor = first.nextCursor;
  assert.ok(cursor);
  const second = await service.listTenantMembers(actorId, tenantA, { limit: 1, cursor });
  assert.deepEqual(second.items.map(member => member.userId), [memberId]);
  assert.ok(second.nextCursor);
  const last = await service.listTenantMembers(actorId, tenantA, { limit: 1, cursor: second.nextCursor });
  assert.deepEqual(last.items.map(member => member.userId), [disabledId]);
  assert.equal(last.nextCursor, null);
  const count = database.calls.length;
  await expectCode(service.listTenantMembers(actorId, tenantB, { cursor }), 400, 'INVALID_INPUT');
  await expectCode(service.listTenantMembers(memberId, tenantA, { cursor }), 400, 'INVALID_INPUT');
  assert.equal(database.calls.length, count);
  database.memberships[0]!.status = 'revoked';
  await expectCode(service.listTenantMembers(actorId, tenantA, { cursor }), 403, 'TENANT_ACCESS_DENIED');
  assert.equal(database.calls.length, count + 1);
});

test('invalid page inputs and noncanonical/overbound cursors are rejected before querying', async () => {
  const { database, service } = fixture();
  const invalid: unknown[] = [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '1' }, { limit: null },
    { cursor: '' }, { cursor: 'tm1.not-json' }, { cursor: null }, { cursor: 'tm1.' + 'a'.repeat(1024) }, { actorUserId: memberId }, null, []];
  for (const input of invalid) await expectCode(service.listTenantMembers(actorId, tenantA, input as TenantMemberQuery), 400, 'INVALID_INPUT');
  await expectCode(service.listTenantMembers('not-a-uuid', tenantA), 400, 'INVALID_INPUT');
  await expectCode(service.listTenantMembers(actorId, 'not-a-uuid'), 400, 'INVALID_INPUT');
  assert.equal(database.calls.length, 0);
  const first = await service.listTenantMembers(actorId, tenantA, { limit: 1 });
  assert.ok(first.nextCursor);
  const json = JSON.parse(Buffer.from(first.nextCursor.slice(4), 'base64url').toString('utf8')) as Record<string, unknown>;
  for (const changed of [{ ...json, version: 2 }, { ...json, userId: 'invalid' }, { ...json, email: privateMarker }]) {
    const cursor = 'tm1.' + Buffer.from(JSON.stringify(changed)).toString('base64url');
    await expectCode(service.listTenantMembers(actorId, tenantA, { cursor }), 400, 'INVALID_INPUT');
  }
  await expectCode(service.listTenantMembers(actorId, tenantA, { cursor: first.nextCursor + '=' }), 400, 'INVALID_INPUT');
  assert.equal(database.calls.length, 1);
  await service.listTenantMembers(actorId, tenantA, { limit: 100 });
  assert.equal(database.calls[1]?.values[3], 101);
});

test('authorized empty page differs from denial; revoked target states remain visible without secrets', async () => {
  const { database, service } = fixture();
  database.memberships[1]!.status = 'revoked';
  assert.equal((await service.listTenantMembers(actorId, tenantA)).items[1]?.status, 'revoked');
  const scopeHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(['tenant-members', actorId, tenantA])).digest('hex');
  const cursor = 'tm1.' + Buffer.from(JSON.stringify({ kind: 'tenant-members', version: 1, scopeHash, userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toString('base64url');
  assert.deepEqual(await service.listTenantMembers(actorId, tenantA, { cursor }), { items: [], nextCursor: null });
});

test('ACL/storage failures and corrupt projections fail closed without raw database error details', async () => {
  const { database, service } = fixture();
  database.failure = Object.assign(new Error(privateMarker), { code: '42501', detail: privateMarker });
  await expectCode(service.listTenantMembers(actorId, tenantA), 500, 'IDENTITY_STORAGE_ERROR');
  database.failure = undefined;
  const row = { actor_role: 'owner', user_id: actorId, display_name: null, role: 'owner', status: 'active' };
  for (const rows of [[{ ...row, role: 'superadmin' }], [{ ...row, status: 'unknown' }], [{ ...row, display_name: 'x'.repeat(121) }],
    [{ ...row, actor_role: 'viewer' }], [row, row], Array.from({ length: 27 }, () => row), [{ ...row, user_id: null }]]) {
    database.rowsOverride = rows;
    await expectCode(service.listTenantMembers(actorId, tenantA), 500, 'IDENTITY_STORAGE_ERROR');
  }
});

class SessionDirectoryService extends SaasIdentityService {
  sessionCalls = 0;
  override async getSession(token: string): Promise<SafeSession | undefined> {
    this.sessionCalls++;
    return token === 'unit-session' ? { userId: actorId, activeTenantId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' } : undefined;
  }
  override async verifyCsrfToken(): Promise<boolean> { throw new Error('Readonly directory must not require CSRF'); }
}

async function invoke(service: SessionDirectoryService, url: string, options: {
  method?: string; authenticated?: boolean; limit?: number; limiterFailure?: boolean;
} = {}) {
  const limiterKeys: string[] = [];
  const handler = createSaasIdentityHandler({ service, publicOrigin: origin, sessionTtlSeconds: 900,
    rateLimiter: { take: async key => { limiterKeys.push(key); if (options.limiterFailure) throw new Error(privateMarker); return options.limit; } },
  });
  const req = new IncomingMessage(new Socket());
  req.method = options.method ?? 'GET'; req.url = url;
  req.headers = options.authenticated === false ? {} : { cookie: 'mr_saas_session=unit-session' };
  let status = 0; let headers: OutgoingHttpHeaders = {}; let body = '';
  const res = {
    destroyed: false, writableEnded: false,
    writeHead(value: number, fields: OutgoingHttpHeaders) { status = value; headers = fields; return res; },
    end(value: string) { body = value; res.writableEnded = true; return res; },
  };
  try {
    const handled = await handler(req, res as unknown as ServerResponse);
    return { handled, status, headers, body, limiterKeys, parsed: body ? JSON.parse(body) as Record<string, unknown> : undefined };
  } finally { req.socket.destroy(); }
}

const memberPath = `/console/api/v1/tenants/${tenantA}/members`;

test('directory GET uses existing authenticated session, no CSRF/body, bounded projection and no-store contract', async () => {
  const database = new DirectoryDatabase(); const service = new SessionDirectoryService(database);
  const response = await invoke(service, memberPath + '?limit=1');
  assert.equal(response.handled, true); assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(service.sessionCalls, 1); assert.equal(database.calls.length, 1);
  const data = response.parsed?.data as { items: Record<string, unknown>[]; nextCursor: string };
  assert.deepEqual(Object.keys(data.items[0]!).sort(), ['displayName', 'role', 'status', 'userId']);
  assert.ok(data.nextCursor.startsWith('tm1.'));
  assert.equal(response.body.includes(privateMarker), false);
  assert.equal(response.body.includes('unit-session'), false);
  assert.equal(response.limiterKeys.length, 1);
  assert.equal(response.limiterKeys[0]?.includes(actorId), false);
  assert.equal(response.limiterKeys[0]?.includes(tenantA), false);
});

test('directory GET safely rejects anonymous, other-tenant and inactive/disabled/low-role actors', async () => {
  const database = new DirectoryDatabase(); const service = new SessionDirectoryService(database);
  assert.equal((await invoke(service, memberPath, { authenticated: false })).status, 401);
  assert.equal(database.calls.length, 0);
  for (const role of ['developer', 'billing', 'viewer'] as const) {
    database.memberships[0]!.role = role;
    const response = await invoke(service, memberPath);
    assert.equal(response.status, 403); assert.equal(response.body.includes(privateMarker), false);
    const error = response.parsed?.error as { code: string; message: string; requestId: string };
    assert.equal(error.code, 'FORBIDDEN'); assert.equal(error.message, 'The operation is not permitted');
    assert.match(error.requestId, /^saas_/);
  }
  database.memberships[0]!.role = 'owner';
  assert.equal((await invoke(service, `/console/api/v1/tenants/${tenantB}/members`)).status, 403);
  database.memberships[0]!.status = 'revoked'; assert.equal((await invoke(service, memberPath)).status, 403);
  database.memberships[0]!.status = 'active'; database.disabled.add(actorId); assert.equal((await invoke(service, memberPath)).status, 403);
});

test('directory rejects duplicate/unknown query inputs and all write methods without changing identity facts', async () => {
  const database = new DirectoryDatabase(); const service = new SessionDirectoryService(database);
  for (const suffix of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?cursor=', '?cursor=tm1.a&cursor=tm1.b', '?userId=' + memberId, '?role=owner', '?limit=1.0']) {
    assert.equal((await invoke(service, memberPath + suffix)).status, 400);
  }
  assert.equal(service.sessionCalls, 0); assert.equal(database.calls.length, 0);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await invoke(service, memberPath, { method });
    assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET');
  }
  assert.equal(database.calls.length, 0);
});

test('directory shared limiter denies before page reads and errors keep the existing safe envelope', async () => {
  const database = new DirectoryDatabase(); const service = new SessionDirectoryService(database);
  const limited = await invoke(service, memberPath, { limit: 7 });
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '7');
  assert.equal((limited.parsed?.error as { code: string }).code, 'RATE_LIMITED');
  const unavailable = await invoke(service, memberPath, { limiterFailure: true });
  assert.equal(unavailable.status, 503); assert.equal(unavailable.body.includes(privateMarker), false);
  assert.equal(database.calls.length, 0);
  database.failure = Object.assign(new Error(privateMarker), { code: '42501' });
  const storage = await invoke(service, memberPath);
  assert.equal(storage.status, 500); assert.equal(storage.body.includes(privateMarker), false);
  assert.equal((storage.parsed?.error as { code: string }).code, 'INTERNAL_ERROR');
});
