import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { SaasBillingGroupsError } from '../../../../src/saas/billing/groups/errors.js';
import type { SaasBillingGroupsService } from '../../../../src/saas/billing/groups/service.js';
import type { BillingGroupRecord, BillingGroupUpsertInput } from '../../../../src/saas/billing/groups/types.js';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  type BillingGroupsHttpOptions,
  createBillingGroupsHttpHandler,
} from '../../../../src/saas/platform/billing-groups-http.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

function clockSeconds(value: string): number {
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function groupRecord(overrides: Partial<BillingGroupRecord> = {}): BillingGroupRecord {
  return {
    id: 'default',
    displayName: 'Default group',
    rateMultiplier: { numerator: 1n, denominator: 1n },
    topupMultiplier: { numerator: 1n, denominator: 1n },
    peakEnabled: false,
    peak: null,
    modelPricing: new Map(),
    rpmLimit: null,
    dailyLimitMinorUnits: null,
    weeklyLimitMinorUnits: null,
    monthlyLimitMinorUnits: null,
    profitMinMargin: null,
    profitSafetyBuffer: null,
    claudeCodeOnly: false,
    fallbackGroupId: null,
    supportedModelScopes: null,
    status: 'active',
    ...overrides,
  };
}

interface ServiceCall {
  readonly action: string;
  readonly input: unknown;
}

function validGroupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vip',
    displayName: 'VIP group',
    status: 'active',
    rateMultiplier: { num: '3', den: '2' },
    topupMultiplier: { num: '11', den: '10' },
    peakEnabled: false,
    peakStart: null,
    peakEnd: null,
    peakMultiplier: null,
    modelPricing: null,
    rpmLimit: null,
    dailyLimitMinorUnits: null,
    weeklyLimitMinorUnits: null,
    monthlyLimitMinorUnits: null,
    profitMinMargin: null,
    profitSafetyBuffer: null,
    claudeCodeOnly: false,
    fallbackGroupId: null,
    supportedModelScopes: null,
    ...overrides,
  };
}

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: Record<string, unknown>; handled: boolean }>;
  readonly calls: ServiceCall[];
  readonly auditCalls: Array<{ action: string; targetId: string; actorUserId: string }>;
}

function harness(): Harness {
  const calls: ServiceCall[] = [];
  const auditCalls: Array<{ action: string; targetId: string; actorUserId: string }> = [];
  const groups = new Map<string, BillingGroupRecord>();
  const service = {
    async listBillingGroups() {
      calls.push({ action: 'list', input: null });
      return [...groups.values()];
    },
    async getBillingGroup(id: string) {
      calls.push({ action: 'get', input: id });
      const group = groups.get(id);
      if (!group) throw new SaasBillingGroupsError('GROUP_NOT_FOUND');
      return group;
    },
    async createBillingGroup(input: BillingGroupUpsertInput) {
      calls.push({ action: 'create', input });
      if (groups.has(input.id)) {
        throw new SaasBillingGroupsError('GROUP_CONFLICT');
      }
      const record = groupRecord({
        id: input.id,
        displayName: input.displayName,
        rateMultiplier: input.rateMultiplier,
        topupMultiplier: input.topupMultiplier,
        peakEnabled: input.peakEnabled,
        peak:
          input.peakEnabled && input.peakMultiplier && input.peakStart && input.peakEnd
            ? {
                startSecondsUtc: clockSeconds(input.peakStart),
                endSecondsUtc: clockSeconds(input.peakEnd),
                multiplier: input.peakMultiplier,
              }
            : null,
        modelPricing: new Map(Object.entries(input.modelPricing ?? {})),
        status: input.status,
      });
      groups.set(input.id, record);
      return record;
    },
    async updateBillingGroup(input: BillingGroupUpsertInput) {
      calls.push({ action: 'update', input });
      if (!groups.has(input.id)) {
        throw new SaasBillingGroupsError('GROUP_NOT_FOUND');
      }
      const record = groupRecord({
        id: input.id,
        displayName: input.displayName,
        rateMultiplier: input.rateMultiplier,
        status: input.status,
      });
      groups.set(input.id, record);
      return record;
    },
    async listGroupAccountPool(groupId: string) {
      calls.push({ action: 'pool-list', input: groupId });
      return groupId === 'vip' ? [{ accountId: 'account-1', priority: 90 }] : [];
    },
    async replaceGroupAccountPool(groupId: string, entries: readonly { accountId: string; priority: number }[]) {
      calls.push({ action: 'pool-replace', input: { groupId, entries } });
      return { entries, invalidatedKeys: 7 };
    },
    async setKeyBillingGroup(input: {
      tenantId: string;
      projectId: string;
      keyId: string;
      billingGroupId: string | null;
    }) {
      calls.push({ action: 'key-group', input });
      return { keyId: input.keyId, billingGroupId: input.billingGroupId, authzVersion: '42' };
    },
  } as unknown as Pick<
    SaasBillingGroupsService,
    | 'listBillingGroups'
    | 'getBillingGroup'
    | 'createBillingGroup'
    | 'updateBillingGroup'
    | 'listGroupAccountPool'
    | 'replaceGroupAccountPool'
    | 'setKeyBillingGroup'
  >;

  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: BillingGroupsHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    async audit(input) {
      auditCalls.push({ action: input.action, targetId: input.targetId, actorUserId: input.actorUserId });
    },
    publicOrigin: ORIGIN,
  };
  const handler = createBillingGroupsHttpHandler(options);

  return {
    calls,
    auditCalls,
    async request(path, body, overrides = {}) {
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        origin: ORIGIN,
        cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...overrides.headers,
      };
      currentActor = 'actor' in overrides ? overrides.actor : ACTOR;
      const bodyText = JSON.stringify(body ?? {});
      const req = {
        url: path,
        method: overrides.method ?? 'POST',
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(bodyText);
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
      const handled = await handler(req, res);
      return {
        status,
        handled,
        body: responseText === '' ? {} : (JSON.parse(responseText) as Record<string, unknown>),
      };
    },
  };
}

