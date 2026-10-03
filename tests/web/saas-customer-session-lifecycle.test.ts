import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaasApiError, type SafeCustomerSession, saasClient } from '../../web/src/api/saas-client.ts';
import {
  createCustomerSessionMutationLifecycle,
  customerSessionsKey,
  performCustomerSessionMutation,
  SessionSecurityErrorNotice,
} from '../../web/src/features/saas-console.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const queryClients = new Set<QueryClient>();

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  for (const client of queryClients) client.clear();
  queryClients.clear();
});
after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const listPath = '/console/api/v1/auth/sessions';
const currentRevokePath = `${listPath}/session-current/revoke`;
const otherRevokePath = `${listPath}/session%2Fother/revoke`;
const othersRevokePath = `${listPath}/revoke-others`;
const currentSession: SafeCustomerSession = {
  id: 'session-current', createdAt: '2026-10-03T08:00:00.000Z',
  expiresAt: '2026-10-10T08:00:00.000Z', revokedAt: null,
  status: 'active', current: true,
};
const otherSession: SafeCustomerSession = { ...currentSession, id: 'session/other', current: false };
const revokedOther: SafeCustomerSession = {
  ...otherSession, status: 'revoked', revokedAt: '2026-10-03T09:00:00.000Z',
};
const currentResult = {
  sessionId: currentSession.id, revokedAt: '2026-10-03T09:00:00.000Z', currentSessionRevoked: true,
};
const otherResult = { ...currentResult, sessionId: otherSession.id, currentSessionRevoked: false };
function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function wire(handler: (path: string, method: string) => Response | Promise<Response>) {
  const calls: Array<{ path: string; method: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { cookie: 'mr_saas_csrf=lifecycle-test-csrf' },
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    assert.ok([listPath, currentRevokePath, otherRevokePath, othersRevokePath].includes(path), `unexpected route ${path}`);
    calls.push({ path, method, init: init ?? {} });
    return handler(path, method);
  };
  return calls;
}

function mountedLifecycle(options: { isCurrent?: () => boolean; onCurrentSessionRevoked?: () => void | Promise<void> } = {}) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.add(cache);
  cache.setQueryData(customerSessionsKey, [currentSession, otherSession]);
  const lifecycle = createCustomerSessionMutationLifecycle({
    isCurrent: options.isCurrent,
    onCurrentSessionRevoked: options.onCurrentSessionRevoked ?? (() => {}),
    refresh: async (isCurrent) => {
      const rows = await saasClient.getCustomerSessions();
      if (isCurrent()) cache.setQueryData(customerSessionsKey, rows);
    },
  });
  return { lifecycle, cache };
}

test('current revoke starts the real list read, but invalidates before that read can finish', async () => {
  const read = deferred<Response>();
  const invalidated = deferred<void>();
  const calls = wire((path, method) => {
    if (path === currentRevokePath && method === 'POST') return response(currentResult);
    assert.equal(path, listPath);
    assert.equal(method, 'GET');
    return read.promise;
  });
  let settled = false;
  const work = performCustomerSessionMutation({ kind: 'session', sessionId: currentSession.id }, {
    refresh: saasClient.getCustomerSessions,
    onCurrentSessionRevoked: () => { invalidated.resolve(undefined); },
  });
  void work.then(() => { settled = true; }, () => { settled = true; });
  await invalidated.promise;
  assert.equal(settled, false);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    [currentRevokePath, 'POST'], [listPath, 'GET'],
  ]);
  read.resolve(response({ sessions: [] }));
  assert.deepEqual(await work, currentResult);
});

test('successful current revoke still invalidates when the list refresh rejects', async () => {
  wire(() => response(currentResult));
  const original = new Error('original-refresh-failure');
  let invalidations = 0;
  await assert.rejects(performCustomerSessionMutation({ kind: 'session', sessionId: currentSession.id }, {
    refresh: async () => { throw original; },
    onCurrentSessionRevoked: () => { invalidations += 1; },
  }), error => error === original);
  assert.equal(invalidations, 1);
});

