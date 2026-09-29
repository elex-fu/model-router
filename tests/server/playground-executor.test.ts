import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { createPlaygroundExecutor } from '../../src/server/playground-executor.js';
import { proxyHandler } from '../../src/server/proxy.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function fixture(url: string) {
  const config = {
    revision: 7,
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10, maxRetries: 2 },
    proxyKeys: [
      {
        id: 'key_1',
        name: 'test',
        key: '',
        keyHash: 'one-way-hash',
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        dailyTokens: 1000,
        rpm: 10,
      },
    ],
    upstreams: [
      {
        id: 'up_1',
        name: 'up_1',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: url,
        endpoint: 'chat/completions',
        authMode: 'none',
        apiKeys: [],
        models: ['actual-model'],
        enabled: true,
      },
    ],
    routes: [
      {
        id: 'route_1',
        name: 'route',
        enabled: true,
        clientProtocols: ['openai', 'anthropic'],
        match: { kind: 'exact', value: 'public-model' },
        order: 0,
        publishedModels: ['public-model'],
        targets: [{ upstreamId: 'up_1', model: 'actual-model' }],
      },
    ],
  } as unknown as Config;
  const requests: RequestRecord[] = [];
  const attempts: AttemptRecord[] = [];
  const calls: string[] = [];
  let allowed = true;
  const executor = createPlaygroundExecutor({ load: () => config } as ConfigStore, () => {}, {
    telemetryStore: {
      upsertRequest: async (record) => {
        requests.push(structuredClone(record));
      },
      upsertAttempt: async (record) => {
        attempts.push(structuredClone(record));
      },
    },
    quotaLedger: {
      admit: async () => {
        calls.push('admit');
        return { allowed };
      },
      topUp: async () => ({ allowed: true }),
      markAttemptSent: async () => {
        calls.push('sent');
      },
      settle: async () => {
        calls.push('settle');
      },
    } as any,
    maxRetries: 2,
  });
  const input = {
    keyId: 'key_1',
    model: 'public-model',
    protocol: 'openai' as const,
    input: 'private prompt',
    maxOutputTokens: 16,
    actor: 'admin',
    routeId: 'route_1',
    target: { upstreamId: 'up_1', model: 'actual-model' },
    source: 'playground' as const,
    signal: new AbortController().signal,
  };
  return {
    executor,
    input,
    requests,
    attempts,
    calls,
    config,
    deny: () => {
      allowed = false;
    },
  };
}

test('playground uses hashed key ID, admits before dispatch, records source and usage without prompt', async () => {
  let sent = 0;
  const mock = await upstream((req, res) => {
    sent++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  try {
    const f = fixture(mock.url);
    const result = await f.executor(f.input);
    assert.equal(result.status, 200);
    assert.equal(result.output, 'hello');
    assert.equal(result.upstreamId, 'up_1');
    assert.equal(result.usage?.inputTotal, 3);
    assert.equal(result.usage?.outputTotal, 2);
    assert.equal(sent, 1);
    assert.deepEqual(f.calls, ['admit', 'sent', 'settle']);
    assert.equal(f.requests.at(-1)?.source, 'playground');
    assert.equal(f.requests.at(-1)?.configRevision, 7);
    assert.equal(f.requests.at(-1)?.proxyKeyId, 'key_1');
    assert.equal(f.attempts.at(-1)?.outcome, 'completed');
    assert.equal(JSON.stringify({ requests: f.requests, attempts: f.attempts }).includes('private prompt'), false);
  } finally {
    await mock.close();
  }
});

test('playground quota denial blocks upstream and stale target is rejected', async () => {
  let sent = 0;
  const mock = await upstream((_req, res) => {
    sent++;
    res.end('{}');
  });
  try {
    const f = fixture(mock.url);
    f.deny();
    const denied = await f.executor(f.input);
    assert.equal(denied.status, 429);
    assert.equal(sent, 0);
    assert.deepEqual(f.calls, ['admit', 'settle']);
    const stale = await f.executor({ ...f.input, target: { upstreamId: 'up_other', model: 'actual-model' } });
    assert.equal(stale.status, 409);
    assert.equal(sent, 0);
  } finally {
    await mock.close();
  }
});

test('playground explicitly rejects pass-through auth without a recoverable token', async () => {
  let sent = 0;
  const mock = await upstream((_req, res) => {
    sent++;
    res.end('{}');
  });
  try {
    const f = fixture(mock.url);
    f.config.upstreams[0].authMode = 'pass-through';
    const result = await f.executor(f.input);
    assert.equal(result.status, 422);
    assert.match(result.error ?? '', /pass-through upstream/);
    assert.equal(sent, 0);
    assert.deepEqual(f.calls, ['settle']);
    assert.equal(f.requests.at(-1)?.source, 'playground');
  } finally {
    await mock.close();
  }
});

test('playground collects streamed text and usage without requiring usage', async () => {
  const mock = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const f = fixture(mock.url);
    const result = await f.executor({ ...f.input, stream: true });
    assert.equal(result.status, 200);
    assert.equal(result.output, 'hello');
    assert.equal(result.usage?.inputTotal, 4);
    assert.equal(result.usage?.outputTotal, 2);
  } finally {
    await mock.close();
  }
});

test('playground uses the core Anthropic-to-OpenAI bridge', async () => {
  const mock = await upstream(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, 'actual-model');
    assert.equal(parsed.messages[0].content, 'private prompt');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'bridged' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    );
  });
  try {
    const f = fixture(mock.url);
    const result = await f.executor({ ...f.input, protocol: 'anthropic' });
    assert.equal(result.status, 200);
    assert.equal(result.output, 'bridged');
    assert.equal(result.usage?.inputTotal, 2);
  } finally {
    await mock.close();
  }
});

