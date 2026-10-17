import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasModelPlazaServeInput } from '../../../src/saas/gateway/model-plaza/endpoint.js';
import {
  createModelPlazaRateLimiter,
  createSaasModelPlazaEndpoint,
} from '../../../src/saas/gateway/model-plaza/endpoint.js';
import type { SaasModelPlazaService } from '../../../src/saas/gateway/model-plaza/service.js';
import type { ModelPlazaAccess, ModelPlazaSettings } from '../../../src/saas/gateway/model-plaza/types.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

function present<T>(value: T | null | undefined, message?: string): T {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

function authenticatedKey(): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalUserId: 'user-1',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-1',
      createdByUserId: 'user-1',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'platform',
      name: 'test-key',
      prefix: 'mr_test',
      modelScopes: ['model'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalKind: 'member',
      principalId: 'user-1',
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'platform',
      modelScopes: ['model'],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
}

function captureService(): {
  service: SaasModelPlazaService;
  accesses: ModelPlazaAccess[];
  settings: ModelPlazaSettings[];
} {
  const accesses: ModelPlazaAccess[] = [];
  const settings: ModelPlazaSettings[] = [];
  const service = {
    async list(input: { readonly access: ModelPlazaAccess; readonly settings: ModelPlazaSettings }) {
      accesses.push(input.access);
      settings.push(input.settings);
      return { description: input.settings.description, groups: [] };
    },
  } as unknown as SaasModelPlazaService;
  return { service, accesses, settings };
}

function enabledSettings(overrides: Partial<ModelPlazaSettings> = {}): ModelPlazaSettings {
  return { enabled: true, requireAuth: false, description: 'Showcase', exclusiveGroupIds: new Set(), ...overrides };
}

function serveInput(overrides: Partial<SaasModelPlazaServeInput> = {}): SaasModelPlazaServeInput {
  return {
    requestId: 'req-1',
    bearerToken: null,
    sessionToken: null,
    clientAddress: '127.0.0.1',
    authenticateProxyKey: async () => null,
    ...overrides,
  };
}

function endpoint(
  options: Parameters<typeof createSaasModelPlazaEndpoint>[0] & { readonly settingsValue?: ModelPlazaSettings },
): ReturnType<typeof createSaasModelPlazaEndpoint> & { settingsValue?: ModelPlazaSettings } {
  const { settingsValue, ...rest } = options;
  const created = createSaasModelPlazaEndpoint({
    ...rest,
    settings: settingsValue === undefined ? undefined : async () => settingsValue,
  });
  return Object.assign(created, { settingsValue });
}

test('disabled settings serve 404 PLAZA_DISABLED before any authentication work', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({ service, settingsValue: { ...enabledSettings(), enabled: false } });
  const result = await port.serve(serveInput({ bearerToken: 'x' }));
  assert.equal(result.status, 404);
  assert.equal((JSON.parse(String(result.body)) as { error: { code: string } }).error.code, 'PLAZA_DISABLED');
  assert.equal(accesses.length, 0);
});

test('proxy key tier: a live Bearer key reaches the service with the key identity and skips the rate limiter', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({
    service,
    settingsValue: enabledSettings(),
    rateLimiter: {
      take: () => {
        throw new Error('proxy-key requests are not rate limited');
      },
    },
  });
  const result = await port.serve(
    serveInput({
      bearerToken: 'proxy-key-secret',
      authenticateProxyKey: async (key) => (key === 'proxy-key-secret' ? authenticatedKey() : null),
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(String(result.body)), { description: 'Showcase', groups: [] });
  assert.equal(present(accesses[0]).tier, 'proxy_key');
  assert.deepEqual(present(accesses[0]).proxyKeyCaller, {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
  });
});

test('a Bearer that is not a proxy key falls through to the session tier (sub2api OptionalJWT semantics)', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({
    service,
    settingsValue: enabledSettings(),
    sessionAuth: { getSession: async (token) => (token === 'session-token' ? { userId: 'user-9' } : null) },
  });
  const result = await port.serve(serveInput({ bearerToken: 'session-token', authenticateProxyKey: async () => null }));
  assert.equal(result.status, 200);
  assert.equal(present(accesses[0]).tier, 'session');
  assert.equal(present(accesses[0]).sessionUserId, 'user-9');
});

test('the session cookie authenticates; invalid and unvalidatable sessions degrade to anonymous', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({
    service,
    settingsValue: enabledSettings(),
    sessionAuth: {
      getSession: async (token) => {
        if (token === 'throws') throw new Error('session storage down');
        return token === 'live' ? { userId: 'user-9' } : null;
      },
    },
  });
  await port.serve(serveInput({ sessionToken: 'live' }));
  assert.equal(present(accesses[0]).tier, 'session');
  await port.serve(serveInput({ sessionToken: 'unknown-token' }));
  assert.equal(
    present(accesses[1]).tier,
    'anonymous',
    'an invalid session token degrades to the least-privileged tier',
  );
  await port.serve(serveInput({ sessionToken: 'throws' }));
  assert.equal(
    present(accesses[2]).tier,
    'anonymous',
    'a session-authority failure degrades to anonymous, never widens',
  );
});

test('require_auth rejects anonymous callers with 401', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({ service, settingsValue: enabledSettings({ requireAuth: true }) });
  const result = await port.serve(serveInput({}));
  assert.equal(result.status, 401);
  assert.equal((JSON.parse(String(result.body)) as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
  assert.equal(accesses.length, 0);
});

test('anonymous callers share a per-address fixed-window budget; the session tier shares it too', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({
    service,
    settingsValue: enabledSettings(),
    rateLimiter: createModelPlazaRateLimiter({ windowMs: 60_000, limit: 2 }),
  });
  assert.equal((await port.serve(serveInput({}))).status, 200);
  assert.equal((await port.serve(serveInput({}))).status, 200);
  const limited = await port.serve(serveInput({}));
  assert.equal(limited.status, 429);
  assert.equal((JSON.parse(String(limited.body)) as { error: { code: string } }).error.code, 'PLAZA_RATE_LIMITED');
  assert.equal(accesses.length, 2);
  // A different address has its own budget.
  assert.equal((await port.serve(serveInput({ clientAddress: '10.0.0.2' }))).status, 200);
});

test('a settings resolution failure fails closed to the disabled defaults', async () => {
  const { service } = captureService();
  const port = endpoint({
    service,
    settings: () => {
      throw new Error('boom');
    },
  });
  const result = await port.serve(serveInput({}));
  assert.equal(result.status, 404);
});

test('a proxy-key authority storage failure fails closed with 503, not anonymous', async () => {
  const { service, accesses } = captureService();
  const port = endpoint({ service, settingsValue: enabledSettings() });
  const result = await port.serve(
    serveInput({
      bearerToken: 'anything',
      authenticateProxyKey: () => {
        throw new Error('key storage down');
      },
    }),
  );
  assert.equal(result.status, 503);
  assert.equal(accesses.length, 0);
});
