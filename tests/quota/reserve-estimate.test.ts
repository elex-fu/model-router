import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { DEFAULT_OUTPUT_RESERVE_TOKENS, estimateQuotaAttemptReserve } from '../../src/quota/estimate.js';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { proxyHandler } from '../../src/server/proxy.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('estimate includes JSON input and explicit or default output for both protocol parameters', () => {
  assert.equal(estimateQuotaAttemptReserve(Buffer.alloc(0), null), DEFAULT_OUTPUT_RESERVE_TOKENS);
  const body = Buffer.from(JSON.stringify({ messages: [{ content: 'hello' }] }));
  assert.equal(estimateQuotaAttemptReserve(body, {}), body.length + DEFAULT_OUTPUT_RESERVE_TOKENS);
  assert.equal(estimateQuotaAttemptReserve(body, { max_tokens: 25 }), body.length + 25);
  assert.equal(estimateQuotaAttemptReserve(body, { max_output_tokens: 40 }), body.length + 40);
  assert.equal(estimateQuotaAttemptReserve(body, { max_tokens: 25, max_output_tokens: 40 }), body.length + 40);
  assert.equal(estimateQuotaAttemptReserve(body, { max_output_tokens: 40 }, 7), 7);
  const unicode = Buffer.from(JSON.stringify({ input: '汉字😀'.repeat(10_000) }));
  const reserve = estimateQuotaAttemptReserve(unicode, { max_output_tokens: 1 });
  assert.ok(reserve >= Math.ceil(unicode.length / 2) + 1);
  assert.ok(reserve > 30_000);
});

function config(baseUrl: string, dailyTokens: number): Config {
  return {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10, maxRetries: 2 },
    proxyKeys: [
      {
        id: 'key',
        name: 'key',
        key: '',
        keyHash: createHash('sha256').update('sk-test').digest('hex'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        dailyTokens,
      },
    ],
    upstreams: [
      {
        id: 'up',
        name: 'up',
        provider: 'custom',
        protocol: 'openai',
        baseUrl,
        endpoint: 'chat/completions',
        apiKeys: ['first', 'second'],
        models: ['real'],
        enabled: true,
      },
    ],
    routes: [
      {
        id: 'route',
        name: 'route',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'public' },
        order: 0,
        publishedModels: ['public'],
        targets: [{ upstreamId: 'up', model: 'real' }],
      },
    ],
  };
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

test('proxy rejects an under-budget request before outbound; override is reused on retry top-up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-reserve-estimate-'));
  const store = new SQLiteTelemetryStore(path.join(dir, 'logs.sqlite'));
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    if (calls === 1) {
      res.statusCode = 503;
      res.end('{"error":{"message":"retry"}}');
    } else res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  let proxy: http.Server | undefined;
  try {
    await store.init();
    const upstreamPort = await listen(upstream);
    const runtime = config(`http://127.0.0.1:${upstreamPort}/v1`, 30);
    const ledger = new SQLiteQuotaLedger(store);
    let useOverride = false;
    const reserved: number[] = [];
    proxy = http.createServer((req, res) => {
      const quotaLedger = useOverride
        ? ({
            admit: async (admission: { reserveTokens: number }) => {
              reserved.push(admission.reserveTokens);
              return { allowed: true };
            },
            topUp: async (_id: string, extra: number) => {
              reserved.push(extra);
              return { allowed: true };
            },
            markAttemptSent: async () => {},
            settle: async () => {},
          } as any)
        : ledger;
      void proxyHandler(req, res, { load: () => runtime } as ConfigStore, () => {}, {
        quotaLedger,
        quotaReserveTokens: useOverride ? 7 : undefined,
        maxRetries: 2,
      }).catch((error) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
    });
    const proxyPort = await listen(proxy);
    const post = () =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'public',
          messages: [{ role: 'user', content: '汉字😀'.repeat(100) }],
          max_output_tokens: 2,
        }),
      });
    assert.equal((await post()).status, 429);
    assert.equal(calls, 0);
    useOverride = true;
    assert.equal((await post()).status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(reserved, [7, 7]);
  } finally {
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
