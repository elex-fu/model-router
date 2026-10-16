#!/usr/bin/env node
// mock-upstream.mjs — programmable HTTPS mock provider for the R9 bench/chaos
// suite (scripts/ops/bench-gateway.mjs, scripts/ops/chaos-gateway.mjs).
//
// Two listeners:
//   :8443  (TLS)   provider traffic from the model-router gateway. TLS is
//                   mandatory: the gateway's provider HTTP transport
//                   (src/saas/gateway/provider-http-transport.ts) hard-requires
//                   https:// targets, so the bench CA/cert must be trusted by
//                   the gateway containers (NODE_EXTRA_CA_CERTS in
//                   bench-compose.override.yml).
//   :8080  (plain)  control plane for the bench drivers (no TLS needed there;
//                   keep it on the compose network / loopback only).
//
// Provider surface (protocol selected by path, matching what an operator
// gateway-runtime module would route to):
//   POST /v1/chat/completions   OpenAI shape (stream + non-stream)
//   POST /v1/messages           Anthropic shape (stream + non-stream)
//   POST /oauth/token           OAuth client-credentials token mint (for the
//                               token-expiry race scenario)
//   GET  /healthz
//
// Control surface (plain-HTTP listener):
//   GET  /__control/stats             per-account in-flight/status/stream stats
//   POST /__control/reset             clear faults, delay, shape, stats
//   POST /__control/shape             { chunks, chunkDelayMs, content }
//   POST /__control/delay             { ms } (first-byte delay, default 0)
//   POST /__control/faults            { accounts, mode, status, afterChunks, durationMs }
//   POST /__control/rotate-token      invalidate the current bearer (401 invalid_grant after)
//
// Fault modes:
//   none            (clear)
//   status          respond immediately with `status` and a protocol-shaped error body
//   abort-after     stream `afterChunks` SSE chunks, then destroy the socket
//                   (mid-stream failure injection)
//   invalid-grant   respond 401 with an invalid_grant marker body
//
// SSE integrity encoding: every streamed JSON data payload carries `bench_seq`
// (0-based, strictly +1 per chunk) and `bench_stream_id`; the terminal marker
// is `data: [DONE]` (OpenAI) or an Anthropic `message_stop` event. The bench
// client validates seq continuity to detect corruption. Extra fields are inert
// to protocol parsers; the gateway forwards SSE bytes untouched.
//
// No secrets: TLS key material is operator-generated on the bench host (see
// deploy/compose/BENCH.md) and mounted from ./bench/certs/, never committed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const TLS_CERT = process.env.MOCK_TLS_CERT ?? '/bench-certs/mock-cert.pem';
const TLS_KEY = process.env.MOCK_TLS_KEY ?? '/bench-key/mock-key.pem';
const PROVIDER_PORT = Number(process.env.MOCK_PORT ?? 8443);
const CONTROL_PORT = Number(process.env.MOCK_CONTROL_PORT ?? 8080);
const MAX_BODY_BYTES = 1 << 20;

// ── Mutable bench state (control-plane owned) ────────────────────────────────
const shape = { chunks: 32, chunkDelayMs: 0, content: 'bench-chunk' };
let firstByteDelayMs = 0;

/** @type {Map<string, {expiresAt: number, mode: string, status: number, afterChunks: number}>} */
const accountFaults = new Map(); // account token -> active fault
let globalFault = null;

// Bearer lifecycle for the token-expiry scenario. `currentToken` is what
// /oauth/token mints; every other bearer gets 401 invalid_grant only while a
// fault demands it (rotate-token flips `rotatedAt` and marks the old token).
let currentToken = `bench-token-${Date.now().toString(36)}`;
const retiredTokens = new Set();

// ── Per-account stats ────────────────────────────────────────────────────────
const stats = {
  startedAt: Date.now(),
  accounts: new Map(), // token -> record
  tokenEndpoint: { requests: 0, byGrant: {} },
};

function accountRecord(token) {
  let rec = stats.accounts.get(token);
  if (!rec) {
    rec = {
      requests: 0,
      byStatus: {},
      currentInFlight: 0,
      maxInFlight: 0,
      streams: 0,
      sseChunks: 0,
      abortedStreams: 0,
      lastRequestAt: 0,
    };
    stats.accounts.set(token, rec);
  }
  return rec;
}

function accountOf(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '(anonymous)';
  const match = /^Bearer[ \t]+([^ \t\r\n]+)$/i.exec(header.trim());
  return match ? match[1] : '(anonymous)';
}

function activeFault(token) {
  const now = Date.now();
  for (const fault of [accountFaults.get(token), globalFault]) {
    if (!fault) continue;
    if (fault.expiresAt !== 0 && fault.expiresAt < now) continue;
    return fault;
  }
  return null;
}

