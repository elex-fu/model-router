import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { type MediaRequeueCommand, OperationsActionError } from '../../../src/saas/observability/operations-actions.js';
import { createOperationsActionHttpHandler } from '../../../src/saas/observability/operations-actions-http.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

const ACTOR: PlatformAdminActor = {
  userId: 'user-from-session',
  sessionId: 'session-from-session',
  roles: ['operations'],
};
const PATH = '/admin/api/v1/ops/media-tasks/video/accepted-video/requeue';
function harness() {
  const calls: MediaRequeueCommand[] = [];
  let actor: PlatformAdminActor | undefined = ACTOR;
  let fail = false;
  const handler = createOperationsActionHttpHandler({
    publicOrigin: 'https://ops.example.test',
    access: { authenticate: async () => actor },
    authService: { verifyCsrfToken: async (session, csrf) => session === 'session-cookie' && csrf === 'csrf-cookie' },
    operations: {
      async requeueVideo(input) {
        calls.push(input);
        if (fail) throw new OperationsActionError('TASK_STATE_CONFLICT');
        return { status: 'queued', auditEventId: 'audit-one', leaseEpoch: 8, queuedAt: '2026-10-21T01:00:00Z' };
      },
    },
  });
  return {
    calls,
    conflict: () => {
      fail = true;
    },
    async request(
      overrides: {
        path?: string;
        method?: string;
        actor?: PlatformAdminActor;
        anonymous?: boolean;
        headers?: Record<string, string>;
        body?: unknown;
      } = {},
    ) {
      actor = overrides.anonymous ? undefined : (overrides.actor ?? ACTOR);
      const req = {
        url: overrides.path ?? PATH,
        method: overrides.method ?? 'POST',
        headers: {
          host: 'ops.example.test',
          origin: 'https://ops.example.test',
          'content-type': 'application/json',
          cookie: 'mr_platform_admin_session=session-cookie; mr_platform_admin_csrf=csrf-cookie',
          'x-csrf-token': 'csrf-cookie',
          'idempotency-key': 'incident:one',
          ...overrides.headers,
        },
        resume() {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            JSON.stringify(
              overrides.body ?? {
                tenantId: 'tenant-one',
                expectedLeaseEpoch: 7,
                reason: 'Recheck original accepted task',
              },
            ),
          );
        },
      } as unknown as IncomingMessage;
      let status = 0;
      let output = '';
      const res = {
        writeHead(value: number) {
          status = value;
        },
        end(value: string) {
          output = value;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      return { handled, status, body: output ? JSON.parse(output) : undefined };
    },
  };
}

test('media action uses server identity and strict tenant/version/reason body', async () => {
  const h = harness();
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], {
    actorUserId: ACTOR.userId,
    actorSessionId: ACTOR.sessionId,
    tenantId: 'tenant-one',
    taskId: 'accepted-video',
    expectedLeaseEpoch: 7,
    reason: 'Recheck original accepted task',
    idempotencyKey: 'incident:one',
  });
  assert.equal(
    (
      await h.request({
        body: { tenantId: 'tenant-one', expectedLeaseEpoch: 7, reason: 'reason', actorUserId: 'spoofed' },
      })
    ).status,
    400,
  );
  h.conflict();
  assert.equal((await h.request()).status, 409);
});
test('media action requires session, operations role, same origin, CSRF and idempotency key', async () => {
  const h = harness();
  for (const [override, status] of [
    [{ method: 'GET' }, 405],
    [{ anonymous: true }, 401],
    [{ actor: { ...ACTOR, roles: ['support-readonly'] } }, 403],
    [{ headers: { origin: 'https://elsewhere.test' } }, 403],
    [{ headers: { 'x-csrf-token': 'wrong' } }, 403],
    [{ headers: { 'idempotency-key': '' } }, 400],
    [{ path: `${PATH}?tenantId=other` }, 400],
  ] as const) {
    assert.equal((await h.request(override)).status, status);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request({ path: '/admin/api/v1/ops/media-tasks' })).handled, false);
});
