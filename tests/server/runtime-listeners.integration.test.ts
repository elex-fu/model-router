import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { reconcileObservedExternal } from '../../src/server/external-config-lifecycle.js';

const timeoutMs = 30_000;
const password = 'runtime-listener-admin-password';

test('external timezone reconciliation fails before journal finalization and runtime apply follows journaling', () => {
  const failedOrder: string[] = [];
  assert.throws(
    () =>
      reconcileObservedExternal(
        () => {
          failedOrder.push('schedule');
          throw new Error('schedule failed');
        },
        (afterJournal) => {
          failedOrder.push('journal');
          afterJournal();
        },
        () => failedOrder.push('replace'),
      ),
    /schedule failed/,
  );
  assert.deepEqual(failedOrder, ['schedule']);

  const retryOrder: string[] = [];
  reconcileObservedExternal(
    () => retryOrder.push('schedule'),
    (afterJournal) => {
      retryOrder.push('journal');
      afterJournal();
    },
    () => retryOrder.push('replace'),
  );
  assert.deepEqual(retryOrder, ['schedule', 'journal', 'replace']);
});

async function reserveEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function redactToken(value: string, token?: string): string {
  return token ? value.split(token).join('[REDACTED_BOOTSTRAP_TOKEN]') : value;
}

test('real CLI runtime reports listening proxy/admin sockets and safe database diagnostics', {
  timeout: timeoutMs,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-runtime-listeners-'));
  const configPath = join(dir, 'config.json');
  const proxyPort = await reserveEphemeralPort();
  let adminPort = await reserveEphemeralPort();
  while (adminPort === proxyPort) adminPort = await reserveEphemeralPort();
  const config = defaultConfigV2(configPath, 'runtime-listener-integration');
  config.server.port = proxyPort;
  config.server.bindAddress = '127.0.0.1';
  config.server.publicProxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
  config.admin.port = adminPort;
  config.admin.bindAddress = '127.0.0.1';
  config.admin.publicAdminBaseUrl = `http://127.0.0.1:${adminPort}`;
  config.storage.dataDir = dir;
  writeFileSync(configPath, JSON.stringify(config));

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'start', '--config', configPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stdout = '';
  let stderr = '';
  let bootstrapToken: string | undefined;
  let stopped = false;
  const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = chunk.toString();
    if (stream === 'stdout') stdout += text;
    else stderr += text;
    const tokenLine = /Admin bootstrap token \(local, expires in 15m\):\s*(\S+)/.exec(stdout);
    if (tokenLine) bootstrapToken = tokenLine[1];
  };
  child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
  const diagnostic = () => redactToken(`${stdout}\n${stderr}`, bootstrapToken);
  const stopChild = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const awaitExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, `server exited before ${label}: ${diagnostic()}`);
      if (predicate()) return;
      await delay(25);
    }
    assert.fail(`timed out waiting for ${label}: ${diagnostic()}`);
  };

  try {
    await waitFor(
      () =>
        stdout.includes(`model-router proxy listening on http://127.0.0.1:${proxyPort}`) &&
        stdout.includes(`model-router admin listening on http://127.0.0.1:${adminPort}/admin/`) &&
        Boolean(bootstrapToken),
      'both listeners and bootstrap token',
    );
    const proxyHealth = await fetch(`http://127.0.0.1:${proxyPort}/healthz`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(proxyHealth.status, 200, diagnostic());
    const bootstrapUrl = `http://127.0.0.1:${adminPort}/admin/api/v1/bootstrap`;
    const bootstrap = await fetch(bootstrapUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bootstrapToken, name: 'integration-admin', password }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(bootstrap.status, 201, diagnostic());
    const login = await fetch(`http://127.0.0.1:${adminPort}/admin/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'integration-admin', password }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(login.status, 200, diagnostic());
    const session = (await login.json()) as { data?: { csrfToken?: string } };
    assert.ok(session.data?.csrfToken);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const systemResponse = await fetch(`http://127.0.0.1:${adminPort}/admin/api/v1/system`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(systemResponse.status, 200, diagnostic());
    const payload = (await systemResponse.json()) as {
      data: {
        listeners: {
          proxy: { configured: { bindAddress: string; port: number }; actual: { bindAddress: string; port: number } };
          admin: { configured: { bindAddress: string; port: number }; actual: { bindAddress: string; port: number } };
        };
        databases: Record<
          string,
          {
            health: { status: string; scope: string; reason: string | null };
            capacity: { pageCount: number; pageSizeBytes: number; allocatedBytes: number; reason: string | null };
          }
        >;
      };
    };
    const system = payload.data;
    assert.deepEqual(system.listeners.proxy.configured, { bindAddress: '127.0.0.1', port: proxyPort });
    assert.deepEqual(system.listeners.proxy.actual, { bindAddress: '127.0.0.1', port: proxyPort });
    assert.deepEqual(system.listeners.admin.configured, { bindAddress: '127.0.0.1', port: adminPort });
    assert.deepEqual(system.listeners.admin.actual, { bindAddress: '127.0.0.1', port: adminPort });
    for (const [name, port] of [
      ['proxy', proxyPort],
      ['admin', adminPort],
    ] as const) {
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(port, '127.0.0.1', () => {
          socket.off('error', reject);
          resolve();
        });
      }).then(
        async () => {
          await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
          assert.fail(`${name} port ${port} was reported actual but is no longer occupied by the server`);
        },
        (error) =>
          assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE', `${name} port must have a live listener`),
      );
    }
    assert.deepEqual(Object.keys(system.databases).sort(), ['control', 'telemetry']);
    for (const database of [system.databases.control, system.databases.telemetry]) {
      assert.deepEqual(database.health, { status: 'available', scope: 'connection', reason: null });
      assert.ok(database.capacity.pageCount > 0);
      assert.ok(database.capacity.pageSizeBytes > 0);
      assert.ok(database.capacity.allocatedBytes > 0);
      assert.equal(database.capacity.reason, null);
    }
    const serialized = JSON.stringify(system);
    assert.equal(serialized.includes(dir), false);
    assert.equal(serialized.includes(configPath), false);
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes(bootstrapToken), false);
    await stopChild();
    const exit = await awaitExit;
    assert.equal(exit.code, 0, `server shutdown failed (${exit.signal ?? 'no signal'}): ${diagnostic()}`);
  } catch (error) {
    await stopChild();
    const safeDiagnostic = diagnostic();
    if (error instanceof Error)
      error.message = `${error.message}\nChild logs (bootstrap token redacted):\n${safeDiagnostic}`;
    throw error;
  } finally {
    await stopChild();
    rmSync(dir, { recursive: true, force: true });
  }
});
