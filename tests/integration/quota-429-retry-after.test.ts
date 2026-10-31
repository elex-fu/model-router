import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { proxyHandler } from '../../src/server/proxy.js';

/*
 * Quota-ledger 429s must carry a Retry-After header (mirroring the in-memory
 * limiter and IP-blocker paths) so API-shaped clients back off instead of
 * hammering the ledger admission transaction. Found by the 2026-10-30 classic
 * baseline: 3037/3500 requests were concurrency 429s with no retry hint.
 */

async function startProxy(quotaLedger: object): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const tmpDir = path.join(os.tmpdir(), `mr-quota429-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  const config: Config = {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [{ name: 'test', key: 'sk-test-12345', enabled: true, createdAt: '2026-05-02T00:00:00Z' }],
    upstreams: [
      {
        name: 'unused',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9',
        apiKeys: [],
        authMode: 'none',
        models: ['custom-model'],
        enabled: true,
      },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, () => {}, { quotaLedger: quotaLedger as never }).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          err ? reject(err) : resolve();
        }),
      ),
  };
}

const REQUEST = {
  method: 'POST' as const,
  headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'custom-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
};

function rejectingLedger(reason: string, retryAfterMs?: number) {
  return {
    admit: async () => ({ allowed: false, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }),
    markAttemptSent: async () => {},
    settle: async () => {},
  };
}

test('quota concurrency 429 carries Retry-After from the ledger decision', async () => {
  const proxy = await startProxy(rejectingLedger('concurrency_exceeded', 1_000));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '1');
    const json: any = await response.json();
    assert.equal(json.error.type, 'rate_limit_exceeded');
    assert.equal(json.error.message, 'Concurrent request limit exceeded');
  } finally {
    await proxy.close();
  }
});

test('quota 429 without a ledger hint falls back to a 60s Retry-After', async () => {
  const proxy = await startProxy(rejectingLedger('rpm_exceeded'));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    const json: any = await response.json();
    assert.equal(json.error.message, 'Requests per minute limit exceeded');
  } finally {
    await proxy.close();
  }
});

test('quota rpm 429 surfaces the ledger-computed window hint', async () => {
  const proxy = await startProxy(rejectingLedger('rpm_exceeded', 90_000));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '90');
  } finally {
    await proxy.close();
  }
});
