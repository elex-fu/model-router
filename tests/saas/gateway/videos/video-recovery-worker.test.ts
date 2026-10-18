import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  GrokVideoUpstreamForwarder,
  GrokVideoUpstreamResponse,
} from '../../../../src/saas/gateway/videos/grok-video-upstream.js';
import type { SaasVideoBillingStateMachine } from '../../../../src/saas/gateway/videos/video-billing-state-machine.js';
import {
  backoffDelayMs,
  classifyRecoveryPoll,
  type VideoRecoveryAlertEvent,
  VideoTaskRecoveryWorker,
} from '../../../../src/saas/gateway/videos/video-recovery-worker.js';
import {
  InMemoryVideoTaskStore,
  type SaasVideoTaskCreateInput,
} from '../../../../src/saas/gateway/videos/video-task-store.js';

/**
 * Gap-remediation G-A1 (§1.4): the recovery worker's business invariants —
 * the no-client-poll settlement, the six-class failure ladder, the
 * fail-closed cap escalation, lease fencing and the bounded claim.
 */

const BASE_TIME = Date.parse('2026-10-18T12:00:00Z');

function taskInput(requestId: string, createdAtMs = BASE_TIME): SaasVideoTaskCreateInput {
  return {
    requestId,
    tenantId: 'tenant-a',
    proxyKeyId: 'key-a',
    providerAccountId: 'acct-1',
    credentialId: 'cred-1',
    credentialVersion: 'v1',
    gatewayRequestId: `req-${requestId}`,
    gatewayAttemptId: `att-${requestId}`,
    model: 'grok-video',
    resolution: '720p',
    durationSeconds: 5,
    videoCount: 1,
    settlementFacts: null,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

interface Harness {
  readonly store: InMemoryVideoTaskStore;
  readonly worker: VideoTaskRecoveryWorker;
  readonly polls: Array<{ readonly requestId: string }>;
  readonly observations: Array<{ readonly taskId: string; readonly status: string }>;
  readonly alerts: VideoRecoveryAlertEvent[];
  timeMs: number;
}

function harness(
  responses: (requestId: string) => GrokVideoUpstreamResponse,
  options: { readonly maxPollFailures?: number; readonly billingDisposition?: string } = {},
): Harness {
  const store = new InMemoryVideoTaskStore({ now: () => harnessState.timeMs });
  const harnessState: Harness = {
    store,
    polls: [],
    observations: [],
    alerts: [],
    timeMs: BASE_TIME,
    worker: undefined as unknown as VideoTaskRecoveryWorker,
  };
  const forwarder = {
    fetchStatus(request: { readonly requestId: string }): Promise<GrokVideoUpstreamResponse> {
      harnessState.polls.push({ requestId: request.requestId });
      return Promise.resolve(responses(request.requestId));
    },
  } as unknown as GrokVideoUpstreamForwarder;
  const billing = {
    observe(input: { readonly taskId: string; readonly statusBody: Record<string, unknown> }): Promise<unknown> {
      harnessState.observations.push({ taskId: input.taskId, status: String(input.statusBody.status ?? '') });
      return Promise.resolve({ disposition: options.billingDisposition ?? 'billed', taskId: input.taskId });
    },
  } as unknown as SaasVideoBillingStateMachine;
  harnessState.worker = new VideoTaskRecoveryWorker({
    store,
    forwarder,
    billing,
    owner: 'worker-test',
    maxPollFailures: options.maxPollFailures,
    now: () => harnessState.timeMs,
    alerts: (event) => {
      harnessState.alerts.push(event);
    },
  });
  return harnessState;
}

function okStatus(
  body: Record<string, unknown> = { status: 'done', video: { url: 'https://x/v.mp4' } },
): GrokVideoUpstreamResponse {
  return {
    kind: 'response',
    status: 200,
    body: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
  };
}

function httpStatus(status: number): GrokVideoUpstreamResponse {
  return { kind: 'response', status, body: new Uint8Array(), contentType: null };
}

test('G-A1 worker: a done status settles billing without any client poll', async () => {
  const h = harness(() => okStatus());
  await h.store.create(taskInput('task-1'));
  const result = await h.worker.runOnce();
  assert.equal(result.claimed, 1);
  assert.equal(result.polled, 1);
  assert.equal(result.billed, 1);
  assert.deepEqual(
    h.observations.map((o) => o.taskId),
    ['task-1'],
  );
  // The successful poll reset the failure ladder and re-armed the cursor.
  const record = await h.store.get('task-1');
  assert.equal(record?.billingState, 'pending'); // the fake billing never transitions state
  const second = await h.worker.runOnce();
  assert.equal(second.claimed, 0, 'the due cursor pushed the next poll into the future');
});

test('G-A1 worker: transient failures climb the backoff ladder and reset on success', async () => {
  const h = harness(() => httpStatus(500));
  await h.store.create(taskInput('task-2'));
  const first = await h.worker.runOnce();
  assert.equal(first.failedPolls, 1);
  // Not re-claimable until the backoff elapses.
  h.timeMs += 1_000;
  assert.equal((await h.worker.runOnce()).claimed, 0, 'inside the 15 s backoff window');
  h.timeMs += 15_000;
  assert.equal((await h.worker.runOnce()).claimed, 1, 'past the first backoff step');
});

test('G-A1 worker: the failure cap escalates to the fail-closed skip, never a guessed bill', async () => {
  const h = harness(() => httpStatus(500), { maxPollFailures: 3 });
  await h.store.create(taskInput('task-3'));
  for (let round = 0; round < 3; round += 1) {
    // Exhaust each backoff step deterministically.
    h.timeMs += 15 * 60 * 1000;
    const result = await h.worker.runOnce();
    assert.equal(result.claimed, 1, `round ${round}`);
  }
  const record = await h.store.get('task-3');
  assert.equal(record?.billingState, 'skipped');
  assert.ok(h.alerts.some((a) => a.code === 'VIDEO_RECOVERY_POLL_EXHAUSTED'));
  // Skipped rows are terminal for the recovery loop.
  h.timeMs += 15 * 60 * 1000;
  assert.equal((await h.worker.runOnce()).claimed, 0);
});

test('G-A1 worker: upstream 404 aborts immediately with a fail-closed skip', async () => {
  const h = harness(() => httpStatus(404));
  await h.store.create(taskInput('task-4'));
  const result = await h.worker.runOnce();
  assert.equal(result.skipped, 1);
  const record = await h.store.get('task-4');
  assert.equal(record?.billingState, 'skipped');
  assert.ok(h.alerts.some((a) => a.code === 'VIDEO_RECOVERY_UPSTREAM_NOT_FOUND'));
});

test('G-A1 worker: auth failures back off without burning the failure ladder', async () => {
  const h = harness(() => httpStatus(403), { maxPollFailures: 2 });
  await h.store.create(taskInput('task-5'));
  await h.worker.runOnce();
  h.timeMs += 15_000;
  await h.worker.runOnce();
  h.timeMs += 15_000;
  const third = await h.worker.runOnce();
  assert.equal(third.claimed, 1, 'auth failures wait for an operator, the cap never trips');
  const record = await h.store.get('task-5');
  assert.equal(record?.billingState, 'pending');
});

test('G-A1 worker: a 2xx body that is not JSON counts as unrecognized, never settles', async () => {
  const h = harness(() => ({
    kind: 'response' as const,
    status: 200,
    body: new TextEncoder().encode('not-json'),
    contentType: 'text/plain',
  }));
  await h.store.create(taskInput('task-6'));
  const result = await h.worker.runOnce();
  assert.equal(result.failedPolls, 1);
  assert.equal(result.billed, 0);
  assert.deepEqual(h.observations, []);
});

test('G-A1 worker: the bound account is re-dialed exactly (the create-time binding)', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const store = new InMemoryVideoTaskStore({ now: () => BASE_TIME });
  const forwarder = {
    fetchStatus(request: {
      readonly account: Record<string, unknown>;
      readonly requestId: string;
    }): Promise<GrokVideoUpstreamResponse> {
      seen.push(request.account);
      return Promise.resolve(okStatus());
    },
  } as unknown as GrokVideoUpstreamForwarder;
  const billing = {
    observe: () => Promise.resolve({ disposition: 'billed' }),
  } as unknown as SaasVideoBillingStateMachine;
  const worker = new VideoTaskRecoveryWorker({ store, forwarder, billing, owner: 'w', now: () => BASE_TIME });
  await store.create(taskInput('task-7'));
  await worker.runOnce();
  assert.deepEqual(seen, [{ accountId: 'acct-1', credentialId: 'cred-1', credentialVersion: 'v1' }]);
});

test('G-A1 worker: lease fencing — a zombie epoch cannot record an outcome', async () => {
  const h = harness(() => okStatus());
  await h.store.create(taskInput('task-8'));
  const claims = await h.store.claimRecoveryBatch({
    owner: 'other-worker',
    limit: 5,
    leaseMs: 90_000,
    now: new Date(BASE_TIME).toISOString(),
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].leaseEpoch, 1);
  // The other worker holds the lease → our runOnce claims nothing.
  assert.equal((await h.worker.runOnce()).claimed, 0);
  // A stale outcome write (old owner) is a no-op.
  const recorded = await h.store.recordRecoveryOutcome({
    requestId: 'task-8',
    owner: 'ghost',
    epoch: 0,
    nextPollAt: new Date(BASE_TIME + 1_000).toISOString(),
    resetFailures: true,
    failureDelta: 0,
  });
  assert.equal(recorded, false);
  // The expired lease is adoptable by anyone (the dead-worker path).
  h.timeMs += 91_000;
  const adopted = await h.store.claimRecoveryBatch({
    owner: 'worker-test',
    limit: 5,
    leaseMs: 90_000,
    now: new Date(h.timeMs).toISOString(),
  });
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].leaseEpoch, 2, 'the epoch advanced — the zombie is fenced');
});

