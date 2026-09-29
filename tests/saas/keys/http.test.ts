import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { createSaasKeyHandler } from '../../../src/saas/keys/http.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import type { ApiKeyMetadata, CreateApiKeyInput, CreatedApiKey } from '../../../src/saas/keys/types.js';

const SESSION_COOKIE = 'mr_saas_session=session-token';
const CSRF_COOKIE = 'mr_saas_csrf=csrf-token';
const CSRF_TOKEN = 'csrf-token';

type KeyHttpService = {
  create(context: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey>;
  list(context: TenantContext): Promise<ApiKeyMetadata[]>;
  rotate(context: TenantContext, keyId: string): Promise<CreatedApiKey>;
  revoke(context: TenantContext, keyId: string): Promise<ApiKeyMetadata>;
};

const baseContext: TenantContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  tenantRole: 'owner',
  projectRole: 'owner',
};

function keyMetadata(id: string, overrides: Partial<ApiKeyMetadata> = {}): ApiKeyMetadata {
  return {
    id,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    principalUserId: 'user-1',
    executionPrincipalType: 'member',
    executionPrincipalId: 'user-1',
    createdByUserId: 'user-1',
    rotatedByUserId: null,
    revokedByUserId: null,
    entitlementId: 'entitlement-1',
    supplyProfileId: 'server-profile',
    supplyMode: 'platform',
    name: 'Console key',
    prefix: `mr_live_${id}`,
    modelScopes: ['model-a'],
    status: 'active',
    createdAt: '2026-09-28T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementAuthzVersion: 1,
    supplyProfileAuthzVersion: 1,
    ...overrides,
  };
}

function errorWithStatus(status: number): Error & { status: number } {
  return Object.assign(new Error('rejected'), { status });
}

function makeHarness(options: { role?: TenantContext['tenantRole']; keyService?: unknown } = {}) {
  const calls = {
    authorize: [] as Array<Record<string, string>>,
    create: [] as Array<{ context: TenantContext; input: CreateApiKeyInput }>,
    list: 0,
    rotate: [] as string[],
    revoke: [] as string[],
  };
  const rows = new Map<string, ApiKeyMetadata>();
  const context = { ...baseContext, tenantRole: options.role ?? 'owner' };
  let secretNumber = 0;

  const assertManagementRole = (candidate: TenantContext) => {
    if (
      !['owner', 'admin', 'developer'].includes(candidate.tenantRole) ||
      !['owner', 'admin', 'developer'].includes(candidate.projectRole)
    ) {
      throw errorWithStatus(403);
    }
  };

  const defaultKeyService: KeyHttpService = {
    async create(candidate, input) {
      assertManagementRole(candidate);
      calls.create.push({ context: candidate, input });
      const id = `key-${rows.size + 1}`;
      const principalKind = input.principalKind ?? 'member';
      const metadata = keyMetadata(id, {
        projectId: candidate.projectId,
        principalUserId: principalKind === 'member' ? candidate.userId : null,
        executionPrincipalType: principalKind,
        executionPrincipalId: principalKind === 'member' ? candidate.userId : candidate.projectId,
        createdByUserId: candidate.userId,
      });
      rows.set(id, metadata);
      secretNumber += 1;
      return { ...metadata, secret: `mr_live_create_${secretNumber}` };
    },
    async list(candidate) {
      assertManagementRole(candidate);
      calls.list += 1;
      return [...rows.values()];
    },
    async rotate(candidate, keyId) {
      assertManagementRole(candidate);
      calls.rotate.push(keyId);
      const current = rows.get(keyId);
      if (!current) throw errorWithStatus(404);
      if (current.status === 'revoked') throw Object.assign(errorWithStatus(409), { code: 'KEY_ALREADY_REVOKED' });
      rows.set(keyId, { ...current, status: 'revoked', revokedAt: '2026-09-28T00:01:00.000Z', authzVersion: 2 });
      const replacement = keyMetadata(`key-${rows.size + 1}`, {
        projectId: candidate.projectId,
        principalUserId: current.principalUserId,
        executionPrincipalType: current.executionPrincipalType,
        executionPrincipalId: current.executionPrincipalId,
        createdByUserId: candidate.userId,
      });
      rows.set(replacement.id, replacement);
      secretNumber += 1;
      return { ...replacement, secret: `mr_live_rotate_${secretNumber}` };
    },
    async revoke(candidate, keyId) {
      assertManagementRole(candidate);
      calls.revoke.push(keyId);
      const current = rows.get(keyId);
      if (!current) throw errorWithStatus(404);
      const revoked = {
        ...current,
        status: 'revoked' as const,
        revokedAt: '2026-09-28T00:02:00.000Z',
        authzVersion: 2,
      };
      rows.set(keyId, revoked);
      return revoked;
    },
  };

  const identity = {
    async getSession(token: string) {
      return token === 'session-token' ? { userId: 'user-1' } : undefined;
    },
    async verifyCsrfToken(token: string, csrf: string) {
      return token === 'session-token' && csrf === CSRF_TOKEN;
    },
    async authorizeProjectAccess(input: { userId: string; tenantId: string; projectId: string }) {
      calls.authorize.push(input);
      if (input.userId !== 'user-1' || input.tenantId !== 'tenant-1' || input.projectId !== 'project-1') {
        throw errorWithStatus(404);
      }
      return context;
    },
  };

  return {
    identity,
    keyService: (options.keyService as KeyHttpService | undefined) ?? defaultKeyService,
    calls,
    context,
  };
}

