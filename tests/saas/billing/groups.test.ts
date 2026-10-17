import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSaasBillingGroupsError, SaasBillingGroupsError } from '../../../src/saas/billing/groups/errors.js';
import {
  composeGroupMultiplier,
  computeTopupCredit,
  evaluateProfitControl,
  isWithinPeakWindow,
  multiplyMinorUnits,
  multiplyRational,
  parseTopupAmountTierDiscounts,
  resolveBillingGroupId,
  TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY,
} from '../../../src/saas/billing/groups/multiplier.js';
import {
  modelPricingOverrideDigest,
  parseAppliedModelPricingOverride,
  parseModelPricingJson,
  resolveModelPricingOverride,
  serializeAppliedModelPricingOverride,
} from '../../../src/saas/billing/groups/override.js';
import { mapBillingGroupRow } from '../../../src/saas/billing/groups/record.js';
import { SaasBillingGroupsService } from '../../../src/saas/billing/groups/service.js';
import { snapshotBillingGroupTerms } from '../../../src/saas/billing/groups/snapshot.js';
import type { BillingGroupRecord, RationalMultiplier } from '../../../src/saas/billing/groups/types.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type {
  NormalSuccessSettlementSnapshot,
  NormalSuccessTransactionInput,
  NormalSuccessTransactionPort,
} from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { DispatchUsageSettlementCoordinator } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { normalizeRates } from '../../../src/saas/pricing/calculator.js';
import type {
  CustomerPriceSnapshotRecord,
  CustomerPriceVersionRecord,
  RateSetInput,
} from '../../../src/saas/pricing/types.js';
import type { NormalizedUsage } from '../../../src/telemetry/usage.js';

const HALF: RationalMultiplier = { numerator: 1n, denominator: 2n };

function utcDate(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 9, 15, hour, minute, 0));
}

function group(overrides: Partial<BillingGroupRecord> = {}): BillingGroupRecord {
  return {
    id: 'vip',
    displayName: 'VIP',
    rateMultiplier: { numerator: 3n, denominator: 2n },
    topupMultiplier: { numerator: 11n, denominator: 10n },
    peakEnabled: false,
    peak: null,
    modelPricing: new Map(),
    rpmLimit: null,
    dailyLimitMinorUnits: null,
    weeklyLimitMinorUnits: null,
    monthlyLimitMinorUnits: null,
    profitMinMargin: null,
    profitSafetyBuffer: null,
    claudeCodeOnly: false,
    fallbackGroupId: null,
    supportedModelScopes: null,
    composite: false,
    status: 'active',
    ...overrides,
  };
}

test('multiplyMinorUnits is exact rational math with mode-sensitive rounding', () => {
  assert.equal(multiplyMinorUnits(7n, { numerator: 3n, denominator: 2n }, 'ceil'), 11n);
  assert.equal(multiplyMinorUnits(7n, { numerator: 3n, denominator: 2n }, 'floor'), 10n);
  assert.equal(multiplyMinorUnits(7n, { numerator: 3n, denominator: 2n }, 'half_up'), 11n);
  assert.equal(multiplyMinorUnits(4n, { numerator: 3n, denominator: 2n }, 'half_up'), 6n);
  assert.equal(multiplyMinorUnits(10n, HALF, 'floor'), 5n);
  assert.equal(multiplyMinorUnits(11n, HALF, 'floor'), 5n);
  assert.equal(multiplyMinorUnits(11n, HALF, 'ceil'), 6n);
  // Reduction keeps intermediate products small; 2/4 === 1/2.
  assert.equal(multiplyMinorUnits(10n, { numerator: 2n, denominator: 4n }, 'floor'), 5n);
  // The neutral multiplier is the identity for every mode.
  for (const mode of ['floor', 'ceil', 'half_up', 'half_even'] as const) {
    assert.equal(multiplyMinorUnits(123n, { numerator: 1n, denominator: 1n }, mode), 123n);
  }
  assert.throws(() => multiplyMinorUnits(1n, { numerator: 0n, denominator: 1n }, 'ceil'), SaasBillingGroupsError);
  assert.throws(() => multiplyMinorUnits(1n, { numerator: 1n, denominator: 0n }, 'ceil'), SaasBillingGroupsError);
  assert.throws(() => multiplyMinorUnits(1n, { numerator: -1n, denominator: 1n }, 'ceil'), SaasBillingGroupsError);
});

test('multiplyRational reduces exact rational products', () => {
  assert.deepEqual(multiplyRational({ numerator: 3n, denominator: 4n }, { numerator: 2n, denominator: 3n }), {
    numerator: 1n,
    denominator: 2n,
  });
  assert.deepEqual(multiplyRational(HALF, HALF), { numerator: 1n, denominator: 4n });
});