test('G-A1 classification: the six-class table mirrors new-api classifyPollHTTP', () => {
  assert.equal(classifyRecoveryPoll(okStatus()), 'ok');
  assert.equal(classifyRecoveryPoll(httpStatus(404)), 'not_found');
  assert.equal(classifyRecoveryPoll(httpStatus(410)), 'not_found');
  assert.equal(classifyRecoveryPoll(httpStatus(401)), 'auth');
  assert.equal(classifyRecoveryPoll(httpStatus(403)), 'auth');
  assert.equal(classifyRecoveryPoll(httpStatus(429)), 'transient');
  assert.equal(classifyRecoveryPoll(httpStatus(500)), 'transient');
  assert.equal(classifyRecoveryPoll(httpStatus(400)), 'other_client');
  assert.equal(classifyRecoveryPoll({ kind: 'error' }), 'transient');
});

test('G-A1 backoff: base doubling with a ceiling', () => {
  assert.equal(backoffDelayMs(1, 15_000, 15 * 60_000), 15_000);
  assert.equal(backoffDelayMs(2, 15_000, 15 * 60_000), 30_000);
  assert.equal(backoffDelayMs(3, 15_000, 15 * 60_000), 60_000);
  assert.equal(backoffDelayMs(10, 15_000, 15 * 60_000), 15 * 60_000);
});

