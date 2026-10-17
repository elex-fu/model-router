import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type SaasVideoBillingAlertEvent,
  SaasVideoBillingStateMachine,
} from '../../../../src/saas/gateway/videos/video-billing-state-machine.js';
import type {
  SaasVideoSettlementPort,
  VideoSettlementFacts,
} from '../../../../src/saas/gateway/videos/video-settlement-port.js';
import {
  InMemoryVideoTaskStore,
  type SaasVideoTaskRecord,
} from '../../../../src/saas/gateway/videos/video-task-store.js';

/**
 * Batch 4 §4.3 (task #17) — the async billing state machine's full branch
 * matrix: not-billable polls, the one-shot claim, cross-poll idempotency,
 * fail-closed skips (missing snapshot / unpriceable), claim release +
 * retry on settlement failure, replayed settles, and BYOK no-wallet rows.
 */

const FACTS: VideoSettlementFacts = {
  customerPriceVersion: 'price-v1',
  priceSnapshotRef: 'snapshot-1',
  currency: 'USD',
};

function taskRecord(overrides: Partial<SaasVideoTaskRecord> = {}): SaasVideoTaskRecord {
  return {
    requestId: 'req-video-1',
    tenantId: 'tenant-1',
    proxyKeyId: 'key-1',
    providerAccountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    gatewayRequestId: 'gateway-request-1',
    gatewayAttemptId: 'attempt-1',
    model: 'grok-imagine-video-1.5',
    resolution: '720p',
    durationSeconds: 6,
    videoCount: 2,
    billingState: 'pending',
    billedAt: null,
    settlementFacts: FACTS,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function seededStore(...records: SaasVideoTaskRecord[]): InMemoryVideoTaskStore {
  const store = new InMemoryVideoTaskStore();
  for (const record of records) void store.create(record);
  return store;
}

interface SettlementCall {
  readonly billingRequestId: string;
  readonly gatewayRequestId: string;
  readonly gatewayAttemptId: string;
  readonly units: string;
  readonly sizeTier: string;
  readonly customerPriceVersion: string;
}

function settlementPort(
  behavior: { readonly outcome?: 'settled' | 'replayed' | 'failed' | 'throw'; readonly calls?: SettlementCall[] } = {},
): SaasVideoSettlementPort {
  return {
    async settle(input) {
      behavior.calls?.push({
        billingRequestId: input.billingRequestId,
        gatewayRequestId: input.gatewayRequestId,
        gatewayAttemptId: input.gatewayAttemptId,
        units: input.observation.units.toString(),
        sizeTier: input.observation.sizeTier,
        customerPriceVersion: input.facts.customerPriceVersion,
      });
      if (behavior.outcome === 'throw') throw new Error('metering write lost');
      if (behavior.outcome === 'failed') return { status: 'failed', reason: 'settlement_blocked:rate_card_invalid' };
      if (behavior.outcome === 'replayed') return { status: 'replayed' };
      return { status: 'settled' };
    },
  };
}

const DONE_BODY = {
  status: 'done',
  model: 'grok-imagine-video-1.5',
  video: { url: 'https://vidgen.x.ai/a.mp4', duration: 4 },
};

test('4.3: a non-done status poll never touches the claim', async () => {
  const store = seededStore(taskRecord());
  const calls: SettlementCall[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ calls }),
  });
  const result = await machine.observe({
    taskId: 'req-video-1',
    statusBody: { status: 'pending' },
    record: taskRecord(),
  });
  assert.equal(result.disposition, 'not_billable');
  assert.equal(calls.length, 0);
  assert.equal((await store.get('req-video-1'))?.billingState, 'pending');
});

test('4.3: a done status claims once and settles with the observed units and the video key', async () => {
  const store = seededStore(taskRecord());
  const calls: SettlementCall[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ calls }),
  });
  const result = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: taskRecord() });
  assert.equal(result.disposition, 'billed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.billingRequestId, 'video:req-video-1');
  assert.equal(calls[0]?.gatewayRequestId, 'gateway-request-1');
  assert.equal(calls[0]?.gatewayAttemptId, 'attempt-1');
  // status duration 4 × snapshot count 2 at the snapshot tier 720p.
  assert.equal(calls[0]?.units, '8');
  assert.equal(calls[0]?.sizeTier, '720p');
  assert.equal(calls[0]?.customerPriceVersion, 'price-v1');
  assert.equal((await store.get('req-video-1'))?.billingState, 'billed');
});

test('4.3: a second poll of the same done task is idempotent (already billed, no settlement)', async () => {
  const store = seededStore(taskRecord());
  const calls: SettlementCall[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ calls }),
  });
  await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: taskRecord() });
  const record = await store.get('req-video-1');
  assert.ok(record !== null);
  const second = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record });
  assert.equal(second.disposition, 'already_billed');
  assert.equal(calls.length, 1);
});

test('4.3: a concurrent claim loss reads as already billed (one poll settles)', async () => {
  const store = seededStore(taskRecord());
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort(),
  });
  // The store's claim already transitioned the row (another poll won).
  const claimed = await store.claimBilling('req-video-1');
  assert.ok(claimed !== null);
  const result = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: claimed });
  assert.equal(result.disposition, 'already_billed');
});

