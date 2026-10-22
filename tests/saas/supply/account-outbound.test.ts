import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  createProviderEgressProxyConnection,
  createProviderHttpTestAddressCapability,
} from '../../../src/saas/gateway/provider-http-address.js';
import { AccountOutboundError, withAccountOutbound } from '../../../src/saas/supply/account-outbound.js';

const ACCOUNT = { ownerKind: 'tenant' as const, tenantId: 'tenant-a', accountId: 'account-a' };
const OPTIONS = { deployment: 'account-outbound-test', environment: 'test' };
const KMS = {
  decryptDataKey: async () => {
    throw new Error('no proxy auth is sealed in this fixture');
  },
};

function executor(port: number | null): SqlExecutor {
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      assert.match(sql, /JOIN saas_egress_proxies/);
      assert.match(sql, /account.tenant_id = \$1 AND account.id = \$2/);
      assert.deepEqual(values, ['tenant-a', 'account-a']);
      const rows =
        port === null
          ? []
          : [
              {
                id: 'proxy-a',
                name: 'test proxy',
                protocol: 'http',
                host: '127.0.0.1',
                port,
                auth_sealed_envelope: null,
                status: 'active',
                expires_at: null,
                fallback_mode: 'none',
                backup_proxy_id: null,
                last_probe_at: null,
                last_probe_latency_ms: null,
                last_probe_ip: null,
                last_probe_quality: null,
              },
            ];
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

test('bound-account default fetch traverses a real HTTP CONNECT proxy and never calls global fetch', async (t) => {
  process.env.NODE_ENV = 'test';
  const capability = createProviderHttpTestAddressCapability(
    '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
  );
  const sockets = new Set<net.Socket>();
  let proxyCalls = 0;
  let targetCalls = 0;
  const target = http.createServer((request, response) => {
    targetCalls += 1;
    assert.equal(request.url, '/usages');
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  const proxy = http.createServer();
  proxy.on('connect', (request, client, head) => {
    proxyCalls += 1;
    const port = Number(request.url?.split(':').at(-1));
    const upstream = net.connect({ host: '127.0.0.1', port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  for (const server of [target, proxy])
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch must not bypass account proxy policy');
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  const observed = await withAccountOutbound(
    executor(proxyPort),
    KMS,
    ACCOUNT,
    {
      ...OPTIONS,
      createEgressConnection: (descriptor, options) =>
        createProviderEgressProxyConnection(descriptor, {
          ...options,
          testCapability: capability,
        }),
    },
    async (outbound) => {
      const response = await outbound.fetch(`http://127.0.0.1:${targetPort}/usages`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.json();
    },
  );
  assert.deepEqual(observed, { ok: true });
  assert.equal(proxyCalls, 1);
  assert.equal(targetCalls, 1);
});

test('proxy setup failures never fall back to a direct fetch and errors contain no proxy data', async () => {
  let calls = 0;
  await assert.rejects(
    withAccountOutbound(
      executor(8080),
      KMS,
      ACCOUNT,
      {
        ...OPTIONS,
        createEgressConnection: async () => {
          throw new Error('private proxy URL must stay hidden');
        },
        fetch: async () => {
          calls += 1;
          return new Response('{}');
        },
      },
      (outbound) => outbound.fetch('https://api.kimi.com/coding/v1/usages', {}),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AccountOutboundError);
      assert.equal(error.message.includes('private'), false);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('the account scope retains its dispatcher through body consumption and destroys it on completion', async () => {
  let destroyed = false;
  const dispatcher = { fixture: true } as never;
  await withAccountOutbound(
    executor(8080),
    KMS,
    ACCOUNT,
    {
      ...OPTIONS,
      createEgressConnection: async () => ({
        dispatcher,
        close: async () => {},
        destroy: async () => {
          destroyed = true;
        },
      }),
      fetch: async (_url, init) => {
        assert.equal(init.dispatcher, dispatcher);
        return new Response(
          new ReadableStream({
            pull(controller) {
              assert.equal(destroyed, false);
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
            },
          }),
        );
      },
    },
    async (outbound) => {
      const response = await outbound.fetch('https://api.kimi.com/coding/v1/usages', {});
      await response.json();
      assert.equal(destroyed, false);
    },
  );
  assert.equal(destroyed, true);
});
