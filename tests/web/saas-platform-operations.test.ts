import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearPlatformCsrfToken, PlatformApiError, platformClient } from '../../web/src/api/saas-platform-client.ts';
import {
  type OperationsDiagnosticsPage,
  type OpsMediaTaskRow,
  platformOpsClient,
  type SchedulingHealthRow,
} from '../../web/src/api/saas-platform-ops-client.ts';

const originalFetch = globalThis.fetch;
const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
let media: typeof import('../../web/src/features/media-task-operations.tsx');
let health: typeof import('../../web/src/features/scheduling-health.tsx');
let diagnostics: typeof import('../../web/src/features/operations-diagnostics.tsx');
let MemoryRouter: typeof import('react-router-dom')['MemoryRouter'];
const AT = '2026-10-21T01:00:00.000Z';
const TASK: OpsMediaTaskRow = {
  kind: 'video',
  taskId: 'accepted:video',
  tenantId: 'tenant-one',
  proxyKeyId: 'proxy-one',
  status: 'pending',
  statusSource: 'video_billing',
  diagnostic: 'poll_overdue',
  requestId: 'request-one',
  accountId: 'account-one',
  financialStatus: 'pending',
  executionState: 'unknown',
  recovery: { leaseOwner: null, leaseEpoch: 7, leaseUntil: null, nextPollAt: AT, pollFailures: 5, canRequeue: true },
  latestRequeue: null,
  createdAt: AT,
  completedAt: null,
  expiresAt: AT,
};
const HEALTH: SchedulingHealthRow = {
  accountId: 'account-one',
  displayName: 'Account One',
  providerId: 'kimi-code-cn',
  accountStatus: 'pending',
  validationState: 'failed',
  validationErrorCode: 'provider_response_too_large',
  validationCredentialId: null,
  windowState: 'sticky_only',
  windowFacts: {
    usageMinorUnits: '9007199254740993',
    limitMinorUnits: '9007199254740990',
    reserveMinorUnits: '10',
    windowStart: AT,
  },
  thresholdPauseUntil: AT,
  thresholdPauseReason: 'window=rolling',
  healthState: 'cooldown',
  healthLastOutcome: 'gateway_network_failure',
  healthCooldownUntil: AT,
  healthObservedAt: AT,
  quotaObservedAt: null,
  quotaFreshness: 'unobserved',
  probe: null,
};
const DIAGNOSTICS: OperationsDiagnosticsPage = {
  snapshotAt: AT,
  sources: [{ name: 'daily_summary', observedAt: AT, observationKind: 'schedule_claim', freshness: 'fresh' }],
  alerts: [{ id: 'alert-one', name: 'Fault Rule', metric: 'channel_error_rate', triggeredAt: AT, resolvedAt: null }],
  financial: {
    open: '1',
    operatorRequired: '1',
    oldestAt: AT,
    cases: [
      {
        caseId: 'case-one',
        tenantId: 'tenant-one',
        requestId: 'request-one',
        state: 'operator_required',
        scanAttempts: 12,
        lastErrorCode: 'RECONCILIATION_RETRY_LIMIT',
        createdAt: AT,
      },
    ],
  },
  validation: { queued: '0', leased: '0', expiredLeases: '0', failed: '1', oldestQueuedAt: null, lastCompletedAt: AT },
};
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
const render = (element: React.ReactElement) => renderToStaticMarkup(React.createElement(MemoryRouter, null, element));

before(async () => {
  reactGlobal.React = React;
  ({ MemoryRouter } = await import('react-router-dom'));
  media = await import('../../web/src/features/media-task-operations.tsx');
  health = await import('../../web/src/features/scheduling-health.tsx');
  diagnostics = await import('../../web/src/features/operations-diagnostics.tsx');
});
afterEach(() => {
  clearPlatformCsrfToken();
  globalThis.fetch = originalFetch;
});
after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

test('operations client unwraps bounded task facts, drops payloads and carries CSRF/idempotency on requeue', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/session')) return json({ session: { userId: 'operator' }, csrfToken: 'test-csrf' });
    if (String(url).includes('/requeue'))
      return json({
        status: 'queued',
        auditEventId: 'audit-one',
        leaseEpoch: 8,
        queuedAt: AT,
        upstreamBody: 'must-not-leak',
      });
    return json({
      snapshotAt: AT,
      limit: 100,
      rows: [{ ...TASK, payload: 'must-not-leak' }],
      counts: { total: 1, processing: 1, terminalUnsettled: 0, recoveryActive: 0, overdue: 1 },
    });
  };
  await platformClient.login({ email: 'ops@example.test', password: 'synthetic-password', code: '123456' });
  const page = await platformOpsClient.listOpsMediaTasks({ kind: 'video', includeTerminal: false });
  assert.deepEqual(page.rows, [TASK]);
  assert.doesNotMatch(JSON.stringify(page), /must-not-leak|payload/);
  const receipt = await platformOpsClient.requeueVideo({
    taskId: TASK.taskId,
    tenantId: TASK.tenantId,
    expectedLeaseEpoch: 7,
    reason: 'Account recovered',
    idempotencyKey: 'incident:one',
  });
  assert.equal(receipt.auditEventId, 'audit-one');
  assert.doesNotMatch(JSON.stringify(receipt), /upstreamBody|must-not-leak/);
  const call = calls[2]!;
  assert.equal(call.url, '/admin/api/v1/ops/media-tasks/video/accepted%3Avideo/requeue');
  assert.equal(new Headers(call.init.headers).get('x-csrf-token'), 'test-csrf');
  assert.equal(new Headers(call.init.headers).get('idempotency-key'), 'incident:one');
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    tenantId: TASK.tenantId,
    expectedLeaseEpoch: 7,
    reason: 'Account recovered',
  });
});