test('4.3: a failed settlement releases the claim and a later poll retries', async () => {
  const store = seededStore(taskRecord());
  const calls: SettlementCall[] = [];
  const alerts: SaasVideoBillingAlertEvent[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ outcome: 'failed', calls }),
    alerts: (event) => {
      alerts.push(event);
    },
  });
  const first = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: taskRecord() });
  assert.equal(first.disposition, 'retry');
  assert.ok(first.reason?.startsWith('settlement_blocked'));
  // The claim was released: the row is pending again.
  assert.equal((await store.get('req-video-1'))?.billingState, 'pending');
  assert.equal(alerts[0]?.code, 'VIDEO_BILLING_SETTLEMENT_FAILED');
  // A later poll retries (and can succeed).
  const retry = new SaasVideoBillingStateMachine({ store, settlement: settlementPort({ calls }) });
  const second = await retry.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: taskRecord() });
  assert.equal(second.disposition, 'billed');
  assert.equal(calls.length, 2);
});

test('4.3: a thrown settlement also releases the claim for retry', async () => {
  const store = seededStore(taskRecord());
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ outcome: 'throw' }),
  });
  const result = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: taskRecord() });
  assert.equal(result.disposition, 'retry');
  assert.equal((await store.get('req-video-1'))?.billingState, 'pending');
});

test('4.3: a replayed settlement counts as billed (idempotent retry after a settled task)', async () => {
  const store = seededStore(taskRecord());
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ outcome: 'replayed' }),
  });
  const result = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: taskRecord() });
  assert.equal(result.disposition, 'billed');
  assert.equal(result.reason, 'replayed');
});

test('4.3: a missing snapshot (expired / never persisted) skips fail-closed with an alert — never a default charge', async () => {
  const store = seededStore();
  const alerts: SaasVideoBillingAlertEvent[] = [];
  const calls: SettlementCall[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ calls }),
    alerts: (event) => {
      alerts.push(event);
    },
  });
  const result = await machine.observe({ taskId: 'req-video-1', statusBody: DONE_BODY, record: null });
  assert.equal(result.disposition, 'skipped');
  assert.equal(result.reason, 'snapshot_missing');
  assert.equal(alerts[0]?.code, 'VIDEO_BILLING_SNAPSHOT_MISSING');
  assert.equal(alerts[0]?.taskId, 'req-video-1');
  assert.equal(calls.length, 0);
});

test('4.3: a snapshot-less row that cannot be priced marks skipped and alerts', async () => {
  // A row whose model identity cannot pair with a rate card: emulate via a
  // done status whose model is absent AND a snapshot row missing the model
  // is impossible by table constraint; the unpriceable branch is exercised
  // through extract returning null with a snapshot that has no model.
  const store = seededStore(taskRecord());
  const alerts: SaasVideoBillingAlertEvent[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort(),
    alerts: (event) => {
      alerts.push(event);
    },
  });
  // status has no model; snapshot supplies one — priceable. To hit the
  // unpriceable branch, pass a record whose model is blank (defensive row).
  const blank = { ...taskRecord(), model: '' } as SaasVideoTaskRecord;
  const result = await machine.observe({
    taskId: 'req-video-1',
    statusBody: { status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4' } },
    record: blank,
  });
  assert.equal(result.disposition, 'skipped');
  assert.equal(result.reason, 'unpriceable');
  assert.equal(alerts[0]?.code, 'VIDEO_BILLING_UNPRICEABLE');
  assert.equal((await store.get('req-video-1'))?.billingState, 'skipped');
  // A later poll stays skipped.
  const again = await machine.observe({
    taskId: 'req-video-1',
    statusBody: { status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4' } },
    record: { ...blank, billingState: 'skipped' },
  });
  assert.equal(again.disposition, 'skipped');
});

test('4.3: a BYOK row (no settlement facts) claims once without any wallet settlement', async () => {
  const store = seededStore(taskRecord({ settlementFacts: null }));
  const calls: SettlementCall[] = [];
  const machine = new SaasVideoBillingStateMachine({
    store,
    settlement: settlementPort({ calls }),
  });
  const result = await machine.observe({
    taskId: 'req-video-1',
    statusBody: DONE_BODY,
    record: taskRecord({ settlementFacts: null }),
  });
  assert.equal(result.disposition, 'billed');
  assert.equal(result.reason, 'byok_no_wallet_settlement');
  assert.equal(calls.length, 0);
  assert.equal((await store.get('req-video-1'))?.billingState, 'billed');
});

test('4.3: a record mismatch never bills', async () => {
  const store = seededStore(taskRecord());
  const machine = new SaasVideoBillingStateMachine({ store, settlement: settlementPort() });
  const result = await machine.observe({
    taskId: 'req-video-1',
    statusBody: DONE_BODY,
    record: taskRecord({ requestId: 'other-task' }),
  });
  assert.equal(result.disposition, 'not_billable');
  assert.equal((await store.get('req-video-1'))?.billingState, 'pending');
});

test('4.3: an empty task id is a no-op', async () => {
  const machine = new SaasVideoBillingStateMachine({
    store: new InMemoryVideoTaskStore(),
    settlement: settlementPort(),
  });
  const result = await machine.observe({ taskId: '  ', statusBody: DONE_BODY, record: null });
  assert.equal(result.disposition, 'not_billable');
});
