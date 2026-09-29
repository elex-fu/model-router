import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ResponseOwnershipStore } from '../../src/storage/response-ownership.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('response ownership binds key and upstream across store instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-response-owner-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  try {
    const telemetry = new SQLiteTelemetryStore(dbPath);
    await telemetry.init();
    const owners = new ResponseOwnershipStore(telemetry);
    owners.put({
      responseId: 'resp_a',
      proxyKeyId: 'key_a',
      upstreamId: 'up_a',
      credentialId: 'cred_a',
      expiresAtMs: Date.now() + 60_000,
    });
    assert.equal(owners.get('resp_a', 'key_b'), null);
    assert.equal(owners.get('resp_a', 'key_a')?.credentialId, 'cred_a');
    await telemetry.close();
    const reopened = new SQLiteTelemetryStore(dbPath);
    await reopened.init();
    assert.equal(new ResponseOwnershipStore(reopened).get('resp_a', 'key_a')?.upstreamId, 'up_a');
    await reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