test('refresh rejection remains the original error even if local invalidation also fails', async () => {
  wire(() => response(currentResult));
  const original = new Error('original-refresh-failure');
  const cleanup = new Error('separate-invalidation-failure');
  let invalidations = 0;
  await assert.rejects(performCustomerSessionMutation({ kind: 'session', sessionId: currentSession.id }, {
    refresh: async () => { throw original; },
    onCurrentSessionRevoked: async () => { invalidations += 1; throw cleanup; },
  }), error => error === original);
  assert.equal(invalidations, 1);
});

test('a sole invalidation failure is preserved without repeating the server mutation', async () => {
  const calls = wire(() => response(currentResult));
  const original = new Error('original-invalidation-failure');
  let invalidations = 0;
  await assert.rejects(performCustomerSessionMutation({ kind: 'session', sessionId: currentSession.id }, {
    refresh: async () => {},
    onCurrentSessionRevoked: () => { invalidations += 1; throw original; },
  }), error => error === original);
  assert.equal(calls.length, 1);
  assert.equal(invalidations, 1);
});

test('endpoint rejection remains the original error and never invents a revoke acknowledgement', async () => {
  const original = new SaasApiError(403, 'FORBIDDEN', 'not-rendered');
  let reads = 0;
  let invalidations = 0;
  await assert.rejects(performCustomerSessionMutation({ kind: 'session', sessionId: currentSession.id }, {
    client: {
      revokeCustomerSession: async () => { throw original; },
      revokeOtherCustomerSessions: async () => ({ revokedCount: 0, currentSessionPreserved: true }),
    },
    refresh: async () => { reads += 1; },
    onCurrentSessionRevoked: () => { invalidations += 1; },
  }), error => error === original);
  assert.equal(reads, 0);
  assert.equal(invalidations, 0);
});

test('real other-session and revoke-others routes refresh authoritative rows without signing out', async () => {
  let invalidations = 0;
  const calls = wire((path, method) => {
    if (method === 'GET') return response({ sessions: [currentSession, revokedOther] });
    if (path === otherRevokePath) return response(otherResult);
    assert.equal(path, othersRevokePath);
    return response({ revokedCount: 0, currentSessionPreserved: true });
  });
  const { lifecycle, cache } = mountedLifecycle({ onCurrentSessionRevoked: () => { invalidations += 1; } });
  const one = await lifecycle.perform({ kind: 'session', sessionId: otherSession.id });
  const others = await lifecycle.perform({ kind: 'others' });
  assert.ok(one.status === 'complete');
  assert.deepEqual(one.result, otherResult);
  assert.ok(others.status === 'complete');
  assert.deepEqual(others.result, { revokedCount: 0, currentSessionPreserved: true });
  assert.equal(invalidations, 0);
  assert.deepEqual(cache.getQueryData(customerSessionsKey), [currentSession, revokedOther]);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    [otherRevokePath, 'POST'], [listPath, 'GET'], [othersRevokePath, 'POST'], [listPath, 'GET'],
  ]);
  for (const call of calls.filter(call => call.method === 'POST')) {
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(new Headers(call.init.headers).get('x-csrf-token'), 'lifecycle-test-csrf');
    assert.deepEqual(JSON.parse(String(call.init.body)), {});
  }
});

