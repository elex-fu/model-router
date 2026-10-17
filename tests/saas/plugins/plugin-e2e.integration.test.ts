/**
 * Batch-5 §5.1 MVP acceptance: the mock plugin walks the FULL chain —
 * install (signed .mrplugin package → verification → DB row) → enable
 * (DB-authoritative state) → reconcile (package re-verified + extracted +
 * real child spawned + handshake) → forward through the real plugin-host
 * HTTP surface (reverse KV channel included) → drain — with a real mock
 * plugin child process and a real mock upstream.
 */

import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { writeZip } from '../../../src/saas/plugins/package/zip.js';
import { PluginAdminService } from '../../../src/saas/plugins/admin-service.js';
import { PluginManager } from '../../../src/saas/plugins/manager.js';
import { createPluginHostServices } from '../../../src/saas/plugins/host-services.js';
import { createPluginHostHttpServer, listenPluginHostHttpServer } from '../../../src/saas/plugins/plugin-host-server.js';
import { PluginHostClient } from '../../../src/saas/plugins/gateway-plugin-router.js';
import { InMemoryPluginStore } from './in-memory-plugin-store.js';

const CAPABILITY = 'claude.oauth.outbound_transport.v1';
const INTERNAL_TOKEN = 'e2e-internal-token-0123456789abcdef';

function ed25519RawPublicKey(publicKey: { export(options: { format: 'der'; type: 'spki' }): Buffer }): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

async function buildMockPluginPackage(): Promise<{
  packageBytes: Buffer;
  trustedPublishers: { [keyId: string]: string };
}> {
  const fixture = await readFile(new URL('./fixtures/mock-transport-plugin.mjs', import.meta.url).pathname);
  const pluginSha256 = createHash('sha256').update(fixture).digest('hex');
  const manifest = {
    schema_version: 1,
    id: 'com.example.mr-mock-transport',
    name: 'Mock Transport Plugin',
    version: '1.2.3',
    description: 'e2e fixture',
    author: 'test',
    requires: { model_router: '>=0.1.0', plugin_protocol: 1, transport_api: 1 },
    capabilities: [{ id: CAPABILITY }],
    entrypoint: 'plugin.mjs',
    files: { 'plugin.mjs': pluginSha256 },
  };
  const manifestRaw = Buffer.from(JSON.stringify(manifest, null, 2));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = ed25519Sign(null, manifestRaw, privateKey);
  const signatureRaw = Buffer.from(
    JSON.stringify({
      algorithm: 'ed25519',
      key_id: 'e2e-test-publisher',
      signature: signature.toString('base64'),
    }),
  );
  const packageBytes = writeZip([
    { name: 'manifest.json', data: manifestRaw },
    { name: 'signature.json', data: signatureRaw },
    { name: 'plugin.mjs', data: fixture },
  ]);
  return { packageBytes, trustedPublishers: { 'e2e-test-publisher': ed25519RawPublicKey(publicKey) } };
}

