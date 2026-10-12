import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SaasApiError, type SafeTenant, saasClient, type TenantAnnouncement } from '../../web/src/api/saas-client.ts';
import {
  countUnreadAnnouncements,
  mergeAnnouncementReadReceipt,
  performTenantAnnouncementMarkRead,
  TenantNotificationsPage,
  tenantAnnouncementsKey,
  tenantAnnouncementUnreadKey,
} from '../../web/src/features/saas-console.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const queryClients = new Set<QueryClient>();
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantQueryKey = ['saas-console', 'tenants'] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
});

const criticalMaintenance: TenantAnnouncement = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'maintenance',
  severity: 'critical',
  title: '核心路由维护通知',
  body: '平台将于本周六 02:00-04:00 进行核心路由维护，期间请求可能出现短暂中断。',
  publishAt: '2026-10-09T18:00:00.000Z',
  unpublishAt: '2026-10-12T18:00:00.000Z',
  readAt: null,
};

const warningBilling: TenantAnnouncement = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'billing',
  severity: 'warning',
  title: '账单结算规则调整',
  body: '自 11 月起钱包充值的最小结算单位将调整，请提前核对账单。',
  publishAt: '2026-10-08T10:00:00.000Z',
  unpublishAt: null,
  readAt: '2026-10-09T01:00:00.000Z',
};

const infoAnnouncement: TenantAnnouncement = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'info',
  severity: 'info',
  title: '新功能上线',
  body: '通知中心现已面向全部租户角色开放。',
  publishAt: '2026-10-07T08:00:00.000Z',
  unpublishAt: null,
  readAt: null,
};

function newQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClients.add(queryClient);
  return queryClient;
}

function makeTenant(role: SafeTenant['role']): SafeTenant {
  return {
    id: TENANT_ID,
    name: '示例租户',
    slug: 'example-tenant',
    status: 'active',
    role,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

function seedTenant(queryClient: QueryClient, role: SafeTenant['role'] = 'owner') {
  queryClient.setQueryData(tenantQueryKey, [makeTenant(role)]);
}

function renderPage(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/console/notifications'] },
        React.createElement(TenantNotificationsPage, { onLogout: async () => {} }),
      ),
    ),
  );
}

function respondJson(status: number, payload: unknown) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('tenant announcements client pins the tenant route and allowlists customer-safe fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        data: {
          announcements: [
            {
              ...criticalMaintenance,
              status: 'published',
              version: 3,
              createdByUserId: '99999999-9999-4999-8999-999999999999',
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-02T00:00:00.000Z',
              operatorNote: 'operator-note-must-not-escape',
            },
          ],
          nextCursor: 'cursor/next',
          internalError: 'internal-detail-must-not-escape',
        },
        meta: { requestId: 'request-id' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const page = await saasClient.getTenantAnnouncements('tenant/one', {
    cursor: 'cursor/current',
    limit: 25,
    signal: controller.signal,
  });

  assert.deepEqual(page, { items: [criticalMaintenance], nextCursor: 'cursor/next' });
  assert.deepEqual(JSON.parse(JSON.stringify(page)), { items: [criticalMaintenance], nextCursor: 'cursor/next' });
  assert.equal(calls[0]?.url, '/console/api/v1/tenants/tenant%2Fone/announcements?cursor=cursor%2Fcurrent&limit=25');
  assert.equal(calls[0]?.init.method ?? 'GET', 'GET');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  assert.equal(calls[0]?.init.signal, controller.signal);
  assert.equal(new Headers(calls[0]?.init.headers).get('x-csrf-token'), null);
  assert.doesNotMatch(
    JSON.stringify(page),
    /99999999|operator-note|must-not-escape|internal-detail|"status"|"version"|createdAt|updatedAt/,
  );
});

test('mark-read client pins POST with an empty JSON body and the double-submit CSRF header', async () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=notifications-test-csrf' },
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        data: {
          outcome: 'marked',
          announcementId: criticalMaintenance.id,
          readAt: '2026-10-10T00:00:00.000Z',
          leaseToken: 'receipt-internal-must-not-escape',
        },
        meta: { requestId: 'request-id' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const receipt = await saasClient.markTenantAnnouncementRead('tenant/one', criticalMaintenance.id);

  assert.deepEqual(receipt, {
    outcome: 'marked',
    announcementId: criticalMaintenance.id,
    readAt: '2026-10-10T00:00:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `/console/api/v1/tenants/tenant%2Fone/announcements/${criticalMaintenance.id}/read`);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.body, '{}');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-csrf-token'), 'notifications-test-csrf');
  assert.doesNotMatch(JSON.stringify(receipt), /leaseToken|must-not-escape/);

  respondJson(200, {
    data: {
      outcome: 'already_read',
      announcementId: criticalMaintenance.id,
      readAt: '2026-10-10T00:00:00.000Z',
    },
  });
  const replay = await saasClient.markTenantAnnouncementRead(TENANT_ID, criticalMaintenance.id);
  assert.equal(replay.outcome, 'already_read');
});

