import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clearPlatformCsrfToken,
  PlatformApiError,
  type PlatformCapacityPolicy,
  type PlatformCapacityPolicyTarget,
  type PlatformCatalogRights,
  type PlatformCatalogRightsRevokeInput,
  type PlatformCatalogRightsVersionInput,
  type PlatformOperationsSummary,
  type PlatformPriceVersionRegistrationInput,
  type PlatformSupplyAccount,
  type PlatformSupplyCredential,
  type PlatformSupplyCredentialVersion,
  platformClient,
} from '../../web/src/api/saas-platform-client.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
let platformFeature: typeof import('../../web/src/features/saas-platform.tsx');

const CAPACITY_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAPACITY_PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAPACITY_API_KEY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CAPACITY_LIMITS = {
  requestsPerMinute: 120,
  tokensPerMinute: 90000,
  maxConcurrentRequests: 8,
};

const CAPACITY_TARGETS: PlatformCapacityPolicyTarget[] = [
  { scope: 'tenant', tenantId: CAPACITY_TENANT_ID },
  { scope: 'project', tenantId: CAPACITY_TENANT_ID, projectId: CAPACITY_PROJECT_ID },
  {
    scope: 'api_key',
    tenantId: CAPACITY_TENANT_ID,
    projectId: CAPACITY_PROJECT_ID,
    apiKeyId: CAPACITY_API_KEY_ID,
  },
];

function capacityPolicy(target: PlatformCapacityPolicyTarget, revision: string): PlatformCapacityPolicy {
  const base = {
    tenantId: target.tenantId,
    revision,
    revisionKind:
      target.scope === 'tenant'
        ? ('tenant_capacity_policy' as const)
        : target.scope === 'project'
          ? ('project_inference_policy' as const)
          : ('api_key_authz' as const),
    limits: CAPACITY_LIMITS,
    configured: true,
  };
  if (target.scope === 'tenant') return { ...base, scope: 'tenant' };
  if (target.scope === 'project') return { ...base, scope: 'project', projectId: target.projectId };
  return { ...base, scope: 'api_key', projectId: target.projectId, apiKeyId: target.apiKeyId };
}

const RIGHTS: PlatformCatalogRights = {
  rightsId: 'rights-a',
  version: 1,
  providerId: 'provider-a',
  productId: 'product-a',
  supplyMode: 'platform',
  region: 'cn-mainland',
  purpose: 'commercial-api',
  modelScope: ['model-a'],
  endpointScope: ['chat-completions'],
  effectiveAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  status: 'active',
  createdAt: '2026-09-28T00:00:00.000Z',
};

const VERSION_INPUT: PlatformCatalogRightsVersionInput = {
  rightsId: 'rights-a',
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  supplyMode: 'platform',
  region: 'cn-mainland',
  purpose: 'commercial-api',
  modelScope: ['model-a'],
  endpointScope: ['chat-completions'],
  effectiveAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  approvalReference: 'approval-1',
  evidenceReference: 'evidence-reference',
  evidenceSha256: 'a'.repeat(64),
  status: 'active',
};

const REVOKE_INPUT: PlatformCatalogRightsRevokeInput = {
  approvalReference: 'approval-revoke',
  evidenceReference: 'revocation-evidence',
  evidenceSha256: 'b'.repeat(64),
};

const SUPPLY_ACCOUNT: PlatformSupplyAccount = {
  ownerKind: 'platform',
  tenantId: null,
  supplyMode: 'platform',
  id: 'platform-account-a',
  displayName: 'Provider A production',
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  region: 'cn-mainland',
  purpose: 'commercial-api',
  rightsId: 'rights-a',
  rightsVersion: 1,
  capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
  status: 'pending',
  validationState: 'unverified',
  validationErrorCode: null,
  lastValidatedAt: null,
  authzVersion: 3,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  disabledAt: null,
  revokedAt: null,
};

const SUPPLY_CREDENTIAL_VERSION: PlatformSupplyCredentialVersion = {
  ownerKind: 'platform',
  tenantId: null,
  accountId: SUPPLY_ACCOUNT.id,
  credentialId: 'platform-credential-a',
  version: 1,
  status: 'active',
  envelopeSchemaVersion: 1,
  contextVersion: 1,
  algorithm: 'aes-256-gcm',
  kmsPurpose: 'provider-supply',
  wrappingRevision: 1,
  createdAt: '2026-09-29T00:00:00.000Z',
  expiresAt: null,
  retiredAt: null,
  revokedAt: null,
};

const SUPPLY_CREDENTIAL: PlatformSupplyCredential = {
  ownerKind: 'platform',
  tenantId: null,
  supplyMode: 'platform',
  id: SUPPLY_CREDENTIAL_VERSION.credentialId,
  accountId: SUPPLY_ACCOUNT.id,
  providerId: SUPPLY_ACCOUNT.providerId,
  productId: SUPPLY_ACCOUNT.productId,
  credentialType: SUPPLY_ACCOUNT.credentialType,
  status: 'pending',
  validationState: 'unverified',
  validationErrorCode: null,
  lastValidatedAt: null,
  currentVersion: 1,
  expiresAt: null,
  authzVersion: 5,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  disabledAt: null,
  revokedAt: null,
  versions: [SUPPLY_CREDENTIAL_VERSION],
};

