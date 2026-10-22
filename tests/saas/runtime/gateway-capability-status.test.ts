import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readGatewayCapabilityStatus } from '../../../src/saas/runtime/gateway-capability-status.js';

const env = { MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: 'http://127.0.0.1:19000' };
const readiness = {
  configurationValid: true,
  fatalReasonCodes: [],
  capabilities: [
    {
      capability: 'provider-bundle:kimi',
      kind: 'provider-bundle',
      label: 'Kimi',
      providerId: 'kimi',
      enabled: true,
      assembled: true,
      verified: false,
      operational: true,
      verificationLevel: 'unverified',
      reasonCodes: ['VERIFICATION_NOT_RECORDED'],
      productIds: ['kimi-code'],
      endpointScopes: ['messages'],
      unavailableEndpointScopes: [],
    },
  ],
};

test('running gateway projection preserves facts and removes arbitrary probe fields', async () => {
  let requested = '';
  const fetcher: typeof fetch = async (input, options) => {
    requested = String(input);
    assert.equal(options?.redirect, 'error');
    return Response.json({ providerCapabilities: { ...readiness, privateField: 'excluded' }, arbitrary: 'excluded' });
  };
  const status = await readGatewayCapabilityStatus(env, fetcher);
  assert.equal(requested, 'http://127.0.0.1:19000/readyz');
  assert.equal(status.state, 'available');
  if (status.state !== 'available') return;
  assert.deepEqual(status.readiness, readiness);
  assert.equal(JSON.stringify(status).includes('excluded'), false);
});

test('absent configuration performs no network request', async () => {
  assert.deepEqual(
    await readGatewayCapabilityStatus({}, async () => {
      throw Error('unexpected fetch');
    }),
    { state: 'not-configured' },
  );
});

for (const origin of [
  'http://public.example',
  'https://user:password@example.com',
  'https://example.com/path',
  'https://example.com?query=value',
]) {
  test(`invalid gateway origin is rejected before fetching: ${origin.split(':')[0]}`, async () => {
    let fetched = false;
    const status = await readGatewayCapabilityStatus({ MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: origin }, async () => {
      fetched = true;
      return Response.json({});
    });
    assert.deepEqual(status, { state: 'unavailable' });
    assert.equal(fetched, false);
  });
}

test('unknown capability reason and oversized probe fail closed', async () => {
  const invalid = structuredClone(readiness);
  const first = invalid.capabilities[0];
  assert.ok(first);
  first.reasonCodes = ['UNKNOWN_REASON'];
  assert.deepEqual(
    await readGatewayCapabilityStatus(env, async () => Response.json({ providerCapabilities: invalid })),
    { state: 'unavailable' },
  );
  assert.deepEqual(await readGatewayCapabilityStatus(env, async () => new Response(' '.repeat(128 * 1024 + 1))), {
    state: 'unavailable',
  });
});

test('unavailable, malformed and legacy gateway probes remain unavailable', async () => {
  for (const fetcher of [
    async () => {
      throw Error('offline');
    },
    async () => new Response('{'),
    async () => Response.json({ capabilities: {} }),
  ]) {
    assert.deepEqual(await readGatewayCapabilityStatus(env, fetcher), { state: 'unavailable' });
  }
});
