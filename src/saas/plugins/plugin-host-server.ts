/**
 * Batch-5 §5.1 plugin-host internal HTTP surface.
 *
 * The gateway workload calls this over the deployment-internal network
 * (compose network / localhost): GET /v1/plugin-routes returns the
 * reconcile loop's route snapshot; POST /v1/plugin-forward streams one
 * HTTP roundtrip through the routed plugin child. Both are guarded by a
 * shared internal bearer token (timing-safe compare) — this listener is
 * never exposed publicly (the plugin-host role owns no public listeners).
 *
 * Wire contract: request bodies and route responses are JSON; a successful
 * forward response carries the plugin's status in `x-mr-plugin-status`,
 * its header map base64-encoded in `x-mr-plugin-headers`, and the raw
 * response bytes streamed as the body. A failed forward returns 502 with
 * `{code, message, request_sent}`; `request_sent: true` tells the gateway
 * the outcome is uncertain and must NOT be replayed or failed over.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { PluginForwardRequestWire, PluginRouteSnapshotWire } from './protocol.js';
import { PluginTransportError } from './types.js';
import type { PluginManager } from './manager.js';

const MAX_FORWARD_BODY_BYTES = 16 * 1024 * 1024;

export interface PluginHostHttpServerOptions {
  readonly manager: PluginManager;
  readonly internalToken: string;
}

export interface PluginHostHttpServerHandle {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export function createPluginHostHttpServer(options: PluginHostHttpServerOptions): PluginHostHttpServerHandle {
  const internalToken = Buffer.from(options.internalToken, 'utf8');
  const server = createServer((req, res) => {
    void handleRequest(req, res, options.manager, internalToken).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'plugin-host request failed' }));
    });
  });
  const handle: PluginHostHttpServerHandle = {
    server,
    get port(): number {
      const address = server.address() as AddressInfo;
      return address.port;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
  return handle;
}

export function listenPluginHostHttpServer(
  handle: PluginHostHttpServerHandle,
  options: { bindAddress: string; port: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    handle.server.once('error', onError);
    handle.server.listen(options.port, options.bindAddress, () => {
      handle.server.off('error', onError);
      resolve();
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: PluginManager,
  internalToken: Buffer,
): Promise<void> {
  if (!authorized(req, internalToken)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'internal token missing or invalid' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/plugin-routes') {
    const routes: Record<string, PluginRouteSnapshotWire> = {};
    for (const [capability, snapshot] of manager.routesSnapshot()) {
      routes[capability] = {
        plugin_key: snapshot.pluginKey,
        rollout_percent: snapshot.rolloutPercent,
        available: snapshot.available,
        unavailable_reason: snapshot.unavailableReason,
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ routes }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/plugin-forward') {
    await handleForward(req, res, manager);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'unknown plugin-host route' }));
}

function authorized(req: IncomingMessage, internalToken: Buffer): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
  if (presented.length !== internalToken.length) return false;
  return timingSafeEqual(presented, internalToken);
}

function parseForwardWire(value: unknown): PluginForwardRequestWire | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.request_id !== 'string' || record.request_id.length === 0) return null;
  if (typeof record.capability !== 'string') return null;
  if (typeof record.method !== 'string' || record.method.length === 0) return null;
  if (typeof record.url !== 'string' || record.url.length === 0) return null;
  if (typeof record.body_base64 !== 'string' && record.body_base64 !== null) return null;
  const account = record.account;
  if (typeof account !== 'object' || account === null) return null;
  const accountRecord = account as Record<string, unknown>;
  if (typeof accountRecord.id !== 'string') return null;
  if (accountRecord.owner_kind !== 'tenant' && accountRecord.owner_kind !== 'platform') return null;
  if (accountRecord.owner_kind === 'tenant' && typeof accountRecord.tenant_id !== 'string') return null;
  if (typeof accountRecord.credential_id !== 'string' && accountRecord.credential_id !== null) return null;
  if (typeof accountRecord.credential_version !== 'number' || !Number.isInteger(accountRecord.credential_version)) {
    return null;
  }
  const headers = record.headers;
  if (typeof headers !== 'object' || headers === null) return null;
  for (const values of Object.values(headers as Record<string, unknown>)) {
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string')) return null;
  }
  return {
    request_id: record.request_id,
    capability: record.capability as PluginForwardRequestWire['capability'],
    method: record.method,
    url: record.url,
    headers: headers as Record<string, readonly string[]>,
    body_base64: typeof record.body_base64 === 'string' ? record.body_base64 : null,
    account: {
      id: accountRecord.id,
      owner_kind: accountRecord.owner_kind,
      tenant_id: typeof accountRecord.tenant_id === 'string' ? accountRecord.tenant_id : null,
      credential_id: typeof accountRecord.credential_id === 'string' ? accountRecord.credential_id : null,
      credential_version: accountRecord.credential_version,
    },
  };
}

async function handleForward(req: IncomingMessage, res: ServerResponse, manager: PluginManager): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'BODY_TOO_LARGE', message: 'forward body exceeds the limit' }));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'BAD_REQUEST', message: 'forward body is not valid JSON' }));
    return;
  }
  const wire = parseForwardWire(parsed);
  if (wire === null) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'BAD_REQUEST', message: 'forward body shape is invalid' }));
    return;
  }
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const result = await manager.forward(wire, controller.signal);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'x-mr-plugin-status': String(result.status),
      'x-mr-plugin-headers': Buffer.from(JSON.stringify(result.headers), 'utf8').toString('base64'),
    });
    if (result.body === null) {
      res.end();
      return;
    }
    const reader = result.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (streamError) {
      // Mid-stream plugin failure after the client already received headers:
      // terminate the transfer; the gateway maps this to an uncertain outcome.
      res.destroy(streamError instanceof Error ? streamError : new Error('plugin stream failed'));
    }
  } catch (error) {
    if (error instanceof PluginTransportError) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ code: error.code, message: error.message.slice(0, 512), request_sent: error.requestSent }),
      );
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 'PLUGIN_HOST_ERROR',
        message: (error instanceof Error ? error.message : 'forward failed').slice(0, 512),
        request_sent: false,
      }),
    );
  }
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FORWARD_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
