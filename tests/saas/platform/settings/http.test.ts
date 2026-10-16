import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { REGISTRATION_SETTINGS_KEYS } from '../../../../src/saas/identity/registration-settings.js';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  createPlatformSettingsHttpHandler,
  type PlatformSettingsHttpOptions,
} from '../../../../src/saas/platform/settings/http.js';
import {
  type PlatformSettingRecord,
  type PlatformSettingsActor,
  PlatformSettingsError,
} from '../../../../src/saas/platform/settings/service.js';

/**
 * F1 platform settings admin API boundary tests, following the codex-oauth
 * http.test.ts harness shape (fake access/auth services, fabricated
 * request/response objects, no server).
 */

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

interface ServiceCall {
  readonly kind: 'set' | 'setSecret' | 'list';
  readonly key?: string;
  readonly value?: unknown;
  readonly secret?: string;
  readonly expectedVersion?: number;
  readonly actor?: PlatformSettingsActor;
}

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: {
      method?: string;
      actor?: PlatformAdminActor | undefined;
      headers?: Record<string, string>;
    },
  ) => Promise<{ readonly status: number; readonly body: Record<string, unknown>; readonly handled: boolean }>;
  readonly calls: ServiceCall[];
  setList(records: readonly PlatformSettingRecord[] | Error): void;
  setSetResult(result: PlatformSettingRecord | Error): void;
}

function harness(): Harness {
  const calls: ServiceCall[] = [];
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  let listResult: readonly PlatformSettingRecord[] | Error = [];
  let setResult: PlatformSettingRecord | Error = {
    key: 'unset',
    secret: false,
    value: undefined,
    version: 1,
    updatedByUserId: null,
    updatedAt: '2026-10-16T00:00:00Z',
    createdAt: '2026-10-16T00:00:00Z',
  };
  const service: PlatformSettingsHttpOptions['service'] = {
    async list() {
      if (listResult instanceof Error) throw listResult;
      return listResult;
    },
    async get() {
      return undefined;
    },
    async set(input) {
      calls.push({ kind: 'set', ...input });
      if (setResult instanceof Error) throw setResult;
      return setResult;
    },
    async setSecret(input) {
      calls.push({ kind: 'setSecret', ...input });
      if (setResult instanceof Error) throw setResult;
      return setResult;
    },
  };
  const options: PlatformSettingsHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    publicOrigin: ORIGIN,
  };
  const handler = createPlatformSettingsHttpHandler(options);

  return {
    calls,
    setList(records) {
      listResult = records;
    },
    setSetResult(result) {
      setResult = result;
    },
    async request(path, body, overrides = {}) {
      currentActor = 'actor' in overrides ? overrides.actor : ACTOR;
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        origin: ORIGIN,
        cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...overrides.headers,
      };
      const bodyText = JSON.stringify(body ?? {});
      const req = {
        url: path,
        method: overrides.method ?? 'PUT',
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          if ((overrides.method ?? 'PUT') !== 'GET') yield Buffer.from(bodyText);
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

const RECORD: PlatformSettingRecord = {
  key: REGISTRATION_SETTINGS_KEYS.mode,
  secret: false,
  value: 'open',
  version: 4,
  updatedByUserId: 'operator-user',
  updatedAt: '2026-10-16T00:00:00Z',
  createdAt: '2026-10-15T00:00:00Z',
};

test('GET lists settings with metadata and redacts sealed rows', async () => {
  const h = harness();
  h.setList([
    RECORD,
    {
      key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
      secret: true,
      value: undefined,
      version: 2,
      updatedByUserId: null,
      updatedAt: '2026-10-16T00:00:00Z',
      createdAt: '2026-10-15T00:00:00Z',
    },
  ]);
  const response = await h.request('/admin/api/v1/platform-settings', undefined, { method: 'GET' });
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const settings = (response.body.data as { settings: Record<string, unknown>[] }).settings;
  assert.equal(settings.length, 2);
  assert.deepEqual(settings[0], {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    secret: false,
    value: 'open',
    version: 4,
    updatedAt: '2026-10-16T00:00:00Z',
    updatedByUserId: 'operator-user',
  });
  assert.deepEqual(settings[1], {
    key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
    secret: true,
    version: 2,
    updatedAt: '2026-10-16T00:00:00Z',
  });
  assert.ok(!('value' in (settings[1] ?? {})), 'sealed rows never carry a value field');
  assert.ok(!JSON.stringify(settings[1]).includes('envelope'), 'sealed rows never carry envelope bytes');
});

test('GET requires authentication and the operations role', async () => {
  const h = harness();
  const anonymous = await h.request('/admin/api/v1/platform-settings', undefined, {
    method: 'GET',
    actor: undefined,
  });
  assert.equal(anonymous.status, 401);
  assert.equal((anonymous.body.error as { code: string }).code, 'UNAUTHENTICATED');
  const viewer: PlatformAdminActor = { ...ACTOR, roles: ['support-readonly'] };
  const forbidden = await h.request('/admin/api/v1/platform-settings', undefined, {
    method: 'GET',
    actor: viewer,
  });
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.body.error as { code: string }).code, 'FORBIDDEN');
});

