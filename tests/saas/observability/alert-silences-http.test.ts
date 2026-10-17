import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import {
  type AlertSilenceInput,
  type AlertSilenceRecord,
  ObservabilitySilenceValidationError,
} from '../../../src/saas/observability/alert-silences.js';
import {
  type AlertSilencesHttpOptions,
  createAlertSilencesHttpHandler,
} from '../../../src/saas/observability/alert-silences-http.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

/**
 * Batch 5 §5.6 (task #23) — the operator silence CRUD surface. The contract
 * mirrors the composite-routes http.ts shape exactly (the 121 admin surface
 * precedent): POST-only actions, platform session with the operations role,
 * same-origin + CSRF on every write, strict JSON with exact-key allowlists.
 */

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

const SILENCE: AlertSilenceRecord = {
  id: 'c8e2d1ef-0000-4000-8000-00000000000a',
  ruleId: null,
  platform: 'kimi',
  groupId: null,
  region: null,
  until: '2026-10-20T00:00:00.000Z',
  reason: 'maintenance window',
  createdBy: 'platform-user-from-session',
  createdAt: '2026-10-17T00:00:00.000Z',
};

interface ServiceCall {
  readonly action: string;
  readonly input: unknown;
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
  ) => Promise<{ status: number; body: Record<string, unknown>; handled: boolean }>;
  readonly calls: ServiceCall[];
  readonly auditCalls: Array<{ action: string; targetId: string; actorUserId: string }>;
}

function harness(): Harness {
  const calls: ServiceCall[] = [];
  const auditCalls: Array<{ action: string; targetId: string; actorUserId: string }> = [];
  const service = {
    async listSilences(options: { includeExpired?: boolean } = {}) {
      calls.push({ action: 'list', input: options });
      return [SILENCE];
    },
    async createSilence(input: AlertSilenceInput) {
      calls.push({ action: 'create', input });
      if (input.platform === 'conflict') {
        throw new ObservabilitySilenceValidationError('SILENCE_UNTIL_IN_PAST', 'until must be in the future');
      }
      return { ...SILENCE, ...input, createdBy: input.createdBy };
    },
    async deleteSilence(id: string) {
      calls.push({ action: 'delete', input: id });
      return id === SILENCE.id;
    },
  };

  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: AlertSilencesHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    async audit(input) {
      auditCalls.push({ action: input.action, targetId: input.targetId, actorUserId: input.actorUserId });
    },
    publicOrigin: ORIGIN,
  };
  const handler = createAlertSilencesHttpHandler(options);

  return {
    calls,
    auditCalls,
    async request(path, body, overrides = {}) {
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

const PREFIX = '/admin/api/v1/ops/alert-silences';

test('list returns the active silences and defaults includeExpired to false', async () => {
  const { request, calls } = harness();
  const active = await request(`${PREFIX}/list`, {});
  assert.equal(active.status, 200);
  assert.equal(active.handled, true);
  const silences = (active.body.data as { silences: AlertSilenceRecord[] }).silences;
  assert.equal(silences[0]?.platform, 'kimi');
  assert.deepEqual(calls[0]?.input, { includeExpired: false });

  const all = await request(`${PREFIX}/list`, { includeExpired: true });
  assert.equal(all.status, 200);
  assert.deepEqual(calls[1]?.input, { includeExpired: true });

  const invalid = await request(`${PREFIX}/list`, { includeExpired: 'yes' });
  assert.equal(invalid.status, 400);
});

test('create persists a silence with the acting operator as created_by', async () => {
  const { request, calls, auditCalls } = harness();
  const created = await request(`${PREFIX}/create`, {
    platform: 'kimi',
    until: '2026-10-20T00:00:00Z',
    reason: 'maintenance window',
  });
  assert.equal(created.status, 201);
  const silence = (created.body.data as { silence: AlertSilenceRecord }).silence;
  assert.equal(silence.createdBy, 'platform-user-from-session');
  assert.deepEqual(calls[0]?.input, {
    ruleId: null,
    platform: 'kimi',
    groupId: null,
    region: null,
    until: '2026-10-20T00:00:00Z',
    reason: 'maintenance window',
    createdBy: 'platform-user-from-session',
  });
  assert.deepEqual(auditCalls, [
    { action: 'saas_obs_alert_silence.created', targetId: SILENCE.id, actorUserId: 'platform-user-from-session' },
  ]);
});

test('create maps validation failures onto 400 envelopes', async () => {
  const { request } = harness();
  const conflict = await request(`${PREFIX}/create`, {
    platform: 'conflict',
    until: '2026-10-20T00:00:00Z',
  });
  assert.equal(conflict.status, 400);
  assert.equal((conflict.body.error as { code: string }).code, 'SILENCE_UNTIL_IN_PAST');

  const unsupported = await request(`${PREFIX}/create`, {
    platform: 'kimi',
    until: '2026-10-20T00:00:00Z',
    extra: 'field',
  });
  assert.equal(unsupported.status, 400);
});

test('delete removes a silence and 404s an unknown id', async () => {
  const { request, calls, auditCalls } = harness();
  const deleted = await request(`${PREFIX}/delete`, { silenceId: SILENCE.id });
  assert.equal(deleted.status, 200);
  assert.equal(calls[0]?.action, 'delete');
  assert.deepEqual(auditCalls, [
    { action: 'saas_obs_alert_silence.deleted', targetId: SILENCE.id, actorUserId: 'platform-user-from-session' },
  ]);

  const missing = await request(`${PREFIX}/delete`, { silenceId: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal((missing.body.error as { code: string }).code, 'SILENCE_NOT_FOUND');
});

test('the surface enforces method, origin, session, role and CSRF', async () => {
  const { request } = harness();

  const wrongMethod = await request(`${PREFIX}/list`, {}, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);

  const noOrigin = await request(`${PREFIX}/list`, {}, { headers: { origin: '' } });
  assert.equal(noOrigin.status, 403);
  assert.equal((noOrigin.body.error as { code: string }).code, 'ORIGIN_REJECTED');

  const unauthenticated = await request(`${PREFIX}/list`, {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);

  const forbidden = await request(`${PREFIX}/list`, {}, { actor: { ...ACTOR, roles: ['support-readonly'] } });
  assert.equal(forbidden.status, 403);

  const noCsrf = await request(`${PREFIX}/list`, {}, { headers: { 'x-csrf-token': 'wrong' } });
  assert.equal(noCsrf.status, 403);
  assert.equal((noCsrf.body.error as { code: string }).code, 'CSRF_REJECTED');

  const notJson = await request(`${PREFIX}/list`, {}, { headers: { 'content-type': 'text/plain' } });
  assert.equal(notJson.status, 415);
});

test('unrelated paths are not handled', async () => {
  const { request } = harness();
  const other = await request('/admin/api/v1/ops/channel-status', {});
  assert.equal(other.handled, false);
  // Unknown actions under the prefix are passed through (the platform
  // handler's final 404 owns them).
  const unknownAction = await request(`${PREFIX}/unknown`, {});
  assert.equal(unknownAction.handled, false);
});
