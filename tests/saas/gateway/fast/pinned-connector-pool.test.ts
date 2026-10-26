import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Dispatcher } from 'undici';
import { FastPinnedConnectorPool } from '../../../../src/saas/gateway/fast/pinned-connector-pool.js';
import type { ProviderHttpConnectorInput } from '../../../../src/saas/gateway/provider-http-address.js';
import {
  type ProviderHttpBoundRequest,
  ProviderHttpTransport,
} from '../../../../src/saas/gateway/provider-http-transport.js';

const input: ProviderHttpConnectorInput = { hostname: 'provider.example', port: 443, address: '8.8.8.8', family: 4 };
function fixture(maximumEntries = 4) {
  let created = 0,
    now = 0;
  const closed: number[] = [],
    destroyed: number[] = [];
  const pool = new FastPinnedConnectorPool({
    maximumEntries,
    idleTtlMs: 1000,
    monotonicNow: () => now,
    createConnector: () => {
      const id = ++created;
      return {
        dispatcher: { id } as unknown as Dispatcher,
        close: async () => {
          closed.push(id);
        },
        destroy: async () => {
          destroyed.push(id);
        },
      };
    },
  });
  return {
    pool,
    closed,
    destroyed,
    created: () => created,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test('reuses only a completed request-exclusive matching pinned connector', async () => {
  const f = fixture();
  try {
    const first = f.pool.createConnector(input),
      second = f.pool.createConnector(input);
    assert.notEqual(first.dispatcher, second.dispatcher);
    assert.equal(f.created(), 2);
    await first.close();
    const reused = f.pool.createConnector(input);
    assert.equal(reused.dispatcher, first.dispatcher);
    await first.destroy();
    assert.deepEqual(f.destroyed, [], 'late cleanup cannot destroy a later borrower');
    await reused.close();
    await second.close();
    assert.deepEqual(f.closed, []);
  } finally {
    await f.pool.close();
  }
  assert.equal(f.closed.length, 2);
});
test('hostname/SNI, port, approved address and family separate connection identities', async () => {
  const f = fixture(8);
  try {
    const first = f.pool.createConnector(input);
    await first.close();
    for (const changed of [
      { ...input, hostname: 'other.example' },
      { ...input, port: 8443 },
      { ...input, address: '1.1.1.1' },
      { ...input, address: '2001:4860:4860::8888', family: 6 as const },
    ]) {
      const next = f.pool.createConnector(changed);
      assert.notEqual(next.dispatcher, first.dispatcher);
      await next.close();
    }
    assert.equal(f.created(), 5);
  } finally {
    await f.pool.close();
  }
});
test('cancellation destroys only its borrowed connector and cannot reenter idle', async () => {
  const f = fixture();
  try {
    const first = f.pool.createConnector(input),
      second = f.pool.createConnector(input);
    await first.destroy();
    await first.close();
    assert.deepEqual(f.destroyed, [1]);
    await second.close();
    const next = f.pool.createConnector(input);
    assert.equal(next.dispatcher, second.dispatcher);
    await next.close();
  } finally {
    await f.pool.close();
  }
});
test('idle TTL and total LRU budget retire unused connectors without evicting active ones', async () => {
  const f = fixture(2);
  try {
    const first = f.pool.createConnector(input),
      second = f.pool.createConnector({ ...input, address: '1.1.1.1' });
    assert.throws(() => f.pool.createConnector({ ...input, hostname: 'third.example' }));
    await first.close();
    const third = f.pool.createConnector({ ...input, hostname: 'third.example' });
    assert.deepEqual(f.closed, [1]);
    await third.close();
    f.advance(1001);
    const renewed = f.pool.createConnector({ ...input, hostname: 'third.example' });
    assert.notEqual(renewed.dispatcher, third.dispatcher);
    assert.deepEqual(f.closed, [1, 3]);
    await renewed.close();
    await second.close();
  } finally {
    await f.pool.close();
  }
  assert.throws(() => f.pool.createConnector(input));
});
test('unsupported proxy or TLS fingerprint never enters the direct connection pool', async () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.pool.createConnector({ ...input, proxy: {} as NonNullable<ProviderHttpConnectorInput['proxy']> }),
    );
    assert.throws(() =>
      f.pool.createConnector({
        ...input,
        tlsFingerprint: {} as NonNullable<ProviderHttpConnectorInput['tlsFingerprint']>,
      }),
    );
    assert.equal(f.created(), 0);
  } finally {
    await f.pool.close();
  }
});

test('slow close cannot grow an unbounded retirement queue', async () => {
  let unblock: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let created = 0;
  const pool = new FastPinnedConnectorPool({
    maximumEntries: 2,
    createConnector: () => {
      const id = ++created;
      return {
        dispatcher: { id } as unknown as Dispatcher,
        close: async () => {
          if (id <= 2) await barrier;
        },
        destroy: async () => {},
      };
    },
  });
  try {
    for (let i = 0; i < 4; i++) {
      const c = pool.createConnector({ ...input, hostname: `host-${i}.example` });
      await c.close();
    }
    assert.equal(created, 4);
    assert.throws(() => pool.createConnector({ ...input, hostname: 'overflow.example' }));
    assert.ok(unblock);
    unblock();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const next = pool.createConnector({ ...input, hostname: 'after-drain.example' });
    await next.close();
  } finally {
    unblock?.();
    await pool.close();
  }
});

for (const failure of ['network', 'redirect', 'invalid'] as const)
  test(`transport ${failure} failure destroys its connector before reuse`, async () => {
    const f = fixture();
    let fail = true;
    const payloadBytes = Buffer.from('{}');
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
    const tickets = new WeakSet<object>();
    const ticket = () => {
      const value = {};
      tickets.add(value);
      return value;
    };
    const transport = new ProviderHttpTransport({
      timeoutMs: 1000,
      endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
      createConnector: f.pool.createConnector,
      resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
      resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/chat/completions' }),
      resolveCredential: async (_i, use) =>
        use({ headerName: 'authorization', value: randomBytes(12).toString('hex') }),
      consumeFastTicket: (value) => {
        if (!value || typeof value !== 'object' || !tickets.delete(value)) throw new Error('unissued');
        return bound;
      },
      fetch: async () => {
        if (!fail) return new Response('ok');
        if (failure === 'network') throw new Error('network');
        if (failure === 'redirect')
          return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
        return {} as Response;
      },
    });
    try {
      await assert.rejects(() => transport.sendFast(ticket()));
      assert.deepEqual(f.destroyed, [1]);
      fail = false;
      const response = await transport.sendFast(ticket());
      assert.ok(response.body);
      const reader = response.body.getReader();
      while (!(await reader.read()).done) {}
      reader.releaseLock();
      assert.equal(f.created(), 2);
      assert.deepEqual(f.destroyed, [1]);
    } finally {
      await f.pool.close();
    }
  });
