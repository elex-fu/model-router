import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BillableUsageEnvelope, InputBillingBucket } from '../../../src/saas/gateway/hold-calculator.js';
import { calculateConservativePriceHold, INPUT_BILLING_BUCKETS } from '../../../src/saas/gateway/hold-calculator.js';
import { calculatePriceVersion, normalizeRates } from '../../../src/saas/pricing/calculator.js';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
import type {
  CustomerPriceVersionRecord,
  PriceMetric,
  RateSet,
  RateSetInput,
  RationalRateInput,
  RoundingMode,
} from '../../../src/saas/pricing/types.js';

const rate = (numeratorMinorUnits: bigint | string, denominatorUnits: bigint | string = 1n): RationalRateInput => ({
  numeratorMinorUnits,
  denominatorUnits,
});

function rates(overrides: Partial<Record<PriceMetric, RationalRateInput | null>> = {}): RateSet {
  return normalizeRates({
    input: rate(1n),
    cache_read: rate(1n),
    cache_write: rate(1n),
    cache_write_5m: rate(1n),
    cache_write_1h: rate(1n),
    output: rate(1n),
    ...overrides,
  } satisfies RateSetInput);
}

function customerVersion(options: { rates?: RateSet; roundingMode?: RoundingMode } = {}): CustomerPriceVersionRecord {
  return {
    kind: 'customer',
    id: 'customer-price-version-1',
    version: 1,
    publicModelId: 'public-model-1',
    publicModelVersion: 1,
    providerId: 'provider-1',
    productId: 'product-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'USD',
    commercialPolicyVersion: 'policy-1',
    calculatorVersion: 'calculator-1',
    roundingVersion: 'rounding-1',
    roundingMode: options.roundingMode ?? 'half_up',
    roundingBoundary: 'total',
    rates: options.rates ?? rates(),
    effectiveAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    idempotencyKey: 'customer-version-1',
    definitionDigest: 'a'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

function envelope(
  inputUpperBound: bigint | number | string,
  outputUpperBound: bigint | number | string,
  feasibleInputBuckets: readonly InputBillingBucket[] = INPUT_BILLING_BUCKETS,
): BillableUsageEnvelope {
  return { inputUpperBound, outputUpperBound, feasibleInputBuckets };
}

function assertPricingCode(action: () => unknown, code: SaasPricingError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof SaasPricingError && error.code === code);
}

test('chooses each input billing bucket when it has the highest rate', () => {
  for (const winner of INPUT_BILLING_BUCKETS) {
    const overrides: Partial<Record<PriceMetric, RationalRateInput | null>> = {};
    for (const bucket of INPUT_BILLING_BUCKETS) overrides[bucket] = rate(bucket === winner ? 9n : 1n);
    const result = calculateConservativePriceHold(customerVersion({ rates: rates(overrides) }), envelope(4n, 2n));

    assert.equal(result.selectedInputMetric, winner);
    assert.equal(result.inputUpperBound, 4n);
    assert.equal(result.outputUpperBound, 2n);
    assert.equal(result.witness.inputTotal, 4n);
    assert.equal(result.witness.outputTotal, 2n);
    assert.equal(result.witness[winner === 'input' ? 'inputUncached' : bucketField(winner)], 4n);
  }
});

function bucketField(
  bucket: InputBillingBucket,
): 'inputUncached' | 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' {
  switch (bucket) {
    case 'input':
      return 'inputUncached';
    case 'cache_read':
      return 'cacheRead';
    case 'cache_write':
      return 'cacheWrite';
    case 'cache_write_5m':
      return 'cacheWrite5m';
    case 'cache_write_1h':
      return 'cacheWrite1h';
  }
}

test('compares very close rational rates exactly when Number comparisons collapse them', () => {
  const scale = 9_000_000_000_000_001n;
  const lowerNumerator = scale - 2n;
  const lowerDenominator = scale - 1n;
  const higherNumerator = scale - 1n;
  const higherDenominator = scale;
  assert.equal(Number(lowerNumerator) / Number(lowerDenominator), Number(higherNumerator) / Number(higherDenominator));

  const result = calculateConservativePriceHold(
    customerVersion({
      rates: rates({
        input: rate(lowerNumerator, lowerDenominator),
        cache_read: rate(higherNumerator, higherDenominator),
      }),
    }),
    envelope(1n, 0n, ['input', 'cache_read']),
  );

  assert.equal(result.selectedInputMetric, 'cache_read');
});

test('uses canonical bucket order for exact-rate ties, independent of envelope order', () => {
  const priceVersion = customerVersion({ rates: rates({ cache_read: rate(3n), cache_write_1h: rate(3n) }) });
  const first = calculateConservativePriceHold(priceVersion, envelope(2n, 0n, ['cache_write_1h', 'cache_read']));
  const second = calculateConservativePriceHold(priceVersion, envelope(2n, 0n, ['cache_read', 'cache_write_1h']));

  assert.equal(first.selectedInputMetric, 'cache_read');
  assert.equal(second.selectedInputMetric, 'cache_read');
  assert.deepEqual(first.witness, second.witness);
});

test('rejects a missing rate for any permitted positive-input bucket', () => {
  const priceVersion = customerVersion({ rates: rates({ input: rate(100n), cache_read: null }) });
  assertPricingCode(
    () => calculateConservativePriceHold(priceVersion, envelope(5n, 0n, ['input', 'cache_read'])),
    'PRICE_RATE_MISSING',
  );
});

