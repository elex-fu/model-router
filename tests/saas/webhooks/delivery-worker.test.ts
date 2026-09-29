import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import type {
  ProviderHttpConnectorInput,
  ProviderHttpPinnedConnector,
} from '../../../src/saas/gateway/provider-http-address.js';
import { CustomerWebhookDeliveryWorker } from '../../../src/saas/webhooks/delivery-worker.js';
import { CustomerWebhookEgressTransport } from '../../../src/saas/webhooks/egress-transport.js';
import { createCustomerWebhookEnvelope } from '../../../src/saas/webhooks/events.js';
import type {
  ClaimedCustomerWebhookDelivery,
  PostgresCustomerWebhookDeliveryStore,
} from '../../../src/saas/webhooks/postgres-store.js';
import type { WebhookSigningSecretProtector } from '../../../src/saas/webhooks/signing-secret-protector.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';

function connector(_input: ProviderHttpConnectorInput): ProviderHttpPinnedConnector {
  return { dispatcher: { dispatch() {} } as unknown as Dispatcher, close: async () => {}, destroy: async () => {} };
}

function claimed(id: string): ClaimedCustomerWebhookDelivery {
  return {
    tenantId: TENANT,
    deliveryId: id,
    endpointId: ENDPOINT,
    endpointVersion: 1,
    payloadVersion: 1,
    event: createCustomerWebhookEnvelope({
      eventId: EVENT,
      eventType: 'wallet.low_balance',
      occurredAt: '2026-09-29T00:00:00.000Z',
      data: {
        supply_mode: 'platform',
        balance_minor_units: 1000,
        threshold_minor_units: 5000,
        currency: 'USD',
      },
    }),
    targetUrl: 'https://customer.example.test/hook',
    signingSecrets: [{ version: 1, envelope: Buffer.from([1, 2, 3]) }],
    attemptNumber: 1,
    attemptSequence: 1,
    leaseToken: `lease-${id}`,
    fencingToken: 1,
  };
}

test('worker bounds concurrency/backpressure, binds AAD, sends outside store calls, and wipes decrypted key buffers', async () => {
  const claimedDeliveries = [
    claimed('44444444-4444-4444-8444-444444444444'),
    claimed('55555555-5555-4555-8555-555555555555'),
  ];
  const calls: string[] = [];
  let peak = 0;
  let inFlight = 0;
  const decrypted: Buffer[] = [];
  const store = {
    async claimReady(limit: number, leaseMs: number) {
      calls.push(`claim:${limit}:${leaseMs}`);
      return claimedDeliveries.slice(0, limit);
    },
    async markDelivered(input: { deliveryId: string; httpStatus: number }) {
      calls.push(`ack:${input.deliveryId}:${input.httpStatus}`);
      return true;
    },
    async recordFailure() {
      throw new Error('successful sends must not be retried');
    },
  } as unknown as PostgresCustomerWebhookDeliveryStore;
  const protector: WebhookSigningSecretProtector = {
    purpose: 'customer-webhook-signing-secret-v1',
    async protect() {
      return new Uint8Array([1]);
    },
    async unprotect(_envelope, aad) {
      const context = Buffer.from(aad).toString('utf8');
      calls.push(`decrypt:${context}`);
      const result = Buffer.alloc(32, 0x55);
      decrypted.push(result);
      return result;
    },
  };
  const transport = new CustomerWebhookEgressTransport({
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    createConnector: connector,
    fetch: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 202 });
    },
  });
  const worker = new CustomerWebhookDeliveryWorker(store, protector, transport, { concurrency: 2, leaseMs: 20_000 });
  const result = await worker.runOnce();
  assert.deepEqual(result, { claimed: 2, delivered: 2, retrying: 0, deadLettered: 0, stale: 0 });
  assert.equal(peak, 2);
  assert.ok(calls.includes(`claim:2:20000`));
  assert.equal(
    calls.filter((entry) =>
      entry.startsWith(
        `decrypt:model-router/customer-webhook-signing-secret/v1\ntenant=${TENANT}\nendpoint=${ENDPOINT}\nversion=1`,
      ),
    ).length,
    2,
  );
  assert.equal(calls.filter((entry) => entry.startsWith('ack:')).length, 2);
  assert.equal(
    decrypted.every((key) => key.every((byte) => byte === 0)),
    true,
  );
  assert.equal(
    claimedDeliveries.every((delivery) => delivery.signingSecrets[0]?.envelope.every((byte) => byte === 0)),
    true,
  );
});

test('an already-cancelled worker does not claim or send work', async () => {
  let claimedCount = 0;
  const store = {
    async claimReady() {
      claimedCount += 1;
      return [];
    },
  } as unknown as PostgresCustomerWebhookDeliveryStore;
  const protector: WebhookSigningSecretProtector = {
    purpose: 'customer-webhook-signing-secret-v1',
    async protect() {
      return new Uint8Array([1]);
    },
    async unprotect() {
      throw new Error('no work should be decrypted');
    },
  };
  const transport = new CustomerWebhookEgressTransport({ fetch: async () => new Response(null, { status: 204 }) });
  const worker = new CustomerWebhookDeliveryWorker(store, protector, transport);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await worker.runOnce(controller.signal), {
    claimed: 0,
    delivered: 0,
    retrying: 0,
    deadLettered: 0,
    stale: 0,
  });
  assert.equal(claimedCount, 0);
});