test('peak windows are half-open UTC windows and wrap midnight; equal bounds never apply', () => {
  const nineToEighteen = { start: 9 * 3600, end: 18 * 3600 };
  assert.equal(isWithinPeakWindow(utcDate(9), nineToEighteen.start, nineToEighteen.end), true);
  assert.equal(isWithinPeakWindow(utcDate(8, 59), nineToEighteen.start, nineToEighteen.end), false);
  assert.equal(isWithinPeakWindow(utcDate(18), nineToEighteen.start, nineToEighteen.end), false);
  assert.equal(isWithinPeakWindow(utcDate(17, 59), nineToEighteen.start, nineToEighteen.end), true);
  // Overnight window 22:00 -> 06:00.
  assert.equal(isWithinPeakWindow(utcDate(23), 22 * 3600, 6 * 3600), true);
  assert.equal(isWithinPeakWindow(utcDate(3), 22 * 3600, 6 * 3600), true);
  assert.equal(isWithinPeakWindow(utcDate(6), 22 * 3600, 6 * 3600), false);
  assert.equal(isWithinPeakWindow(utcDate(12), 22 * 3600, 6 * 3600), false);
  // start === end is an empty window (never applies).
  assert.equal(isWithinPeakWindow(utcDate(12), 5 * 3600, 5 * 3600), false);
});

test('composeGroupMultiplier multiplies group rate by peak only inside the window', () => {
  const peakGroup = group({
    peakEnabled: true,
    peak: { startSecondsUtc: 9 * 3600, endSecondsUtc: 18 * 3600, multiplier: { numerator: 5n, denominator: 4n } },
  });
  const offPeak = composeGroupMultiplier(peakGroup, utcDate(20));
  assert.equal(offPeak.peakApplied, false);
  assert.deepEqual(offPeak.multiplier, { numerator: 3n, denominator: 2n });
  const onPeak = composeGroupMultiplier(peakGroup, utcDate(12));
  assert.equal(onPeak.peakApplied, true);
  assert.deepEqual(onPeak.multiplier, { numerator: 15n, denominator: 8n });
  // Peak disabled never applies even with a configured window.
  const disabled = composeGroupMultiplier(
    group({ peak: { startSecondsUtc: 0, endSecondsUtc: 86400, multiplier: { numerator: 2n, denominator: 1n } } }),
    utcDate(12),
  );
  assert.equal(disabled.peakApplied, false);
  assert.deepEqual(disabled.multiplier, { numerator: 3n, denominator: 2n });
});

test('resolveBillingGroupId follows the key, tenant, default fallback chain', () => {
  assert.equal(resolveBillingGroupId('vip', 'svip'), 'vip');
  assert.equal(resolveBillingGroupId(null, 'svip'), 'svip');
  assert.equal(resolveBillingGroupId(undefined, null), 'default');
  assert.equal(resolveBillingGroupId('  ', ''), 'default');
  assert.equal(resolveBillingGroupId(null, undefined), 'default');
});

test('evaluateProfitControl refuses at or below cost × (1 − margin − buffer) exactly', () => {
  const input = {
    minMargin: { numerator: 1n, denominator: 10n },
    safetyBuffer: { numerator: 1n, denominator: 20n },
  } as const;
  // threshold = 1000 × (1 − 0.1 − 0.05) = 850.
  assert.equal(
    evaluateProfitControl({ customerChargeMinorUnits: 851n, supplierCostMinorUnits: 1000n, ...input }).allowed,
    true,
  );
  assert.equal(
    evaluateProfitControl({ customerChargeMinorUnits: 850n, supplierCostMinorUnits: 1000n, ...input }).allowed,
    false,
  );
  assert.equal(
    evaluateProfitControl({ customerChargeMinorUnits: 849n, supplierCostMinorUnits: 1000n, ...input }).allowed,
    false,
  );
  // Exact rational thresholds: margin 1/3, buffer 1/6 -> factor 1/2.
  const thirds = {
    minMargin: { numerator: 1n, denominator: 3n },
    safetyBuffer: { numerator: 1n, denominator: 6n },
  };
  assert.equal(
    evaluateProfitControl({ customerChargeMinorUnits: 501n, supplierCostMinorUnits: 1001n, ...thirds }).allowed,
    true,
  );
  assert.equal(
    evaluateProfitControl({ customerChargeMinorUnits: 500n, supplierCostMinorUnits: 1001n, ...thirds }).allowed,
    false,
  );
  // margin + buffer >= 1 never refuses.
  assert.equal(
    evaluateProfitControl({
      customerChargeMinorUnits: 0n,
      supplierCostMinorUnits: 1000n,
      minMargin: { numerator: 3n, denominator: 4n },
      safetyBuffer: { numerator: 1n, denominator: 2n },
    }).allowed,
    true,
  );
  assert.throws(
    () =>
      evaluateProfitControl({
        customerChargeMinorUnits: 1n,
        supplierCostMinorUnits: 1n,
        minMargin: { numerator: -1n, denominator: 2n },
        safetyBuffer: HALF,
      }),
    SaasBillingGroupsError,
  );
});

