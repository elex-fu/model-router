import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SaasApiError, type SafeCustomerSession, saasClient } from '../../web/src/api/saas-client.ts';
import {
  CustomerSessionsPage,
  customerSessionsKey,
  performCustomerSessionMutation,
  SessionConfirmationDialog,
} from '../../web/src/features/saas-console.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

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

const currentSession: SafeCustomerSession = {
  id: 'session-current',
  createdAt: '2026-09-29T10:00:00.000Z',
  expiresAt: '2026-10-06T10:00:00.000Z',
  revokedAt: null,
  status: 'active',
  current: true,
};

const otherSession: SafeCustomerSession = {
  id: 'session-other',
  createdAt: '2026-09-28T08:00:00.000Z',
  expiresAt: '2026-10-05T08:00:00.000Z',
  revokedAt: null,
  status: 'active',
  current: false,
};

function renderPage(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/console/security'] },
        React.createElement(CustomerSessionsPage, {
          onLogout: async () => {},
          onCurrentSessionRevoked: () => {},
        }),
      ),
    ),
  );
}

test('session client uses existing routes and CSRF conventions while allowlisting response metadata', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=csrf-value-must-not-leak' },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const data =
      calls.length === 1
        ? {
            sessions: [
              {
                ...currentSession,
                token: 'session-token-must-not-leak',
                tokenHash: 'session-hash-must-not-leak',
                csrfToken: 'response-csrf-must-not-leak',
                ip: '198.51.100.42',
                browser: 'Private Browser',
                lastUsedAt: '2026-09-29T10:30:00.000Z',
              },
            ],
          }
        : calls.length === 2
          ? {
              sessionId: 'session/one',
              revokedAt: '2026-09-29T11:00:00.000Z',
              currentSessionRevoked: false,
              token: 'mutation-token-must-not-leak',
            }
          : {
              revokedCount: 1,
              currentSessionPreserved: true,
              tokenHash: 'mutation-hash-must-not-leak',
            };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const sessions = await saasClient.getCustomerSessions();
  const one = await saasClient.revokeCustomerSession('session/one');
  const others = await saasClient.revokeOtherCustomerSessions();

  assert.deepEqual(sessions, [currentSession]);
  assert.deepEqual(one, {
    sessionId: 'session/one',
    revokedAt: '2026-09-29T11:00:00.000Z',
    currentSessionRevoked: false,
  });
  assert.deepEqual(others, { revokedCount: 1, currentSessionPreserved: true });
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      '/console/api/v1/auth/sessions',
      '/console/api/v1/auth/sessions/session%2Fone/revoke',
      '/console/api/v1/auth/sessions/revoke-others',
    ],
  );
  assert.equal(new Headers(calls[0].init.headers).get('x-csrf-token'), null);
  assert.equal(new Headers(calls[1].init.headers).get('x-csrf-token'), 'csrf-value-must-not-leak');
  assert.equal(new Headers(calls[2].init.headers).get('x-csrf-token'), 'csrf-value-must-not-leak');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {});
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {});
  assert.equal(JSON.stringify([sessions, one, others]).includes('must-not-leak'), false);
});

