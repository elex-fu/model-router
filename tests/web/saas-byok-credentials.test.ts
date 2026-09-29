import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseTenantByokCredential, SaasApiError, type SafeTenant, saasClient } from '../../web/src/api/saas-client.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;
let consoleFeature: typeof import('../../web/src/features/saas-console.tsx');
let reactQuery: typeof import('@tanstack/react-query');
let reactRouter: typeof import('react-router-dom');

before(async () => {
  [consoleFeature, reactQuery, reactRouter] = await Promise.all([
    import('../../web/src/features/saas-console.tsx'),
    import('@tanstack/react-query'),
    import('react-router-dom'),
  ]);
});

after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

function credential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'credential-one',
    supplyMode: 'byok',
    account: {
      id: 'account-one',
      displayName: 'Production provider',
      providerId: 'provider-one',
      productId: 'product-one',
      credentialType: 'api-key',
      region: 'global',
      capabilities: [{ model: 'model-one', endpoint: 'messages', version: 1 }],
      status: 'active',
      validationState: 'unverified',
      lastValidatedAt: null,
      authzVersion: 4,
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
      disabledAt: null,
      revokedAt: null,
      purpose: 'must-not-leak',
    },
    status: 'active',
    validationState: 'unverified',
    secretConfigured: true,
    currentVersion: 2,
    expiresAt: null,
    authzVersion: 5,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    disabledAt: null,
    revokedAt: null,
    secret: 'fake-test-secret-must-not-leak',
    ...overrides,
  };
}

function renderCredentialPage(
  role: SafeTenant['role'] = 'owner',
  credentialItems: Record<string, unknown>[] | null = [credential({ validationState: 'failed' })],
  listError?: SaasApiError,
) {
  const queryClient = new reactQuery.QueryClient({
    defaultOptions: { queries: { refetchOnMount: false, retry: false } },
  });
  queryClient.setQueryData(
    ['saas-console', 'tenants'],
    [
      {
        id: 'tenant-one',
        name: 'Tenant One',
        slug: 'tenant-one',
        status: 'active',
        role,
        defaultProjectId: 'project-default',
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      } satisfies SafeTenant,
    ],
  );
  const credentialQueryKey = ['saas-console', 'byok-credentials', 'tenant-one'];
  if (credentialItems !== null) {
    queryClient.setQueryData(credentialQueryKey, credentialItems.map(parseTenantByokCredential));
  }
  if (listError) {
    queryClient.setQueryDefaults(credentialQueryKey, { refetchOnMount: false });
    queryClient.getQueryCache().find({ queryKey: credentialQueryKey })?.setState({ status: 'error', error: listError });
  }
  const html = renderToStaticMarkup(
    React.createElement(
      reactQuery.QueryClientProvider,
      { client: queryClient },
      React.createElement(
        reactRouter.MemoryRouter,
        null,
        React.createElement(consoleFeature.ByokCredentialsPage, { onLogout: async () => {} }),
      ),
    ),
  );
  queryClient.clear();
  return html;
}

test('tenant BYOK client uses authenticated tenant-scoped routes and CSRF for writes', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=csrf-token' },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const data =
      calls.length === 1
        ? { items: [credential()] }
        : {
            credential: credential(),
            version: { version: 3, status: 'active', createdAt: '2026-09-29T00:00:00.000Z', expiresAt: null },
          };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const listed = await saasClient.getTenantByokCredentials('tenant/one');
  const created = await saasClient.createTenantByokCredential('tenant/one', {
    displayName: 'Production provider',
    providerId: 'provider-one',
    productId: 'product-one',
    credentialType: 'api-key',
    region: 'global',
    purpose: 'inference',
    model: 'model-one',
    endpoint: 'messages',
    secret: 'fake-request-secret',
  });
  const rotated = await saasClient.replaceTenantByokCredentialSecret('tenant/one', 'credential/one', {
    expectedVersion: 2,
    secret: 'fake-rotation-secret',
  });
  await saasClient.disableTenantByokCredential('tenant/one', 'credential/one', { expectedAuthzVersion: 5 });
  await saasClient.enableTenantByokCredential('tenant/one', 'credential/one', { expectedAuthzVersion: 6 });
  await saasClient.revokeTenantByokCredential('tenant/one', 'credential/one', { expectedAuthzVersion: 7 });

  assert.equal(listed.length, 1);
  assert.equal('secret' in (listed.at(0) ?? {}), false);
  assert.equal('secret' in created.credential, false);
  assert.equal('secret' in rotated.credential, false);
  assert.equal('purpose' in created.credential.account, false);
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    displayName: 'Production provider',
    providerId: 'provider-one',
    productId: 'product-one',
    credentialType: 'api-key',
    region: 'global',
    purpose: 'inference',
    model: 'model-one',
    endpoint: 'messages',
    secret: 'fake-request-secret',
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/console/api/v1/tenants/tenant%2Fone/credentials',
      '/console/api/v1/tenants/tenant%2Fone/credentials',
      '/console/api/v1/tenants/tenant%2Fone/credentials/credential%2Fone/secret',
      '/console/api/v1/tenants/tenant%2Fone/credentials/credential%2Fone/disable',
      '/console/api/v1/tenants/tenant%2Fone/credentials/credential%2Fone/enable',
      '/console/api/v1/tenants/tenant%2Fone/credentials/credential%2Fone/revoke',
    ],
  );
  const methods = calls.map((call) => call.init.method ?? 'GET');
  assert.deepEqual(methods, ['GET', 'POST', 'PUT', 'POST', 'POST', 'POST']);
  assert.equal(new Headers(calls[0]?.init.headers).get('x-csrf-token'), null);
  for (const call of calls.slice(1)) assert.equal(new Headers(call.init.headers).get('x-csrf-token'), 'csrf-token');
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), { expectedVersion: 2, secret: 'fake-rotation-secret' });
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), { expectedAuthzVersion: 5 });
  assert.equal(calls[1]?.init.credentials, 'same-origin');
});

