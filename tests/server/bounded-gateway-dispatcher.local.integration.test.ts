import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestPeerAddress } from '../../src/saas/gateway/trusted-request-peer.js';
import { BoundedGatewayPermits, type BoundedGatewaySlot } from '../../src/server/bounded-gateway-budgets.js';
import { createBoundedGatewayDispatcher } from '../../src/server/bounded-gateway-dispatcher.js';
import { BOUNDED_GATEWAY_TICKET_HEADER } from '../../src/server/bounded-gateway-protocol.js';
import { BoundedGatewayWorkerTickets } from '../../src/server/bounded-gateway-worker-tickets.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function streamingFixtureCompletion(
  response: Pick<ServerResponse, 'destroyed' | 'writableEnded'> & { end(body: string): unknown },
  complete: () => void,
): () => void {
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    try {
      if (!response.destroyed && !response.writableEnded) response.end('data: last\n\n');
    } finally {
      complete();
    }
  };
}

test('streaming fixture completion ends only a live response and releases ownership exactly once', () => {
  for (const [destroyed, writableEnded] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    let writes = 0;
    let completions = 0;
    const finish = streamingFixtureCompletion(
      {
        destroyed,
        writableEnded,
        end() {
          writes++;
        },
      },
      () => {
        completions++;
      },
    );
    finish();
    finish();
    assert.equal(writes, destroyed || writableEnded ? 0 : 1);
    assert.equal(completions, 1);
  }
  let completions = 0;
  const failure = new Error('fixture write failure');
  const finish = streamingFixtureCompletion(
    {
      destroyed: false,
      writableEnded: false,
      end() {
        throw failure;
      },
    },
    () => {
      completions++;
    },
  );
  assert.throws(finish, (error) => error === failure, 'a genuine write error must still surface');
  finish();
  assert.equal(completions, 1, 'write failure cannot skip or duplicate handler completion');
});

