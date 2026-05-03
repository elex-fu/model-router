import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ConfigStore } from '../../src/config/store.js';
import { proxyHandler } from '../../src/server/proxy.js';
import { IpAuthBlocker } from '../../src/limit/ipBlocker.js';
import type { Config } from '../../src/config/types.js';
import type { LogEntry } from '../../src/logger/types.js';

async function startHarness(ipBlocker: IpAuthBlocker) {
  const tmpDir = path.join(os.tmpdir(), `mr-ipblock-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  const config: Config = {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        name: 'test',
        key: 'sk-test-12345',
        enabled: true,
        createdAt: '2026-05-02T00:00:00Z',
      },
    ],
    upstreams: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const logs: LogEntry[] = [];
  const enqueue = (entry: LogEntry): void => {
    logs.push(entry);
  };
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, enqueue, { ipBlocker }).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    logs,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          err ? reject(err) : resolve();
        })
      ),
  };
}

test('auth blocking: blocks IP after N failed auth attempts', async () => {
  const blocker = new IpAuthBlocker({ threshold: 3, windowMs: 60_000 });
  const h = await startHarness(blocker);
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${h.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
      assert.equal(res.status, 401);
    }
    const blocked = await fetch(`${h.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
  } finally {
    await h.close();
  }
});

test('auth blocking: blocked IP also rejected for valid keys (pre-auth gate)', async () => {
  const blocker = new IpAuthBlocker({ threshold: 2, windowMs: 60_000 });
  const h = await startHarness(blocker);
  try {
    for (let i = 0; i < 2; i++) {
      await fetch(`${h.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
    }
    // Even with the right key, IP is blocked
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    assert.equal(res.status, 429);
  } finally {
    await h.close();
  }
});

test('auth blocking: successful auth clears prior failures from same IP', async () => {
  const blocker = new IpAuthBlocker({ threshold: 3, windowMs: 60_000 });
  const h = await startHarness(blocker);
  try {
    // 2 failures (threshold is 3)
    for (let i = 0; i < 2; i++) {
      await fetch(`${h.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
    }
    // 1 success — would otherwise reach threshold next failure
    const ok = await fetch(`${h.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-unknown', messages: [] }),
    });
    // 404 because model not found, but auth succeeded — clears failures
    assert.equal(ok.status, 404);

    // Now 2 more failures should NOT trip blocking (clear succeeded)
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${h.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
      assert.equal(res.status, 401);
    }
  } finally {
    await h.close();
  }
});

test('auth blocking: 429 response is not logged (pre-auth gate)', async () => {
  const blocker = new IpAuthBlocker({ threshold: 1, windowMs: 60_000 });
  const h = await startHarness(blocker);
  try {
    // First failure: 401
    await fetch(`${h.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    // Subsequent: 429 (blocked)
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    assert.equal(res.status, 429);
    // Pre-auth blocking should not be logged (no key name to attribute to)
    // h.logs should be empty
    assert.equal(h.logs.length, 0);
  } finally {
    await h.close();
  }
});
