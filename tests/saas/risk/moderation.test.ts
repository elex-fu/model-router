import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ContentModerationCheckInput,
  type ContentModerationLogRow,
  type ContentModerationStore,
  defaultRiskControlConfig,
  evaluateModerationScores,
  freezeDurationForHttpStatus,
  includesModel,
  includesTenant,
  KEY_AUTH_FREEZE_MS,
  KEY_RATE_LIMIT_FREEZE_MS,
  type ModerationEmailMessage,
  type ModerationFetch,
  normalizeRiskControlConfig,
  parseRiskControlConfigInput,
  RiskControlConfigError,
  SaasContentModerationService,
  serializeRiskControlConfig,
  shouldSample,
} from '../../../src/saas/risk/moderation.js';
import { moderationInputHash } from '../../../src/saas/risk/moderation-input.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

class FakeStore implements ContentModerationStore {
  rawConfig: string | null = null;
  configReads = 0;
  configReadError: Error | null = null;
  logs: ContentModerationLogRow[] = [];
  insertLogError: Error | null = null;
  flaggedHashes = new Set<string>();
  hasHashError: Error | null = null;
  counts: Record<string, number> = {};
  disabledUsers: string[] = [];
  disableRefuses = false;
  contacts: Record<string, string> = {};
  auditEvents: { tenantId: string; action: string; targetId: string; requestId: string }[] = [];

  readRawConfig(): Promise<string | null> {
    this.configReads += 1;
    if (this.configReadError) return Promise.reject(this.configReadError);
    return Promise.resolve(this.rawConfig);
  }

  insertLog(row: ContentModerationLogRow): Promise<void> {
    if (this.insertLogError) return Promise.reject(this.insertLogError);
    this.logs.push(row);
    return Promise.resolve();
  }

  countFlaggedByUserSince(userId: string): Promise<number> {
    return Promise.resolve(this.counts[userId] ?? 0);
  }

  hasFlaggedInputHash(inputHash: string): Promise<boolean> {
    if (this.hasHashError) return Promise.reject(this.hasHashError);
    return Promise.resolve(this.flaggedHashes.has(inputHash));
  }

  recordFlaggedInputHash(inputHash: string): Promise<void> {
    this.flaggedHashes.add(inputHash);
    return Promise.resolve();
  }

  disableUser(userId: string): Promise<{ newlyDisabled: boolean }> {
    if (this.disableRefuses) throw new Error('disable refused');
    if (this.disabledUsers.includes(userId)) {
      return Promise.resolve({ newlyDisabled: false });
    }
    this.disabledUsers.push(userId);
    return Promise.resolve({ newlyDisabled: true });
  }

  userContact(userId: string): Promise<{ email: string | null } | null> {
    const email = this.contacts[userId];
    return Promise.resolve(email === undefined ? { email: null } : { email });
  }

  insertAuditEvent(event: {
    tenantId: string;
    action: string;
    targetType: string;
    targetId: string;
    requestId: string;
  }): Promise<void> {
    this.auditEvents.push(event);
    return Promise.resolve();
  }
}

class RecordingEmailSender {
  sent: ModerationEmailMessage[] = [];
  error: Error | null = null;

  async send(input: ModerationEmailMessage): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(input);
  }
}

function fakeFetch(handler: (call: FetchCall) => Response): ModerationFetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl: ModerationFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return Object.assign(impl, { calls });
}