const OPERATIONS_SUMMARY: PlatformOperationsSummary = {
  from: '2026-09-28T00:00:00.000Z',
  to: '2026-09-29T00:00:00.000Z',
  requests: {
    total: '12',
    byStatus: { pending: '1', succeeded: '9', failed: '1', unknown: '1' },
  },
  attempts: {
    total: '14',
    byStatus: { pending: '1', succeeded: '10', failed: '2', unknown: '1' },
  },
  activeProviderAccountLeaseCount: '3',
  metrics: {
    dataSource: 'postgresql_persisted_aggregates',
    snapshotAt: '2026-09-29T00:00:00.000Z',
    requests: {
      successPercent: '75.00',
      unknownPercent: '8.33',
      financialStatus: {
        notApplicable: '2',
        pending: '1',
        settled: '8',
        released: '0',
        reconciliationPending: '1',
      },
    },
    attempts: {
      successPercent: '71.43',
      unknownPercent: '7.14',
      responseHttp4xxCount: '2',
      responseHttp5xxCount: '1',
      responseStartLatencyMs: { sampleCount: '12', p50: '80', p95: '250' },
    },
    billingReservationBacklog: { reserved: '3', reconciliationPending: '1' },
    platformAccountHealth: {
      observationCount: '4',
      byState: { healthy: '2', degraded: '1', cooldown: '1', unhealthy: '0' },
      activeCooldownCount: '1',
      latestObservedAt: '2026-09-28T23:59:00.000Z',
    },
    paymentWebhookBacklog: { pending: '2', processing: '1', oldestUnprocessedAgeMs: '9000' },
    runtimeProbes: {
      postgresql: 'not_configured',
      redis: 'not_configured',
      kms: 'not_configured',
      worker: 'not_configured',
    },
  },
};

before(async () => {
  reactGlobal.React = React;
  platformFeature = await import('../../web/src/features/saas-platform.tsx');
});

after(() => {
  clearPlatformCsrfToken();
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

afterEach(() => {
  clearPlatformCsrfToken();
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

test('operations summary client parses additive persisted metrics and keeps exact decimal strings', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: OPERATIONS_SUMMARY }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const summary = await platformClient.getOpsSummary({
    from: OPERATIONS_SUMMARY.from,
    to: OPERATIONS_SUMMARY.to,
  });

  const requested = new URL(calls[0]?.url ?? '/missing', 'http://localhost');
  assert.equal(requested.pathname, '/admin/api/v1/ops/summary');
  assert.equal(requested.searchParams.get('from'), OPERATIONS_SUMMARY.from);
  assert.equal(requested.searchParams.get('to'), OPERATIONS_SUMMARY.to);
  assert.equal(summary.metrics?.requests.successPercent, '75.00');
  assert.equal(summary.metrics?.attempts.responseStartLatencyMs.p95, '250');
  assert.equal(summary.metrics?.runtimeProbes.redis, 'not_configured');
  assert.doesNotMatch(JSON.stringify(summary), /tenantId|requestId|credential|paymentOrder|secret/i);
});

test('operations summary client accepts the previous base-only response shape', async () => {
  const { metrics: _metrics, ...baseSummary } = OPERATIONS_SUMMARY;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: baseSummary }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const summary = await platformClient.getOpsSummary({ from: baseSummary.from, to: baseSummary.to });

  assert.equal(summary.requests.total, '12');
  assert.equal(summary.metrics, undefined);
});

test('operations page renders selectable periods, accessible loading and status states, and persisted KPI data', () => {
  const loading = renderToStaticMarkup(React.createElement(platformFeature.OperationsSummaryPanel));
  assert.match(loading, /aria-label="运营摘要统计范围"/);
  assert.match(loading, /最近 24 小时/);
  assert.match(loading, /最近 7 天/);
  assert.match(loading, /最近 31 天/);
  assert.match(loading, /role="status" aria-label="正在读取运营摘要"/);
  assert.match(loading, /不代表 PostgreSQL、Redis、KMS/);

  const ready = renderToStaticMarkup(
    React.createElement(platformFeature.OperationsSummaryContent, { summary: OPERATIONS_SUMMARY }),
  );
  assert.match(ready, /请求成功率/);
  assert.match(ready, /75\.00%/);
  assert.match(ready, /响应开始 P50/);
  assert.match(ready, /80 毫秒/);
  assert.match(ready, /钱包预留 · 待对账/);
  assert.match(ready, /Payment inbox · pending/);
  assert.match(ready, /role="list" aria-label="请求状态分布"/);
  assert.match(ready, /<meter[^>]+aria-label="请求成功占比"/);
  assert.match(ready, /未配置探针/);
  assert.match(ready, /首 Token\/上游首字节延迟/);
});

test('operations page presents empty observations and server authorization denial without metrics', async () => {
  const baseMetrics = OPERATIONS_SUMMARY.metrics;
  assert.ok(baseMetrics);
  const emptySummary: PlatformOperationsSummary = {
    ...OPERATIONS_SUMMARY,
    requests: { total: '0', byStatus: { pending: '0', succeeded: '0', failed: '0', unknown: '0' } },
    attempts: { total: '0', byStatus: { pending: '0', succeeded: '0', failed: '0', unknown: '0' } },
    activeProviderAccountLeaseCount: '0',
    metrics: {
      ...baseMetrics,
      requests: {
        successPercent: null,
        unknownPercent: null,
        financialStatus: {
          notApplicable: '0',
          pending: '0',
          settled: '0',
          released: '0',
          reconciliationPending: '0',
        },
      },
      attempts: {
        successPercent: null,
        unknownPercent: null,
        responseHttp4xxCount: '0',
        responseHttp5xxCount: '0',
        responseStartLatencyMs: { sampleCount: '0', p50: null, p95: null },
      },
      billingReservationBacklog: { reserved: '0', reconciliationPending: '0' },
      platformAccountHealth: {
        observationCount: '0',
        byState: { healthy: '0', degraded: '0', cooldown: '0', unhealthy: '0' },
        activeCooldownCount: '0',
        latestObservedAt: null,
      },
      paymentWebhookBacklog: { pending: '0', processing: '0', oldestUnprocessedAgeMs: null },
    },
  };
  const empty = renderToStaticMarkup(
    React.createElement(platformFeature.OperationsSummaryContent, { summary: emptySummary }),
  );
  assert.match(empty, /暂无请求或尝试记录/);
  assert.match(empty, /没有可显示的观察记录/);
  assert.match(empty, /缺少记录不表示账号健康/);
  assert.match(empty, /无待处理事件/);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { code: 'FORBIDDEN', message: 'must-not-leak-this-server-detail' },
      }),
      {
        status: 403,
        headers: { 'content-type': 'application/json' },
      },
    );
  let authorizationError: unknown;
  try {
    await platformClient.getOpsSummary({ from: OPERATIONS_SUMMARY.from, to: OPERATIONS_SUMMARY.to });
  } catch (error) {
    authorizationError = error;
  }
  assert.ok(authorizationError instanceof PlatformApiError);
  const denied = renderToStaticMarkup(
    React.createElement(platformFeature.PlatformErrorNotice, {
      error: authorizationError,
      title: '运营摘要读取失败',
    }),
  );
  assert.match(denied, /role="alert"/);
  assert.match(denied, /当前管理员角色未获准读取此内容/);
  assert.doesNotMatch(denied, /must-not-leak-this-server-detail|75\.00%|运营指标/);
});

