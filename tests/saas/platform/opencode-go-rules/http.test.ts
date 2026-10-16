import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  createOpencodeGoModelCatalogHttpHandler,
  createOpencodeGoRulesHttpHandler,
  type OpencodeGoModelCatalogHttpOptions,
  type OpencodeGoRulesHttpOptions,
  type OpencodeGoRulesStore,
} from '../../../../src/saas/platform/opencode-go-rules-http.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

interface State {
  authzVersion: number;
  rules: unknown;
}

function fakeStore(initial: Map<string, State> = new Map()): OpencodeGoRulesStore & {
  readonly states: Map<string, State>;
} {
  return {
    states: initial,
    async read(input) {
      const state = initial.get(input.accountId);
      if (!state) return null;
      return { authzVersion: state.authzVersion, rules: state.rules };
    },
    async update(input) {
      const state = initial.get(input.accountId);
      if (!state) return null;
      if (state.authzVersion !== input.expectedAuthzVersion) return null;
      state.authzVersion += 1;
      state.rules = input.rulesJson === null ? null : JSON.parse(input.rulesJson);
      return { authzVersion: state.authzVersion, rules: state.rules };
    },
  };
}

function rulesHarness(store: OpencodeGoRulesStore = fakeStore()) {
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: OpencodeGoRulesHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    store,
    publicOrigin: ORIGIN,
  };
  const handler = createOpencodeGoRulesHttpHandler(options);
  return {
    async request(
      path: string,
      body: unknown,
      overrides: { actor?: PlatformAdminActor | undefined; headers?: Record<string, string>; method?: string } = {},
    ) {
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        origin: ORIGIN,
        cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...overrides.headers,
      };
      currentActor = 'actor' in overrides ? overrides.actor : ACTOR;
      const bodyText = JSON.stringify(body ?? {});
      const req = {
        url: path,
        method: overrides.method ?? 'POST',
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(bodyText);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseText = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number) {
          status = code;
          return res;
        },
        end(value?: unknown) {
          responseText = value === undefined ? '' : String(value);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      return {
        status,
        handled,
        body: responseText === '' ? {} : (JSON.parse(responseText) as Record<string, unknown>),
      };
    },
  };
}

test('read returns the rule table and the authz fence version', async () => {
  const store = fakeStore(
    new Map([['account-1', { authzVersion: 5, rules: [{ pattern: 'grok-*', protocol: 'responses' }] }]]),
  );
  const h = rulesHarness(store);
  const response = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'platform',
    accountId: 'account-1',
  });
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as { authzVersion: number; rules: Array<{ pattern: string }> | null };
  assert.equal(data.authzVersion, 5);
  assert.deepEqual(data.rules, [{ pattern: 'grok-*', protocol: 'responses' }]);
});

test('read reports null rules for the default table', async () => {
  const store = fakeStore(new Map([['account-1', { authzVersion: 1, rules: null }]]));
  const h = rulesHarness(store);
  const response = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'platform',
    accountId: 'account-1',
  });
  assert.equal(response.status, 200);
  assert.equal((response.body.data as { rules: unknown }).rules, null);
});

test('tenant scope requires tenantId; platform scope rejects it', async () => {
  const store = fakeStore(new Map([['account-1', { authzVersion: 1, rules: null }]]));
  const h = rulesHarness(store);
  const missing = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'tenant',
    accountId: 'account-1',
  });
  assert.equal(missing.status, 400);
  const stray = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'platform',
    tenantId: 'tenant-1',
    accountId: 'account-1',
  });
  assert.equal(stray.status, 400);
  const scoped = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'tenant',
    tenantId: 'tenant-1',
    accountId: 'account-1',
  });
  assert.equal(scoped.status, 200);
});

test('unrelated paths fall through to the next handler', async () => {
  const h = rulesHarness();
  for (const path of ['/admin/api/v1/opencode-go-rules/unknown', '/admin/api/v1/opencode-go-rules/', '/healthz']) {
    const response = await h.request(path, {});
    assert.equal(response.handled, false, path);
  }
});

