import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createAdminServer, type AdminAdapters } from '../../src/admin/server.js';
import { telemetryAdapters } from '../../src/admin/telemetry.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const outcome of ['success', 'failure'] as const) {
  test(`admin close drains a disconnected telemetry handler through ${outcome}`, { timeout: 30_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mr-admin-shutdown-'));
    const telemetry = new SQLiteTelemetryStore(join(directory, 'telemetry.sqlite'));
    await telemetry.init();
    const entered = signal();
    const release = signal();
    const settled = signal();
    let handlerEntered = false;
    let readSummary!: NonNullable<AdminAdapters['usageSummary']>;
    let readCompleted = false;
    let closeCompleted = false;
    let closePromise: Promise<void> | undefined;
    const app = createAdminServer({
      configPath: join(directory, 'config.json'),
      telemetryStore: telemetry,
      adapters: {
        usageSummary: async (input) => {
          handlerEntered = true;
          entered.resolve();
          try {
            await release.promise;
            // Start a real read worker after the socket is gone. The owner must
            // drain the whole handler, including work started after disconnect.
            const value = await readSummary(input);
            assert.equal(app.store.db.open, true);
            assert.equal(telemetry.connection.open, true);
            readCompleted = true;
            if (outcome === 'failure') throw new Error('Intentional adapter failure after read');
            return value;
          } finally {
            settled.resolve();
          }
        },
      },
    });
    readSummary = telemetryAdapters(telemetry, app.control).usageSummary!;
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      app.store.createAdmin('admin', 'shutdown-test-password');
      const login = app.store.login('admin', 'shutdown-test-password', 60);
      assert.ok(login);
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address();
      assert.ok(address && typeof address !== 'string');
      client = httpRequest(`http://127.0.0.1:${address.port}/admin/api/v1/usage/summary`, {
        headers: { cookie: `mr_admin_session=${login.token}` },
        agent: false,
      });
      // Intentional disconnect below normally emits ECONNRESET.
      client.on('error', () => {});
      client.end();
      await entered.promise;
      const clientClosed = new Promise<void>((resolve) => client!.once('close', resolve));
      client.destroy();
      await clientClosed;

      const listenerClosed = once(app.server, 'close');
      closePromise = app.close();
      void closePromise.then(() => { closeCompleted = true; }, () => {});
      await listenerClosed;
      // Flush close callbacks/microtasks, rather than relying on a timed delay.
      await setImmediate();
      assert.equal(closeCompleted, false, 'HTTP shutdown must not finish the application drain');
      assert.equal(app.store.db.open, true, 'the handler still owns access to the control store');
      assert.equal(telemetry.connection.open, true);

      release.resolve();
      await closePromise;
      assert.equal(readCompleted, true, 'close waits for worker exit and response assembly, including failure');
      assert.equal(app.store.db.open, false);
    } finally {
      release.resolve();
      client?.destroy();
      // Also drain explicitly on assertion failure, so a regressed implementation
      // cannot make this test remove the database under its own reader.
      if (handlerEntered) await settled.promise;
      await (closePromise ?? app.close());
      await telemetry.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