test('strict scheduling diagnostics preserve exact minor units and reject unsafe versions or malformed freshness', async () => {
  globalThis.fetch = async () =>
    json({
      snapshotAt: AT,
      limit: 100,
      scanned: 1,
      freshnessThresholdSeconds: 600,
      rows: [HEALTH],
      counts: { total: 1, paused: 0, stickyOnly: 1, thresholdPaused: 0, unhealthy: 1, quotaStale: 1 },
    });
  assert.equal(
    (await platformOpsClient.listOpsSchedulingHealth()).rows[0]?.windowFacts?.usageMinorUnits,
    '9007199254740993',
  );
  globalThis.fetch = async () =>
    json({
      snapshotAt: AT,
      limit: 100,
      rows: [{ ...TASK, recovery: { ...TASK.recovery, leaseEpoch: Number.MAX_SAFE_INTEGER + 1 } }],
      counts: { total: 1, processing: 1, terminalUnsettled: 0, recoveryActive: 0, overdue: 1 },
    });
  await assert.rejects(
    platformOpsClient.listOpsMediaTasks(),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );
  globalThis.fetch = async () =>
    json({
      ...DIAGNOSTICS,
      sources: [{ name: 'daily', observedAt: 'invalid', observationKind: 'schedule_claim', freshness: 'fresh' }],
    });
  await assert.rejects(
    platformOpsClient.diagnostics(),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('media UI separates billing state, fences readonly actions, and requires reason and confirmation', () => {
  const table = render(React.createElement(media.MediaTaskTable, { rows: [TASK], canManage: false, onRequeue() {} }));
  assert.match(table, /回查到期超过 1 分钟/);
  assert.match(table, /结算：pending/);
  assert.match(table, /disabled=""/);
  assert.match(table, /unknown-outcomes\?tenantId=tenant-one/);
  const form = render(
    React.createElement(media.MediaRequeueForm, {
      row: TASK,
      busy: false,
      locked: true,
      errorCode: 'TASK_STATE_CONFLICT',
      onSubmit: async () => {},
      onCancel() {},
    }),
  );
  assert.match(form, /name="reason"/);
  assert.match(form, /type="checkbox"/);
  assert.match(form, /不会重放创建任务/);
  assert.match(form, /Idempotency-Key/);
  assert.match(form, /任务已变化/);
});

test('diagnostics distinguish schedule claims and successful freshness, link financial evidence and show gateway readiness stages', () => {
  const markup = render(React.createElement(diagnostics.OperationsDiagnosticsContent, { page: DIAGNOSTICS }));
  assert.match(markup, /不证明邮件发送成功/);
  assert.match(markup, /人工核对/);
  assert.match(markup, /RECONCILIATION_RETRY_LIMIT/);
  assert.match(markup, /尚未配置网关能力探针来源/);
  const gateway: OperationsDiagnosticsPage = {
    ...DIAGNOSTICS,
    gatewayCapabilities: {
      state: 'available',
      observedAt: AT,
      readiness: {
        configurationValid: true,
        fatalReasonCodes: [],
        capabilities: [
          {
            capability: 'bundle:kimi',
            label: 'Kimi Runtime',
            kind: 'provider-bundle',
            enabled: true,
            assembled: true,
            verified: true,
            operational: false,
            verificationLevel: 'mock',
            reasonCodes: ['RUNTIME_NOT_LIVE_VERIFIED'],
            productIds: [],
            endpointScopes: [],
            unavailableEndpointScopes: ['v1/messages'],
          },
        ],
      },
    },
  };
  const stages = render(React.createElement(diagnostics.OperationsDiagnosticsContent, { page: gateway }));
  assert.match(stages, /已装配/);
  assert.match(stages, /已验证/);
  assert.match(stages, /可运营/);
  assert.match(stages, /RUNTIME_NOT_LIVE_VERIFIED/);
  assert.match(stages, /mock/);
  const account = render(
    React.createElement(health.SchedulingHealthTable, {
      rows: [HEALTH],
      canManage: false,
      busyAccount: '',
      onProbe() {},
    }),
  );
  assert.match(account, /没有成功配额观察/);
  assert.match(account, /provider_response_too_large/);
  assert.match(account, /9007199254740993/);
  assert.match(account, /disabled=""/);
});