test('GET enforces same-origin and rejects query strings', async () => {
  const h = harness();
  const crossOrigin = await h.request('/admin/api/v1/platform-settings', undefined, {
    method: 'GET',
    headers: { origin: 'https://evil.test' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((crossOrigin.body.error as { code: string }).code, 'ORIGIN_REJECTED');
  const withQuery = await h.request('/admin/api/v1/platform-settings?x=1', undefined, { method: 'GET' });
  assert.equal(withQuery.status, 400);
  assert.equal((withQuery.body.error as { code: string }).code, 'INVALID_QUERY');
});

test('PUT mutates a plain setting with version CAS and audit context', async () => {
  const h = harness();
  h.setSetResult(RECORD);
  const response = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'open',
    expectedVersion: 3,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    secret: false,
    value: 'open',
    version: 4,
    updatedAt: '2026-10-16T00:00:00Z',
    updatedByUserId: 'operator-user',
  });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call?.kind, 'set');
  assert.equal(call?.key, REGISTRATION_SETTINGS_KEYS.mode);
  assert.equal(call?.value, 'open');
  assert.equal(call?.expectedVersion, 3);
  assert.equal(call?.actor?.actorUserId, ACTOR.userId);
  assert.equal(call?.actor?.sourceIp, '203.0.113.10');
  assert.ok(typeof call?.actor?.requestId === 'string' && call.actor.requestId.length > 0);
});

test('PUT seals secret writes and never echoes the secret', async () => {
  const h = harness();
  h.setSetResult({
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    secret: true,
    value: undefined,
    version: 1,
    updatedByUserId: ACTOR.userId,
    updatedAt: '2026-10-16T00:00:00Z',
    createdAt: '2026-10-16T00:00:00Z',
  });
  const response = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    secret: 'turnstile-secret-value',
    expectedVersion: 0,
  });
  assert.equal(response.status, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.kind, 'setSecret');
  assert.equal(h.calls[0]?.secret, 'turnstile-secret-value');
  assert.ok(!JSON.stringify(response.body).includes('turnstile-secret-value'));
  assert.equal((response.body.data as { secret: boolean }).secret, true);
  assert.equal((response.body.data as { value?: unknown }).value, undefined);
});

test('PUT requires CSRF and rejects malformed bodies fail-closed', async () => {
  const h = harness();
  h.setSetResult(RECORD);
  const noCsrf = await h.request(
    '/admin/api/v1/platform-settings',
    {
      key: REGISTRATION_SETTINGS_KEYS.mode,
      value: 'open',
      expectedVersion: 0,
    },
    { headers: { 'x-csrf-token': '' } },
  );
  assert.equal(noCsrf.status, 403);
  assert.equal((noCsrf.body.error as { code: string }).code, 'CSRF_REJECTED');
  assert.equal(h.calls.length, 0);

  const wrongType = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'open',
    expectedVersion: 'three',
  });
  assert.equal(wrongType.status, 400);
  const unknownField = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'open',
    expectedVersion: 0,
    extra: true,
  });
  assert.equal(unknownField.status, 400);
  assert.equal((unknownField.body.error as { code: string }).code, 'INVALID_BODY');
  assert.equal(h.calls.length, 0, 'no service call for rejected bodies');
});

test('PUT maps service errors to safe status codes', async () => {
  const h = harness();
  h.setSetResult(new PlatformSettingsError('VERSION_CONFLICT', 'stale'));
  const conflict = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'open',
    expectedVersion: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body.error as { code: string }).code, 'VERSION_CONFLICT');

  h.setSetResult(new PlatformSettingsError('INVALID_VALUE', 'bad value'));
  const invalid = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'public',
    expectedVersion: 0,
  });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body.error as { code: string }).code, 'INVALID_SETTINGS_INPUT');

  h.setSetResult(new Error('database exploded'));
  const unavailable = await h.request('/admin/api/v1/platform-settings', {
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'open',
    expectedVersion: 0,
  });
  assert.equal(unavailable.status, 503);
  assert.equal((unavailable.body.error as { code: string }).code, 'PLATFORM_SETTINGS_UNAVAILABLE');
  assert.ok(!JSON.stringify(unavailable.body).includes('database exploded'), 'no internals leak');
});

test('only GET and PUT are served; other paths fall through', async () => {
  const h = harness();
  const post = await h.request('/admin/api/v1/platform-settings', {}, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.handled, true);
  const other = await h.request('/admin/api/v1/platform-settings/other', {}, { method: 'GET' });
  assert.equal(other.handled, false);
});
