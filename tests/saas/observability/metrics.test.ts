import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  beginGatewayInflightRequest,
  getSaasMetricsRegistry,
  recordGatewayAttemptOutcome,
  recordGatewayRequestEnd,
  renderSaasMetrics,
  SAAS_GATEWAY_ATTEMPT_DURATION_SECONDS,
  SAAS_GATEWAY_INFLIGHT_REQUESTS,
  SAAS_GATEWAY_REQUESTS_TOTAL,
  SAAS_PROVIDER_ACCOUNT_POOL,
  SAAS_WALLET_ACTIVE_HOLDS,
  setSaasProviderPoolCounts,
  setSaasWalletActiveHolds,
} from '../../../src/saas/observability/metrics.js';

test('metrics registry exposes the gateway metric families', () => {
  const registry = getSaasMetricsRegistry();
  assert.equal(registry, getSaasMetricsRegistry());
  for (const name of [
    SAAS_GATEWAY_REQUESTS_TOTAL,
    SAAS_GATEWAY_ATTEMPT_DURATION_SECONDS,
    SAAS_GATEWAY_INFLIGHT_REQUESTS,
    SAAS_PROVIDER_ACCOUNT_POOL,
    SAAS_WALLET_ACTIVE_HOLDS,
  ]) {
    assert.ok(registry.getSingleMetric(name), `expected ${name} to be registered`);
  }
});

test('renderSaasMetrics produces Prometheus text exposition', async () => {
  recordGatewayRequestEnd('/v1/messages', 200);
  recordGatewayRequestEnd('/v1/messages', 500);
  recordGatewayAttemptOutcome({ route: 'route-1', ok: true, durationMs: 1500 });
  const text = await renderSaasMetrics();
  assert.match(text, /# HELP saas_gateway_requests_total /);
  assert.match(text, /saas_gateway_requests_total\{endpoint="\/v1\/messages",status="200"\} [1-9]\d*/);
  assert.match(text, /saas_gateway_requests_total\{endpoint="\/v1\/messages",status="500"\} [1-9]\d*/);
  assert.match(text, /saas_gateway_attempt_duration_seconds_bucket\{le="1",route="route-1"\} \d+/);
  assert.match(text, /saas_gateway_attempt_duration_seconds_count\{route="route-1"\} [1-9]\d*/);
});

test('request counter normalizes unknown endpoints and invalid statuses', async () => {
  recordGatewayRequestEnd('/v1/unknown', 200);
  recordGatewayRequestEnd('/v1/messages', Number.NaN);
  const text = await renderSaasMetrics();
  assert.match(text, /saas_gateway_requests_total\{endpoint="other",status="200"\}/);
  assert.match(text, /saas_gateway_requests_total\{endpoint="\/v1\/messages",status="0"\}/);
});

test('in-flight gauge rises and falls exactly once per begin/end pair', async () => {
  const before = await currentGaugeValue(SAAS_GATEWAY_INFLIGHT_REQUESTS);
  const endOne = beginGatewayInflightRequest();
  const endTwo = beginGatewayInflightRequest();
  const during = await currentGaugeValue(SAAS_GATEWAY_INFLIGHT_REQUESTS);
  assert.equal(during, before + 2);
  endOne();
  endOne(); // Idempotent: a second close must not double-decrement.
  const between = await currentGaugeValue(SAAS_GATEWAY_INFLIGHT_REQUESTS);
  assert.equal(between, before + 1);
  endTwo();
  const after = await currentGaugeValue(SAAS_GATEWAY_INFLIGHT_REQUESTS);
  assert.equal(after, before);
});

test('attempt outcome falls back to the unrouted label and drives the qps feed', async () => {
  recordGatewayAttemptOutcome({ route: '  ', ok: false, durationMs: 10 });
  const text = await renderSaasMetrics();
  assert.match(text, /saas_gateway_attempt_duration_seconds_count\{route="unrouted"\}/);
});

test('runtime gauges render pool states and wallet holds', async () => {
  setSaasProviderPoolCounts('kimi', { available: 3, cooldown: 1, 'quota-paused': 2, error: 0 });
  setSaasWalletActiveHolds(7);
  const text = await renderSaasMetrics();
  assert.match(text, /saas_provider_account_pool\{provider="kimi",state="available"\} 3/);
  assert.match(text, /saas_provider_account_pool\{provider="kimi",state="cooldown"\} 1/);
  assert.match(text, /saas_provider_account_pool\{provider="kimi",state="quota-paused"\} 2/);
  assert.match(text, /saas_provider_account_pool\{provider="kimi",state="error"\} 0/);
  assert.match(text, /saas_wallet_active_holds 7/);
});

async function currentGaugeValue(name: string): Promise<number> {
  const metric = await getSaasMetricsRegistry().getSingleMetric(name).get();
  if (typeof metric === 'object' && metric !== null && 'values' in metric) {
    const values = (metric as { values: Array<{ value: number }> }).values;
    return values.length === 1 ? values[0].value : values.reduce((sum, entry) => sum + entry.value, 0);
  }
  throw new Error(`unexpected metric shape for ${name}`);
}