test('the server currentSessionRevoked flag, not the selected UI session, controls invalidation', async () => {
  const calls = wire((_path, method) => method === 'GET'
    ? response({ sessions: [currentSession] })
    : response({ ...currentResult, currentSessionRevoked: false }));
  let invalidations = 0;
  const { lifecycle } = mountedLifecycle({ onCurrentSessionRevoked: () => { invalidations += 1; } });
  assert.equal((await lifecycle.perform({ kind: 'session', sessionId: currentSession.id })).status, 'complete');
  assert.equal(invalidations, 0);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('same-tick duplicate or different-session triggers cannot issue a second mutation', async () => {
  const reply = deferred<Response>();
  const calls = wire((_path, method) => method === 'POST' ? reply.promise : response({ sessions: [] }));
  const { lifecycle } = mountedLifecycle();
  const first = lifecycle.perform({ kind: 'session', sessionId: otherSession.id });
  assert.equal(lifecycle.busy, true);
  assert.deepEqual(await lifecycle.perform({ kind: 'session', sessionId: otherSession.id }), { status: 'ignored', reason: 'busy' });
  assert.deepEqual(await lifecycle.perform({ kind: 'others' }), { status: 'ignored', reason: 'busy' });
  assert.equal(calls.length, 1);
  reply.resolve(response(otherResult));
  assert.equal((await first).status, 'complete');
  assert.equal(lifecycle.busy, false);
});

test('network unknown blocks resubmission until an explicit GET confirms the list, never auto-retries POST', async () => {
  let fail = true;
  let invalidations = 0;
  const calls = wire((_path, method) => {
    if (method === 'GET') return response({ sessions: [currentSession, fail ? otherSession : revokedOther] });
    if (fail) throw new Error('private-network-payload');
    return response(otherResult);
  });
  const { lifecycle, cache } = mountedLifecycle({ onCurrentSessionRevoked: () => { invalidations += 1; } });
  const attempt = await lifecycle.perform({ kind: 'session', sessionId: otherSession.id });
  assert.ok(attempt.status === 'error');
  assert.equal(attempt.outcome, 'unknown');
  assert.ok(attempt.error instanceof SaasApiError && attempt.error.code === 'NETWORK');
  assert.equal(lifecycle.requiresRefresh, true);
  assert.equal(invalidations, 0);
  assert.deepEqual(cache.getQueryData(customerSessionsKey), [currentSession, otherSession]);
  assert.deepEqual(await lifecycle.perform({ kind: 'others' }), { status: 'ignored', reason: 'refresh-required' });
  assert.equal(calls.length, 1);
  assert.equal((await lifecycle.refreshAndConfirm()).status, 'refreshed');
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(lifecycle.requiresRefresh, false);
  assert.deepEqual(cache.getQueryData(customerSessionsKey), [currentSession, otherSession]);
  fail = false;
  assert.equal((await lifecycle.perform({ kind: 'session', sessionId: otherSession.id })).status, 'complete');
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'POST', 'GET']);
  assert.deepEqual(cache.getQueryData(customerSessionsKey), [currentSession, revokedOther]);
});

test('unreadable acknowledgement and server storage errors remain unknown, without cleanup or retry', async () => {
  let invalidations = 0;
  const calls = wire(() => new Response('{broken', { status: 200 }));
  const { lifecycle } = mountedLifecycle({ onCurrentSessionRevoked: () => { invalidations += 1; } });
  const malformed = await lifecycle.perform({ kind: 'session', sessionId: currentSession.id });
  assert.ok(malformed.status === 'error');
  assert.equal(malformed.outcome, 'unknown');
  assert.equal(invalidations, 0);
  assert.equal(calls.length, 1);

  const other = mountedLifecycle();
  wire(() => new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'private-storage-payload' } }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }));
  const storage = await other.lifecycle.perform({ kind: 'others' });
  assert.ok(storage.status === 'error');
  assert.equal(storage.outcome, 'unknown');
  assert.equal(other.lifecycle.requiresRefresh, true);
});

test('failed explicit refresh keeps unknown blocked and does not repeat the mutation', async () => {
  const calls = wire(() => { throw new Error('offline'); });
  const { lifecycle } = mountedLifecycle();
  await lifecycle.perform({ kind: 'others' });
  assert.equal((await lifecycle.refreshAndConfirm()).status, 'error');
  assert.equal(lifecycle.requiresRefresh, true);
  assert.deepEqual(await lifecycle.perform({ kind: 'others' }), { status: 'ignored', reason: 'refresh-required' });
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
});