test('list returns group summaries with exact rational DTOs', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/billing-groups/list', {});
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.ok(Array.isArray(data.groups));
});

test('unrelated paths fall through to the next handler', async () => {
  const h = harness();
  for (const path of [
    '/admin/api/v1/billing-groups/unknown',
    '/admin/api/v1/billing-groups/',
    '/admin/api/v1/egress-proxies/list',
    '/healthz',
  ]) {
    const response = await h.request(path, {});
    assert.equal(response.handled, false, path);
  }
});

test('create validates and persists through the service, exact rationals preserved', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/billing-groups/create', validGroupBody());
  assert.equal(response.status, 200);
  const data = response.body.data as { group: Record<string, unknown> };
  assert.equal(data.group.id, 'vip');
  assert.deepEqual(data.group.rateMultiplier, { num: '3', den: '2' });
  const create = h.calls.find((call) => call.action === 'create');
  assert.ok(create);
  assert.deepEqual((create.input as BillingGroupUpsertInput).rateMultiplier, {
    numerator: 3n,
    denominator: 2n,
  });
  assert.equal(h.auditCalls.length, 1);
  assert.equal(h.auditCalls[0].action, 'saas_billing_group.created');
});

test('model pricing goes through the canonical override codec', async () => {
  const h = harness();
  const response = await h.request(
    '/admin/api/v1/billing-groups/create',
    validGroupBody({
      modelPricing: {
        'claude-sonnet-4': {
          input: { num: '3', den: '1000000' },
          output: { num: '15', den: '1000000' },
        },
      },
    }),
  );
  assert.equal(response.status, 200);
  const create = h.calls.find((call) => call.action === 'create');
  const input = create.input as BillingGroupUpsertInput;
  const entry = input.modelPricing?.['claude-sonnet-4'];
  assert.ok(entry);
  assert.deepEqual(entry.input, { numeratorMinorUnits: '3', denominatorUnits: '1000000' });

  const invalid = await h.request(
    '/admin/api/v1/billing-groups/create',
    validGroupBody({ modelPricing: { 'claude-sonnet-4': { bogus_metric: { num: '1', den: '1' } } } }),
  );
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body.error as Record<string, unknown>).code, 'INVALID_MODEL_PRICING');
});

test('float multipliers are rejected — rationals only', async () => {
  const h = harness();
  const response = await h.request(
    '/admin/api/v1/billing-groups/create',
    validGroupBody({ rateMultiplier: { num: 1.5, den: 1 } }),
  );
  assert.equal(response.status, 400);
  assert.equal((response.body.error as Record<string, unknown>).code, 'INVALID_BODY');
});

