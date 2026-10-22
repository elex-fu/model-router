import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyZhipuWindowUnit,
  cnNormalizeResetTime,
  minimaxQuotaUrl,
  parseKimiQuotaResponseBody,
  parseMinimaxQuotaResponseBody,
  parseZhipuQuotaData,
  parseZhipuQuotaResponseBody,
  zhipuQuotaUrl,
} from '../../../../src/saas/gateway/cn-providers/quota.js';

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function tier(tiers: readonly { window: string }[], window: string) {
  return tiers.find((candidate) => candidate.window === window) ?? null;
}

test('Kimi parses rolling detail and top-level weekly usage without relabeling reset order', () => {
  const result = parseKimiQuotaResponseBody(
    encode({
      limits: [
        { metadata: 'skip' },
        { detail: { limit: '100', remaining: '25', resetTime: '2026-10-22T12:00:00Z' } },
        { detail: { limit: 100, remaining: 0, resetTime: '2026-10-23T12:00:00Z' } },
      ],
      usage: { limit: 200, remaining: 40, resetTime: '2026-10-21T12:00:00Z' },
    }),
  );
  assert.deepEqual(result, {
    state: 'ok',
    result: {
      planLevel: '',
      tiers: [
        { window: '5h', usedPercent: 75, resetAt: '2026-10-22T12:00:00.000Z' },
        { window: 'weekly', usedPercent: 80, resetAt: '2026-10-21T12:00:00.000Z' },
      ],
    },
  });
});

test('Kimi keeps absent or invalid windows unknown, including zero capacity and missing remaining', () => {
  for (const detail of [
    undefined,
    {},
    { limit: 10 },
    { limit: 0, remaining: 0 },
    { limit: '', remaining: 0 },
    { limit: 10, remaining: -1 },
    { limit: false, remaining: 0 },
  ]) {
    const parsed = parseKimiQuotaResponseBody(encode({ limits: [{ detail }] }));
    assert.deepEqual(parsed, { state: 'ok', result: { tiers: [], planLevel: '' } });
  }
  const parsed = parseKimiQuotaResponseBody(encode({ usage: { limit: 10, remaining: 11 } }));
  assert.equal(parsed.state, 'ok');
  if (parsed.state === 'ok') assert.deepEqual(parsed.result.tiers, [{ window: 'weekly', usedPercent: 0, resetAt: '' }]);
  assert.equal(parseKimiQuotaResponseBody(new TextEncoder().encode('{broken')).state, 'error');
  assert.equal(cnNormalizeResetTime(Number.MAX_VALUE), '');
});

test('zhipu unit classification: 3 = 5h rolling, 6 = weekly', () => {
  assert.equal(classifyZhipuWindowUnit(3), '5h');
  assert.equal(classifyZhipuWindowUnit(6), 'weekly');
  assert.equal(classifyZhipuWindowUnit('3'), '5h');
  assert.equal(classifyZhipuWindowUnit(6.0), 'weekly');
  // Unknown / missing / other values fall to the heuristic.
  assert.equal(classifyZhipuWindowUnit(undefined), 'unknown');
  assert.equal(classifyZhipuWindowUnit(1), 'unknown');
  assert.equal(classifyZhipuWindowUnit(99), 'unknown');
  assert.equal(classifyZhipuWindowUnit('nope'), 'unknown');
});

test('zhipu parses a new-plan payload with explicit unit fields (3=5h, 6=weekly)', () => {
  const body = {
    success: true,
    data: {
      level: 'MAX',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 42.5, nextResetTime: 1_760_000_000_000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 71.2, nextResetTime: '2026-10-21T08:00:00Z' },
      ],
    },
  };
  const parsed = parseZhipuQuotaResponseBody(encode(body));
  assert.equal(parsed.state, 'ok');
  if (parsed.state !== 'ok') return;
  assert.equal(parsed.result.planLevel, 'MAX');
  const fiveHour = tier(parsed.result.tiers, '5h');
  const weekly = tier(parsed.result.tiers, 'weekly');
  assert.ok(fiveHour && weekly);
  assert.equal(fiveHour.usedPercent, 42.5);
  assert.equal(fiveHour.resetAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(weekly.usedPercent, 71.2);
  assert.equal(weekly.resetAt, '2026-10-21T08:00:00.000Z');
});