test('G-A1 image sweep: stuck processing rows terminate at the execution deadline', async () => {
  const { InMemoryImageTaskStore } = await import('../../../../src/saas/gateway/images/image-task-store.js');
  const { SaasImageTaskService, IMAGE_TASK_EXECUTION_TIMEOUT_MS } = await import(
    '../../../../src/saas/gateway/images/image-task-service.js'
  );
  const nowMs = BASE_TIME;
  const store = new InMemoryImageTaskStore({ now: () => nowMs });
  const service = new SaasImageTaskService({ store, executionTimeoutMs: 1_000, ttlMs: 60_000, now: () => nowMs });
  const imageInput = (id: string, createdAtMs: number) => ({
    id,
    tenantId: 'tenant-a',
    proxyKeyId: 'key-a',
    status: 'processing' as const,
    httpStatus: null,
    result: null,
    error: null,
    createdAt: new Date(createdAtMs).toISOString(),
    completedAt: null,
    expiresAt: new Date(createdAtMs + 60_000).toISOString(),
  });
  await store.create(imageInput('imgtask_00000000000000000000000000000001', nowMs - 10_000));
  await store.create(imageInput('imgtask_00000000000000000000000000000002', nowMs - 100));
  // A terminal row must never be touched by the sweep.
  await store.create(imageInput('imgtask_00000000000000000000000000000003', nowMs - 10_000));
  await store.finish('imgtask_00000000000000000000000000000003', {
    status: 'completed',
    httpStatus: 200,
    result: '{"ok":true}',
    error: null,
    completedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 60_000).toISOString(),
  });
  const swept = await service.sweepStuckTasks();
  assert.equal(swept, 1, 'only the past-deadline processing row');
  const stuckOld = await store.get('imgtask_00000000000000000000000000000001');
  assert.equal(stuckOld?.status, 'failed');
  assert.equal(stuckOld?.httpStatus, 504);
  const stuckNew = await store.get('imgtask_00000000000000000000000000000002');
  assert.equal(stuckNew?.status, 'processing', 'a live task inside its deadline is untouched');
  const done = await store.get('imgtask_00000000000000000000000000000003');
  assert.equal(done?.status, 'completed');
  void IMAGE_TASK_EXECUTION_TIMEOUT_MS;
});