test('platform error notice distinguishes invalid login credentials from expired sessions without rendering raw errors', async () => {
  const { PlatformApiError: FeaturePlatformApiError } = await import('../../web/src/api/saas-platform-client.ts');
  const poison = 'must-not-render-raw-error <img src=x onerror=alert(1)> csrf-secret';
  const invalidCredentials = '邮箱、密码或 MFA 验证码不正确。';
  const expiredSession = '平台管理员会话已失效，安全令牌已清理，请重新登录。';
  const forbidden = '当前管理员角色未获准读取此内容。访问由服务端授权决定，请联系平台管理员确认；页面显示的角色信息不会授予权限。';
  const cases: Array<{ error: unknown; message: string }> = [
    { error: new FeaturePlatformApiError(401, 'INVALID_CREDENTIALS', poison), message: invalidCredentials },
    { error: new FeaturePlatformApiError(401, 'UNAUTHENTICATED', poison), message: expiredSession },
    { error: new FeaturePlatformApiError(401, 'UNKNOWN_CODE', poison), message: expiredSession },
    { error: { status: 401, code: 'INVALID_CREDENTIALS', message: poison }, message: expiredSession },
    { error: new FeaturePlatformApiError(403, 'INVALID_CREDENTIALS', poison), message: forbidden },
    { error: new FeaturePlatformApiError(403, 'FORBIDDEN', poison), message: forbidden },
    { error: new FeaturePlatformApiError(503, 'MFA_UNAVAILABLE', poison), message: '平台 MFA 当前不可用，请联系运维人员。' },
  ];
  for (const { error, message } of cases) {
    const html = renderToStaticMarkup(
      React.createElement(platformFeature.PlatformErrorNotice, { error, title: '登录失败' }),
    );
    assert.equal(html, `<div class="notice error" role="alert"><strong>登录失败</strong><span>${message}</span></div>`);
    assert.doesNotMatch(html, /must-not-render-raw-error|onerror|csrf-secret|<img|&lt;img/);
  }
});

test('platform rights client uses explicit mutation routes, CSRF, and no actor or secret fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const callNumber = calls.length;
    const data =
      callNumber === 1
        ? { session: { userId: 'admin-user' }, csrfToken: 'csrf-token' }
        : { ...RIGHTS, version: callNumber === 2 ? 1 : 2, status: callNumber === 2 ? 'active' : 'revoked' };
    return new Response(JSON.stringify({ data }), {
      status: callNumber === 2 ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  await platformClient.registerRightsVersion(VERSION_INPUT);
  await platformClient.revokeRights('rights-a', REVOKE_INPUT);

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/admin/api/v1/auth/session',
      '/admin/api/v1/catalog/rights/versions',
      '/admin/api/v1/catalog/rights/rights-a/revoke',
    ],
  );
  assert.equal(new Headers(calls[0]?.init.headers).get('x-csrf-token'), null);
  assert.equal(new Headers(calls[1]?.init.headers).get('x-csrf-token'), 'csrf-token');
  assert.equal(new Headers(calls[2]?.init.headers).get('x-csrf-token'), 'csrf-token');
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), VERSION_INPUT);
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), REVOKE_INPUT);
  assert.equal(String(calls[1]?.init.body).includes('actorUserId'), false);
  assert.equal(String(calls[1]?.init.body).includes('secret'), false);
});

