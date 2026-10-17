/**
 * Batch-5 §5.1 gateway plugin routing tests: the PreparedEvidenceTransport
 * decorator's decision table — native passthrough (no binding / outside the
 * rollout bucket), fail-closed 502 (binding + bucketed + plugin not
 * serving), full forward with usage observation, and the request_sent
 * rethrow rule — against a REAL plugin-host HTTP server + client pair.
 */

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  PluginHostClient,
  PluginRoutingClaudeTransport,
  type EnabledPluginBinding,
  type PluginRouteReader,
} from '../../../src/saas/plugins/gateway-plugin-router.js';
import { createPluginHostHttpServer, listenPluginHostHttpServer } from '../../../src/saas/plugins/plugin-host-server.js';
import type { PluginRouteSnapshot } from '../../../src/saas/plugins/types.js';
import { PluginTransportError, accountInPluginRollout, stablePluginBucket } from '../../../src/saas/plugins/types.js';

const CAPABILITY = 'claude.oauth.outbound_transport.v1';
const PLUGIN_KEY = 'com.example.mr-mock-transport';
const INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef';

interface StubManager {
  routesSnapshot(): Map<string, PluginRouteSnapshot>;
  forward(): never;
}

function startPluginHost(stub: {
  routes: Record<string, PluginRouteSnapshot>;
  forwardImpl?: (wire: unknown) => Promise<{
    status: number;
    headers: Record<string, readonly string[]>;
    body: ReadableStream<Uint8Array> | null;
  }>;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const manager = {
    routesSnapshot() {
      return new Map(Object.entries(stub.routes));
    },
    async forward(wire: unknown) {
      if (stub.forwardImpl === undefined) throw new Error('forward not stubbed');
      return stub.forwardImpl(wire);
    },
  };
  const handle = createPluginHostHttpServer({
    manager: manager as unknown as Parameters<typeof createPluginHostHttpServer>[0]['manager'],
    internalToken: INTERNAL_TOKEN,
  });
  return listenPluginHostHttpServer(handle, { bindAddress: '127.0.0.1', port: 0 }).then(() => ({
    baseUrl: `http://127.0.0.1:${handle.port}`,
    close: handle.close,
  }));
}

function routeReader(binding: EnabledPluginBinding | null): PluginRouteReader {
  return {
    async enabledBinding(capability) {
      return binding === null || binding.capability !== capability ? null : binding;
    },
  };
}

function transportInput(accountId: string): PreparedEvidenceTransportRequest {
  const payload = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }));
  const evidence = {
    requestId: 'req-router-1',
    attemptId: 'attempt-1',
    accountId,
    accountOwnerKind: 'platform',
    tenantId: '00000000-0000-0000-0000-000000000000',
    credentialId: 'cred-1',
    credentialVersion: '1',
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    endpoint: 'claude-messages',
    status: 'claimed',
    claimedAttemptId: 'attempt-1',
  } as unknown as PreparedRequestEvidenceRecord;
  return {
    tenantId: evidence.tenantId,
    projectId: 'project-1',
    requestId: evidence.requestId,
    attemptId: evidence.attemptId,
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes: payload,
    evidence,
  };
}

