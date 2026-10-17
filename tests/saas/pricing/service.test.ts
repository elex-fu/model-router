import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import { normalizeRates } from '../../../src/saas/pricing/calculator.js';
import {
  modelPricingOverrideDigest,
  parseAppliedModelPricingOverride,
} from '../../../src/saas/billing/groups/override.js';
import type { AppendCustomerPriceVersionInput, PriceHoldInput } from '../../../src/saas/pricing/types.js';

type Row = Record<string, unknown>;

function result<RowType>(rows: RowType[] = []): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

function identityMatches(row: Row, values: readonly unknown[], supplier = false): boolean {
  const fields = supplier
    ? [
        'public_model_id',
        'public_model_version',
        'provider_id',
        'product_id',
        'resolved_model',
        'protocol',
        'endpoint',
        'currency',
      ]
    : ['public_model_id', 'public_model_version', 'provider_id', 'product_id', 'protocol', 'endpoint', 'currency'];
  return fields.every((field, index) => String(row[field]) === String(values[index]));
}

function customerRow(values: readonly unknown[]): Row {
  const [
    id,
    version,
    publicModelId,
    publicModelVersion,
    providerId,
    productId,
    protocol,
    endpoint,
    currency,
    commercialPolicyVersion,
    calculatorVersion,
    roundingVersion,
    roundingMode,
    roundingBoundary,
    inputNumerator,
    inputDenominator,
    cacheReadNumerator,
    cacheReadDenominator,
    cacheWriteNumerator,
    cacheWriteDenominator,
    cacheWrite5mNumerator,
    cacheWrite5mDenominator,
    cacheWrite1hNumerator,
    cacheWrite1hDenominator,
    outputNumerator,
    outputDenominator,
    perUnitNumerator,
    perUnitDenominator,
    perUnitTierRates,
    tokenMultipliers,
    effectiveAt,
    expiresAt,
    idempotencyKey,
    definitionDigest,
    createdAt,
  ] = values;
  return {
    id,
    version,
    public_model_id: publicModelId,
    public_model_version: publicModelVersion,
    provider_id: providerId,
    product_id: productId,
    protocol,
    endpoint,
    currency,
    commercial_policy_version: commercialPolicyVersion,
    calculator_version: calculatorVersion,
    rounding_version: roundingVersion,
    rounding_mode: roundingMode,
    rounding_boundary: roundingBoundary,
    input_rate_numerator_minor_units: inputNumerator,
    input_rate_denominator_units: inputDenominator,
    cache_read_rate_numerator_minor_units: cacheReadNumerator,
    cache_read_rate_denominator_units: cacheReadDenominator,
    cache_write_rate_numerator_minor_units: cacheWriteNumerator,
    cache_write_rate_denominator_units: cacheWriteDenominator,
    cache_write_5m_rate_numerator_minor_units: cacheWrite5mNumerator,
    cache_write_5m_rate_denominator_units: cacheWrite5mDenominator,
    cache_write_1h_rate_numerator_minor_units: cacheWrite1hNumerator,
    cache_write_1h_rate_denominator_units: cacheWrite1hDenominator,
    output_rate_numerator_minor_units: outputNumerator,
    output_rate_denominator_units: outputDenominator,
    per_unit_rate_numerator_minor_units: perUnitNumerator,
    per_unit_rate_denominator_units: perUnitDenominator,
    per_unit_tier_rates: perUnitTierRates,
    token_multipliers: tokenMultipliers,
    effective_at: effectiveAt,
    expires_at: expiresAt,
    idempotency_key: idempotencyKey,
    definition_digest: definitionDigest,
    created_at: createdAt,
  };
}

