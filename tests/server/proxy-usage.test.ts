import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import type { QuotaAdmission } from '../../src/quota/ledger.js';
import { quotaPeriod } from '../../src/quota/period.js';
import type { QuotaTimezoneVersions } from '../../src/quota/timezone-versions.js';
import { extractNonStreamUsage, type ProxyHandlerOptions, proxyHandler } from '../../src/server/proxy.js';
import type { AttemptRecord } from '../../src/telemetry/types.js';

async function startAnthropicProxy(
  inputIncludesCache?: boolean,
  quotaOptions: Pick<ProxyHandlerOptions, 'quotaLedger' | 'quotaTimezone' | 'quotaTimezoneVersions'> = {},
) {
  const attempts: AttemptRecord[] = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_usage',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config: Config = {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        name: 'test',
        key: '',
        keyHash: createHash('sha256').update('sk-test').digest('hex'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    upstreams: [
      {
        name: 'anthropic',
        provider: 'custom',
        protocol: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKeys: [],
        authMode: 'none',
        models: ['claude-test'],
        enabled: true,
        inputIncludesCache,
      },
    ],
  };
  const proxy = http.createServer((req, res) => {
    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, {
      ...quotaOptions,
      telemetryStore: {
        upsertRequest: async () => {},
        upsertAttempt: async (attempt) => attempts.push(structuredClone(attempt)),
      },
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    attempts,
    url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    close: async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test('proxy resolves the versioned quota period once and passes its fixed identity to admission', async () => {
  const admissions: QuotaAdmission[] = [];
  const resolutionTimes: number[] = [];
  const versions: Pick<QuotaTimezoneVersions, 'resolveForAdmission'> = {
    resolveForAdmission: (atMs) => {
      resolutionTimes.push(atMs);
      return {
        ...quotaPeriod(atMs, 'Asia/Shanghai', 37),
        versionId: 37,
        timezone: 'Asia/Shanghai',
        effectiveFromMs: 0,
      };
    },
  };
  const quotaLedger: NonNullable<ProxyHandlerOptions['quotaLedger']> = {
    admit: async (admission) => {
      admissions.push(admission);
      return { allowed: true };
    },
    markAttemptSent: async () => {},
    settle: async () => {},
  };
  const proxy = await startAnthropicProxy(false, { quotaLedger, quotaTimezoneVersions: versions });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(resolutionTimes.length, 1);
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].atMs, resolutionTimes[0]);
    assert.equal(admissions[0].periodId, quotaPeriod(resolutionTimes[0], 'Asia/Shanghai', 37).id);
    assert.equal(admissions[0].periodStartMs, quotaPeriod(resolutionTimes[0], 'Asia/Shanghai', 37).startMs);
    assert.equal(admissions[0].periodEndMs, quotaPeriod(resolutionTimes[0], 'Asia/Shanghai', 37).endMs);
    assert.equal(admissions[0].timezoneVersionId, 37);
  } finally {
    await proxy.close();
  }
});

test('proxy retains its configured timezone fallback without a version resolver', async () => {
  const admissions: QuotaAdmission[] = [];
  const quotaLedger: NonNullable<ProxyHandlerOptions['quotaLedger']> = {
    admit: async (admission) => {
      admissions.push(admission);
      return { allowed: true };
    },
    markAttemptSent: async () => {},
    settle: async () => {},
  };
  const proxy = await startAnthropicProxy(false, { quotaLedger, quotaTimezone: 'Asia/Tokyo' });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(admissions.length, 1);
    const fallbackPeriod = quotaPeriod(admissions[0].atMs, 'Asia/Tokyo');
    assert.equal(admissions[0].periodId, fallbackPeriod.id);
    assert.equal(admissions[0].periodStartMs, fallbackPeriod.startMs);
    assert.equal(admissions[0].periodEndMs, fallbackPeriod.endMs);
    assert.equal(admissions[0].timezoneVersionId, undefined);
  } finally {
    await proxy.close();
  }
});

for (const { policy, expectedTotal, expectedUncached } of [
  { policy: true, expectedTotal: 100, expectedUncached: 0 },
  { policy: false, expectedTotal: 200, expectedUncached: 100 },
  { policy: undefined, expectedTotal: 200, expectedUncached: 100 },
]) {
  test(`Anthropic production telemetry applies inputIncludesCache=${String(policy)}`, async () => {
    const proxy = await startAnthropicProxy(policy);
    try {
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(response.status, 200);
      await response.json();
      assert.equal(proxy.attempts.at(-1)?.usage?.inputTotal, expectedTotal);
      assert.equal(proxy.attempts.at(-1)?.usage?.inputUncached, expectedUncached);
    } finally {
      await proxy.close();
    }
  });
}

