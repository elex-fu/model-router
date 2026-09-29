import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import {
  createPlatformAdminAccessService,
  hasPlatformRole,
  type PlatformAdminAccessRequest,
  type PlatformAdminActor,
} from '../../../../src/saas/platform/access/index.js';
import type { PlatformAuthSession } from '../../../../src/saas/platform/auth/types.js';

const COOKIE_NAME = 'mr_platform_admin_session';
const SESSION_TOKEN = 'opaque-session-token';

const SESSION: PlatformAuthSession = {
  id: 'session-id',
  userId: 'user-id',
  createdAt: '2026-09-28T00:00:00.000Z',
  expiresAt: '2026-09-28T08:00:00.000Z',
};

class RecordingDatabase implements SqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: readonly unknown[] = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ sql, values });
    return { rows: this.rows as Row[], rowCount: this.rows.length };
  }
}

function request(cookie?: string): PlatformAdminAccessRequest {
  return { headers: cookie === undefined ? {} : { cookie } };
}

function authService(session: PlatformAuthSession | undefined) {
  const calls: string[] = [];
  return {
    calls,
    service: {
      getSession: async (token: string): Promise<PlatformAuthSession | undefined> => {
        calls.push(token);
        return session;
      },
    },
  };
}

test('requires exactly one well-formed platform-admin session cookie', async () => {
  const database = new RecordingDatabase();
  const auth = authService(SESSION);
  const access = createPlatformAdminAccessService({ authService: auth.service, database });
  const invalidRequests: PlatformAdminAccessRequest[] = [
    request(),
    request('other=value'),
    request(`${COOKIE_NAME}`),
    request(`${COOKIE_NAME}=`),
    request(`${COOKIE_NAME}=%E0%A4%A`),
    request(`${COOKIE_NAME}=one; ${COOKIE_NAME}=two`),
    {
      headers: {
        cookie: [`${COOKIE_NAME}=one`, `${COOKIE_NAME}=two`],
      } as unknown as PlatformAdminAccessRequest['headers'],
    },
  ];

  for (const invalidRequest of invalidRequests) {
    assert.equal(await access.authenticate(invalidRequest), undefined);
  }
  assert.deepEqual(auth.calls, []);
  assert.equal(database.calls.length, 0);
});

test('denies an absent session and a user with no role assignment', async () => {
  const noSessionDatabase = new RecordingDatabase();
  const noSessionAuth = authService(undefined);
  const noSessionAccess = createPlatformAdminAccessService({
    authService: noSessionAuth.service,
    database: noSessionDatabase,
  });
  assert.equal(await noSessionAccess.authenticate(request(`${COOKIE_NAME}=${SESSION_TOKEN}`)), undefined);
  assert.deepEqual(noSessionAuth.calls, [SESSION_TOKEN]);
  assert.equal(noSessionDatabase.calls.length, 0);

  const noRoleDatabase = new RecordingDatabase();
  const noRoleAuth = authService(SESSION);
  const noRoleAccess = createPlatformAdminAccessService({ authService: noRoleAuth.service, database: noRoleDatabase });
  assert.equal(await noRoleAccess.authenticate(request(`${COOKIE_NAME}=${SESSION_TOKEN}`)), undefined);
  assert.equal(noRoleDatabase.calls.length, 1);
});

test('loads current role assignments after validating the session', async () => {
  const database = new RecordingDatabase();
  database.rows = [{ role: 'security' }, { role: 'operations' }];
  const auth = authService(SESSION);
  const access = createPlatformAdminAccessService({ authService: auth.service, database });

  assert.deepEqual(await access.authenticate(request(`${COOKIE_NAME}=${SESSION_TOKEN}`)), {
    userId: SESSION.userId,
    sessionId: SESSION.id,
    roles: ['security', 'operations'],
  });
  assert.deepEqual(auth.calls, [SESSION_TOKEN]);
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0]?.sql ?? '', /SELECT role[\s\S]*saas_platform_role_assignments/);
  assert.deepEqual(database.calls[0]?.values, [SESSION.userId]);
  assert.doesNotMatch(database.calls[0]?.sql ?? '', /opaque-session-token/);
});

test('fails closed when the database returns an unknown role', async () => {
  const database = new RecordingDatabase();
  database.rows = [{ role: 'security' }, { role: 'legacy-admin' }];
  const auth = authService(SESSION);
  const access = createPlatformAdminAccessService({ authService: auth.service, database });

  assert.equal(await access.authenticate(request(`${COOKIE_NAME}=${SESSION_TOKEN}`)), undefined);
});

test('checks assigned roles and gives only superadmin a valid-role override', () => {
  const securityActor: PlatformAdminActor = {
    userId: 'user-id',
    sessionId: 'session-id',
    roles: ['security'],
  };
  assert.equal(hasPlatformRole(securityActor, ['security']), true);
  assert.equal(hasPlatformRole(securityActor, ['finance']), false);
  assert.equal(hasPlatformRole(securityActor, 'security'), true);
  assert.equal(hasPlatformRole({ ...securityActor, roles: [] }, ['security']), false);
  assert.equal(hasPlatformRole(undefined, ['security']), false);

  const superadminActor: PlatformAdminActor = { ...securityActor, roles: ['superadmin'] };
  assert.equal(hasPlatformRole(superadminActor, ['security']), true);
  assert.equal(hasPlatformRole(superadminActor, ['finance', 'operations']), true);
  assert.equal(hasPlatformRole(superadminActor, []), false);

  const unknownActor = { ...securityActor, roles: ['legacy-admin'] } as unknown as PlatformAdminActor;
  assert.equal(hasPlatformRole(unknownActor, ['security']), false);
  assert.equal(hasPlatformRole(superadminActor, ['legacy-admin'] as never), false);
});