test('session UI exposes loading, empty, and safe errors without rendering response details', async () => {
  const noRefetch = { retry: false, retryOnMount: false, refetchOnMount: false };
  const loadingClient = new QueryClient({ defaultOptions: { queries: noRefetch } });
  const loadingQuery = loadingClient.getQueryCache().build(loadingClient, {
    queryKey: customerSessionsKey,
    queryFn: async () => [] as SafeCustomerSession[],
  });
  loadingQuery.setState({ status: 'pending', fetchStatus: 'fetching' });
  const loading = renderPage(loadingClient);
  assert.match(loading, /role="status"[^>]*aria-label="正在加载登录会话"/);
  loadingClient.clear();

  const emptyClient = new QueryClient();
  emptyClient.setQueryData(customerSessionsKey, []);
  const empty = renderPage(emptyClient);
  assert.match(empty, /暂无登录会话信息/);
  emptyClient.clear();

  const renderErrorState = (error: SaasApiError) => {
    const errorClient = new QueryClient({ defaultOptions: { queries: noRefetch } });
    const errorQuery = errorClient.getQueryCache().build(errorClient, {
      queryKey: customerSessionsKey,
      queryFn: async () => [] as SafeCustomerSession[],
    });
    errorQuery.setState({ status: 'error', error, errorUpdatedAt: Date.now() });
    const html = renderPage(errorClient);
    errorClient.clear();
    return html;
  };
  const error = new SaasApiError(403, 'CSRF_REJECTED', 'raw-csrf-response-must-not-render', {
    csrfToken: 'details-csrf-must-not-render',
  });
  const failed = renderErrorState(error);
  assert.match(failed, /安全校验失败/);
  assert.match(failed, /刷新页面/);
  assert.doesNotMatch(failed, /raw-csrf-response-must-not-render|details-csrf-must-not-render/);

  const originRejected = renderErrorState(new SaasApiError(403, 'ORIGIN_REJECTED', 'raw-origin-value-must-not-render'));
  assert.match(originRejected, /请求来源校验失败/);
  assert.match(originRejected, /从客户控制台重新打开页面/);
  assert.match(originRejected, /刷新页面/);

  const expired = renderErrorState(new SaasApiError(401, 'UNAUTHENTICATED', 'raw-expired-value-must-not-render'));
  assert.match(expired, /登录状态已过期/);
  assert.match(expired, /返回登录/);
  assert.doesNotMatch(expired, /raw-origin-value-must-not-render|raw-expired-value-must-not-render/);
});

test('session list renders only allowlisted safe metadata and localized status', async () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=render-test-csrf' },
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          sessions: [
            {
              ...currentSession,
              token: 'visible-session-token-must-not-render',
              tokenHash: 'visible-hash-must-not-render',
              csrfToken: 'visible-csrf-must-not-render',
              ip: '203.0.113.88',
              browser: 'Hidden Browser',
              lastUsedAt: '2026-09-29T10:30:00.000Z',
            },
            {
              ...otherSession,
              status: 'revoked',
              revokedAt: '2026-09-29T09:00:00.000Z',
              token: 'another-secret-must-not-render',
            },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const safeSessions = await saasClient.getCustomerSessions();
  const queryClient = new QueryClient();
  queryClient.setQueryData(customerSessionsKey, safeSessions);

  const html = renderPage(queryClient);

  assert.match(html, /安全与登录会话/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-label="登录会话列表"/);
  assert.match(html, /当前 · 活动/);
  assert.match(html, /已撤销/);
  assert.match(html, /创建时间/);
  assert.match(html, /到期时间/);
  assert.match(html, /撤销时间/);
  assert.match(html, /dateTime="2026-09-29T10:00:00.000Z"/);
  assert.match(html, /dateTime="2026-10-06T10:00:00.000Z"/);
  assert.match(html, /当前接口暂未提供设备、浏览器、IP 或上次使用时间/);
  assert.doesNotMatch(
    html,
    /visible-session-token-must-not-render|visible-hash-must-not-render|visible-csrf-must-not-render|203\.0\.113\.88|Hidden Browser|another-secret-must-not-render|session-current/,
  );
  queryClient.clear();
});

test('single-session revoke refreshes the list and does not sign out the current session', async () => {
  const calls: string[] = [];
  const result = await performCustomerSessionMutation(
    { kind: 'session', sessionId: 'session-other' },
    {
      client: {
        revokeCustomerSession: async (sessionId) => {
          calls.push(`revoke:${sessionId}`);
          return {
            sessionId,
            revokedAt: '2026-09-29T11:00:00.000Z',
            currentSessionRevoked: false,
          };
        },
        revokeOtherCustomerSessions: async () => ({ revokedCount: 0, currentSessionPreserved: true }),
      },
      refresh: async () => {
        calls.push('refresh');
      },
      onCurrentSessionRevoked: () => {
        calls.push('logout');
      },
    },
  );

  assert.deepEqual(calls, ['revoke:session-other', 'refresh']);
  assert.equal('currentSessionRevoked' in result && result.currentSessionRevoked, false);
});

