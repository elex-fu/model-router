import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { type ProxyHandlerOptions, proxyHandler } from '../../src/server/proxy.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

type Faults = {
  request?: (record: RequestRecord) => void;
  attempt?: (record: AttemptRecord) => void;
  admit?: () => void;
  settle?: () => void;
  sent?: () => void;
};

async function harness(faults: Faults = {}, streaming = false) {
  let outbound = 0;
  const upstream = await listen((_req, res) => {
    outbound++;
    if (streaming) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    }
  });
  const requests: RequestRecord[] = [];
  const attempts: AttemptRecord[] = [];
  const active = new Set<string>();
  const config: Config = {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        id: 'key_1',
        name: 'test',
        key: '',
        keyHash: createHash('sha256').update('sk-test').digest('hex'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    upstreams: [
      {
        id: 'up_1',
        name: 'up_1',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: `${upstream.url}/v1`,
        endpoint: 'chat/completions',
        authMode: 'none',
        apiKeys: [],
        models: ['real'],
        enabled: true,
      },
    ],
    routes: [
      {
        id: 'route_1',
        name: 'route',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'public' },
        order: 0,
        publishedModels: ['public'],
        targets: [{ upstreamId: 'up_1', model: 'real' }],
      },
    ],
  };
  const telemetryStore: NonNullable<ProxyHandlerOptions['telemetryStore']> = {
    upsertRequest: async (record) => {
      faults.request?.(record);
      requests.push(structuredClone(record));
    },
    upsertAttempt: async (record) => {
      faults.attempt?.(record);
      attempts.push(structuredClone(record));
    },
  };
  const quotaLedger: NonNullable<ProxyHandlerOptions['quotaLedger']> = {
    admit: async ({ requestId }) => {
      active.add(requestId);
      faults.admit?.();
      return { allowed: true };
    },
    markAttemptSent: async () => {
      faults.sent?.();
    },
    settle: async (requestId) => {
      faults.settle?.();
      active.delete(requestId);
    },
  };
  const proxy = await listen((req, res) => {
    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, { telemetryStore, quotaLedger }).catch(
      (error) => {
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end(String(error));
      },
    );
  });
  const post = () =>
    fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public', stream: streaming, messages: [{ role: 'user', content: 'hi' }] }),
    });
  return {
    post,
    requests,
    attempts,
    active,
    get outbound() {
      return outbound;
    },
    close: async () => {
      await proxy.close();
      await upstream.close();
    },
  };
}

test('initial request write failure fails closed before admission and persists terminal state on retry', async () => {
  let failed = false;
  const h = await harness({
    request: (record) => {
      if (record.state === 'received' && !failed) {
        failed = true;
        throw new Error('injected request write failure');
      }
    },
  });
  try {
    const response = await h.post();
    assert.equal(response.status, 503);
    assert.equal(h.outbound, 0);
    assert.equal(h.active.size, 0);
    assert.equal(h.requests.at(-1)?.state, 'failed');
  } finally {
    await h.close();
  }
});

test('admitted request write failure releases reservation and returns 503 before outbound', async () => {
  const h = await harness({
    request: (record) => {
      if (record.state === 'admitted') throw new Error('injected admitted write failure');
    },
  });
  try {
    const response = await h.post();
    assert.equal(response.status, 503);
    assert.equal(h.outbound, 0);
    assert.equal(h.active.size, 0);
    assert.equal(h.requests.at(-1)?.state, 'failed');
    assert.equal(h.requests.at(-1)?.finalHttpStatus, 503);
  } finally {
    await h.close();
  }
});

test('admission uncertainty and started-attempt write failure release reservations', async () => {
  const admission = await harness({
    admit: () => {
      throw new Error('after commit');
    },
  });
  try {
    assert.equal((await admission.post()).status, 503);
    assert.equal(admission.outbound, 0);
    assert.equal(admission.active.size, 0);
  } finally {
    await admission.close();
  }

  const attempt = await harness({
    attempt: (record) => {
      if (record.outcome === 'started') throw new Error('injected attempt write failure');
    },
  });
  try {
    assert.equal((await attempt.post()).status, 503);
    assert.equal(attempt.outbound, 0);
    assert.equal(attempt.active.size, 0);
    assert.equal(attempt.requests.at(-1)?.state, 'failed');
  } finally {
    await attempt.close();
  }
});

test('quota attempt tracking failure blocks outbound and finalizes reservation', async () => {
  const h = await harness({
    sent: () => {
      throw new Error('injected markAttemptSent failure');
    },
  });
  try {
    const response = await h.post();
    assert.equal(response.status, 503);
    assert.equal(h.outbound, 0);
    assert.equal(h.active.size, 0);
    assert.equal(h.attempts.at(-1)?.retryReason, 'quota_tracking_unavailable');
  } finally {
    await h.close();
  }
});

test('settle failure does not skip terminal persistence or send a second stream response', async () => {
  let failures = 0;
  const h = await harness(
    {
      settle: () => {
        if (failures++ === 0) throw new Error('injected settle failure');
      },
    },
    true,
  );
  try {
    const response = await h.post();
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal((body.match(/data:/g) ?? []).length, 2);
    assert.equal(h.active.size, 0);
    assert.equal(h.requests.at(-1)?.state, 'completed');
    assert.equal(h.requests.at(-1)?.finalHttpStatus, 200);
    assert.equal(failures, 2);
  } finally {
    await h.close();
  }
});

test('terminal write failure retries persistence without altering delivered status', async () => {
  let failures = 0;
  const h = await harness({
    request: (record) => {
      if (record.endedAtMs !== null && failures++ === 0) throw new Error('injected terminal write failure');
    },
  });
  try {
    const response = await h.post();
    assert.equal(response.status, 200);
    assert.equal(h.active.size, 0);
    assert.equal(h.requests.at(-1)?.state, 'completed');
    assert.equal(failures, 2);
  } finally {
    await h.close();
  }
});

test('persistent settle failure still writes terminal state and preserves the delivered response', async () => {
  let settleCalls = 0;
  const h = await harness(
    {
      settle: () => {
        settleCalls++;
        throw new Error('persistent settle failure');
      },
    },
    true,
  );
  try {
    const response = await h.post();
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: \[DONE\]/);
    assert.equal(settleCalls, 2);
    assert.equal(h.requests.at(-1)?.state, 'completed');
    assert.equal(h.requests.at(-1)?.finalHttpStatus, 200);
    assert.equal(h.active.size, 1);
  } finally {
    await h.close();
  }
});
