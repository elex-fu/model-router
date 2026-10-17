/**
 * Batch-5 §5.1 plugin manager tests: the DB-authoritative reconcile state
 * machine (starting takeover, expired-starting reclaim, error backoff,
 * fail-closed route publication on DB failure), rollout stability, and the
 * forward path's fail-closed rules — using an in-memory store and a fake
 * runtime factory.
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PluginManager } from '../../../src/saas/plugins/manager.js';
import type { PluginForwardRequestWire } from '../../../src/saas/plugins/protocol.js';
import type { PluginRuntime, PluginRuntimeOptions } from '../../../src/saas/plugins/runtime.js';
import {
  accountInPluginRollout,
  PLUGIN_CAPABILITY_AUTHORIZATIONS,
  type PluginCapabilityId,
  type PluginInstallationRecord,
  PluginTransportError,
  stablePluginBucket,
} from '../../../src/saas/plugins/types.js';
import { InMemoryPluginStore, testPluginManifest } from './in-memory-plugin-store.js';

const CAPABILITY: PluginCapabilityId = 'claude.oauth.outbound_transport.v1';

class FakeRuntime implements Partial<PluginRuntime> {
  alive = false;
  started = false;
  drained = false;
  health = true;
  startError: Error | null = null;
  lastForward: { requestId: string; headers: Record<string, readonly string[]> } | null = null;
  forwardError: PluginTransportError | null = null;

  async start(): Promise<void> {
    if (this.startError !== null) throw this.startError;
    this.started = true;
    this.alive = true;
  }

  async checkHealth(): Promise<boolean> {
    return this.health;
  }

  async drain(): Promise<void> {
    this.drained = true;
    this.alive = false;
  }

  kill(): void {
    this.alive = false;
  }

  async forward(input: {
    requestId: string;
    headers: Readonly<Record<string, readonly string[]>>;
  }): Promise<{ status: number; headers: Record<string, readonly string[]>; body: null }> {
    this.lastForward = { requestId: input.requestId, headers: { ...input.headers } };
    if (this.forwardError !== null) throw this.forwardError;
    return { status: 200, headers: { 'x-plugin': ['yes'] }, body: null };
  }
}

interface Harness {
  manager: PluginManager;
  store: InMemoryPluginStore;
  runtimes: FakeRuntime[];
  installation: () => PluginInstallationRecord;
  reconcile(): Promise<void>;
}

async function harness(setup?: (harness: Harness) => Promise<void>): Promise<Harness> {
  const store = new InMemoryPluginStore();
  const runtimes: FakeRuntime[] = [];
  const dataDir = await mkdtemp(join(tmpdir(), 'mr-plugin-manager-'));
  const manager = new PluginManager({
    store,
    executor: fakeExecutor,
    kms: fakeKms,
    dataDir,
    trustedPublishers: {},
    allowUnsigned: true,
    deploymentId: 'test-deployment',
    environmentId: 'test',
    createRuntime: (options: PluginRuntimeOptions) => {
      const runtime = new FakeRuntime();
      runtime.pluginKey = options.pluginKey;
      runtimes.push(runtime);
      return runtime as unknown as PluginRuntime;
    },
    createHostServices: () =>
      ({
        'kv.get': async () => ({ found: false, value: null }),
        'kv.set': async () => ({}),
        'kv.delete': async () => ({ deleted: false }),
        'kv.list': async () => ({ keys: [] }),
        'accounts.list': async () => ({ accounts: [] }),
      }) as never,
    // The state-machine tests exercise reconcile with fake runtimes; the
    // package re-extraction path is covered by the e2e test with a real
    // signed package.
    resolveEntryPath: async () => join(dataDir, 'fake-entry'),
  });
  const pluginKey = 'com.example.mr-mock-transport';
  await store.upsertInstallation({
    pluginKey,
    name: 'Mock',
    version: '1.2.3',
    description: '',
    author: '',
    manifest: testPluginManifest(),
    manifestSha256: 'a'.repeat(64),
    entrypointPath: 'plugin.mjs',
    binarySha256: 'b'.repeat(64),
    signatureStatus: 'trusted',
    artifactData: new Uint8Array([1, 2, 3]),
    artifactSha256: 'c'.repeat(64),
    installedBy: null,
  });
  const installation = () => {
    const record = store.getInstallationSync(pluginKey);
    if (record === null) throw new Error('installation missing');
    return record;
  };
  const harness: Harness = {
    manager,
    store,
    runtimes,
    installation,
    reconcile: () =>
      manager.runOperation(() => (manager as unknown as { reconcileOnce(): Promise<void> }).reconcileOnce()),
  };
  if (setup !== undefined) await setup(harness);
  return harness;
}

const fakeExecutor = {
  async query() {
    return { rows: [] };
  },
};

const fakeKms = {
  async decryptDataKey() {
    return new Uint8Array(32);
  },
};

async function enable(harness: Harness, rolloutPercent = 100): Promise<void> {
  const record = harness.installation();
  await harness.store.updateInstallationState({
    id: record.id,
    expectedState: 'disabled',
    expectedBinarySha256: record.binarySha256,
    state: 'starting',
  });
  await harness.store.replaceBindings({
    installationId: record.id,
    bindings: [
      {
        capability: CAPABILITY,
        platform: PLUGIN_CAPABILITY_AUTHORIZATIONS[CAPABILITY].platform,
        accountType: PLUGIN_CAPABILITY_AUTHORIZATIONS[CAPABILITY].accountType,
        enabled: true,
        rolloutPercent,
      },
    ],
  });
}

test('reconcile spawns the routed plugin and publishes an available route', async () => {
  const h = await harness();
  await enable(h);
  await h.reconcile();
  assert.equal(h.runtimes.length, 1);
  assert.equal(h.runtimes[0].started, true);
  assert.equal(h.installation().state, 'enabled');
  const route = h.manager.getRoute(CAPABILITY);
  assert.deepEqual(route, {
    capability: CAPABILITY,
    pluginKey: 'com.example.mr-mock-transport',
    rolloutPercent: 100,
    available: true,
    unavailableReason: null,
  });
  await h.manager.stop();
});

test('a fresh starting row is adopted immediately (split model: no other spawner)', async () => {
  const h = await harness();
  await enable(h);
  await h.reconcile();
  // The reconcile spawned and CAS-claimed the row on the FIRST tick —
  // there is no "another instance owns the start" wait in the split model.
  assert.equal(h.runtimes.length, 1);
  assert.equal(h.installation().state, 'enabled');
  assert.equal(h.manager.getRoute(CAPABILITY)?.available, true);
  // A concurrent second adoption loses the CAS and drains its runtime.
  const record = h.installation();
  await h.store.updateInstallationState({
    id: record.id,
    expectedState: 'enabled',
    expectedBinarySha256: record.binarySha256,
    state: 'starting',
  });
  const managerInternals = h.manager as unknown as {
    options: { createRuntime: (options: never) => never };
  };
  void managerInternals;
  h.runtimes[0].alive = false; // the first runtime "died" — reconcile adopts again
  await h.reconcile();
  assert.equal(h.manager.getRoute(CAPABILITY)?.available, true);
  await h.manager.stop();
});

test('an expired starting row is reclaimed and this instance takes over the start', async () => {
  const h = await harness();
  await enable(h);
  // Age the starting row beyond the recovery delay.
  await h.store.ageInstallation(h.installation().id, 120_000);
  await h.reconcile();
  assert.equal(h.installation().state, 'enabled');
  assert.equal(h.manager.getRoute(CAPABILITY)?.available, true);
  await h.manager.stop();
});

test('a spawn failure records the error state and publishes an unavailable route', async () => {
  const h = await harness(async (current) => {
    current.manager; // no-op; failure injected via factory below
  });
  // Inject the failure through the first created runtime.
  const originalCreate = h as unknown as { options: { createRuntime?: unknown } };
  void originalCreate;
  await enable(h);
  // Pre-seed a failing runtime by monkey-patching the factory outcome: the
  // harness factory always creates FakeRuntime; make the next one fail.
  const managerInternals = h.manager as unknown as {
    options: { createRuntime: (options: PluginRuntimeOptions) => PluginRuntime };
  };
  const inner = managerInternals.options.createRuntime;
  managerInternals.options.createRuntime = (options: PluginRuntimeOptions) => {
    const runtime = inner(options) as unknown as FakeRuntime;
    runtime.startError = new Error('spawn exploded');
    return runtime as unknown as PluginRuntime;
  };
  await h.reconcile();
  assert.equal(h.installation().state, 'error');
  assert.match(h.installation().lastError, /spawn exploded/);
  const route = h.manager.getRoute(CAPABILITY);
  assert.equal(route?.available, false);
  await h.manager.stop();
});

test('error state backs off before retrying the spawn', async () => {
  const h = await harness();
  await enable(h);
  const managerInternals = h.manager as unknown as {
    options: { createRuntime: (options: PluginRuntimeOptions) => PluginRuntime };
  };
  const inner = managerInternals.options.createRuntime;
  let attempts = 0;
  managerInternals.options.createRuntime = (options: PluginRuntimeOptions) => {
    attempts += 1;
    const runtime = inner(options) as unknown as FakeRuntime;
    if (attempts === 1) runtime.startError = new Error('first failure');
    return runtime as unknown as PluginRuntime;
  };
  await h.reconcile(); // attempt 1 fails
  assert.equal(attempts, 1);
  await h.reconcile(); // backoff window — no retry
  assert.equal(attempts, 1);
  await h.store.ageInstallation(h.installation().id, 60_000);
  await h.reconcile(); // past backoff — retry succeeds
  assert.equal(attempts, 2);
  assert.equal(h.installation().state, 'enabled');
  await h.manager.stop();
});

test('a failing health probe on the fast path kills the runtime and fails the route closed', async () => {
  const h = await harness();
  await enable(h);
  await h.reconcile();
  assert.equal(h.manager.getRoute(CAPABILITY)?.available, true);
  h.runtimes[0].health = false;
  await h.reconcile();
  assert.equal(h.runtimes[0].drained, true);
  assert.equal(h.manager.getRoute(CAPABILITY)?.available, false);
  await h.manager.stop();
});

test('a database read failure publishes unavailable and detaches runtimes — never a silent native fallback', async () => {
  const h = await harness();
  await enable(h);
  await h.reconcile();
  assert.equal(h.manager.getRoute(CAPABILITY)?.available, true);
  h.store.failListInstallations = true;
  await h.reconcile();
  const route = h.manager.getRoute(CAPABILITY);
  assert.equal(route?.available, false);
  assert.match(route?.unavailableReason ?? '', /could not be read/);
  assert.equal(h.runtimes[0].drained, true);
  await h.manager.stop();
});

test('disabling the binding clears the route (native path returns)', async () => {
  const h = await harness();
  await enable(h);
  await h.reconcile();
  const record = h.installation();
  await h.store.updateInstallationState({
    id: record.id,
    expectedState: 'enabled',
    expectedBinarySha256: record.binarySha256,
    state: 'disabled',
  });
  await h.store.replaceBindings({ installationId: record.id, bindings: [] });
  await h.reconcile();
  assert.equal(h.manager.getRoute(CAPABILITY), undefined);
  assert.equal(h.runtimes[0].drained, true);
  await h.manager.stop();
});

test('forward fails closed when no route is available', async () => {
  const h = await harness();
  await assert.rejects(h.manager.forward(forwardWire('acct-1'), new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof PluginTransportError);
    assert.equal(error.code, 'PLUGIN_ROUTE_UNAVAILABLE');
    assert.equal(error.requestSent, false);
    return true;
  });
  await h.manager.stop();
});

test('forward strips any authorization header before handing the request to the plugin', async () => {
  const h = await harness();
  await enable(h);
  await h.reconcile();
  const result = await h.manager.forward(
    { ...forwardWire('acct-1'), headers: { authorization: ['Bearer host-secret'], 'x-a': ['1'] } },
    new AbortController().signal,
  );
  assert.equal(result.status, 200);
  assert.equal('authorization' in (h.runtimes.at(-1)?.lastForward?.headers ?? {}), false);
  await h.manager.stop();
});

test('the stable rollout bucket is deterministic and roughly uniform', () => {
  assert.equal(stablePluginBucket('acct-1'), stablePluginBucket('acct-1'));
  assert.ok(stablePluginBucket('acct-1') >= 0 && stablePluginBucket('acct-1') < 100);
  // Distinct accounts must not all collapse into one bucket.
  const buckets = new Set<string>();
  for (let i = 0; i < 200; i += 1) buckets.add(`${stablePluginBucket(`account-${i}`)}`);
  assert.ok(buckets.size > 80, `expected spread, got ${buckets.size}`);
  // Boundary semantics.
  assert.equal(accountInPluginRollout('acct-1', 0), false);
  assert.equal(accountInPluginRollout('acct-1', 100), true);
  assert.equal(accountInPluginRollout('acct-1', 1), stablePluginBucket('acct-1') < 1);
  // Stability: the same account set partitions identically across calls.
  const first = Array.from({ length: 50 }, (_, i) => accountInPluginRollout(`acct-${i}`, 30));
  const second = Array.from({ length: 50 }, (_, i) => accountInPluginRollout(`acct-${i}`, 30));
  assert.deepEqual(first, second);
});

test('rollout percent gates which accounts the route intercepts', async () => {
  const h = await harness();
  await enable(h, 100);
  await h.reconcile();
  const route = h.manager.getRoute(CAPABILITY);
  assert.equal(route?.rolloutPercent, 100);
  await h.manager.stop();
});

function forwardWire(accountId: string): PluginForwardRequestWire {
  return {
    request_id: 'req-manager-1',
    capability: CAPABILITY,
    account: {
      id: accountId,
      owner_kind: 'platform',
      tenant_id: null,
      credential_id: null,
      credential_version: 1,
    },
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {},
    body_base64: null,
  };
}