function snapshotStats() {
  const accounts = {};
  for (const [token, rec] of stats.accounts) {
    accounts[token] = { ...rec, byStatus: { ...rec.byStatus } };
  }
  return {
    uptimeMs: Date.now() - stats.startedAt,
    currentTokenIssued: stats.tokenEndpoint.requests > 0,
    tokenEndpoint: { ...stats.tokenEndpoint },
    accounts,
    shape: { ...shape },
    firstByteDelayMs,
    faults: {
      global: globalFault ? { ...globalFault } : null,
      perAccount: [...accountFaults.entries()].map(([token, fault]) => ({ account: token, ...fault })),
    },
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Provider responses ───────────────────────────────────────────────────────
function errorBody(protocol, status, marker) {
  if (protocol === 'anthropic') {
    return { type: 'error', error: { type: 'api_error', message: `${marker} (mock ${status})` } };
  }
  return { error: { message: `${marker} (mock ${status})`, type: 'mock_error', code: status } };
}

function openaiChunk(id, model, seq, streamId, content) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    bench_seq: seq,
    bench_stream_id: streamId,
    choices: [{ index: 0, delta: seq === 0 ? { role: 'assistant', content } : { content }, finish_reason: null }],
  };
}

function anthropicDelta(seq, streamId, content) {
  return {
    type: 'content_block_delta',
    index: 0,
    bench_seq: seq,
    bench_stream_id: streamId,
    delta: { type: 'text_delta', text: content },
  };
}

