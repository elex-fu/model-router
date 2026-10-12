import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearPlatformCsrfToken, PlatformApiError, platformClient } from '../../web/src/api/saas-platform-client.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
const originalFetch = globalThis.fetch;
let platformFeature: typeof import('../../web/src/features/saas-platform.tsx');

const USER_ID = '10000000-0000-4000-8000-0000000000b1';
const TENANT_ID = '20000000-0000-4000-8000-0000000000a1';
const TARGET_ID = '30000000-0000-4000-8000-0000000000c2';

const USER = {
  id: USER_ID,
  email: 'customer@example.test',
  displayName: 'Customer One',
  emailVerifiedAt: '2026-02-01T00:00:00.000Z',
  disabledAt: null,
  createdAt: '2026-02-01T00:00:00.000Z',
};

const TENANT = {
  id: TENANT_ID,
  name: 'Alpha',
  slug: 'alpha',
  status: 'active',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
};

const OPERATOR = {
  userId: USER_ID,
  email: 'operator@example.test',
  displayName: null,
  disabledAt: null,
  roles: ['superadmin'],
};

before(async () => {
  reactGlobal.React = React;
  platformFeature = await import('../../web/src/features/saas-platform.tsx');
});

after(() => {
  clearPlatformCsrfToken();
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

afterEach(() => {
  clearPlatformCsrfToken();
  globalThis.fetch = originalFetch;
});

test('governance client sends strict requests and strips poisoned response fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const responses: unknown[] = [
    { session: { userId: 'admin' }, csrfToken: 'csrf-token' },
    { items: [{ ...USER, internalNotes: 'junk', apiKeys: ['sk-secret'] }], nextCursor: null },
    { ok: true },
    { ok: true },
    { ok: true },
    { items: [{ ...TENANT, billingPrivateKey: 'junk' }], nextCursor: null },
    TENANT,
    { ok: true },
    { items: [{ ...OPERATOR, lastLoginIp: '203.0.113.9' }] },
    OPERATOR,
    { ok: true },
    { ok: true },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const data = responses[calls.length - 1];
    return new Response(JSON.stringify({ data }), {
      status: calls.length === 10 ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  const users = await platformClient.listGovernanceUsers({
    limit: 25,
    cursor: 'cursor/1',
    emailContains: 'target@',
    status: 'active',
  });
  await platformClient.setGovernanceUserDisabled(USER_ID, true);
  await platformClient.resetGovernanceUserPassword(USER_ID, 'operator-set-passphrase');
  await platformClient.resetGovernanceUserMfa(USER_ID);
  const tenants = await platformClient.listGovernanceTenants({ slugContains: 'alpha', status: 'active' });
  const suspended = await platformClient.setGovernanceTenantStatus(TENANT_ID, 'suspend');
  await platformClient.takeoverGovernanceTenant(TENANT_ID, TARGET_ID);
  const operators = await platformClient.listGovernanceOperators();
  const created = await platformClient.createGovernanceOperator({
    email: 'new@example.test',
    password: 'initial-passphrase-01',
    role: 'operations',
  });
  await platformClient.grantGovernanceOperatorRole(USER_ID, 'finance');
  await platformClient.revokeGovernanceOperatorRole(USER_ID, 'finance');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/admin/api/v1/auth/session',
      '/admin/api/v1/governance/users?limit=25&cursor=cursor%2F1&emailContains=target%40&status=active',
      `/admin/api/v1/governance/users/${USER_ID}/disable`,
      `/admin/api/v1/governance/users/${USER_ID}/password-reset`,
      `/admin/api/v1/governance/users/${USER_ID}/mfa-reset`,
      '/admin/api/v1/governance/tenants?slugContains=alpha&status=active',
      `/admin/api/v1/governance/tenants/${TENANT_ID}/suspend`,
      `/admin/api/v1/governance/tenants/${TENANT_ID}/takeover`,
      '/admin/api/v1/governance/operators',
      '/admin/api/v1/governance/operators',
      `/admin/api/v1/governance/operators/${USER_ID}/roles`,
      `/admin/api/v1/governance/operators/${USER_ID}/roles/finance`,
    ],
  );

  // CSRF token rides every mutation but never the GETs; DELETE carries no body.
  for (const index of [2, 3, 4, 6, 7, 9, 10]) {
    assert.equal(new Headers(calls[index]?.init.headers).get('x-csrf-token'), 'csrf-token');
    assert.equal(calls[index]?.init.credentials, 'same-origin');
  }
  for (const index of [1, 5, 8]) {
    assert.equal(new Headers(calls[index]?.init.headers).get('x-csrf-token'), null);
  }
  assert.equal(calls[11]?.init.method, 'DELETE');
  assert.equal(calls[11]?.init.body, undefined);

  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {});
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), { password: 'operator-set-passphrase' });
  assert.deepEqual(JSON.parse(String(calls[7]?.init.body)), { targetUserId: TARGET_ID });
  assert.deepEqual(JSON.parse(String(calls[9]?.init.body)), {
    email: 'new@example.test',
    password: 'initial-passphrase-01',
    role: 'operations',
  });
  assert.equal('displayName' in JSON.parse(String(calls[9]?.init.body)), false);
  assert.deepEqual(JSON.parse(String(calls[10]?.init.body)), { role: 'finance' });

  // Unknown server fields never reach the caller's objects.
  const firstUser = users.items[0];
  assert.ok(firstUser);
  const firstTenant = tenants.items[0];
  assert.ok(firstTenant);
  const firstOperator = operators[0];
  assert.ok(firstOperator);
  assert.equal('internalNotes' in firstUser, false);
  assert.equal('apiKeys' in firstUser, false);
  assert.equal('billingPrivateKey' in firstTenant, false);
  assert.equal('lastLoginIp' in firstOperator, false);
  assert.deepEqual(Object.keys(firstUser).sort(), [
    'createdAt',
    'disabledAt',
    'displayName',
    'email',
    'emailVerifiedAt',
    'id',
  ]);
  assert.equal(suspended.status, 'active');
  assert.equal(created.userId, USER_ID);
});