test('credential DTO parsing drops all unrecognized fields and rejects non-BYOK records', () => {
  const parsed = parseTenantByokCredential(credential());
  assert.equal(parsed.validationState, 'unverified');
  assert.equal('secret' in parsed, false);
  assert.equal('purpose' in parsed.account, false);
  assert.throws(
    () => parseTenantByokCredential({ ...credential(), supplyMode: 'platform' }),
    (error: unknown) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('changing the Provider or product clears the create form Secret', () => {
  assert.deepEqual(
    consoleFeature.updateByokSecretForScopeChange(
      { providerId: 'provider-one', productId: 'product-one' },
      { providerId: 'provider-two', productId: 'product-one' },
      'fake-provider-one-secret',
    ),
    { secret: '', scopeChanged: true },
  );
  assert.deepEqual(
    consoleFeature.updateByokSecretForScopeChange(
      { providerId: 'provider-one', productId: 'product-one' },
      { providerId: 'provider-one', productId: 'product-two' },
      'fake-provider-one-secret',
    ),
    { secret: '', scopeChanged: true },
  );
  assert.deepEqual(
    consoleFeature.updateByokSecretForScopeChange(
      { providerId: 'provider-one', productId: 'product-one' },
      { providerId: 'provider-one', productId: 'product-one' },
      'fake-provider-one-secret',
    ),
    { secret: 'fake-provider-one-secret', scopeChanged: false },
  );
});

test('Secret write errors discard echoed response details and network messages', async () => {
  const marker = 'fake-sensitive-request-secret';
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { code: marker, message: marker, details: { secret: marker } },
        data: { secret: marker },
      }),
      { status: 409 },
    );
  await assert.rejects(
    saasClient.createTenantByokCredential('tenant-one', {
      displayName: 'Production provider',
      providerId: 'provider-one',
      productId: 'product-one',
      credentialType: 'api-key',
      region: 'global',
      purpose: 'inference',
      model: 'model-one',
      endpoint: 'messages',
      secret: marker,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SaasApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.details, undefined);
      assert.equal(error.data, undefined);
      return true;
    },
  );

  globalThis.fetch = async () => {
    throw new Error(`network failed with request body ${marker}`);
  };
  await assert.rejects(
    saasClient.replaceTenantByokCredentialSecret('tenant-one', 'credential-one', {
      expectedVersion: 2,
      secret: marker,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SaasApiError);
      assert.equal(error.status, 0);
      assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
});

test('credential page selects only an authenticated tenant and shows real validation without a fake verify action', () => {
  const html = renderCredentialPage();
  assert.match(html, /<select aria-label="选择租户"/);
  assert.match(html, /href="\/console\/credentials"/);
  assert.match(html, /Tenant One/);
  assert.match(html, /默认项目 ID/);
  assert.match(html, /project-default/);
  assert.match(html, /凭证列表按租户显示/);
  assert.match(html, /type="password" autoComplete="off"/);
  assert.match(html, /验证失败/);
  assert.match(html, /暂不提供验证任务接口/);
  assert.match(html, /CAS 换 Secret/);
  assert.doesNotMatch(html, /fake-test-secret-must-not-leak|must-not-leak|<button[^>]*>验证/);
  assert.doesNotMatch(html, /name="tenantId"|aria-label="租户 ID"|name="projectId"/);
});

test('non-owner and non-admin roles cannot load or render tenant BYOK credentials', () => {
  for (const role of ['developer', 'billing', 'viewer'] as const) {
    const html = renderCredentialPage(role);
    assert.match(html, /只有租户 owner 或 admin 可以查看和管理凭证/);
    assert.doesNotMatch(html, /添加 BYOK 凭证|已登记凭证|CAS 换 Secret/);
  }
});

test('credential list presents loading, empty, and read-error states', () => {
  globalThis.fetch = () => new Promise<Response>(() => {});
  const loading = renderCredentialPage('owner', null);
  assert.match(loading, /class="skeleton" aria-label="加载中"/);

  const empty = renderCredentialPage('owner', []);
  assert.match(empty, /当前租户暂无 BYOK 凭证/);

  const failed = renderCredentialPage(
    'owner',
    [],
    new SaasApiError(503, 'CREDENTIALS_UNAVAILABLE', 'private error detail'),
  );
  assert.match(failed, /class="notice error" role="alert"/);
  assert.doesNotMatch(failed, /private error detail/);
});

test('credential response errors never expose response payload fields', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { items: [{ secret: 'fake-response-secret' }] } }), { status: 200 });
  await assert.rejects(
    saasClient.getTenantByokCredentials('tenant-one'),
    (error: unknown) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
  );

  const marker = 'fake-stored-secret-echo';
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: marker, message: marker, details: { secret: marker } } }), {
      status: 503,
    });
  await assert.rejects(saasClient.getTenantByokCredentials('tenant-one'), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.equal(error.message.includes(marker), false);
    assert.equal(error.code.includes(marker), false);
    assert.equal(error.details, undefined);
    return true;
  });

  const failed = renderCredentialPage(
    'owner',
    [],
    new SaasApiError(500, 'fake-response-secret', 'fake-response-secret'),
  );
  assert.doesNotMatch(failed, /fake-response-secret/);
});
