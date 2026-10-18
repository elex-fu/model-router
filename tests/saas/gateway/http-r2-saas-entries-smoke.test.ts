import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createSaasGatewayHandler } from '../../../src/saas/gateway/http-handler.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

const NOW = new Date().toISOString();
const caller: AuthenticatedApiKey = {
  metadata: {
    id: 'proxy-key-1',
    tenantId: 't',
    projectId: 'p',
    principalUserId: 'u',
    executionPrincipalType: 'member',
    executionPrincipalId: 'u',
    createdByUserId: 'u',
    rotatedByUserId: null,
    revokedByUserId: null,
    entitlementId: 'e',
    supplyProfileId: 's',
    supplyMode: 'platform',
    name: 'smoke-key',
    prefix: 'mr_test',
    modelScopes: ['gemini-2.5-pro'],
    status: 'active',
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementAuthzVersion: 1,
    supplyProfileAuthzVersion: 1,
  },
  authorization: {
    keyId: 'proxy-key-1',
    tenantId: 't',
    projectId: 'p',
    principalKind: 'member',
    principalId: 'u',
    entitlementId: 'e',
    supplyProfileId: 's',
    supplyMode: 'platform',
    modelScopes: ['gemini-2.5-pro'],
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementAuthzVersion: 1,
    supplyProfileAuthzVersion: 1,
  },
};

test('T03 real-socket smoke: the R2 §7.2 entries answer over a real HTTP listener', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return caller;
      },
    },
    preparation: {
      async prepare() {
        throw new Error('preparation must not run in this smoke');
      },
    },
    dispatch: {
      async dispatch() {
        throw new Error('dispatch must not run in this smoke');
      },
    },
    modelDiscovery: {
      async list() {
        return ['gemini-2.5-pro'];
      },
    },
    countTokensRateLimitPerMinute: 2,
    entryPoint: 't03-smoke',
  });
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('{"error":{"code":"NOT_FOUND"}}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: 'Bearer smoke-key', 'content-type': 'application/json' };
  try {
    // 1. count_tokens: 200 + explicit policy header + estimate body.
    const count = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hello world, count me' }] }),
    });
    assert.equal(count.status, 200);
    assert.equal(count.headers.get('x-model-router-count-policy'), 'local-estimate');
    assert.deepEqual(await count.json(), { input_tokens: 6 });

    // 2. Out-of-scope model: 403 (scope enforcement, never a bypass).
    const outOfScope = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'claude-x', messages: [] }),
    });
    assert.equal(outOfScope.status, 403);

    // 3. Independent rate limit: window budget 2 (one used) -> one more 200, then 429.
    assert.equal(
      (
        await fetch(`${base}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [] }),
        })
      ).status,
      200,
    );
    const limited = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [] }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    // 4. GET /v1beta/models: caller-scoped Gemini ListModels envelope.
    const models = await fetch(`${base}/v1beta/models`, { headers: auth });
    assert.equal(models.status, 200);
    assert.deepEqual(await models.json(), {
      models: [{ name: 'models/gemini-2.5-pro', displayName: 'gemini-2.5-pro' }],
    });

    // 5. compact: fail closed 404 (no declared native-compact supply).
    const compact = await fetch(`${base}/v1/responses/compact`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'gemini-2.5-pro', input: [] }),
    });
    assert.equal(compact.status, 404);
    assert.equal((await compact.json()).error.code, 'CAPABILITY_UNSUPPORTED');

    // 6. Method routing: 405 on wrong methods, 404 on unknown /v1beta paths.
    assert.equal((await fetch(`${base}/v1beta/models/gemini-2.5-pro:generateContent`)).status, 405);
    assert.equal((await fetch(`${base}/v1beta/unknown`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/v1beta/models`, { method: 'POST', headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/v1/messages/count_tokens`)).status, 405);

    // 7. Unauthenticated: 401 without ever reaching admission.
    const unauth = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [] }),
    });
    assert.equal(unauth.status, 401);
    console.log('T03_SMOKE_OK');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
