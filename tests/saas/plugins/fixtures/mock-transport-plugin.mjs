#!/usr/bin/env node
/**
 * Batch-5 §5.1 test mock plugin — the reference implementation of the
 * model-router plugin wire protocol (stdio JSON-RPC; see
 * src/saas/plugins/protocol.ts). It doubles as executable documentation:
 * a real transport plugin is exactly this shape.
 *
 * Behavior:
 * - handshake: echoes the SHA-256 of its own entrypoint (the TOCTOU gate)
 *   and an ephemeral X25519 public key; derives the same HKDF session key
 *   as the host;
 * - forward: decrypts the session-wrapped credential envelope (AAD =
 *   pluginKey\0requestId), injects `authorization: Bearer <token>` into the
 *   outbound headers, performs the upstream fetch, streams the response
 *   back frame by frame;
 * - reverse channel: writes every forwarded request id into the KV host
 *   service (`e2e` namespace) and lists it back — used by the e2e test to
 *   prove the plugin→host direction works;
 * - honors forward.abort and reports request_sent=false ONLY for failures
 *   proven to precede the upstream fetch.
 */

import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SESSION_HKDF_SALT = 'model-router-plugin-session:v1';

const PLUGIN_ID = 'com.example.mr-mock-transport';
const PLUGIN_VERSION = '1.2.3';

let hostSessionPublicKey = null;
let sessionKey = null;
let pluginKey = null;
let config = null;
const kvSeen = [];
const pendingBodies = new Map();
const abortedRequests = new Set();

// ---------------------------------------------------------------------------
// wire plumbing
// ---------------------------------------------------------------------------

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function callHostService(id, method, params) {
  write({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingHostCalls.set(id, { resolve, reject });
  });
}

const pendingHostCalls = new Map();
let nextHostCallId = 1;

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handleMessage(message);
  }
});

// ---------------------------------------------------------------------------
// session crypto (mirror of runtime.ts derivePluginSessionKey)
// ---------------------------------------------------------------------------

function deriveSession(hostPublicBase64, key) {
  const hostPublic = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(hostPublicBase64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey: sessionPrivateKey, publicKey: hostPublic });
  return Buffer.from(hkdfSync('sha256', shared, SESSION_HKDF_SALT, key, 32));
}