test('mock plugin walks install → enable → forward → drain end to end', async () => {
  const store = new InMemoryPluginStore();
  const { packageBytes, trustedPublishers } = await buildMockPluginPackage();
  const dataDir = await mkdtemp(join(tmpdir(), 'mr-plugin-e2e-'));

  // --- install (control plane: verify + persist, no spawn) ---
  const admin = new PluginAdminService({ store, trustedPublishers, allowUnsigned: false });
  const installed = await admin.install(packageBytes, null);
  assert.equal(installed.state, 'disabled');
  assert.equal(installed.signatureStatus, 'trusted');
  assert.equal(installed.pluginKey, 'com.example.mr-mock-transport');

  // re-upload of the same signed package while disabled is an idempotent replace
  const reinstalled = await admin.install(packageBytes, null);
  assert.equal(reinstalled.state, 'disabled');

  // --- enable (DB-authoritative transition) ---
  const enabling = await admin.enable('com.example.mr-mock-transport', 100);
  assert.equal(enabling.state, 'starting');
  const bindings = await store.listBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].capability, CAPABILITY);
  assert.equal(bindings[0].enabled, true);
  assert.equal(bindings[0].rolloutPercent, 100);

  // --- reconcile (plugin-host: re-verify package, extract, spawn, CAS healthy) ---
  const fakeExecutor = { async query() { return { rows: [] }; } };
  const kms = { async decryptDataKey() { return new Uint8Array(32); } };
  const kvPort = {
    store,
    async get(pluginKey: string, namespace: string, key: string) {
      return store.kvGet(pluginKey, namespace, key);
    },
    async set(pluginKey: string, namespace: string, key: string, value: string, expiresAt: Date | null) {
      await store.kvSet(pluginKey, namespace, key, value, expiresAt === null ? null : 60);
    },
    async delete(pluginKey: string, namespace: string, key: string) {
      return store.kvDelete(pluginKey, namespace, key);
    },
    async list(pluginKey: string, namespace: string, keyPrefix: string, limit: number) {
      return store.kvList(pluginKey, namespace, keyPrefix, limit);
    },
  };
  const manager = new PluginManager({
    store,
    executor: fakeExecutor,
    kms,
    dataDir,
    trustedPublishers,
    allowUnsigned: false,
    deploymentId: 'e2e-deployment',
    environmentId: 'test',
    createHostServices: (pluginKey) =>
      createPluginHostServices({
        pluginKey,
        kv: kvPort,
        accounts: { async list() { return []; } },
      }),
  });
  await manager.start();
  assert.equal(manager.getRoute(CAPABILITY)?.available, true);
  assert.equal(store.getInstallationSync('com.example.mr-mock-transport')?.state, 'enabled');

  // --- forward through the real plugin-host HTTP surface ---
  const upstream = await startMockUpstream();
  const handle = createPluginHostHttpServer({ manager, internalToken: INTERNAL_TOKEN });
  await listenPluginHostHttpServer(handle, { bindAddress: '127.0.0.1', port: 0 });
  const client = new PluginHostClient({ baseUrl: `http://127.0.0.1:${handle.port}`, internalToken: INTERNAL_TOKEN });

  const routes = await client.routeSnapshot();
  assert.equal(routes?.[CAPABILITY]?.available, true);

  const forwardResult = await client.forward(
    {
      request_id: 'e2e-req-1',
      capability: CAPABILITY,
      account: { id: 'acct-e2e', owner_kind: 'platform', tenant_id: null, credential_id: null, credential_version: 1 },
      method: 'POST',
      url: upstream.url,
      headers: { 'content-type': ['application/json'] },
      body_base64: Buffer.from(JSON.stringify({ hello: 'plugin' })).toString('base64'),
    },
    new AbortController().signal,
  );
  assert.equal(forwardResult.status, 200);
  assert.deepEqual(forwardResult.headers['x-mr-mock-plugin'], ['true']);
  const text = await readStream(forwardResult.body as ReadableStream<Uint8Array>);
  assert.equal(JSON.parse(text).echo, 'upstream-ok');
  // The plugin reached the mock upstream with our body and headers.
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].body, JSON.stringify({ hello: 'plugin' }));
  // The reverse KV channel recorded the request through the manager wiring.
  assert.deepEqual(forwardResult.headers['x-mr-mock-kv'], ['last-request']);
  const kvEntry = await store.kvGet('com.example.mr-mock-transport', 'e2e', 'last-request');
  assert.equal(kvEntry?.value, 'e2e-req-1');

  // --- drain (disable + stop drains the child cleanly) ---
  await admin.disable('com.example.mr-mock-transport');
  await manager.stop();
  await handle.close();
  await upstream.close();
  assert.equal(manager.getRoute(CAPABILITY), undefined);
  assert.equal(store.getInstallationSync('com.example.mr-mock-transport')?.state, 'disabled');
});

function startMockUpstream(): Promise<{
  url: string;
  received: { body?: string; headers: Record<string, string | string[] | undefined> }[];
  close(): Promise<void>;
}> {
  const received: { body?: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: 'upstream-ok' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/messages`,
        received,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
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