function supplierPriceRow(): Row {
  return {
    id: 'supplier-price-1',
    version: 1,
    public_model_id: 'public-model-1',
    public_model_version: 1,
    provider_id: 'provider-1',
    product_id: 'product-1',
    resolved_model: 'provider-model-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'CNY',
    commercial_policy_version: 'policy-1',
    calculator_version: 'calculator-1',
    rounding_version: 'rounding-1',
    rounding_mode: 'half_up',
    rounding_boundary: 'total',
    input_rate_numerator_minor_units: 1n,
    input_rate_denominator_units: 1n,
    cache_read_rate_numerator_minor_units: null,
    cache_read_rate_denominator_units: null,
    cache_write_rate_numerator_minor_units: null,
    cache_write_rate_denominator_units: null,
    cache_write_5m_rate_numerator_minor_units: null,
    cache_write_5m_rate_denominator_units: null,
    cache_write_1h_rate_numerator_minor_units: null,
    cache_write_1h_rate_denominator_units: null,
    output_rate_numerator_minor_units: 1n,
    output_rate_denominator_units: 1n,
    per_unit_rate_numerator_minor_units: null,
    per_unit_rate_denominator_units: null,
    per_unit_tier_rates: null,
    token_multipliers: null,
    effective_at: '2026-09-01T00:00:00.000Z',
    expires_at: null,
    idempotency_key: 'supplier-price-1',
    definition_digest: 'b'.repeat(64),
    created_at: '2026-09-01T00:00:00.000Z',
  };
}

class FakePricingDatabase implements SaasDatabase {
  readonly customerPrices: Row[] = [];
  readonly customerSnapshots: Row[] = [];
  readonly supplierPrices: Row[] = [supplierPriceRow()];

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const a = values[0];
    const b = values[1];
    const h = values[7];

    if (statement.startsWith('select pg_advisory_xact_lock')) return result();

    if (statement.startsWith('select version from saas_supplier_cost_versions')) {
      return result(
        this.supplierPrices
          .sort((left, right) => Number(right.version) - Number(left.version))
          .slice(0, 1)
          .map((row) => ({ version: row.version })) as RowType[],
      );
    }

    if (statement.startsWith('select version from saas_customer_price_versions')) {
      const rows = this.customerPrices
        .filter((row) => identityMatches(row, values))
        .sort((left, right) => Number(right.version) - Number(left.version))
        .slice(0, 1)
        .map((row) => ({ version: row.version }));
      return result(rows as RowType[]);
    }

    if (statement.startsWith('select id, version') && statement.includes('from saas_customer_price_versions')) {
      let rows = this.customerPrices;
      if (statement.includes('where id = $1')) rows = rows.filter((row) => String(row.id) === String(a));
      else if (statement.includes('idempotency_key = $8')) {
        rows = rows.filter((row) => identityMatches(row, values) && String(row.idempotency_key) === String(h));
      } else if (statement.includes('effective_at <= $8')) {
        rows = rows.filter(
          (row) =>
            identityMatches(row, values) &&
            new Date(String(row.effective_at)).getTime() <= new Date(String(h)).getTime(),
        );
      }
      return result(rows as RowType[]);
    }

    if (statement.startsWith('select id, version') && statement.includes('from saas_supplier_cost_versions')) {
      let rows = this.supplierPrices;
      // 4.1: the idempotency lookup keys on idempotency_key = $9; the
      // resolve/latest queries carry their own predicates. The fake filters
      // only the idempotency shape (the 9-parameter supplier binding).
      if (statement.includes('idempotency_key = $9')) {
        const key = values[8];
        rows = rows.filter((row) => String(row.idempotency_key) === String(key));
      }
      return result(rows as RowType[]);
    }

    if (statement.startsWith('insert into saas_supplier_cost_versions')) {
      // Supplier rows carry resolved_model after product_id (35+1 values).
      const [id, version, publicModelId, publicModelVersion, providerId, productId, resolvedModel] = values;
      const rest = values.slice(7);
      const row = {
        ...customerRow([id, version, publicModelId, publicModelVersion, providerId, productId, ...rest]),
        resolved_model: resolvedModel,
      };
      this.supplierPrices.push(row);
      return result([row] as RowType[]);
    }

    if (statement.startsWith('insert into saas_customer_price_versions')) {
      const row = customerRow(values);
      this.customerPrices.push(row);
      return result([row] as RowType[]);
    }

    if (statement.startsWith('select supply_mode, protocol, endpoint from saas_requests')) {
      return result([{ supply_mode: 'platform', protocol: 'openai', endpoint: 'chat-completions' }] as RowType[]);
    }

    if (
      statement.startsWith('select id, tenant_id, request_id') &&
      statement.includes('from saas_attempt_supplier_cost_snapshots')
    ) {
      return result([]);
    }

    if (statement.startsWith('select id from saas_platform_provider_accounts')) {
      return result([{ id: a }] as RowType[]);
    }

    if (statement.startsWith('select column_name from information_schema.columns')) {
      return result([
        { column_name: 'resolved_model' },
        { column_name: 'protocol' },
        { column_name: 'supplier_cost_version' },
      ] as RowType[]);
    }

