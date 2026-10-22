import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import { createPlatformCredentialValidationRequeueHttpHandler } from '../../../../src/saas/platform/credential-validation-requeue-http.js';
import { PlatformValidationRequeueError } from '../../../../src/saas/platform/credential-validation-requeue-service.js';

const ACTOR: PlatformAdminActor = {
  userId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  roles: ['operations'],
};
const JOB = '10000000-0000-4000-8000-000000000003';
const INPUT = {
  jobId: JOB,
  expectedCredentialVersion: 1,
  expectedCredentialAuthzVersion: 3,
  expectedLeaseGeneration: 0,
  reason: 'Retry after envelope limit repair',
};

function harness(actor: PlatformAdminActor | undefined = ACTOR, conflict = false) {
  const calls: unknown[] = [];
  const handler = createPlatformCredentialValidationRequeueHttpHandler({
    publicOrigin: 'https://platform-admin.test',
    access: { authenticate: async () => actor },
    authService: { verifyCsrfToken: async (session, csrf) => session === 'session' && csrf === 'csrf' },
    operations: {
      async getStatus(inputActor, accountId, credentialId) {
        calls.push({ inputActor, accountId, credentialId });
        return { state: 'ready', jobId: JOB, credentialVersion: 1, credentialAuthzVersion: 3, leaseGeneration: 0 };
      },
      async requeue(inputActor, command) {
        calls.push({ inputActor, command });
        if (conflict) throw new PlatformValidationRequeueError('STATE_CONFLICT');
        return {
          outcome: 'queued',
          jobId: JOB,
          credentialVersion: 1,
          leaseGeneration: 1,
          auditEventId: 'audit',
          recordedAt: '2026-10-21T00:00:00Z',
          replayed: false,
        };
      },
    },
  });
  return {
    calls,
    async request(
      method = 'POST',
      body: unknown = INPUT,
      headers: Record<string, string> = {},
      path = '/admin/api/v1/supply/accounts/account-a/credentials/credential-a/validation-requeue',
    ) {
      const req = {
        url: path,
        method,
        headers: {
          host: 'platform-admin.test',
          origin: 'https://platform-admin.test',
          cookie: 'mr_platform_admin_session=session; mr_platform_admin_csrf=csrf',
          'x-csrf-token': 'csrf',
          'content-type': 'application/json',
          'idempotency-key': 'operation-a',
          ...headers,
        },
        resume() {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(body));
        },
      } as unknown as IncomingMessage;
      let status = 0;
      let output = '';
      const res = {
        destroyed: false,
        writableEnded: false,
        writeHead(code: number) {
          status = code;
          return res;
        },
        end(value: unknown) {
          output = String(value);
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      return { handled, status, body: output ? JSON.parse(output) : null, output };
    },
  };
}

test('retry HTTP binds account, credential and actor at the trusted boundary and exposes only metadata', async () => {
  const fixture = harness();
  const metadata = await fixture.request('GET');
  assert.equal(metadata.status, 200);
  const result = await fixture.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.data.outcome, 'queued');
  const call = fixture.calls[1] as { inputActor: PlatformAdminActor; command: Record<string, unknown> };
  assert.deepEqual(call.inputActor, ACTOR);
  assert.deepEqual(
    { ...call.command, requestId: 'generated' },
    {
      accountId: 'account-a',
      credentialId: 'credential-a',
      ...INPUT,
      idempotencyKey: 'operation-a',
      requestId: 'generated',
    },
  );
  assert.doesNotMatch(result.output, /reason|actor_session|signature|ciphertext|token/i);
});

test('retry HTTP enforces current role, same origin, CSRF and bounded exact input', async () => {
  for (const actor of [
    { ...ACTOR, roles: ['support-readonly'] as const },
    { ...ACTOR, roles: ['finance'] as const },
  ]) {
    const fixture = harness(actor);
    assert.equal((await fixture.request()).status, 403);
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = harness();
  for (const headers of [
    { origin: 'https://other.test' },
    { 'x-csrf-token': 'bad' },
    { cookie: 'mr_platform_admin_session=session' },
  ])
    assert.equal((await fixture.request('POST', INPUT, headers)).status, 403);
  assert.equal((await fixture.request('POST', { ...INPUT, actorUserId: 'forged' })).status, 400);
  assert.equal((await fixture.request('POST', INPUT, { 'content-length': '9999999' })).status, 413);
  assert.equal(fixture.calls.length, 0);
});

test('retry HTTP reports stale revisions as a refreshable conflict and leaves unrelated routes alone', async () => {
  const fixture = harness(ACTOR, true);
  const conflict = await fixture.request();
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'STATE_CONFLICT');
  assert.equal((await fixture.request('POST', INPUT, {}, '/admin/api/v1/other')).handled, false);
});
