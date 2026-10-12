import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  CUSTOMER_KEY_MUTATION_ISSUE_SQL,
  type CustomerKeyMutationSessionHandle,
} from '../../../src/saas/identity/customer-key-mutation-session.js';
import { assertCustomerKeyMutationSessionBound, SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import type {
  KeyBudgetPolicySnapshot,
  ReplaceKeyBudgetPolicyInput,
} from '../../../src/saas/keys/budget-policy-contract.js';
import { createSaasKeyHandler } from '../../../src/saas/keys/http.js';
import type { KeyIpPolicySnapshot, ReplaceKeyIpPolicyInput } from '../../../src/saas/keys/ip-policy-contract.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import type { ApiKeyMetadata, CreateApiKeyInput, CreatedApiKey } from '../../../src/saas/keys/types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_TOKEN = 'owned_synthetic_session_token_001';
const CSRF_TOKEN = 'owned_synthetic_csrf_token_001';
const SESSION_COOKIE = 'mr_saas_session=' + SESSION_TOKEN;
const CSRF_COOKIE = 'mr_saas_csrf=' + CSRF_TOKEN;

type KeyHttpService = {
  create(context: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey>;
  list(context: TenantContext): Promise<ApiKeyMetadata[]>;
  rotate(context: TenantContext, keyId: string): Promise<CreatedApiKey>;
  revoke(context: TenantContext, keyId: string): Promise<ApiKeyMetadata>;
  getKeyIpPolicy(context: TenantContext, keyId: string): Promise<KeyIpPolicySnapshot>;
  getKeyBudgetPolicy(context: TenantContext, keyId: string): Promise<KeyBudgetPolicySnapshot>;
  createAuthenticated?(
    context: TenantContext,
    input: CreateApiKeyInput,
    handle: CustomerKeyMutationSessionHandle,
  ): Promise<CreatedApiKey>;
  rotateAuthenticated?(
    context: TenantContext,
    keyId: string,
    handle: CustomerKeyMutationSessionHandle,
  ): Promise<CreatedApiKey>;
  revokeAuthenticated?(
    context: TenantContext,
    keyId: string,
    handle: CustomerKeyMutationSessionHandle,
  ): Promise<ApiKeyMetadata>;
  replaceKeyIpPolicyAuthenticated?(
    context: TenantContext,
    keyId: string,
    input: ReplaceKeyIpPolicyInput,
    handle: CustomerKeyMutationSessionHandle,
  ): Promise<KeyIpPolicySnapshot>;
  replaceKeyBudgetPolicyAuthenticated?(
    context: TenantContext,
    keyId: string,
    input: ReplaceKeyBudgetPolicyInput,
    handle: CustomerKeyMutationSessionHandle,
  ): Promise<KeyBudgetPolicySnapshot>;
};

const baseContext: TenantContext = {
  userId: USER_ID,
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
    principalUserId: USER_ID,
    executionPrincipalType: 'member',
    executionPrincipalId: USER_ID,
    createdByUserId: USER_ID,
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

const verifiedZeroCounter = { status: 'verified', settled: '0', outstandingReserved: '0' } as const;

function budgetSnapshot(
  context: TenantContext,
  keyId: string,
  key: ApiKeyMetadata,
  budget: {
    version: string;
    lineageId: string;
    tokenCaps: { daily: string | null; lifetime: string | null };
    customerChargeCaps: { daily: string | null; lifetime: string | null } | null;
  },
): KeyBudgetPolicySnapshot {
  return {
    tenantId: context.tenantId,
    projectId: context.projectId,
    keyId,
    lineageId: budget.lineageId,
    version: budget.version,
    authzVersion: key.authzVersion,
    supplyMode: 'platform',
    tokenUnit: 'tokens',
    tokenCountingSemanticsVersion: 'token-units-v1',
    currentWindow: {
      timezone: 'UTC',
      startInclusive: '2026-09-28T00:00:00.000Z',
      endExclusive: '2026-09-29T00:00:00.000Z',
    },
    tokenCaps: { daily: budget.tokenCaps.daily, lifetime: budget.tokenCaps.lifetime },
    tokenUsage: { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter },
    customerChargeBudget:
      budget.customerChargeCaps === null
        ? null
        : {
            currency: 'USD',
            unit: 'minor_units',
            caps: { daily: budget.customerChargeCaps.daily, lifetime: budget.customerChargeCaps.lifetime },
            usage: { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter },
          },
  };
}

function makeHarness(
  options: {
    role?: TenantContext['tenantRole'];
    keyService?: KeyHttpService;
    withoutResolver?: boolean;
    withoutIssuer?: boolean;
    forgedIssuer?: boolean;
    withoutAuthenticated?: boolean;
  } = {},
) {
  const calls = {
    authorize: [] as Array<Record<string, string>>,
    create: [] as Array<{ context: TenantContext; input: CreateApiKeyInput }>,
    list: 0,
    rotate: [] as string[],
    revoke: [] as string[],
  };
  const rows = new Map<string, ApiKeyMetadata>();
  const policies = new Map<string, { version: string; mode: 'disabled' | 'allowlist' | 'denyall'; rules: string[] }>();
  const budgets = new Map<
    string,
    {
      version: string;
      lineageId: string;
      tokenCaps: { daily: string | null; lifetime: string | null };
      customerChargeCaps: { daily: string | null; lifetime: string | null } | null;
    }
  >();
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

  // Real issuer, scripted native query port: NOT a verified-capability mint stub.
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  const database: SaasDatabase = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      let rows: unknown[];
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (sql === CUSTOMER_KEY_MUTATION_ISSUE_SQL) {
        rows =
          values[0] === sha(SESSION_TOKEN) && values[1] === sha(CSRF_TOKEN)
            ? [
                {
                  id: '22222222-2222-4222-8222-222222222222',
                  user_id: USER_ID,
                  token_hash: sha(SESSION_TOKEN),
                  csrf_token_hash: sha(CSRF_TOKEN),
                },
              ]
            : [];
      } else if (
        statement ===
        'SELECT s.user_id, s.expires_at, s.created_at FROM saas_sessions s JOIN saas_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.disabled_at IS NULL LIMIT 1'
      ) {
        rows =
          values[0] === sha(SESSION_TOKEN)
            ? [{ user_id: USER_ID, expires_at: '2030-01-01T00:00:00.000Z', created_at: '2026-09-28T00:00:00.000Z' }]
            : [];
      } else if (
        statement ===
        'SELECT s.csrf_token_hash FROM saas_sessions s JOIN saas_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.disabled_at IS NULL LIMIT 1'
      ) {
        rows = values[0] === sha(SESSION_TOKEN) ? [{ csrf_token_hash: sha(CSRF_TOKEN) }] : [];
      } else {
        throw new Error('Unexpected owned HTTP fixture SQL');
      }
      // Only the generic scripted-driver row boundary; actual issuer validates origin.
      return { rows: rows as Row[], rowCount: rows.length };
    },
    async transaction<T>(_work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      throw new Error('Unexpected HTTP fixture TX');
    },
    async migrate() {
      throw new Error('No fixture migration');
    },
    async verifySchema() {
      throw new Error('No fixture readiness');
    },
    async ping() {
      throw new Error('No fixture ping');
    },
    async close() {},
  };
  const actualIdentity = new SaasIdentityService(database, { now: () => new Date('2026-09-28T00:00:00.000Z') });

  const defaultKeyService: KeyHttpService = {
    async createAuthenticated(candidate, input, handle) {
      assertCustomerKeyMutationSessionBound(handle, database, candidate.userId);
      return defaultKeyService.create(candidate, input);
    },
    async rotateAuthenticated(candidate, keyId, handle) {
      assertCustomerKeyMutationSessionBound(handle, database, candidate.userId);
      return defaultKeyService.rotate(candidate, keyId);
    },
    async revokeAuthenticated(candidate, keyId, handle) {
      assertCustomerKeyMutationSessionBound(handle, database, candidate.userId);
      return defaultKeyService.revoke(candidate, keyId);
    },
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
      policies.set(id, { version: '1', mode: 'disabled', rules: [] });
      budgets.set(id, {
        version: '1',
        lineageId: id,
        tokenCaps: { daily: null, lifetime: null },
        customerChargeCaps: null,
      });
      secretNumber += 1;
      return { ...metadata, secret: `mr_live_create_${secretNumber}` };
    },
    async getKeyIpPolicy(candidate, keyId) {
      assertManagementRole(candidate);
      const current = rows.get(keyId);
      const policy = policies.get(keyId);
      if (!current || !policy) throw errorWithStatus(404);
      return {
        tenantId: candidate.tenantId,
        projectId: candidate.projectId,
        keyId,
        version: policy.version,
        authzVersion: current.authzVersion,
        policy: { mode: policy.mode, rules: [...policy.rules] },
      };
    },
    async replaceKeyIpPolicyAuthenticated(candidate, keyId, input, handle) {
      assertCustomerKeyMutationSessionBound(handle, database, candidate.userId);
      assertManagementRole(candidate);
      const current = rows.get(keyId);
      const policy = policies.get(keyId);
      if (!current || !policy) throw errorWithStatus(404);
      if (input.expectedVersion !== policy.version) {
        throw Object.assign(errorWithStatus(409), { code: 'KEY_IP_POLICY_VERSION_CONFLICT' });
      }
      const nextVersion = String(Number(policy.version) + 1);
      const replaced = {
        version: nextVersion,
        mode: input.policy.mode,
        rules: [...input.policy.rules],
      };
      policies.set(keyId, replaced);
      rows.set(keyId, { ...current, authzVersion: current.authzVersion + 1 });
      return {
        tenantId: candidate.tenantId,
        projectId: candidate.projectId,
        keyId,
        version: nextVersion,
        authzVersion: current.authzVersion + 1,
        policy: { mode: replaced.mode, rules: [...replaced.rules] },
      };
    },
    async getKeyBudgetPolicy(candidate, keyId) {
      assertManagementRole(candidate);
      const current = rows.get(keyId);
      const budget = budgets.get(keyId);
      if (!current || !budget) throw errorWithStatus(404);
      return budgetSnapshot(candidate, keyId, current, budget);
    },
    async replaceKeyBudgetPolicyAuthenticated(candidate, keyId, input, handle) {
      assertCustomerKeyMutationSessionBound(handle, database, candidate.userId);
      assertManagementRole(candidate);
      const current = rows.get(keyId);
      const budget = budgets.get(keyId);
      if (!current || !budget) throw errorWithStatus(404);
      if (input.expectedVersion !== budget.version) {
        throw Object.assign(errorWithStatus(409), { code: 'KEY_BUDGET_POLICY_VERSION_CONFLICT' });
      }
      const replaced = {
        version: String(Number(budget.version) + 1),
        lineageId: budget.lineageId,
        tokenCaps: { daily: input.tokenCaps.daily, lifetime: input.tokenCaps.lifetime },
        customerChargeCaps:
          input.customerChargeCaps === null
            ? null
            : { daily: input.customerChargeCaps.daily, lifetime: input.customerChargeCaps.lifetime },
      };
      budgets.set(keyId, replaced);
      rows.set(keyId, { ...current, authzVersion: current.authzVersion + 1 });
      return budgetSnapshot(candidate, keyId, { ...current, authzVersion: current.authzVersion + 1 }, replaced);
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
    getSession: (token: string) => actualIdentity.getSession(token),
    verifyCsrfToken: (token: string, csrf: string) => actualIdentity.verifyCsrfToken(token, csrf),
    ...(options.withoutIssuer
      ? {}
      : {
          issueKeyMutationSession: (token: string, csrf: string) =>
            options.forgedIssuer
              ? Promise.resolve(
                  Object.freeze({
                    purpose: 'customer-key-mutation-session-v1',
                  } satisfies CustomerKeyMutationSessionHandle),
                )
              : actualIdentity.issueKeyMutationSession(token, csrf),
        }),
    async authorizeProjectAccess(input: { userId: string; tenantId: string; projectId: string }) {
      calls.authorize.push(input);
      if (input.userId !== USER_ID || input.tenantId !== 'tenant-1' || input.projectId !== 'project-1') {
        throw errorWithStatus(404);
      }
      return context;
    },
  };

  return {
    identity,
    keyService: options.withoutResolver
      ? new KeyService(database)
      : (options.keyService ??
        (options.withoutAuthenticated
          ? {
              create: defaultKeyService.create,
              list: defaultKeyService.list,
              rotate: defaultKeyService.rotate,
              revoke: defaultKeyService.revoke,
            }
          : defaultKeyService)),
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
    service: harness.identity,
    keyService: harness.keyService,
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
      { userId: USER_ID, tenantId: 'tenant-2', projectId: 'project-1' },
      { userId: USER_ID, tenantId: 'tenant-1', projectId: 'project-2' },
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
    assert.equal(defaultMemberData.executionPrincipalId, USER_ID);
    assert.equal(defaultMemberData.createdByUserId, USER_ID);
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
    assert.equal(projectServiceData.createdByUserId, USER_ID);
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
      { userId: USER_ID, tenantId: 'tenant-1', projectId: 'project-1' },
      { userId: USER_ID, tenantId: 'tenant-1', projectId: 'project-1' },
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
    assert.equal(rotatedData.createdByUserId, USER_ID);
  } finally {
    await app.close();
  }
});

