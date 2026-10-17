import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DispatchUsageSettlementCoordinator } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { calculateConservativePriceHold } from '../../../src/saas/gateway/hold-calculator.js';
import {
  createMediaUsageUpperBoundEstimator,
  imageSizeTierUpperBound,
  imageUnitsUpperBound,
} from '../../../src/saas/gateway/media-usage-estimator.js';
import { normalizeRates } from '../../../src/saas/pricing/index.js';
import type { CustomerPriceVersionRecord } from '../../../src/saas/pricing/types.js';
import { normalizeUsage } from '../../../src/telemetry/usage.js';

/**
 * Batch 4 §4.1 (task #15): the per-unit (media) hold envelope branch, the
 * media usage estimator that #16/#17 feed through, and the normal-success
 * usage evidence digest's zero-drift policy.
 */

const mediaVersion: CustomerPriceVersionRecord = {
  id: 'price-media-1',
  version: 1,
  kind: 'customer',
  publicModelId: 'public-model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  protocol: 'openai',
  endpoint: 'images.generations',
  currency: 'USD',
  commercialPolicyVersion: 'policy-1',
  calculatorVersion: 'calculator-1',
  roundingVersion: 'rounding-1',
  roundingMode: 'half_up',
  roundingBoundary: 'total',
  rates: normalizeRates({
    input: { numeratorMinorUnits: '0', denominatorUnits: '1' },
    output: { numeratorMinorUnits: '0', denominatorUnits: '1' },
    per_unit: { numeratorMinorUnits: '40000', denominatorUnits: '1000' },
    per_unit_tiers: {
      '1k': { numeratorMinorUnits: '11000', denominatorUnits: '1000' },
      '2k': { numeratorMinorUnits: '40000', denominatorUnits: '1000' },
      '4k': { numeratorMinorUnits: '167000', denominatorUnits: '1000' },
    },
  }),
  tokenMultipliers: null,
  effectiveAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  idempotencyKey: 'price-media-1',
  definitionDigest: 'a'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
};

test('4.1: the media envelope branch holds units × the tier rate', () => {
  const hold = calculateConservativePriceHold(mediaVersion, {
    perUnitUnitsUpperBound: '3',
    sizeTier: '2k',
  });
  // 3 units × 40 minor units = 120 reserved.
  assert.equal(hold.calculation.amountMinorUnits, 120n);
  assert.equal(hold.perUnitUnitsUpperBound, 3n);
  assert.deepEqual(hold.selectedPerUnitRate, { flat: false, tier: '2k' });
  // The witness carries the media facts so the snapshot freezes them.
  assert.equal(hold.witness.perUnitUnits, 3n);
  assert.equal(hold.witness.sizeTier, '2k');
  assert.equal(hold.witness.inputTotal, 0n);
  assert.equal(hold.witness.outputTotal, 0n);
});

test('4.1: an open tier holds against the most expensive tier rate (conservative max)', () => {
  const hold = calculateConservativePriceHold(mediaVersion, {
    perUnitUnitsUpperBound: '2',
    sizeTier: null,
  });
  // The 4k tier (167 minor units/unit) dominates: 2 × 167 = 334.
  assert.equal(hold.calculation.amountMinorUnits, 334n);
  assert.deepEqual(hold.selectedPerUnitRate, { flat: false, tier: '4k' });
});

test('4.1: a flat per_unit version holds units × the flat rate; a missing rate fails closed', () => {
  const flatVersion: CustomerPriceVersionRecord = {
    ...mediaVersion,
    rates: normalizeRates({
      input: { numeratorMinorUnits: '0', denominatorUnits: '1' },
      output: { numeratorMinorUnits: '0', denominatorUnits: '1' },
      per_unit: { numeratorMinorUnits: '1340', denominatorUnits: '10' },
    }),
  };
  const hold = calculateConservativePriceHold(flatVersion, {
    perUnitUnitsUpperBound: '1',
    sizeTier: null,
  });
  assert.equal(hold.calculation.amountMinorUnits, 134n);
  assert.deepEqual(hold.selectedPerUnitRate, { flat: true, tier: null });

  // No per-unit family at all: PRICE_RATE_MISSING, never a zero hold.
  const tokenVersion: CustomerPriceVersionRecord = {
    ...mediaVersion,
    rates: normalizeRates({
      input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
      output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
    }),
  };
  assert.throws(
    () =>
      calculateConservativePriceHold(tokenVersion, {
        perUnitUnitsUpperBound: '1',
        sizeTier: '1k',
      }),
    (error: unknown) => (error as { code?: string }).code === 'PRICE_RATE_MISSING',
  );
});

