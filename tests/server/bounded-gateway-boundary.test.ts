import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  configureSaasNativePoolBudget,
  createSaasDatabase,
  ownedSaasNativePoolSnapshot,
} from '../../src/saas/db/database.js';
import { requestPeerAddress } from '../../src/saas/gateway/trusted-request-peer.js';
import { boundedGatewayForwardHeaders } from '../../src/server/bounded-gateway-dispatcher.js';
import { BOUNDED_GATEWAY_TICKET_HEADER } from '../../src/server/bounded-gateway-protocol.js';
import { BoundedGatewayWorkerTickets } from '../../src/server/bounded-gateway-worker-tickets.js';

function fake(ticket: unknown) {
  const request = {
    headers: { [BOUNDED_GATEWAY_TICKET_HEADER]: ticket },
    socket: { remoteAddress: '127.0.0.1' },
    pause() {},
  } as unknown as IncomingMessage;
  let status = 0;
  const response = {
    writeHead(value: number) {
      status = value;
    },
    end() {},
  } as unknown as ServerResponse;
  return { request, response, status: () => status };
}
test('external internal headers and hop-nominated headers are stripped; ordinary auth and multi-value cookies survive', () => {
  const headers = boundedGatewayForwardHeaders({
    connection: 'keep-alive, x-secret',
    'x-secret': 'removed',
    [BOUNDED_GATEWAY_TICKET_HEADER]: randomUUID(),
    'x-model-router-bounded-peer': 'fake',
    authorization: 'fixture-authorization',
    'set-cookie': ['a=1', 'b=2'],
    'content-type': 'text/event-stream',
  });
  assert.deepEqual(headers, {
    authorization: 'fixture-authorization',
    'set-cookie': ['a=1', 'b=2'],
    'content-type': 'text/event-stream',
  });
});
test('IPC ticket is one-use and binds original peer without trusting an HTTP forwarding header', () => {
  const completed: string[] = [];
  const tickets = new BoundedGatewayWorkerTickets(1, (ticket) => completed.push(ticket));
  const id = randomUUID();
  tickets.reserve(id, '192.0.2.20');
  const first = fake(id);
  assert.equal(tickets.accept(first.request, first.response), true);
  assert.equal(requestPeerAddress(first.request), '192.0.2.20');
  assert.equal(first.request.headers[BOUNDED_GATEWAY_TICKET_HEADER], undefined);
  const duplicate = fake(id);
  assert.equal(tickets.accept(duplicate.request, duplicate.response), false);
  assert.equal(duplicate.status(), 403);
  tickets.cancel(id);
  tickets.stop();
  assert.equal(tickets.size, 1, 'active cancellation/stop must not free the original handler');
  tickets.finish(first.request);
  tickets.finish(first.request);
  assert.deepEqual(completed, [id]);
  assert.equal(tickets.size, 0);
});
test('undispatched reservation cancellation acknowledges once; forged IDs cannot reserve capacity', () => {
  const completed: string[] = [];
  const tickets = new BoundedGatewayWorkerTickets(1, (ticket) => completed.push(ticket));
  const forged = fake(randomUUID());
  assert.equal(tickets.accept(forged.request, forged.response), false);
  assert.equal(requestPeerAddress(forged.request), '127.0.0.1');
  const id = randomUUID();
  tickets.reserve(id, '192.0.2.21');
  assert.throws(() => tickets.reserve(randomUUID(), '192.0.2.22'));
  tickets.cancel(id);
  tickets.cancel(id);
  assert.deepEqual(completed, [id]);
  assert.equal(tickets.size, 0);
  const late = fake(id);
  assert.equal(tickets.accept(late.request, late.response), false);
});

test('one private readiness probe remains possible at full business capacity and cannot become a business request', () => {
  const completed: string[] = [];
  const tickets = new BoundedGatewayWorkerTickets(1, (ticket) => completed.push(ticket));
  const business = randomUUID();
  tickets.reserve(business, '192.0.2.20');
  const probe = randomUUID();
  tickets.reserveProbe(probe);
  assert.equal(tickets.size, 2);
  assert.throws(() => tickets.reserveProbe(randomUUID()));
  assert.throws(() => tickets.reserve(randomUUID(), '192.0.2.21'));
  const misuse = fake(probe);
  misuse.request.method = 'POST';
  misuse.request.url = '/v1/chat/completions';
  assert.equal(tickets.accept(misuse.request, misuse.response), false);
  const health = fake(probe);
  health.request.method = 'GET';
  health.request.url = '/readyz';
  assert.equal(tickets.accept(health.request, health.response), true);
  tickets.finish(health.request);
  assert.equal(tickets.size, 1);
  assert.deepEqual(completed, []);
  const businessRequest = fake(business);
  assert.equal(tickets.accept(businessRequest.request, businessRequest.response), true);
  tickets.finish(businessRequest.request);
  assert.deepEqual(completed, [business]);
});

test('core native pool constructor grants cannot exceed the worker budget or be replaced by opaque pools', async () => {
  configureSaasNativePoolBudget(4, 'mr-bounded-unit');
  const options = {
    connectionString: 'postgresql://unused@127.0.0.1:1/unused',
    env: {
      MODEL_ROUTER_SAAS_DB_APPLICATION_NAME: 'mr-bounded-unit',
      MODEL_ROUTER_SAAS_DB_POOL_MAX: '2',
    },
  };
  const first = createSaasDatabase(options);
  const second = createSaasDatabase(options);
  try {
    assert.equal(
      ownedSaasNativePoolSnapshot().reduce((total, entry) => total + entry.maximum, 0),
      4,
    );
    assert.throws(() => createSaasDatabase(options), /BUDGET_EXHAUSTED/);
    assert.throws(
      () => createSaasDatabase({ ...options, pool: { query() {}, connect() {}, end() {} } as never }),
      /UNACCOUNTED_POOL/,
    );
    assert.throws(() => configureSaasNativePoolBudget(8, 'other'), /BUDGET_CONFLICT/);
  } finally {
    await first.close();
    await second.close();
  }
  assert.deepEqual(ownedSaasNativePoolSnapshot(), []);
});
