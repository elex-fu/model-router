import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminReadHandlerOptions,
  type PlatformAdminSupplyService,
} from '../../../../src/saas/platform/http/index.js';
import { ProviderSupplyError } from '../../../../src/saas/supply/errors.js';
import type {
  ProviderAccountRecord,
  ProviderCredentialRecord,
  ProviderCredentialVersionRecord,
  ProviderCredentialWriteResult,
} from '../../../../src/saas/supply/types.js';

const ACTOR: PlatformAdminActor = {
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  sessionId: 'session-1',
  roles: ['operations'],
};

const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';

const ACCOUNT: ProviderAccountRecord = {
  ownerKind: 'platform',
  tenantId: null,
  supplyMode: 'platform',
  id: 'platform-account-a',
  displayName: 'Platform account',
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  region: 'cn-mainland',
  purpose: 'inference',
  rightsId: 'rights-a',
  rightsVersion: 2,
  capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
  status: 'pending',
  validationState: 'unverified',
  validationErrorCode: null,
  lastValidatedAt: null,
  authzVersion: 1,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  disabledAt: null,
  revokedAt: null,
};

const CREDENTIAL: ProviderCredentialRecord = {
  ownerKind: 'platform',
  tenantId: null,
  supplyMode: 'platform',
  id: 'credential-a',
  accountId: ACCOUNT.id,
  providerId: ACCOUNT.providerId,
  productId: ACCOUNT.productId,
  credentialType: ACCOUNT.credentialType,
  status: 'pending',
  validationState: 'unverified',
  validationErrorCode: null,
  lastValidatedAt: null,
  currentVersion: 1,
  expiresAt: null,
  authzVersion: 1,
  createdAt: ACCOUNT.createdAt,
  updatedAt: ACCOUNT.updatedAt,
  disabledAt: null,
  revokedAt: null,
};

const VERSION: ProviderCredentialVersionRecord = {
  ownerKind: 'platform',
  tenantId: null,
  accountId: ACCOUNT.id,
  credentialId: CREDENTIAL.id,
  version: 1,
  status: 'active',
  envelopeSchemaVersion: 1,
  contextVersion: 1,
  algorithm: 'aes-256-gcm',
  kmsPurpose: 'provider-supply',
  wrappingRevision: 1,
  createdAt: ACCOUNT.createdAt,
  expiresAt: null,
  retiredAt: null,
  revokedAt: null,
};

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

interface Harness {
  readonly base: string;
  request(url: string, init?: RequestInit): Promise<TestResponse>;
}

interface SupplyCalls {
  readonly accounts: unknown[];
  readonly credentials: unknown[];
  readonly rotations: unknown[];
  readonly accountLifecycle: unknown[];
  readonly credentialLifecycle: unknown[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeSupply(calls: SupplyCalls): PlatformAdminSupplyService {
  return {
    listPlatformProviderAccounts: async () => [clone(ACCOUNT)],
    createPlatformProviderAccount: async (input) => {
      calls.accounts.push(clone(input));
      return clone(ACCOUNT);
    },
    listPlatformProviderCredentials: async (accountId) => {
      if (accountId !== ACCOUNT.id) throw new ProviderSupplyError('ACCOUNT_NOT_FOUND');
      return [clone(CREDENTIAL)];
    },
    createPlatformProviderCredential: async (input) => {
      calls.credentials.push({ ...clone(input), secret: Buffer.from(input.secret) });
      return { credential: clone(CREDENTIAL), version: clone(VERSION) } satisfies ProviderCredentialWriteResult;
    },
    replacePlatformProviderCredentialSecret: async (input) => {
      calls.rotations.push({ ...clone(input), secret: Buffer.from(input.secret) });
      if (input.expectedVersion !== 1) throw new ProviderSupplyError('CREDENTIAL_VERSION_CONFLICT');
      return {
        credential: { ...clone(CREDENTIAL), currentVersion: 2, authzVersion: 2 },
        version: { ...clone(VERSION), version: 2 },
      } satisfies ProviderCredentialWriteResult;
    },
    enablePlatformProviderAccount: async (input) => {
      calls.accountLifecycle.push(clone(input));
      if (input.expectedAuthzVersion !== 1) throw new ProviderSupplyError('ACCOUNT_STATE_CONFLICT');
      return { ...clone(ACCOUNT), status: 'active', validationState: 'verified', authzVersion: 2 };
    },
    disablePlatformProviderAccount: async (input) => {
      calls.accountLifecycle.push(clone(input));
      if (input.expectedAuthzVersion !== 1) throw new ProviderSupplyError('ACCOUNT_STATE_CONFLICT');
      return { ...clone(ACCOUNT), status: 'disabled', authzVersion: 2, disabledAt: ACCOUNT.updatedAt };
    },
    revokePlatformProviderAccount: async (input) => {
      calls.accountLifecycle.push(clone(input));
      if (input.expectedAuthzVersion !== 1) throw new ProviderSupplyError('ACCOUNT_STATE_CONFLICT');
      return { ...clone(ACCOUNT), status: 'revoked', authzVersion: 2, revokedAt: ACCOUNT.updatedAt };
    },
    enablePlatformProviderCredential: async (input) => {
      calls.credentialLifecycle.push(clone(input));
      if (input.expectedAuthzVersion !== 1) throw new ProviderSupplyError('CREDENTIAL_STATE_CONFLICT');
      return { ...clone(CREDENTIAL), status: 'active', validationState: 'verified', authzVersion: 2 };
    },
    disablePlatformProviderCredential: async (input) => {
      calls.credentialLifecycle.push(clone(input));
      if (input.expectedAuthzVersion !== 1) throw new ProviderSupplyError('CREDENTIAL_STATE_CONFLICT');
      return { ...clone(CREDENTIAL), status: 'disabled', authzVersion: 2, disabledAt: ACCOUNT.updatedAt };
    },
    revokePlatformProviderCredential: async (input) => {
      calls.credentialLifecycle.push(clone(input));
      if (input.expectedAuthzVersion !== 1) throw new ProviderSupplyError('CREDENTIAL_STATE_CONFLICT');
      return { ...clone(CREDENTIAL), status: 'revoked', authzVersion: 2, revokedAt: ACCOUNT.updatedAt };
    },
  };
}

function writeInit(body: unknown, overrides: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      origin: 'https://platform-admin.test',
      host: 'platform-admin.test',
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
      'user-agent': 'platform-admin-supply-test',
      ...overrides,
    },
    body: JSON.stringify(body),
  };
}