async function startHarness(options: Parameters<typeof makeHarness>[0] = {}) {
  const harness = makeHarness(options);
  let handler: ReturnType<typeof createSaasKeyHandler>;
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  handler = createSaasKeyHandler({
    service: harness.identity as never,
    keyService: harness.keyService as never,
    publicOrigin: origin,
    sessionTtlSeconds: 900,
  });
  return {
    ...harness,
    origin,
    base: `${origin}/console/api/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

type JsonObject = Record<string, unknown>;

async function body(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function objectValue(value: unknown): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}

function dataObject(value: JsonObject): JsonObject {
  return objectValue(value.data);
}

function dataArray(value: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(value.data));
  return value.data.map(objectValue);
}

function errorCode(value: JsonObject): string {
  return String(objectValue(value.error).code);
}

function authHeaders(withCsrf = true): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}; ${CSRF_COOKIE}`,
    origin: 'http://127.0.0.1',
    ...(withCsrf ? { 'x-csrf-token': CSRF_TOKEN } : {}),
  };
}

test('key routes fail closed for anonymous, invalid session, origin, and CSRF requests', async () => {
  const app = await startHarness();
  try {
    const anonymous = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`);
    assert.equal(anonymous.status, 401);

    const invalidSession = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      headers: { cookie: 'mr_saas_session=invalid' },
    });
    assert.equal(invalidSession.status, 401);

    const noOrigin = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key', modelScopes: ['model-a'] }),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(errorCode(await body(noOrigin)), 'ORIGIN_REJECTED');

    const wrongOrigin = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: 'http://other.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key', modelScopes: ['model-a'] }),
    });
    assert.equal(wrongOrigin.status, 403);

    const noCsrf = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(false), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key', modelScopes: ['model-a'] }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(errorCode(await body(noCsrf)), 'CSRF_REJECTED');
    assert.equal(app.calls.create.length, 0);
  } finally {
    await app.close();
  }
});

test('key routes authorize the cookie user and reject cross-tenant/project selectors and roles', async () => {
  const app = await startHarness();
  try {
    const crossTenant = await fetch(`${app.base}/tenants/tenant-2/projects/project-1/keys`, {
      headers: { cookie: SESSION_COOKIE },
    });
    assert.equal(crossTenant.status, 404);
    const crossProject = await fetch(`${app.base}/tenants/tenant-1/projects/project-2/keys`, {
      headers: { cookie: SESSION_COOKIE },
    });
    assert.equal(crossProject.status, 404);
    assert.deepEqual(app.calls.authorize, [
      { userId: 'user-1', tenantId: 'tenant-2', projectId: 'project-1' },
      { userId: 'user-1', tenantId: 'tenant-1', projectId: 'project-2' },
    ]);
  } finally {
    await app.close();
  }

  const viewer = await startHarness({ role: 'viewer' });
  try {
    const denied = await fetch(`${viewer.base}/tenants/tenant-1/projects/project-1/keys`, {
      headers: { cookie: SESSION_COOKIE },
    });
    assert.equal(denied.status, 403);
    assert.equal(viewer.calls.list, 0);
  } finally {
    await viewer.close();
  }
});

test('create is strict, returns a secret once, and list/revoke expose only safe key metadata', async () => {
  const app = await startHarness();
  try {
    const missingMode = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key', modelScopes: ['model-a'] }),
    });
    assert.equal(missingMode.status, 400);
    assert.equal(app.calls.create.length, 0);

    const forged = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'key',
        modelScopes: ['model-a'],
        supplyMode: 'platform',
        principalKind: 'project_service',
        profile: 'client-profile',
        tenant: 'tenant-2',
        project: 'project-2',
        principal: 'user-2',
      }),
    });
    assert.equal(forged.status, 400);
    assert.equal(app.calls.create.length, 0);

    const created = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'key',
        modelScopes: ['model-a'],
        supplyMode: 'platform',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(created.status, 201);
    const createdData = dataObject(await body(created));
    assert.equal(createdData.secret, 'mr_live_create_1');
    assert.deepEqual(app.calls.create[0]?.input, {
      name: 'key',
      modelScopes: ['model-a'],
      supplyMode: 'platform',
      principalKind: 'member',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    const listed = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      headers: { cookie: SESSION_COOKIE },
    });
    assert.equal(listed.status, 200);
    const listedData = dataArray(await body(listed));
    const listedKey = listedData[0];
    assert.ok(listedKey);
    assert.equal(listedKey.prefix, 'mr_live_key-1');
    assert.equal(listedKey.entitlementId, 'entitlement-1');
    assert.equal(listedKey.status, 'active');
    assert.equal(listedKey.secret, undefined);
    assert.equal(listedKey.keyHash, undefined);
    assert.equal(JSON.stringify(listedData).includes('mr_live_create_1'), false);

    const revoked = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/key-1/revoke`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin },
    });
    assert.equal(revoked.status, 200);
    const revokedData = dataObject(await body(revoked));
    assert.equal(revokedData.status, 'revoked');
    assert.equal(revokedData.secret, undefined);
    assert.equal(JSON.stringify(revokedData).includes('mr_live_create_1'), false);
  } finally {
    await app.close();
  }
});

