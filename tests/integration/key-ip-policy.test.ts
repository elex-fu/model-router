import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import type { LogEntry } from '../../src/logger/types.js';
import { proxyHandler } from '../../src/server/proxy.js';

/*
 * O3: key-level IP policy integration coverage. Requests originate from
 * 127.0.0.1, so the allowlist/denylist fixtures pin that address: the
 * X-Forwarded-For forgery case proves the socket address wins unless a
 * trusted proxy says otherwise.
 */

async function startProxy(config: Config): Promise<{ baseUrl: string; logs: LogEntry[]; close(): Promise<void> }> {
  const tmpDir = path.join(os.tmpdir(), `mr-keyip-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const logs: LogEntry[] = [];
  const enqueue = (entry: LogEntry): void => {
    logs.push(entry);
  };
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, enqueue, {}).catch((err) => {
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
    baseUrl: `http://127.0.0.1:${addr.port}`,
    logs,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          err ? reject(err) : resolve();
        }),
      ),
  };
}

function configWithKeyPolicy(ipPolicy: { ipAllowlist?: string[]; ipDenylist?: string[] }): Config {
  return {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        name: 'test',
        key: 'sk-test-12345',
        enabled: true,
        createdAt: '2026-05-02T00:00:00Z',
        ...ipPolicy,
      },
    ],
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
}

const REQUEST = {
  method: 'POST' as const,
  headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'custom-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
};

const PATH = '/v1/chat/completions';

test('a key without IP policy serves requests from loopback', async () => {
  const proxy = await startProxy(configWithKeyPolicy({}));
  try {
    const response = await fetch(`${proxy.baseUrl}${PATH}`, REQUEST);
    // Routing proceeds past auth (the unreachable upstream yields an error,
    // but 403 is what IP policy would have returned — any other status means
    // the policy was not applied).
    assert.notEqual(response.status, 403);
  } finally {
    await proxy.close();
  }
});

test('a denylist covering loopback rejects with 403 and a protocol error body', async () => {
  const proxy = await startProxy(configWithKeyPolicy({ ipDenylist: ['127.0.0.0/8'] }));
  try {
    const response = await fetch(`${proxy.baseUrl}${PATH}`, REQUEST);
    assert.equal(response.status, 403);
    const json: any = await response.json();
    assert.equal(json.error.type, 'forbidden');
    assert.equal(json.error.message, 'Proxy key is not allowed from this address');
  } finally {
    await proxy.close();
  }
});

test('an allowlist excluding loopback rejects with 403', async () => {
  const proxy = await startProxy(configWithKeyPolicy({ ipAllowlist: ['203.0.113.0/24'] }));
  try {
    const response = await fetch(`${proxy.baseUrl}${PATH}`, REQUEST);
    assert.equal(response.status, 403);
  } finally {
    await proxy.close();
  }
});

test('an allowlist containing loopback admits the request', async () => {
  const proxy = await startProxy(configWithKeyPolicy({ ipAllowlist: ['127.0.0.1'] }));
  try {
    const response = await fetch(`${proxy.baseUrl}${PATH}`, REQUEST);
    assert.notEqual(response.status, 403);
    assert.notEqual(response.status, 401);
  } finally {
    await proxy.close();
  }
});

test('a forged X-Forwarded-For header does not bypass the denylist without a trusted proxy', async () => {
  const proxy = await startProxy(configWithKeyPolicy({ ipDenylist: ['127.0.0.0/8'] }));
  try {
    const response = await fetch(`${proxy.baseUrl}${PATH}`, {
      ...REQUEST,
      headers: { ...REQUEST.headers, 'x-forwarded-for': '203.0.113.99' },
    });
    assert.equal(response.status, 403);
  } finally {
    await proxy.close();
  }
});

test('IP policy applies after authentication: an invalid key still yields 401, not 403', async () => {
  const proxy = await startProxy(configWithKeyPolicy({ ipDenylist: ['127.0.0.0/8'] }));
  try {
    const response = await fetch(`${proxy.baseUrl}${PATH}`, {
      ...REQUEST,
      headers: { ...REQUEST.headers, authorization: 'Bearer sk-wrong-key' },
    });
    assert.equal(response.status, 401);
  } finally {
    await proxy.close();
  }
});
