import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import type {
  ProviderHttpConnectorInput,
  ProviderHttpPinnedConnector,
  ProviderHttpResolvedAddress,
} from '../../../src/saas/gateway/provider-http-address.js';
import {
  CustomerWebhookEgressTransport,
  type CustomerWebhookFetch,
  CustomerWebhookTransportError,
} from '../../../src/saas/webhooks/egress-transport.js';
import { createCustomerWebhookEnvelope, validateCustomerWebhookEventData } from '../../../src/saas/webhooks/events.js';
import {
  computeCustomerWebhookSignature,
  formatCustomerWebhookSignatureHeader,
  verifyCustomerWebhookSignature,
} from '../../../src/saas/webhooks/signatures.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const ADDRESS = { address: '8.8.8.8', family: 4 as const };
const KEY = { version: 4, secret: Buffer.alloc(32, 0x6a) };

function event() {
  return createCustomerWebhookEnvelope({
    eventId: EVENT_ID,
    eventType: 'wallet.low_balance',
    occurredAt: '2026-09-29T00:00:00.000Z',
    data: {
      supply_mode: 'platform',
      balance_minor_units: 4200,
      threshold_minor_units: 5000,
      currency: 'USD',
    },
  });
}

function fakeConnector(input: ProviderHttpConnectorInput, onCreate?: (input: ProviderHttpConnectorInput) => void) {
  onCreate?.(input);
  const connector: ProviderHttpPinnedConnector = {
    dispatcher: { dispatch() {} } as unknown as Dispatcher,
    close: async () => {},
    destroy: async () => {},
  };
  return connector;
}

test('event allowlist rejects arbitrary names, prompt/response fields, tenant ids, and BYOK wallet notices', () => {
  assert.throws(
    () =>
      validateCustomerWebhookEventData('wallet.low_balance', {
        supply_mode: 'platform',
        balance_minor_units: 1,
        threshold_minor_units: 5,
        currency: 'USD',
        prompt: 'secret',
      }),
    /unsupported or missing fields/,
  );
  assert.throws(
    () =>
      validateCustomerWebhookEventData('wallet.low_balance', {
        supply_mode: 'byok',
        balance_minor_units: 1,
        threshold_minor_units: 5,
        currency: 'USD',
      }),
    /only valid for platform supply/,
  );
  assert.throws(
    () =>
      validateCustomerWebhookEventData('request.completed', {
        request_id: EVENT_ID,
        project_id: EVENT_ID,
        supply_mode: 'platform',
        status: 'succeeded',
        duration_ms: 10,
        response: 'must never leave the platform',
      }),
    /unsupported or missing fields/,
  );
  assert.throws(
    () =>
      validateCustomerWebhookEventData('usage.completed', {
        request_id: EVENT_ID,
        project_id: EVENT_ID,
        supply_mode: 'platform',
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 6,
        tenant_id: EVENT_ID,
      }),
    /unsupported or missing fields/,
  );
});

test('HMAC signs the exact transmitted bytes and verifies event-id/timestamp-bound canonical data', () => {
  const body = Buffer.from('{"exact":true}\n', 'utf8');
  const timestamp = 1_790_640_000;
  const signature = computeCustomerWebhookSignature(KEY, timestamp, EVENT_ID, body);
  assert.match(signature, /^v1=4:[0-9a-f]{64}$/);
  assert.equal(verifyCustomerWebhookSignature(signature, KEY, timestamp, EVENT_ID, body), true);
  assert.equal(verifyCustomerWebhookSignature(signature, KEY, timestamp + 1, EVENT_ID, body), false);
  assert.equal(
    verifyCustomerWebhookSignature(signature, KEY, timestamp, EVENT_ID, Buffer.from('{"exact":true}')),
    false,
  );
  assert.equal(
    verifyCustomerWebhookSignature(signature, KEY, timestamp, '22222222-2222-4222-8222-222222222222', body),
    false,
  );
  assert.equal(
    formatCustomerWebhookSignatureHeader([
      signature,
      computeCustomerWebhookSignature({ version: 3, secret: Buffer.alloc(32, 1) }, timestamp, EVENT_ID, body),
    ]).split(',').length,
    2,
  );
  assert.throws(() => formatCustomerWebhookSignatureHeader([signature, signature]), /duplicate/);
  assert.throws(() => formatCustomerWebhookSignatureHeader([signature, signature, signature]), /one or two/);
});

