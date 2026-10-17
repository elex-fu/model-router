import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeeRecordingClientStream } from '../../../../src/saas/gateway/videos/tee-recording-client-stream.js';
import { stableVideoBillingRequestId } from '../../../../src/saas/gateway/videos/video-billing.js';
import {
  PersistentSaasGatewayVideoCreatePort,
  VIDEO_TASK_TTL_MS,
} from '../../../../src/saas/gateway/videos/video-create-port.js';
import { InMemoryVideoTaskStore } from '../../../../src/saas/gateway/videos/video-task-store.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';

/**
 * Batch 4 §4.3 (task #17) — the create-time snapshot port (the migration
 * 124 row: normalized billing identity + bound account + frozen settlement
 * facts) and the tee recording stream the sync create response rides.
 */

function caller(): AuthenticatedApiKey {
  return {
    metadata: { id: 'key-1', tenantId: 'tenant-1', status: 'active', modelScopes: [] },
    authorization: { principalId: 'user-1', modelScopes: [] },
  } as unknown as AuthenticatedApiKey;
}

test('4.3: registerCreate persists the normalized snapshot + binding + frozen facts', async () => {
  const store = new InMemoryVideoTaskStore();
  const port = new PersistentSaasGatewayVideoCreatePort({ store });
  await port.registerCreate({
    authenticatedCaller: caller(),
    taskId: 'req-9',
    account: { accountId: 'account-1', credentialId: 'credential-1', credentialVersion: '3' },
    settlement: { requestId: 'gateway-request-1', attemptId: 'attempt-1' },
    requestBody: {
      model: 'grok-imagine-video-1.5',
      prompt: 'a cat surfing',
      resolution: '1080p',
      duration: 5,
      n: 2,
    },
    settlementFacts: { customerPriceVersion: 'price-v1', priceSnapshotRef: 'snapshot-1', currency: 'USD' },
  });
  const record = await store.get('req-9');
  assert.ok(record !== null);
  assert.equal(record.tenantId, 'tenant-1');
  assert.equal(record.proxyKeyId, 'key-1');
  assert.equal(record.providerAccountId, 'account-1');
  assert.equal(record.credentialVersion, '3');
  assert.equal(record.gatewayRequestId, 'gateway-request-1');
  assert.equal(record.gatewayAttemptId, 'attempt-1');
  // The billing identity is the create-time normalization (1080p / 5s / 2).
  assert.equal(record.model, 'grok-imagine-video-1.5');
  assert.equal(record.resolution, '1080p');
  assert.equal(record.durationSeconds, 5);
  assert.equal(record.videoCount, 2);
  assert.equal(record.billingState, 'pending');
  assert.deepEqual(record.settlementFacts, {
    customerPriceVersion: 'price-v1',
    priceSnapshotRef: 'snapshot-1',
    currency: 'USD',
  });
  // The 24 h TTL matches the sub2api pending-billing TTL.
  assert.equal(VIDEO_TASK_TTL_MS, 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(record.expiresAt) - Date.parse(record.createdAt) === VIDEO_TASK_TTL_MS);
});

test('4.3: a BYOK create persists a null settlement-facts row', async () => {
  const store = new InMemoryVideoTaskStore();
  const port = new PersistentSaasGatewayVideoCreatePort({ store });
  await port.registerCreate({
    authenticatedCaller: caller(),
    taskId: 'req-10',
    account: { accountId: 'account-1', credentialId: 'credential-1', credentialVersion: '1' },
    settlement: { requestId: 'gr-1', attemptId: 'at-1' },
    requestBody: { model: 'grok-imagine-video', prompt: 'p' },
    settlementFacts: null,
  });
  const record = await store.get('req-10');
  assert.ok(record !== null);
  assert.equal(record.settlementFacts, null);
  assert.equal(record.resolution, '480p');
  assert.equal(record.durationSeconds, 8);
  assert.equal(record.videoCount, 1);
});

test('4.3: an unauthenticated caller is rejected; a duplicate task id is a closed failure', async () => {
  const store = new InMemoryVideoTaskStore();
  const port = new PersistentSaasGatewayVideoCreatePort({ store });
  await assert.rejects(
    port.registerCreate({
      authenticatedCaller: {} as AuthenticatedApiKey,
      taskId: 'req-1',
      account: { accountId: 'a', credentialId: 'c', credentialVersion: '1' },
      settlement: { requestId: 'r', attemptId: 'a' },
      requestBody: { model: 'm' },
      settlementFacts: null,
    }),
  );
  const input = {
    authenticatedCaller: caller(),
    account: { accountId: 'a', credentialId: 'c', credentialVersion: '1' },
    settlement: { requestId: 'r', attemptId: 'a' },
    requestBody: { model: 'm' },
    settlementFacts: null,
  } as const;
  await port.registerCreate({ ...input, taskId: 'req-dup' });
  await assert.rejects(port.registerCreate({ ...input, taskId: 'req-dup' }));
});

test('4.3: the stable billing key for a registered task is video:<taskId>', () => {
  assert.equal(stableVideoBillingRequestId('req-9'), 'video:req-9');
});

class InnerStream {
  readonly started: number[] = [];
  readonly chunks: Uint8Array[] = [];
  ended = false;
  aborted = false;
  readonly signal = new AbortController().signal;
  start(status: number | null): void {
    this.started.push(status ?? 200);
  }
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  end(): void {
    this.ended = true;
  }
  abort(): void {
    this.aborted = true;
  }
  dispose(): void {
    this.disposed = true;
  }
  disposed = false;
}

test('4.3: the tee stream forwards every byte to the client and records under the ceiling', () => {
  const inner = new InnerStream();
  const tee = new TeeRecordingClientStream(inner, { maxRecordedBytes: 64 });
  tee.start(200, {});
  const first = new TextEncoder().encode('{"request_id":"req-1"');
  const second = new TextEncoder().encode(',"status":"queued"}');
  tee.write(first);
  tee.write(second);
  tee.end();
  assert.deepEqual(inner.started, [200]);
  assert.equal(inner.chunks.length, 2);
  assert.ok(inner.ended);
  assert.ok(tee.isComplete);
  assert.equal(new TextDecoder().decode(tee.recordedBody()), '{"request_id":"req-1","status":"queued"}');
  tee.dispose();
  assert.ok(inner.disposed);
});

test('4.3: the tee stream aborts the client stream when the recording ceiling is exceeded', () => {
  const inner = new InnerStream();
  const tee = new TeeRecordingClientStream(inner, { maxRecordedBytes: 4 });
  tee.start(200, {});
  assert.throws(() => tee.write(new TextEncoder().encode('too many bytes')));
  assert.ok(inner.aborted);
  assert.equal(tee.isComplete, false);
});

test('4.3: the tee stream forwards aborts and exposes the inner signal', () => {
  const inner = new InnerStream();
  const tee = new TeeRecordingClientStream(inner, { maxRecordedBytes: 8 });
  tee.abort();
  assert.ok(inner.aborted);
  assert.equal(tee.signal, inner.signal);
});
