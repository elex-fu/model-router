import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialSealingKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/index.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import type { SupplyProfileResolution } from '../../../src/saas/keys/types.js';
import type {
  PlatformCatalogCapabilityRecord,
  PlatformCatalogProviderProductRecord,
  PlatformCatalogRightsRecord,
} from '../../../src/saas/platform/catalog/types.js';
import { type CustomerByokHttpOptions, createCustomerByokHttpHandler } from '../../../src/saas/supply/customer-http.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import { ProviderSupplyService } from '../../../src/saas/supply/index.js';
import type {
  PersistedTenantByokProfileAccountInput,
  ProviderSupplyRepository,
} from '../../../src/saas/supply/repository.js';
import type {
  CreateTenantByokCredentialInput,
  ProviderAccountRecord,
  ProviderCredentialRecord,
  ProviderCredentialVersionRecord,
  ProviderCredentialWriteResult,
} from '../../../src/saas/supply/types.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';

const ORIGIN = 'https://console.example.test';
const NOW = new Date('2026-09-29T00:00:00.000Z');
const SECRET = 'upstream-secret-never-return-this';
const BYOK_ENTITLEMENT: SupplyProfileResolution = {
  entitlementId: 'entitlement-a',
  profileId: 'profile-a',
  mode: 'byok',
  allowedModels: ['model-a'],
  entitlementAuthzVersion: 1,
  supplyProfileAuthzVersion: 1,
  modelScopeVersion: 1,
};

class TestResponse extends EventEmitter {
  statusCode = 0;
  headers: OutgoingHttpHeaders = {};
  body = '';
  destroyed = false;
  writableEnded = false;
  headersSent = false;