async function startHarness(
  actor: PlatformAdminActor | undefined,
  supply: PlatformAdminSupplyService | undefined,
): Promise<Harness> {
  const options: PlatformAdminReadHandlerOptions = {
    access: { authenticate: async () => actor },
    operations: { getSummary: async () => ({}) },
    catalog: {
      listProducts: async () => ({ items: [] }),
      listCapabilities: async () => ({ items: [] }),
      listRights: async () => ({ items: [] }),
    },
    supply,
    writeSecurity: {
      publicOrigin: 'https://platform-admin.test',
      authService: {
        verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
      },
    },
  };
  const handler = createPlatformAdminReadHandler(options);
  return {
    base: 'http://platform-admin.test',
    async request(target, init) {
      const url = new URL(target, 'http://platform-admin.test');
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = init?.body === undefined ? undefined : String(init.body);
      const req = {
        url: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseHeaders = new Headers();
      let responseBody = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number, response: Record<string, unknown> = {}) {
          status = code;
          responseHeaders = new Headers(
            Object.entries(response).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : String(value)]],
            ),
          );
          return res;
        },
        end(value?: unknown) {
          responseBody = value === undefined ? '' : String(value);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;
      assert.equal(await handler(req, res), true);
      return { status, headers: responseHeaders, body: JSON.parse(responseBody) as Record<string, unknown> };
    },
  };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  assert.ok(error && typeof error === 'object' && !Array.isArray(error));
  return (error as Record<string, unknown>).code as string;
}