test('update validates strictly, bumps the fence and echoes the new state', async () => {
  const store = fakeStore(new Map([['account-1', { authzVersion: 5, rules: null }]]));
  const h = rulesHarness(store);
  const response = await h.request('/admin/api/v1/opencode-go-rules/update', {
    ownerKind: 'platform',
    accountId: 'account-1',
    expectedAuthzVersion: 5,
    rules: [
      { pattern: 'grok-*', protocol: 'responses' },
      { pattern: 'qwen*', protocol: 'anthropic' },
    ],
  });
  assert.equal(response.status, 200);
  const data = response.body.data as { authzVersion: number; rules: Array<{ pattern: string }> };
  assert.equal(data.authzVersion, 6);
  assert.equal(data.rules.length, 2);
  // Patterns are normalized (trimmed + lowercased) by the validator.
  const normalized = await h.request('/admin/api/v1/opencode-go-rules/update', {
    ownerKind: 'platform',
    accountId: 'account-1',
    expectedAuthzVersion: 6,
    rules: [{ pattern: '  GPT-*  ', protocol: 'responses' }],
  });
  assert.equal(normalized.status, 200);
  assert.deepEqual((normalized.body.data as { rules: Array<{ pattern: string }> }).rules, [
    { pattern: 'gpt-*', protocol: 'responses' },
  ]);
});

test('update clears the override with null rules', async () => {
  const store = fakeStore(
    new Map([['account-1', { authzVersion: 2, rules: [{ pattern: 'gpt-*', protocol: 'responses' }] }]]),
  );
  const h = rulesHarness(store);
  const response = await h.request('/admin/api/v1/opencode-go-rules/update', {
    ownerKind: 'platform',
    accountId: 'account-1',
    expectedAuthzVersion: 2,
    rules: null,
  });
  assert.equal(response.status, 200);
  assert.equal((response.body.data as { rules: unknown }).rules, null);
});

test('stale expectedAuthzVersion is a 409 conflict', async () => {
  const store = fakeStore(new Map([['account-1', { authzVersion: 9, rules: null }]]));
  const h = rulesHarness(store);
  const response = await h.request('/admin/api/v1/opencode-go-rules/update', {
    ownerKind: 'platform',
    accountId: 'account-1',
    expectedAuthzVersion: 8,
    rules: [{ pattern: 'grok-*', protocol: 'responses' }],
  });
  assert.equal(response.status, 409);
  assert.equal((response.body.error as Record<string, unknown>).code, 'VERSION_CONFLICT');
});

test('unknown accounts are a 404, not a conflict', async () => {
  const h = rulesHarness();
  const read = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'platform',
    accountId: 'missing',
  });
  assert.equal(read.status, 404);
  assert.equal((read.body.error as Record<string, unknown>).code, 'ACCOUNT_NOT_FOUND');
  const update = await h.request('/admin/api/v1/opencode-go-rules/update', {
    ownerKind: 'platform',
    accountId: 'missing',
    expectedAuthzVersion: 1,
    rules: null,
  });
  assert.equal(update.status, 404);
});

test('invalid rule tables are rejected with the validator reason', async () => {
  const store = fakeStore(new Map([['account-1', { authzVersion: 1, rules: null }]]));
  const h = rulesHarness(store);
  for (const rules of [
    [{ pattern: 'gpt-*', protocol: 'gopher' }],
    [{ pattern: '', protocol: 'openai' }],
    [{ pattern: 'a*b*', protocol: 'openai' }],
    [
      { pattern: 'gpt-*', protocol: 'openai' },
      { pattern: 'gpt-*', protocol: 'anthropic' },
    ],
    'not-an-array',
  ]) {
    const response = await h.request('/admin/api/v1/opencode-go-rules/update', {
      ownerKind: 'platform',
      accountId: 'account-1',
      expectedAuthzVersion: 1,
      rules,
    });
    assert.equal(response.status, 400, JSON.stringify(rules));
    assert.equal((response.body.error as Record<string, unknown>).code, 'INVALID_OPENCODE_GO_RULES');
  }
});