function moderationResponse(scores: Record<string, number>): Response {
  return new Response(
    JSON.stringify({ model: 'omni-moderation-latest', results: [{ flagged: true, category_scores: scores }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status: number): Response {
  return new Response('upstream error', { status });
}

function baseInput(overrides: Partial<ContentModerationCheckInput> = {}): ContentModerationCheckInput {
  return {
    requestId: 'req-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    apiKeyId: 'key-1',
    apiKeyName: 'key-name',
    protocol: 'anthropic',
    model: 'claude-sonnet-4',
    body: { messages: [{ role: 'user', content: 'hello world' }] },
    ...overrides,
  };
}

function configJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    enabled: true,
    mode: 'pre_block',
    base_url: 'https://moderation.example',
    model: 'omni-moderation-latest',
    api_keys: ['mod-key-1'],
    timeout_ms: 1000,
    sample_rate: 100,
    all_tenants: true,
    thresholds: { hate: 0.65 },
    block_message: 'blocked by policy',
    auto_ban_enabled: true,
    ban_threshold: 10,
    violation_window_hours: 720,
    ...overrides,
  });
}

function harness(
  options: {
    store?: FakeStore;
    emailSender?: RecordingEmailSender;
    fetchImpl?: ModerationFetch;
    nowMs?: () => number;
    ttlMs?: number;
  } = {},
) {
  const store = options.store ?? new FakeStore();
  const emailSender = options.emailSender ?? new RecordingEmailSender();
  let now = 1_000_000;
  const nowMs = options.nowMs ?? (() => now);
  const fetchImpl = options.fetchImpl ?? fakeFetch(() => moderationResponse({ hate: 0.99 }));
  const service = new SaasContentModerationService({
    store,
    emailSender,
    fetchImpl,
    nowMs,
    runtimeCacheTtlMs: options.ttlMs ?? 0,
    siteName: 'Test Router',
  });
  return {
    store,
    emailSender,
    fetch: fetchImpl,
    service,
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe('risk control config parsing', () => {
  it('defaults every field (feature off, pre_block, all tenants, 13 thresholds)', () => {
    const config = defaultRiskControlConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.mode, 'pre_block');
    assert.equal(config.baseUrl, 'https://api.openai.com');
    assert.equal(config.model, 'omni-moderation-latest');
    assert.equal(config.apiKeys.length, 0);
    assert.equal(config.timeoutMs, 3000);
    assert.equal(config.sampleRate, 100);
    assert.equal(config.allTenants, true);
    assert.equal(config.recordNonHits, false);
    assert.equal(config.blockStatus, 403);
    assert.equal(config.banThreshold, 10);
    assert.equal(config.violationWindowHours, 720);
    assert.equal(config.retryCount, 2);
    assert.equal(config.hitRetentionDays, 180);
    assert.equal(config.nonHitRetentionDays, 3);
    assert.equal(config.preHashCheckEnabled, false);
    assert.equal(config.keywordBlockingMode, 'keyword_and_api');
    assert.equal(config.modelFilter.type, 'all');
    assert.deepEqual(Object.keys(config.thresholds).sort(), [
      'harassment',
      'harassment/threatening',
      'hate',
      'hate/threatening',
      'illicit',
      'illicit/violent',
      'self-harm',
      'self-harm/instructions',
      'self-harm/intent',
      'sexual',
      'sexual/minors',
      'violence',
      'violence/graphic',
    ]);
  });

  it('normalizes invalid runtime values leniently (fail-open posture)', () => {
    const config = normalizeRiskControlConfig({
      enabled: 'yes',
      mode: 'bogus',
      sample_rate: 5000,
      timeout_ms: -5,
      api_keys: [' a ', 'a', '', 42],
      blocked_keywords: ['敏感词', '敏感词', '  ', 'x'.repeat(300)],
      thresholds: { hate: 5, made_up: 0.1 },
    });
    assert.equal(config.enabled, false);
    assert.equal(config.mode, 'pre_block');
    assert.equal(config.sampleRate, 100);
    assert.equal(config.timeoutMs, 3000);
    assert.deepEqual(config.apiKeys, ['a']);
    assert.equal(config.blockedKeywords[0], '敏感词');
    assert.equal([...config.blockedKeywords[0]].length, 3);
    assert.ok([...config.blockedKeywords[1]].length <= 200);
    assert.equal(config.thresholds.hate, 1);
    assert.equal('made_up' in config.thresholds, false);
  });

  it('round-trips serialize → normalize', () => {
    const parsed = parseRiskControlConfigInput({
      enabled: true,
      mode: 'observe',
      blocked_keywords: ['alpha', 'beta'],
      model_filter_type: 'include',
      model_filter_models: ['claude-*'],
    });
    const round = normalizeRiskControlConfig(JSON.parse(serializeRiskControlConfig(parsed)));
    assert.deepEqual(round, parsed);
  });

  it('strict parse rejects unknown fields, bad enums, bad URLs, rogue categories', () => {
    assert.throws(() => parseRiskControlConfigInput({ surprise: 1 }), RiskControlConfigError);
    assert.throws(() => parseRiskControlConfigInput({ mode: 'nope' }), RiskControlConfigError);
    assert.throws(() => parseRiskControlConfigInput({ keyword_blocking_mode: 'nope' }), RiskControlConfigError);
    assert.throws(() => parseRiskControlConfigInput({ base_url: 'ftp://x' }), RiskControlConfigError);
    assert.throws(() => parseRiskControlConfigInput({ base_url: 'not a url' }), RiskControlConfigError);
    assert.throws(() => parseRiskControlConfigInput({ thresholds: { nope: 0.5 } }), RiskControlConfigError);
    assert.throws(() => parseRiskControlConfigInput({ model_filter_type: 'include' }), RiskControlConfigError);
    assert.throws(
      () => parseRiskControlConfigInput({ model_filter_type: 'exclude', model_filter_models: [] }),
      RiskControlConfigError,
    );
    assert.throws(() => parseRiskControlConfigInput([]), RiskControlConfigError);
    // Valid shape passes.
    const config = parseRiskControlConfigInput({ enabled: true, block_status: 451 });
    assert.equal(config.blockStatus, 451);
  });
});

describe('score evaluation, sampling and scope helpers', () => {
  it('flags when any category meets its threshold and reports the highest', () => {
    const thresholds = defaultRiskControlConfig().thresholds;
    const evaluation = evaluateModerationScores({ hate: 0.7, violence: 0.99, harassment: 0.5 }, thresholds);
    assert.equal(evaluation.flagged, true);
    assert.equal(evaluation.highestCategory, 'violence');
    assert.equal(evaluation.highestScore, 0.99);
  });

  it('does not flag below threshold', () => {
    const evaluation = evaluateModerationScores({ hate: 0.64 }, defaultRiskControlConfig().thresholds);
    assert.equal(evaluation.flagged, false);
    assert.equal(evaluation.highestCategory, 'hate');
  });

  it('breaks ties by the fixed category order', () => {
    const evaluation = evaluateModerationScores(
      { sexual: 0.9, harassment: 0.9 },
      defaultRiskControlConfig().thresholds,
    );
    assert.equal(evaluation.highestCategory, 'harassment');
  });

  it('carries unknown categories into the highest reporting without flagging', () => {
    const evaluation = evaluateModerationScores({ custom_engine: 0.99 }, defaultRiskControlConfig().thresholds);
    assert.equal(evaluation.flagged, false);
    assert.equal(evaluation.highestCategory, 'custom_engine');
  });

  it('samples deterministically from the input hash prefix (rate r admits value < r)', () => {
    for (const text of ['sample me', 'another input', '中文采样文本', 'third probe']) {
      const hash = moderationInputHash(text);
      const value = Number.parseInt(hash.slice(0, 4), 16) % 100;
      assert.ok(Number.isFinite(value));
      assert.equal(shouldSample(hash, 0), false, text);
      assert.equal(shouldSample(hash, 100), true, text);
      // Included exactly when the hash prefix bucket is below the rate.
      assert.equal(shouldSample(hash, value + 1), true, text);
      assert.equal(shouldSample(hash, value), false, text);
      if (value > 0) {
        assert.equal(shouldSample(hash, value - 1), false, text);
      }
    }
  });

  it('scopes tenants and models', () => {
    const allConfig = normalizeRiskControlConfig({});
    assert.equal(includesTenant(allConfig, 'any'), true);
    const scoped = normalizeRiskControlConfig({ all_tenants: false, tenant_ids: ['t1', 't2'] });
    assert.equal(includesTenant(scoped, 't1'), true);
    assert.equal(includesTenant(scoped, 't3'), false);

    const includeConfig = normalizeRiskControlConfig({
      model_filter_type: 'include',
      model_filter_models: ['Claude-Sonnet-4'],
    });
    assert.equal(includesModel(includeConfig, 'claude-sonnet-4'), true);
    assert.equal(includesModel(includeConfig, 'gpt-4o'), false);
    const excludeConfig = normalizeRiskControlConfig({ model_filter_type: 'exclude', model_filter_models: ['gpt-4o'] });
    assert.equal(includesModel(excludeConfig, 'gpt-4o'), false);
    assert.equal(includesModel(excludeConfig, 'claude-sonnet-4'), true);
  });

  it('maps HTTP statuses to freeze durations', () => {
    assert.equal(freezeDurationForHttpStatus(0), 0);
    assert.equal(freezeDurationForHttpStatus(400), 0);
    assert.equal(freezeDurationForHttpStatus(401), KEY_AUTH_FREEZE_MS);
    assert.equal(freezeDurationForHttpStatus(403), KEY_AUTH_FREEZE_MS);
    assert.equal(freezeDurationForHttpStatus(429), KEY_RATE_LIMIT_FREEZE_MS);
    assert.equal(freezeDurationForHttpStatus(529), KEY_RATE_LIMIT_FREEZE_MS);
    assert.equal(freezeDurationForHttpStatus(500), 10_000);
    assert.equal(freezeDurationForHttpStatus(502), 10_000);
  });
});

describe('content moderation judgment chain', () => {
  it('allows everything when the feature is disabled, off, out of tenant scope or out of model scope', async () => {
    for (const overrides of [
      { enabled: false },
      { enabled: true, mode: 'off' },
      { enabled: true, all_tenants: false, tenant_ids: ['other'] },
      { enabled: true, model_filter_type: 'include', model_filter_models: ['other-model'] },
    ]) {
      const h = harness();
      h.store.rawConfig = configJson(overrides);
      const decision = await h.service.check(baseInput());
      assert.equal(decision.allowed, true, JSON.stringify(overrides));
      assert.equal(h.fetch.calls.length, 0);
      assert.equal(h.store.logs.length, 0);
    }
  });

  it('blocks on keyword hits with zero API latency and applies side effects', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ blocked_keywords: ['forbidden-phrase'] });
    const decision = await h.service.check(
      baseInput({ body: { messages: [{ role: 'user', content: 'please say FORBIDDEN-PHRASE now' }] } }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'keyword_block');
    assert.equal(decision.statusCode, 403);
    assert.equal(decision.message, 'blocked by policy');
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.store.logs.length, 1);
    const log = h.store.logs[0];
    assert.equal(log.action, 'keyword_block');
    assert.equal(log.flagged, true);
    assert.equal(log.highestCategory, 'keyword');
    assert.equal(log.highestScore, 1);
    assert.equal(log.matchedKeyword, 'forbidden-phrase');
    assert.equal(log.violationCount, 1);
    assert.equal(log.emailSent, false); // no contact email configured
  });

  it('stops at keywords in keyword_only mode (miss → allow, no API call)', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ blocked_keywords: ['forbidden-phrase'], keyword_blocking_mode: 'keyword_only' });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.store.logs.length, 0);
  });

  it('skips keyword matching entirely in api_only mode', async () => {
    const low = fakeFetch(() => moderationResponse({ hate: 0.1 }));
    const h = harness({ fetchImpl: low });
    h.store.rawConfig = configJson({ blocked_keywords: ['hello'], keyword_blocking_mode: 'api_only' });
    const decision = await h.service.check(
      baseInput({ body: { messages: [{ role: 'user', content: 'hello world' }] } }),
    );
    // Keyword text is ignored; the API path runs and hate=0.1 is below the
    // 0.65 threshold → allow.
    assert.equal(decision.allowed, true);
    assert.equal(low.calls.length, 1);
  });

  it('blocks previously flagged input hashes without calling the API', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ pre_hash_check_enabled: true });
    const hash = moderationInputHash('hello world');
    h.store.flaggedHashes.add(hash);
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'hash_block');
    assert.match(decision.message, /hash: [0-9a-f]{64}/);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.store.logs.length, 1);
    assert.equal(h.store.logs[0].action, 'hash_block');
    // hash_block rows never participate in the violation count and auto-ban
    // is not applied for them.
    assert.equal(h.store.logs[0].violationCount, 0);
    assert.equal(h.store.disabledUsers.length, 0);
  });

  it('skips unsampled requests', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ sample_rate: 0 });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
  });

  it('fails open when no audit API keys are configured', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ api_keys: [] });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.store.logs.length, 0);
  });

  it('blocks when a category exceeds its threshold (pre_block)', async () => {
    const h = harness();
    h.store.rawConfig = configJson({});
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'block');
    assert.equal(decision.highestCategory, 'hate');
    assert.equal(h.fetch.calls.length, 1);
    const log = h.store.logs[0];
    assert.equal(log.action, 'block');
    assert.equal(log.flagged, true);
    assert.equal(log.thresholdSnapshot.hate, 0.65);
    assert.ok(h.store.flaggedHashes.has(moderationInputHash('hello world')));
  });

  it('allows below-threshold results and records non-hits only when configured', async () => {
    const h1 = harness({ fetchImpl: fakeFetch(() => moderationResponse({ hate: 0.1 })) });
    h1.store.rawConfig = configJson({});
    await h1.service.check(baseInput());
    assert.equal(h1.store.logs.length, 0);

    const h2 = harness({ fetchImpl: fakeFetch(() => moderationResponse({ hate: 0.1 })) });
    h2.store.rawConfig = configJson({ record_non_hits: true });
    await h2.service.check(baseInput());
    assert.equal(h2.store.logs.length, 1);
    assert.equal(h2.store.logs[0].flagged, false);
    assert.equal(h2.store.logs[0].action, 'allow');
  });

  it('fails open on moderation API errors, optionally logging them', async () => {
    const failing = fakeFetch(() => errorResponse(500));
    const h = harness({ fetchImpl: failing });
    h.store.rawConfig = configJson({ retry_count: 0, record_non_hits: true });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.store.logs.length, 1);
    assert.equal(h.store.logs[0].action, 'error');
    assert.match(h.store.logs[0].error, /status 500/);
  });

  it('fails open when the config itself cannot be loaded', async () => {
    const h = harness();
    h.store.configReadError = new Error('db down');
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
  });

  it('still blocks when log persistence fails (fail-open applies to side effects, not the decision)', async () => {
    const h = harness();
    h.store.rawConfig = configJson({});
    h.store.insertLogError = new Error('log insert failed');
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'block');
  });

  it('continues the chain when the hash store fails (fail-open)', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ pre_hash_check_enabled: true });
    h.store.hasHashError = new Error('hash store down');
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false); // still evaluated by the API result
    assert.equal(h.fetch.calls.length, 1);
  });

  it('skips empty extracted input', async () => {
    const h = harness();
    h.store.rawConfig = configJson({});
    const decision = await h.service.check(baseInput({ body: { messages: [] } }));
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
  });

  it('extracts per-protocol text (openai and responses shapes)', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ blocked_keywords: ['canary-word'] });
    for (const [protocol, body] of [
      ['openai', { messages: [{ role: 'user', content: 'canary-word present' }] }],
      ['responses', { input: 'canary-word present' }],
    ] as const) {
      const decision = await h.service.check(baseInput({ protocol, body: body as Record<string, unknown> }));
      assert.equal(decision.allowed, false, protocol);
      assert.equal(decision.action, 'keyword_block');
    }
  });
});