  writeHead(statusCode: number, headers: OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(value?: string | Uint8Array): this {
    this.body = typeof value === 'string' ? value : value ? Buffer.from(value).toString('utf8') : '';
    this.writableEnded = true;
    this.emit('finish');
    return this;
  }
}

function makeAccount(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  return {
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    supplyMode: 'byok',
    id: 'account-a',
    displayName: 'Primary key',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    rightsId: 'rights-a',
    rightsVersion: 3,
    capabilities: [],
    status: 'pending',
    validationState: 'unverified',
    validationErrorCode: null,
    lastValidatedAt: null,
    authzVersion: 1,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    disabledAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeCredential(overrides: Partial<ProviderCredentialRecord> = {}): ProviderCredentialRecord {
  return {
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    supplyMode: 'byok',
    id: 'credential-a',
    accountId: 'account-a',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    status: 'pending',
    validationState: 'unverified',
    validationErrorCode: null,
    lastValidatedAt: null,
    currentVersion: 1,
    expiresAt: null,
    authzVersion: 1,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    disabledAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<ProviderCredentialVersionRecord> = {}): ProviderCredentialVersionRecord {
  return {
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    version: 1,
    status: 'active',
    envelopeSchemaVersion: 1,
    contextVersion: 1,
    algorithm: 'AES-256-GCM',
    kmsPurpose: 'provider-credential',
    wrappingRevision: 1,
    createdAt: '2026-09-29T00:00:00.000Z',
    expiresAt: null,
    retiredAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeRights(overrides: Partial<PlatformCatalogRightsRecord> = {}): PlatformCatalogRightsRecord {
  return {
    rightsId: 'rights-a',
    version: 3,
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    supplyMode: 'byok',
    region: 'cn-mainland',
    purpose: 'inference',
    modelScope: ['model-a'],
    endpointScope: ['chat-completions'],
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    approvalReference: 'approval-a',
    status: 'active',
    evidenceReference: 'evidence-a',
    evidenceSha256: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCapability(overrides: Partial<PlatformCatalogCapabilityRecord> = {}): PlatformCatalogCapabilityRecord {
  return {
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpoint: 'chat-completions',
    protocol: 'openai',
    version: 1,
    supportLevel: 'supported',
    validationState: 'verified',
    evidenceVersion: 'contract-v1',
    discoverySource: 'manual',
    evidenceReference: 'capability-evidence-a',
    evidenceSha256: 'b'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProduct(): PlatformCatalogProviderProductRecord {
  return {
    providerId: 'provider-a',
    productId: 'product-a',
    displayName: 'Provider A',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function fixture(
  options: {
    readonly leakOtherTenants?: boolean;
    readonly rights?: readonly PlatformCatalogRightsRecord[];
    readonly capabilities?: readonly PlatformCatalogCapabilityRecord[];
    readonly entitlement?: SupplyProfileResolution | null;
    readonly profileResolverUnavailable?: boolean;
    readonly tenantRole?: TenantContext['tenantRole'];
  } = {},
) {
  const calls: {
    readonly contextInputs: Array<{ userId: string; tenantId: string }>;
    readonly createInputs: CreateTenantByokCredentialInput[];
    readonly listFilters: unknown[];
    readonly replaceInputs: unknown[];
    readonly lifecycleInputs: unknown[];
    readonly secretBuffers: Uint8Array[];
    readonly profileInputs: Array<{ userId: string; tenantId: string; projectId: string; mode: string }>;
    rightsQuery: unknown;
  } = {
    contextInputs: [],
    createInputs: [],
    listFilters: [],
    replaceInputs: [],
    lifecycleInputs: [],
    secretBuffers: [],
    profileInputs: [],
    rightsQuery: undefined,
  };
  const accounts = new Map<string, ProviderAccountRecord>();
  const credentials = new Map<string, ProviderCredentialRecord>();
  accounts.set(
    'account-a',
    makeAccount({ capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }] }),
  );
  const identity = {
    async getSession(token: string) {
      return token === 'session-a' ? { userId: 'user-a' } : undefined;
    },
    async resolveTenantContext(input: { userId: string; tenantId: string }) {
      calls.contextInputs.push(input);
      if (input.userId !== 'user-a' || input.tenantId !== 'tenant-a') {
        throw Object.assign(new Error('not authorized'), { status: 403 });
      }
      return {
        userId: 'user-a',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        tenantRole: options.tenantRole ?? ('owner' as const),
        projectRole: 'owner' as const,
      };
    },
    async verifyCsrfToken(token: string, csrfToken: string) {
      return token === 'session-a' && csrfToken === 'csrf-a';
    },
  };
  const catalog = {
    async listProducts() {
      return { items: [makeProduct()], nextCursor: null, hasMore: false };
    },
    async listRights(input: unknown) {
      calls.rightsQuery = input;
      return {
        items: [
          ...(options.rights ?? [
            makeRights(),
            makeRights({ rightsId: 'platform-rights', supplyMode: 'platform', version: 9 }),
          ]),
        ],
        nextCursor: null,
        hasMore: false,
      };
    },
    async listCapabilities() {
      return { items: options.capabilities ?? [makeCapability()], nextCursor: null, hasMore: false };
    },
  };
  const supplyProfileResolver = {
    async resolve(context: TenantContext, mode: 'byok' | 'platform') {
      calls.profileInputs.push({
        userId: context.userId,
        tenantId: context.tenantId,
        projectId: context.projectId,
        mode,
      });
      if (options.profileResolverUnavailable) throw new Error('profile resolver unavailable');
      if (options.entitlement !== undefined) return options.entitlement;
      return BYOK_ENTITLEMENT;
    },
  };
  const supply = {
    async createTenantByokCredential(input: CreateTenantByokCredentialInput) {
      calls.createInputs.push(input);
      calls.secretBuffers.push(input.secret);
      const account = makeAccount({
        id: 'created-account',
        tenantId: input.context.tenantId,
        displayName: input.account.displayName,
        providerId: input.account.providerId,
        productId: input.account.productId,
        credentialType: input.account.credentialType,
        region: input.account.region,
        purpose: input.account.purpose,
        rightsId: input.account.rightsId,
        rightsVersion: input.account.rightsVersion,
        capabilities: [input.account.capability],
      });
      accounts.set(account.id, account);
      const credential = makeCredential({
        id: 'created-credential',
        accountId: account.id,
        tenantId: account.tenantId,
        providerId: account.providerId,
        productId: account.productId,
        credentialType: account.credentialType,
        currentVersion: 1,
        expiresAt: input.expiresAt ?? null,
      });
      credentials.set(credential.id, credential);
      return { account, credential, version: makeVersion({ credentialId: credential.id, accountId: account.id }) };
    },
    async listProviderCredentials(filter: unknown) {
      calls.listFilters.push(filter);
      const rows = [...credentials.values()];
      return options.leakOtherTenants ? rows : rows.filter((row) => row.tenantId === 'tenant-a');
    },
    async getProviderAccount(reference: { accountId: string }) {
      const account = accounts.get(reference.accountId);
      if (!account) throw new ProviderSupplyError('ACCOUNT_NOT_FOUND');
      return account;
    },
    async replaceTenantProviderCredentialSecret(input: {
      readonly credential: { readonly credentialId: string };
      readonly expectedVersion: number;
      readonly secret: Uint8Array;
    }) {
      calls.replaceInputs.push(input);
      calls.secretBuffers.push(input.secret);
      const current = credentials.get(input.credential.credentialId) as ProviderCredentialRecord;
      if (input.expectedVersion !== current.currentVersion) {
        throw new ProviderSupplyError('CREDENTIAL_VERSION_CONFLICT');
      }
      const updated = makeCredential({
        ...current,
        currentVersion: (current.currentVersion ?? 0) + 1,
        authzVersion: current.authzVersion + 1,
      });
      credentials.set(updated.id, updated);
      return {
        credential: updated,
        version: makeVersion({
          credentialId: updated.id,
          accountId: updated.accountId,
          version: updated.currentVersion as number,
        }),
      } satisfies ProviderCredentialWriteResult;
    },
    async disableTenantProviderCredential(input: {
      readonly credential: { readonly credentialId: string };
      readonly expectedAuthzVersion: number;
    }) {
      calls.lifecycleInputs.push({ action: 'disable', ...input });
      return transition('disabled', input);
    },
    async enableTenantProviderCredential(input: {
      readonly credential: { readonly credentialId: string };
      readonly expectedAuthzVersion: number;
    }) {
      calls.lifecycleInputs.push({ action: 'enable', ...input });
      return transition('active', input);
    },
    async revokeTenantProviderCredential(input: {
      readonly credential: { readonly credentialId: string };
      readonly expectedAuthzVersion: number;
    }) {
      calls.lifecycleInputs.push({ action: 'revoke', ...input });
      return transition('revoked', input);
    },
  };

  function transition(
    status: 'active' | 'disabled' | 'revoked',
    input: { readonly credential: { readonly credentialId: string }; readonly expectedAuthzVersion: number },
  ) {
    const current = credentials.get(input.credential.credentialId) as ProviderCredentialRecord | undefined;
    if (current?.tenantId !== 'tenant-a') throw new ProviderSupplyError('CREDENTIAL_NOT_FOUND');
    if (input.expectedAuthzVersion !== current.authzVersion) throw new ProviderSupplyError('CREDENTIAL_STATE_CONFLICT');
    if (current.status === 'revoked') throw new ProviderSupplyError('CREDENTIAL_REVOKED');
    const updated = makeCredential({
      ...current,
      status,
      authzVersion: current.authzVersion + 1,
      disabledAt: status === 'disabled' ? NOW.toISOString() : null,
      revokedAt: status === 'revoked' ? NOW.toISOString() : null,
    });
    credentials.set(updated.id, updated);
    return updated;
  }

  const handler = createCustomerByokHttpHandler({
    service: identity,
    supplyService: supply,
    catalog,
    supplyProfileResolver,
    publicOrigin: ORIGIN,
    now: () => NOW,
  } as unknown as CustomerByokHttpOptions);
  return { handler, calls, accounts, credentials, identity, catalog, supplyProfileResolver };
}

class AtomicTestRepository extends FakeProviderSupplyRepository {
  profileBindings: PersistedTenantByokProfileAccountInput[] = [];

  async transaction<T>(work: (repository: ProviderSupplyRepository, executor?: SqlExecutor) => Promise<T>): Promise<T> {
    const child = new AtomicTestRepository();
    child.accounts = structuredClone(this.accounts);
    child.credentials = structuredClone(this.credentials);
    child.versions = structuredClone(this.versions);
    child.auditEvents = structuredClone(this.auditEvents);
    child.profileBindings = structuredClone(this.profileBindings);
    child.failAudit = this.failAudit;
    child.dispatchProof = this.dispatchProof === null ? null : structuredClone(this.dispatchProof);

    const result = await work(child);
    this.accounts = child.accounts;
    this.credentials = child.credentials;
    this.versions = child.versions;
    this.auditEvents = child.auditEvents;
    this.profileBindings = child.profileBindings;
    this.failAudit = child.failAudit;
    this.dispatchProof = child.dispatchProof;
    return result;
  }

  async createTenantByokProfileAccount(input: PersistedTenantByokProfileAccountInput): Promise<void> {
    this.profileBindings.push(structuredClone(input));
  }
}

class TestSealingKms implements ProviderCredentialSealingKms {
  private sequence = 0;

  async generateDataKey(_request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = Buffer.alloc(32, ++this.sequence);
    return { plaintextKey, ciphertextBlob: Buffer.from(`wrapped-${this.sequence}`, 'utf8') };
  }
}

async function call(
  handler: ReturnType<typeof createCustomerByokHttpHandler>,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly body?: unknown;
    readonly authenticated?: boolean;
    readonly csrf?: boolean;
  } = {},
): Promise<{ readonly handled: boolean; readonly response: TestResponse; readonly payload: Record<string, unknown> }> {
  const bodyText = options.body === undefined ? '' : JSON.stringify(options.body);
  const request = Readable.from(bodyText === '' ? [] : [bodyText]) as unknown as IncomingMessage;
  Object.assign(request, {
    method: options.method ?? 'GET',
    url: options.path ?? '/console/api/v1/tenants/tenant-a/credentials',
    headers: {
      host: 'console.example.test',
      ...(options.authenticated === false ? {} : { cookie: 'mr_saas_session=session-a' }),
      ...(options.csrf === false
        ? {}
        : {
            cookie: `${options.authenticated === false ? '' : 'mr_saas_session=session-a; '}mr_saas_csrf=csrf-a`,
            origin: ORIGIN,
            'x-csrf-token': 'csrf-a',
          }),
      ...(bodyText === ''
        ? {}
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bodyText)) }),
    },
    socket: { remoteAddress: '203.0.113.10' },
  });
  const response = new TestResponse();
  const handled = await handler(request, response as unknown as ServerResponse);
  const payload = response.body ? (JSON.parse(response.body) as Record<string, unknown>) : {};
  return { handled, response, payload };
}

test('creates only a tenant BYOK credential from session scope and never returns its secret', async () => {
  const state = fixture();
  const result = await call(state.handler, {
    method: 'POST',
    body: {
      displayName: 'Primary key',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'cn-mainland',
      purpose: 'inference',
      model: 'model-a',
      endpoint: 'chat-completions',
      secret: SECRET,
    },
  });

  assert.equal(result.response.statusCode, 201);
  assert.deepEqual(state.calls.contextInputs, [{ userId: 'user-a', tenantId: 'tenant-a' }]);
  assert.equal(state.calls.createInputs.length, 1);
  const createInput = state.calls.createInputs[0] as CreateTenantByokCredentialInput;
  assert.deepEqual(createInput.context, {
    userId: 'user-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    tenantRole: 'owner',
    projectRole: 'owner',
  });
  const accountInput = createInput.account as Record<string, unknown>;
  assert.equal(accountInput.rightsId, 'rights-a');
  assert.equal(accountInput.rightsVersion, 3);
  assert.deepEqual(accountInput.capability, { model: 'model-a', endpoint: 'chat-completions', version: 1 });
  assert.equal(Object.hasOwn(accountInput, 'ownerKind'), false);
  assert.equal(Object.hasOwn(accountInput, 'tenantId'), false);
  assert.equal(Object.hasOwn(accountInput, 'supplyProfileId'), false);
  assert.equal(Object.hasOwn(accountInput, 'baseUrl'), false);
  assert.equal(createInput.evidenceReference, 'evidence-a');
  assert.equal(createInput.evidenceSha256, 'a'.repeat(64));
  assert.deepEqual(createInput.audit, {
    actorUserId: 'user-a',
    entryPoint: 'customer_byok_http',
    sourceIp: '203.0.113.10',
    userAgent: null,
    requestId: createInput.audit.requestId,
  });
  assert.equal(createInput.audit.requestId?.startsWith('byok_'), true);
  assert.deepEqual(state.calls.profileInputs, [
    { userId: 'user-a', tenantId: 'tenant-a', projectId: 'project-a', mode: 'byok' },
  ]);
  assert.deepEqual(state.calls.rightsQuery, { providerId: 'provider-a', productId: 'product-a', limit: 100 });
  assert.deepEqual([...(state.calls.secretBuffers[0] as Uint8Array)], new Array(Buffer.byteLength(SECRET)).fill(0));
  assert.equal(result.response.body.includes(SECRET), false);
  assert.equal(result.response.body.toLowerCase().includes('envelope'), false);
  assert.equal(result.response.headers['cache-control'], 'no-store');
  assert.equal((result.payload.data as { credential: { supplyMode: string } }).credential.supplyMode, 'byok');
});

test('BYOK create and audited credential mutations roll back atomically when audit writes fail', async () => {
  const state = fixture();
  const repository = new AtomicTestRepository();
  repository.failAudit = true;
  const supply = new ProviderSupplyService({} as SaasDatabase, {
    repository,
    sealingKms: new TestSealingKms(),
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
    supplyProfileResolver: state.supplyProfileResolver,
  });
  const handedOffBuffers: Uint8Array[] = [];
  const createCredential = supply.createTenantByokCredential.bind(supply);
  supply.createTenantByokCredential = async (input) => {
    handedOffBuffers.push(input.secret);
    return createCredential(input);
  };
  const replaceSecret = supply.replaceTenantProviderCredentialSecret.bind(supply);
  supply.replaceTenantProviderCredentialSecret = async (input) => {
    handedOffBuffers.push(input.secret);
    return replaceSecret(input);
  };
  const handler = createCustomerByokHttpHandler({
    service: state.identity,
    supplyService: supply,
    catalog: state.catalog,
    supplyProfileResolver: state.supplyProfileResolver,
    publicOrigin: ORIGIN,
    now: () => NOW,
  });
  const createBody = {
    displayName: 'Primary key',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    model: 'model-a',
    endpoint: 'chat-completions',
    secret: SECRET,
  };

  const rejectedCreate = await call(handler, { method: 'POST', body: createBody });
  assert.equal(rejectedCreate.response.statusCode, 500, JSON.stringify(rejectedCreate.payload));
  assert.equal((rejectedCreate.payload.error as { code: string }).code, 'SUPPLY_STORAGE_ERROR');
  assert.equal(repository.accounts.length, 0);
  assert.equal(repository.credentials.length, 0);
  assert.equal(repository.versions.length, 0);
  assert.equal(repository.profileBindings.length, 0);
  assert.equal(repository.auditEvents.length, 0);
  assert.deepEqual([...(handedOffBuffers[0] as Uint8Array)], new Array(Buffer.byteLength(SECRET)).fill(0));

  repository.failAudit = false;
  const created = await call(handler, { method: 'POST', body: createBody });
  assert.equal(created.response.statusCode, 201);
  assert.equal(repository.accounts.length, 1);
  assert.equal(repository.credentials.length, 1);
  assert.equal(repository.versions.length, 1);
  assert.equal(repository.profileBindings.length, 1);
  assert.equal(repository.profileBindings[0]?.supplyProfileId, 'profile-a');
  assert.equal(repository.auditEvents.length, 3);
  assert.equal(repository.auditEvents[0]?.action, 'provider_supply.account.created');
  assert.equal(repository.auditEvents[1]?.action, 'provider_supply.credential.created');
  assert.equal(repository.auditEvents[2]?.action, 'tenant_profile_account.bound');

  let credential = repository.credentials[0];
  assert.ok(credential);
  Object.assign(credential, { status: 'active', validationState: 'verified' });
  const auditCount = repository.auditEvents.length;
  repository.failAudit = true;

  const rotation = await call(handler, {
    method: 'PUT',
    path: `/console/api/v1/tenants/tenant-a/credentials/${credential.id}/secret`,
    body: { expectedVersion: 1, secret: 'replacement-secret' },
  });
  assert.equal(rotation.response.statusCode, 500);
  assert.equal(credential.currentVersion, 1);
  assert.equal(repository.versions.length, 1);
  assert.equal(repository.auditEvents.length, auditCount);
  assert.deepEqual(
    [...(handedOffBuffers.at(-1) as Uint8Array)],
    new Array(Buffer.byteLength('replacement-secret')).fill(0),
  );

  const base = `/console/api/v1/tenants/tenant-a/credentials/${credential.id}`;
  const rejectedDisable = await call(handler, {
    method: 'POST',
    path: `${base}/disable`,
    body: { expectedAuthzVersion: credential.authzVersion },
  });
  assert.equal(rejectedDisable.response.statusCode, 500);
  assert.equal(credential.status, 'active');
  assert.equal(credential.authzVersion, 2);
  assert.equal(repository.auditEvents.length, auditCount);

  repository.failAudit = false;
  const disabled = await call(handler, {
    method: 'POST',
    path: `${base}/disable`,
    body: { expectedAuthzVersion: credential.authzVersion },
  });
  assert.equal(disabled.response.statusCode, 200);
  credential = repository.credentials[0];
  assert.ok(credential);
  assert.equal(credential.status, 'disabled');
  assert.equal(credential.authzVersion, 3);
  repository.failAudit = true;

  const rejectedEnable = await call(handler, {
    method: 'POST',
    path: `${base}/enable`,
    body: { expectedAuthzVersion: credential.authzVersion },
  });
  assert.equal(rejectedEnable.response.statusCode, 500);
  assert.equal(credential.status, 'disabled');
  assert.equal(credential.authzVersion, 3);

  repository.failAudit = false;
  const enabled = await call(handler, {
    method: 'POST',
    path: `${base}/enable`,
    body: { expectedAuthzVersion: credential.authzVersion },
  });
  assert.equal(enabled.response.statusCode, 200);
  credential = repository.credentials[0];
  assert.ok(credential);
  assert.equal(credential.status, 'active');
  assert.equal(credential.authzVersion, 4);
  repository.failAudit = true;

  const rejectedRevoke = await call(handler, {
    method: 'POST',
    path: `${base}/revoke`,
    body: { expectedAuthzVersion: credential.authzVersion },
  });
  assert.equal(rejectedRevoke.response.statusCode, 500);
  assert.equal(credential.status, 'active');
  assert.equal(credential.authzVersion, 4);
  assert.equal(repository.auditEvents.length, auditCount + 2);
});

test('rechecks entitlement inside the mutation transaction after the HTTP preflight', async () => {
  const state = fixture();
  const repository = new AtomicTestRepository();
  let resolverCalls = 0;
  let rejectedResolverCall: number | undefined;
  const resolver = {
    async resolve() {
      resolverCalls += 1;
      return resolverCalls === rejectedResolverCall ? null : BYOK_ENTITLEMENT;
    },
  };
  const supply = new ProviderSupplyService({} as SaasDatabase, {
    repository,
    sealingKms: new TestSealingKms(),
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
    supplyProfileResolver: resolver,
  });
  const handler = createCustomerByokHttpHandler({
    service: state.identity,
    supplyService: supply,
    catalog: state.catalog,
    supplyProfileResolver: resolver,
    publicOrigin: ORIGIN,
    now: () => NOW,
  });
  const created = await call(handler, {
    method: 'POST',
    body: {
      displayName: 'Primary key',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'cn-mainland',
      purpose: 'inference',
      model: 'model-a',
      endpoint: 'chat-completions',
      secret: SECRET,
    },
  });
  assert.equal(created.response.statusCode, 201);
  const credential = repository.credentials[0];
  assert.ok(credential);
  const auditCount = repository.auditEvents.length;

  rejectedResolverCall = resolverCalls + 2;
  const rotation = await call(handler, {
    method: 'PUT',
    path: `/console/api/v1/tenants/tenant-a/credentials/${credential.id}/secret`,
    body: { expectedVersion: 1, secret: 'replacement-secret' },
  });
  assert.equal(rotation.response.statusCode, 409);
  assert.equal((rotation.payload.error as { code: string }).code, 'CREDENTIAL_UNAVAILABLE');
  assert.equal(credential.currentVersion, 1);
  assert.equal(repository.versions.length, 1);
  assert.equal(repository.auditEvents.length, auditCount);

  rejectedResolverCall = resolverCalls + 2;
  const lifecycle = await call(handler, {
    method: 'POST',
    path: `/console/api/v1/tenants/tenant-a/credentials/${credential.id}/disable`,
    body: { expectedAuthzVersion: credential.authzVersion },
  });
  assert.equal(lifecycle.response.statusCode, 409);
  assert.equal((lifecycle.payload.error as { code: string }).code, 'CREDENTIAL_UNAVAILABLE');
  assert.equal(credential.status, 'pending');
  assert.equal(credential.authzVersion, 2);
  assert.equal(repository.auditEvents.length, auditCount);
});

test('rejects caller supplied tenant, owner, profile, validation, and upstream URL fields', async () => {
  const state = fixture();
  const base = {
    displayName: 'Primary key',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    model: 'model-a',
    endpoint: 'chat-completions',
    secret: SECRET,
  };
  for (const extra of [
    { tenantId: 'tenant-b' },
    { ownerKind: 'platform' },
    { owner: 'platform' },
    { profileId: 'profile-b' },
    { supplyProfileId: 'profile-b' },
    { supplyMode: 'platform' },
    { validationState: 'verified' },
    { baseUrl: 'http://127.0.0.1:11434' },
    { upstreamUrl: 'http://127.0.0.1:11434' },
  ]) {
    const result = await call(state.handler, { method: 'POST', body: { ...base, ...extra } });
    assert.equal(result.response.statusCode, 400);
  }
  assert.equal(state.calls.createInputs.length, 0);
});

test('lists tenant scoped redacted metadata even if the supply adapter returns unrelated owners', async () => {
  const state = fixture({ leakOtherTenants: true });
  state.credentials.set('credential-a', makeCredential());
  state.credentials.set(
    'credential-b',
    makeCredential({ id: 'credential-b', tenantId: 'tenant-b', accountId: 'account-b' }),
  );
  state.credentials.set(
    'credential-platform',
    makeCredential({ id: 'credential-platform', ownerKind: 'platform', tenantId: null, supplyMode: 'platform' }),
  );
  const result = await call(state.handler);
  assert.equal(result.response.statusCode, 200);
  const payloadText = result.response.body;
  assert.equal(payloadText.includes('credential-a'), true);
  assert.equal(payloadText.includes('credential-b'), false);
  assert.equal(payloadText.includes('credential-platform'), false);
  assert.equal(payloadText.includes(SECRET), false);
  assert.deepEqual(state.calls.listFilters[0], { ownerKind: 'tenant', tenantId: 'tenant-a' });
});

test('does not read or mutate a credential belonging to another tenant', async () => {
  const state = fixture();
  state.credentials.set(
    'credential-b',
    makeCredential({ id: 'credential-b', tenantId: 'tenant-b', accountId: 'account-b' }),
  );
  const read = await call(state.handler, {
    path: '/console/api/v1/tenants/tenant-a/credentials/credential-b',
  });
  assert.equal(read.response.statusCode, 404);
  const wrongTenant = await call(state.handler, {
    path: '/console/api/v1/tenants/tenant-b/credentials',
  });
  assert.equal(wrongTenant.response.statusCode, 403);
  const changed = await call(state.handler, {
    method: 'POST',
    path: '/console/api/v1/tenants/tenant-a/credentials/credential-b/revoke',
    body: { expectedAuthzVersion: 1 },
  });
  assert.equal(changed.response.statusCode, 404);
  assert.equal(state.calls.lifecycleInputs.length, 0);
});

test('replaces a Secret only with the matching expected version and returns metadata', async () => {
  const state = fixture();
  state.credentials.set('credential-a', makeCredential({ validationState: 'verified', status: 'active' }));
  const secretRead = await call(state.handler, {
    path: '/console/api/v1/tenants/tenant-a/credentials/credential-a/secret',
  });
  assert.equal(secretRead.response.statusCode, 405);
  const result = await call(state.handler, {
    method: 'PUT',
    path: '/console/api/v1/tenants/tenant-a/credentials/credential-a/secret',
    body: { expectedVersion: 1, secret: SECRET },
  });
  assert.equal(result.response.statusCode, 200);
  const input = state.calls.replaceInputs[0] as {
    context: TenantContext;
    credential: { ownerKind: string; tenantId: string; accountId: string; credentialId: string };
    expectedVersion: number;
    audit: { actorUserId: string };
  };
  assert.equal(input.context.userId, 'user-a');
  assert.equal(input.context.tenantId, 'tenant-a');
  assert.equal(input.audit.actorUserId, 'user-a');
  assert.deepEqual(input.credential, {
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    version: 1,
  });
  assert.equal(input.expectedVersion, 1);
  assert.deepEqual([...(state.calls.secretBuffers[0] as Uint8Array)], new Array(Buffer.byteLength(SECRET)).fill(0));
  assert.equal(result.response.body.includes(SECRET), false);
  assert.equal((result.payload.data as { credential: { currentVersion: number } }).credential.currentVersion, 2);

  const conflict = await call(state.handler, {
    method: 'PUT',
    path: '/console/api/v1/tenants/tenant-a/credentials/credential-a/secret',
    body: { expectedVersion: 1, secret: 'replacement' },
  });
  assert.equal(conflict.response.statusCode, 409);
  assert.equal((conflict.payload.error as { code: string }).code, 'CREDENTIAL_VERSION_CONFLICT');
});

test('supports CAS disable, restore, and terminal revoke transitions', async () => {
  const state = fixture();
  state.credentials.set(
    'credential-a',
    makeCredential({ status: 'active', validationState: 'verified', authzVersion: 4 }),
  );
  const base = '/console/api/v1/tenants/tenant-a/credentials/credential-a';
  const disabled = await call(state.handler, {
    method: 'POST',
    path: `${base}/disable`,
    body: { expectedAuthzVersion: 4 },
  });
  assert.equal(disabled.response.statusCode, 200);
  assert.equal((disabled.payload.data as { credential: { status: string } }).credential.status, 'disabled');
  const enabled = await call(state.handler, {
    method: 'POST',
    path: `${base}/enable`,
    body: { expectedAuthzVersion: 5 },
  });
  assert.equal(enabled.response.statusCode, 200);
  assert.equal((enabled.payload.data as { credential: { status: string } }).credential.status, 'active');
  const revoked = await call(state.handler, {
    method: 'POST',
    path: `${base}/revoke`,
    body: { expectedAuthzVersion: 6 },
  });
  assert.equal(revoked.response.statusCode, 200);
  assert.equal((revoked.payload.data as { credential: { status: string } }).credential.status, 'revoked');
  const restoreRevoked = await call(state.handler, {
    method: 'POST',
    path: `${base}/enable`,
    body: { expectedAuthzVersion: 7 },
  });
  assert.equal(restoreRevoked.response.statusCode, 409);
  assert.deepEqual(
    state.calls.lifecycleInputs.map((entry) => (entry as { action: string }).action),
    ['disable', 'enable', 'revoke', 'enable'],
  );
});

test('requires an authenticated session and CSRF proof for writes', async () => {
  const state = fixture();
  const unauthenticated = await call(state.handler, { authenticated: false });
  assert.equal(unauthenticated.response.statusCode, 401);
  const missingCsrf = await call(state.handler, {
    method: 'POST',
    csrf: false,
    body: { expectedAuthzVersion: 1 },
  });
  assert.equal(missingCsrf.response.statusCode, 403);
  assert.equal(state.calls.createInputs.length, 0);
});

test('fails closed when no current active BYOK right matches', async () => {
  const state = fixture({ rights: [makeRights({ status: 'revoked' })] });
  const result = await call(state.handler, {
    method: 'POST',
    body: {
      displayName: 'Primary key',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'cn-mainland',
      purpose: 'inference',
      model: 'model-a',
      endpoint: 'chat-completions',
      secret: SECRET,
    },
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal(state.calls.createInputs.length, 0);
});

test('fails closed when the active entitlement or unique authorized profile cannot be resolved', async () => {
  const body = {
    displayName: 'Primary key',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    model: 'model-a',
    endpoint: 'chat-completions',
    secret: SECRET,
  };
  const scenarios = [
    { options: { entitlement: null }, status: 403, code: 'BYOK_ENTITLEMENT_REQUIRED' },
    { options: { profileResolverUnavailable: true }, status: 503, code: 'BYOK_PROFILE_UNAVAILABLE' },
    {
      options: { entitlement: { ...BYOK_ENTITLEMENT, profileId: '' } },
      status: 503,
      code: 'BYOK_PROFILE_UNAVAILABLE',
    },
    {
      options: { entitlement: { ...BYOK_ENTITLEMENT, allowedModels: ['other-model'] } },
      status: 403,
      code: 'BYOK_MODEL_NOT_ENTITLED',
    },
  ] as const;

  for (const scenario of scenarios) {
    const state = fixture(scenario.options);
    const result = await call(state.handler, { method: 'POST', body });
    assert.equal(result.response.statusCode, scenario.status);
    assert.equal((result.payload.error as { code: string }).code, scenario.code);
    assert.equal(state.calls.createInputs.length, 0);
  }
});

test('requires an approved verified BYOK capability for creation', async () => {
  for (const capabilities of [
    [],
    [makeCapability({ validationState: 'failed' })],
    [makeCapability({ supportLevel: 'unsupported' })],
    [makeCapability(), makeCapability()],
  ]) {
    const state = fixture({ capabilities });
    const result = await call(state.handler, {
      method: 'POST',
      body: {
        displayName: 'Primary key',
        providerId: 'provider-a',
        productId: 'product-a',
        credentialType: 'api-key',
        region: 'cn-mainland',
        purpose: 'inference',
        model: 'model-a',
        endpoint: 'chat-completions',
        secret: SECRET,
      },
    });
    assert.equal(result.response.statusCode, 403);
    assert.equal((result.payload.error as { code: string }).code, 'CAPABILITY_NOT_AVAILABLE');
    assert.equal(state.calls.createInputs.length, 0);
  }
});

test('allows only tenant owners and admins to manage customer BYOK credentials', async () => {
  const admin = fixture({ tenantRole: 'admin' });
  const allowed = await call(admin.handler, {
    method: 'POST',
    body: {
      displayName: 'Primary key',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'cn-mainland',
      purpose: 'inference',
      model: 'model-a',
      endpoint: 'chat-completions',
      secret: SECRET,
    },
  });
  assert.equal(allowed.response.statusCode, 201);

  const developer = fixture({ tenantRole: 'developer' });
  const denied = await call(developer.handler, {
    method: 'POST',
    body: {
      displayName: 'Primary key',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'cn-mainland',
      purpose: 'inference',
      model: 'model-a',
      endpoint: 'chat-completions',
      secret: SECRET,
    },
  });
  assert.equal(denied.response.statusCode, 403);
  assert.equal(developer.calls.createInputs.length, 0);
});

test('fails closed on BYOK entitlement loss for existing credential mutations', async () => {
  const state = fixture({ entitlement: null });
  state.credentials.set('credential-a', makeCredential({ status: 'active', validationState: 'verified' }));
  const result = await call(state.handler, {
    method: 'POST',
    path: '/console/api/v1/tenants/tenant-a/credentials/credential-a/disable',
    body: { expectedAuthzVersion: 1 },
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal((result.payload.error as { code: string }).code, 'BYOK_ENTITLEMENT_REQUIRED');
  assert.equal(state.calls.lifecycleInputs.length, 0);
});
