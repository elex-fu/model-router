import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { startServer } from '../../src/server/index.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('startup bind failure closes telemetry worker and stores while preserving original error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-startup-cleanup-'));
  const configPath = path.join(dir, 'config.json');
  const occupied = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address && typeof address === 'object');
  const config = defaultConfigV2(configPath, 'startup-cleanup-test');
  config.admin.enabled = false;
  config.server.port = address.port;
  config.server.publicProxyBaseUrl = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const dbPath = path.join(dir, 'logs.sqlite');
  try {
    await assert.rejects(
      startServer(undefined, configPath),
      (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
    );
    const reopened = new SQLiteTelemetryStore(dbPath);
    await reopened.init();
    await reopened.close();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