test('model pricing overrides parse canonically and match only the exact public model', () => {
  const parsed = parseModelPricingJson({
    'model-a': { input: { num: '3', den: '1000000' }, output: { num: '15', den: '1000000' } },
  });
  const override = resolveModelPricingOverride(parsed, 'model-a');
  assert.ok(override);
  assert.equal(override.rates.input?.numeratorMinorUnits, 3n);
  assert.equal(override.rates.output?.denominatorUnits, 1000000n);
  assert.equal(override.model, 'model-a');
  assert.match(override.digest, /^[0-9a-f]{64}$/);
  assert.equal(resolveModelPricingOverride(parsed, 'model-b'), null);
  assert.equal(resolveModelPricingOverride(new Map(), 'model-a'), null);
  // The stored JSON round-trips through the same digest.
  const restored = parseAppliedModelPricingOverride(serializeAppliedModelPricingOverride(override));
  assert.ok(restored);
  assert.equal(restored.digest, override.digest);
  assert.equal(modelPricingOverrideDigest('model-a', override.rates), override.digest);
  // Overrides require input and output rates like any rate set.
  assert.throws(
    () => parseModelPricingJson({ 'model-a': { cache_read: { num: '1', den: '2' } } }),
    SaasBillingGroupsError,
  );
  assert.throws(() => parseModelPricingJson({ 'model-a': { input: { num: 'x', den: '2' } } }), SaasBillingGroupsError);
  assert.throws(() => parseModelPricingJson([1, 2]), SaasBillingGroupsError);
});

test('mapBillingGroupRow validates the peak and profit pair shapes fail-closed', () => {
  const base = {
    id: 'vip',
    display_name: 'VIP',
    rate_multiplier_num: '3',
    rate_multiplier_den: '2',
    topup_multiplier_num: '1',
    topup_multiplier_den: '1',
    peak_enabled: false,
    model_pricing: null,
    rpm_limit: null,
    daily_limit_minor_units: null,
    weekly_limit_minor_units: null,
    monthly_limit_minor_units: null,
    profit_min_margin_num: null,
    profit_min_margin_den: null,
    profit_safety_buffer_num: null,
    profit_safety_buffer_den: null,
    claude_code_only: false,
    fallback_group_id: null,
    supported_model_scopes: null,
    composite: false,
    status: 'active',
  };
  const record = mapBillingGroupRow(base);
  assert.equal(record.rateMultiplier.numerator, 3n);
  assert.equal(record.peak, null);
  assert.throws(() => mapBillingGroupRow({ ...base, peak_enabled: true, peak_start: null }), SaasBillingGroupsError);
  assert.throws(
    () => mapBillingGroupRow({ ...base, peak_enabled: true, peak_start: '09:00:00', peak_end: '18:00:00' }),
    SaasBillingGroupsError,
  );
  assert.throws(
    () =>
      mapBillingGroupRow({
        ...base,
        peak_enabled: true,
        peak_start: '09:00:00',
        peak_end: '18:00:00',
        peak_multiplier_num: '2',
      }),
    SaasBillingGroupsError,
  );
  assert.throws(() => mapBillingGroupRow({ ...base, profit_min_margin_num: '1' }), SaasBillingGroupsError);
  assert.throws(() => mapBillingGroupRow({ ...base, rate_multiplier_num: '0' }), SaasBillingGroupsError);
  const overnight = mapBillingGroupRow({
    ...base,
    peak_enabled: true,
    peak_start: '22:00:00',
    peak_end: '06:00:00',
    peak_multiplier_num: '5',
    peak_multiplier_den: '4',
  });
  assert.equal(overnight.peak?.startSecondsUtc, 22 * 3600);
  assert.equal(overnight.peak?.endSecondsUtc, 6 * 3600);
  assert.equal(overnight.peak?.multiplier.numerator, 5n);
});

