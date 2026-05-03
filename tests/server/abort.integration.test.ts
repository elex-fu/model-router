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

interface HangingUpstream {
  baseUrl: string;
  sawClose(): boolean;
  close(): Promise<void>;
}

async function startHangingUpstream(opts: { sendHeaders?: boolean } = {}): Promise<HangingUpstream> {
  let sawClose = false;
  const server = http.createServer((req, res) => {
    req.on('close', () => {
      sawClose = true;
    });
    if (opts.sendHeaders) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    }
    // never end
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sawClose: () => sawClose,
    close: () => new Promise<void>((resolve) => {
      (server as any).closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface ProxyHarness {
  baseUrl: string;
  close(): Promise<void>;
}

async function startProxy(
  upstreamUrl: string,
  opts: { streamIdleTimeoutMs?: number } = {}
): Promise<ProxyHarness> {
  const tmpDir = path.join(os.tmpdir(), `mr-abort-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  const config: Config = {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      { name: 'test', key: 'sk-test', enabled: true, createdAt: '2026-05-02T00:00:00Z' },
    ],
    upstreams: [
      {
        name: 'mock',
        provider: 'mock',
        protocol: 'anthropic',
        baseUrl: upstreamUrl,
        apiKeys: ['x'],
        models: ['claude'],
        enabled: true,
      },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, () => {}, opts).catch(() => {
      if (!res.headersSent) {
        try {
          res.writeHead(500);
          res.end();
        } catch {}
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve();
        })
      ),
  };
}

test('abort: client disconnect propagates to upstream', { timeout: 10000 }, async () => {
  const upstream = await startHangingUpstream();
  const proxy = await startProxy(upstream.baseUrl);
  try {
    const ctl = new AbortController();
    const fetchP = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [] }),
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort(), 100);
    await fetchP.catch(() => {});
    // give upstream time to observe TCP close
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(upstream.sawClose(), true, 'upstream should observe client disconnect');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('abort: SSE idle timeout closes stalled stream', { timeout: 10000 }, async () => {
  const upstream = await startHangingUpstream({ sendHeaders: true });
  const proxy = await startProxy(upstream.baseUrl, { streamIdleTimeoutMs: 200 });
  try {
    const start = Date.now();
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
    });
    const reader = res.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected stream to close fast, got ${elapsed}ms`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
