import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { FastResolutionInput } from '../../../../src/saas/gateway/fast/resolution.js';
import {
  createFastOutcomePlatformHttpHandler,
  FAST_OUTCOME_PLATFORM_PREFIX,
} from '../../../../src/saas/gateway/fast/resolution-http.js';
import { PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_SESSION_COOKIE } from '../../../../src/saas/platform/auth/http.js';

test('fast resolution HTTP requires operations, exact origin, session CSRF and server-derived actor before invoking writes', async () => {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), roles: ['operations' as const] };
  const tenantId = randomUUID(),
    intentId = randomUUID();
  const seen: FastResolutionInput[] = [];
  let authorized = true,
    csrf = true;
  const handler = createFastOutcomePlatformHttpHandler({
    publicOrigin: 'https://ops.example.test',
    access: { authenticate: async () => (authorized ? actor : undefined) },
    authService: { verifyCsrfToken: async () => csrf },
    operations: {
      listCases: async () => [],
      getCase: async () => null,
      resolve: async (input) => {
        seen.push(input);
        return { resolutionId: randomUUID(), intentId, replayed: false, state: 'pending' };
      },
    },
  });
  const payload = {
    kind: 'non_execution',
    chargeMinorUnits: '0',
    usage: {},
    evidenceReference: 'provider-case:proof',
    evidenceSha256: 'e'.repeat(64),
    supportTicketRef: 'support:case',
    reason: 'Provider attests no execution.',
  };
  const headers = {
    host: 'ops.example.test',
    origin: 'https://ops.example.test',
    'content-type': 'application/json',
    'idempotency-key': 'test-resolution-1',
    cookie: `${PLATFORM_ADMIN_SESSION_COOKIE}=session; ${PLATFORM_ADMIN_CSRF_COOKIE}=csrf`,
    'x-csrf-token': 'csrf',
  };
  async function call(overrides: Record<string, string | undefined> = {}, data: unknown = payload) {
    const request = new PassThrough() as unknown as IncomingMessage;
    request.url = `${FAST_OUTCOME_PLATFORM_PREFIX}/${intentId}/resolve?tenantId=${tenantId}`;
    request.method = 'POST';
    request.headers = { ...headers, ...overrides };
    let status = 0,
      text = '';
    const response = {
      destroyed: false,
      writableEnded: false,
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
        this.writableEnded = true;
      },
    };
    request.push(JSON.stringify(data));
    request.push(null);
    assert.equal(await handler(request, response as unknown as ServerResponse), true);
    return { status, body: JSON.parse(text) };
  }
  assert.equal((await call()).status, 202);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actorUserId, actor.userId);
  assert.equal(seen[0].actorSessionId, actor.sessionId);
  assert.equal((await call({}, { ...payload, actorUserId: randomUUID() })).status, 400);
  assert.equal((await call({ origin: 'https://other.example.test' })).status, 403);
  assert.equal((await call({ 'x-csrf-token': 'wrong' })).status, 403);
  csrf = false;
  assert.equal((await call()).status, 403);
  csrf = true;
  authorized = false;
  assert.equal((await call()).status, 401);
  assert.equal(seen.length, 1, 'no rejected request reaches the financial mutation port');
});