test('snapshotBillingGroupTerms resolves neutral terms for pre-group snapshots and fails closed on bad digests', () => {
  const legacy: CustomerPriceSnapshotRecord = {
    id: 's',
    tenantId: 't',
    requestId: 'r',
    customerPriceVersion: 'p',
    publicModelId: 'm',
    publicModelVersion: 1,
    providerId: 'prov',
    productId: 'prod',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'USD',
    commercialPolicyVersion: 'cpv',
    calculatorVersion: 'cv',
    roundingVersion: 'rv',
    roundingMode: 'half_up',
    roundingBoundary: 'total',
    holdInput: {
      inputTotal: 1n,
      inputUncached: 1n,
      cacheRead: 0n,
      cacheWrite: 0n,
      cacheWrite5m: 0n,
      cacheWrite1h: 0n,
      outputTotal: 1n,
      reasoningOutput: 0n,
    },
    holdAmountMinorUnits: 2n,
    walletHoldRequired: true,
    admissionExpiresAt: '2026-10-15T00:05:00.000Z',
    idempotencyKey: 'k',
    snapshotDigest: 'a'.repeat(64),
    createdAt: '2026-10-15T00:00:00.000Z',
  };
  const neutral = snapshotBillingGroupTerms(legacy);
  assert.equal(neutral.billingGroupId, null);
  assert.deepEqual(neutral.rateMultiplier, { numerator: 1n, denominator: 1n });
  assert.equal(neutral.peakApplied, false);
  assert.equal(neutral.modelPricingOverride, null);
  // Pre-112 snapshots carry no enforcement terms: every limit resolves to
  // null (no limit was in force), never to a finite zero.
  assert.equal(neutral.rpmLimit, null);
  assert.equal(neutral.dailyLimitMinorUnits, null);
  assert.equal(neutral.weeklyLimitMinorUnits, null);
  assert.equal(neutral.monthlyLimitMinorUnits, null);
  assert.equal(neutral.supportedModelScopes, null);
  assert.equal(neutral.fallbackGroupId, null);

  const rates = normalizeRates({
    input: { numeratorMinorUnits: 3n, denominatorUnits: 1000000n },
    output: { numeratorMinorUnits: 15n, denominatorUnits: 1000000n },
  } satisfies RateSetInput);
  const override = { model: 'm', rates, digest: modelPricingOverrideDigest('m', rates) };
  const frozen = snapshotBillingGroupTerms({
    ...legacy,
    billingGroupId: 'vip',
    rateMultiplier: { numerator: 3n, denominator: 2n },
    peakApplied: true,
    modelPricingOverrideDigest: override.digest,
    modelPricingOverride: serializeAppliedModelPricingOverride(override),
    groupRpmLimit: 60,
    groupDailyLimitMinorUnits: 500n,
    groupWeeklyLimitMinorUnits: 0n,
    groupMonthlyLimitMinorUnits: null,
    groupSupportedModelScopes: ['claude-sonnet-4-5', 'claude-opus-4-1'],
    groupFallbackGroupId: 'default',
  });
  assert.equal(frozen.billingGroupId, 'vip');
  assert.deepEqual(frozen.rateMultiplier, { numerator: 3n, denominator: 2n });
  assert.equal(frozen.peakApplied, true);
  assert.equal(frozen.modelPricingOverride?.digest, override.digest);
  // R1 enforcement terms (roadmap 1.3): frozen verbatim, zero kept finite.
  assert.equal(frozen.rpmLimit, 60);
  assert.equal(frozen.dailyLimitMinorUnits, 500n);
  assert.equal(frozen.weeklyLimitMinorUnits, 0n);
  assert.equal(frozen.monthlyLimitMinorUnits, null);
  assert.deepEqual(frozen.supportedModelScopes, ['claude-sonnet-4-5', 'claude-opus-4-1']);
  assert.equal(frozen.fallbackGroupId, 'default');
  // A digest that does not match the stored rate set fails closed.
  assert.throws(
    () =>
      snapshotBillingGroupTerms({
        ...legacy,
        modelPricingOverrideDigest: 'b'.repeat(64),
        modelPricingOverride: serializeAppliedModelPricingOverride(override),
      }),
    SaasBillingGroupsError,
  );
  // A digest without its stored rate set cannot be reconstructed.
  assert.throws(
    () => snapshotBillingGroupTerms({ ...legacy, modelPricingOverrideDigest: override.digest }),
    SaasBillingGroupsError,
  );
});

const rateSet = normalizeRates({
  input: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_read: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_write: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_write_5m: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_write_1h: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  output: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
} satisfies RateSetInput);

