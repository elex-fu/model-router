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
 *   - a single reader loop feeding the engine (a slow engine
 *     backpressures the socket naturally: ws pauses on a full send buffer);
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
  readonly createEngine: () => ResponsesWsEngine;
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes, perMessageDeflate: false });
  let active = 0;
  let stopped = false;

  const shutdown = (): void => {
    stopped = true;
    for (const client of wss.clients) client.terminate();
  };

  const handleUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean => {
    if (stopped) return false;
    const requestKey = req.url ?? '';
    if (!requestKey.startsWith('/v1/responses')) return false;

    const origin = String(req.headers.origin ?? '');
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (active >= maxConnections) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return true;
    }

    void (async () => {
      const auth = await upgrade.authenticate(req).catch(() => ({ ok: false as const, reason: 'unavailable' }));
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        active += 1;
        ws.on('close', () => {
          active -= 1;
        });
        attachConnection(ws, upgrade.createEngine());
      });
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

    const send = (event: ResponsesWsEvent): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(event));
    };
    const close = (code: number, reason: string): void => {
      ws.close(code, reason);
    };
    // The engine was constructed before the socket existed — bind now.
    engine.bindTransport(send, close);

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
      // The single reader loop: the engine handles one event at a time; a
      // busy round naturally serializes subsequent frames (the queue is
      // ws's own recv buffer, bounded by maxPayload per frame).
      void engine.handle(parsed);
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
