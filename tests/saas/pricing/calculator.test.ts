import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
import { calculatePrice, calculateUsageSettlement, normalizeRates } from '../../../src/saas/pricing/index.js';
import type {
  CommercialPriceVersionRecordBase,
  CustomerPriceVersionRecord,
  SupplierCostVersionRecord,
  TokenUsageInput,
} from '../../../src/saas/pricing/types.js';

const usage = (overrides: Partial<TokenUsageInput> = {}): TokenUsageInput => ({
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

const rates = normalizeRates({
  input: { numeratorMinorUnits: '3', denominatorUnits: '1000000' },
  cache_read: { numeratorMinorUnits: '1', denominatorUnits: '1000000' },
  cache_write: { numeratorMinorUnits: '4', denominatorUnits: '1000000' },
  cache_write_5m: { numeratorMinorUnits: '5', denominatorUnits: '1000000' },
  cache_write_1h: { numeratorMinorUnits: '6', denominatorUnits: '1000000' },
  output: { numeratorMinorUnits: '15', denominatorUnits: '1000000' },
});

function version(
  kind: 'customer' | 'supplier',
  id: string,
  overrides: Partial<CommercialPriceVersionRecordBase> = {},
): CustomerPriceVersionRecord | SupplierCostVersionRecord {
  const base = {
    id,
    version: 1,
    publicModelId: 'public-model-1',
    publicModelVersion: 1,
    providerId: 'provider-1',
    productId: 'product-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: kind === 'customer' ? 'USD' : 'CNY',
    commercialPolicyVersion: 'policy-1',
    calculatorVersion: 'calculator-1',
    roundingVersion: 'rounding-1',
    roundingMode: 'half_up' as const,
    roundingBoundary: 'total' as const,
    rates,
    effectiveAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    idempotencyKey: `${kind}-1`,
    definitionDigest: 'a'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
    ...(kind === 'supplier' ? { resolvedModel: 'provider-model-1' } : {}),
    ...overrides,
  };
  return kind === 'customer' ? { kind, ...base } : { kind, ...base, resolvedModel: 'provider-model-1' };
}

test('calculates exact rational charges and rounds once at the total boundary', () => {
  const result = calculatePrice(
    {
      input: { numeratorMinorUnits: '1', denominatorUnits: '3' },
      output: { numeratorMinorUnits: '1', denominatorUnits: '6' },
    },
    usage({ inputTotal: '1', outputTotal: '1' }),
    { roundingMode: 'half_up', roundingBoundary: 'total' },
  );

  assert.equal(result.unroundedNumerator, 1n);
  assert.equal(result.unroundedDenominator, 2n);
  assert.equal(result.amountMinorUnits, 1n);
  assert.deepEqual(result.chargedMetrics, ['input', 'output']);
});

test('rejects unsafe numeric input rather than converting a floating-point amount', () => {
  assert.throws(
    () => calculatePrice(rates, usage({ inputTotal: Number.MAX_SAFE_INTEGER + 1 }), { roundingMode: 'half_up' }),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () =>
      calculatePrice(
        {
          input: { numeratorMinorUnits: 1.5, denominatorUnits: 1 },
          output: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        },
        usage(),
        { roundingMode: 'half_up' },
      ),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'INVALID_RATE',
  );
});

test('charges cache breakdown instead of inputTotal and never charges reasoningOutput twice', () => {
  const result = calculatePrice(
    rates,
    usage({
      inputTotal: '9999999',
      inputUncached: '1000000',
      cacheRead: '2000000',
      cacheWrite: null,
      cacheWrite5m: '1000000',
      cacheWrite1h: '0',
      outputTotal: '1000000',
      reasoningOutput: '400000',
    }),
    { roundingMode: 'half_up' },
  );

  assert.equal(result.amountMinorUnits, 25n);
  assert.deepEqual(result.ignoredMetrics, ['inputTotal', 'reasoningOutput']);
  assert.deepEqual(result.chargedMetrics, ['input', 'cache_read', 'cache_write_5m', 'output']);
});

test('rejects ambiguous generic and TTL cache-write counters', () => {
  assert.throws(
    () =>
      calculatePrice(
        rates,
        usage({ inputTotal: null, inputUncached: '1', cacheRead: '0', cacheWrite: '1', cacheWrite5m: '1' }),
        { roundingMode: 'half_up' },
      ),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'INVALID_INPUT',
  );
});

test('reports incomplete evidence instead of treating missing counters as zero', () => {
  assert.throws(
    () => calculatePrice(rates, usage({ inputTotal: null, outputTotal: '1' }), { roundingMode: 'half_up' }),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'USAGE_INCOMPLETE',
  );

  const partial = calculatePrice(rates, usage({ inputTotal: null, outputTotal: '1' }), {
    roundingMode: 'half_up',
    requireComplete: false,
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.unknownMetrics, ['inputTotal']);
});

test('returns separate customer and supplier currency amounts for later settlement', () => {
  const customer = version('customer', 'customer-version-1');
  const supplier = version('supplier', 'supplier-version-1');
  const result = calculateUsageSettlement({
    customerPrice: customer,
    supplierCost: supplier,
    usage: usage(),
  });

  assert.equal(result.customerPriceVersion, 'customer-version-1');
  assert.equal(result.supplierCostVersion, 'supplier-version-1');
  assert.equal(result.customerCurrency, 'USD');
  assert.equal(result.supplierCurrency, 'CNY');
  assert.equal(result.customer.amountMinorUnits, 18n);
  assert.equal(result.supplier.amountMinorUnits, 18n);
});