test('create fails closed when the KeyService has no entitlement resolver', async () => {
  const app = await startHarness({ withoutResolver: true });
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

test('HTTP mutations require actual issuer and authenticated writer; GET remains unchanged without them', async () => {
  for (const options of [{ withoutIssuer: true }, { withoutAuthenticated: true }]) {
    const app = await startHarness(options);
    try {
      for (const suffix of ['keys', 'keys/key-1/rotate', 'keys/key-1/revoke']) {
        const response = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/${suffix}`, {
          method: 'POST',
          headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
          body: JSON.stringify(
            suffix === 'keys' ? { name: 'key', modelScopes: ['model-a'], supplyMode: 'platform' } : {},
          ),
        });
        assert.equal(response.status, 503);
        assert.equal(errorCode(await body(response)), 'SERVICE_UNAVAILABLE');
      }
      assert.equal(app.calls.create.length, 0);
      assert.equal(app.calls.rotate.length, 0);
      assert.equal(app.calls.revoke.length, 0);
      const get = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
        headers: { cookie: SESSION_COOKIE },
      });
      assert.equal(get.status, 200);
      assert.equal(app.calls.list, 1);
    } finally {
      await app.close();
    }
  }
});
test('HTTP refuses a shape-only issuer handle before any business service call', async () => {
  const app = await startHarness({ forgedIssuer: true });
  try {
    const response = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key', modelScopes: ['model-a'], supplyMode: 'platform' }),
    });
    assert.equal(response.status, 503);
    assert.equal(errorCode(await body(response)), 'SERVICE_UNAVAILABLE');
    assert.equal(app.calls.create.length, 0);
    assert.equal(
      JSON.stringify(
        await body(
          await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, { headers: { cookie: SESSION_COOKIE } }),
        ),
      ).includes(SESSION_TOKEN),
      false,
    );
  } finally {
    await app.close();
  }
});

test('GET ip-policy returns the versioned snapshot and rejects unsupported methods and anonymous callers', async () => {
  const app = await startHarness();
  try {
    const created = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Console key', modelScopes: ['model-a'], supplyMode: 'platform' }),
    });
    assert.equal(created.status, 201);
    const keyId = String(dataObject(await body(created)).id);

    const anonymous = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/ip-policy`);
    assert.equal(anonymous.status, 401);

    const wrongMethod = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/ip-policy`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(wrongMethod.status, 405);

    const response = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/ip-policy`, {
      headers: authHeaders(false),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(dataObject(await body(response)), {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      keyId,
      version: '1',
      authzVersion: 1,
      policy: { mode: 'disabled', rules: [] },
    });
  } finally {
    await app.close();
  }
});

test('PUT ip-policy enforces the write boundary and advances the CAS head', async () => {
  const app = await startHarness();
  try {
    const created = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Console key', modelScopes: ['model-a'], supplyMode: 'platform' }),
    });
    const keyId = String(dataObject(await body(created)).id);
    const url = `${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/ip-policy`;

    const noCsrf = await fetch(url, {
      method: 'PUT',
      headers: { cookie: `${SESSION_COOKIE}; ${CSRF_COOKIE}`, origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: '1', policy: { mode: 'denyall', rules: [] } }),
    });
    assert.equal(noCsrf.status, 403);

    const malformed = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: '1' }),
    });
    assert.equal(malformed.status, 400);

    const replaced = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: '1', policy: { mode: 'allowlist', rules: ['203.0.113.0/24'] } }),
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual(dataObject(await body(replaced)), {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      keyId,
      version: '2',
      authzVersion: 2,
      policy: { mode: 'allowlist', rules: ['203.0.113.0/24'] },
    });

    const stale = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: '1', policy: { mode: 'denyall', rules: [] } }),
    });
    assert.equal(stale.status, 409);
    assert.equal(errorCode(await body(stale)), 'CONFLICT');

    const current = await fetch(url, { headers: authHeaders(false) });
    assert.equal(String(dataObject(await body(current)).version), '2');
  } finally {
    await app.close();
  }
});