describe('observe mode', () => {
  it('allows the request immediately and audits asynchronously without blocking', async () => {
    let resolveFirst: (() => void) | null = null;
    const slow = fakeFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = () => resolve(moderationResponse({ hate: 0.99 }));
        }),
    );
    const h = harness({ fetchImpl: slow });
    h.store.rawConfig = configJson({ mode: 'observe' });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(decision.action, 'allow');
    assert.equal(h.store.logs.length, 0);
    resolveFirst?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.logs.length, 1);
    assert.equal(h.store.logs[0].action, 'allow');
    assert.equal(h.store.logs[0].flagged, true);
    assert.equal(h.store.logs[0].mode, 'observe');
  });

  it('drops observe checks past the in-flight cap instead of queueing unbounded', async () => {
    const never = fakeFetch(() => new Promise<Response>(() => undefined));
    const h = harness({ fetchImpl: never });
    h.store.rawConfig = configJson({ mode: 'observe' });
    const service = new SaasContentModerationService({
      store: h.store,
      emailSender: h.emailSender,
      fetchImpl: never,
      runtimeCacheTtlMs: 0,
      observeInFlightLimit: 1,
    });
    await service.check(baseInput({ requestId: 'r1' }));
    await service.check(baseInput({ requestId: 'r2' }));
    // First check occupies the single slot; the second is dropped (allowed).
    assert.equal(never.calls.length, 1);
  });
});

