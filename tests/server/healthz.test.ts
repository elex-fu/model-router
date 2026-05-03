import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ConfigStore } from '../../src/config/store.js';
import { proxyHandler } from '../../src/server/proxy.js';
import type { Config } from '../../src/config/types.js';
import type { LogEntry } from '../../src/logger/types.js';

interface HarnessOptions {
  healthCheck?: () => Promise<boolean>;
}

async function startHarness(options: HarnessOptions = {}) {
  const tmpDir = path.join(os.tmpdir(), `mr-health-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  const config: Config = {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [],
    upstreams: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const logs: LogEntry[] = [];
  const enqueue = (entry: LogEntry): void => {
    logs.push(entry);
  };
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, enqueue, options).catch((err) => {
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

test('healthz: GET /healthz returns 200 with status ok and no auth required', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.status, 'ok');
    // health pings should not be logged as request_logs entries
    assert.equal(h.logs.length, 0);
  } finally {
    await h.close();
  }
});

test('healthz: returns 200 even if no proxy keys configured', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});

test('healthz: 503 when healthCheck callback throws', async () => {
  const h = await startHarness({
    healthCheck: async () => {
      throw new Error('db unreachable');
    },
  });
  try {
    const res = await fetch(`${h.baseUrl}/healthz`);
    assert.equal(res.status, 503);
    const body: any = await res.json();
    assert.equal(body.status, 'degraded');
  } finally {
    await h.close();
  }
});

test('healthz: 503 when healthCheck callback returns false', async () => {
  const h = await startHarness({
    healthCheck: async () => false,
  });
  try {
    const res = await fetch(`${h.baseUrl}/healthz`);
    assert.equal(res.status, 503);
  } finally {
    await h.close();
  }
});

test('healthz: 200 reports db ok when healthCheck returns true', async () => {
  const h = await startHarness({
    healthCheck: async () => true,
  });
  try {
    const res = await fetch(`${h.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db, 'ok');
  } finally {
    await h.close();
  }
});

test('healthz: POST /healthz returns 405 method not allowed', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/healthz`, { method: 'POST' });
    assert.equal(res.status, 405);
  } finally {
    await h.close();
  }
});

test('healthz: HEAD /healthz returns 200 without body', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/healthz`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});