test('egress checks every DNS answer, pins the socket, preserves exact body, and uses a manual redirect policy', async () => {
  let fetchCalls = 0;
  let capturedUrl = '';
  let capturedInit: Parameters<CustomerWebhookFetch>[1] | undefined;
  let pinned: ProviderHttpConnectorInput | undefined;
  const fakeFetch: CustomerWebhookFetch = async (url, init) => {
    fetchCalls += 1;
    capturedUrl = url;
    capturedInit = init;
    return new Response(null, { status: 204 });
  };
  const transport = new CustomerWebhookEgressTransport({
    now: () => 1_790_640_000_000,
    resolveAddresses: async (hostname) => {
      assert.equal(hostname, 'hooks.example.test');
      return [ADDRESS, { address: '1.1.1.1', family: 4 }];
    },
    createConnector: (input) =>
      fakeConnector(input, (value) => {
        pinned = value;
      }),
    fetch: fakeFetch,
  });
  const result = await transport.send({
    targetUrl: 'https://hooks.example.test/events',
    event: event(),
    signingKeys: [KEY],
  });
  assert.deepEqual(result, { httpStatus: 204, latencyMs: 0 });
  assert.equal(fetchCalls, 1);
  assert.equal(capturedUrl, 'https://hooks.example.test/events');
  assert.deepEqual(pinned, { hostname: 'hooks.example.test', port: 443, ...ADDRESS });
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.redirect, 'manual');
  assert.ok(capturedInit?.dispatcher);
  const body = Buffer.from(capturedInit?.body as Uint8Array);
  const signatureHeader = new Headers(capturedInit?.headers as HeadersInit).get('x-model-router-signature');
  const timestampHeader = new Headers(capturedInit?.headers as HeadersInit).get('x-model-router-timestamp');
  assert.equal(new Headers(capturedInit?.headers as HeadersInit).get('x-model-router-event-id'), EVENT_ID);
  assert.equal(timestampHeader, '1790640000');
  assert.equal(signatureHeader, computeCustomerWebhookSignature(KEY, 1_790_640_000, EVENT_ID, body));
  assert.deepEqual(JSON.parse(body.toString('utf8')), event());
});