test('zhipu unit classification beats reset-time ordering (period-edge inversion guard)', () => {
  // At a period edge the WEEKLY window resets EARLIER than the 5h window; a
  // reset-time sort would label them backwards (sub2api issue #3036).
  const parsed = parseZhipuQuotaData({
    limits: [
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 95, nextResetTime: 1_760_001_000_000 },
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 10, nextResetTime: 1_760_002_000_000 },
    ],
  });
  assert.equal(parsed.state, 'ok');
  if (parsed.state !== 'ok') return;
  assert.equal(tier(parsed.result.tiers, '5h')?.usedPercent, 10);
  assert.equal(tier(parsed.result.tiers, 'weekly')?.usedPercent, 95);
});

test('zhipu unit-missing heuristic: no-reset first, then ascending reset, filling empty slots', () => {
  // A 0%-used 5h bucket may carry no reset; the weekly carries the later one.
  const parsed = parseZhipuQuotaData({
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 0 },
      { type: 'TOKENS_LIMIT', percentage: 33.3, nextResetTime: 1_760_000_000_000 },
    ],
  });
  assert.equal(parsed.state, 'ok');
  if (parsed.state !== 'ok') return;
  assert.equal(tier(parsed.result.tiers, '5h')?.usedPercent, 0);
  assert.equal(tier(parsed.result.tiers, '5h')?.resetAt, '');
  assert.equal(tier(parsed.result.tiers, 'weekly')?.usedPercent, 33.3);

  // Two reset-bearing entries without unit: ascending reset fills 5h first.
  const ascending = parseZhipuQuotaData({
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 50, nextResetTime: 1_760_005_000_000 },
      { type: 'TOKENS_LIMIT', percentage: 80, nextResetTime: 1_760_003_000_000 },
    ],
  });
  assert.equal(ascending.state, 'ok');
  if (ascending.state !== 'ok') return;
  assert.equal(tier(ascending.result.tiers, '5h')?.usedPercent, 80, 'earlier reset → 5h');
  assert.equal(tier(ascending.result.tiers, 'weekly')?.usedPercent, 50);
});

test('zhipu CREDIT_LIMIT competes only when no TOKENS_LIMIT exists', () => {
  // Both present: only TOKENS_LIMIT fills the slots (credit percent never
  // pollutes the threshold snapshot).
  const both = parseZhipuQuotaData({
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 40, nextResetTime: 1_760_000_000_000 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 60, nextResetTime: 1_760_100_000_000 },
      { type: 'CREDIT_LIMIT', percentage: 99.9 },
    ],
  });
  assert.equal(both.state, 'ok');
  if (both.state !== 'ok') return;
  assert.equal(both.result.tiers.length, 2);
  assert.equal(tier(both.result.tiers, '5h')?.usedPercent, 40);
  assert.equal(tier(both.result.tiers, 'weekly')?.usedPercent, 60);

  // Credit-only plan: degrades to CREDIT_LIMIT display.
  const creditOnly = parseZhipuQuotaData({
    limits: [{ type: 'CREDIT_LIMIT', percentage: 12.5, nextResetTime: 1_760_000_000_000 }],
  });
  assert.equal(creditOnly.state, 'ok');
  if (creditOnly.state !== 'ok') return;
  assert.equal(creditOnly.result.tiers.length, 1);
  assert.equal(tier(creditOnly.result.tiers, '5h')?.usedPercent, 12.5);
});

test('zhipu old-plan single TOKENS_LIMIT entry degrades to 5h only', () => {
  const parsed = parseZhipuQuotaData({
    limits: [{ type: 'TOKENS_LIMIT', percentage: 55, nextResetTime: 1_760_000_000_000 }],
  });
  assert.equal(parsed.state, 'ok');
  if (parsed.state !== 'ok') return;
  assert.equal(parsed.result.tiers.length, 1);
  assert.ok(tier(parsed.result.tiers, '5h'));
  assert.equal(tier(parsed.result.tiers, 'weekly'), null);
});

test('zhipu business errors and malformed payloads never produce a snapshot', () => {
  // HTTP 2xx with success=false.
  const business = parseZhipuQuotaResponseBody(encode({ success: false, msg: '当前用户不存在coding plan' }));
  assert.equal(business.state, 'error');
  if (business.state === 'error') assert.equal(business.errorCode, 'business_error');
  // Missing data object.
  const noData = parseZhipuQuotaResponseBody(encode({ success: true }));
  assert.equal(noData.state, 'error');
  // Invalid JSON.
  const invalid = parseZhipuQuotaResponseBody(new TextEncoder().encode('not json'));
  assert.equal(invalid.state, 'error');
  // Empty limits array: zero windows (no snapshot write).
  const empty = parseZhipuQuotaResponseBody(encode({ success: true, data: { limits: [] } }));
  assert.equal(empty.state, 'ok');
  if (empty.state === 'ok') assert.equal(empty.result.tiers.length, 0);
});

