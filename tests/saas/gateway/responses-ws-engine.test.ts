import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RESPONSES_WS_CLOSE_POLICY_VIOLATION,
  ResponsesWsEngine,
  type ResponsesWsEvent,
  type ResponsesWsInboundEvent,
  type ResponsesWsPinnedIdentity,
  type ResponsesWsRoundExecutor,
} from '../../../src/saas/gateway/responses-ws-engine.js';

/**
 * Gap-remediation G-B4 (§5.1 fusion): the session engine's invariants —
 * per-round full-chain execution, the pin, one-active-round, event-id
 * idempotency, cancel-never-refunds, close-code classification.
 */

interface Harness {
  readonly engine: ResponsesWsEngine;
  readonly sent: ResponsesWsEvent[];
  readonly closed: Array<{ code: number; reason: string }>;
  readonly rounds: Array<{
    body: Record<string, unknown>;
    pinned: ResponsesWsPinnedIdentity | null;
    cancelled: boolean;
  }>;
  roundsBehavior: {
    terminal?: ResponsesWsEvent;
    pin?: ResponsesWsPinnedIdentity;
    failWith?: Error;
    holdRound?: (cancelled: () => void) => void;
  };
}

function pinned(overrides: Partial<ResponsesWsPinnedIdentity> = {}): ResponsesWsPinnedIdentity {
  return {
    tenantId: 'tenant-1',
    proxyKeyId: 'key-1',
    providerId: 'provider-1',
    accountId: 'account-1',
    upstreamModel: 'model-1',
    upstreamSessionId: null,
    ...overrides,
  };
}

function harness(): Harness {
  const sent: ResponsesWsEvent[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  const state: Harness = {
    sent,
    closed,
    rounds: [],
    roundsBehavior: {},
    engine: undefined as unknown as ResponsesWsEngine,
  };
  const executor: ResponsesWsRoundExecutor = {
    async executeRound({ body, pinned: pinnedInput, cancelSignal }) {
      const roundRecord = { body, pinned: pinnedInput, cancelled: false };
      state.rounds.push(roundRecord);
      cancelSignal.addEventListener(
        'abort',
        () => {
          roundRecord.cancelled = true;
        },
        { once: true },
      );
      if (state.roundsBehavior.holdRound !== undefined) {
        await new Promise<void>((resolve) => {
          state.roundsBehavior.holdRound?.(() => resolve());
          cancelSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (state.roundsBehavior.failWith !== undefined) throw state.roundsBehavior.failWith;
      return {
        terminal: state.roundsBehavior.terminal ?? {
          type: 'response.completed',
          response_id: 'r',
          usage: { total: 5 },
        },
        pinned: state.roundsBehavior.pin ?? pinnedInput ?? pinned(),
      };
    },
  };
  state.engine = new ResponsesWsEngine({
    executor,
    send: (event) => sent.push(event),
    close: (code, reason) => closed.push({ code, reason }),
    idFactory: () => `ev-${state.rounds.length + 1}`,
  });
  return state;
}

const create = (
  body: Record<string, unknown> = { model: 'm', input: 'hi' },
  eventId?: string,
): ResponsesWsInboundEvent => ({
  type: 'response.create',
  ...(eventId === undefined ? {} : { event_id: eventId }),
  response: body,
});

test('G-B4: round 1 pins the identity; round 2 receives the pin and re-verifies', async () => {
  const h = harness();
  h.roundsBehavior.pin = pinned({ accountId: 'account-9', upstreamSessionId: 'sess-1' });
  await h.engine.handle(create());
  await h.engine.handle(create());
  assert.equal(h.rounds[0].pinned, null, 'round 1 has no pin yet');
  assert.deepEqual(h.rounds[1].pinned, {
    tenantId: 'tenant-1',
    proxyKeyId: 'key-1',
    providerId: 'provider-1',
    accountId: 'account-9',
    upstreamModel: 'model-1',
    upstreamSessionId: 'sess-1',
  });
  assert.equal(h.sent.filter((e) => e.type === 'response.completed').length, 2);
});

test('G-B4: one active round — a concurrent create answers in-band, never a second execution', async () => {
  const h = harness();
  h.roundsBehavior.holdRound = () => {};
  const first = h.engine.handle(create());
  await h.engine.handle(create({ model: 'm', input: 'second' }));
  assert.equal(
    h.sent.some((e) => e.type === 'error' && e.error?.code === 'response_create_conflict'),
    true,
    'the concurrent create answers in-band',
  );
  assert.equal(h.rounds.length, 1);
  // Release the held round via cancel so the promise settles.
  await h.engine.handle({ type: 'response.interrupt' });
  await first;
});

test('G-B4: response.interrupt cancels the active round; the terminal still settles (cancel never refunds)', async () => {
  const h = harness();
  h.roundsBehavior.holdRound = () => {};
  const first = h.engine.handle(create({ model: 'm', input: 'work' }));
  await h.engine.handle({ type: 'response.interrupt' });
  await first;
  assert.equal(h.rounds[0].cancelled, true);
  assert.equal(
    h.sent.some((e) => e.type === 'response.completed' || e.type === 'response.failed'),
    true,
  );
});

test('G-B4: event_id idempotency — the same id + body replays; the same id + a different body closes', async () => {
  const h = harness();
  await h.engine.handle(create({ model: 'm', input: 'a' }, 'evt-1'));
  await h.engine.handle(create({ model: 'm', input: 'a' }, 'evt-1'));
  assert.equal(h.rounds.length, 1, 'the replay does not re-execute');
  assert.equal(
    h.sent.some((e) => e.error?.code === 'response_already_completed'),
    true,
  );
  await h.engine.handle(create({ model: 'm', input: 'DIFFERENT' }, 'evt-1'));
  assert.deepEqual(h.closed, [
    { code: RESPONSES_WS_CLOSE_POLICY_VIOLATION, reason: 'event_id reused with a different body' },
  ]);
});

test('G-B4: a credential-class failure closes the connection (the silent-reconnect rule)', async () => {
  const h = harness();
  h.roundsBehavior.failWith = new Error('credential expired');
  await h.engine.handle(create());
  assert.equal(
    h.sent.some((e) => e.type === 'response.failed'),
    true,
  );
  assert.deepEqual(h.closed, [{ code: RESPONSES_WS_CLOSE_POLICY_VIOLATION, reason: '' }]);
});

test('G-B4: a request-shape failure keeps the connection open', async () => {
  const h = harness();
  h.roundsBehavior.failWith = new Error('invalid request shape');
  await h.engine.handle(create());
  assert.equal(
    h.sent.some((e) => e.type === 'response.failed'),
    true,
  );
  assert.equal(h.closed.length, 0, 'a shape error notifies without closing');
});

test('G-B4: client disconnect cancels the in-flight round', async () => {
  const h = harness();
  h.roundsBehavior.holdRound = () => {};
  const first = h.engine.handle(create());
  h.engine.clientDisconnected();
  await first;
  assert.equal(h.rounds[0].cancelled, true);
});

test('G-B4: the close reason is truncated to 123 UTF-8 bytes', async () => {
  const h = harness();
  h.roundsBehavior.failWith = new Error(`credential ${'x'.repeat(200)}`);
  await h.engine.handle(create());
  assert.equal(h.closed.length, 1);
  assert.ok(Buffer.from(h.closed[0].reason, 'utf8').length <= 123);
});