test('no enabled binding → native passthrough', async () => {
  const host = await startPluginHost({ routes: {} });
  const inner = {
    calls: 0,
    transport: {
      async send(): Promise<PreparedEvidenceTransportResponse> {
        inner.calls += 1;
        return { responseStarted: false, resultHttpStatus: 200, headers: {}, body: null, providerUsage: null };
      },
    },
  };
  const router = new PluginRoutingClaudeTransport({
    inner: inner.transport,
    capability: CAPABILITY,
    routeReader: routeReader(null),
    pluginHostClient: new PluginHostClient({ baseUrl: host.baseUrl, internalToken: INTERNAL_TOKEN }),
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  const result = await router.send(transportInput('acct-any'));
  assert.equal(result.resultHttpStatus, 200);
  assert.equal(inner.calls, 1);
  await host.close();
});

test('enabled binding + account outside the rollout bucket → native passthrough', async () => {
  // Find an account that is NOT in a 1% rollout.
  let outsideAccount = 'acct-outside';
  for (let i = 0; i < 500; i += 1) {
    const candidate = `acct-outside-${i}`;
    if (!accountInPluginRollout(candidate, 1)) {
      outsideAccount = candidate;
      break;
    }
  }
  const host = await startPluginHost({
    routes: { [CAPABILITY]: snapshot(true, 1) },
  });
  const inner = {
    calls: 0,
    transport: {
      async send(): Promise<PreparedEvidenceTransportResponse> {
        inner.calls += 1;
        return { responseStarted: false, resultHttpStatus: 200, headers: {}, body: null, providerUsage: null };
      },
    },
  };
  const router = new PluginRoutingClaudeTransport({
    inner: inner.transport,
    capability: CAPABILITY,
    routeReader: routeReader({ capability: CAPABILITY, pluginKey: PLUGIN_KEY, rolloutPercent: 1 }),
    pluginHostClient: new PluginHostClient({ baseUrl: host.baseUrl, internalToken: INTERNAL_TOKEN }),
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  const result = await router.send(transportInput(outsideAccount));
  assert.equal(result.resultHttpStatus, 200);
  assert.equal(inner.calls, 1);
  await host.close();
});

test('bucketed account + available route → forwarded through the plugin-host', async () => {
  let forwarded = 0;
  const host = await startPluginHost({
    routes: { [CAPABILITY]: snapshot(true, 100) },
    forwardImpl: (wire) => {
      forwarded += 1;
      void wire;
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': ['text/event-stream'], 'x-plugin': ['served'] },
        body: sseStream(),
      });
    },
  });
  const inner = {
    calls: 0,
    transport: {
      async send(): Promise<PreparedEvidenceTransportResponse> {
        inner.calls += 1;
        return { responseStarted: false, resultHttpStatus: 200, headers: {}, body: null, providerUsage: null };
      },
    },
  };
  const router = new PluginRoutingClaudeTransport({
    inner: inner.transport,
    capability: CAPABILITY,
    routeReader: routeReader({ capability: CAPABILITY, pluginKey: PLUGIN_KEY, rolloutPercent: 100 }),
    pluginHostClient: new PluginHostClient({ baseUrl: host.baseUrl, internalToken: INTERNAL_TOKEN }),
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  const result = await router.send(transportInput('acct-inside'));
  assert.equal(inner.calls, 0);
  assert.equal(forwarded, 1);
  assert.equal(result.resultHttpStatus, 200);
  assert.equal(result.headers['x-plugin'], 'served');
  assert.ok(result.body !== null);
  const text = await readStream(result.body);
  assert.ok(text.includes('message_start'));
  // The same MessagesUsageWatcher as the native path observed the usage.
  assert.ok(result.providerUsage !== null);
  assert.ok((result.providerUsage as { outputTotal: number }).outputTotal > 0);
  await host.close();
});

test('bucketed account + unavailable route → fail-closed 502, never the native path', async () => {
  const host = await startPluginHost({
    routes: { [CAPABILITY]: snapshot(false, 100) },
  });
  const inner = {
    calls: 0,
    transport: {
      async send(): Promise<PreparedEvidenceTransportResponse> {
        inner.calls += 1;
        return { responseStarted: false, resultHttpStatus: 200, headers: {}, body: null, providerUsage: null };
      },
    },
  };
  const router = new PluginRoutingClaudeTransport({
    inner: inner.transport,
    capability: CAPABILITY,
    routeReader: routeReader({ capability: CAPABILITY, pluginKey: PLUGIN_KEY, rolloutPercent: 100 }),
    pluginHostClient: new PluginHostClient({ baseUrl: host.baseUrl, internalToken: INTERNAL_TOKEN }),
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  const result = await router.send(transportInput('acct-inside'));
  assert.equal(result.resultHttpStatus, 502);
  assert.equal(result.upstreamErrorKind, 'plugin_route_unavailable');
  assert.equal(inner.calls, 0);
  await host.close();
});

test('plugin-host unreachable → fail-closed 502 for bucketed accounts', async () => {
  // Reserve a port then close it: nothing listens there.
  const throwaway = createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, '127.0.0.1', resolve));
  const deadPort = (throwaway.address() as AddressInfo).port;
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));

  const inner = {
    calls: 0,
    transport: {
      async send(): Promise<PreparedEvidenceTransportResponse> {
        inner.calls += 1;
        return { responseStarted: false, resultHttpStatus: 200, headers: {}, body: null, providerUsage: null };
      },
    },
  };
  const router = new PluginRoutingClaudeTransport({
    inner: inner.transport,
    capability: CAPABILITY,
    routeReader: routeReader({ capability: CAPABILITY, pluginKey: PLUGIN_KEY, rolloutPercent: 100 }),
    pluginHostClient: new PluginHostClient({
      baseUrl: `http://127.0.0.1:${deadPort}`,
      internalToken: INTERNAL_TOKEN,
    }),
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  const result = await router.send(transportInput('acct-inside'));
  assert.equal(result.resultHttpStatus, 502);
  assert.equal(result.upstreamErrorKind, 'plugin_route_unavailable');
  assert.equal(inner.calls, 0);
});

test('a request_sent=true plugin failure is rethrown (unknown outcome, no replay)', async () => {
  const host = await startPluginHost({
    routes: { [CAPABILITY]: snapshot(true, 100) },
    forwardImpl: () => Promise.reject(new PluginTransportError('PLUGIN_STREAM_FAILED', 'mid-stream', true)),
  });
  const inner = {
    calls: 0,
    transport: {
      async send(): Promise<PreparedEvidenceTransportResponse> {
        inner.calls += 1;
        return { responseStarted: false, resultHttpStatus: 200, headers: {}, body: null, providerUsage: null };
      },
    },
  };
  const router = new PluginRoutingClaudeTransport({
    inner: inner.transport,
    capability: CAPABILITY,
    routeReader: routeReader({ capability: CAPABILITY, pluginKey: PLUGIN_KEY, rolloutPercent: 100 }),
    pluginHostClient: new PluginHostClient({ baseUrl: host.baseUrl, internalToken: INTERNAL_TOKEN }),
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  await assert.rejects(router.send(transportInput('acct-inside')), (error: unknown) => {
    assert.ok(error instanceof PluginTransportError);
    assert.equal(error.requestSent, true);
    return true;
  });
  await host.close();
});

test('the plugin-host rejects requests without the internal token', async () => {
  const host = await startPluginHost({ routes: {} });
  const response = await fetch(`${host.baseUrl}/v1/plugin-routes`);
  assert.equal(response.status, 401);
  await host.close();
});

function snapshot(available: boolean, rolloutPercent: number): PluginRouteSnapshot {
  return {
    capability: CAPABILITY,
    pluginKey: PLUGIN_KEY,
    rolloutPercent,
    available,
    unavailableReason: available ? null : 'plugin health check failed',
  };
}

function sseStream(): ReadableStream<Uint8Array> {
  const body =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
