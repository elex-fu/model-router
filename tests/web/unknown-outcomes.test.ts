import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clearPlatformCsrfToken,
  hasPlatformCsrfToken,
  PlatformApiError,
  platformClient,
  type PlatformUnknownOutcomeCaseDetail,
} from '../../web/src/api/saas-platform-client.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
const originalFetch = globalThis.fetch;
let platformFeature: typeof import('../../web/src/features/saas-platform.tsx');

const TENANT_ID = 'tenant-unknown-outcome';
const CASE_ID = 'case-unknown-001';
const ATTEMPT_IDS = ['attempt-001', 'attempt-002'];

const SUMMARY = {
  caseId: CASE_ID,
  tenantId: TENANT_ID,
  projectId: 'project-001',
  requestId: 'request-001',
  supplyMode: 'platform' as const,
  scanAttempts: 12,
  lastErrorCode: 'RECONCILIATION_RETRY_LIMIT',
  createdAt: '2026-09-29T01:00:00.000Z',
};

const DETAIL_PAYLOAD = {
  summary: SUMMARY,
  possibleAttemptIds: ATTEMPT_IDS,
  observations: [
    {
      observationId: 'observation-001',
      kind: 'attempt_snapshot',
      observedAt: '2026-09-29T01:01:00.000Z',
      attemptId: ATTEMPT_IDS[0],
      usageEventId: null,
      supplyMode: 'platform',
      executionState: 'unknown',
      reconciliationState: 'pending',
      financialStatus: 'reconciliation_pending',
      requestStateVersion: 2,
      dispatchState: 'unknown',
      resultState: 'unknown',
      responseStarted: false,
      attemptStateVersion: 3,
      upstreamId: 'upstream-001',
      accountOwnerKind: 'platform',
      accountId: 'account-001',
      providerId: 'provider-001',
      productId: 'product-001',
      resolvedModel: 'model-001',
      unknownReason: 'upstream_timeout',
      usageEventDigest: null,
      providerStatus: null,
      providerOperationId: null,
      providerIdentityDigest: null,
      evidenceReference: null,
      operatorOutcome: null,
      actorUserId: 'must-not-be-retained',
      reason: 'must-not-be-retained',
      auditEventId: 'audit-001',
      providerUsage: {
        promptTokens: 99,
        responseTokens: 99,
        prompt: 'must-not-be-retained',
        responseBody: 'must-not-be-retained',
      },
      prompt: 'must-not-be-retained',
      responseBody: 'must-not-be-retained',
    },
  ],
};

const DETAIL: PlatformUnknownOutcomeCaseDetail = {
  summary: SUMMARY,
  possibleAttemptIds: [...ATTEMPT_IDS],
  observations: [
    {
      observationId: 'observation-001',
      kind: 'attempt_snapshot',
      observedAt: '2026-09-29T01:01:00.000Z',
      attemptId: ATTEMPT_IDS[0] ?? null,
      usageEventId: null,
      supplyMode: 'platform',
      executionState: 'unknown',
      reconciliationState: 'pending',
      financialStatus: 'reconciliation_pending',
      requestStateVersion: 2,
      dispatchState: 'unknown',
      resultState: 'unknown',
      responseStarted: false,
      attemptStateVersion: 3,
      upstreamId: 'upstream-001',
      accountOwnerKind: 'platform',
      accountId: 'account-001',
      providerId: 'provider-001',
      productId: 'product-001',
      resolvedModel: 'model-001',
      unknownReason: 'upstream_timeout',
      usageEventDigest: null,
      providerStatus: null,
      providerOperationId: null,
      providerIdentityDigest: null,
      evidenceReference: null,
      operatorOutcome: null,
      auditEventId: 'audit-001',
    },
  ],
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
});

test('unknown-outcome client uses tenant query, strict safe projection, CSRF, and fixed resolution body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    if (url.endsWith('/auth/session')) return jsonResponse({ session: { userId: 'admin-user' }, csrfToken: 'csrf-token' });
    if (url.includes('/resolve-not-executed')) {
      return jsonResponse({ status: 'resolved', caseId: CASE_ID, requestId: SUMMARY.requestId }, 200);
    }
    if (url.includes(`/${CASE_ID}?`)) return jsonResponse(DETAIL_PAYLOAD);
    return jsonResponse([{ ...SUMMARY, prompt: 'must-not-be-retained', responseBody: 'must-not-be-retained' }]);
  };

  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  const cases = await platformClient.listUnknownOutcomeCases({ tenantId: TENANT_ID, limit: 25 });
  const detail = await platformClient.getUnknownOutcomeCase(TENANT_ID, CASE_ID);
  const resolution = await platformClient.resolveUnknownOutcomeNotExecuted({
    tenantId: TENANT_ID,
    caseId: CASE_ID,
    supportTicketRef: 'SUP-1001',
    reason: '证据定位显示没有执行。',
    coverage: ATTEMPT_IDS.map(attemptId => ({ attemptId, evidenceReference: `ticket://SUP-1001/${attemptId}` })),
    idempotencyKey: 'resolution-key-001',
  });

  assert.deepEqual(cases, [SUMMARY]);
  assert.equal(detail.summary.caseId, CASE_ID);
  assert.deepEqual(detail.possibleAttemptIds, ATTEMPT_IDS);
  assert.equal('providerUsage' in (detail.observations[0] ?? {}), false);
  assert.equal('actorUserId' in (detail.observations[0] ?? {}), false);
  assert.equal('reason' in (detail.observations[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(detail), /must-not-be-retained|prompt|responseBody|providerUsage|actorUserId/);
  assert.deepEqual(resolution, { status: 'resolved', caseId: CASE_ID, requestId: SUMMARY.requestId });

  const listUrl = new URL(calls[1]?.url ?? '/missing', 'http://localhost');
  assert.equal(listUrl.pathname, '/admin/api/v1/ops/unknown-outcomes');
  assert.equal(listUrl.searchParams.get('tenantId'), TENANT_ID);
  assert.equal(listUrl.searchParams.get('limit'), '25');
  const detailUrl = new URL(calls[2]?.url ?? '/missing', 'http://localhost');
  assert.equal(detailUrl.pathname, `/admin/api/v1/ops/unknown-outcomes/${CASE_ID}`);
  assert.equal(detailUrl.searchParams.get('tenantId'), TENANT_ID);
  const resolveUrl = new URL(calls[3]?.url ?? '/missing', 'http://localhost');
  assert.equal(resolveUrl.pathname, `/admin/api/v1/ops/unknown-outcomes/${CASE_ID}/resolve-not-executed`);
  assert.equal(resolveUrl.searchParams.get('tenantId'), TENANT_ID);
  assert.equal(new Headers(calls[3]?.init.headers).get('x-csrf-token'), 'csrf-token');
  assert.equal(new Headers(calls[3]?.init.headers).get('idempotency-key'), 'resolution-key-001');
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), {
    supportTicketRef: 'SUP-1001',
    reason: '证据定位显示没有执行。',
    outcome: 'not_executed',
    coverage: ATTEMPT_IDS.map(attemptId => ({
      attemptId,
      outcome: 'not_executed',
      evidenceReference: `ticket://SUP-1001/${attemptId}`,
    })),
  });
  assert.doesNotMatch(String(calls[3]?.init.body), /tenantId|actorUserId|prompt|responseBody/);
});