test('auth, origin, CSRF and body-shape failures fail closed', async () => {
  const store = fakeStore(new Map([['account-1', { authzVersion: 1, rules: null }]]));
  const h = rulesHarness(store);
  const method = await h.request('/admin/api/v1/opencode-go-rules/read', {}, { method: 'GET' });
  assert.equal(method.status, 405);
  const origin = await h.request(
    '/admin/api/v1/opencode-go-rules/read',
    {},
    { headers: { origin: 'https://evil.test' } },
  );
  assert.equal(origin.status, 403);
  assert.equal((origin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');
  const csrf = await h.request('/admin/api/v1/opencode-go-rules/read', {}, { headers: { 'x-csrf-token': 'wrong' } });
  assert.equal(csrf.status, 403);
  const unauthenticated = await h.request('/admin/api/v1/opencode-go-rules/read', {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);
  const viewer: PlatformAdminActor = { ...ACTOR, roles: ['support-readonly'] };
  const forbidden = await h.request('/admin/api/v1/opencode-go-rules/read', {}, { actor: viewer });
  assert.equal(forbidden.status, 403);
  const extraField = await h.request('/admin/api/v1/opencode-go-rules/read', {
    ownerKind: 'platform',
    accountId: 'account-1',
    unexpected: 1,
  });
  assert.equal(extraField.status, 400);
  const contentType = await h.request(
    '/admin/api/v1/opencode-go-rules/read',
    {},
    { headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(contentType.status, 415);
});

test('the model catalog endpoint serves the read-only merged list', async () => {
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: OpencodeGoModelCatalogHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    resolveModels: () => ['grok-4', 'gpt-5', 'qwen3-coder'],
    publicOrigin: ORIGIN,
  };
  const handler = createOpencodeGoModelCatalogHttpHandler(options);
  async function request(
    path: string,
    body: unknown,
    overrides: { actor?: PlatformAdminActor | undefined; headers?: Record<string, string>; method?: string } = {},
  ) {
    const headers: Record<string, string> = {
      host: 'platform-admin.test',
      origin: ORIGIN,
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
      ...overrides.headers,
    };
    currentActor = 'actor' in overrides ? overrides.actor : ACTOR;
    const bodyText = JSON.stringify(body ?? {});
    const req = {
      url: path,
      method: overrides.method ?? 'POST',
      headers,
      destroyed: false,
      socket: { remoteAddress: '203.0.113.10' },
      resume() {
        return req;
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(bodyText);
      },
    } as unknown as IncomingMessage;
    let status = 200;
    let responseText = '';
    let writableEnded = false;
    const res = {
      destroyed: false,
      get writableEnded() {
        return writableEnded;
      },
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(value?: unknown) {
        responseText = value === undefined ? '' : String(value);
        writableEnded = true;
        return res;
      },
    } as unknown as ServerResponse;
    const handled = await handler(req, res);
    return {
      status,
      handled,
      body: responseText === '' ? {} : (JSON.parse(responseText) as Record<string, unknown>),
    };
  }

  const other = await request('/admin/api/v1/opencode-go-models/other', {});
  assert.equal(other.handled, false);
  const ok = await request('/admin/api/v1/opencode-go-models/list', {});
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body.data as { models: string[] }).models, ['grok-4', 'gpt-5', 'qwen3-coder']);
  const unauthenticated = await request('/admin/api/v1/opencode-go-models/list', {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);
  const extraField = await request('/admin/api/v1/opencode-go-models/list', { unexpected: 1 });
  assert.equal(extraField.status, 400);
});