test('create defaults to the authenticated member, supports project services, and rejects forged bindings', async () => {
  const app = await startHarness();
  try {
    const create = (input: Record<string, unknown>) =>
      fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
        method: 'POST',
        headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'key', modelScopes: ['model-a'], supplyMode: 'platform', ...input }),
      });

    const defaultMember = await create({});
    assert.equal(defaultMember.status, 201);
    const defaultMemberData = dataObject(await body(defaultMember));
    assert.equal(defaultMemberData.executionPrincipalType, 'member');
    assert.equal(defaultMemberData.executionPrincipalId, 'user-1');
    assert.equal(defaultMemberData.createdByUserId, 'user-1');
    assert.deepEqual(app.calls.create[0]?.input, {
      name: 'key',
      modelScopes: ['model-a'],
      supplyMode: 'platform',
      principalKind: 'member',
    });

    const projectService = await create({ principalKind: 'project_service' });
    assert.equal(projectService.status, 201);
    const projectServiceData = dataObject(await body(projectService));
    assert.equal(projectServiceData.executionPrincipalType, 'project_service');
    assert.equal(projectServiceData.executionPrincipalId, 'project-1');
    assert.equal(projectServiceData.principalUserId, null);
    assert.equal(projectServiceData.createdByUserId, 'user-1');
    assert.deepEqual(app.calls.create[1]?.input, {
      name: 'key',
      modelScopes: ['model-a'],
      supplyMode: 'platform',
      principalKind: 'project_service',
    });

    const unknownKind = await create({ principalKind: 'service' });
    assert.equal(unknownKind.status, 400);
    assert.equal(app.calls.create.length, 2);

    for (const forgedField of [
      { principalId: 'attacker-principal' },
      { principalUserId: 'attacker-user' },
      { executionPrincipalId: 'attacker-principal' },
      { creatorId: 'attacker-creator' },
      { createdByUserId: 'attacker-creator' },
      { entitlementId: 'attacker-entitlement' },
      { supplyProfileId: 'attacker-profile' },
      { profileId: 'attacker-profile' },
      { tenantId: 'tenant-2' },
      { projectId: 'project-2' },
    ]) {
      const forged = await create(forgedField);
      assert.equal(forged.status, 400);
    }
    assert.equal(app.calls.create.length, 2);
    assert.deepEqual(app.calls.authorize, [
      { userId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1' },
      { userId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1' },
    ]);
  } finally {
    await app.close();
  }
});

test('rotate returns a one-time replacement secret and rejects a forged body', async () => {
  const app = await startHarness();
  try {
    await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'key',
        modelScopes: ['model-a'],
        supplyMode: 'platform',
        principalKind: 'project_service',
      }),
    });
    for (const forgedBody of [
      { supplyMode: 'byok' },
      { profileId: 'attacker-profile' },
      { principalId: 'attacker-principal' },
      { principalKind: 'member' },
    ]) {
      const forged = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/key-1/rotate`, {
        method: 'POST',
        headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
        body: JSON.stringify(forgedBody),
      });
      assert.equal(forged.status, 400);
    }
    assert.deepEqual(app.calls.rotate, []);

    const rotated = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/key-1/rotate`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin },
    });
    assert.equal(rotated.status, 201);
    const rotatedData = dataObject(await body(rotated));
    assert.equal(rotatedData.secret, 'mr_live_rotate_2');
    assert.match(String(rotatedData.prefix), /^mr_live_key-/);
    assert.equal(rotatedData.executionPrincipalType, 'project_service');
    assert.equal(rotatedData.executionPrincipalId, 'project-1');
    assert.equal(rotatedData.principalUserId, null);
    assert.equal(rotatedData.createdByUserId, 'user-1');
  } finally {
    await app.close();
  }
});

test('create fails closed when the KeyService has no entitlement resolver', async () => {
  const app = await startHarness({ keyService: new KeyService({} as never) });
  try {
    const response = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key', modelScopes: ['model-a'], supplyMode: 'platform' }),
    });
    assert.equal(response.status, 503);
    assert.equal(errorCode(await body(response)), 'SERVICE_UNAVAILABLE');
  } finally {
    await app.close();
  }
});
