import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { proxyHandler } from '../../src/server/proxy.js';

const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');

async function serve(config: Config) {
  const server = http.createServer((req, res) => {
    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function v2Config(): Config {
  return {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        id: 'key_all',
        name: 'all',
        key: '',
        keyHash: digest('sk-all'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'key_scoped',
        name: 'scoped',
        key: '',
        keyHash: digest('sk-scoped'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        allowedUpstreamIds: ['up_1'],
        allowedModels: ['alpha', 'beta-*'],
      },
      {
        id: 'key_disabled',
        name: 'disabled',
        key: '',
        keyHash: digest('sk-disabled'),
        enabled: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'key_expired',
        name: 'expired',
        key: '',
        keyHash: digest('sk-expired'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-02T00:00:00Z',
      },
    ],
    upstreams: [
      {
        id: 'up_1',
        name: 'internal-one',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: 'https://secret.internal/v1',
        apiKeys: ['upstream-secret'],
        models: ['actual-one'],
        enabled: true,
      },
      {
        id: 'up_2',
        name: 'internal-two',
        provider: 'custom',
        protocol: 'anthropic',
        baseUrl: 'https://another.secret/v1',
        apiKeys: ['another-secret'],
        models: ['actual-two'],
        enabled: true,
      },
      {
        id: 'up_off',
        name: 'disabled-upstream',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: 'https://off.secret/v1',
        apiKeys: [],
        models: ['actual-off'],
        enabled: false,
      },
    ],
    routes: [
      {
        id: 'route_alpha',
        name: 'alpha',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'alpha' },
        order: 0,
        publishedModels: ['alpha', 'not-the-match'],
        targets: [{ upstreamId: 'up_1', model: 'actual-one' }],
      },
      {
        id: 'route_beta',
        name: 'beta',
        enabled: true,
        clientProtocols: ['anthropic'],
        match: { kind: 'glob', value: 'beta-*' },
        order: 1,
        publishedModels: ['beta-1', 'beta-*'],
        targets: [{ upstreamId: 'up_2', model: 'actual-two' }],
      },
      {
        id: 'route_off_target',
        name: 'off target',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'offline' },
        order: 2,
        publishedModels: ['offline'],
        targets: [{ upstreamId: 'up_off', model: 'actual-off' }],
      },
      {
        id: 'route_disabled',
        name: 'disabled',
        enabled: false,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'hidden' },
        order: 3,
        publishedModels: ['hidden'],
        targets: [{ upstreamId: 'up_1', model: 'actual-one' }],
      },
    ],
  };
}

test('GET /v1/models authenticates digest key and lists only concrete, routed, permitted V2 aliases', async () => {
  const app = await serve(v2Config());
  try {
    const all = await fetch(`${app.url}/v1/models?ignored=1`, { headers: { authorization: 'Bearer sk-all' } });
    assert.equal(all.status, 200);
    const list = (await all.json()) as {
      object: string;
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    assert.equal(list.object, 'list');
    assert.deepEqual(
      list.data.map((item) => item.id),
      ['alpha', 'beta-1'],
    );
    assert.deepEqual(list.data[0], { id: 'alpha', object: 'model', created: 0, owned_by: 'model-router' });
    assert.equal(JSON.stringify(list).includes('secret'), false);
    assert.equal(JSON.stringify(list).includes('internal'), false);

    const scoped = await fetch(`${app.url}/v1/models`, { headers: { 'x-api-key': 'sk-scoped' } });
    assert.equal(scoped.status, 200);
    assert.deepEqual(
      ((await scoped.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id),
      ['alpha'],
    );
  } finally {
    await app.close();
  }
});

test('GET /v1/models denies missing, wrong, disabled and expired keys', async () => {
  const app = await serve(v2Config());
  try {
    for (const raw of [undefined, 'wrong', 'sk-disabled', 'sk-expired']) {
      const response = await fetch(`${app.url}/v1/models`, raw ? { headers: { authorization: `Bearer ${raw}` } } : {});
      assert.equal(response.status, 401, String(raw));
      const body = (await response.json()) as { error: { type: string } };
      assert.equal(body.error.type, 'authentication_error');
    }
  } finally {
    await app.close();
  }
});

test('/v1/models has GET-only semantics and no HEAD body', async () => {
  const app = await serve(v2Config());
  try {
    for (const method of ['HEAD', 'POST', 'OPTIONS']) {
      const response = await fetch(`${app.url}/v1/models`, { method, headers: { authorization: 'Bearer sk-all' } });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET');
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
    const missing = await fetch(`${app.url}/v1/models/other`, { headers: { authorization: 'Bearer sk-all' } });
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test('legacy model list contains only literal routed models and aliases under key permissions', async () => {
  const config = v2Config();
  delete config.routes;
  config.upstreams = [
    {
      id: 'legacy',
      name: 'legacy',
      provider: 'openai',
      protocol: 'openai',
      baseUrl: 'https://legacy.secret/v1',
      apiKeys: ['supplier-secret'],
      models: ['actual-model'],
      modelMap: { alias: 'actual-model', 'family-*': 'actual-model' },
      enabled: true,
    },
  ];
  config.proxyKeys[1].allowedUpstreamIds = ['legacy'];
  config.proxyKeys[1].allowedModels = ['alias'];
  const app = await serve(config);
  try {
    const all = await fetch(`${app.url}/v1/models`, { headers: { authorization: 'Bearer sk-all' } });
    assert.deepEqual(
      ((await all.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id),
      ['actual-model', 'alias'],
    );
    const scoped = await fetch(`${app.url}/v1/models`, { headers: { authorization: 'Bearer sk-scoped' } });
    assert.deepEqual(
      ((await scoped.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id),
      ['alias'],
    );
  } finally {
    await app.close();
  }
});