describe('moderation API key pool and circuit breaker', () => {
  it('freezes a 429 key for 60s and round-robins to the next key', async () => {
    const statuses = [429, 200];
    let index = 0;
    const fetchImpl = fakeFetch(() => {
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (status === 200) return moderationResponse({ hate: 0.1 });
      return errorResponse(status);
    });
    const h = harness({ fetchImpl });
    h.store.rawConfig = configJson({ api_keys: ['key-a', 'key-b'], retry_count: 0 });
    await h.service.check(baseInput()); // key-a → 429, fail open
    const decision = await h.service.check(baseInput()); // key-a frozen → key-b
    assert.equal(decision.allowed, true);
    assert.equal(fetchImpl.calls.length, 2);
    const auths = fetchImpl.calls.map((call) => String(call.init.headers?.authorization));
    assert.equal(auths[0], 'Bearer key-a');
    assert.equal(auths[1], 'Bearer key-b');
    assert.equal(h.service.keyHealthStatuses().length, 2);
  });

  it('freezes 401 keys for 10 minutes and skips them while frozen', async () => {
    const h = harness({ fetchImpl: fakeFetch(() => errorResponse(401)) });
    h.store.rawConfig = configJson({ api_keys: ['moderation-key-a'], retry_count: 0 });
    await h.service.check(baseInput());
    const all = h.service.keyHealthStatuses();
    assert.equal(all.length, 1);
    assert.equal(all[0].masked, '****ey-a');
    // The clock never advances in this test, so the full auth freeze remains.
    assert.ok(all[0].frozenForMs >= KEY_AUTH_FREEZE_MS - 1000, `frozen=${all[0].frozenForMs}`);
    // Frozen key is skipped; no key available → fail open.
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 1);
  });

  it('unfreezes keys once the freeze window passes', async () => {
    const statuses = [429, 200];
    let index = 0;
    const fetchImpl = fakeFetch(() => {
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (status === 200) return moderationResponse({ hate: 0.1 });
      return errorResponse(status);
    });
    const h = harness({ fetchImpl });
    h.store.rawConfig = configJson({ api_keys: ['only-key'], retry_count: 0 });
    await h.service.check(baseInput()); // 429 → frozen
    const blocked = await h.service.check(baseInput());
    assert.equal(blocked.allowed, true);
    assert.equal(fetchImpl.calls.length, 1); // still frozen
    h.advance(KEY_RATE_LIMIT_FREEZE_MS + 1);
    const after = await h.service.check(baseInput());
    assert.equal(after.allowed, true);
    assert.equal(fetchImpl.calls.length, 2); // unfrozen
  });

  it('retries with another key within one request and stops on HTTP 400', async () => {
    const statuses = [500, 200];
    let index = 0;
    const fetchImpl = fakeFetch(() => {
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (status === 200) return moderationResponse({ hate: 0.1 });
      return errorResponse(status);
    });
    const h = harness({ fetchImpl });
    h.store.rawConfig = configJson({ api_keys: ['key-a', 'key-b'], retry_count: 2 });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(fetchImpl.calls.length, 2);

    const bad = fakeFetch(() => errorResponse(400));
    const h2 = harness({ fetchImpl: bad });
    h2.store.rawConfig = configJson({ api_keys: ['key-a', 'key-b'], retry_count: 2 });
    await h2.service.check(baseInput());
    assert.equal(bad.calls.length, 1);
  });
});

