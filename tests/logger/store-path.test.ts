import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { logStoreFromConfig } from '../../src/logger/store.js';

test('custom config uses its own data directory for logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-log-path-'));
  try {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, storage: { dataDir: 'local-data' } }));
    fs.mkdirSync(path.join(dir, 'local-data'));
    const store = await logStoreFromConfig(configPath);
    await store.close?.();
    assert.equal(fs.existsSync(path.join(dir, 'local-data', 'logs.sqlite')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