test('playground retries through proxy lifecycle and does not log prompt-echoed errors', async () => {
  let sent = 0;
  const mock = await upstream((_req, res) => {
    sent++;
    res.setHeader('content-type', 'application/json');
    if (sent === 1) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: 'private prompt unavailable' } }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }));
    }
  });
  try {
    const f = fixture(mock.url);
    f.config.upstreams.push({ ...f.config.upstreams[0], id: 'up_2', name: 'up_2' });
    f.config.routes![0].targets.push({ upstreamId: 'up_2', model: 'actual-model' });
    const logs: string[] = [];
    const executor = createPlaygroundExecutor(
      { load: () => f.config } as ConfigStore,
      (entry) => {
        logs.push(JSON.stringify(entry));
      },
      {
        telemetryStore: {
          upsertRequest: async (record) => {
            f.requests.push(structuredClone(record));
          },
          upsertAttempt: async (record) => {
            f.attempts.push(structuredClone(record));
          },
        },
        quotaLedger: {
          admit: async () => ({ allowed: true }),
          topUp: async () => ({ allowed: true }),
          markAttemptSent: async () => {},
          settle: async () => {},
        } as any,
        maxRetries: 2,
      },
    );
    const result = await executor(f.input);
    assert.equal(result.status, 200);
    assert.equal(result.output, 'recovered');
    assert.equal(result.usage?.inputTotal, null);
    assert.equal(sent, 2);
    assert.equal(f.attempts.length, 4); // each attempt is upserted at start and completion
    assert.equal(f.attempts[1]?.status, 503);
    assert.equal(JSON.stringify(logs).includes('private prompt'), false);
  } finally {
    await mock.close();
  }
});

test('playground abort cancels in-flight upstream and settles quota', async () => {
  let received!: () => void;
  const receivedPromise = new Promise<void>((resolve) => {
    received = resolve;
  });
  const mock = await upstream((_req, _res) => {
    received();
  });
  try {
    const f = fixture(mock.url);
    const controller = new AbortController();
    const running = f.executor({ ...f.input, signal: controller.signal });
    await receivedPromise;
    controller.abort();
    const result = await running;
    assert.equal(result.status, 499);
    assert.equal(result.output, '');
    assert.equal(f.requests.at(-1)?.state, 'cancelled');
    assert.ok(f.calls.includes('settle'));
  } finally {
    await mock.close();
  }
});

test('public proxy cannot select playground source or key by spoofed headers', async () => {
  const f = fixture('http://127.0.0.1:1/v1');
  const server = http.createServer((req, res) => {
    void proxyHandler(req, res, { load: () => f.config } as ConfigStore, () => {}, {
      telemetryStore: {
        upsertRequest: async (record) => {
          f.requests.push(structuredClone(record));
        },
        upsertAttempt: async () => {},
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-traffic-source': 'playground', 'x-proxy-key-id': 'key_1' },
        body: JSON.stringify({ model: 'public-model', messages: [{ role: 'user', content: 'prompt' }] }),
      },
    );
    assert.equal(response.status, 401);
    assert.equal(f.requests.at(-1)?.source, 'production');
    assert.equal(f.requests.at(-1)?.proxyKeyId, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
