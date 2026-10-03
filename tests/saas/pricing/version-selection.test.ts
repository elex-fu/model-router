import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import type {
  AppendCustomerPriceVersionInput,
  AppendSupplierCostVersionInput,
  PricingIdentity,
  SupplierPricingIdentity,
} from '../../../src/saas/pricing/types.js';

type Row = Record<string, unknown>;

function result<RowType>(rows: RowType[] = []): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

function customerIdentityMatches(row: Row, values: readonly unknown[]): boolean {
  return [
    'public_model_id',
    'public_model_version',
    'provider_id',
    'product_id',
    'protocol',
    'endpoint',
    'currency',
  ].every((field, index) => String(row[field]) === String(values[index]));
}

function supplierIdentityMatches(row: Row, values: readonly unknown[]): boolean {
  return [
    'public_model_id',
    'public_model_version',
    'provider_id',
    'product_id',
    'resolved_model',
    'protocol',
    'endpoint',
    'currency',
  ].every((field, index) => String(row[field]) === String(values[index]));
}

function priceRow(
  kind: 'customer' | 'supplier',
  identity: PricingIdentity | SupplierPricingIdentity,
  overrides: Partial<Row> = {},
): Row {
  const supplier = kind === 'supplier' ? (identity as SupplierPricingIdentity).resolvedModel : undefined;
  return {
    id: `${kind}-price-1`,
    version: 1,
    public_model_id: identity.publicModelId,
    public_model_version: identity.publicModelVersion,
    provider_id: identity.providerId,
    product_id: identity.productId,
    resolved_model: supplier,
    protocol: identity.protocol,
    endpoint: identity.endpoint,
    currency: identity.currency,
    commercial_policy_version: 'policy-1',
    calculator_version: 'calculator-1',
    rounding_version: 'rounding-1',
    rounding_mode: 'half_up',
    rounding_boundary: 'total',
    input_rate_numerator_minor_units: 2n,
    input_rate_denominator_units: 1n,
    cache_read_rate_numerator_minor_units: null,
    cache_read_rate_denominator_units: null,
    cache_write_rate_numerator_minor_units: null,
    cache_write_rate_denominator_units: null,
    cache_write_5m_rate_numerator_minor_units: null,
    cache_write_5m_rate_denominator_units: null,
    cache_write_1h_rate_numerator_minor_units: null,
    cache_write_1h_rate_denominator_units: null,
    output_rate_numerator_minor_units: 4n,
    output_rate_denominator_units: 1n,
    effective_at: '2026-09-01T00:00:00.000Z',
    expires_at: null,
    idempotency_key: `${kind}-price-1`,
    definition_digest: 'a'.repeat(64),
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function rowFromAppendValues(values: readonly unknown[], kind: 'customer' | 'supplier'): Row {
  const identityLength = kind === 'customer' ? 7 : 8;
  const identityValues = values.slice(2, 2 + identityLength);
  const commonStart = 2 + identityLength;
  const [commercialPolicyVersion, calculatorVersion, roundingVersion, roundingMode, roundingBoundary] = values.slice(
    commonStart,
    commonStart + 5,
  );
  const rateValues = values.slice(commonStart + 5, commonStart + 17);
  const [effectiveAt, expiresAt, idempotencyKey, definitionDigest, createdAt] = values.slice(commonStart + 17);
  const [publicModelId, publicModelVersion, providerId, productId] = identityValues;
  const resolvedModel = kind === 'supplier' ? identityValues[4] : undefined;
  const protocol = kind === 'supplier' ? identityValues[5] : identityValues[4];
  const endpoint = kind === 'supplier' ? identityValues[6] : identityValues[5];
  const currency = kind === 'supplier' ? identityValues[7] : identityValues[6];
  const [
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
  ] = rateValues;
  return {
    id: values[0],
    version: values[1],
    public_model_id: publicModelId,
    public_model_version: publicModelVersion,
    provider_id: providerId,
    product_id: productId,
    resolved_model: resolvedModel,
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
    effective_at: effectiveAt,
    expires_at: expiresAt,
    idempotency_key: idempotencyKey,
    definition_digest: definitionDigest,
    created_at: createdAt,
  };
}

interface Statement {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class RecordingPricingExecutor implements SqlExecutor {
  readonly statements: Statement[] = [];

  constructor(private readonly database: RecordingPricingDatabase) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.statements.push({ sql, values });
    return this.database.execute<RowType>(sql, values);
  }
}

class RecordingPricingDatabase implements SaasDatabase {
  readonly customerPrices: Row[];
  readonly supplierPrices: Row[];
  readonly executors: RecordingPricingExecutor[] = [];
  readonly rootStatements: Statement[] = [];
  transactionCalls = 0;
  failAdvisoryLock = false;

  constructor() {
    this.customerPrices = [priceRow('customer', customerIdentity)];
    this.supplierPrices = [priceRow('supplier', supplierIdentity)];
  }

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.rootStatements.push({ sql, values });
    return this.execute<RowType>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const executor = new RecordingPricingExecutor(this);
    this.executors.push(executor);
    return work(executor);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async execute<RowType>(sql: string, values: readonly unknown[]): Promise<SqlResult<RowType>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (statement.startsWith('select pg_advisory_xact_lock')) {
      if (this.failAdvisoryLock) throw new Error('synthetic lineage lock failure');
      return result();
    }

    const isCustomer = statement.includes('saas_customer_price_versions');
    const isSupplier = statement.includes('saas_supplier_cost_versions');
    if (isCustomer || isSupplier) {
      const kind = isCustomer ? 'customer' : 'supplier';
      const prices = isCustomer ? this.customerPrices : this.supplierPrices;
      if (statement.startsWith('insert into')) {
        const row = rowFromAppendValues(values, kind);
        prices.push(row);
        return result([row]) as SqlResult<RowType>;
      }
      if (statement.startsWith('select version from')) {
        const matches = prices
          .filter((row) => (isCustomer ? customerIdentityMatches(row, values) : supplierIdentityMatches(row, values)))
          .sort((left, right) => Number(right.version) - Number(left.version));
        return result(matches.slice(0, 1).map((row) => ({ version: row.version }))) as SqlResult<RowType>;
      }
      if (statement.startsWith('select id, version')) {
        const identityMatches = isCustomer
          ? (row: Row) => customerIdentityMatches(row, values)
          : (row: Row) => supplierIdentityMatches(row, values);
        let matches = prices.filter(identityMatches);
        const idempotencyParameter = isCustomer ? 7 : 8;
        if (statement.includes(`idempotency_key = $${idempotencyParameter + 1}`)) {
          matches = matches.filter((row) => String(row.idempotency_key) === String(values[idempotencyParameter]));
        } else {
          const atParameter = isCustomer ? 7 : 8;
          const at = new Date(String(values[atParameter])).getTime();
          matches = matches
            .filter(
              (row) =>
                new Date(String(row.effective_at)).getTime() <= at &&
                (row.expires_at === null || new Date(String(row.expires_at)).getTime() > at),
            )
            .sort(
              (left, right) =>
                new Date(String(right.effective_at)).getTime() - new Date(String(left.effective_at)).getTime() ||
                Number(right.version) - Number(left.version),
            );
        }
        return result(matches.slice(0, 1)) as SqlResult<RowType>;
      }
    }

    throw new Error(`Unexpected pricing query: ${statement}`);
  }
}

const customerIdentity: PricingIdentity = {
  publicModelId: 'public-model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
};

const supplierIdentity: SupplierPricingIdentity = {
  ...customerIdentity,
  currency: 'CNY',
  resolvedModel: 'provider-model-1',
};

function commonPriceInput(identity: PricingIdentity | SupplierPricingIdentity, idempotencyKey: string) {
  return {
    ...identity,
    idempotencyKey,
    effectiveAt: '2026-09-01T00:00:00.000Z',
    commercialPolicyVersion: 'policy-1',
    calculatorVersion: 'calculator-1',
    roundingVersion: 'rounding-1',
    roundingMode: 'half_up' as const,
    rates: {
      input: { numeratorMinorUnits: '2', denominatorUnits: '1' },
      output: { numeratorMinorUnits: '4', denominatorUnits: '1' },
    },
  };
}

function advisoryStatements(executor: RecordingPricingExecutor): Statement[] {
  return executor.statements.filter(({ sql }) => sql.toLowerCase().includes('pg_advisory_xact_lock'));
}

function executorAt(database: RecordingPricingDatabase, index: number): RecordingPricingExecutor {
  const executor = database.executors[index];
  assert.ok(executor);
  return executor;
}

function firstAdvisoryKey(executor: RecordingPricingExecutor): unknown {
  const statement = advisoryStatements(executor)[0];
  assert.ok(statement);
  return statement.values[0];
}

test('resolvers reuse a caller executor and use a standalone transaction otherwise', async () => {
  const database = new RecordingPricingDatabase();
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  let callerExecutor: SqlExecutor | undefined;

  await database.transaction(async (executor) => {
    callerExecutor = executor;
    const customer = await service.resolveCustomerPriceVersion(
      { ...customerIdentity, at: '2026-09-28T00:00:00.000Z' },
      { executor },
    );
    const supplier = await service.resolveSupplierCostVersion(
      { ...supplierIdentity, at: '2026-09-28T00:00:00.000Z' },
      { executor },
    );
    assert.equal(customer.id, 'customer-price-1');
    assert.equal(supplier.id, 'supplier-price-1');
    assert.equal(database.transactionCalls, 1);
  });

  const callerRecordingExecutor = executorAt(database, 0);
  assert.equal(callerRecordingExecutor, callerExecutor);
  assert.equal(database.rootStatements.length, 0);
  assert.equal(advisoryStatements(callerRecordingExecutor).length, 2);
  for (const [index, table] of ['saas_customer_price_versions', 'saas_supplier_cost_versions'].entries()) {
    const readIndex = callerRecordingExecutor.statements.findIndex(({ sql }) => sql.includes(`FROM ${table}`));
    const lock = advisoryStatements(callerRecordingExecutor)[index];
    assert.ok(lock);
    assert.ok(readIndex > callerRecordingExecutor.statements.indexOf(lock));
    const read = callerRecordingExecutor.statements[readIndex];
    assert.ok(read);
    assert.doesNotMatch(read.sql, /FOR\s+(?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)/i);
  }

  const standaloneDatabase = new RecordingPricingDatabase();
  const standaloneService = new SaasPricingService(standaloneDatabase, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const resolved = await standaloneService.resolveCustomerPriceVersion(customerIdentity);
  assert.equal(resolved.id, 'customer-price-1');
  assert.equal(standaloneDatabase.transactionCalls, 1);
  assert.equal(standaloneDatabase.executors.length, 1);
  assert.equal(advisoryStatements(executorAt(standaloneDatabase, 0)).length, 1);
  const resolvedSupplier = await standaloneService.resolveSupplierCostVersion(supplierIdentity);
  assert.equal(resolvedSupplier.id, 'supplier-price-1');
  assert.equal(standaloneDatabase.transactionCalls, 2);
  assert.equal(advisoryStatements(executorAt(standaloneDatabase, 1)).length, 1);
});

test('append and resolve share lineage lock keys, while distinct identities stay isolated', async () => {
  const database = new RecordingPricingDatabase();
  let id = 0;
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `generated-${++id}`,
  });

  const appendedCustomer = await service.appendCustomerPriceVersion(
    commonPriceInput(customerIdentity, 'customer-append-2') as AppendCustomerPriceVersionInput,
  );
  const appendedCustomerLock = firstAdvisoryKey(executorAt(database, 0));
  const resolvedCustomer = await service.resolveCustomerPriceVersion(customerIdentity);
  const resolvedCustomerLock = firstAdvisoryKey(executorAt(database, 1));
  assert.equal(resolvedCustomer.id, appendedCustomer.id);
  assert.equal(resolvedCustomerLock, appendedCustomerLock);

  await service.appendCustomerPriceVersion(
    commonPriceInput(
      { ...customerIdentity, productId: 'product-2' },
      'customer-distinct',
    ) as AppendCustomerPriceVersionInput,
  );
  const distinctCustomerLock = firstAdvisoryKey(executorAt(database, 2));
  assert.notEqual(distinctCustomerLock, appendedCustomerLock);

  const appendedSupplier = await service.appendSupplierCostVersion(
    commonPriceInput(supplierIdentity, 'supplier-append-2') as AppendSupplierCostVersionInput,
  );
  const appendedSupplierLock = firstAdvisoryKey(executorAt(database, 3));
  const resolvedSupplier = await service.resolveSupplierCostVersion(supplierIdentity);
  const resolvedSupplierLock = firstAdvisoryKey(executorAt(database, 4));
  assert.equal(resolvedSupplier.id, appendedSupplier.id);
  assert.equal(resolvedSupplierLock, appendedSupplierLock);

  await service.appendSupplierCostVersion(
    commonPriceInput(
      { ...supplierIdentity, resolvedModel: 'provider-model-2' },
      'supplier-distinct',
    ) as AppendSupplierCostVersionInput,
  );
  const distinctSupplierLock = firstAdvisoryKey(executorAt(database, 5));
  assert.notEqual(distinctSupplierLock, appendedSupplierLock);
});