test('401 clears the in-memory platform CSRF token and malformed unknown-outcome data is rejected', async () => {
  let callNumber = 0;
  globalThis.fetch = async (_input, _init) => {
    callNumber += 1;
    if (callNumber === 1) return jsonResponse({ session: { userId: 'admin-user' }, csrfToken: 'csrf-token' });
    return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'must-not-leak' } }), { status: 401 });
  };
  await platformClient.login({ email: 'admin@example.test', password: 'not-retained', code: '123456' });
  assert.equal(hasPlatformCsrfToken(), true);
  await assert.rejects(
    platformClient.listUnknownOutcomeCases({ tenantId: TENANT_ID }),
    (error: unknown) => error instanceof PlatformApiError && error.status === 401,
  );
  assert.equal(hasPlatformCsrfToken(), false);

  globalThis.fetch = async () => jsonResponse([{ ...SUMMARY, scanAttempts: 13 }]);
  await assert.rejects(
    platformClient.listUnknownOutcomeCases({ tenantId: TENANT_ID }),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('unknown-outcome UI exposes safe form fields, fixed outcome, evidence warning, and confirmation', () => {
  const form = renderToStaticMarkup(
    React.createElement(platformFeature.UnknownOutcomeResolutionForm, {
      detail: DETAIL,
      busy: false,
      state: { kind: 'idle' },
      idempotencyStatus: '尚未生成',
      onSubmit: async () => {},
    }),
  );
  assert.match(form, /supportTicketRef/);
  assert.match(form, /reason/);
  assert.match(form, /not_executed/);
  assert.match(form, /evidenceReference 只用于定位证据，不是已验证的 Provider 证明/);
  assert.match(form, /提交前二次确认/);
  assert.match(form, /type="checkbox"/);
  assert.match(form, /evidenceReference attempt-001/);
  assert.match(form, /evidenceReference attempt-002/);
  assert.doesNotMatch(form, /prompt|responseBody|providerUsage|must-not-be-retained/);
});

test('unknown-outcome UI maps success, conflict, and authorization failure without server detail', () => {
  const render = (state: { kind: 'success'; status: 'resolved' | 'replayed' } | { kind: 'conflict' } | { kind: 'forbidden' }) =>
    renderToStaticMarkup(
      React.createElement(platformFeature.UnknownOutcomeResolutionForm, {
        detail: DETAIL,
        busy: false,
        state,
        idempotencyStatus: '已生成；重试会复用同一个 Idempotency-Key。',
        onSubmit: async () => {},
      }),
    );

  assert.match(render({ kind: 'success', status: 'resolved' }), /处置成功/);
  assert.match(render({ kind: 'conflict' }), /处置冲突/);
  assert.match(render({ kind: 'conflict' }), /重试会复用同一个 Idempotency-Key/);
  assert.match(render({ kind: 'forbidden' }), /权限不足/);
  assert.doesNotMatch(render({ kind: 'forbidden' }), /must-not-leak/);
  const unavailable = renderToStaticMarkup(
    React.createElement(platformFeature.PlatformErrorNotice, {
      error: new PlatformApiError(501, 'NOT_IMPLEMENTED', 'must-not-leak'),
      title: '未知结果案件读取失败',
    }),
  );
  assert.match(unavailable, /此管理接口当前不可用或尚未接入/);

  const readonlyPage = renderToStaticMarkup(
    React.createElement(platformFeature.UnknownOutcomesPage, {
      me: { kind: 'ready', me: { userId: 'admin-user', roles: ['security'] } },
    }),
  );
  assert.match(readonlyPage, /租户 ID/);
  assert.match(readonlyPage, /当前角色只读/);
  assert.doesNotMatch(readonlyPage, /提交 not_executed 处置/);
});