test('known server denial preserves auth and safe status without broadening it to a confirmed revoke', async () => {
  let invalidations = 0;
  const calls = wire(() => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'private-denial' } }), {
    status: 403, headers: { 'content-type': 'application/json' },
  }));
  const { lifecycle } = mountedLifecycle({ onCurrentSessionRevoked: () => { invalidations += 1; } });
  const attempt = await lifecycle.perform({ kind: 'session', sessionId: currentSession.id });
  assert.ok(attempt.status === 'error');
  assert.equal(attempt.outcome, 'rejected');
  assert.ok(attempt.error instanceof SaasApiError && attempt.error.code === 'FORBIDDEN');
  assert.equal(lifecycle.requiresRefresh, false);
  assert.equal(invalidations, 0);
  assert.equal(calls.length, 1);
});

test('confirmed revoke plus refresh failure preserves original read error, cleans once, and requires a read', async () => {
  let original: unknown;
  let invalidations = 0;
  const calls = wire((_path, method) => method === 'POST' ? response(currentResult) : Promise.reject(new Error('read-failure')));
  const lifecycle = createCustomerSessionMutationLifecycle({
    refresh: async () => {
      try { await saasClient.getCustomerSessions(); }
      catch (error) { original = error; throw error; }
    },
    onCurrentSessionRevoked: () => { invalidations += 1; throw new Error('secondary-cleanup-error'); },
  });
  const attempt = await lifecycle.perform({ kind: 'session', sessionId: currentSession.id });
  assert.ok(attempt.status === 'error');
  assert.equal(attempt.outcome, 'confirmed');
  assert.equal(attempt.error, original);
  assert.equal(invalidations, 1);
  assert.equal(lifecycle.requiresRefresh, true);
  assert.deepEqual(await lifecycle.perform({ kind: 'session', sessionId: currentSession.id }), { status: 'ignored', reason: 'refresh-required' });
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
});

test('unmounted lifecycle ignores a late current-session acknowledgement and new actions', async () => {
  const reply = deferred<Response>();
  const calls = wire(() => reply.promise);
  let invalidations = 0;
  const { lifecycle } = mountedLifecycle({ onCurrentSessionRevoked: () => { invalidations += 1; } });
  const pending = lifecycle.perform({ kind: 'session', sessionId: currentSession.id });
  lifecycle.deactivate();
  reply.resolve(response(currentResult));
  assert.deepEqual(await pending, { status: 'ignored', reason: 'stale' });
  assert.deepEqual(await lifecycle.perform({ kind: 'others' }), { status: 'ignored', reason: 'stale' });
  assert.deepEqual(await lifecycle.refreshAndConfirm(), { status: 'ignored', reason: 'stale' });
  assert.equal(invalidations, 0);
  assert.equal(calls.length, 1);
});

test('replacement login invalidates old work before a late callback can clear its authentication', async () => {
  const reply = deferred<Response>();
  const calls = wire(() => reply.promise);
  let owner = 'old-login';
  let invalidations = 0;
  const { lifecycle } = mountedLifecycle({
    isCurrent: () => owner === 'old-login',
    onCurrentSessionRevoked: () => { invalidations += 1; },
  });
  const pending = lifecycle.perform({ kind: 'session', sessionId: currentSession.id });
  owner = 'replacement-login';
  reply.resolve(response(currentResult));
  assert.deepEqual(await pending, { status: 'ignored', reason: 'stale' });
  assert.equal(invalidations, 0);
  assert.equal(calls.length, 1);
});