test('both resolvers fail closed before reading prices when their lineage mutex fails', async () => {
  for (const kind of ['customer', 'supplier'] as const) {
    const database = new RecordingPricingDatabase();
    database.failAdvisoryLock = true;
    const service = new SaasPricingService(database);
    await assert.rejects(
      kind === 'customer'
        ? service.resolveCustomerPriceVersion(customerIdentity)
        : service.resolveSupplierCostVersion(supplierIdentity),
      (error: unknown) => error instanceof SaasPricingError && error.code === 'PRICING_STORAGE_ERROR',
    );
    const executor = executorAt(database, 0);
    assert.equal(executor.statements.length, 1);
    assert.match(executor.statements[0]?.sql ?? '', /^SELECT pg_advisory_xact_lock/);
    assert.equal(database.rootStatements.length, 0);
  }
});

test('both resolvers retain exact effective-window and complete identity selection', async () => {
  const database = new RecordingPricingDatabase();
  for (const [kind, identity, prices] of [
    ['customer', customerIdentity, database.customerPrices],
    ['supplier', supplierIdentity, database.supplierPrices],
  ] as const) {
    prices.push(
      priceRow(kind, identity, { id: `${kind}-expired`, version: 2, expires_at: '2026-09-28T00:00:00.000Z' }),
      priceRow(kind, identity, { id: `${kind}-future`, version: 3, effective_at: '2026-09-29T00:00:00.000Z' }),
      priceRow(kind, { ...identity, productId: 'other-product' }, { id: `${kind}-other-product`, version: 4 }),
    );
  }
  const service = new SaasPricingService(database, { now: () => new Date('2026-09-28T00:00:00.000Z') });
  assert.equal((await service.resolveCustomerPriceVersion(customerIdentity)).id, 'customer-price-1');
  assert.equal((await service.resolveSupplierCostVersion(supplierIdentity)).id, 'supplier-price-1');
  database.customerPrices.splice(0);
  database.supplierPrices.splice(0);
  for (const resolve of [
    () => service.resolveCustomerPriceVersion(customerIdentity),
    () => service.resolveSupplierCostVersion(supplierIdentity),
  ]) {
    await assert.rejects(
      resolve(),
      (error: unknown) => error instanceof SaasPricingError && error.code === 'PRICE_VERSION_NOT_EFFECTIVE',
    );
  }
});