function assertSafeHeaders(response: TestResponse): void {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

const ACCOUNT_BODY = {
  displayName: 'Platform account',
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  region: 'cn-mainland',
  purpose: 'inference',
  rightsId: 'rights-a',
  rightsVersion: 2,
  capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
};

test('platform supply is operations/superadmin-only and absent service fails closed', async () => {
  const absent = await startHarness(ACTOR, undefined);
  const unavailable = await absent.request(`${absent.base}/admin/api/v1/supply/accounts`);
  assert.equal(unavailable.status, 503);
  assert.equal(errorCode(unavailable.body), 'SUPPLY_UNAVAILABLE');
  assertSafeHeaders(unavailable);

  const denied = await startHarness(
    { ...ACTOR, roles: ['security'] },
    makeSupply({
      accounts: [],
      credentials: [],
      rotations: [],
      accountLifecycle: [],
      credentialLifecycle: [],
    }),
  );
  const forbidden = await denied.request(`${denied.base}/admin/api/v1/supply/accounts`);
  assert.equal(forbidden.status, 403);
  assert.equal(errorCode(forbidden.body), 'FORBIDDEN');

  const superadmin = await startHarness(
    { ...ACTOR, roles: ['superadmin'] },
    makeSupply({
      accounts: [],
      credentials: [],
      rotations: [],
      accountLifecycle: [],
      credentialLifecycle: [],
    }),
  );
  assert.equal((await superadmin.request(`${superadmin.base}/admin/api/v1/supply/accounts`)).status, 200);
});

test('account creation fixes platform ownership, passes audit evidence, and redacts tenant/internal fields', async () => {
  const calls: SupplyCalls = {
    accounts: [],
    credentials: [],
    rotations: [],
    accountLifecycle: [],
    credentialLifecycle: [],
  };
  const app = await startHarness(ACTOR, makeSupply(calls));
  const invalidOwner = await app.request(`${app.base}/admin/api/v1/supply/accounts`, {
    ...writeInit({ ...ACCOUNT_BODY, ownerKind: 'tenant', tenantId: 'tenant-a' }),
  });
  assert.equal(invalidOwner.status, 400);
  assert.equal(calls.accounts.length, 0);

  const response = await app.request(`${app.base}/admin/api/v1/supply/accounts`, writeInit(ACCOUNT_BODY));
  assert.equal(response.status, 201);
  assertSafeHeaders(response);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.ownerKind, 'platform');
  assert.equal(data.supplyMode, 'platform');
  assert.equal('tenantId' in data, false);
  assert.equal('validationErrorCode' in data, false);
  assert.equal(calls.accounts.length, 1);
  const audit = (calls.accounts[0] as Record<string, unknown>).audit as Record<string, unknown>;
  assert.equal(audit.actorUserId, ACTOR.userId);
  assert.equal(audit.entryPoint, 'platform_admin');
  assert.equal(audit.sourceIp, '203.0.113.10');
  assert.equal(typeof audit.requestId, 'string');
});