    if (
      statement.startsWith('select id, tenant_id, request_id') &&
      statement.includes('from saas_request_customer_price_snapshots')
    ) {
      const rows = this.customerSnapshots.filter(
        (row) => String(row.tenant_id) === String(a) && String(row.request_id) === String(b),
      );
      return result(rows as RowType[]);
    }

    if (statement.startsWith('insert into saas_request_customer_price_snapshots')) {
      const [
        id,
        tenantId,
        requestId,
        customerPriceVersion,
        publicModelId,
        publicModelVersion,
        providerId,
        productId,
        protocol,
        endpoint,
        currency,
        commercialPolicyVersion,
        calculatorVersion,
        roundingVersion,
        roundingMode,
        roundingBoundary,
        holdInputTotal,
        holdInputUncached,
        holdInputCacheRead,
        holdInputCacheWrite,
        holdInputCacheWrite5m,
        holdInputCacheWrite1h,
        holdInputOutputTotal,
        holdInputReasoningOutput,
        holdInputPerUnitUnits,
        holdInputSizeTier,
        holdAmountMinorUnits,
        walletHoldRequired,
        admissionExpiresAt,
        idempotencyKey,
        snapshotDigest,
        createdAt,
        billingGroupId,
        rateMultiplierNum,
        rateMultiplierDen,
        peakApplied,
        overrideDigest,
        overrideJson,
        groupRpmLimit,
        groupDailyLimitMinorUnits,
        groupWeeklyLimitMinorUnits,
        groupMonthlyLimitMinorUnits,
        groupSupportedModelScopes,
        groupFallbackGroupId,
      ] = values;
      const row = {
        id,
        tenant_id: tenantId,
        request_id: requestId,
        customer_price_version: customerPriceVersion,
        public_model_id: publicModelId,
        public_model_version: publicModelVersion,
        provider_id: providerId,
        product_id: productId,
        protocol,
        endpoint,
        currency,
        commercial_policy_version: commercialPolicyVersion,
        calculator_version: calculatorVersion,
        rounding_version: roundingVersion,
        rounding_mode: roundingMode,
        rounding_boundary: roundingBoundary,
        hold_input_total: holdInputTotal,
        hold_input_uncached: holdInputUncached,
        hold_input_cache_read: holdInputCacheRead,
        hold_input_cache_write: holdInputCacheWrite,
        hold_input_cache_write_5m: holdInputCacheWrite5m,
        hold_input_cache_write_1h: holdInputCacheWrite1h,
        hold_input_output_total: holdInputOutputTotal,
        hold_input_reasoning_output: holdInputReasoningOutput,
        hold_input_per_unit_units: holdInputPerUnitUnits,
        hold_input_size_tier: holdInputSizeTier,
        hold_amount_minor_units: holdAmountMinorUnits,
        wallet_hold_required: walletHoldRequired,
        admission_expires_at: admissionExpiresAt,
        idempotency_key: idempotencyKey,
        snapshot_digest: snapshotDigest,
        created_at: createdAt,
        billing_group_id: billingGroupId,
        rate_multiplier_num: rateMultiplierNum,
        rate_multiplier_den: rateMultiplierDen,
        peak_applied: peakApplied,
        model_pricing_override_digest: overrideDigest,
        model_pricing_override: overrideJson,
        group_rpm_limit: groupRpmLimit,
        group_daily_limit_minor_units: groupDailyLimitMinorUnits,
        group_weekly_limit_minor_units: groupWeeklyLimitMinorUnits,
        group_monthly_limit_minor_units: groupMonthlyLimitMinorUnits,
        group_supported_model_scopes: groupSupportedModelScopes,
        group_fallback_group_id: groupFallbackGroupId,
      };
      this.customerSnapshots.push(row);
      return result([row] as RowType[]);
    }

    throw new Error(`Unexpected fake pricing query: ${statement}`);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const priceInput = (overrides: Partial<AppendCustomerPriceVersionInput> = {}): AppendCustomerPriceVersionInput => ({
  publicModelId: 'public-model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  idempotencyKey: 'price-append-1',
  effectiveAt: '2026-09-01T00:00:00.000Z',
  commercialPolicyVersion: 'policy-1',
  calculatorVersion: 'calculator-1',
  roundingVersion: 'rounding-1',
  roundingMode: 'half_up',
  rates: {
    input: { numeratorMinorUnits: '2', denominatorUnits: '1' },
    output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
  },
  ...overrides,
});

const holdInput: PriceHoldInput = {
  inputTotal: '1',
  inputUncached: '1',
  cacheRead: '0',
  cacheWrite: '0',
  cacheWrite5m: '0',
  cacheWrite1h: '0',
  outputTotal: '0',
  reasoningOutput: '0',
};

test('appends immutable customer prices idempotently and snapshots a positive hold', async () => {
  const database = new FakePricingDatabase();
  let id = 0;
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `pricing-${++id}`,
  });

