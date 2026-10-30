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
import { SessionAffinityStore } from '../../src/server/sticky-affinity.js';

/*
 * O2: session affinity integration — consecutive requests from one proxy key
 * for one model stick to the same upstream; when that upstream starts
 * failing, the mapping clears and traffic drifts to the other candidate.
 */

interface MockUpstream {
  baseUrl: string;
  hits: number;
  setFail(fail: boolean): void;
  close(): Promise<void>;
}

function startUpstream(): Promise<MockUpstream> {
  let fail = false;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (fail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: 123,
        model: 'custom-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        get hits() {
          return hits;
        },
        setFail(value: boolean) {
          fail = value;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function startProxy(
  config: Config,
  sessionAffinity?: SessionAffinityStore,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const tmpDir = path.join(os.tmpdir(), `mr-affinity-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, () => {}, sessionAffinity ? { sessionAffinity } : {}).catch((err) => {
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

function configFor(a: MockUpstream, b: MockUpstream): Config {
  const upstream = (name: string, mock: MockUpstream) => ({
    name,
    provider: 'custom',
    presetId: 'custom-openai',
    protocol: 'openai' as const,
    baseUrl: mock.baseUrl,
    endpoint: 'chat/completions',
    apiKeys: [],
    authMode: 'none' as const,
    models: ['custom-model'],
    enabled: true,
    priority: 0,
    sortIndex: name === 'up-a' ? 1 : 2,
  });
  return {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10, maxAttempts: 2 },
    proxyKeys: [{ name: 'test', key: 'sk-test-12345', enabled: true, createdAt: '2026-05-02T00:00:00Z' }],
    upstreams: [upstream('up-a', a), upstream('up-b', b)],
  };
}

const REQUEST = {
  method: 'POST' as const,
  headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'custom-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
};

test('stickiness pins consecutive requests to the first-serving upstream', async () => {
  const upA = await startUpstream();
  const upB = await startUpstream();
  const affinity = new SessionAffinityStore();
  const proxy = await startProxy(configFor(upA, upB), affinity);
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
      assert.equal(response.status, 200);
    }
    assert.equal(upA.hits, 3);
    assert.equal(upB.hits, 0);
    assert.equal(affinity.size(), 1);
  } finally {
    await proxy.close();
    await upA.close();
    await upB.close();
  }
});

test('stickiness drifts to the other upstream when the pinned one starts failing', async () => {
  const upA = await startUpstream();
  const upB = await startUpstream();
  const affinity = new SessionAffinityStore();
  const proxy = await startProxy(configFor(upA, upB), affinity);
  try {
    const first = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
    assert.equal(first.status, 200);
    assert.equal(upA.hits, 1);

    upA.setFail(true);
    // The sticky mapping is cleared on failure and the retry ladder serves
    // from up-b within the same request (maxAttempts 2).
    const second = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
    assert.equal(second.status, 200);
    assert.equal(upB.hits >= 1, true);
    // The failed mapping is gone; the next request re-pins to the surviving upstream.
    const third = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
    assert.equal(third.status, 200);
    const bHitsAfterThird = upB.hits;
    assert.equal(bHitsAfterThird >= 2, true);
    assert.equal(upA.hits, 2); // only the one failed attempt
  } finally {
    await proxy.close();
    await upA.close();
    await upB.close();
  }
});

test('without an affinity store, requests interleave across candidates (control)', async () => {
  const upA = await startUpstream();
  const upB = await startUpstream();
  const proxy = await startProxy(configFor(upA, upB), undefined);
  try {
    // sortIndex order is deterministic: every fresh request tries up-a first.
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, REQUEST);
      assert.equal(response.status, 200);
    }
    assert.equal(upA.hits, 2);
    assert.equal(upB.hits, 0);
  } finally {
    await proxy.close();
    await upA.close();
    await upB.close();
  }
});