test('revoke-others keeps the current session and refreshes session state', async () => {
  const calls: string[] = [];
  const result = await performCustomerSessionMutation(
    { kind: 'others' },
    {
      client: {
        revokeCustomerSession: async () => ({
          sessionId: 'unused',
          revokedAt: '2026-09-29T11:00:00.000Z',
          currentSessionRevoked: false,
        }),
        revokeOtherCustomerSessions: async () => {
          calls.push('revoke-others');
          return { revokedCount: 2, currentSessionPreserved: true };
        },
      },
      refresh: async () => {
        calls.push('refresh');
      },
      onCurrentSessionRevoked: () => {
        calls.push('logout');
      },
    },
  );

  assert.deepEqual(calls, ['revoke-others', 'refresh']);
  assert.deepEqual(result, { revokedCount: 2, currentSessionPreserved: true });
});

test('revoking the current session refreshes state, then clears local authentication without another logout request', async () => {
  const calls: string[] = [];
  await performCustomerSessionMutation(
    { kind: 'session', sessionId: currentSession.id },
    {
      client: {
        revokeCustomerSession: async (sessionId) => {
          calls.push(`revoke:${sessionId}`);
          return {
            sessionId,
            revokedAt: '2026-09-29T11:00:00.000Z',
            currentSessionRevoked: true,
          };
        },
        revokeOtherCustomerSessions: async () => ({ revokedCount: 0, currentSessionPreserved: true }),
      },
      refresh: async () => {
        calls.push('refresh');
      },
      onCurrentSessionRevoked: () => {
        calls.push('clear-local-session-and-navigate-to-login');
      },
    },
  );

  assert.deepEqual(calls, ['revoke:session-current', 'refresh', 'clear-local-session-and-navigate-to-login']);
});

test('confirmation controls announce destructive actions accessibly, including current-session logout', () => {
  const current = renderToStaticMarkup(
    React.createElement(SessionConfirmationDialog, {
      confirmation: { kind: 'session', session: currentSession },
      busy: false,
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );
  assert.match(current, /role="alertdialog"/);
  assert.match(current, /aria-modal="true"/);
  assert.match(current, /aria-labelledby="customer-session-confirmation-title"/);
  assert.match(current, /aria-describedby="customer-session-confirmation-description"/);
  assert.match(current, /撤销当前会话并退出登录/);
  assert.match(current, /你需要重新登录/);
  assert.match(current, /<button[^>]*>取消<\/button>/);
  assert.match(current, /撤销并退出登录/);

  const others = renderToStaticMarkup(
    React.createElement(SessionConfirmationDialog, {
      confirmation: { kind: 'others', activeCount: 2 },
      busy: false,
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );
  assert.match(others, /撤销其他活动会话/);
  assert.match(others, /其他 2 个活动会话/);
  assert.match(others, /当前会话会继续保持登录/);
  assert.match(others, /撤销其他会话/);
});

test('session client redacts arbitrary origin and error response fields', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'ORIGIN_REJECTED',
          message: 'origin-value-must-not-leak',
          details: { token: 'error-token-must-not-leak', csrfToken: 'error-csrf-must-not-leak' },
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );

  await assert.rejects(saasClient.getCustomerSessions(), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.equal(error.code, 'ORIGIN_REJECTED');
    assert.equal(error.message, '会话请求失败，请稍后重试。');
    assert.equal(error.details, undefined);
    assert.equal(error.data, undefined);
    assert.doesNotMatch(error.message, /origin-value-must-not-leak|error-token-must-not-leak|error-csrf-must-not-leak/);
    return true;
  });
});