function unwrapCredential(envelope, key, requestId) {
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const aad = Buffer.from(`${key}\0${requestId}`, 'utf8');
  if (envelope.aad !== `${key}\0${requestId}`) throw new Error('credential envelope AAD mismatch');
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', deriveSession(hostSessionPublicKey, key), nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

let sessionPrivateKey = null;

// ---------------------------------------------------------------------------
// message dispatch
// ---------------------------------------------------------------------------

async function handleMessage(message) {
  if (message.jsonrpc !== '2.0') return;
  if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingHostCalls.get(message.id);
    if (pending !== undefined) {
      pendingHostCalls.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
    return;
  }
  if (typeof message.method !== 'string') return;
  const params = message.params ?? {};

  if (typeof message.id === 'number') {
    // host→plugin requests
    try {
      await handleRequest(message.id, message.method, params);
    } catch (error) {
      replyError(message.id, -32000, error instanceof Error ? error.message : 'plugin error');
    }
    return;
  }
  // host→plugin notifications (forward stream)
  await handleNotification(message.method, params);
}

async function handleRequest(id, method, params) {
  if (method === 'initialize') {
    if (process.env.MR_PLUGIN_MAGIC_COOKIE !== 'model-router-plugin-v1') {
      replyError(id, -32000, 'magic cookie missing');
      process.exit(1);
    }
    pluginKey = params.plugin_key;
    hostSessionPublicKey = params.host_session_public_key;
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    sessionPrivateKey = createPrivateKey({
      key: Buffer.concat([
        X25519_PKCS8_PREFIX,
        privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const entrypoint = await readFile(new URL(import.meta.url));
    reply(id, {
      protocol_version: 1,
      entrypoint_sha256: createHash('sha256').update(entrypoint).digest('hex'),
      session_public_key: Buffer.from(der.subarray(der.length - 32)).toString('base64'),
    });
    return;
  }
  if (method === 'getInfo') {
    reply(id, {
      plugin_id: PLUGIN_ID,
      plugin_version: PLUGIN_VERSION,
      protocol_version: 1,
      transport_api_version: 1,
    });
    return;
  }
  if (method === 'health') {
    reply(id, { healthy: true });
    return;
  }
  if (method === 'validateConfig') {
    const candidate = params.config_json;
    const valid =
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate.mock_upstream === undefined || typeof candidate.mock_upstream === 'string');
    reply(id, valid ? { valid: true, normalized_config_json: candidate } : { valid: false, message: 'bad config' });
    return;
  }
  if (method === 'applyConfig') {
    config = params.config_json;
    reply(id, { applied: true });
    return;
  }
  if (method === 'forward.begin') {
    const state = {
      requestId: params.request_id,
      headers: params.headers,
      method: params.method,
      url: params.url,
      account: params.account,
      credentialEnvelope: params.credential_envelope,
      body: [],
    };
    pendingBodies.set(params.request_id, state);
    // Reverse-channel proof: record the request in the KV host service.
    const callId = nextHostCallId++;
    try {
      const setResult = await callHostService(callId, 'kv.set', {
        namespace: 'e2e',
        key: 'last-request',
        value: params.request_id,
        ttl_seconds: null,
      });
      if (setResult === undefined) throw new Error('kv.set failed');
      const listId = nextHostCallId++;
      const listResult = await callHostService(listId, 'kv.list', {
        namespace: 'e2e',
        key_prefix: '',
        limit: null,
      });
      kvSeen.push(...(listResult?.keys ?? []));
    } catch {
      // The KV service is optional for forwarding; note and continue.
      kvSeen.push('kv-unavailable');
    }
    reply(id, { accepted: true });
    return;
  }
  replyError(id, -32601, `method not found: ${method}`);
}

async function handleNotification(method, params) {
  if (method === 'forward.body') {
    const state = pendingBodies.get(params.request_id);
    if (state !== undefined) state.body.push(Buffer.from(params.data, 'base64'));
    return;
  }
  if (method === 'forward.abort') {
    abortedRequests.add(params.request_id);
    return;
  }
  if (method === 'forward.end') {
    const state = pendingBodies.get(params.request_id);
    if (state === undefined) return;
    pendingBodies.delete(params.request_id);
    void runForward(state);
    return;
  }
}

async function runForward(state) {
  const { requestId } = state;
  let requestSent = false;
  try {
    const headers = { ...state.headers };
    if (state.credentialEnvelope !== null) {
      const token = unwrapCredential(state.credentialEnvelope, pluginKey, requestId);
      headers.authorization = `Bearer ${token.toString('utf8')}`;
      token.fill(0);
    }
    const body = state.body.length === 0 ? undefined : Buffer.concat(state.body);
    requestSent = true;
    const response = await fetch(state.url, {
      method: state.method,
      headers,
      body,
      redirect: 'manual',
    });
    const responseHeaders = {};
    for (const [name, value] of response.headers) {
      if (responseHeaders[name] === undefined) responseHeaders[name] = [value];
      else responseHeaders[name].push(value);
    }
    responseHeaders['x-mr-mock-plugin'] = ['true'];
    responseHeaders['x-mr-mock-kv'] = [kvSeen.join(',')];
    notify('response.start', { request_id: requestId, status: response.status, headers: responseHeaders });
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (abortedRequests.has(requestId)) {
          await reader.cancel();
          return;
        }
        notify('response.body', { request_id: requestId, data: Buffer.from(value).toString('base64') });
      }
    }
    if (abortedRequests.has(requestId)) return;
    notify('response.end', { request_id: requestId });
  } catch (error) {
    notify('response.error', {
      request_id: requestId,
      code: 'MOCK_UPSTREAM_ERROR',
      message: error instanceof Error ? error.message : 'forward failed',
      request_sent: requestSent,
    });
  }
}

process.stdin.resume();