test('4.1: mixed media envelopes carry their token bounds into the witness', () => {
  const mixedVersion: CustomerPriceVersionRecord = {
    ...mediaVersion,
    rates: normalizeRates({
      input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
      output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
      per_unit: { numeratorMinorUnits: '5000', denominatorUnits: '1000' },
    }),
  };
  const hold = calculateConservativePriceHold(mixedVersion, {
    perUnitUnitsUpperBound: '4',
    sizeTier: null,
    inputUpperBound: '1000000',
    outputUpperBound: '1000000',
  });
  // 4 × 5 per-unit + 3 + 15 token = 38.
  assert.equal(hold.calculation.amountMinorUnits, 38n);
  assert.equal(hold.inputUpperBound, 1000000n);
  assert.equal(hold.outputUpperBound, 1000000n);
});

test('4.1: the media estimator bounds image generations (n × size tier)', () => {
  const estimator = createMediaUsageUpperBoundEstimator();
  assert.equal(imageUnitsUpperBound({}), 1);
  assert.equal(imageUnitsUpperBound({ n: 4 }), 4);
  assert.equal(imageSizeTierUpperBound({ size: '1024x1024' }), '1k');
  assert.equal(imageSizeTierUpperBound({ size: '1792x1024' }), '2k');
  assert.equal(imageSizeTierUpperBound({ size: '1024x2048' }), '4k');
  assert.equal(imageSizeTierUpperBound({ size: '1536x1024' }), '2k');
  assert.equal(imageSizeTierUpperBound({ size_tier: '720p' }), '720p');
  assert.equal(imageSizeTierUpperBound({}), null);

  const estimate = estimator.estimate({
    normalizedRequest: {
      providerOperation: 'images.generations' as never,
      body: { n: 2, size: '1024x1024' },
    },
  } as never) as {
    perUnitUnitsUpperBound: string;
    sizeTier?: string;
    inputTotalUpperBound: string;
    feasibleInputBuckets: readonly string[];
  };
  assert.equal(estimate.perUnitUnitsUpperBound, '2');
  assert.equal(estimate.sizeTier, '1k');
  assert.equal(estimate.inputTotalUpperBound, '0');
  assert.deepEqual(estimate.feasibleInputBuckets, ['input']);
  // Miscomposition is a closed failure.
  assert.throws(
    () =>
      estimator.estimate({
        normalizedRequest: { providerOperation: 'messages' as never, body: {} },
      } as never),
    /images\.generations/,
  );
});

test('4.1: telemetry normalizes media usage counters and tiers', () => {
  const imageUsage = normalizeUsage('openai', {
    input_tokens: 100,
    total_tokens: 100,
    output_tokens: 0,
    images: 2,
    size: '1024x1024',
  });
  assert.equal(imageUsage.billingMode, 'image');
  assert.equal(imageUsage.units, 2);
  assert.equal(imageUsage.sizeTier, '1k');
  assert.equal(imageUsage.status, 'reported');

  // A media report with no token counters at all is complete.
  const pure = normalizeUsage('openai', { images: 1, size_tier: '2k' });
  assert.equal(pure.status, 'reported');
  assert.equal(pure.billingMode, 'image');
  assert.equal(pure.units, 1);
  assert.equal(pure.sizeTier, '2k');

  // Token-only usage keeps the exact pre-4.1 shape.
  const token = normalizeUsage('openai', { prompt_tokens: 5, completion_tokens: 3 });
  assert.equal(token.billingMode, 'token');
  assert.equal(token.units, null);
  assert.equal(token.sizeTier, null);
  assert.equal(token.status, 'reported');
});