describe('runtime snapshot caching', () => {
  it('serves the cached snapshot within the TTL and refreshes after it', async () => {
    const h = harness({ ttlMs: 1000 });
    h.store.rawConfig = configJson({ enabled: false });
    await h.service.check(baseInput());
    await h.service.check(baseInput());
    assert.equal(h.store.configReads, 1);
    h.advance(1500);
    await h.service.check(baseInput());
    // Stale-while-revalidate: the request was served from the stale snapshot,
    // and a background refresh ran.
    assert.ok(h.store.configReads >= 2);
  });

  it('rebuilds the keyword matcher only when the config digest changes', async () => {
    const h = harness({ ttlMs: 0 });
    h.store.rawConfig = configJson({ enabled: false });
    await h.service.check(baseInput());
    h.store.rawConfig = configJson({ enabled: false }); // identical content
    await h.service.check(baseInput());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.configReads, 2);
    // New keywords → digest changes → matcher rebuild. Stale-while-revalidate
    // serves the previous snapshot for the triggering request; the refreshed
    // snapshot (with the new matcher) applies from the next request on.
    h.store.rawConfig = configJson({ enabled: true, blocked_keywords: ['fresh-keyword'] });
    await h.service.check(baseInput({ body: { messages: [{ role: 'user', content: 'has fresh-keyword inside' }] } }));
    await new Promise((resolve) => setImmediate(resolve));
    const decision = await h.service.check(
      baseInput({ requestId: 'req-2', body: { messages: [{ role: 'user', content: 'has fresh-keyword inside' }] } }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'keyword_block');
  });

  it('defaults when no config row exists yet', async () => {
    const h = harness();
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
  });

  it('fails open on malformed config JSON', async () => {
    const h = harness();
    h.store.rawConfig = '{not json';
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, true);
    assert.equal(h.fetch.calls.length, 0);
  });
});

