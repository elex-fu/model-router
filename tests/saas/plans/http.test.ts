import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import type { SafeSession, TenantContext } from '../../../src/saas/identity/types.js';
import {
  BYOK_CATALOG_POLICY_DESCRIPTION,
  type CustomerServicePlanCatalogItem,
  createSaasPlanCatalogHandler,
} from '../../../src/saas/plans/http.js';
import type { ServicePlanVersionRecord } from '../../../src/saas/plans/types.js';

const SESSION_TOKEN = 'customer-session-token-123456';
const NOW = '2026-09-28T00:00:00.000Z';

const session: SafeSession = {
  userId: 'user-1',
  activeTenantId: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: NOW,
};

const tenantContext: TenantContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  tenantRole: 'viewer',
  projectRole: 'viewer',
};

function publishedPlan(overrides: Partial<ServicePlanVersionRecord> = {}): ServicePlanVersionRecord {
  return {
    id: 'plan-version-1',
    planId: 'plan-1',
    version: 2,
    supplyMode: 'byok',
    supplyProfileId: 'profile-secret-reference',
    allowedProviderIds: ['provider-a'],
    allowedModels: ['model-a', 'model-b'],
    priceVersion: 'price-v2-internal',
    priceMinorUnits: '1200',
    currency: 'USD',
    termDays: 30,
    policyVersion: 'policy-v2-internal',
    status: 'published',
    createdAt: NOW,
    publishedAt: NOW,
    retiredAt: null,
    ...overrides,
  };
}

interface ResponseRecord {
  status: number | undefined;
  headers: Record<string, unknown>;
  body: string;
  writableEnded: boolean;
}

function response(): { value: ServerResponse; record: ResponseRecord } {
  const record: ResponseRecord = { status: undefined, headers: {}, body: '', writableEnded: false };
  const value = {
    get destroyed() {
      return false;
    },
    get writableEnded() {
      return record.writableEnded;
    },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      record.status = status;
      record.headers = headers;
      return value;
    },
    end(body?: unknown) {
      record.body = body === undefined ? '' : String(body);
      record.writableEnded = true;
      return value;
    },
  };
  return { value: value as unknown as ServerResponse, record };
}

async function invoke(
  handler: ReturnType<typeof createSaasPlanCatalogHandler>,
  url: string,
  options: { method?: string; cookie?: string } = {},
): Promise<{ handled: boolean; record: ResponseRecord }> {
  const request = {
    url,
    method: options.method ?? 'GET',
    headers: options.cookie === undefined ? {} : { cookie: options.cookie },
    resume() {
      return request;
    },
  };
  const result = response();
  const handled = await handler(request as unknown as IncomingMessage, result.value);
  return { handled, record: result.record };
}

test('catalog handler authenticates and authorizes the tenant before returning an allowlisted DTO', async () => {
  const contextInputs: Array<{ userId: string; tenantId: string }> = [];
  let catalogInput: unknown;
  const handler = createSaasPlanCatalogHandler({
    service: {
      getSession: async (token) => (token === SESSION_TOKEN ? session : undefined),
      resolveTenantContext: async (input) => {
        contextInputs.push(input);
        return tenantContext;
      },
    },
    planService: {
      listCatalog: async (input) => {
        catalogInput = input;
        return [
          publishedPlan(),
          publishedPlan({ id: 'retired-version', status: 'retired', retiredAt: NOW }),
          publishedPlan({ id: 'draft-version', status: 'draft', publishedAt: null }),
        ];
      },
    },
    publicOrigin: 'https://customer.example',
  });

  const result = await invoke(handler, '/console/api/v1/tenants/tenant-1/service-plans/catalog', {
    cookie: `mr_saas_session=${SESSION_TOKEN}`,
  });
  assert.equal(result.handled, true);
  assert.equal(result.record.status, 200);
  assert.deepEqual(contextInputs, [{ userId: 'user-1', tenantId: 'tenant-1' }]);
  assert.deepEqual(catalogInput, { includeRetired: false });

  const body = JSON.parse(result.record.body) as {
    data?: CustomerServicePlanCatalogItem[];
    meta?: { requestId?: string };
  };
  assert.deepEqual(body.data, [
    {
      planVersionId: 'plan-version-1',
      planId: 'plan-1',
      version: 2,
      supplyMode: 'byok',
      termDays: 30,
      fixedFeeMinorUnits: '1200',
      currency: 'USD',
      supportedProviderIds: ['provider-a'],
      supportedModels: ['model-a', 'model-b'],
      policyDescription: BYOK_CATALOG_POLICY_DESCRIPTION,
    },
  ]);
  assert.match(body.meta?.requestId ?? '', /^saas_plan_/);
  assert.doesNotMatch(result.record.body, /profile-secret-reference|price-v2-internal|policy-v2-internal/);
});

test('catalog handler rejects anonymous and non-member tenant reads', async () => {
  let catalogCalls = 0;
  const handler = createSaasPlanCatalogHandler({
    service: {
      getSession: async (token) => (token === SESSION_TOKEN ? session : undefined),
      resolveTenantContext: async () => {
        throw new SaasIdentityError(404, 'TENANT_ACCESS_DENIED');
      },
    },
    planService: {
      listCatalog: async () => {
        catalogCalls += 1;
        return [];
      },
    },
    publicOrigin: 'https://customer.example',
  });

  const anonymous = await invoke(handler, '/console/api/v1/tenants/tenant-1/service-plans/catalog');
  assert.equal(anonymous.record.status, 401);
  assert.equal((JSON.parse(anonymous.record.body) as { error?: { code?: string } }).error?.code, 'UNAUTHENTICATED');

  const forbidden = await invoke(handler, '/console/api/v1/tenants/other/service-plans/catalog', {
    cookie: `mr_saas_session=${SESSION_TOKEN}`,
  });
  assert.equal(forbidden.record.status, 404);
  assert.equal(
    (JSON.parse(forbidden.record.body) as { error?: { code?: string } }).error?.code,
    'TENANT_ACCESS_DENIED',
  );
  assert.equal(catalogCalls, 0);
});

test('catalog handler is read-only and does not claim a write route', async () => {
  const handler = createSaasPlanCatalogHandler({
    service: {
      getSession: async () => session,
      resolveTenantContext: async () => tenantContext,
    },
    planService: { listCatalog: async () => [] },
    publicOrigin: 'https://customer.example',
  });

  const write = await invoke(handler, '/console/api/v1/tenants/tenant-1/service-plans/catalog', {
    method: 'POST',
    cookie: `mr_saas_session=${SESSION_TOKEN}`,
  });
  assert.equal(write.record.status, 405);
  assert.equal(write.record.headers.allow, 'GET');

  const unknown = await invoke(handler, '/console/api/v1/tenants/tenant-1/service-plans/catalog/orders', {
    cookie: `mr_saas_session=${SESSION_TOKEN}`,
  });
  assert.equal(unknown.handled, false);
  assert.equal(unknown.record.writableEnded, false);
});