test('4.1 zero drift: normal-success usage evidence digests token-only usage exactly as pre-4.1', async () => {
  // BYOK completion computes the usage evidence digest internally and binds
  // it into the settlement transaction; capturing the transaction input
  // proves the token-only digest is byte-identical to the pre-4.1 form.
  let captured: { usageEvidenceRef?: string; usage?: Record<string, unknown> } | null = null;
  const pricing = {
    async getCustomerPriceVersion() {
      throw new Error('not reached');
    },
    async getCustomerPriceSnapshot() {
      throw new Error('not reached');
    },
  };
  const transaction = {
    async complete(input: { usageEvidenceRef: string; usage: Record<string, unknown> }) {
      captured = input;
      return { kind: 'settled' as const, attempt: {} };
    },
    async retainUnknown() {
      throw new Error('not reached');
    },
  };
  const coordinator = new DispatchUsageSettlementCoordinator(pricing as never, transaction as never);
  const { createHash } = await import('node:crypto');

  const tokenOnly = Object.freeze({
    ...normalizeUsage('openai', { prompt_tokens: 12, completion_tokens: 8 }),
    source: 'upstream',
  }) as never;
  await coordinator.complete({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    snapshot: {
      supplyMode: 'byok',
      providerProtocol: 'openai',
      customerPriceVersion: null,
      reservationId: null,
      priceSnapshotRef: null,
      currency: null,
      holdAmountMinorUnits: null,
      publicModelId: 'public-model-1',
      publicModelVersion: '1',
      providerId: 'provider-1',
      productId: 'product-1',
      endpoint: 'chat-completions',
      usageEstimatorVersion: 'estimator-v1',
    },
    usage: tokenOnly,
  });
  const pre41 = createHash('sha256')
    .update(
      'inputTotal=12&inputUncached=null&cacheRead=null&cacheWrite=null&cacheWrite5m=null&cacheWrite1h=null&outputTotal=8&reasoningOutput=null',
    )
    .digest('hex');
  assert.ok(captured);
  assert.equal(captured.usageEvidenceRef, pre41, 'token-only usage evidence digest must not drift');
  // The recorded usage event carries the neutral media fields.
  assert.equal(captured.usage?.billingMode, 'token');
  assert.equal(captured.usage?.units, null);
  assert.equal(captured.usage?.sizeTier, null);

  // A media observation appends its fields after the legacy eight.
  const mediaUsage = Object.freeze({
    ...normalizeUsage('openai', { images: 4, size: '1792x1024' }),
    source: 'upstream',
  }) as never;
  await coordinator.complete({
    tenantId: 'tenant-1',
    requestId: 'request-2',
    attemptId: 'attempt-2',
    snapshot: {
      supplyMode: 'byok',
      providerProtocol: 'openai',
      customerPriceVersion: null,
      reservationId: null,
      priceSnapshotRef: null,
      currency: null,
      holdAmountMinorUnits: null,
      publicModelId: 'public-model-1',
      publicModelVersion: '1',
      providerId: 'provider-1',
      productId: 'product-1',
      endpoint: 'images.generations',
      usageEstimatorVersion: 'media-usage-upper-bound/v1',
    },
    usage: mediaUsage,
  });
  const mediaDigest = createHash('sha256')
    .update(
      'inputTotal=null&inputUncached=null&cacheRead=null&cacheWrite=null&cacheWrite5m=null&cacheWrite1h=null&outputTotal=null&reasoningOutput=null' +
        '&billingMode=image&units=4&sizeTier=2k',
    )
    .digest('hex');
  assert.ok(captured);
  assert.equal(captured.usageEvidenceRef, mediaDigest);
  assert.equal(captured.usage?.billingMode, 'image');
  assert.equal(captured.usage?.units, 4n);
  assert.equal(captured.usage?.sizeTier, '2k');
});
