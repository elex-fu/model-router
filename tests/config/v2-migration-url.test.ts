import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/store.js';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { ConfigServiceV2, ConfigValidationError } from '../../src/config/v2-service.js';
import { joinApiUrl } from '../../src/providers/url.js';
import { proxyHandler } from '../../src/server/proxy.js';

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

for (const item of [
  { protocol: 'openai', prefix: '', clientPath: '/v1/chat/completions', suffix: '/v1/chat/completions' },
  { protocol: 'openai', prefix: '/v1', clientPath: '/v1/chat/completions', suffix: '/v1/chat/completions' },
  { protocol: 'openai', prefix: '/v1/', clientPath: '/v1/chat/completions', suffix: '/v1/chat/completions' },
  {
    protocol: 'openai',
    prefix: '/gateway/team/v1',
    clientPath: '/v1/chat/completions',
    suffix: '/v1/chat/completions',
  },
  {
    protocol: 'openai',
    prefix: '/gateway/team/v1?fixed=1',
    clientPath: '/v1/chat/completions',
    suffix: '/v1/chat/completions',
  },
  {
    protocol: 'openai',
    prefix: '/gateway/team/v1/?fixed=1',
    clientPath: '/v1/chat/completions',
    suffix: '/v1/chat/completions',
  },
  { protocol: 'anthropic', prefix: '', clientPath: '/v1/messages', suffix: '/v1/messages' },
  { protocol: 'anthropic', prefix: '/coding/v1', clientPath: '/v1/messages', suffix: '/v1/messages' },
  { protocol: 'anthropic', prefix: '/coding/v1?fixed=1', clientPath: '/v1/messages', suffix: '/v1/messages' },
  { protocol: 'anthropic', prefix: '/coding/v1/?fixed=1', clientPath: '/v1/messages', suffix: '/v1/messages' },
  { protocol: 'responses', prefix: '', clientPath: '/v1/responses', suffix: '/v1/responses' },
  { protocol: 'responses', prefix: '/v1', clientPath: '/v1/responses', suffix: '/v1/responses' },
  { protocol: 'responses', prefix: '/gateway/v1?fixed=1', clientPath: '/v1/responses', suffix: '/v1/responses' },
  { protocol: 'responses', prefix: '/gateway/v1/?fixed=1', clientPath: '/v1/responses', suffix: '/v1/responses' },
] as const) {
  test(`${item.protocol} ${item.prefix || '(root)'}: migrated V2 proxy reaches exact V1 URL`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-migration-url-'));
    const configPath = join(dir, 'config.json');
    const seen: Array<{ url: string; auth: string | undefined; model: string | undefined }> = [];
    const upstream = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      const parsed = JSON.parse(body) as { model?: string };
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, model: parsed.model });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          item.protocol === 'anthropic'
            ? {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'model',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : item.protocol === 'responses'
              ? {
                  id: 'resp_1',
                  object: 'response',
                  model: 'model',
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1 },
                }
              : {
                  id: 'chat_1',
                  choices: [{ message: { role: 'assistant', content: 'ok' } }],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                },
        ),
      );
    });
    const upstreamBase = await listen(upstream);
    const legacyBase = `${upstreamBase}${item.prefix}`;
    const expected = new URL(`${legacyBase.replace(/\/+$/, '')}${item.suffix}`);
    writeFileSync(
      configPath,
      JSON.stringify({
        server: { port: 15005 },
        upstreams: [
          {
            name: 'target',
            provider: 'custom',
            protocol: item.protocol,
            baseUrl: legacyBase,
            apiKeys: ['upstream-secret'],
            models: ['model'],
            enabled: true,
            policy: { allowInsecureHttp: true },
          },
        ],
        proxyKeys: [{ name: 'client', key: 'client-secret', enabled: true, createdAt: '2026-01-01T00:00:00Z' }],
      }),
    );
    let active: ConfigStore = new ConfigStore(configPath);
    const proxy = createServer((req, res) => {
      proxyHandler(req, res, active, () => {}).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(error));
        }
      });
    });
    const proxyBase = await listen(proxy);
    const send = async () =>
      fetch(`${proxyBase}${item.clientPath}`, {
        method: 'POST',
        headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
        body: JSON.stringify(
          item.protocol === 'responses'
            ? { model: 'model', input: 'hi' }
            : item.protocol === 'anthropic'
              ? { model: 'model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
              : { model: 'model', messages: [{ role: 'user', content: 'hi' }] },
        ),
      });
    try {
      const backups: string[] = [];
      const service = new ConfigServiceV2(configPath, {
        storeSecret: async () => 'sec_1',
        hasSecret: () => true,
        backupLegacy: async (raw) => {
          backups.push(raw);
        },
      });
      const migrated = await service.loadRaw();
      assert.equal(backups.length, 1);
      assert.equal(
        joinApiUrl(migrated.upstreams[0]!.baseUrl, migrated.upstreams[0]!.endpoints.generate).toString(),
        expected.toString(),
      );
      assert.equal(
        readdirSync(dir).some((name) => name.endsWith('.bak')),
        false,
      );
      assert.equal(readFileSync(configPath, 'utf8').includes('upstream-secret'), false);
      const runtime = await compileRuntimeConfig(migrated, () => 'upstream-secret');
      active = new RuntimeConfigStore(configPath, runtime);
      const after = await send();
      assert.equal(after.status, 200, await after.clone().text());
      assert.deepEqual(
        seen.map((call) => call.url),
        [`${expected.pathname}${expected.search}`],
      );
      assert.deepEqual(
        seen.map((call) => call.auth),
        ['Bearer upstream-secret'],
      );
      assert.deepEqual(
        seen.map((call) => call.model),
        ['model'],
      );
    } finally {
      await close(proxy);
      await close(upstream);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('unrepresentable V1 root query blocks migration before secret writes or config overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-migration-url-error-'));
  const configPath = join(dir, 'config.json');
  const raw = JSON.stringify({
    server: {},
    upstreams: [
      {
        name: 'root-query',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: 'https://example.invalid?fixed=1',
        apiKeys: ['plaintext'],
        models: ['model'],
        enabled: true,
      },
    ],
    proxyKeys: [],
  });
  writeFileSync(configPath, raw);
  let stored = 0;
  try {
    await assert.rejects(
      () =>
        new ConfigServiceV2(configPath, {
          backupLegacy: async () => {},
          storeSecret: async () => {
            stored++;
            return 'sec_1';
          },
        }).loadRaw(),
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.issues.some((issue) => issue.code === 'legacy_url_unrepresentable'),
    );
    assert.equal(stored, 0);
    assert.equal(readFileSync(configPath, 'utf8'), raw);
    assert.deepEqual(readdirSync(dir), ['config.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration without a backup sink preserves the exact V1 config and does not publish V2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-migration-no-plaintext-'));
  const configPath = join(dir, 'config.json');
  const raw =
    JSON.stringify(
      {
        server: {},
        upstreams: [
          {
            name: 'local',
            provider: 'custom',
            protocol: 'openai',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKeys: ['private-value'],
            models: ['model'],
            enabled: true,
            policy: { allowInsecureHttp: true },
          },
        ],
        proxyKeys: [],
      },
      null,
      2,
    ) + '\n';
  writeFileSync(configPath, raw);
  try {
    let secretWrites = 0;
    const service = new ConfigServiceV2(configPath, {
      storeSecret: async () => {
        secretWrites++;
        return 'sec_1';
      },
      hasSecret: () => true,
    });
    await assert.rejects(() => service.loadRaw(), /secure versioned legacy backup sink/);
    assert.equal(secretWrites, 0);
    assert.equal(
      readdirSync(dir).some((name) => name.endsWith('.bak')),
      false,
    );
    assert.equal(readFileSync(configPath, 'utf8'), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