test('GET budget-policy returns the versioned snapshot and rejects unsupported methods and anonymous callers', async () => {
  const app = await startHarness();
  try {
    const created = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Console key', modelScopes: ['model-a'], supplyMode: 'platform' }),
    });
    assert.equal(created.status, 201);
    const keyId = String(dataObject(await body(created)).id);

    const anonymous = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/budget-policy`);
    assert.equal(anonymous.status, 401);

    const wrongMethod = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/budget-policy`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(wrongMethod.status, 405);

    const response = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/budget-policy`, {
      headers: authHeaders(false),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(dataObject(await body(response)), {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      keyId,
      lineageId: keyId,
      version: '1',
      authzVersion: 1,
      supplyMode: 'platform',
      tokenUnit: 'tokens',
      tokenCountingSemanticsVersion: 'token-units-v1',
      currentWindow: {
        timezone: 'UTC',
        startInclusive: '2026-09-28T00:00:00.000Z',
        endExclusive: '2026-09-29T00:00:00.000Z',
      },
      tokenCaps: { daily: null, lifetime: null },
      tokenUsage: { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter },
      customerChargeBudget: null,
    });
  } finally {
    await app.close();
  }
});

test('PUT budget-policy enforces the write boundary and advances the CAS head', async () => {
  const app = await startHarness();
  try {
    const created = await fetch(`${app.base}/tenants/tenant-1/projects/project-1/keys`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Console key', modelScopes: ['model-a'], supplyMode: 'platform' }),
    });
    const keyId = String(dataObject(await body(created)).id);
    const url = `${app.base}/tenants/tenant-1/projects/project-1/keys/${keyId}/budget-policy`;

    const noCsrf = await fetch(url, {
      method: 'PUT',
      headers: { cookie: `${SESSION_COOKIE}; ${CSRF_COOKIE}`, origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: '1',
        tokenCaps: { daily: '1000', lifetime: null },
        customerChargeCaps: null,
      }),
    });
    assert.equal(noCsrf.status, 403);

    const malformed = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: '1', tokenCaps: { daily: '1000', lifetime: null } }),
    });
    assert.equal(malformed.status, 400);

    const replaced = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: '1',
        tokenCaps: { daily: '1000', lifetime: null },
        customerChargeCaps: { daily: '5000', lifetime: '90000' },
      }),
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual(dataObject(await body(replaced)), {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      keyId,
      lineageId: keyId,
      version: '2',
      authzVersion: 2,
      supplyMode: 'platform',
      tokenUnit: 'tokens',
      tokenCountingSemanticsVersion: 'token-units-v1',
      currentWindow: {
        timezone: 'UTC',
        startInclusive: '2026-09-28T00:00:00.000Z',
        endExclusive: '2026-09-29T00:00:00.000Z',
      },
      tokenCaps: { daily: '1000', lifetime: null },
      tokenUsage: { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter },
      customerChargeBudget: {
        currency: 'USD',
        unit: 'minor_units',
        caps: { daily: '5000', lifetime: '90000' },
        usage: { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter },
      },
    });

    const stale = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), origin: app.origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: '1',
        tokenCaps: { daily: null, lifetime: null },
        customerChargeCaps: null,
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal(errorCode(await body(stale)), 'CONFLICT');

    const current = await fetch(url, { headers: authHeaders(false) });
    const currentBody = dataObject(await body(current));
    assert.equal(String(currentBody.version), '2');
    assert.equal(String(currentBody.authzVersion), '2');
  } finally {
    await app.close();
  }
});
