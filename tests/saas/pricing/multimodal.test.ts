import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { modelPricingOverrideDigest } from '../../../src/saas/billing/groups/override.js';
import { canonicalUsage } from '../../../src/saas/metering/digest.js';
import type { NormalizedUsageExact } from '../../../src/saas/metering/types.js';
import { calculatePrice, calculateUsageSettlement, normalizeRates } from '../../../src/saas/pricing/index.js';
import {
  computeEffectiveTokenMultipliers,
  longContextMultiplier,
  normalizeTokenMultiplierPolicy,
  resolveBillingServiceTier,
  serviceTierMultiplier,
  tokenMultiplierPolicyDigestMaterial,
} from '../../../src/saas/pricing/multipliers.js';
import type {
  CommercialPriceVersionRecordBase,
  CustomerPriceVersionRecord,
  TokenUsageInput,
} from '../../../src/saas/pricing/types.js';

/**
 * Batch 4 §4.1 (task #15) multimodal billing: the per_unit calculator
 * branch, the tier ladder, the token-path multipliers (service tier +
 * long context), and the digest anti-drift reproductions that prove every
 * pre-4.1 digest is byte-identical to its recomputation.
 */

const tokenUsage = (overrides: Partial<TokenUsageInput> = {}): TokenUsageInput => ({
  inputTotal: '1000000',
  inputUncached: null,
  cacheRead: null,
  cacheWrite: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  outputTotal: '1000000',
  reasoningOutput: null,
  ...overrides,
});

const mediaRates = normalizeRates({
  // Zero token rates: a pure per-unit price version still needs its token
  // pair (schema NOT NULL), priced at zero.
  input: { numeratorMinorUnits: '0', denominatorUnits: '1' },
  output: { numeratorMinorUnits: '0', denominatorUnits: '1' },
  per_unit: { numeratorMinorUnits: '40000', denominatorUnits: '1000' },
  per_unit_tiers: {
    '1k': { numeratorMinorUnits: '11000', denominatorUnits: '1000' },
    '2k': { numeratorMinorUnits: '40000', denominatorUnits: '1000' },
    '4k': { numeratorMinorUnits: '167000', denominatorUnits: '1000' },
  },
});