async function handleProviderRequest(req, res) {
  const token = accountOf(req);
  const rec = accountRecord(token);
  const url = new URL(req.url ?? '/', 'https://mock-upstream');
  const protocol = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptimeMs: Date.now() - stats.startedAt });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    stats.tokenEndpoint.requests += 1;
    const body = parseJson(await readBody(req));
    const grant = typeof body.grant_type === 'string' ? body.grant_type : '(missing)';
    stats.tokenEndpoint.byGrant[grant] = (stats.tokenEndpoint.byGrant[grant] ?? 0) + 1;
    sendJson(res, 200, { access_token: currentToken, token_type: 'Bearer', expires_in: 3600 });
    return;
  }

  if (req.method !== 'POST' || (url.pathname !== '/v1/chat/completions' && url.pathname !== '/v1/messages')) {
    sendJson(res, 404, { error: { message: `mock: unsupported ${req.method} ${url.pathname}` } });
    return;
  }

  rec.requests += 1;
  rec.lastRequestAt = Date.now();
  rec.currentInFlight += 1;
  if (rec.currentInFlight > rec.maxInFlight) rec.maxInFlight = rec.currentInFlight;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      rec.currentInFlight -= 1;
    }
  };
  res.on('close', release);
  req.on('aborted', release);

  const body = parseJson(await readBody(req));
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'bench-model';
  const streaming = body.stream === true;
  const fault = activeFault(token);

  // Retired bearer (token-expiry race): hard 401 invalid_grant regardless of
  // the fault plan, so the gateway's refresh path is exercised.
  if (retiredTokens.has(token)) {
    rec.byStatus[401] = (rec.byStatus[401] ?? 0) + 1;
    sendJson(res, 401, errorBody(protocol, 401, 'invalid_grant'));
    return;
  }

  if (fault && fault.mode === 'status') {
    rec.byStatus[fault.status] = (rec.byStatus[fault.status] ?? 0) + 1;
    sendJson(res, fault.status, errorBody(protocol, fault.status, 'injected'));
    return;
  }
  if (fault && fault.mode === 'invalid-grant') {
    rec.byStatus[401] = (rec.byStatus[401] ?? 0) + 1;
    sendJson(res, 401, errorBody(protocol, 401, 'invalid_grant'));
    return;
  }

  if (firstByteDelayMs > 0) await sleep(firstByteDelayMs);

  const id = `bench-${createHash('sha256').update(`${token}:${rec.requests}`).digest('hex').slice(0, 12)}`;
  const streamId = `str-${id}`;

  if (!streaming) {
    const text = `${shape.content} x${shape.chunks} (seq 0..${shape.chunks - 1})`;
    rec.byStatus[200] = (rec.byStatus[200] ?? 0) + 1;
    if (protocol === 'anthropic') {
      sendJson(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model,
        bench_stream_id: streamId,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: shape.chunks },
      });
    } else {
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        bench_stream_id: streamId,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: shape.chunks, total_tokens: 8 + shape.chunks },
      });
    }
    return;
  }

  // Streaming: SSE with bench_seq continuity, optional per-chunk delay, and
  // mid-stream abort injection after `afterChunks` chunks.
  rec.streams += 1;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (protocol === 'anthropic') {
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', bench_stream_id: streamId, message: { id, model } })}\n\n`);
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`);
  }

  const abortAfter = fault && fault.mode === 'abort-after' ? fault.afterChunks : -1;
  for (let seq = 0; seq < shape.chunks; seq += 1) {
    if (chunkAbortSignal(req, res)) return; // client/gateway went away
    const payload =
      protocol === 'anthropic'
        ? anthropicDelta(seq, streamId, shape.content)
        : openaiChunk(id, model, seq, streamId, shape.content);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    rec.sseChunks += 1;
    if (abortAfter >= 0 && seq + 1 >= abortAfter) {
      rec.abortedStreams += 1;
      rec.byStatus[200] = (rec.byStatus[200] ?? 0) + 1; // headers were 200; abort is mid-stream
      // Give the socket a beat to flush the chunks we already wrote before
      // tearing it down (res.destroy() discards unflushed writes).
      await sleep(20);
      res.destroy();
      return;
    }
    if (shape.chunkDelayMs > 0) await sleep(shape.chunkDelayMs);
  }

  rec.byStatus[200] = (rec.byStatus[200] ?? 0) + 1;
  if (protocol === 'anthropic') {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`);
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  } else {
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

// Client/gateway disconnect detection. NOTE: req.destroyed is unusable here —
// once the (TLS) request body has been consumed across an await boundary it
// reads as destroyed while the connection is perfectly alive. Response-side
// flags only.
function chunkAbortSignal(req, res) {
  void req;
  return res.destroyed || res.writableEnded;
}

// ── Control plane ─────────────────────────────────────────────────────────────
async function handleControlRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://mock-upstream-control');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/__control/stats') {
    sendJson(res, 200, snapshotStats());
    return;
  }
  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'unsupported' });
    return;
  }

  const body = parseJson(await readBody(req));

  if (path === '/__control/reset') {
    accountFaults.clear();
    globalFault = null;
    firstByteDelayMs = 0;
    shape.chunks = 32;
    shape.chunkDelayMs = 0;
    shape.content = 'bench-chunk';
    retiredTokens.clear();
    stats.accounts.clear();
    stats.tokenEndpoint = { requests: 0, byGrant: {} };
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/__control/shape') {
    if (Number.isSafeInteger(body.chunks) && body.chunks >= 0 && body.chunks <= 100_000) shape.chunks = body.chunks;
    if (Number.isSafeInteger(body.chunkDelayMs) && body.chunkDelayMs >= 0 && body.chunkDelayMs <= 60_000) {
      shape.chunkDelayMs = body.chunkDelayMs;
    }
    if (typeof body.content === 'string' && body.content.length <= 256) shape.content = body.content;
    sendJson(res, 200, { ok: true, shape: { ...shape } });
    return;
  }

  if (path === '/__control/delay') {
    if (Number.isSafeInteger(body.ms) && body.ms >= 0 && body.ms <= 60_000) firstByteDelayMs = body.ms;
    sendJson(res, 200, { ok: true, firstByteDelayMs });
    return;
  }

  if (path === '/__control/faults') {
    const mode = body.mode ?? 'none';
    if (!['none', 'status', 'abort-after', 'invalid-grant'].includes(mode)) {
      sendJson(res, 400, { error: `unknown mode ${mode}` });
      return;
    }
    const durationMs = Number.isSafeInteger(body.durationMs) && body.durationMs > 0 ? body.durationMs : 0;
    const expiresAt = durationMs > 0 ? Date.now() + durationMs : 0;
    const fault = {
      mode: mode === 'none' ? 'none' : mode,
      status: Number.isSafeInteger(body.status) ? body.status : 429,
      afterChunks: Number.isSafeInteger(body.afterChunks) && body.afterChunks >= 0 ? body.afterChunks : 3,
      expiresAt,
    };
    const accounts = Array.isArray(body.accounts) ? body.accounts.filter((a) => typeof a === 'string') : [];
    if (accounts.length > 0) {
      for (const account of accounts) {
        if (mode === 'none') accountFaults.delete(account);
        else accountFaults.set(account, { ...fault });
      }
    } else if (mode === 'none') {
      globalFault = null;
      accountFaults.clear();
    } else {
      globalFault = { ...fault };
    }
    sendJson(res, 200, { ok: true, snapshot: snapshotStats().faults });
    return;
  }

  if (path === '/__control/rotate-token') {
    retiredTokens.add(currentToken);
    currentToken = `bench-token-${Date.now().toString(36)}`;
    sendJson(res, 200, { ok: true, retired: retiredTokens.size });
    return;
  }

  sendJson(res, 404, { error: `unknown control path ${path}` });
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
let tls;
try {
  tls = { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) };
} catch (error) {
  console.error(`mock-upstream: cannot read TLS material (${TLS_CERT} / ${TLS_KEY}): ${error.message}`);
  console.error('Generate bench certs first — see deploy/compose/BENCH.md ("Bench certificates").');
  process.exit(1);
}

const provider = https.createServer(tls, (req, res) => {
  handleProviderRequest(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: 'mock internal error' });
    else res.destroy();
  });
});
provider.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

const control = http.createServer((req, res) => {
  handleControlRequest(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: 'mock control error' });
    else res.destroy();
  });
});

provider.listen(PROVIDER_PORT, '0.0.0.0', () => {
  console.log(`mock-upstream provider (TLS): https://0.0.0.0:${PROVIDER_PORT}`);
});
control.listen(CONTROL_PORT, '0.0.0.0', () => {
  console.log(`mock-upstream control (plain HTTP): http://0.0.0.0:${CONTROL_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    provider.close();
    control.close();
    process.exit(0);
  });
}