test('peak window shape is enforced', async () => {
  const h = harness();
  const missingTimes = await h.request(
    '/admin/api/v1/billing-groups/create',
    validGroupBody({ peakEnabled: true, peakStart: null, peakEnd: null, peakMultiplier: { num: '2', den: '1' } }),
  );
  assert.equal(missingTimes.status, 400);
  const badTime = await h.request(
    '/admin/api/v1/billing-groups/create',
    validGroupBody({
      peakEnabled: true,
      peakStart: '25:00:00',
      peakEnd: '02:00:00',
      peakMultiplier: { num: '2', den: '1' },
    }),
  );
  assert.equal(badTime.status, 400);
  const withPeak = await h.request(
    '/admin/api/v1/billing-groups/create',
    validGroupBody({
      peakEnabled: true,
      peakStart: '09:00:00',
      peakEnd: '21:00:00',
      peakMultiplier: { num: '2', den: '1' },
    }),
  );
  assert.equal(withPeak.status, 200);
  const peak = (withPeak.body.data as { group: { peak: Record<string, unknown> } }).group.peak;
  assert.equal(peak.start, '09:00:00');
});

test('get returns the group with its account pool', async () => {
  const h = harness();
  await h.request('/admin/api/v1/billing-groups/create', validGroupBody());
  const response = await h.request('/admin/api/v1/billing-groups/get', { groupId: 'vip' });
  assert.equal(response.status, 200);
  const data = response.body.data as { group: { id: string }; accountPool: Array<{ accountId: string }> };
  assert.equal(data.group.id, 'vip');
  assert.deepEqual(data.accountPool, [{ accountId: 'account-1', priority: 90 }]);
});

test('replace-account-pool surfaces the authz_version fence bump', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/billing-groups/replace-account-pool', {
    groupId: 'vip',
    accounts: [
      { accountId: 'account-1', priority: 90 },
      { accountId: 'account-2', priority: 10 },
    ],
  });
  assert.equal(response.status, 200);
  const data = response.body.data as { accounts: unknown[]; invalidatedKeys: number };
  assert.equal(data.accounts.length, 2);
  assert.equal(data.invalidatedKeys, 7);
  assert.equal(h.auditCalls.length, 1);
});

test('set-key-group returns the key authzVersion', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/billing-groups/set-key-group', {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    billingGroupId: 'vip',
  });
  assert.equal(response.status, 200);
  const data = response.body.data as { keyId: string; authzVersion: string };
  assert.equal(data.keyId, 'key-1');
  assert.equal(data.authzVersion, '42');
  const unassign = await h.request('/admin/api/v1/billing-groups/set-key-group', {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    billingGroupId: null,
  });
  assert.equal(unassign.status, 200);
});

test('auth, origin, CSRF and body-shape failures fail closed', async () => {
  const h = harness();

  const method = await h.request('/admin/api/v1/billing-groups/list', {}, { method: 'GET' });
  assert.equal(method.status, 405);
  const origin = await h.request('/admin/api/v1/billing-groups/list', {}, { headers: { origin: 'https://evil.test' } });
  assert.equal(origin.status, 403);
  assert.equal((origin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');
  const csrf = await h.request('/admin/api/v1/billing-groups/list', {}, { headers: { 'x-csrf-token': 'wrong' } });
  assert.equal(csrf.status, 403);
  assert.equal((csrf.body.error as Record<string, unknown>).code, 'CSRF_REJECTED');
  const unauthenticated = await h.request('/admin/api/v1/billing-groups/list', {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);
  const viewer: PlatformAdminActor = { ...ACTOR, roles: ['support-readonly'] };
  const forbidden = await h.request('/admin/api/v1/billing-groups/list', {}, { actor: viewer });
  assert.equal(forbidden.status, 403);
  const extraField = await h.request('/admin/api/v1/billing-groups/list', { unexpected: 1 });
  assert.equal(extraField.status, 400);
  const contentType = await h.request(
    '/admin/api/v1/billing-groups/list',
    {},
    { headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(contentType.status, 415);
  const query = await h.request('/admin/api/v1/billing-groups/list?x=1', {});
  assert.equal(query.status, 400);
});

test('service not-found and conflict errors map to safe statuses', async () => {
  const h = harness();
  const missing = await h.request('/admin/api/v1/billing-groups/get', { groupId: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal((missing.body.error as Record<string, unknown>).code, 'BILLING_GROUP_NOT_FOUND');

  await h.request('/admin/api/v1/billing-groups/create', validGroupBody());
  const conflict = await h.request('/admin/api/v1/billing-groups/create', validGroupBody());
  assert.equal(conflict.status, 409);

  const updateMissing = await h.request('/admin/api/v1/billing-groups/update', validGroupBody({ id: 'nope' }));
  assert.equal(updateMissing.status, 404);
});