test('supply writes require exact origin/host and CSRF and reject strict-body violations', async () => {
  const calls: SupplyCalls = {
    accounts: [],
    credentials: [],
    rotations: [],
    accountLifecycle: [],
    credentialLifecycle: [],
  };
  const app = await startHarness(ACTOR, makeSupply(calls));
  const base = writeInit(ACCOUNT_BODY);

  const origin = await app.request(`${app.base}/admin/api/v1/supply/accounts`, {
    ...base,
    headers: { ...base.headers, origin: 'https://evil.example' },
  });
  assert.equal(origin.status, 403);
  assert.equal(errorCode(origin.body), 'ORIGIN_REJECTED');

  const host = await app.request(`${app.base}/admin/api/v1/supply/accounts`, {
    ...base,
    headers: { ...base.headers, host: 'other.test' },
  });
  assert.equal(host.status, 403);
  assert.equal(errorCode(host.body), 'HOST_REJECTED');

  const csrf = await app.request(`${app.base}/admin/api/v1/supply/accounts`, {
    ...base,
    headers: { ...base.headers, 'x-csrf-token': 'wrong' },
  });
  assert.equal(csrf.status, 403);
  assert.equal(errorCode(csrf.body), 'CSRF_REJECTED');

  for (const body of [
    { ...ACCOUNT_BODY, tenantId: 'tenant-a' },
    { ...ACCOUNT_BODY, status: 'active' },
    {
      ...ACCOUNT_BODY,
      capabilities: [
        { model: 'model-a', endpoint: 'chat-completions', version: 1 },
        { model: 'model-a', endpoint: 'chat-completions', version: 1 },
      ],
    },
  ]) {
    const invalid = await app.request(`${app.base}/admin/api/v1/supply/accounts`, writeInit(body));
    assert.equal(invalid.status, 400);
    assert.equal(errorCode(invalid.body), 'INVALID_BODY');
  }

  const wrongContentType = await app.request(`${app.base}/admin/api/v1/supply/accounts`, {
    ...base,
    headers: { ...base.headers, 'content-type': 'text/plain' },
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal(errorCode(wrongContentType.body), 'JSON_REQUIRED');
  assert.equal(calls.accounts.length, 0);
});

test('credential create/rotate accept secrets only as input and return metadata/version allowlists', async () => {
  const calls: SupplyCalls = {
    accounts: [],
    credentials: [],
    rotations: [],
    accountLifecycle: [],
    credentialLifecycle: [],
  };
  const app = await startHarness(ACTOR, makeSupply(calls));
  const create = await app.request(
    `${app.base}/admin/api/v1/supply/accounts/${ACCOUNT.id}/credentials`,
    writeInit({ id: 'credential-a', secret: 'top-secret-value' }),
  );
  assert.equal(create.status, 201);
  assertSafeHeaders(create);
  assert.equal(JSON.stringify(create.body).includes('top-secret-value'), false);
  assert.equal(JSON.stringify(create.body).includes('ciphertext'), false);
  assert.equal(JSON.stringify(create.body).includes('kmsKeyId'), false);
  const createData = create.body.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(createData).sort(), ['credential', 'version']);
  assert.deepEqual(Object.keys(createData.version as Record<string, unknown>).sort(), [
    'accountId',
    'createdAt',
    'credentialId',
    'expiresAt',
    'ownerKind',
    'retiredAt',
    'revokedAt',
    'status',
    'supplyMode',
    'version',
  ]);
  assert.equal(
    Buffer.from((calls.credentials[0] as Record<string, unknown>).secret as Uint8Array).toString(),
    'top-secret-value',
  );

  const rotate = await app.request(`${app.base}/admin/api/v1/supply/credentials/${CREDENTIAL.id}/secret`, {
    ...writeInit({ expectedVersion: 1, secret: 'rotated-secret' }),
    method: 'PUT',
  });
  assert.equal(rotate.status, 200);
  assert.equal(JSON.stringify(rotate.body).includes('rotated-secret'), false);
  assert.equal((rotate.body.data as Record<string, unknown>).version !== undefined, true);

  const cas = await app.request(`${app.base}/admin/api/v1/supply/credentials/${CREDENTIAL.id}/secret`, {
    ...writeInit({ expectedVersion: 2, secret: 'rotated-secret' }),
    method: 'PUT',
  });
  assert.equal(cas.status, 409);
  assert.equal(errorCode(cas.body), 'CREDENTIAL_VERSION_CONFLICT');
});

test('credential and account lifecycle routes pass explicit CAS and never resolve a tenant owner', async () => {
  const calls: SupplyCalls = {
    accounts: [],
    credentials: [],
    rotations: [],
    accountLifecycle: [],
    credentialLifecycle: [],
  };
  const app = await startHarness(ACTOR, makeSupply(calls));

  const disabled = await app.request(
    `${app.base}/admin/api/v1/supply/accounts/${ACCOUNT.id}/disable`,
    writeInit({ expectedAuthzVersion: 1 }),
  );
  assert.equal(disabled.status, 200);
  assert.equal((disabled.body.data as Record<string, unknown>).status, 'disabled');
  assert.equal((calls.accountLifecycle[0] as Record<string, unknown>).accountId, ACCOUNT.id);

  const credentialDisabled = await app.request(
    `${app.base}/admin/api/v1/supply/credentials/${CREDENTIAL.id}/disable`,
    writeInit({ expectedAuthzVersion: 1 }),
  );
  assert.equal(credentialDisabled.status, 200);
  assert.equal((credentialDisabled.body.data as Record<string, unknown>).status, 'disabled');

  const stale = await app.request(
    `${app.base}/admin/api/v1/supply/accounts/${ACCOUNT.id}/revoke`,
    writeInit({ expectedAuthzVersion: 2 }),
  );
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale.body), 'ACCOUNT_STATE_CONFLICT');

  const tenantLookup = await app.request(`${app.base}/admin/api/v1/supply/accounts/tenant-account/credentials`);
  assert.equal(tenantLookup.status, 404);
  assert.equal(errorCode(tenantLookup.body), 'ACCOUNT_NOT_FOUND');
  assert.equal(calls.credentialLifecycle.length, 1);
});

test('supply service errors stay generic and request bodies never appear in errors', async () => {
  const calls: SupplyCalls = {
    accounts: [],
    credentials: [],
    rotations: [],
    accountLifecycle: [],
    credentialLifecycle: [],
  };
  const supply = makeSupply(calls);
  supply.createPlatformProviderCredential = async () => {
    throw new ProviderSupplyError('INVALID_INPUT', 'provider secret=do-not-leak');
  };
  const app = await startHarness(ACTOR, supply);
  const response = await app.request(
    `${app.base}/admin/api/v1/supply/accounts/${ACCOUNT.id}/credentials`,
    writeInit({ secret: 'do-not-leak' }),
  );
  assert.equal(response.status, 400);
  assert.equal(errorCode(response.body), 'INVALID_INPUT');
  assert.equal(JSON.stringify(response.body).includes('do-not-leak'), false);
  assert.equal(JSON.stringify(response.body).includes('provider secret'), false);
});