function customerPrice(): CustomerPriceVersionRecord {
  return {
    kind: 'customer',
    id: 'price-v1',
    version: 1,
    publicModelId: 'model-1',
    publicModelVersion: 1,
    providerId: 'provider-1',
    productId: 'product-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'USD',
    commercialPolicyVersion: 'policy-v1',
    calculatorVersion: 'calculator-v1',
    roundingVersion: 'rounding-v1',
    roundingMode: 'half_up',
    roundingBoundary: 'total',
    rates: rateSet,
    effectiveAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    idempotencyKey: 'price-key-v1',
    definitionDigest: 'd'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

function snapshotRecord(multiplier: RationalMultiplier): CustomerPriceSnapshotRecord {
  return {
    id: 'snapshot-1',
    tenantId: 'tenant-1',
    requestId: 'request-1',
    customerPriceVersion: 'price-v1',
    publicModelId: 'model-1',
    publicModelVersion: 1,
    providerId: 'provider-1',
    productId: 'product-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'USD',
    commercialPolicyVersion: 'policy-v1',
    calculatorVersion: 'calculator-v1',
    roundingVersion: 'rounding-v1',
    roundingMode: 'half_up',
    roundingBoundary: 'total',
    holdInput: {
      inputTotal: 10n,
      inputUncached: 10n,
      cacheRead: 0n,
      cacheWrite: 0n,
      cacheWrite5m: 0n,
      cacheWrite1h: 0n,
      outputTotal: 10n,
      reasoningOutput: 0n,
    },
    holdAmountMinorUnits: multiplyMinorUnits(20n, multiplier, 'ceil'),
    walletHoldRequired: true,
    admissionExpiresAt: '2026-10-15T00:05:00.000Z',
    idempotencyKey: 'admission-1',
    snapshotDigest: 'a'.repeat(64),
    createdAt: '2026-10-15T00:00:00.000Z',
    billingGroupId: 'vip',
    rateMultiplier: multiplier,
    peakApplied: false,
    modelPricingOverrideDigest: null,
    modelPricingOverride: null,
  };
}

const settlementSnapshot: NormalSuccessSettlementSnapshot = {
  supplyMode: 'platform',
  providerProtocol: 'openai',
  customerPriceVersion: 'price-v1',
  reservationId: 'hold-1',
  priceSnapshotRef: 'snapshot-1',
  currency: 'USD',
  holdAmountMinorUnits: '30',
  publicModelId: 'model-1',
  publicModelVersion: '1',
  providerId: 'provider-1',
  productId: 'product-1',
  endpoint: 'chat-completions',
  usageEstimatorVersion: 'estimator-v1',
};

const observedUsage = {
  inputTotal: 5,
  inputUncached: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  outputTotal: 2,
  reasoningOutput: 0,
  status: 'reported',
  source: 'upstream',
  semanticsVersion: 'v1',
} satisfies NormalizedUsage;

test('settlement multiplies by the admission snapshot multiplier and ignores later group edits', async () => {
  // The group table is never consulted: the coordinator reads only the
  // immutable snapshot row. A group edited after admission cannot reprice it.
  const settle = async (multiplier: RationalMultiplier): Promise<string> => {
    let committed: NormalSuccessTransactionInput | undefined;
    const coordinator = new DispatchUsageSettlementCoordinator(
      {
        async getCustomerPriceVersion() {
          return customerPrice();
        },
        async getCustomerPriceSnapshot() {
          return snapshotRecord(multiplier);
        },
      },
      {
        async complete(input) {
          committed = input;
          return { kind: 'settled', attempt: null as never };
        },
        async retainUnknown() {
          throw new Error('unexpected reconciliation');
        },
      } satisfies NormalSuccessTransactionPort,
    );
    await coordinator.complete({
      tenantId: 'tenant-1',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      snapshot: settlementSnapshot,
      usage: observedUsage,
    });
    assert.ok(committed);
    return committed.chargeAmountMinorUnits ?? '';
  };
  // Base charge for 5 input + 2 output at rate 1 is 7 minor units.
  assert.equal(await settle({ numerator: 1n, denominator: 1n }), '7');
  assert.equal(await settle({ numerator: 3n, denominator: 2n }), '11');
  // 7 × 1/3 = 2.33 rounds to 2 under the price version's half_up mode.
  assert.equal(await settle({ numerator: 1n, denominator: 3n }), '2');
});

test('topup credit applies the group multiplier and the highest matching amount tier, floored', () => {
  const identity = computeTopupCredit({ paidMinorUnits: 1000n, topupMultiplier: { numerator: 1n, denominator: 1n } });
  assert.equal(identity.creditMinorUnits, 1000n);
  const bonus = computeTopupCredit({ paidMinorUnits: 1000n, topupMultiplier: { numerator: 11n, denominator: 10n } });
  assert.equal(bonus.creditMinorUnits, 1100n);
  assert.deepEqual(bonus.tierDiscount, null);
  const tiers = parseTopupAmountTierDiscounts([
    { thresholdMinorUnits: '1000', discountNumerator: 95, discountDenominator: 100 },
    { thresholdMinorUnits: '10000', discountNumerator: 9, discountDenominator: 10 },
  ]);
  const tiered = computeTopupCredit({
    paidMinorUnits: 1500n,
    topupMultiplier: { numerator: 11n, denominator: 10n },
    tiers,
  });
  // 1500 × 11/10 = 1650; × 95/100 = 1567.5 -> floor 1567.
  assert.equal(tiered.creditMinorUnits, 1567n);
  assert.deepEqual(tiered.tierDiscount, { numerator: 95n, denominator: 100n });
  const bigTier = computeTopupCredit({
    paidMinorUnits: 20000n,
    topupMultiplier: { numerator: 1n, denominator: 1n },
    tiers,
  });
  assert.equal(bigTier.creditMinorUnits, 18000n);
  const belowTier = computeTopupCredit({
    paidMinorUnits: 999n,
    topupMultiplier: { numerator: 1n, denominator: 1n },
    tiers,
  });
  assert.equal(belowTier.creditMinorUnits, 999n);
  assert.equal(belowTier.tierDiscount, null);
  // Discount multipliers above one or zero are rejected, as are duplicates and bad shapes.
  assert.throws(
    () =>
      parseTopupAmountTierDiscounts([{ thresholdMinorUnits: '1', discountNumerator: 101, discountDenominator: 100 }]),
    SaasBillingGroupsError,
  );
  assert.throws(
    () => parseTopupAmountTierDiscounts([{ thresholdMinorUnits: '1', discountNumerator: 0, discountDenominator: 100 }]),
    SaasBillingGroupsError,
  );
  assert.throws(
    () =>
      parseTopupAmountTierDiscounts([
        { thresholdMinorUnits: '1', discountNumerator: 1, discountDenominator: 1 },
        { thresholdMinorUnits: '1', discountNumerator: 1, discountDenominator: 1 },
      ]),
    SaasBillingGroupsError,
  );
  assert.throws(() => parseTopupAmountTierDiscounts({ nope: true }), SaasBillingGroupsError);
  assert.deepEqual(parseTopupAmountTierDiscounts(null), []);
  assert.deepEqual(parseTopupAmountTierDiscounts(undefined), []);
  assert.equal(TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY, 'saas.payments.topup.amount_tier_discounts');
});

test('isSaasBillingGroupsError narrows the error type', () => {
  assert.equal(isSaasBillingGroupsError(new SaasBillingGroupsError('GROUP_NOT_FOUND')), true);
  assert.equal(isSaasBillingGroupsError(new Error('nope')), false);
});

// ---------------------------------------------------------------------------
// Control-plane service SQL paths (fake executor).
// ---------------------------------------------------------------------------

class FakeExecutor implements SqlExecutor {
  readonly statements: string[] = [];
  rows: Record<string, unknown[]> = {};

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(`${sql.trim()} :: ${values.join('|')}`);
    const lower = sql.toLowerCase();
    if (lower.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (lower.startsWith('select id from saas_billing_groups')) {
      return { rows: (this.rows.groups ?? [{ id: 'default' }]) as Row[], rowCount: 1 };
    }
    if (lower.startsWith('select id from saas_platform_provider_accounts')) {
      return { rows: (this.rows.accounts ?? [{ id: 'account-1' }]) as Row[], rowCount: 1 };
    }
    if (lower.includes('from saas_api_keys') && lower.includes('for update')) {
      return { rows: (this.rows.keys ?? [{ id: 'key-1', status: 'active' }]) as Row[], rowCount: 1 };
    }
    if (lower.includes('update saas_api_keys') && lower.includes('returning')) {
      const billingGroupId = values[3] === null ? null : String(values[3]);
      return { rows: [{ id: values[2], billing_group_id: billingGroupId, authz_version: 2 }] as Row[], rowCount: 1 };
    }
    if (lower.startsWith('update saas_api_keys')) return { rows: [], rowCount: 2 };
    if (lower.startsWith('delete from saas_billing_group_account_pools')) return { rows: [], rowCount: 0 };
    if (lower.includes('insert into saas_billing_groups') || lower.includes('update saas_billing_groups')) {
      return {
        rows: [
          {
            id: values[0],
            display_name: values[1],
            rate_multiplier_num: String(values[2]),
            rate_multiplier_den: String(values[3]),
            topup_multiplier_num: String(values[4]),
            topup_multiplier_den: String(values[5]),
            peak_enabled: values[6],
            peak_start: values[7],
            peak_end: values[8],
            peak_multiplier_num: values[9] === null ? null : String(values[9]),
            peak_multiplier_den: values[10] === null ? null : String(values[10]),
            model_pricing: null,
            rpm_limit: values[12],
            daily_limit_minor_units: values[13] === null ? null : String(values[13]),
            weekly_limit_minor_units: values[14] === null ? null : String(values[14]),
            monthly_limit_minor_units: values[15] === null ? null : String(values[15]),
            profit_min_margin_num: values[16] === null ? null : String(values[16]),
            profit_min_margin_den: values[17] === null ? null : String(values[17]),
            profit_safety_buffer_num: values[18] === null ? null : String(values[18]),
            profit_safety_buffer_den: values[19] === null ? null : String(values[19]),
            claude_code_only: values[20],
            fallback_group_id: values[21],
            supported_model_scopes: values[22],
            composite: values[23] === undefined ? false : values[23],
            status: values[24],
            created_at: values[25],
            updated_at: values[26],
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (lower.includes('insert into saas_billing_group_account_pools')) return { rows: [], rowCount: 1 };
    throw new Error(`unhandled fake SQL: ${sql}`);
  }
}

function fakeDatabase(): {
  executor: FakeExecutor;
  database: {
    query: FakeExecutor['query'];
    transaction: (work: (tx: FakeExecutor) => Promise<unknown>) => Promise<unknown>;
  };
} {
  const executor = new FakeExecutor();
  return {
    executor,
    database: {
      query: executor.query.bind(executor),
      transaction: async (work) => work(executor),
    },
  };
}

function upsertInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vip',
    displayName: 'VIP',
    rateMultiplier: { numerator: 3n, denominator: 2n },
    topupMultiplier: { numerator: 11n, denominator: 10n },
    peakEnabled: false,
    peakStart: null,
    peakEnd: null,
    peakMultiplier: null,
    modelPricing: null,
    rpmLimit: null,
    dailyLimitMinorUnits: null,
    weeklyLimitMinorUnits: null,
    monthlyLimitMinorUnits: null,
    profitMinMargin: null,
    profitSafetyBuffer: null,
    claudeCodeOnly: false,
    fallbackGroupId: null,
    supportedModelScopes: null,
    composite: false,
    status: 'active',
    ...overrides,
  };
}

test('the groups service creates groups and rejects invalid shapes fail-closed', async () => {
  const { database, executor } = fakeDatabase();
  const service = new SaasBillingGroupsService(database as never, { now: () => new Date('2026-10-15T00:00:00Z') });
  const created = await service.createBillingGroup(upsertInput() as never);
  assert.equal(created.id, 'vip');
  assert.equal(created.rateMultiplier.numerator, 3n);
  assert.ok(executor.statements.some((statement) => statement.includes('INSERT INTO saas_billing_groups')));
  await assert.rejects(
    () => service.createBillingGroup(upsertInput({ rateMultiplier: { numerator: 0n, denominator: 1n } }) as never),
    SaasBillingGroupsError,
  );
  await assert.rejects(
    () => service.createBillingGroup(upsertInput({ status: 'paused' }) as never),
    SaasBillingGroupsError,
  );
  await assert.rejects(
    () => service.createBillingGroup(upsertInput({ peakEnabled: true, peakStart: null }) as never),
    SaasBillingGroupsError,
  );
  await assert.rejects(
    () => service.createBillingGroup(upsertInput({ profitMinMargin: { numerator: 1n, denominator: 10n } }) as never),
    SaasBillingGroupsError,
  );
});

test('setKeyBillingGroup bumps authz_version atomically and validates the group binding', async () => {
  const { database, executor } = fakeDatabase();
  const service = new SaasBillingGroupsService(database as never);
  const result = await service.setKeyBillingGroup({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    billingGroupId: 'vip',
  });
  assert.deepEqual(result, { keyId: 'key-1', billingGroupId: 'vip', authzVersion: '2' });
  const update = executor.statements.find(
    (statement) =>
      statement.includes('UPDATE saas_api_keys') && statement.includes('authz_version = authz_version + 1'),
  );
  assert.ok(update, 'the key update must bump authz_version in the same transaction');
  assert.ok(executor.statements.some((statement) => statement.includes('pg_advisory_xact_lock')));
  // Clearing the binding falls back to the tenant default.
  const cleared = await service.setKeyBillingGroup({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    billingGroupId: null,
  });
  assert.equal(cleared.billingGroupId, null);
  // An unknown target fails closed.
  const missing = fakeDatabase();
  missing.executor.rows.keys = [];
  await assert.rejects(
    () =>
      new SaasBillingGroupsService(missing.database as never).setKeyBillingGroup({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        keyId: 'key-x',
        billingGroupId: 'vip',
      }),
    SaasBillingGroupsError,
  );
});

test('replaceGroupAccountPool rewrites membership and invalidates affected keys', async () => {
  const { database, executor } = fakeDatabase();
  const service = new SaasBillingGroupsService(database as never);
  const outcome = await service.replaceGroupAccountPool('vip', [
    { accountId: 'account-1', priority: 10 },
    { accountId: 'account-2', priority: 90 },
  ]);
  assert.equal(outcome.entries.length, 2);
  // The fake executor reports one touched row per statement; production reads
  // the real RETURNING row count. The field's presence is the contract.
  assert.ok(Number.isSafeInteger(outcome.invalidatedKeys) && outcome.invalidatedKeys >= 0);
  assert.ok(
    executor.statements.some((statement) => statement.includes('DELETE FROM saas_billing_group_account_pools')),
  );
  assert.ok(
    executor.statements.some((statement) => statement.includes('INSERT INTO saas_billing_group_account_pools')),
  );
  const invalidation = executor.statements.find(
    (statement) => statement.includes('UPDATE saas_api_keys') && statement.includes('default_billing_group_id'),
  );
  assert.ok(invalidation, 'pool changes must invalidate keys bound to the group');
  // Unknown accounts and duplicate rows fail closed.
  const unknownAccount = fakeDatabase();
  unknownAccount.executor.rows.accounts = [];
  await assert.rejects(
    () =>
      new SaasBillingGroupsService(unknownAccount.database as never).replaceGroupAccountPool('vip', [
        { accountId: 'missing', priority: 1 },
      ]),
    SaasBillingGroupsError,
  );
  await assert.rejects(
    () =>
      service.replaceGroupAccountPool('vip', [
        { accountId: 'account-1', priority: 1 },
        { accountId: 'account-1', priority: 2 },
      ]),
    SaasBillingGroupsError,
  );
});

test('resolveTopupCredit converts through the tenant default group', async () => {
  const { database } = fakeDatabase();
  const service = new SaasBillingGroupsService(database as never, {
    topupAmountTierDiscounts: [{ thresholdMinorUnits: '1000', discountNumerator: 95, discountDenominator: 100 }],
  });
  const executor = {
    query: async <Row>(sql: string): Promise<SqlResult<Row>> => {
      assert.ok(sql.includes('saas-billing-groups:topup'));
      return {
        rows: [
          {
            id: 'default',
            display_name: 'Default',
            rate_multiplier_num: '1',
            rate_multiplier_den: '1',
            topup_multiplier_num: '11',
            topup_multiplier_den: '10',
            peak_enabled: false,
            peak_start: null,
            peak_end: null,
            peak_multiplier_num: null,
            peak_multiplier_den: null,
            model_pricing: null,
            rpm_limit: null,
            daily_limit_minor_units: null,
            weekly_limit_minor_units: null,
            monthly_limit_minor_units: null,
            profit_min_margin_num: null,
            profit_min_margin_den: null,
            profit_safety_buffer_num: null,
            profit_safety_buffer_den: null,
            claude_code_only: false,
            fallback_group_id: null,
            supported_model_scopes: null,
            composite: false,
            status: 'active',
            created_at: '2026-10-15T00:00:00Z',
            updated_at: '2026-10-15T00:00:00Z',
          },
        ] as Row[],
        rowCount: 1,
      };
    },
  };
  const conversion = await service.resolveTopupCredit(executor, {
    tenantId: 'tenant-1',
    paidMinorUnits: 2000n,
    currency: 'USD',
  });
  // 2000 × 11/10 × 95/100 = 2090.
  assert.equal(conversion.creditMinorUnits, 2090n);
  assert.deepEqual(conversion.topupMultiplier, { numerator: 11n, denominator: 10n });
});

test('resolveTopupCredit accepts a call-time tiers override (F1 store-first consumption)', async () => {
  const { database } = fakeDatabase();
  // No tiers injected at construction: an empty store keeps the no-discounts
  // default, and the call-time override (the platform settings store value)
  // supplies the tiers without rebuilding the service.
  const service = new SaasBillingGroupsService(database as never);
  const executor = {
    query: async <Row>(sql: string): Promise<SqlResult<Row>> => ({
      rows: [
        {
          id: 'default',
          display_name: 'Default',
          rate_multiplier_num: '1',
          rate_multiplier_den: '1',
          topup_multiplier_num: '1',
          topup_multiplier_den: '1',
          peak_enabled: false,
          peak_start: null,
          peak_end: null,
          peak_multiplier_num: null,
          peak_multiplier_den: null,
          model_pricing: null,
          rpm_limit: null,
          daily_limit_minor_units: null,
          weekly_limit_minor_units: null,
          monthly_limit_minor_units: null,
          profit_min_margin_num: null,
          profit_min_margin_den: null,
          profit_safety_buffer_num: null,
          profit_safety_buffer_den: null,
          claude_code_only: false,
          fallback_group_id: null,
          supported_model_scopes: null,
          composite: false,
          status: 'active',
          created_at: '2026-10-15T00:00:00Z',
          updated_at: '2026-10-15T00:00:00Z',
        },
      ] as Row[],
      rowCount: 1,
    }),
  };
  const neutral = await service.resolveTopupCredit(executor, {
    tenantId: 'tenant-1',
    paidMinorUnits: 2000n,
    currency: 'USD',
  });
  assert.equal(neutral.creditMinorUnits, 2000n, 'no tiers and no override: identity conversion');

  const conversion = await service.resolveTopupCredit(
    executor,
    { tenantId: 'tenant-1', paidMinorUnits: 2000n, currency: 'USD' },
    {
      tiers: parseTopupAmountTierDiscounts([
        { thresholdMinorUnits: '1000', discountNumerator: 95, discountDenominator: 100 },
      ]),
    },
  );
  // 2000 × 95/100 = 1900.
  assert.equal(conversion.creditMinorUnits, 1900n);
  assert.deepEqual(conversion.tierDiscount, { numerator: 95n, denominator: 100n });
});
