import { randomUUID } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { BoundedGatewayPermits, BoundedGatewaySlot } from './bounded-gateway-budgets.js';
import { BOUNDED_GATEWAY_TICKET_HEADER } from './bounded-gateway-protocol.js';

export interface BoundedGatewayDispatchTransport {
  reserve(slot: BoundedGatewaySlot, epoch: string, ticket: string, peerAddress: string): Promise<void>;
  cancel(slot: BoundedGatewaySlot, epoch: string, ticket: string): void;
  socketPath(slot: BoundedGatewaySlot, epoch: string): string;
}
export interface BoundedGatewayDispatcherOptions {
  readonly permits: BoundedGatewayPermits;
  readonly transport: BoundedGatewayDispatchTransport;
  readonly maximumConnections: number;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly ready: () => boolean;
}

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Strip hop-by-hop fields AND names nominated by Connection. Never carry an external internal-ticket header. */
export function boundedGatewayForwardHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const blocked = new Set(HOP_HEADERS);
  const connection = headers.connection;
  if (typeof connection === 'string') for (const name of connection.split(',')) blocked.add(name.trim().toLowerCase());
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-model-router-bounded-'))
      result[name] = value;
  }
  return result;
}

function reject(request: IncomingMessage, response: ServerResponse, status: number, code: string): void {
  // There is no pending ingress body queue. Overload never drains an unbounded attacker body.
  response.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
    'cache-control': 'no-store',
    ...(status === 429 ? { 'retry-after': '1' } : {}),
  });
  response.end(JSON.stringify({ error: { code } }));
  request.pause();
}