  const first = await service.appendCustomerPriceVersion(priceInput());
  const replay = await service.appendCustomerPriceVersion(priceInput());
  assert.equal(first.id, 'pricing-1');
  assert.equal(first.version, 1);
  assert.equal(replay.id, first.id);
  assert.equal(database.customerPrices.length, 1);

  await assert.rejects(
    service.appendCustomerPriceVersion(
      priceInput({
        rates: {
          input: { numeratorMinorUnits: '3', denominatorUnits: '1' },
          output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
        },
      }),
    ),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'IDEMPOTENCY_CONFLICT',
  );

  const snapshot = await service.createCustomerPriceSnapshot({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    customerPriceVersion: first.id,
    holdInput,
    admissionExpiresAt: '2026-09-28T00:05:00.000Z',
    idempotencyKey: 'request-1',
  });
  assert.equal(snapshot.snapshot.holdAmountMinorUnits, 2n);
  assert.equal(snapshot.walletHoldRequired, true);
  assert.equal(snapshot.admissionTerms.priceSnapshotRef, snapshot.snapshot.id);

  const zeroPrice = await service.appendCustomerPriceVersion(
    priceInput({
      idempotencyKey: 'price-append-zero',
      rates: {
        input: { numeratorMinorUnits: '0', denominatorUnits: '1' },
        output: { numeratorMinorUnits: '0', denominatorUnits: '1' },
      },
    }),
  );
  await assert.rejects(
    service.createCustomerPriceSnapshot({
      tenantId: 'tenant-1',
      requestId: 'request-zero',
      customerPriceVersion: zeroPrice.id,
      holdInput,
      admissionExpiresAt: '2026-09-28T00:05:00.000Z',
      idempotencyKey: 'request-zero',
    }),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'ZERO_PRICE_NOT_RESERVABLE',
  );
  assert.equal(database.customerSnapshots.length, 1);
});

test('freezes the R1 enforcement terms onto the billing-group snapshot (roadmap 1.3)', async () => {
  const database = new FakePricingDatabase();
  let id = 0;
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `pricing-${++id}`,
  });
  const price = await service.appendCustomerPriceVersion(priceInput());
  const snapshot = await service.createCustomerPriceSnapshot({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    customerPriceVersion: price.id,
    holdInput,
    admissionExpiresAt: '2026-09-28T00:05:00.000Z',
    idempotencyKey: 'request-1',
    billingGroup: {
      billingGroupId: 'vip',
      rateMultiplier: { numerator: 3n, denominator: 2n },
      peakApplied: false,
      modelPricingOverride: null,
      rpmLimit: 60,
      dailyLimitMinorUnits: 500n,
      weeklyLimitMinorUnits: 0n,
      monthlyLimitMinorUnits: null,
      supportedModelScopes: ['claude-sonnet-4-5', 'claude-opus-4-1'],
      fallbackGroupId: 'default',
    },
  });
  assert.equal(snapshot.snapshot.billingGroupId, 'vip');
  assert.equal(snapshot.snapshot.groupRpmLimit, 60);
  assert.equal(snapshot.snapshot.groupDailyLimitMinorUnits, 500n);
  assert.equal(snapshot.snapshot.groupWeeklyLimitMinorUnits, 0n);
  assert.equal(snapshot.snapshot.groupMonthlyLimitMinorUnits, null);
  assert.deepEqual(snapshot.snapshot.groupSupportedModelScopes, ['claude-sonnet-4-5', 'claude-opus-4-1']);
  assert.equal(snapshot.snapshot.groupFallbackGroupId, 'default');
  // The outer multiplier still applies to the frozen hold.
  assert.equal(snapshot.snapshot.holdAmountMinorUnits, 3n);

  const invalid = async (billingGroup: Record<string, unknown>): Promise<unknown> =>
    service
      .createCustomerPriceSnapshot({
        tenantId: 'tenant-1',
        requestId: 'request-2',
        customerPriceVersion: price.id,
        holdInput,
        admissionExpiresAt: '2026-09-28T00:05:00.000Z',
        idempotencyKey: 'request-2',
        billingGroup: {
          billingGroupId: 'vip',
          rateMultiplier: { numerator: 1n, denominator: 1n },
          peakApplied: false,
          ...billingGroup,
        },
      })
      .catch((error: unknown) => error);
  for (const [label, shape] of [
    ['negative rpm', { rpmLimit: -1 }],
    ['fractional rpm', { rpmLimit: 1.5 }],
    ['negative daily limit', { dailyLimitMinorUnits: -1n }],
    ['oversized daily limit', { dailyLimitMinorUnits: 2n ** 63n }],
    ['duplicate scopes', { supportedModelScopes: ['a', 'a'] }],
    ['empty scope entry', { supportedModelScopes: [''] }],
    ['blank fallback group', { fallbackGroupId: '  ' }],
  ] as const) {
    const error = await invalid(shape);
    assert.ok(error instanceof SaasPricingError && error.code === 'INVALID_INPUT', `${label} must fail closed`);
  }
});