function version(overrides: Partial<CommercialPriceVersionRecordBase> = {}): CustomerPriceVersionRecord {
  return {
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
    rates: mediaRates,
    tokenMultipliers: null,
    effectiveAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    idempotencyKey: 'price-media-1',
    definitionDigest: 'a'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

test('4.1: per-unit usage charges units × the flat per_unit rate', () => {
  const calculation = calculatePrice(
    mediaRates,
    tokenUsage({ inputTotal: null, outputTotal: null, perUnitUnits: '3' }),
    { roundingMode: 'half_up' },
  );
  assert.deepEqual(calculation.chargedMetrics, ['per_unit']);
  // 3 units × 40000/1000 minor units = 120.
  assert.equal(calculation.amountMinorUnits, 120n);
  assert.equal(calculation.complete, true);
  // The unrounded rational is exact.
  assert.equal(calculation.unroundedNumerator / calculation.unroundedDenominator, 120n);
});

test('4.1: a size tier selects its tier rate; an unpriced tier fails closed', () => {
  const billed = calculatePrice(
    mediaRates,
    tokenUsage({ inputTotal: null, outputTotal: null, perUnitUnits: '2', sizeTier: '4k' }),
    { roundingMode: 'half_up' },
  );
  // 2 units × 167000/1000 = 334.
  assert.equal(billed.amountMinorUnits, 334n);
  assert.deepEqual(billed.chargedMetrics, ['per_unit']);

  // A tier the version does not price is a billing error, never a zero charge.
  assert.throws(
    () =>
      calculatePrice(
        mediaRates,
        tokenUsage({ inputTotal: null, outputTotal: null, perUnitUnits: '2', sizeTier: '720p' }),
        { roundingMode: 'half_up' },
      ),
    (error: unknown) => (error as { code?: string }).code === 'PRICE_RATE_MISSING',
  );
});

test('4.1: media usage with no token counters is complete, not unknown', () => {
  const calculation = calculatePrice(
    mediaRates,
    tokenUsage({
      inputTotal: null,
      outputTotal: null,
      perUnitUnits: '1',
      sizeTier: '1k',
    }),
    { roundingMode: 'half_up' },
  );
  assert.equal(calculation.complete, true);
  assert.deepEqual(calculation.unknownMetrics, []);
  assert.equal(calculation.amountMinorUnits, 11n);
});

test('4.1: mixed per-unit + token usage bills both terms', () => {
  const mixedRates = normalizeRates({
    input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
    output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
    per_unit: { numeratorMinorUnits: '5000', denominatorUnits: '1000' },
  });
  const calculation = calculatePrice(
    mixedRates,
    tokenUsage({ inputTotal: '1000000', outputTotal: '1000000', perUnitUnits: '4' }),
    { roundingMode: 'half_up' },
  );
  // 3 + 15 token minor units + 4 × 5 per-unit minor units = 38.
  assert.deepEqual(calculation.chargedMetrics, ['per_unit', 'input', 'output']);
  assert.equal(calculation.amountMinorUnits, 38n);
});

test('4.1: zero per-unit units charge nothing and stay complete', () => {
  const calculation = calculatePrice(
    mediaRates,
    tokenUsage({ inputTotal: null, outputTotal: null, perUnitUnits: '0' }),
    { roundingMode: 'half_up' },
  );
  assert.deepEqual(calculation.chargedMetrics, []);
  assert.equal(calculation.amountMinorUnits, 0n);
  assert.equal(calculation.complete, true);
});

test('4.1: calculateUsageSettlement passes the service-tier terms to both sides', () => {
  const withMultipliers = version({
    rates: normalizeRates({
      input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
      output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
    }),
    tokenMultipliers: normalizeTokenMultiplierPolicy({
      serviceTiers: { priority: { numerator: '2', denominator: '1' }, flex: { numerator: '1', denominator: '2' } },
    }),
  });
  const settlement = calculateUsageSettlement({
    customerPrice: withMultipliers,
    supplierCost: withMultipliers,
    usage: tokenUsage({ inputTotal: '1000000', outputTotal: '1000000' }),
    serviceTier: { requested: 'priority', observed: 'flex' },
  });
  // Base: 3 + 15 = 18 minor units; flex (the cheaper observed tier) halves
  // the whole bill: 9.
  assert.equal(settlement.customer.amountMinorUnits, 9n);
  assert.equal(settlement.supplier.amountMinorUnits, 9n);
});

test('service tiers: the observed tier can only lower the bill (sub2api rule)', () => {
  // Same tier: unchanged.
  assert.deepEqual(resolveBillingServiceTier('priority', 'priority'), {
    requested: 'priority',
    observed: 'priority',
    billing: 'priority',
    downgraded: false,
  });
  // A cheaper observed tier wins (OpenAI priority answered with default).
  assert.deepEqual(resolveBillingServiceTier('priority', 'default'), {
    requested: 'priority',
    observed: 'default',
    billing: 'default',
    downgraded: true,
  });
  // A more expensive observed tier never raises the bill.
  assert.deepEqual(resolveBillingServiceTier('default', 'priority'), {
    requested: 'default',
    observed: 'priority',
    billing: 'default',
    downgraded: false,
  });
  // An unknown observed tier is ignored (billed at the requested tier).
  assert.deepEqual(resolveBillingServiceTier('default', 'mystery'), {
    requested: 'default',
    observed: 'mystery',
    billing: 'default',
    downgraded: false,
  });
  // No observation at all bills the requested tier.
  assert.deepEqual(resolveBillingServiceTier('flex', ''), {
    requested: 'flex',
    observed: '',
    billing: 'flex',
    downgraded: false,
  });
  // Case and spacing normalize.
  assert.equal(resolveBillingServiceTier(' Priority ', 'FLEX').billing, 'flex');
});

test('service tiers: unlisted tiers are neutral multipliers, listed tiers are exact rationals', () => {
  const policy = normalizeTokenMultiplierPolicy({
    serviceTiers: { flex: { numerator: '1', denominator: '2' } },
  });
  assert.ok(policy !== null);
  assert.equal(serviceTierMultiplier('flex', policy).numerator, 1n);
  assert.equal(serviceTierMultiplier('flex', policy).denominator, 2n);
  // Unlisted → neutral.
  assert.deepEqual(serviceTierMultiplier('priority', policy), { numerator: 1n, denominator: 1n });
  // Unknown tier names are rejected at policy normalization, not silently priced.
  assert.throws(
    () => normalizeTokenMultiplierPolicy({ serviceTiers: { turbo: { numerator: '2', denominator: '1' } } }),
    TypeError,
  );
  // An empty policy normalizes to null (multipliers off, digest-omitted).
  assert.equal(normalizeTokenMultiplierPolicy({}), null);
  assert.equal(normalizeTokenMultiplierPolicy(null), null);
});

test('long context: the whole session reprices above the threshold, never just the excess', () => {
  const policy = normalizeTokenMultiplierPolicy({
    longContext: {
      inputThreshold: '200000',
      thresholdInclusive: false,
      inputMultiplier: { numerator: '2', denominator: '1' },
      outputMultiplier: { numerator: '2', denominator: '1' },
    },
  });
  assert.ok(policy !== null);
  // Strictly above (Claude semantics): applied.
  assert.ok(longContextMultiplier(200001n, policy) !== null);
  // Exactly at the threshold: NOT applied (strict >).
  assert.equal(longContextMultiplier(200000n, policy), null);
  // Below: not applied.
  assert.equal(longContextMultiplier(199999n, policy), null);

  // Inclusive threshold (xAI semantics): applied at exactly the threshold.
  const inclusive = normalizeTokenMultiplierPolicy({
    longContext: {
      inputThreshold: '200000',
      thresholdInclusive: true,
      inputMultiplier: { numerator: '2', denominator: '1' },
      outputMultiplier: { numerator: '3', denominator: '2' },
    },
  });
  assert.ok(inclusive !== null);
  const atThreshold = longContextMultiplier(200000n, inclusive);
  assert.ok(atThreshold !== null);
  assert.equal(atThreshold.inputMultiplier.numerator, 2n);
  assert.equal(atThreshold.outputMultiplier.numerator, 3n);
  assert.equal(atThreshold.outputMultiplier.denominator, 2n);
});

test('long context + service tier multiply exactly (input and output independently)', () => {
  const policy = normalizeTokenMultiplierPolicy({
    serviceTiers: { priority: { numerator: '2', denominator: '1' } },
    longContext: {
      inputThreshold: '200000',
      thresholdInclusive: false,
      inputMultiplier: { numerator: '2', denominator: '1' },
      outputMultiplier: { numerator: '3', denominator: '2' },
    },
  });
  assert.ok(policy !== null);
  const multipliers = computeEffectiveTokenMultipliers({
    policy,
    billedInputTokens: 250000n,
    requestedServiceTier: 'priority',
    observedServiceTier: null,
  });
  // Input: priority 2/1 × long-context 2/1 = 4/1. Output: 2/1 × 3/2 = 3/1.
  assert.equal(multipliers.input.numerator / multipliers.input.denominator, 4n);
  assert.equal(multipliers.output.numerator / multipliers.output.denominator, 3n);
  assert.equal(multipliers.longContextApplied, true);

  // The calculator applies them per metric family.
  const withPolicy = version({
    rates: normalizeRates({
      input: { numeratorMinorUnits: '3', denominatorUnits: '1' },
      output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
    }),
    tokenMultipliers: policy,
  });
  const calculation = calculatePrice(withPolicy.rates, tokenUsage({ inputTotal: '250000', outputTotal: '1' }), {
    roundingMode: 'half_up',
    tokenMultipliers: withPolicy.tokenMultipliers,
    serviceTier: { requested: 'priority', observed: null },
  });
  // 250000 × 3 × 4 = 3000000 input + 1 × 4 × 3 = 12 output.
  assert.equal(calculation.amountMinorUnits, 3000012n);
});

test('4.1 zero drift: a token-only calculation without a policy is byte-identical to pre-4.1', () => {
  const rates = normalizeRates({
    input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
    cache_read: { numeratorMinorUnits: '1', denominatorUnits: '1000000' },
    output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
  });
  const calculation = calculatePrice(rates, tokenUsage(), { roundingMode: 'half_up' });
  // The pre-4.1 golden for 1M input + 1M output at 3/1M and 15/1M.
  assert.equal(calculation.amountMinorUnits, 18n);
  assert.deepEqual(calculation.chargedMetrics, ['input', 'output']);
  // The cache-read path with a breakdown also keeps its exact pre-4.1 value.
  const breakdown = calculatePrice(
    rates,
    tokenUsage({
      inputTotal: '1000000',
      inputUncached: '700000',
      cacheRead: '300000',
    }),
    { roundingMode: 'half_up' },
  );
  // 700000×3/1M + 300000×1/1M + 1000000×15/1M = 2.1 + 0.3 + 15 = 17.4 →
  // 17 (half_up rounds the 0.4 remainder down).
  assert.equal(breakdown.amountMinorUnits, 17n);
});

test('4.1 zero drift: canonicalUsage appends media fields only for media usage', () => {
  const tokenUsageExact: NormalizedUsageExact = {
    inputTotal: '12',
    inputUncached: '12',
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: '8',
    reasoningOutput: null,
    billingMode: 'token',
    units: null,
    sizeTier: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'provider-usage-v1',
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
  // The exact pre-4.1 canonical form (13 trailing fields, no media group).
  const legacyForm = JSON.stringify([
    '12',
    '12',
    null,
    null,
    null,
    null,
    '8',
    null,
    'reported',
    'upstream',
    'provider-usage-v1',
    'snapshot',
    'exact',
  ]);
  assert.equal(canonicalUsage(tokenUsageExact), legacyForm);
  // Absent media fields (older callers) resolve to the same token-only form.
  const { billingMode: _b, units: _u, sizeTier: _s, ...legacyShaped } = tokenUsageExact;
  assert.equal(
    canonicalUsage(legacyShaped as NormalizedUsageExact),
    legacyForm,
    'undefined media fields must digest exactly like token-only',
  );
  // Media usage appends the three fields as one trailing group.
  const mediaUsage: NormalizedUsageExact = {
    ...tokenUsageExact,
    inputTotal: null,
    inputUncached: null,
    outputTotal: null,
    billingMode: 'image',
    units: '4',
    sizeTier: '2k',
  };
  assert.equal(
    canonicalUsage(mediaUsage),
    JSON.stringify([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'reported',
      'upstream',
      'provider-usage-v1',
      'snapshot',
      'exact',
      'image',
      '4',
      '2k',
    ]),
  );
  // The usage event digest over the same identity is stable per policy.
  const digestOf = (usage: NormalizedUsageExact) =>
    createHash('sha256')
      .update(JSON.stringify(['tenant-1', 'request-1', 'attempt-1', 'platform', canonicalUsage(usage)]))
      .digest('hex');
  assert.equal(
    digestOf(legacyShaped as NormalizedUsageExact),
    digestOf(tokenUsageExact),
    'token-only digests must not drift across the 4.1 field addition',
  );
});

test('4.1 zero drift: the override digest recomputes a pre-4.1 override byte-identically', () => {
  // The pre-4.1 codec's canonical six-key JSON shape.
  const legacyCanonicalRates = {
    input: { num: '3', den: '1000000' },
    cache_read: null,
    cache_write: null,
    cache_write_5m: null,
    cache_write_1h: null,
    output: { num: '15', den: '1000000' },
  };
  const legacyDigest = createHash('sha256')
    .update(JSON.stringify({ model: 'public-model-1', rates: legacyCanonicalRates }))
    .digest('hex');
  // The same rates, in calculator input shape, digest identically today.
  const rates = normalizeRates({
    input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
    cache_read: null,
    cache_write: null,
    cache_write_5m: null,
    cache_write_1h: null,
    output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
  });
  assert.equal(modelPricingOverrideDigest('public-model-1', rates), legacyDigest);
  // An override carrying per_unit keeps it in the digest (no collision).
  const withPerUnit = normalizeRates({
    input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
    output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
    per_unit: { numeratorMinorUnits: '1000', denominatorUnits: '1' },
  });
  assert.notEqual(modelPricingOverrideDigest('public-model-1', withPerUnit), legacyDigest);
});

test('4.1 zero drift: a null multiplier policy is omitted from the digest material', () => {
  assert.equal(tokenMultiplierPolicyDigestMaterial(null), null);
  assert.equal(tokenMultiplierPolicyDigestMaterial(normalizeTokenMultiplierPolicy({})), null);
  // A real policy serializes sorted, decimal-stringed and canonical.
  const material = tokenMultiplierPolicyDigestMaterial(
    normalizeTokenMultiplierPolicy({
      serviceTiers: { flex: { numerator: '1', denominator: '2' }, priority: { numerator: '2', denominator: '1' } },
      longContext: {
        inputThreshold: '200000',
        thresholdInclusive: true,
        inputMultiplier: { numerator: '2', denominator: '1' },
        outputMultiplier: { numerator: '3', denominator: '2' },
      },
    }),
  );
  assert.deepEqual(Object.keys(material?.serviceTiers ?? {}), ['flex', 'priority']);
  assert.equal(material?.longContext?.inputThreshold, '200000');
  assert.equal(material?.longContext?.thresholdInclusive, true);
});
