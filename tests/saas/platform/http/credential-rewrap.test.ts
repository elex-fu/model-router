import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  createPlatformCredentialRewrapHttpHandler,
  type PlatformCredentialRewrapHttpOptions,
} from '../../../../src/saas/platform/credential-rewrap-http.js';
import type { PlatformCredentialRewrapOperations } from '../../../../src/saas/platform/credential-rewrap-operations.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

interface TestResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

function makeHarness(
  actor: PlatformAdminActor | undefined,
  calls: { readonly rewrap: unknown[]; readonly csrf: unknown[] },
) {
  const operations: PlatformCredentialRewrapOperations = {
    async getStatus() {
      return { state: 'ready', credentialVersion: 7, wrappingRevision: 3 };
    },
    async rewrap(input) {
      calls.rewrap.push(input);
      return {
        outcome: 'unknown',
        credentialVersion: input.expectedVersion,
        expectedWrappingRevision: input.expectedWrappingRevision,
        wrappingRevision: null,
        refreshRequired: true,
      };
    },
  };
  const options: PlatformCredentialRewrapHttpOptions = {
    access: { authenticate: async () => actor },
    operations,
    publicOrigin: ORIGIN,
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => {
        calls.csrf.push([sessionToken, csrfToken]);
        return sessionToken === SESSION && csrfToken === CSRF;
      },
    },
  };
  const handler = createPlatformCredentialRewrapHttpHandler(options);

  return {
    async request(
      method: 'GET' | 'POST',
      body?: unknown,
      overrides: Record<string, string> = {},
    ): Promise<TestResponse> {
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        ...(method === 'POST'
          ? {
              origin: ORIGIN,
              cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
              'x-csrf-token': CSRF,
              'content-type': 'application/json',
              'idempotency-key': 'operator-rewrap-op-1',
            }
          : {}),
        ...overrides,
      };
      const bodyText = body === undefined ? undefined : JSON.stringify(body);
      const req = {
        url: '/admin/api/v1/supply/accounts/account-a/credentials/credential-a/rewrap',
        method,
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          if (bodyText !== undefined) yield Buffer.from(bodyText);
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
      assert.equal(await handler(req, res), true);
      return {
        status,
        body: JSON.parse(responseText) as Record<string, unknown>,
        text: responseText,
      };
    },
  };
}

function data(response: TestResponse): Record<string, unknown> {
  assert.ok(response.body.data && typeof response.body.data === 'object');
  return response.body.data as Record<string, unknown>;
}

function errorCode(response: TestResponse): string {
  assert.ok(response.body.error && typeof response.body.error === 'object');
  return (response.body.error as Record<string, unknown>).code as string;
}

test('rewrap HTTP exposes metadata only and takes the actor from the authenticated session', async () => {
  const calls = { rewrap: [] as unknown[], csrf: [] as unknown[] };
  const harness = makeHarness(ACTOR, calls);
  const status = await harness.request('GET');
  assert.equal(status.status, 200);
  assert.deepEqual(data(status), { state: 'ready', credentialVersion: 7, wrappingRevision: 3 });

  const submitted = await harness.request('POST', { expectedVersion: 7, expectedWrappingRevision: 3 });
  assert.equal(submitted.status, 200);
  assert.deepEqual(data(submitted), {
    state: 'unknown',
    credentialVersion: 7,
    expectedWrappingRevision: 3,
    wrappingRevision: null,
    refreshRequired: true,
  });
  assert.deepEqual(calls.rewrap, [
    {
      accountId: 'account-a',
      credentialId: 'credential-a',
      expectedVersion: 7,
      expectedWrappingRevision: 3,
      operationId: 'operator-rewrap-op-1',
      actorUserId: ACTOR.userId,
      sourceIp: '203.0.113.10',
      userAgent: null,
    },
  ]);
  assert.deepEqual(calls.csrf, [[SESSION, CSRF]]);
  assert.doesNotMatch(submitted.text, /ciphertext|secret|provider error|kms-key-secret/i);
});

test('rewrap HTTP rejects client-selected destination keys and non-operator or cross-origin writes', async () => {
  const calls = { rewrap: [] as unknown[], csrf: [] as unknown[] };
  const operator = makeHarness(ACTOR, calls);
  const unsupportedField = await operator.request('POST', {
    expectedVersion: 7,
    expectedWrappingRevision: 3,
    destinationKmsKeyId: 'attacker-selected-key',
  });
  assert.equal(unsupportedField.status, 400);
  assert.equal(errorCode(unsupportedField), 'INVALID_BODY');
  assert.equal(calls.rewrap.length, 0);

  const wrongOrigin = await operator.request(
    'POST',
    { expectedVersion: 7, expectedWrappingRevision: 3 },
    {
      origin: 'https://attacker.test',
    },
  );
  assert.equal(wrongOrigin.status, 403);
  assert.equal(errorCode(wrongOrigin), 'ORIGIN_REJECTED');

  const wrongCsrf = await operator.request(
    'POST',
    { expectedVersion: 7, expectedWrappingRevision: 3 },
    {
      'x-csrf-token': 'attacker-token',
    },
  );
  assert.equal(wrongCsrf.status, 403);
  assert.equal(errorCode(wrongCsrf), 'CSRF_REJECTED');

  const denied = makeHarness({ ...ACTOR, roles: ['security'] }, calls);
  const forbidden = await denied.request('POST', { expectedVersion: 7, expectedWrappingRevision: 3 });
  assert.equal(forbidden.status, 403);
  assert.equal(errorCode(forbidden), 'FORBIDDEN');
  assert.equal(calls.rewrap.length, 0);
});
