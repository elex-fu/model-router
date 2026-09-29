import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCost, selectPrice } from '../../src/telemetry/pricing.js';
import type { NormalizedUsage } from '../../src/telemetry/usage.js';

const usage: NormalizedUsage = {
  inputTotal: 1000,
  inputUncached: 800,
  cacheRead: 150,
  cacheWrite: 50,
  cacheWrite5m: null,
  cacheWrite1h: null,
  outputTotal: 200,
  reasoningOutput: null,
  status: 'reported',
  source: 'upstream',
  semanticsVersion: 'v1',
};

test('price calculation uses integer microcurrency and disjoint cache categories', () => {
  const result = estimateCost(usage, {
    id: 'v1',
    model: 'm',
    currency: 'USD',
    inputPerMillion: '2.50',
    cacheReadPerMillion: '0.25',
    cacheWritePerMillion: '3.00',
    outputPerMillion: '10.00',
  });
  assert.equal(result.costMicros, 4188);
  assert.equal(result.partial, false);
});

test('missing cache price never becomes a zero-price category', () => {
  const result = estimateCost(usage, {
    id: 'v1',
    model: 'm',
    currency: 'USD',
    inputPerMillion: 2.5,
    outputPerMillion: 10,
  });
  assert.equal(result.costMicros, null);
  assert.equal(result.reason, 'cache_price_missing');
});

test('price selection chooses effective and upstream-specific version', () => {
  const basic = { model: 'm', currency: 'USD', inputPerMillion: 1, outputPerMillion: 1 };
  const selected = selectPrice(
    [
      { id: 'old', ...basic, effectiveFrom: '2025-01-01T00:00:00Z' },
      { id: 'profile', versionId: 'pv_new', ...basic, upstreamId: 'up1', effectiveFrom: '2026-01-01T00:00:00Z' },
      { id: 'future', ...basic, effectiveFrom: '2027-01-01T00:00:00Z' },
    ],
    'm',
    'up1',
    'custom',
    Date.parse('2026-06-01T00:00:00Z'),
  );
  assert.equal(selected?.id, 'profile');
  assert.equal(estimateCost({ ...usage, inputUncached: 1000, cacheRead: 0, cacheWrite: 0 }, selected!).pricingVersion, 'pv_new');
});

test('equal effective times select the highest immutable version sequence', () => {
  const base = { id: 'same-profile', model: 'm', currency: 'USD', inputPerMillion: 1, outputPerMillion: 1,
    effectiveFrom: '2026-01-01T00:00:00Z' };
  const selected = selectPrice([
    { ...base, versionId: 'pv_older', versionSequence: 14 },
    { ...base, versionId: 'pv_newer', versionSequence: 15 },
  ], 'm', 'up', 'custom', Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(selected?.versionId, 'pv_newer');
});

test('TTL-classified cache writes use their separate rates with fixed-point arithmetic', () => {
  const result = estimateCost({ ...usage, cacheWrite5m: 20, cacheWrite1h: 30 }, {
    id: 'profile', versionId: 'pv_ttl', model: 'm', currency: 'USD',
    inputPerMillion: '2.50', cacheReadPerMillion: '0.25',
    cacheWrite5mPerMillion: '4.00', cacheWrite1hPerMillion: '6.00', outputPerMillion: '10.00',
  });
  assert.equal(result.pricingVersion, 'pv_ttl');
  assert.equal(result.costMicros, 4298);
  assert.equal(result.partial, false);
});

test('inclusive cache-write pricing charges those tokens once at the input rate', () => {
  const result = estimateCost(usage, {
    id: 'profile', model: 'm', currency: 'USD', inputPerMillion: '2.50',
    cacheReadPerMillion: '0.25', cacheWrite5mPerMillion: '4.00',
    cacheWriteIncludedInInput: true, outputPerMillion: '10.00',
  });
  assert.equal(result.costMicros, 4163);
  assert.equal(result.partial, false);
});

test('missing TTL classification or its required rate remains explicitly unknown', () => {
  const missingClassification = estimateCost(usage, {
    id: 'v2', model: 'm', currency: 'USD', inputPerMillion: 1,
    cacheReadPerMillion: 0, cacheWrite5mPerMillion: 2, cacheWrite1hPerMillion: 3, outputPerMillion: 1,
  });
  assert.equal(missingClassification.costMicros, null);
  assert.equal(missingClassification.reason, 'cache_write_classification_missing');

  const configuredTtlDoesNotFallBackToAggregate = estimateCost(usage, {
    id: 'v2-aggregate', model: 'm', currency: 'USD', inputPerMillion: 1,
    cacheReadPerMillion: 0, cacheWritePerMillion: 1,
    cacheWrite5mPerMillion: 2, cacheWrite1hPerMillion: 3, outputPerMillion: 1,
  });
  assert.equal(configuredTtlDoesNotFallBackToAggregate.costMicros, null);
  assert.equal(configuredTtlDoesNotFallBackToAggregate.reason, 'cache_write_classification_missing');

  const missingTtlRate = estimateCost({ ...usage, cacheWrite5m: 20, cacheWrite1h: 30 }, {
    id: 'v3', model: 'm', currency: 'USD', inputPerMillion: 1,
    cacheReadPerMillion: 0, cacheWrite5mPerMillion: 2, outputPerMillion: 1,
  });
  assert.equal(missingTtlRate.costMicros, null);
  assert.equal(missingTtlRate.reason, 'cache_price_missing');
});

test('basic profiles still estimate ordinary usage with absent cache-write semantics', () => {
  const result = estimateCost({ ...usage, inputUncached: null, cacheRead: null, cacheWrite: null }, {
    id: 'basic', model: 'm', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10,
  });
  assert.equal(result.costMicros, 4000);
  assert.equal(result.partial, true);

  const knownOrdinaryTokens = estimateCost({
    ...usage, inputUncached: 1000, cacheRead: 0, cacheWrite: null,
  }, { id: 'basic-known-input', model: 'm', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10 });
  assert.equal(knownOrdinaryTokens.costMicros, 4000);
  assert.equal(knownOrdinaryTokens.partial, true);
});

test('cache pricing does not treat an unreported cache category as zero', () => {
  const result = estimateCost({ ...usage, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }, {
    id: 'cache-priced', model: 'm', currency: 'USD', inputPerMillion: 2,
    cacheWritePerMillion: 1, outputPerMillion: 10,
  });
  assert.equal(result.costMicros, null);
  assert.equal(result.reason, 'cache_write_unknown');
});