test('late list response cannot publish rows into a replacement scope or release its active lock', async () => {
  const oldRead = deferred<Response>();
  const oldStarted = deferred<void>();
  const newRead = deferred<Response>();
  const newStarted = deferred<void>();
  let reads = 0;
  wire((_path, method) => {
    if (method === 'POST') return response(otherResult);
    reads += 1;
    if (reads === 1) { oldStarted.resolve(undefined); return oldRead.promise; }
    newStarted.resolve(undefined);
    return newRead.promise;
  });
  const { lifecycle, cache } = mountedLifecycle();
  const oldWork = lifecycle.perform({ kind: 'session', sessionId: otherSession.id });
  await oldStarted.promise;
  lifecycle.deactivate();
  lifecycle.activate();
  const newRows: SafeCustomerSession[] = [{ ...currentSession, id: 'replacement-current' }];
  cache.setQueryData(customerSessionsKey, newRows);
  const newWork = lifecycle.perform({ kind: 'session', sessionId: otherSession.id });
  await newStarted.promise;
  oldRead.resolve(response({ sessions: [revokedOther] }));
  assert.deepEqual(await oldWork, { status: 'ignored', reason: 'stale' });
  assert.deepEqual(cache.getQueryData(customerSessionsKey), newRows);
  assert.equal(lifecycle.busy, true);
  assert.deepEqual(await lifecycle.perform({ kind: 'others' }), { status: 'ignored', reason: 'busy' });
  newRead.resolve(response({ sessions: newRows }));
  assert.equal((await newWork).status, 'complete');
  assert.equal(lifecycle.busy, false);
});

test('explicit confirmation reads also use a synchronous single-flight lock', async () => {
  const read = deferred<Response>();
  const calls = wire(() => read.promise);
  const { lifecycle } = mountedLifecycle();
  const pending = lifecycle.refreshAndConfirm();
  assert.deepEqual(await lifecycle.refreshAndConfirm(), { status: 'ignored', reason: 'busy' });
  assert.deepEqual(await lifecycle.perform({ kind: 'others' }), { status: 'ignored', reason: 'busy' });
  assert.equal(calls.length, 1);
  read.resolve(response({ sessions: [currentSession] }));
  assert.equal((await pending).status, 'refreshed');
});

test('uncertain and confirmed-local-failure notices preserve safe DOM copy without raw error/secret/XSS payloads', () => {
  const poison = '<script>session-secret-must-not-render</script>';
  const render = (outcome: 'unknown' | 'confirmed') => renderToStaticMarkup(React.createElement(SessionSecurityErrorNotice, {
    error: new SaasApiError(0, 'NETWORK', poison, { token: poison }), outcome,
    onRetry: () => {}, onLogout: async () => {},
  }));
  const uncertain = render('unknown');
  assert.match(uncertain, /撤销结果尚未确认/);
  assert.match(uncertain, /不会自动重试撤销/);
  assert.match(uncertain, /刷新会话列表确认/);
  assert.doesNotMatch(uncertain, /已撤销|session-secret|<script>/);
  const confirmed = render('confirmed');
  assert.match(confirmed, /撤销已确认，页面更新未完成/);
  assert.match(confirmed, /不要重复提交/);
  assert.doesNotMatch(confirmed, /session-secret|<script>/);
});

test('real page binds the lifecycle to existing APIs, scoped cache and guarded local auth invalidation', () => {
  const source = readFileSync(resolve(process.cwd(), 'web/src/features/saas-console.tsx'), 'utf8');
  const pageStart = source.indexOf('export function CustomerSessionsPage');
  const pageEnd = source.indexOf('const customerRefundStatusPresentation', pageStart);
  assert.ok(pageStart >= 0 && pageEnd > pageStart);
  const page = source.slice(pageStart, pageEnd);
  assert.match(page, /const lifecycle = useMemo\(\(\) => createCustomerSessionMutationLifecycle/);
  assert.match(page, /const attempt = await lifecycle\.perform\(mutation\)/);
  assert.match(page, /const attempt = await lifecycle\.refreshAndConfirm\(\)/);
  assert.match(page, /const rows = await saasClient\.getCustomerSessions\(\);\s*if \(isCurrent\(\)\) queryClient\.setQueryData\(scopedSessionsKey, rows\)/);
  assert.match(source, /if \(sessionScope\.current !== session\) return;/);
  assert.match(source, /isCurrentSessionScope=\{\(\) => sessionScope\.current === session\}/);
  assert.match(page, /return \(\) => lifecycle\.deactivate\(\)/);
  assert.doesNotMatch(page, /await sessions\.refetch\(\)/);
});
