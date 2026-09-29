import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { proxyHandler } from '../../src/server/proxy.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('three attempts: one reported, two missing retain only two attempt bounds across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-missing-quota-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  let store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    let ledger = new SQLiteQuotaLedger(store);
    const now = Date.now();
    const period = {
      proxyKeyId: 'key',
      periodId: 'current',
      periodStartMs: now - 1000,
      periodEndMs: now + 60_000,
      atMs: now,
      reserveTokens: 50,
      dailyTokens: 160,
      maxConcurrentRequests: 1,
      missingUsagePolicy: 'retain-reservation' as const,
    };
    assert.equal((await ledger.admit({ ...period, requestId: 'three' })).allowed, true);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) assert.equal((await ledger.topUp('three', 50, 160)).allowed, true);
      await ledger.markAttemptSent('three');
    }
    assert.equal((await ledger.topUp('three', 11, 160)).reason, 'daily_tokens_exceeded');
    await ledger.settle('three', 17, 2);
    assert.deepEqual(await ledger.balance('key', 'current'), {
      reportedUsed: 17,
      estimatedUsed: 0,
      reserved: 100,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
    await store.close();
    store = new SQLiteTelemetryStore(dbPath);
    await store.init();
    ledger = new SQLiteQuotaLedger(store);
    assert.equal(await ledger.recoverInterrupted(), 0);
    assert.equal((await ledger.balance('key', 'current')).reserved, 100);
    assert.equal((await ledger.admit({ ...period, requestId: 'next', reserveTokens: 43 })).allowed, true);
    assert.equal(
      (await ledger.admit({ ...period, requestId: 'blocked', reserveTokens: 1 })).reason,
      'concurrency_exceeded',
    );
    await ledger.settle('next', null, 0);
    assert.equal(
      (await ledger.admit({ ...period, requestId: 'over', reserveTokens: 44 })).reason,
      'daily_tokens_exceeded',
    );
    const future = {
      ...period,
      periodId: 'next-period',
      periodStartMs: now + 60_000,
      periodEndMs: now + 120_000,
      atMs: now + 60_001,
    };
    assert.equal((await ledger.admit({ ...future, requestId: 'future' })).allowed, true);
    assert.deepEqual(await ledger.balance('key', 'current'), {
      reportedUsed: 17,
      estimatedUsed: 100,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 1,
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proxy retry path tops up each attempt and preserves two missing usages alongside one failed usage report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-proxy-quota-'));
  const store = new SQLiteTelemetryStore(path.join(dir, 'logs.sqlite'));
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    if ((calls - 1) % 3 < 2) {
      res.statusCode = 503;
      res.end(
        JSON.stringify(
          calls % 3 === 2
            ? { error: { message: 'retry' }, usage: { prompt_tokens: 7, completion_tokens: 10 } }
            : { error: { message: 'retry' } },
        ),
      );
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }
  });
  const listen = (server: http.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
  let proxy: http.Server | undefined;
  try {
    await store.init();
    const ledger = new SQLiteQuotaLedger(store);
    const upstreamPort = await listen(upstream);
    const config: Config = {
      server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10, maxRetries: 3 },
      proxyKeys: [
        {
          id: 'key',
          name: 'key',
          key: '',
          keyHash: createHash('sha256').update('sk-test').digest('hex'),
          enabled: true,
          createdAt: '2026-01-01T00:00:00Z',
          dailyTokens: 210,
        },
      ],
      upstreams: [
        {
          id: 'up',
          name: 'up',
          provider: 'custom',
          protocol: 'openai',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          endpoint: 'chat/completions',
          apiKeys: ['one', 'two', 'three'],
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
    proxy = http.createServer((req, res) => {
      void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, {
        telemetryStore: store,
        quotaLedger: ledger,
        quotaReserveTokens: 50,
        missingUsagePolicy: 'retain-reservation',
        maxRetries: 3,
      }).catch((error) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 3);
    const period = store.connection.prepare('SELECT period_id FROM quota_periods WHERE proxy_key_id=?').get('key') as {
      period_id: string;
    };
    assert.deepEqual(await ledger.balance('key', period.period_id), {
      reportedUsed: 17,
      estimatedUsed: 0,
      reserved: 100,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
    const deniedRetry = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(deniedRetry.status, 429);
    assert.equal(calls, 4);
  } finally {
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release policy records known failed-attempt usage and explicitly releases unknown bound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-release-quota-'));
  const store = new SQLiteTelemetryStore(path.join(dir, 'logs.sqlite'));
  try {
    await store.init();
    const ledger = new SQLiteQuotaLedger(store);
    const now = Date.now();
    const period = {
      proxyKeyId: 'key',
      periodId: 'today',
      periodStartMs: now - 1000,
      periodEndMs: now + 60_000,
      atMs: now,
      reserveTokens: 40,
      dailyTokens: 100,
      missingUsagePolicy: 'release-reservation' as const,
    };
    assert.equal((await ledger.admit({ ...period, requestId: 'partial' })).allowed, true);
    await ledger.markAttemptSent('partial');
    assert.equal((await ledger.topUp('partial', 40, 100, 90)).reason, 'daily_tokens_exceeded');
    assert.equal((await ledger.topUp('partial', 40, 100, 9)).allowed, true);
    await ledger.markAttemptSent('partial');
    await ledger.settle('partial', 9, 1);
    assert.deepEqual(await ledger.balance('key', 'today'), {
      reportedUsed: 9,
      estimatedUsed: 0,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
    const row = store.connection
      .prepare('SELECT state, settled_tokens FROM quota_reservations WHERE request_id=?')
      .get('partial') as { state: string; settled_tokens: number };
    assert.deepEqual(row, { state: 'released_unknown', settled_tokens: 9 });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart retains only sent unknown attempt reserve and releases an unsent top-up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-recover-quota-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  let store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    let ledger = new SQLiteQuotaLedger(store);
    const now = Date.now();
    const period = {
      proxyKeyId: 'key',
      periodId: 'today',
      periodStartMs: now - 1000,
      periodEndMs: now + 60_000,
      atMs: now,
      reserveTokens: 30,
      missingUsagePolicy: 'retain-reservation' as const,
    };
    assert.equal((await ledger.admit({ ...period, requestId: 'interrupted' })).allowed, true);
    await ledger.markAttemptSent('interrupted');
    assert.equal((await ledger.topUp('interrupted', 30)).allowed, true);
    await store.close();
    store = new SQLiteTelemetryStore(dbPath);
    await store.init();
    ledger = new SQLiteQuotaLedger(store);
    assert.equal(await ledger.recoverInterrupted(), 1);
    assert.deepEqual(await ledger.balance('key', 'today'), {
      reportedUsed: 0,
      estimatedUsed: 0,
      reserved: 30,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