test('governance client fails closed on forbidden fields, malformed rows, and invalid input', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ data: { items: [], nextCursor: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({ data: { items: [{ ...USER, password_hash: 'scrypt$...' }], nextCursor: null } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  await assert.rejects(
    platformClient.listGovernanceUsers(),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { items: [{ ...TENANT, status: 'deleted' }], nextCursor: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    platformClient.listGovernanceTenants(),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { items: [{ ...OPERATOR, roles: ['superadmin', 'superadmin'] }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    platformClient.listGovernanceOperators(),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );

  const beforeInputChecks = fetchCount;
  // Input validation fails synchronously, before any fetch is issued.
  assert.throws(
    () => platformClient.resetGovernanceUserPassword(USER_ID, 'short'),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => platformClient.takeoverGovernanceTenant('not-a-uuid', TARGET_ID),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => platformClient.grantGovernanceOperatorRole(USER_ID, 'owner'),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () =>
      platformClient.createGovernanceOperator({
        email: 'no-at-sign',
        password: 'initial-passphrase-01',
        role: 'operations',
      }),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_INPUT',
  );
  assert.equal(fetchCount, beforeInputChecks);
});

function renderUsersPage(roles: Array<'superadmin' | 'security' | 'operations' | 'support-readonly' | 'finance'>) {
  return renderToStaticMarkup(
    React.createElement(platformFeature.GovernanceUsersPage, {
      me: { kind: 'ready', me: { userId: 'admin-user', roles } },
    }),
  );
}

test('user management page shows write affordances only to superadmin and security', () => {
  for (const roles of [['superadmin'], ['security']] as const) {
    const html = renderUsersPage([...roles]);
    assert.match(html, /用户管理/);
    assert.match(html, /邮箱包含/);
    assert.doesNotMatch(html, /当前角色只读/);
  }
  for (const roles of [['operations'], ['support-readonly'], ['finance']] as const) {
    const html = renderUsersPage([...roles]);
    assert.match(html, /当前角色只读/);
    assert.match(html, /仅对 superadmin 或 security 角色开放/);
    assert.doesNotMatch(html, /重置密码|重置 MFA/);
  }
});

function renderTenantsPage(roles: Array<'superadmin' | 'security' | 'operations' | 'support-readonly' | 'finance'>) {
  return renderToStaticMarkup(
    React.createElement(platformFeature.GovernanceTenantsPage, {
      me: { kind: 'ready', me: { userId: 'admin-user', roles } },
    }),
  );
}

test('tenant lifecycle page gates writes to superadmin and operations', () => {
  for (const roles of [['superadmin'], ['operations']] as const) {
    const html = renderTenantsPage([...roles]);
    assert.match(html, /租户生命周期/);
    assert.match(html, /Slug 包含/);
    assert.match(html, /关闭是终态/);
    assert.doesNotMatch(html, /当前角色只读/);
  }
  for (const roles of [['security'], ['support-readonly'], ['finance']] as const) {
    const html = renderTenantsPage([...roles]);
    assert.match(html, /当前角色只读/);
    assert.doesNotMatch(html, /转移所有权/);
  }
});

test('operator management page is superadmin-only with grant and create forms', () => {
  const superadmin = renderToStaticMarkup(
    React.createElement(platformFeature.GovernanceOperatorsPage, {
      me: { kind: 'ready', me: { userId: 'admin-user', roles: ['superadmin'] } },
    }),
  );
  assert.match(superadmin, /操作员管理/);
  assert.match(superadmin, /授予角色/);
  assert.match(superadmin, /创建操作员/);
  assert.match(superadmin, /初始密码/);
  assert.match(superadmin, /最后一个 superadmin 不能被撤销/);
  assert.doesNotMatch(superadmin, /仅超级管理员/);

  for (const roles of [['security'], ['operations'], ['finance'], ['support-readonly']] as const) {
    const html = renderToStaticMarkup(
      React.createElement(platformFeature.GovernanceOperatorsPage, {
        me: { kind: 'ready', me: { userId: 'admin-user', roles: [...roles] } },
      }),
    );
    assert.match(html, /仅超级管理员/);
    assert.doesNotMatch(html, /<form|授予角色|创建操作员/);
  }
});