test('announcement validators fail closed on malformed enums, timestamps, cursors, and shapes', async () => {
  const rejectsInvalid = async (promise: Promise<unknown>, label: string) => {
    await assert.rejects(
      promise,
      (error: unknown) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
      label,
    );
  };

  const poisonedPages: Array<[string, unknown]> = [
    ['unknown kind', { announcements: [{ ...criticalMaintenance, kind: 'promotion' }], nextCursor: null }],
    ['unknown severity', { announcements: [{ ...criticalMaintenance, severity: 'fatal' }], nextCursor: null }],
    ['non-uuid id', { announcements: [{ ...criticalMaintenance, id: 'not-a-uuid' }], nextCursor: null }],
    ['numeric readAt', { announcements: [{ ...criticalMaintenance, readAt: 42 }], nextCursor: null }],
    ['non-date readAt', { announcements: [{ ...criticalMaintenance, readAt: 'not-a-date' }], nextCursor: null }],
    ['numeric unpublishAt', { announcements: [{ ...criticalMaintenance, unpublishAt: 7 }], nextCursor: null }],
    ['oversized title', { announcements: [{ ...criticalMaintenance, title: 'x'.repeat(201) }], nextCursor: null }],
    ['empty body', { announcements: [{ ...criticalMaintenance, body: '' }], nextCursor: null }],
    ['oversized cursor', { announcements: [], nextCursor: 'x'.repeat(513) }],
    ['wrong page shape', { items: [criticalMaintenance], nextCursor: null }],
    ['array root', [criticalMaintenance]],
  ];
  for (const [label, data] of poisonedPages) {
    respondJson(200, { data });
    await rejectsInvalid(saasClient.getTenantAnnouncements(TENANT_ID), label);
  }

  const poisonedReceipts: unknown[] = [
    { outcome: 'deleted', announcementId: criticalMaintenance.id, readAt: '2026-10-10T00:00:00.000Z' },
    { outcome: 'marked', announcementId: 'not-a-uuid', readAt: '2026-10-10T00:00:00.000Z' },
    { outcome: 'marked', announcementId: criticalMaintenance.id, readAt: 'not-a-date' },
    { outcome: 'already_read', announcementId: criticalMaintenance.id, readAt: null },
  ];
  for (const data of poisonedReceipts) {
    respondJson(200, { data });
    await rejectsInvalid(
      saasClient.markTenantAnnouncementRead(TENANT_ID, criticalMaintenance.id),
      JSON.stringify(data),
    );
  }
});

test('announcement client redacts server error codes, messages, and details', async () => {
  respondJson(500, {
    error: {
      code: 'ANNOUNCEMENT_STORAGE_ERROR',
      message: 'database-password-must-not-escape',
      details: { query: 'private-sql-must-not-escape' },
    },
  });
  await assert.rejects(saasClient.getTenantAnnouncements(TENANT_ID), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.equal(error.code, 'HTTP_ERROR');
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /database-password|private-sql/);
    return true;
  });

  respondJson(404, {
    error: { code: 'ANNOUNCEMENT_NOT_FOUND', message: 'unpublished-draft-must-not-escape' },
  });
  await assert.rejects(saasClient.markTenantAnnouncementRead(TENANT_ID, criticalMaintenance.id), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.equal(error.code, 'HTTP_ERROR');
    assert.doesNotMatch(error.message, /unpublished-draft-must-not-escape/);
    return true;
  });
});