async function fixture(
  handle: (request: IncomingMessage, response: ServerResponse, slot: BoundedGatewaySlot, complete: () => void) => void,
  reserveWait?: () => Promise<void>,
  maximumConnections = 8,
) {
  const directory = await mkdtemp(join(tmpdir(), 'mr-bound-'));
  const epochs = [randomUUID(), randomUUID()];
  const permits = new BoundedGatewayPermits(1);
  const sockets = new Set<Socket>();
  const paths = [join(directory, '0.sock'), join(directory, '1.sock')];
  const books = ([0, 1] as const).map(
    (slot) => new BoundedGatewayWorkerTickets(1, (ticket) => permits.complete(slot, epochs[slot], ticket)),
  );
  const workers = ([0, 1] as const).map((slot) =>
    http.createServer((request, response) => {
      if (!books[slot].accept(request, response)) return;
      handle(request, response, slot, () => books[slot].finish(request));
    }),
  );
  const dispatcher = createBoundedGatewayDispatcher({
    permits,
    maximumConnections,
    maximumBodyBytes: 1024 * 1024,
    requestTimeoutMs: 1000,
    ready: () => true,
    transport: {
      async reserve(slot, _epoch, ticket, peer) {
        books[slot].reserve(ticket, peer);
        await reserveWait?.();
      },
      cancel(slot, _epoch, ticket) {
        books[slot].cancel(ticket);
      },
      socketPath(slot) {
        return paths[slot];
      },
    },
  });
  try {
    for (const slot of [0, 1] as const) {
      workers[slot].on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        workers[slot].once('error', reject);
        workers[slot].listen(paths[slot], resolve);
      });
      permits.start(slot, epochs[slot]);
      permits.ready(slot, epochs[slot]);
    }
    await new Promise<void>((resolve, reject) => {
      dispatcher.server.once('error', reject);
      dispatcher.server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    dispatcher.closeConnections();
    await dispatcher.close();
    for (const worker of workers) worker.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const port = (dispatcher.server.address() as net.AddressInfo).port;
  return {
    permits,
    books,
    port,
    dispatcher,
    async close() {
      dispatcher.closeConnections();
      await dispatcher.close();
      for (const book of books) book.stop();
      for (const socket of sockets) socket.destroy();
      await Promise.all(workers.map((worker) => new Promise<void>((resolve) => worker.close(() => resolve()))));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function request(
  port: number,
  agent?: http.Agent,
  path = '/v1/responses',
  headers: http.OutgoingHttpHeaders = {},
) {
  return new Promise<{ status: number; body: string; localPort?: number; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', agent, headers: { 'content-length': '2', ...headers } },
        (res) => {
          const localPort = req.socket?.localPort;
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.once('end', () => resolve({ status: res.statusCode!, body, localPort, headers: res.headers }));
          res.once('error', reject);
        },
      );
      req.once('error', reject);
      req.end('{}');
    },
  );
}

test('one persistent client is placed per request and EOF does not release retained cleanup capacity', {
  timeout: 5000,
}, async () => {
  const completions: Array<() => void> = [];
  const seen: number[] = [];
  const value = await fixture((req, res, slot, complete) => {
    req.resume();
    completions.push(complete);
    seen.push(slot);
    assert.equal(requestPeerAddress(req), '127.0.0.1');
    assert.equal(req.headers.authorization, 'fixture-authorization');
    assert.equal(req.headers['x-model-router-bounded-peer'], undefined);
    res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] });
    res.end(String(slot));
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const headers = {
    authorization: 'fixture-authorization',
    [BOUNDED_GATEWAY_TICKET_HEADER]: randomUUID(),
    'x-model-router-bounded-peer': '192.0.2.250',
  };
  try {
    const first = await request(value.port, agent, '/v1/responses', headers);
    const second = await request(value.port, agent, '/v1/responses', headers);
    assert.equal(first.localPort, second.localPort, 'same external keep-alive socket must reach both workers');
    assert.notEqual(first.body, second.body);
    assert.deepEqual(first.headers['set-cookie'], ['a=1', 'b=2']);
    assert.equal((await request(value.port, agent, '/v1/responses', headers)).status, 429);
    assert.deepEqual(
      value.permits.snapshot().map((slot) => slot.inFlight),
      [1, 1],
    );
    completions[0]();
    assert.equal((await request(value.port, agent, '/v1/responses', headers)).status, 200);
    assert.equal(seen[2], seen[0]);
  } finally {
    for (const complete of completions) complete();
    agent.destroy();
    await value.close();
  }
});

test('abort before reserve ACK cancels the one-use capability without backend dispatch or leaked permit', {
  timeout: 5000,
}, async () => {
  let acknowledge!: () => void;
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let calls = 0;
  const value = await fixture(
    (_req, res, _slot, complete) => {
      calls++;
      res.end();
      complete();
    },
    () => ack,
  );
  try {
    const req = http.request({
      host: '127.0.0.1',
      port: value.port,
      path: '/v1/responses',
      method: 'POST',
      headers: { 'content-length': 10 },
    });
    req.on('error', () => {});
    req.flushHeaders();
    for (let i = 0; i < 50 && value.books.every((book) => book.size === 0); i++) await tick();
    assert.equal(
      value.books.reduce((sum, book) => sum + book.size, 0),
      1,
    );
    req.destroy();
    for (let i = 0; i < 50 && value.books.some((book) => book.size > 0); i++) await tick();
    acknowledge();
    await tick();
    assert.equal(calls, 0);
    assert.equal(
      value.books.reduce((sum, book) => sum + book.size, 0),
      0,
    );
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      0,
    );
  } finally {
    acknowledge();
    await value.close();
  }
});

test('SSE is streamed before completion and client abort retains handler ownership', { timeout: 5000 }, async () => {
  let finish!: () => void;
  let completionCalls = 0;
  const value = await fixture((req, res, _slot, complete) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = streamingFixtureCompletion(res, () => {
      completionCalls++;
      complete();
    });
  });
  try {
    const stream = await new Promise<{ req: http.ClientRequest; res: IncomingMessage; first: string }>(
      (resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: value.port, path: '/v1/responses', method: 'POST' },
          (res) => {
            res.on('error', () => {});
            res.once('data', (first: Buffer) => resolve({ req, res, first: first.toString() }));
          },
        );
        req.once('error', reject);
        req.end('{}');
      },
    );
    assert.equal(stream.first, 'data: first\n\n');
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      1,
    );
    stream.res.destroy();
    stream.req.destroy();
    await tick();
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      1,
    );
    assert.equal(completionCalls, 0, 'client abort must not complete the original handler');
    finish();
    finish(); // The finally cleanup below is allowed to invoke the same completion again.
    assert.equal(completionCalls, 1);
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      0,
    );
  } finally {
    finish?.();
    await value.close();
  }
});

test('health body, public control paths and WebSocket upgrade are explicit refusals', { timeout: 5000 }, async () => {
  let calls = 0;
  const value = await fixture((_req, res, _slot, complete) => {
    calls++;
    res.end();
    complete();
  });
  try {
    assert.equal((await request(value.port, undefined, '/admin/internal')).status, 404);
    const health = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: value.port, path: '/readyz', method: 'GET', headers: { 'content-length': 1 } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end('x');
    });
    assert.equal(health, 400);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(value.port, '127.0.0.1', () =>
        socket.write(
          'GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        ),
      );
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(response, /^HTTP\/1.1 501/);
    assert.equal(calls, 0);
  } finally {
    await value.close();
  }
});

