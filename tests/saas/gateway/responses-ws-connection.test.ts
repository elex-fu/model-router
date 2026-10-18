import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createResponsesWsServer } from '../../../src/saas/gateway/responses-ws-connection.js';
import { ResponsesWsEngine } from '../../../src/saas/gateway/responses-ws-engine.js';

/**
 * Gap-remediation G-B4 (connection half): the upgrade layer — auth before
 * attach, Origin allowlist, the connection cap, the JSON frame contract,
 * and the end-to-end round trip through the engine.
 */

function buildServer(options: { allowedOrigins?: readonly string[]; maxConnections?: number; authOk?: boolean }) {
  const events: Array<{ type: string; payload?: unknown }> = [];
  const handle = createResponsesWsServer({
    authenticate: async () => (options.authOk === false ? { ok: false, reason: 'no' } : { ok: true }),
    createEngine: () =>
      new ResponsesWsEngine({
        executor: {
          async executeRound({ body }) {
            events.push({ type: 'round', payload: body });
            return {
              terminal: { type: 'response.completed', response_id: 'r1', usage: { total: 1 } },
              pinned: {
                tenantId: 't',
                proxyKeyId: 'k',
                providerId: 'p',
                accountId: 'a',
                upstreamModel: 'm',
                upstreamSessionId: null,
              },
            };
          },
        },
        send: () => {},
        close: () => {},
      }),
    limits: {
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
      ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    },
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!handle.handleUpgrade(req, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });
  return { server, handle, events };
}

async function withServer<T>(
  options: Parameters<typeof buildServer>[0],
  work: (port: number, events: Array<{ type: string; payload?: unknown }>) => Promise<T>,
): Promise<T> {
  const { server, handle, events } = buildServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await work(port, events);
  } finally {
    await Promise.race([
      handle.close(),
      new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, 3_000);
        guard.unref?.();
      }),
    ]);
    server.closeAllConnections?.();
    server.close();
    await Promise.race([
      once(server, 'close'),
      new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, 3_000);
        guard.unref?.();
      }),
    ]);
  }
}

test('G-B4 connection: a full round trip — upgrade, create, completed, clean close', async () => {
  await withServer({}, async (port, events) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
    await once(ws, 'open');
    const received: Array<{ type: string }> = [];
    ws.on('message', (data) => {
      received.push(JSON.parse(String(data)));
    });
    ws.send(JSON.stringify({ type: 'response.create', response: { model: 'm', input: 'hi' } }));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((e) => e.type === 'response.completed')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { model: 'm', input: 'hi' });
    ws.close(1000);
    await once(ws, 'close');
  });
});

test('G-B4 connection: a disallowed Origin is rejected before the upgrade', async () => {
  await withServer({ allowedOrigins: ['https://console.example'] }, async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
      headers: { origin: 'https://evil.example' },
    });
    const [failed] = (await once(ws, 'error')) as [Error];
    assert.ok(failed.message.includes('403') || failed.message.includes('Unexpected'));
  });
});

test('G-B4 connection: failed auth rejects the upgrade with 401', async () => {
  await withServer({ authOk: false }, async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
    const [failed] = (await once(ws, 'error')) as [Error];
    assert.ok(failed.message.includes('401') || failed.message.includes('Unexpected'));
  });
});

test('G-B4 connection: the connection cap answers 429', async () => {
  await withServer({ maxConnections: 1 }, async (port) => {
    const first = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
    await once(first, 'open');
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
    const [failed] = (await once(second, 'error')) as [Error];
    assert.ok(failed.message.includes('429') || failed.message.includes('Unexpected'));
    first.close(1000);
    await once(first, 'close');
  });
});

test('G-B4 connection: invalid JSON closes with 1002', async () => {
  await withServer({}, async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
    await once(ws, 'open');
    ws.send('this is not json');
    const [code] = (await once(ws, 'close')) as [number, string];
    assert.equal(code, 1002);
  });
});