test('notifications page renders severity, kind, read state, and local times without poisoned fields', async () => {
  const queryClient = newQueryClient();
  seedTenant(queryClient, 'viewer');
  respondJson(200, {
    data: {
      announcements: [
        {
          ...criticalMaintenance,
          createdByUserId: '88888888-8888-4888-8888-888888888888',
          operatorNote: 'internal-note-must-not-render',
        },
        { ...warningBilling, version: 9, status: 'published' },
        { ...infoAnnouncement },
      ],
      nextCursor: 'cursor/next',
    },
  });
  const safePage = await saasClient.getTenantAnnouncements(TENANT_ID);
  queryClient.setQueryData(tenantAnnouncementsKey(TENANT_ID), safePage);

  const markup = renderPage(queryClient);

  assert.match(markup, /aria-current="page" href="\/console\/notifications"/);
  assert.match(markup, /核心路由维护通知/);
  assert.match(markup, /账单结算规则调整/);
  assert.match(markup, /新功能上线/);
  assert.match(markup, /严重/);
  assert.match(markup, /警告/);
  assert.match(markup, /提示/);
  assert.match(markup, /维护/);
  assert.match(markup, /账单/);
  assert.equal(markup.match(/saas-tenant-card unread/g)?.length, 2);
  assert.equal(markup.match(/>标记已读</g)?.length, 2);
  assert.match(markup, /已读/);
  assert.match(markup, /尚未阅读/);
  assert.match(markup, /长期展示/);
  assert.match(markup, /dateTime="2026-10-09T18:00:00.000Z"/);
  assert.match(markup, /dateTime="2026-10-12T18:00:00.000Z"/);
  assert.match(markup, /dateTime="2026-10-09T01:00:00.000Z"/);
  assert.match(markup, /aria-label="公告列表"/);
  assert.match(markup, /aria-label="通知分页"/);
  assert.match(markup, /下一页/);
  assert.match(markup, /公告由平台运营发布/);
  assert.doesNotMatch(markup, /88888888|internal-note|must-not-render/);
});

test('notifications page has loading, empty, safe error, and expired-session states', () => {
  const loadingClient = newQueryClient();
  seedTenant(loadingClient);
  const loadingQuery = loadingClient.getQueryCache().build(loadingClient, {
    queryKey: tenantAnnouncementsKey(TENANT_ID),
    queryFn: async () => ({ items: [], nextCursor: null }),
  });
  loadingQuery.setState({ status: 'pending', fetchStatus: 'fetching' });
  assert.match(renderPage(loadingClient), /role="status"[^>]*aria-label="正在加载通知"/);

  const emptyClient = newQueryClient();
  seedTenant(emptyClient);
  emptyClient.setQueryData(tenantAnnouncementsKey(TENANT_ID), { items: [], nextCursor: null });
  const emptyMarkup = renderPage(emptyClient);
  assert.match(emptyMarkup, /当前没有可见的平台公告/);
  assert.match(emptyMarkup, /aria-label="客户控制台导航"/);

  const renderError = (error: SaasApiError) => {
    const queryClient = newQueryClient();
    seedTenant(queryClient);
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: tenantAnnouncementsKey(TENANT_ID),
      queryFn: async () => ({ items: [], nextCursor: null }),
    });
    query.setState({ status: 'error', error, errorUpdatedAt: Date.now() });
    return renderPage(queryClient);
  };

  const failed = renderError(new SaasApiError(500, 'HTTP_ERROR', 'database-secret-must-not-render'));
  assert.match(failed, /通知读取失败/);
  assert.doesNotMatch(failed, /database-secret-must-not-render/);

  const forbidden = renderError(new SaasApiError(403, 'FORBIDDEN', 'forbidden-secret-must-not-render'));
  assert.match(forbidden, /无权查看通知/);
  assert.doesNotMatch(forbidden, /forbidden-secret-must-not-render/);

  const csrf = renderError(new SaasApiError(403, 'CSRF_REJECTED', 'csrf-secret-must-not-render'));
  assert.match(csrf, /安全校验失败/);
  assert.doesNotMatch(csrf, /csrf-secret-must-not-render/);

  const expired = renderError(new SaasApiError(401, 'UNAUTHENTICATED', 'expired-session-secret-must-not-render'));
  assert.match(expired, /登录状态已过期/);
  assert.match(expired, /返回登录/);
  assert.doesNotMatch(expired, /expired-session-secret-must-not-render/);
});