test('handles zero input and output bounds and still prices positive input with zero output', () => {
  const noInputPrice = customerVersion({ rates: rates({ cache_write: null }) });
  const zero = calculateConservativePriceHold(noInputPrice, envelope(0n, 0n, ['cache_write']));
  assert.equal(zero.selectedInputMetric, 'cache_write');
  assert.equal(zero.calculation.amountMinorUnits, 0n);
  assert.deepEqual(zero.calculation.chargedMetrics, []);
  assert.equal(zero.witness.cacheWrite, 0n);

  const positiveInput = calculateConservativePriceHold(
    customerVersion({ rates: rates({ input: rate(3n), output: rate(100n) }) }),
    envelope(4n, 0n, ['input']),
  );
  assert.equal(positiveInput.calculation.amountMinorUnits, 12n);
  assert.deepEqual(positiveInput.calculation.chargedMetrics, ['input']);
});

test('validates both bounds as exact non-negative integers', () => {
  const invalid: unknown[] = [
    -1,
    -1n,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    '01',
    '-1',
    '1.0',
    '',
    null,
    undefined,
    '9223372036854775808',
  ];
  const priceVersion = customerVersion();

  for (const bound of invalid) {
    assertPricingCode(
      () =>
        calculateConservativePriceHold(priceVersion, {
          inputUpperBound: bound,
          outputUpperBound: 0n,
          feasibleInputBuckets: ['input'],
        } as unknown as BillableUsageEnvelope),
      'INVALID_INPUT',
    );
    assertPricingCode(
      () =>
        calculateConservativePriceHold(priceVersion, {
          inputUpperBound: 0n,
          outputUpperBound: bound,
          feasibleInputBuckets: ['input'],
        } as unknown as BillableUsageEnvelope),
      'INVALID_INPUT',
    );
  }
});

test('rejects empty, duplicate, unsupported, or malformed feasible bucket sets', () => {
  const invalidBuckets: unknown[] = [[], ['input', 'input'], ['output'], ['input', 'reasoning'], null, undefined];
  const priceVersion = customerVersion();

  for (const feasibleInputBuckets of invalidBuckets) {
    assertPricingCode(
      () =>
        calculateConservativePriceHold(priceVersion, {
          inputUpperBound: 1n,
          outputUpperBound: 0n,
          feasibleInputBuckets,
        } as unknown as BillableUsageEnvelope),
      'INVALID_INPUT',
    );
  }
});

test('uses the immutable version rounding mode once at the total boundary', () => {
  const priceVersion = customerVersion({
    rates: rates({
      input: rate(1n, 3n),
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      output: rate(1n, 6n),
    }),
    roundingMode: 'half_even',
  });
  const result = calculateConservativePriceHold(priceVersion, envelope(1n, 1n, ['input']));

  assert.equal(result.calculation.unroundedNumerator, 1n);
  assert.equal(result.calculation.unroundedDenominator, 2n);
  assert.equal(result.calculation.amountMinorUnits, 0n);
  assert.equal(result.calculation.roundingMode, 'half_even');
  assert.equal(result.calculation.roundingBoundary, 'total');
});

test('prices output once, with reasoning represented only as a subset of output', () => {
  const result = calculateConservativePriceHold(
    customerVersion({ rates: rates({ input: rate(0n), output: rate(2n) }) }),
    envelope(0n, 7n, ['input']),
  );

  assert.equal(result.witness.reasoningOutput, 0n);
  assert.equal(result.witness.outputTotal, 7n);
  assert.equal(result.calculation.amountMinorUnits, 14n);
  assert.deepEqual(result.calculation.chargedMetrics, ['output']);
  assert.deepEqual(result.calculation.ignoredMetrics, ['inputTotal', 'reasoningOutput']);
});

test('rejects an output upper bound whose customer price version has no output rate', () => {
  assertPricingCode(
    () =>
      calculateConservativePriceHold(customerVersion({ rates: rates({ output: null }) }), envelope(0n, 4n, ['input'])),
    'INVALID_RATE',
  );
});

test('the selected witness dominates every small integer split across feasible buckets', () => {
  const priceVersion = customerVersion({
    rates: rates({
      input: rate(1n, 3n),
      cache_read: rate(2n, 5n),
      cache_write_5m: rate(7n, 13n),
      output: rate(1n, 7n),
    }),
  });
  const allowed: readonly InputBillingBucket[] = ['input', 'cache_read', 'cache_write_5m'];
  const hold = calculateConservativePriceHold(priceVersion, envelope(5n, 2n, allowed));

  for (let input = 0n; input <= 5n; input += 1n) {
    for (let cacheRead = 0n; cacheRead <= 5n - input; cacheRead += 1n) {
      const cacheWrite5m = 5n - input - cacheRead;
      const splitPrice = calculatePriceVersion(priceVersion, {
        inputTotal: 5n,
        inputUncached: input,
        cacheRead,
        cacheWrite: 0n,
        cacheWrite5m,
        cacheWrite1h: 0n,
        outputTotal: 2n,
        reasoningOutput: 0n,
      });
      assert.ok(splitPrice.amountMinorUnits <= hold.calculation.amountMinorUnits);
    }
  }
});