test('platform pricing client preserves exact rational strings and sends only server-resolvable registration fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const target = {
    publicModelId: 'public-model-1',
    publicModelVersion: 3,
    publicModelAlias: 'chat-model',
    displayName: 'Chat Model',
    providerId: 'provider-a',
    productId: 'product-a',
    resolvedModel: 'provider/model-v3',
    protocol: 'openai',
    endpoint: 'chat-completions',
    capabilityVersion: 7,
  };
  const version = (kind: 'customer' | 'supplier') => ({
    kind,
    id: 'price-version-1',
    version: 1,
    publicModelId: target.publicModelId,
    publicModelVersion: target.publicModelVersion,
    providerId: target.providerId,
    productId: target.productId,
    ...(kind === 'supplier' ? { resolvedModel: target.resolvedModel } : {}),
    protocol: target.protocol,
    endpoint: target.endpoint,
    currency: 'USD',
    commercialPolicyVersion: 'commercial-v1',
    calculatorVersion: 'calculator-v1',
    roundingVersion: 'rounding-v1',
    roundingMode: 'half_even',
    roundingBoundary: 'total',
    rates: {
      input: { numeratorMinorUnits: '9007199254740993', denominatorUnits: '1000000' },
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      output: { numeratorMinorUnits: '18014398509481985', denominatorUnits: '1000000' },
    },
    effectiveAt: '2026-09-29T00:00:00.000Z',
    expiresAt: null,
    definitionDigest: 'c'.repeat(64),
    createdAt: '2026-09-29T01:00:00.000Z',
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const data = url.endsWith('/auth/session')
      ? { session: { userId: 'admin-user' }, csrfToken: 'csrf-token' }
      : url.includes('/pricing/targets')
        ? { items: [target], nextCursor: null, hasMore: false }
        : url.includes('/pricing/versions')
          ? { items: [version('customer')], nextCursor: null, hasMore: false }
          : version(url.includes('/supplier-cost-versions') ? 'supplier' : 'customer');
    return new Response(JSON.stringify({ data }), {
      status: url.includes('/pricing/') && (init?.method ?? 'GET') === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  const targets = await platformClient.listPricingTargets({ kind: 'customer', limit: 25 });
  const history = await platformClient.listPriceVersionHistory({
    kind: 'customer',
    publicModelId: target.publicModelId,
    publicModelVersion: target.publicModelVersion,
    protocol: target.protocol,
    endpoint: target.endpoint,
    currency: 'USD',
  });
  const baseInput: PlatformPriceVersionRegistrationInput = {
    publicModelId: target.publicModelId,
    publicModelVersion: target.publicModelVersion,
    protocol: target.protocol,
    endpoint: target.endpoint,
    currency: 'USD',
    idempotencyKey: 'price-request-1',
    effectiveAt: '2026-09-29T00:00:00.000Z',
    commercialPolicyVersion: 'commercial-v1',
    calculatorVersion: 'calculator-v1',
    roundingVersion: 'rounding-v1',
    roundingMode: 'half_even',
    roundingBoundary: 'total',
    rates: {
      input: { numeratorMinorUnits: '9007199254740993', denominatorUnits: '1000000' },
      output: { numeratorMinorUnits: '18014398509481985', denominatorUnits: '1000000' },
    },
  };
  const untrustedInput = {
    ...baseInput,
    providerId: 'forged-provider',
    productId: 'forged-product',
    accountId: 'forged-account',
    resolvedModel: 'forged-model',
    audit: { actorUserId: 'forged-actor' },
  } as PlatformPriceVersionRegistrationInput & Record<string, unknown>;
  const customerPrice = await platformClient.registerCustomerPriceVersion(untrustedInput);
  const supplierPrice = await platformClient.registerSupplierCostVersion(untrustedInput);

  assert.equal(targets.items[0]?.resolvedModel, 'provider/model-v3');
  assert.equal(history.items[0]?.rates.input?.numeratorMinorUnits, '9007199254740993');
  assert.equal(customerPrice.rates.output?.numeratorMinorUnits, '18014398509481985');
  assert.equal(supplierPrice.resolvedModel, 'provider/model-v3');
  assert.equal(calls[1]?.url, '/admin/api/v1/pricing/targets?kind=customer&limit=25');
  assert.match(calls[2]?.url ?? '', /^\/admin\/api\/v1\/pricing\/versions\?/u);
  assert.equal(new Headers(calls[3]?.init.headers).get('x-csrf-token'), 'csrf-token');
  assert.equal(new Headers(calls[4]?.init.headers).get('x-csrf-token'), 'csrf-token');
  for (const call of calls.slice(3)) {
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    assert.equal(body.providerId, undefined);
    assert.equal(body.productId, undefined);
    assert.equal(body.accountId, undefined);
    assert.equal(body.resolvedModel, undefined);
    assert.equal(body.audit, undefined);
    assert.deepEqual(body.rates, baseInput.rates);
  }
});

test('platform pricing page gates controls by operations role and exposes exact-rate workflow', () => {
  const operations = renderToStaticMarkup(
    React.createElement(platformFeature.PricingPage, {
      me: { kind: 'ready', me: { userId: 'admin-user', roles: ['operations'] } },
    }),
  );
  assert.match(operations, /价格版本/);
  assert.match(operations, /读取可定价目标/);
  assert.match(operations, /精确有理数追加/);
  assert.match(operations, /不可变的精确有理数追加/);

  const readonly = renderToStaticMarkup(
    React.createElement(platformFeature.PricingPage, {
      me: { kind: 'ready', me: { userId: 'admin-user', roles: ['security'] } },
    }),
  );
  assert.match(readonly, /仅运营管理员可用/);
  assert.doesNotMatch(readonly, /读取可定价目标/);
});

test('rights page exposes mutations only to operations and superadmin roles', () => {
  const render = (roles: readonly ['operations' | 'superadmin' | 'security' | 'support-readonly']) =>
    renderToStaticMarkup(
      React.createElement(platformFeature.RightsPage, {
        me: { kind: 'ready', me: { userId: 'admin-user', roles: [...roles] } },
      }),
    );

  const operations = render(['operations']);
  assert.match(operations, /登记新版本/);
  assert.match(operations, /追加撤销版本/);
  assert.match(operations, /不会编辑既有版本/);

  const superadmin = render(['superadmin']);
  assert.match(superadmin, /登记新版本/);

  for (const role of [['security'], ['support-readonly']] as const) {
    const readonly = render(role);
    assert.doesNotMatch(readonly, /<h2>登记权益新版本<\/h2>|>登记新版本<|>追加撤销版本<\/button>/);
  }
});

test('capacity policy client uses selector and policy routes, preserves CAS revisions, and drops unapproved fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith('/auth/session')) {
      return new Response(JSON.stringify({ data: { session: { userId: 'admin-user' }, csrfToken: 'csrf-token' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/capacity/targets/')) {
      const id = url.includes('/api-keys')
        ? CAPACITY_API_KEY_ID
        : url.includes('/projects')
          ? CAPACITY_PROJECT_ID
          : CAPACITY_TENANT_ID;
      return new Response(
        JSON.stringify({
          data: { items: [{ id, name: 'must-not-return', secret: 'must-not-return' }], nextCursor: null },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    const target = CAPACITY_TARGETS.find((candidate) => {
      const suffix =
        candidate.scope === 'tenant'
          ? `/capacity/tenants/${candidate.tenantId}`
          : candidate.scope === 'project'
            ? `/capacity/tenants/${candidate.tenantId}/projects/${candidate.projectId}`
            : `/capacity/tenants/${candidate.tenantId}/projects/${candidate.projectId}/api-keys/${candidate.apiKeyId}`;
      return url.endsWith(suffix);
    });
    assert.ok(target);
    const expectedRevision = target.scope === 'tenant' ? '7' : target.scope === 'project' ? '13' : '23';
    const revision = init?.method === 'PUT' ? String(BigInt(expectedRevision) + 1n) : expectedRevision;
    return new Response(
      JSON.stringify({
        data: {
          ...capacityPolicy(target, revision),
          secret: 'must-not-return',
          apiKeySecret: 'must-not-return',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  const reads = await Promise.all(CAPACITY_TARGETS.map((target) => platformClient.getCapacityPolicy(target)));
  const updates = await Promise.all(
    CAPACITY_TARGETS.map((target, index) =>
      platformClient.updateCapacityPolicy(target, {
        expectedRevision: ['7', '13', '23'][index] as string,
        limits: CAPACITY_LIMITS,
        reason: 'incident_response',
      }),
    ),
  );
  const tenants = await platformClient.listCapacityPolicyTenants();
  const projects = await platformClient.listCapacityPolicyProjects(CAPACITY_TENANT_ID, CAPACITY_PROJECT_ID);
  const apiKeys = await platformClient.listCapacityPolicyApiKeys(
    CAPACITY_TENANT_ID,
    CAPACITY_PROJECT_ID,
    CAPACITY_API_KEY_ID,
  );

  assert.deepEqual(
    reads.map((record) => record.revision),
    ['7', '13', '23'],
  );
  assert.deepEqual(
    updates.map((record) => record.revision),
    ['8', '14', '24'],
  );
  assert.equal('secret' in (reads[2] ?? {}), false);
  assert.equal('apiKeySecret' in (reads[2] ?? {}), false);
  assert.deepEqual(tenants.items, [{ id: CAPACITY_TENANT_ID }]);
  assert.deepEqual(projects.items, [{ id: CAPACITY_PROJECT_ID }]);
  assert.deepEqual(apiKeys.items, [{ id: CAPACITY_API_KEY_ID }]);
  assert.equal('name' in (tenants.items[0] ?? {}), false);
  assert.equal('secret' in (apiKeys.items[0] ?? {}), false);

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/admin/api/v1/auth/session',
      `/admin/api/v1/capacity/tenants/${CAPACITY_TENANT_ID}`,
      `/admin/api/v1/capacity/tenants/${CAPACITY_TENANT_ID}/projects/${CAPACITY_PROJECT_ID}`,
      `/admin/api/v1/capacity/tenants/${CAPACITY_TENANT_ID}/projects/${CAPACITY_PROJECT_ID}/api-keys/${CAPACITY_API_KEY_ID}`,
      `/admin/api/v1/capacity/tenants/${CAPACITY_TENANT_ID}`,
      `/admin/api/v1/capacity/tenants/${CAPACITY_TENANT_ID}/projects/${CAPACITY_PROJECT_ID}`,
      `/admin/api/v1/capacity/tenants/${CAPACITY_TENANT_ID}/projects/${CAPACITY_PROJECT_ID}/api-keys/${CAPACITY_API_KEY_ID}`,
      '/admin/api/v1/capacity/targets/tenants',
      `/admin/api/v1/capacity/targets/tenants/${CAPACITY_TENANT_ID}/projects?cursor=${CAPACITY_PROJECT_ID}`,
      `/admin/api/v1/capacity/targets/tenants/${CAPACITY_TENANT_ID}/projects/${CAPACITY_PROJECT_ID}/api-keys?cursor=${CAPACITY_API_KEY_ID}`,
    ],
  );
  for (const call of calls.slice(4, 7)) {
    assert.equal(call.init.method, 'PUT');
    assert.equal(new Headers(call.init.headers).get('x-csrf-token'), 'csrf-token');
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      expectedRevision: call.url.includes('/api-keys/') ? '23' : call.url.includes('/projects/') ? '13' : '7',
      limits: CAPACITY_LIMITS,
      reason: 'incident_response',
    });
    assert.equal(String(call.init.body).includes('secret'), false);
  }
});

test('capacity policy selector UI offers bounded ID pickers only to operations and superadmins', () => {
  const render = (roles: readonly ['operations' | 'superadmin' | 'security' | 'support-readonly']) =>
    renderToStaticMarkup(
      React.createElement(platformFeature.CapacityPolicyPage, {
        me: { kind: 'ready', me: { userId: 'admin-user', roles: [...roles] } },
      }),
    );

  for (const role of [['operations'], ['superadmin']] as const) {
    const html = render(role);
    assert.match(html, /加载租户列表/);
    assert.match(html, /策略范围/);
    assert.match(html, /API key/);
    assert.match(html, /项目和 API key 列表按所选父级限定/);
    assert.doesNotMatch(html, /pattern="\[0-9a-fA-F\]\{8\}/);
  }
  for (const role of [['security'], ['support-readonly']] as const) {
    const html = render(role);
    assert.doesNotMatch(html, /加载租户列表|加载项目列表|加载 API key 列表/);
    assert.match(html, /仅运营管理员可用/);
  }
});

test('platform supply client uses exact routes, safe bodies, CSRF, and drops secrets/envelopes from DTOs', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const accountInput = {
    displayName: 'Provider A production',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'commercial-api',
    rightsId: 'rights-a',
    rightsVersion: 1,
    capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
  };
  const unsafeCredential = {
    ...SUPPLY_CREDENTIAL,
    secret: 'must-not-return',
    envelope: { ciphertext: 'must-not-return' },
    versions: [{ ...SUPPLY_CREDENTIAL_VERSION, envelope: { ciphertext: 'must-not-return' } }],
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    let data: unknown = SUPPLY_ACCOUNT;
    let status = 200;
    if (calls.length === 1) data = { session: { userId: 'admin-user' }, csrfToken: 'csrf-token' };
    else if (url.endsWith('/supply/accounts') && (init?.method ?? 'GET') === 'GET') data = [SUPPLY_ACCOUNT];
    else if (url.endsWith('/credentials') && (init?.method ?? 'GET') === 'GET') data = [unsafeCredential];
    else if (
      (init?.method ?? 'GET') === 'PUT' ||
      ((init?.method ?? 'GET') === 'POST' && url.endsWith('/credentials'))
    ) {
      data = { credential: unsafeCredential, version: SUPPLY_CREDENTIAL_VERSION };
      status = 201;
    } else if (url.includes('/credentials/') || url.includes('/accounts/')) {
      data = url.includes('/credentials/') ? unsafeCredential : SUPPLY_ACCOUNT;
    }
    return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
  };

  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  await platformClient.listSupplyAccounts();
  await platformClient.createSupplyAccount(accountInput);
  const credentials = await platformClient.listSupplyCredentials(SUPPLY_ACCOUNT.id);
  await platformClient.createSupplyCredential(SUPPLY_ACCOUNT.id, {
    secret: 'initial-secret',
    expiresAt: '2026-12-01T00:00:00.000Z',
  });
  await platformClient.rotateSupplyCredentialSecret(SUPPLY_CREDENTIAL.id, {
    expectedVersion: 1,
    secret: 'rotated-secret',
  });
  await platformClient.enableSupplyAccount(SUPPLY_ACCOUNT.id, { expectedAuthzVersion: 3 });
  await platformClient.disableSupplyAccount(SUPPLY_ACCOUNT.id, { expectedAuthzVersion: 3 });
  await platformClient.revokeSupplyAccount(SUPPLY_ACCOUNT.id, { expectedAuthzVersion: 3 });
  await platformClient.enableSupplyCredential(SUPPLY_CREDENTIAL.id, { expectedAuthzVersion: 5 });
  await platformClient.disableSupplyCredential(SUPPLY_CREDENTIAL.id, { expectedAuthzVersion: 5 });
  await platformClient.revokeSupplyCredential(SUPPLY_CREDENTIAL.id, { expectedAuthzVersion: 5 });

  assert.equal(credentials[0]?.status, 'pending');
  assert.equal(credentials[0]?.validationState, 'unverified');
  assert.equal('secret' in (credentials[0] ?? {}), false);
  assert.equal('envelope' in (credentials[0] ?? {}), false);
  assert.equal('envelope' in (credentials[0]?.versions?.[0] ?? {}), false);
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), accountInput);
  assert.deepEqual(JSON.parse(String(calls[4]?.init.body)), {
    secret: 'initial-secret',
    expiresAt: '2026-12-01T00:00:00.000Z',
  });
  assert.deepEqual(JSON.parse(String(calls[5]?.init.body)), { expectedVersion: 1, secret: 'rotated-secret' });
  assert.deepEqual(
    calls
      .slice(6)
      .map((call) => ({ url: call.url, method: call.init.method, body: JSON.parse(String(call.init.body)) })),
    [
      {
        url: `/admin/api/v1/supply/accounts/${SUPPLY_ACCOUNT.id}/enable`,
        method: 'POST',
        body: { expectedAuthzVersion: 3 },
      },
      {
        url: `/admin/api/v1/supply/accounts/${SUPPLY_ACCOUNT.id}/disable`,
        method: 'POST',
        body: { expectedAuthzVersion: 3 },
      },
      {
        url: `/admin/api/v1/supply/accounts/${SUPPLY_ACCOUNT.id}/revoke`,
        method: 'POST',
        body: { expectedAuthzVersion: 3 },
      },
      {
        url: `/admin/api/v1/supply/credentials/${SUPPLY_CREDENTIAL.id}/enable`,
        method: 'POST',
        body: { expectedAuthzVersion: 5 },
      },
      {
        url: `/admin/api/v1/supply/credentials/${SUPPLY_CREDENTIAL.id}/disable`,
        method: 'POST',
        body: { expectedAuthzVersion: 5 },
      },
      {
        url: `/admin/api/v1/supply/credentials/${SUPPLY_CREDENTIAL.id}/revoke`,
        method: 'POST',
        body: { expectedAuthzVersion: 5 },
      },
    ],
  );
  assert.equal(new Headers(calls[2]?.init.headers).get('x-csrf-token'), 'csrf-token');
  assert.equal(new Headers(calls[5]?.init.headers).get('x-csrf-token'), 'csrf-token');
});

test('platform supply mutation controls are limited to operations and superadmin', () => {
  const render = (roles: readonly ['operations' | 'superadmin' | 'security' | 'finance' | 'support-readonly']) =>
    renderToStaticMarkup(
      React.createElement(platformFeature.SupplyAccountsPage, {
        me: { kind: 'ready', me: { userId: 'admin-user', roles: [...roles] } },
      }),
    );

  for (const role of [['operations'], ['superadmin']] as const) {
    const html = render(role);
    assert.match(html, /<h2>创建平台供给账号<\/h2>/);
    assert.match(html, /创建平台供给账号/);
  }
  for (const role of [['security'], ['finance'], ['support-readonly']] as const) {
    const html = render(role);
    assert.doesNotMatch(html, /<h2>创建平台供给账号<\/h2>|>创建平台供给账号<|>添加初始凭证<|>提交凭证轮换</);
    assert.match(html, /当前角色只读/);
  }
});

test('write-only credential UI starts empty and states pending validation without a test proxy', () => {
  const html = renderToStaticMarkup(
    React.createElement(platformFeature.SupplyCredentialWriteForm, {
      accountId: SUPPLY_ACCOUNT.id,
      onChanged: () => {},
    }),
  );
  assert.match(html, /type="password"/);
  assert.match(html, /不会写入浏览器存储、日志或分析事件/);
  assert.doesNotMatch(html, /test-proxy|测试代理|must-not-return|initial-secret|rotated-secret/);
});

const AUDIT_ACTOR_UUID = '11111111-1111-4111-8111-111111111111';

function auditClientRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId: null,
    actorId: null,
    action: 'platform_mfa.enrollment_token.issued',
    entityType: 'platform_mfa_enrollment_user',
    entityId: AUDIT_ACTOR_UUID,
    occurredAt: '2026-09-30T16:00:00.000Z',
    entryPoint: 'trusted_operator_cli:platform_mfa_enroll',
    requestId: 'request-reference',
    operatorAttestation: { operatorId: 'ops:handoff-01', reasonCode: 'initial-enrollment', outcome: 'issued' },
    ...overrides,
  };
}

function auditClientResponse(items: readonly unknown[]): Response {
  return new Response(JSON.stringify({ data: { items, hasMore: false, nextCursor: null } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

test('audit client projects strict optional operator declarations without changing UUID filters or exposing raw metadata', async () => {
  const calls: string[] = [];
  const items = [
    auditClientRecord({ userAgent: 'raw-metadata-secret', sourceIp: '192.0.2.4', token: 'top-level-secret' }),
    ...['target-unavailable', 'verified-totp-present', 'enrollment-pending'].map(outcome => auditClientRecord({
      action: 'platform_mfa.enrollment_token.denied',
      operatorAttestation: { operatorId: 'o'.repeat(96), reasonCode: 'approved-enrollment', outcome },
    })),
    auditClientRecord({
      action: 'platform_mfa.enrollment_token.denied', entityType: 'platform_mfa_enrollment_email_digest', entityId: null,
      operatorAttestation: { operatorId: 'ops:handoff-01', reasonCode: 'approved-enrollment', outcome: 'target-unavailable' },
    }),
    auditClientRecord({ actorId: AUDIT_ACTOR_UUID, action: 'api_key.created', entityType: 'saas_api_key', operatorAttestation: undefined }),
    auditClientRecord({
      action: 'platform_mfa.enrollment_token.denied', entityType: 'platform_mfa_enrollment_email_digest',
      entityId: 'd'.repeat(64), operatorAttestation: undefined,
    }),
  ];
  globalThis.fetch = async input => { calls.push(String(input)); return auditClientResponse(items); };
  const page = await platformClient.listAuditEvents({
    actorId: AUDIT_ACTOR_UUID, action: 'platform_mfa.enrollment_token.issued',
    entityType: 'platform_mfa_enrollment_user', limit: 10, cursor: 'pah1.unchanged',
  });
  assert.deepEqual(page.items[0]?.operatorAttestation, {
    operatorId: 'ops:handoff-01', reasonCode: 'initial-enrollment', outcome: 'issued',
  });
  assert.equal(page.items[0]?.actorId, null);
  assert.equal(page.items[5]?.actorId, AUDIT_ACTOR_UUID);
  assert.equal(Object.hasOwn(page.items[5] ?? {}, 'operatorAttestation'), false);
  assert.equal(page.items[6]?.entityId, null);
  const url = new URL(calls[0] ?? '', 'http://localhost');
  assert.equal(url.pathname, '/admin/api/v1/audit/events');
  assert.deepEqual([...url.searchParams.keys()], ['actorId', 'action', 'entityType', 'limit', 'cursor']);
  assert.equal(url.searchParams.get('actorId'), AUDIT_ACTOR_UUID);
  assert.equal(url.searchParams.get('cursor'), 'pah1.unchanged');
  assert.doesNotMatch(JSON.stringify(page), /raw-metadata-secret|top-level-secret|192\.0\.2\.4|userAgent|sourceIp|entryPoint|requestId/);
  assert.equal(JSON.stringify(page).includes('d'.repeat(64)), false);
});

test('audit client rejects malformed or forged optional declarations with safe errors, including proto and XSS payloads', async () => {
  const valid = { operatorId: 'ops:handoff-01', reasonCode: 'initial-enrollment', outcome: 'issued' };
  const invalidAttestations: unknown[] = [
    null, [], 'raw-JSON-secret', 1, {},
    { ...valid, operatorId: '' }, { ...valid, operatorId: 'o'.repeat(97) },
    { ...valid, operatorId: '运维' }, { ...valid, operatorId: 'ops\nforged' },
    { ...valid, operatorId: '<img src=x onerror=alert(1)>' },
    { ...valid, reasonCode: 'other-reason' }, { ...valid, outcome: 'unknown' },
    { ...valid, outcome: 'enrollment-pending' },
    { ...valid, token: 'must-not-leak-secret' },
    { ...valid, audience: 'platform' }, { ...valid, userAgent: 'must-not-leak-secret' },
    JSON.parse('{"operatorId":"ops:handoff-01","reasonCode":"initial-enrollment","outcome":"issued","__proto__":{"token":"must-not-leak-secret"}}'),
  ];
  const invalidEvents = [
    ...invalidAttestations.map(operatorAttestation => auditClientRecord({ operatorAttestation })),
    auditClientRecord({ actorId: AUDIT_ACTOR_UUID }),
    auditClientRecord({ tenantId: CAPACITY_TENANT_ID }),
    auditClientRecord({ tenantId: undefined }),
    auditClientRecord({ entryPoint: 'customer_api' }),
    auditClientRecord({ entryPoint: 'trusted_operator_cli:platform_mfa_enroll:forged' }),
    auditClientRecord({ action: 'api_key.created' }),
    auditClientRecord({ entityType: 'saas_user' }),
    auditClientRecord({ entityId: 'not-a-user-uuid' }),
    auditClientRecord({
      action: 'platform_mfa.enrollment_token.denied', entityType: 'platform_mfa_enrollment_email_digest',
      entityId: 'd'.repeat(64),
      operatorAttestation: { ...valid, outcome: 'target-unavailable' },
    }),
    auditClientRecord({
      action: 'platform_mfa.enrollment_token.denied', entityType: 'platform_mfa_enrollment_email_digest', entityId: null,
      operatorAttestation: { ...valid, outcome: 'verified-totp-present' },
    }),
  ];
  for (const event of invalidEvents) {
    globalThis.fetch = async () => auditClientResponse([event]);
    await assert.rejects(platformClient.listAuditEvents(), (error: unknown) => {
      assert.ok(error instanceof PlatformApiError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.doesNotMatch(error.message, /raw-JSON|must-not-leak|onerror|__proto__|d{64}/);
      return true;
    });
  }
  assert.equal(Object.hasOwn(Object.prototype, 'token'), false);
});

test('audit client retains legacy safe event shape when the optional projection is absent', async () => {
  const legacy = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorId: AUDIT_ACTOR_UUID,
    action: 'api_key.created', entityType: 'saas_api_key', entityId: 'key-reference',
    occurredAt: '2026-09-30T16:00:00.000Z',
  };
  globalThis.fetch = async () => auditClientResponse([legacy]);
  const page = await platformClient.listAuditEvents();
  assert.deepEqual(page.items, [legacy]);
});