export function createBoundedGatewayDispatcher(options: BoundedGatewayDispatcherOptions): {
  readonly server: http.Server;
  stopAdmission(): void;
  closeConnections(): void;
  close(): Promise<void>;
} {
  for (const value of [options.maximumConnections, options.maximumBodyBytes, options.requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('BOUNDED_GATEWAY_INVALID_INGRESS_BOUND');
  }
  let closing = false;
  let closed: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const busySockets = new WeakSet<Socket>();
  const agents = [
    new http.Agent({ keepAlive: true, maxSockets: options.permits.localLimit, maxFreeSockets: 2 }),
    new http.Agent({ keepAlive: true, maxSockets: options.permits.localLimit, maxFreeSockets: 2 }),
  ];
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    if (busySockets.has(request.socket)) {
      // Pipelining would let Node accumulate ordered responses behind a slow first request.
      // Sequential HTTP keep-alive is supported; concurrent pipelining is explicitly not.
      request.socket.destroy();
      return;
    }
    busySockets.add(request.socket);
    const clearSocket = () => busySockets.delete(request.socket);
    response.once('finish', clearSocket);
    response.once('close', clearSocket);
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://bounded.invalid').pathname;
    } catch {
      reject(request, response, 400, 'INVALID_PATH');
      return;
    }
    if ((pathname === '/healthz' || pathname === '/readyz') && request.method === 'GET') {
      if (
        request.headers['transfer-encoding'] !== undefined ||
        (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
      ) {
        reject(request, response, 400, 'HEALTH_REQUEST_BODY_FORBIDDEN');
        return;
      }
      request.resume();
      const ready = !closing && options.ready();
      response.writeHead(pathname === '/healthz' || ready ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ready, mode: 'bounded-two-http' }));
      return;
    }
    // Do not expose worker metrics/control/admin endpoints as a side effect of proxying.
    if (pathname !== '/v1' && !pathname.startsWith('/v1/')) {
      reject(request, response, 404, 'NOT_FOUND');
      return;
    }
    if (closing) {
      reject(request, response, 503, 'GATEWAY_DRAINING');
      return;
    }
    if (!options.ready()) {
      reject(request, response, 503, 'GATEWAY_NOT_READY');
      return;
    }
    if (request.headers.trailer !== undefined) {
      reject(request, response, 400, 'REQUEST_TRAILERS_UNSUPPORTED');
      return;
    }
    const length = request.headers['content-length'];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > options.maximumBodyBytes)
    ) {
      reject(request, response, 413, 'REQUEST_TOO_LARGE');
      return;
    }
    const ticket = randomUUID();
    const reservation = options.permits.reserve(ticket);
    if (!reservation) {
      reject(request, response, 429, 'GATEWAY_CAPACITY_EXHAUSTED');
      return;
    }
    const { slot, epoch } = reservation;
    let backend: http.ClientRequest | undefined;
    let abandoned = false;
    const cancel = () => {
      abandoned = true;
      backend?.destroy();
      options.transport.cancel(slot, epoch, ticket);
    };
    const lifetime = setTimeout(() => {
      cancel();
      response.destroy();
    }, options.requestTimeoutMs);
    lifetime.unref();
    response.once('finish', () => clearTimeout(lifetime));
    response.once('close', () => clearTimeout(lifetime));
    request.once('aborted', cancel);
    request.once('error', cancel);
    response.once('error', cancel);
    response.once('close', () => {
      if (!response.writableFinished) cancel();
    });
    // Header/body intake remains paused until a bounded child reservation is acknowledged.
    request.pause();
    void options.transport.reserve(slot, epoch, ticket, request.socket.remoteAddress ?? '').then(
      () => {
        if (abandoned || closing || response.destroyed) {
          cancel();
          return;
        }
        const headers = boundedGatewayForwardHeaders(request.headers);
        headers[BOUNDED_GATEWAY_TICKET_HEADER] = ticket;
        backend = http.request({
          socketPath: options.transport.socketPath(slot, epoch),
          path: request.url,
          method: request.method,
          headers,
          agent: agents[slot],
        });
        backend.once('response', (upstream) => {
          if (abandoned) {
            upstream.destroy();
            return;
          }
          response.writeHead(upstream.statusCode ?? 502, boundedGatewayForwardHeaders(upstream.headers));
          upstream.once('error', () => {
            response.destroy();
            cancel();
          });
          upstream.once('aborted', () => {
            response.destroy();
            cancel();
          });
          // Native stream backpressure bounds buffering in both directions; never collect an SSE body.
          upstream.pipe(response);
        });
        backend.once('error', () => {
          options.transport.cancel(slot, epoch, ticket);
          if (!response.headersSent && !response.destroyed)
            reject(request, response, 503, 'GATEWAY_WORKER_UNAVAILABLE');
          else response.destroy();
        });
        let bytes = 0;
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maximumBodyBytes) {
            cancel();
            if (!response.headersSent) reject(request, response, 413, 'REQUEST_TOO_LARGE');
            else response.destroy();
          }
        });
        request.once('end', () => {
          // Undeclared trailers are not a second, silently dropped authority channel.
          if (request.rawTrailers.length) {
            cancel();
            if (!response.headersSent) reject(request, response, 400, 'REQUEST_TRAILERS_UNSUPPORTED');
            else response.destroy();
          }
        });
        request.pipe(backend);
      },
      () => {
        cancel();
        if (!response.headersSent && !response.destroyed) reject(request, response, 503, 'GATEWAY_WORKER_UNAVAILABLE');
        else response.destroy();
      },
    );
    // Deliberately no release on finish/close/abort. The worker's original handler owns completion.
  });
  server.maxConnections = options.maximumConnections;
  server.maxRequestsPerSocket = 1000;
  server.headersTimeout = Math.min(options.requestTimeoutMs, 15_000);
  server.requestTimeout = options.requestTimeoutMs;
  server.setTimeout(options.requestTimeoutMs, (socket) => socket.destroy());
  server.keepAliveTimeout = 5000;
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('checkContinue', (request, response) => reject(request, response, 417, 'EXPECT_CONTINUE_UNSUPPORTED'));
  server.on('checkExpectation', (request, response) => reject(request, response, 417, 'EXPECT_CONTINUE_UNSUPPORTED'));
  server.on('upgrade', (_request, socket) => {
    socket.end(
      'HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\nX-Error-Code: BOUNDED_WEBSOCKET_UNSUPPORTED\r\n\r\n',
    );
  });
  server.on('connect', (_request, socket) => socket.destroy());
  return {
    server,
    stopAdmission() {
      closing = true;
      server.closeIdleConnections();
    },
    closeConnections() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      closing = true;
      closed ??= new Promise<void>((resolve, rejectClose) => {
        server.close((error) => {
          for (const agent of agents) agent.destroy();
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error);
          else resolve();
        });
      });
      return closed;
    },
  };
}