describe('auto-ban side effects', () => {
  function banHarness(banThreshold: number, counts: Record<string, number>) {
    const h = harness();
    h.store.rawConfig = configJson({ ban_threshold: banThreshold });
    h.store.counts = counts;
    h.store.contacts = { 'user-1': 'user@example.test' };
    return h;
  }

  it('counts violations but does not ban below the threshold', async () => {
    const h = banHarness(3, { 'user-1': 1 });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.equal(h.store.logs[0].violationCount, 2);
    assert.equal(h.store.logs[0].autoBanned, false);
    assert.equal(h.store.disabledUsers.length, 0);
    assert.equal(h.emailSender.sent.length, 1);
    assert.match(h.emailSender.sent[0].subject, /风控提醒/);
    assert.match(h.emailSender.sent[0].body, /触发详情/);
  });

  it('auto-bans at the threshold, writes an audit event and sends both emails', async () => {
    const h = banHarness(2, { 'user-1': 1 });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.deepEqual(h.store.disabledUsers, ['user-1']);
    assert.equal(h.store.logs[0].autoBanned, true);
    assert.equal(h.store.auditEvents.length, 1);
    assert.equal(h.store.auditEvents[0].action, 'saas.risk_control.user_auto_banned');
    assert.equal(h.store.auditEvents[0].targetId, 'user-1');
    assert.equal(h.emailSender.sent.length, 2);
    assert.match(h.emailSender.sent[1].subject, /Account Disabled/);
    assert.match(h.emailSender.sent[1].body, /封禁状态/);
    assert.equal(h.store.logs[0].emailSent, true);
  });

  it('does not double-ban when the user is already disabled', async () => {
    const h = banHarness(1, {});
    await h.service.check(baseInput({ requestId: 'r1' }));
    assert.equal(h.store.disabledUsers.length, 1);
    const h2 = banHarness(1, { 'user-1': 5 });
    h2.store.disabledUsers.push('user-1');
    await h2.service.check(baseInput({ requestId: 'r2' }));
    assert.equal(h2.store.logs[0].autoBanned, true);
    assert.equal(h2.store.auditEvents.length, 0);
  });

  it('skips side effects entirely for project-service keys (no user id)', async () => {
    const h = harness();
    h.store.rawConfig = configJson({});
    const decision = await h.service.check(baseInput({ userId: null }));
    assert.equal(decision.allowed, false);
    assert.equal(h.store.logs[0].violationCount, 0);
    assert.equal(h.store.disabledUsers.length, 0);
    assert.equal(h.emailSender.sent.length, 0);
  });

  it('survives email and ban failures without changing the decision', async () => {
    const h = banHarness(1, {});
    h.emailSender.error = new Error('smtp down');
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.equal(h.store.disabledUsers.length, 1);
  });

  it('survives a failing ban without changing the decision', async () => {
    const h = banHarness(1, {});
    h.store.disableRefuses = true;
    const decision = await h.service.check(baseInput());
    assert.equal(decision.allowed, false);
    assert.equal(h.store.logs[0].autoBanned, false);
  });
});

describe('decision shape', () => {
  it('uses the configured block status and message', async () => {
    const h = harness();
    h.store.rawConfig = configJson({ block_status: 451, block_message: 'custom notice' });
    const decision = await h.service.check(baseInput());
    assert.equal(decision.statusCode, 451);
    assert.equal(decision.message, 'custom notice');
  });
});