test('mixed, private, reserved, and rebinding answers fail before connector or socket creation', async () => {
  let connectorCalls = 0;
  let fetchCalls = 0;
  const answerSets = [
    [ADDRESS, { address: '10.1.2.3', family: 4 as const }],
    [{ address: '169.254.169.254', family: 4 as const }],
    [{ address: '192.0.2.10', family: 4 as const }],
  ];
  let lookupCount = 0;
  const transport = new CustomerWebhookEgressTransport({
    resolveAddresses: async () => answerSets[lookupCount++] ?? [ADDRESS],
    createConnector: (input) => {
      connectorCalls += 1;
      return fakeConnector(input);
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  for (let index = 0; index < answerSets.length; index += 1) {
    await assert.rejects(
      transport.send({ targetUrl: 'https://hooks.example.test/events', event: event(), signingKeys: [KEY] }),
      (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'DNS_POLICY_REJECTED',
    );
  }
  assert.equal(lookupCount, 3);
  assert.equal(connectorCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('egress rejects reserved IPv4/IPv6 answers, pins public IPv6 literals, and catches DNS rebinding per send', async () => {
  const deniedAddresses: readonly ProviderHttpResolvedAddress[] = [
    { address: '192.0.2.10', family: 4 },
    { address: '198.51.100.10', family: 4 },
    { address: '203.0.113.10', family: 4 },
    { address: '2001:db8::10', family: 6 },
    { address: '3fff::10', family: 6 },
    { address: '2001:2::10', family: 6 },
    { address: 'fc00::10', family: 6 },
    { address: 'fe80::10', family: 6 },
  ];
  let connectorCalls = 0;
  for (const address of deniedAddresses) {
    const transport = new CustomerWebhookEgressTransport({
      resolveAddresses: async () => [address],
      createConnector: (input) => {
        connectorCalls += 1;
        return fakeConnector(input);
      },
      fetch: async () => new Response(null, { status: 204 }),
    });
    await assert.rejects(
      transport.send({ targetUrl: 'https://hooks.example.test/events', event: event(), signingKeys: [KEY] }),
      (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'DNS_POLICY_REJECTED',
    );
  }
  assert.equal(connectorCalls, 0);

  let literalLookupCalls = 0;
  let ipv6Pin: ProviderHttpConnectorInput | undefined;
  const ipv6Transport = new CustomerWebhookEgressTransport({
    resolveAddresses: async () => {
      literalLookupCalls += 1;
      return [ADDRESS];
    },
    createConnector: (input) =>
      fakeConnector(input, (value) => {
        ipv6Pin = value;
      }),
    fetch: async () => new Response(null, { status: 204 }),
  });
  await ipv6Transport.send({
    targetUrl: 'https://[2606:4700:4700::1111]/events',
    event: event(),
    signingKeys: [KEY],
  });
  assert.equal(literalLookupCalls, 0);
  assert.deepEqual(ipv6Pin, {
    hostname: '2606:4700:4700::1111',
    port: 443,
    address: '2606:4700:4700::1111',
    family: 6,
  });

  let dnsCalls = 0;
  let rebindConnectorCalls = 0;
  let rebindFetchCalls = 0;
  const rebindingTransport = new CustomerWebhookEgressTransport({
    resolveAddresses: async () => {
      dnsCalls += 1;
      return dnsCalls === 1 ? [ADDRESS] : [{ address: '169.254.169.254', family: 4 }];
    },
    createConnector: (input) => {
      rebindConnectorCalls += 1;
      return fakeConnector(input);
    },
    fetch: async () => {
      rebindFetchCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  await rebindingTransport.send({
    targetUrl: 'https://hooks.example.test/events',
    event: event(),
    signingKeys: [KEY],
  });
  await assert.rejects(
    rebindingTransport.send({
      targetUrl: 'https://hooks.example.test/events',
      event: event(),
      signingKeys: [KEY],
    }),
    (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'DNS_POLICY_REJECTED',
  );
  assert.equal(dnsCalls, 2);
  assert.equal(rebindConnectorCalls, 1);
  assert.equal(rebindFetchCalls, 1);
});

test('redirect responses are rejected and never followed; response bodies are cancelled', async () => {
  let fetchCalls = 0;
  let cancelled = false;
  const transport = new CustomerWebhookEgressTransport({
    resolveAddresses: async () => [ADDRESS],
    createConnector: (input) => fakeConnector(input),
    fetch: async () => {
      fetchCalls += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 302, headers: { location: 'https://attacker.invalid/' } });
    },
  });
  await assert.rejects(
    transport.send({ targetUrl: 'https://hooks.example.test/events', event: event(), signingKeys: [KEY] }),
    (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'REDIRECT_REJECTED',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  assert.equal(cancelled, true);
});

test('cancellation and timeout stop resolution without dispatch; payload limit is enforced', async () => {
  let fetchCalls = 0;
  const cancel = new AbortController();
  cancel.abort();
  const cancelled = new CustomerWebhookEgressTransport({
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    cancelled.send({
      targetUrl: 'https://hooks.example.test/events',
      event: event(),
      signingKeys: [KEY],
      signal: cancel.signal,
    }),
    (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'ABORTED',
  );

  const timeoutTransport = new CustomerWebhookEgressTransport({
    timeoutMs: 10,
    resolveAddresses: async (_hostname, signal) =>
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    timeoutTransport.send({ targetUrl: 'https://hooks.example.test/events', event: event(), signingKeys: [KEY] }),
    (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'TIMEOUT',
  );
  const limitTransport = new CustomerWebhookEgressTransport({
    maxPayloadBytes: 256,
    resolveAddresses: async () => [ADDRESS],
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  const large = createCustomerWebhookEnvelope({
    eventId: EVENT_ID,
    eventType: 'usage.completed',
    occurredAt: '2026-09-29T00:00:00.000Z',
    data: {
      request_id: EVENT_ID,
      project_id: '22222222-2222-4222-8222-222222222222',
      supply_mode: 'platform',
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    },
  });
  await assert.rejects(
    limitTransport.send({ targetUrl: 'https://hooks.example.test/events', event: large, signingKeys: [KEY] }),
    (error: unknown) => error instanceof CustomerWebhookTransportError && error.code === 'BODY_TOO_LARGE',
  );
  assert.equal(fetchCalls, 0);
});
