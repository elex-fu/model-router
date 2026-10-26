import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Dispatcher } from 'undici';
import {
  type ProviderHttpBoundRequest,
  ProviderHttpTransport,
} from '../../../../src/saas/gateway/provider-http-transport.js';

test('fast transport rejects forged, cloned, foreign and replayed tickets without a fetch', async () => {
  const payloadBytes = Buffer.from('{"model":"native","messages":[]}');
  const bound: ProviderHttpBoundRequest = {
    tenantId: 'tenant',
    projectId: 'project',
    requestId: 'request',
    attemptId: 'attempt',
    fencingToken: 'fence',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: {
      evidenceId: 'intent',
      tenantId: 'tenant',
      projectId: 'project',
      requestId: 'request',
      attemptId: 'attempt',
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      publicModel: 'public',
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      upstreamId: 'upstream',
      accountId: 'account',
      credentialId: 'credential',
      credentialVersion: '1',
      payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    },
  };
  const tickets = new WeakMap<object, ProviderHttpBoundRequest>();
  const issued = Object.freeze({});
  tickets.set(issued, bound);
  let fetches = 0;
  const transport = new ProviderHttpTransport({
    fetch: async () => {
      fetches++;
      return new Response('ok');
    },
    timeoutMs: 1000,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/chat/completions' }),
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    createConnector: () => ({ dispatcher: {} as Dispatcher, close: async () => {}, destroy: async () => {} }),
    resolveCredential: async (_input, use) =>
      use({ headerName: 'authorization', value: randomBytes(16).toString('hex') }),
    consumeFastTicket: (ticket) => {
      if (!ticket || typeof ticket !== 'object') throw new Error('unissued');
      const binding = tickets.get(ticket);
      tickets.delete(ticket);
      if (!binding) throw new Error('unissued');
      return binding;
    },
  });
  const foreignIssued = Object.freeze({});
  for (const forged of [null, {}, { ...issued }, structuredClone(issued), foreignIssued]) {
    await assert.rejects(() => transport.sendFast(forged));
    assert.equal(fetches, 0);
  }
  const response = await transport.sendFast(issued);
  assert.ok(response.body);
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
  reader.releaseLock();
  assert.equal(fetches, 1);
  await assert.rejects(() => transport.sendFast(issued));
  assert.equal(fetches, 1);
});