test('minimax converts remaining percentages into used percents for the general entry only', () => {
  const body = {
    base_resp: { status_code: 0, status_msg: '' },
    current_subscribe_title: 'MiniMax Coding Plan',
    model_remains: [
      {
        model_name: 'video',
        current_interval_remaining_percent: 90,
        end_time: 1_760_000_000_000,
      },
      {
        model_name: 'general',
        current_interval_remaining_percent: 62.5,
        end_time: 1_760_000_000_000,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 15,
        weekly_end_time: '2026-10-22T00:00:00Z',
      },
    ],
  };
  const parsed = parseMinimaxQuotaResponseBody(encode(body));
  assert.equal(parsed.state, 'ok');
  if (parsed.state !== 'ok') return;
  assert.equal(parsed.result.planLevel, 'MiniMax Coding Plan');
  const fiveHour = tier(parsed.result.tiers, '5h');
  const weekly = tier(parsed.result.tiers, 'weekly');
  assert.ok(fiveHour && weekly);
  // used = 100 − remaining.
  assert.equal(fiveHour.usedPercent, 37.5);
  assert.equal(fiveHour.resetAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(weekly.usedPercent, 85);
  assert.equal(weekly.resetAt, '2026-10-22T00:00:00.000Z');
});

test('minimax weekly tier appears only when current_weekly_status == 1', () => {
  const noWeekly = parseMinimaxQuotaResponseBody(
    encode({
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 100,
          end_time: 1_760_000_000_000,
          current_weekly_status: 0,
          current_weekly_remaining_percent: 0,
          weekly_end_time: 1_760_100_000_000,
        },
      ],
    }),
  );
  assert.equal(noWeekly.state, 'ok');
  if (noWeekly.state !== 'ok') return;
  assert.equal(noWeekly.result.tiers.length, 1);
  assert.equal(tier(noWeekly.result.tiers, '5h')?.usedPercent, 0);
  assert.equal(tier(noWeekly.result.tiers, 'weekly'), null);
});

test('minimax errors: base_resp status and missing general entry never produce a snapshot', () => {
  const business = parseMinimaxQuotaResponseBody(
    encode({ base_resp: { status_code: 1004, status_msg: 'invalid key' }, model_remains: [] }),
  );
  assert.equal(business.state, 'error');
  if (business.state === 'error') assert.equal(business.errorCode, 'base_resp_error');

  const noGeneral = parseMinimaxQuotaResponseBody(
    encode({
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: 'video', current_interval_remaining_percent: 50 }],
    }),
  );
  assert.equal(noGeneral.state, 'error');
  if (noGeneral.state === 'error') assert.equal(noGeneral.errorCode, 'general_not_found');

  // Over-remaining values clamp used at 0 (never negative percents).
  const clamp = parseMinimaxQuotaResponseBody(
    encode({
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 120, end_time: 1_760_000_000_000 }],
    }),
  );
  assert.equal(clamp.state, 'ok');
  if (clamp.state !== 'ok') return;
  assert.equal(tier(clamp.result.tiers, '5h')?.usedPercent, 0);
});

test('reset-time normalization accepts ISO strings and second/ms epochs', () => {
  assert.equal(cnNormalizeResetTime('2026-10-17T08:00:00Z'), '2026-10-17T08:00:00.000Z');
  assert.equal(cnNormalizeResetTime(1_760_000_000_000), new Date(1_760_000_000_000).toISOString());
  assert.equal(cnNormalizeResetTime(1_760_000_000), new Date(1_760_000_000_000).toISOString(), 'seconds epoch');
  assert.equal(cnNormalizeResetTime('1760000000000'), new Date(1_760_000_000_000).toISOString(), 'numeric string');
  assert.equal(cnNormalizeResetTime(0), '');
  assert.equal(cnNormalizeResetTime(-5), '');
  assert.equal(cnNormalizeResetTime(''), '');
  assert.equal(cnNormalizeResetTime(undefined), '');
  assert.equal(cnNormalizeResetTime('not-a-date'), '');
});

test('quota probe URL builders carry the team-plan and international variants', () => {
  assert.equal(zhipuQuotaUrl(), 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(zhipuQuotaUrl({ team: true }), 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2');
  assert.equal(zhipuQuotaUrl({ international: true }), 'https://api.z.ai/api/monitor/usage/quota/limit');
  assert.equal(
    zhipuQuotaUrl({ international: true, team: true }),
    'https://api.z.ai/api/monitor/usage/quota/limit?type=2',
  );
  assert.equal(minimaxQuotaUrl(), 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains');
  assert.equal(
    minimaxQuotaUrl({ international: true }),
    'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  );
});