test('fails closed when the current attempt contract cannot bind supplier account identity', async () => {
  const service = new SaasPricingService(new FakePricingDatabase(), {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });

  await assert.rejects(
    service.createSupplierCostSnapshot({
      tenantId: 'tenant-1',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      supplierCostVersion: 'supplier-price-1',
      platformAccountId: 'platform-account-1',
      idempotencyKey: 'attempt-1',
    }),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'SUPPLIER_ATTEMPT_BINDING_UNAVAILABLE',
  );
});

test('per_unit digest policy keeps pre-per_unit price versions idempotently replayable (4.0 ⑤)', async () => {
  /*
   * Reproduction of the digest-drift hazard: this stored row is exactly what
   * pre-4.0 code wrote — its definition digest covers the six legacy metrics
   * (explicit nulls included) with no per_unit material. If rateDigest ever
   * serializes a null per_unit into the material, the recomputed digest for
   * the same registration stops matching this value and the replay below
   * fails with IDEMPOTENCY_CONFLICT instead of returning the stored version.
   */
  const legacyDefinitionDigest = createHash('sha256')
    .update(
      JSON.stringify({
        publicModelId: 'public-model-1',
        publicModelVersion: '1',
        providerId: 'provider-1',
        productId: 'product-1',
        protocol: 'openai',
        endpoint: 'chat-completions',
        currency: 'USD',
        effectiveAt: '2026-09-01T00:00:00.000Z',
        expiresAt: null,
        commercialPolicyVersion: 'policy-1',
        calculatorVersion: 'calculator-1',
        roundingVersion: 'rounding-1',
        roundingMode: 'half_up',
        roundingBoundary: 'total',
        rates: {
          input: { numeratorMinorUnits: '2', denominatorUnits: '1' },
          cache_read: null,
          cache_write: null,
          cache_write_5m: null,
          cache_write_1h: null,
          output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
        },
      }),
    )
    .digest('hex');

  const database = new FakePricingDatabase();
  database.customerPrices.push(
    customerRow([
      'pricing-legacy-1',
      1,
      'public-model-1',
      1,
      'provider-1',
      'product-1',
      'openai',
      'chat-completions',
      'USD',
      'policy-1',
      'calculator-1',
      'rounding-1',
      'half_up',
      'total',
      2n,
      1n,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      4n,
      1n,
      null,
      null,
      null,
      null,
      '2026-09-01T00:00:00.000Z',
      null,
      'price-append-1',
      legacyDefinitionDigest,
      '2026-09-01T00:00:00.000Z',
    ]),
  );
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => 'pricing-new',
  });

  // The identical registration under the same idempotency key must replay
  // the stored version: today's recomputed digest still equals the digest
  // the pre-per_unit code computed for the same terms.
  const replay = await service.appendCustomerPriceVersion(priceInput());
  assert.equal(replay.id, 'pricing-legacy-1');
  assert.equal(replay.version, 1);
  assert.equal(database.customerPrices.length, 1);

  // The digested rates of the replayed record keep the legacy shape.
  assert.equal(replay.definitionDigest, legacyDefinitionDigest);
  assert.equal(replay.rates.per_unit, null);
});