test('notifications navigation is visible to every tenant role and badges only unread counts', () => {
  for (const role of ['owner', 'admin', 'developer', 'billing', 'viewer'] as const) {
    const queryClient = newQueryClient();
    seedTenant(queryClient, role);
    queryClient.setQueryData(tenantAnnouncementsKey(TENANT_ID), { items: [], nextCursor: null });
    const markup = renderPage(queryClient);
    assert.match(markup, /href="\/console\/notifications"/, role);
  }

  const withUnread = newQueryClient();
  seedTenant(withUnread, 'viewer');
  const mixed = [criticalMaintenance, warningBilling, infoAnnouncement];
  withUnread.setQueryData(tenantAnnouncementsKey(TENANT_ID), { items: mixed, nextCursor: null });
  withUnread.setQueryData(tenantAnnouncementUnreadKey(TENANT_ID), { items: mixed, nextCursor: null });
  const unreadMarkup = renderPage(withUnread);
  assert.match(unreadMarkup, /aria-hidden="true">2</);
  assert.match(unreadMarkup, /（2 条未读公告）/);

  const allRead = newQueryClient();
  seedTenant(allRead, 'viewer');
  const read = { ...criticalMaintenance, readAt: '2026-10-10T00:00:00.000Z' };
  allRead.setQueryData(tenantAnnouncementsKey(TENANT_ID), { items: [read], nextCursor: null });
  allRead.setQueryData(tenantAnnouncementUnreadKey(TENANT_ID), { items: [read], nextCursor: null });
  const readMarkup = renderPage(allRead);
  assert.match(readMarkup, /href="\/console\/notifications"/);
  assert.doesNotMatch(readMarkup, /条未读公告/);
});

test('mark-read lifecycle applies optimistic state, confirms, and rolls back on failure', async () => {
  const events: string[] = [];
  const receipt = await performTenantAnnouncementMarkRead(
    { tenantId: TENANT_ID, announcementId: criticalMaintenance.id, optimisticReadAt: '2026-10-10T00:00:00.000Z' },
    {
      client: {
        markTenantAnnouncementRead: async (tenantId, announcementId) => {
          assert.equal(tenantId, TENANT_ID);
          assert.equal(announcementId, criticalMaintenance.id);
          events.push('request');
          return { outcome: 'already_read', announcementId, readAt: '2026-10-10T00:00:01.000Z' };
        },
      },
      onPending: (announcementId, optimisticReadAt) => events.push(`pending:${announcementId}:${optimisticReadAt}`),
      onConfirmed: (value) => events.push(`confirmed:${value.outcome}`),
      onSettled: (announcementId) => events.push(`settled:${announcementId}`),
    },
  );
  assert.deepEqual(receipt, {
    outcome: 'already_read',
    announcementId: criticalMaintenance.id,
    readAt: '2026-10-10T00:00:01.000Z',
  });
  assert.deepEqual(events, [
    `pending:${criticalMaintenance.id}:2026-10-10T00:00:00.000Z`,
    'request',
    'confirmed:already_read',
    `settled:${criticalMaintenance.id}`,
  ]);

  const failureEvents: string[] = [];
  const failure = new SaasApiError(500, 'HTTP_ERROR', 'mark-read exploded');
  await assert.rejects(
    performTenantAnnouncementMarkRead(
      { tenantId: TENANT_ID, announcementId: criticalMaintenance.id, optimisticReadAt: '2026-10-10T00:00:00.000Z' },
      {
        client: {
          markTenantAnnouncementRead: async () => {
            failureEvents.push('request');
            throw failure;
          },
        },
        onPending: (announcementId) => failureEvents.push(`pending:${announcementId}`),
        onConfirmed: () => failureEvents.push('confirmed'),
        onSettled: (announcementId) => failureEvents.push(`settled:${announcementId}`),
      },
    ),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(failureEvents, [
    `pending:${criticalMaintenance.id}`,
    'request',
    `settled:${criticalMaintenance.id}`,
  ]);
});

test('read receipt merge updates only the matching announcement and unread counting is exact', () => {
  const items = [criticalMaintenance, warningBilling, infoAnnouncement];
  assert.equal(countUnreadAnnouncements(items), 2);
  assert.equal(countUnreadAnnouncements(undefined), 0);
  const merged = mergeAnnouncementReadReceipt(items, {
    outcome: 'marked',
    announcementId: criticalMaintenance.id,
    readAt: '2026-10-10T00:00:00.000Z',
  });
  assert.equal(merged[0]?.readAt, '2026-10-10T00:00:00.000Z');
  assert.equal(merged[1], warningBilling);
  assert.equal(merged[2], infoAnnouncement);
  assert.equal(countUnreadAnnouncements(merged), 1);
});