test('idle/slow public connections have a separate hard bound even when no business permit is held', {
  timeout: 5000,
}, async () => {
  const value = await fixture(
    (_req, res, _slot, complete) => {
      res.end();
      complete();
    },
    undefined,
    2,
  );
  const sockets: Socket[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const socket = net.connect(value.port, '127.0.0.1');
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
    }
    const extra = net.connect(value.port, '127.0.0.1');
    sockets.push(extra);
    await new Promise<void>((resolve, reject) => {
      extra.once('close', () => resolve());
      extra.once('error', reject);
    });
    const count = await new Promise<number>((resolve, reject) =>
      value.dispatcher.server.getConnections((error, total) => (error ? reject(error) : resolve(total))),
    );
    assert.ok(count <= 2);
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      0,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await value.close();
  }
});

test('concurrent pipelining is not a hidden ordered-response ingress queue', { timeout: 5000 }, async () => {
  let calls = 0;
  const value = await fixture((req, res, _slot, complete) => {
    calls++;
    req.resume();
    res.end('ok');
    complete();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(value.port, '127.0.0.1', () => {
        socket.write(
          'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}',
        );
      });
      socket.resume();
      socket.once('close', () => resolve());
      socket.once('error', reject);
    });
    for (let i = 0; i < 20; i++) await tick();
    assert.ok(calls <= 1, 'second pipelined request must not reach a business worker');
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      0,
    );
  } finally {
    await value.close();
  }
});

test('Expect and declared trailers are refused before business dispatch; chunked overflow is bounded', {
  timeout: 5000,
}, async () => {
  let calls = 0;
  let received = 0;
  const value = await fixture((req, res, _slot, complete) => {
    calls++;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    req.once('error', () => {});
    req.once('close', complete);
    req.once('end', () => {
      res.end('ok');
      complete();
    });
  });
  const raw = async (payload: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect(value.port, '127.0.0.1', () => socket.end(payload));
      let response = '';
      socket.on('data', (chunk) => {
        response += chunk;
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(response));
    });
  try {
    assert.match(
      await raw('POST /v1/responses HTTP/1.1\r\nHost: local\r\nContent-Length: 1\r\nExpect: 100-continue\r\n\r\n'),
      /^HTTP\/1.1 417/,
    );
    assert.match(
      await raw(
        'POST /v1/responses HTTP/1.1\r\nHost: local\r\nTransfer-Encoding: chunked\r\nTrailer: x-test\r\n\r\n0\r\nx-test: value\r\n\r\n',
      ),
      /^HTTP\/1.1 400/,
    );
    assert.equal(calls, 0);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: value.port,
          path: '/v1/responses',
          method: 'POST',
          headers: { 'transfer-encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode!));
          res.once('error', reject);
        },
      );
      req.once('error', reject);
      req.end(Buffer.alloc(1024 * 1024 + 65536));
    });
    assert.equal(status, 413);
    assert.ok(received <= 1024 * 1024, 'overflowing chunk is never forwarded to the worker');
  } finally {
    await value.close();
  }
});

test('a paused response reader propagates backpressure rather than collecting the upstream stream', {
  timeout: 5000,
}, async () => {
  let supplied = 0;
  let peakFrontBuffer = 0;
  let finish: (() => void) | undefined;
  const value = await fixture((req, res, _slot, complete) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = Buffer.alloc(65536, 97);
    const pump = () => {
      while (!res.destroyed && supplied < 64 * 1024 * 1024) {
        supplied += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
    };
    finish = () => {
      res.destroy();
      complete();
    };
    pump();
  });
  let front: ServerResponse | undefined;
  value.dispatcher.server.on('request', (_req, res) => {
    front = res;
  });
  const sample = setInterval(() => {
    peakFrontBuffer = Math.max(peakFrontBuffer, front?.writableLength ?? 0);
  }, 1);
  let client: http.ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      client = http.get({ host: '127.0.0.1', port: value.port, path: '/v1/responses' }, (res) => {
        res.pause();
        res.on('error', () => {});
        resolve(res);
      });
      client.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(supplied < 64 * 1024 * 1024, 'slow reader must stop producer before the entire stream is materialized');
    assert.ok(peakFrontBuffer <= 256 * 1024, `front queued ${peakFrontBuffer} bytes despite native backpressure`);
    assert.equal(
      value.permits.snapshot().reduce((sum, slot) => sum + slot.inFlight, 0),
      1,
    );
  } finally {
    clearInterval(sample);
    response?.destroy();
    client?.destroy();
    finish?.();
    await value.close();
  }
});