test('per_unit rates register and round-trip once persisted (4.1 — #14 guard removed)', async () => {
  const database = new FakePricingDatabase();
  database.supplierPrices.length = 0;
  let id = 0;
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `pricing-${++id}`,
  });

  const perUnitRates = {
    input: { numeratorMinorUnits: '2', denominatorUnits: '1' },
    output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
    per_unit: { numeratorMinorUnits: '1000', denominatorUnits: '1' },
    per_unit_tiers: {
      '1k': { numeratorMinorUnits: '500', denominatorUnits: '1' },
      '4k': { numeratorMinorUnits: '4000', denominatorUnits: '1' },
    },
  };
  const customer = await service.appendCustomerPriceVersion(priceInput({ rates: perUnitRates }));
  assert.equal(customer.rates.per_unit?.numeratorMinorUnits, 1000n);
  assert.equal(customer.rates.per_unit_tiers?.['1k']?.numeratorMinorUnits, 500n);
  assert.equal(customer.rates.per_unit_tiers?.['4k']?.numeratorMinorUnits, 4000n);
  // A re-registration under the same idempotency key replays the stored row
  // (the digest covers the tier ladder in canonical order).
  const replay = await service.appendCustomerPriceVersion(priceInput({ rates: perUnitRates }));
  assert.equal(replay.id, customer.id);
  assert.equal(replay.definitionDigest, customer.definitionDigest);
  // The stored row round-trips the per-unit family: reading it back cannot
  // collapse per_unit or the tiers to null against the same digest.
  const reread = await service.getCustomerPriceVersion(customer.id);
  assert.equal(reread.rates.per_unit?.denominatorUnits, 1n);
  assert.deepEqual(
    Object.keys(reread.rates.per_unit_tiers ?? {}).sort(),
    ['1k', '4k'],
  );

  const supplier = await service.appendSupplierCostVersion({
    publicModelId: 'public-model-1',
    publicModelVersion: 1,
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: 'provider-model-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'USD',
    idempotencyKey: 'supplier-per-unit-1',
    effectiveAt: '2026-09-01T00:00:00.000Z',
    commercialPolicyVersion: 'policy-1',
    calculatorVersion: 'calculator-1',
    roundingVersion: 'rounding-1',
    roundingMode: 'half_up',
    rates: perUnitRates,
  });
  assert.equal(supplier.rates.per_unit?.numeratorMinorUnits, 1000n);
});

test('billing-group model pricing overrides serialize per_unit through the frozen snapshot (4.1)', async () => {
  const database = new FakePricingDatabase();
  let id = 0;
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `pricing-${++id}`,
  });
  const price = await service.appendCustomerPriceVersion(priceInput());

  const overrideRates = {
    input: { numeratorMinorUnits: '2', denominatorUnits: '1' },
    output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
    per_unit: { numeratorMinorUnits: '1000', denominatorUnits: '1' },
    per_unit_tiers: { '2k': { numeratorMinorUnits: '2000', denominatorUnits: '1' } },
  };
  // The caller digest is recomputed from the normalized override rates; the
  // codec now covers per_unit and the tier ladder, so the snapshot freezes
  // and replays them instead of failing closed (the #14 guard is removed).
  const normalized = normalizeRates(overrideRates);
  const digest = modelPricingOverrideDigest('public-model-1', normalized);
  const snapshot = await service.createCustomerPriceSnapshot({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    customerPriceVersion: price.id,
    holdInput,
    admissionExpiresAt: '2026-09-28T00:05:00.000Z',
    idempotencyKey: 'request-1',
    billingGroup: {
      billingGroupId: 'vip',
      rateMultiplier: { numerator: 1n, denominator: 1n },
      peakApplied: false,
      modelPricingOverride: {
        model: 'public-model-1',
        rates: overrideRates,
        digest,
      },
    },
  });
  assert.equal(database.customerSnapshots.length, 1);
  assert.equal(snapshot.snapshot.modelPricingOverrideDigest, digest);
  const frozen = parseAppliedModelPricingOverride(snapshot.snapshot.modelPricingOverride);
  assert.ok(frozen !== null);
  assert.equal(frozen.rates.per_unit?.numeratorMinorUnits, 1000n);
  assert.equal(frozen.rates.per_unit_tiers?.['2k']?.numeratorMinorUnits, 2000n);
  // The frozen override parses back to the same digest (round-trip).
  assert.equal(frozen.digest, digest);
});
