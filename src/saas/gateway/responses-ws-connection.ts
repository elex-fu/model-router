import type { IncomingMessage, ServerResponse } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import type { ResponsesWsEngine, ResponsesWsEvent, ResponsesWsInboundEvent } from './responses-ws-engine.js';

/**
 * Gap-remediation plan G-B4 (§12.1, connection half): the ws upgrade layer
 * binding the session engine to a real socket.
 *
 * Connection-level concerns ONLY (per-round auth/admission/settlement live
 * in the engine's executor):
 *   - the HTTP upgrade happens under the caller's key auth (the injected
 *     `upgrade` callback authenticates BEFORE the socket attaches);
 *   - Origin check (exact-host allowlist — no wildcards);
 *   - per-connection message size + queue bounds and a global connection
 *     cap (the plan's connection resources);
 *   - a bounded set of decoded handlers feeding the one-active-round
 *     engine; awaited sends backpressure the provider body reader;
 *   - ping/pong keepalive with an idle deadline.
 *
 * Compression stays OFF (the plan's §12.1 note).
 */

export interface ResponsesWsConnectionLimits {
  /** Max one inbound frame size (bytes); default 1 MiB. */
  readonly maxPayloadBytes?: number;
  /** Max concurrent connections across the server; default 256. */
  readonly maxConnections?: number;
  /** Idle deadline without any frame (ms); default 300 s. */
  readonly idleTimeoutMs?: number;
  /** Allowed Origin values (exact match, no wildcards); empty = same-origin only. */
  readonly allowedOrigins?: readonly string[];
  /** Hard bound on queued outbound bytes; default 4 MiB. */
  readonly maxBufferedBytes?: number;
  /** Concurrent decoded control handlers; default 16. */
  readonly maxPendingFrames?: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface ResponsesWsUpgrade {
  /** Authenticates the upgrade request; resolves the caller identity or rejects. */
  readonly authenticate: (
    req: IncomingMessage,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
  /** Builds the per-connection engine (executor binding is the caller's). */
  readonly createEngine: (request: IncomingMessage) => ResponsesWsEngine;
  readonly limits?: ResponsesWsConnectionLimits;
  /** The subprotocol the client must request (the OpenAI realtime convention); empty accepts any/none. */
  readonly subprotocol?: string;
}

export interface ResponsesWsServerHandle {
  /** Handles one HTTP upgrade request; false = not ours (caller 404s). */
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean;
  close(): Promise<void>;
  readonly activeConnections: number;
}

export function createResponsesWsServer(upgrade: ResponsesWsUpgrade): ResponsesWsServerHandle {
  const maxPayloadBytes = upgrade.limits?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxConnections = upgrade.limits?.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const idleTimeoutMs = upgrade.limits?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const allowedOrigins = upgrade.limits?.allowedOrigins ?? [];
  const maxBufferedBytes = upgrade.limits?.maxBufferedBytes ?? 4 * 1024 * 1024;
  const maxPendingFrames = upgrade.limits?.maxPendingFrames ?? 16;
  if (
    [maxPayloadBytes, maxConnections, idleTimeoutMs, maxBufferedBytes, maxPendingFrames].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error('invalid Responses WebSocket limits');
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    perMessageDeflate: false,
    ...(upgrade.subprotocol
      ? {
          handleProtocols: (protocols: Set<string>) =>
            protocols.has(upgrade.subprotocol ?? '') ? (upgrade.subprotocol ?? false) : false,
        }
      : {}),
  });
  const engines = new Set<ResponsesWsEngine>();
  let active = 0;
  let pending = 0;
  let stopped = false;

  const shutdown = (): void => {
    stopped = true;
    for (const engine of engines) engine.clientDisconnected();
    for (const client of wss.clients) client.terminate();
  };

  const handleUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean => {
    if (stopped) return false;
    const requestKey = (req.url ?? '').split('?')[0];
    if (requestKey !== '/v1/responses' || req.method !== 'GET') return false;

    const origin = String(req.headers.origin ?? '');
    let originAllowed = origin === '';
    if (allowedOrigins.length > 0) originAllowed = allowedOrigins.includes(origin);
    else if (origin !== '') {
      try {
        const parsed = new URL(origin);
        originAllowed =
          ['http:', 'https:'].includes(parsed.protocol) &&
          parsed.host.toLowerCase() === String(req.headers.host ?? '').toLowerCase() &&
          parsed.origin === origin;
      } catch {
        originAllowed = false;
      }
    }
    if (!originAllowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (active + pending >= maxConnections) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (
      upgrade.subprotocol &&
      !String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .some((value) => value.trim() === upgrade.subprotocol)
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return true;
    }

    pending += 1;
    void (async () => {
      try {
        const auth = await upgrade.authenticate(req).catch(() => ({ ok: false as const, reason: 'unavailable' }));
        if (!auth.ok) {
          socket.write(
            auth.reason === 'unavailable'
              ? 'HTTP/1.1 503 Service Unavailable\r\n\r\n'
              : 'HTTP/1.1 401 Unauthorized\r\n\r\n',
          );
          socket.destroy();
          return;
        }
        if (stopped || socket.destroyed) {
          socket.destroy();
          return;
        }
        const engine = upgrade.createEngine(req);
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          active += 1;
          engines.add(engine);
          ws.on('close', () => {
            active -= 1;
            void engine.whenIdle().finally(() => engines.delete(engine));
          });
          attachConnection(ws, engine);
        });
      } catch {
        if (!socket.destroyed) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
        }
      } finally {
        pending -= 1;
      }
    })();
    return true;
  };

  const attachConnection = (ws: WebSocket, engine: ResponsesWsEngine): void => {
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ws.close(1000, 'idle');
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    armIdle();

    const send = async (event: ResponsesWsEvent): Promise<void> => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket closed');
      const frame = JSON.stringify(event);
      if (ws.bufferedAmount + Buffer.byteLength(frame) > maxBufferedBytes) {
        engine.clientDisconnected();
        ws.close(1013, 'slow consumer');
        throw new Error('WebSocket send buffer exhausted');
      }
      await new Promise<void>((resolve, reject) => ws.send(frame, (error) => (error ? reject(error) : resolve())));
    };
    const close = (code: number, reason: string): void => {
      ws.close(code, reason);
    };
    // The engine was constructed before the socket existed — bind now.
    engine.bindTransport(send, close);

    let pendingFrames = 0;
    ws.on('message', (data: unknown) => {
      armIdle();
      let parsed: ResponsesWsInboundEvent | null = null;
      try {
        const decoded = JSON.parse(String(data));
        if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
          parsed = decoded as ResponsesWsInboundEvent;
        }
      } catch {
        ws.close(1002, 'invalid json');
        return;
      }
      if (parsed === null) {
        ws.close(1002, 'invalid event');
        return;
      }
      // Cancellation bypasses the bounded work budget and never waits for
      // an active provider stream or socket backpressure.
      const control = parsed.type === 'response.cancel' || parsed.type === 'response.interrupt';
      if (!control && pendingFrames >= maxPendingFrames) {
        engine.clientDisconnected();
        ws.close(1013, 'reader queue exhausted');
        return;
      }
      pendingFrames += 1;
      void engine
        .handle(parsed)
        .catch(() => {
          engine.clientDisconnected();
          ws.terminate();
        })
        .finally(() => {
          pendingFrames -= 1;
        });
    });
    ws.on('close', () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      engine.clientDisconnected();
    });
    ws.on('error', () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      engine.clientDisconnected();
    });
    ws.on('pong', () => {
      armIdle();
    });
    // Server-side keepalive ping.
    const pingTimer = setInterval(
      () => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(pingTimer);
      },
      Math.min(idleTimeoutMs / 2, 60_000),
    );
    pingTimer.unref?.();
    ws.on('close', () => clearInterval(pingTimer));
  };

  return {
    handleUpgrade,
    close: async () => {
      shutdown();
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          for (const client of wss.clients) client.terminate();
          resolve();
        }, 2_000);
        force.unref?.();
        wss.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
      await Promise.allSettled([...engines].map((engine) => engine.whenIdle()));
    },
    get activeConnections() {
      return active;
    },
  };
}

/** Rejects a non-upgrade request on the WS path with the precise 426. */
export function rejectNonUpgrade(res: ServerResponse): void {
  res.writeHead(426, { 'Content-Type': 'application/json', Upgrade: 'websocket' });
  res.end(
    JSON.stringify({ error: { code: 'UPGRADE_REQUIRED', message: 'this endpoint requires a WebSocket upgrade' } }),
  );
}