test('extractNonStreamUsage: anthropic basic tokens', () => {
  const body = { usage: { input_tokens: 10, output_tokens: 20 } };
  const u = extractNonStreamUsage('anthropic', body);
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheReadTokens, undefined);
  assert.equal(u.cacheCreationTokens, undefined);
});

test('extractNonStreamUsage: anthropic with cache tokens', () => {
  const body = {
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    },
  };
  const u = extractNonStreamUsage('anthropic', body);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.cacheReadTokens, 80);
  assert.equal(u.cacheCreationTokens, 20);
});

test('extractNonStreamUsage: openai basic tokens', () => {
  const body = { usage: { prompt_tokens: 30, completion_tokens: 15 } };
  const u = extractNonStreamUsage('openai', body);
  assert.equal(u.inputTokens, 30);
  assert.equal(u.outputTokens, 15);
  assert.equal(u.cacheReadTokens, undefined);
});

test('extractNonStreamUsage: openai with cached_tokens', () => {
  const body = {
    usage: {
      prompt_tokens: 200,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 150 },
    },
  };
  const u = extractNonStreamUsage('openai', body);
  assert.equal(u.inputTokens, 200);
  assert.equal(u.outputTokens, 100);
  assert.equal(u.cacheReadTokens, 150);
});

test('extractNonStreamUsage: handles null/undefined body', () => {
  assert.deepEqual(extractNonStreamUsage('anthropic', null), {});
  assert.deepEqual(extractNonStreamUsage('anthropic', undefined), {});
  assert.deepEqual(extractNonStreamUsage('openai', 'string'), {});
});

import { injectAnthropicHeaders, stripThinkingBetasFromHeaders } from '../../src/server/proxy.js';

test('injectAnthropicHeaders: adds version and beta for legacy model', () => {
  const h = new Headers();
  injectAnthropicHeaders(h, 'claude-sonnet-4-5');
  assert.equal(h.get('anthropic-version'), '2023-06-01');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('interleaved-thinking-2025-05-14'));
});

test('injectAnthropicHeaders: adds context beta for opus/sonnet-4-6', () => {
  const h = new Headers();
  injectAnthropicHeaders(h, 'claude-opus-4-7');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('context-1m-2025-08-07'));
  assert.ok(!beta.includes('interleaved-thinking-2025-05-14'));
});

test('injectAnthropicHeaders: skips thinking beta for haiku', () => {
  const h = new Headers();
  injectAnthropicHeaders(h, 'claude-haiku-4-5');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(!beta.includes('interleaved-thinking-2025-05-14'));
  assert.ok(!beta.includes('context-1m-2025-08-07'));
});

test('injectAnthropicHeaders: preserves existing client beta and deduplicates', () => {
  const h = new Headers();
  h.set('anthropic-beta', 'claude-code-20250219, custom-beta');
  injectAnthropicHeaders(h, 'claude-sonnet-4-5');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('custom-beta'));
  assert.ok(beta.includes('interleaved-thinking-2025-05-14'));
  // Should not duplicate claude-code-20250219
  const matches = beta.match(/claude-code-20250219/g);
  assert.equal(matches?.length, 1);
});

test('injectAnthropicHeaders: does not override existing anthropic-version', () => {
  const h = new Headers();
  h.set('anthropic-version', '2025-01-01');
  injectAnthropicHeaders(h, 'claude-test');
  assert.equal(h.get('anthropic-version'), '2025-01-01');
});

test('stripThinkingBetasFromHeaders: removes thinking betas', () => {
  const h = new Headers();
  h.set('anthropic-beta', 'claude-code-20250219, interleaved-thinking-2025-05-14, custom-beta');
  stripThinkingBetasFromHeaders(h);
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('custom-beta'));
  assert.ok(!beta.includes('interleaved-thinking-2025-05-14'));
});

test('stripThinkingBetasFromHeaders: deletes header when empty', () => {
  const h = new Headers();
  h.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
  stripThinkingBetasFromHeaders(h);
  assert.equal(h.has('anthropic-beta'), false);
});
