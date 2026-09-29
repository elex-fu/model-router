import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import type {
  CreateCustomerPriceSnapshotInput,
  CreateSupplierCostSnapshotInput,
} from '../../../src/saas/pricing/types.js';

type Row = Record<string, unknown>;

function result<RowType>(rows: RowType[] = []): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

const requestRow = (): Row => ({
  tenant_id: 'tenant-1',
  id: 'request-1',
  supply_mode: 'platform',
  protocol: 'openai',
  endpoint: 'chat-completions',
});

const attemptRow = (): Row => ({
  attempt_tenant_id: 'tenant-1',
  attempt_request_id: 'request-1',
  platform_account_id: 'platform-account-1',
  attempt_provider_id: 'provider-1',
  attempt_product_id: 'product-1',
  attempt_resolved_model: 'provider-model-1',
  attempt_protocol: 'openai',
  attempt_endpoint: 'chat-completions',
  attempt_supplier_cost_version: 'supplier-price-1',
  request_tenant_id: 'tenant-1',
  request_id: 'request-1',
  request_supply_mode: 'platform',
  request_protocol: 'openai',
  request_endpoint: 'chat-completions',
});

const customerPriceRow: Row = {
  id: 'customer-price-1',
  version: 1,
  public_model_id: 'public-model-1',
  public_model_version: 1,
  provider_id: 'provider-1',
  product_id: 'product-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  commercial_policy_version: 'policy-1',
  calculator_version: 'calculator-1',
  rounding_version: 'rounding-1',
  rounding_mode: 'half_up',
  rounding_boundary: 'total',
  input_rate_numerator_minor_units: 3n,
  input_rate_denominator_units: 2n,
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
  effective_at: '2026-09-01T00:00:00.000Z',
  expires_at: null,
  idempotency_key: 'customer-price-1',
  definition_digest: 'a'.repeat(64),
  created_at: '2026-09-01T00:00:00.000Z',
};

const supplierPriceRow: Row = {
  ...customerPriceRow,
  id: 'supplier-price-1',
  currency: 'CNY',
  resolved_model: 'provider-model-1',
  input_rate_numerator_minor_units: 1n,
  input_rate_denominator_units: 1n,
  idempotency_key: 'supplier-price-1',
  definition_digest: 'b'.repeat(64),
};

function customerSnapshotRow(values: readonly unknown[]): Row {
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
    holdAmountMinorUnits,
    walletHoldRequired,
    admissionExpiresAt,
    idempotencyKey,
    snapshotDigest,
    createdAt,
  ] = values;
  return {
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
    hold_amount_minor_units: holdAmountMinorUnits,
    wallet_hold_required: walletHoldRequired,
    admission_expires_at: admissionExpiresAt,
    idempotency_key: idempotencyKey,
    snapshot_digest: snapshotDigest,
    created_at: createdAt,
  };
}

function supplierSnapshotRow(values: readonly unknown[]): Row {
  const [
    id,
    tenantId,
    requestId,
    attemptId,
    supplierCostVersion,
    platformAccountId,
    publicModelId,
    publicModelVersion,
    providerId,
    productId,
    resolvedModel,
    protocol,
    endpoint,
    currency,
    commercialPolicyVersion,
    calculatorVersion,
    roundingVersion,
    roundingMode,
    roundingBoundary,
    idempotencyKey,
    snapshotDigest,
    createdAt,
  ] = values;
  return {
    id,
    tenant_id: tenantId,
    request_id: requestId,
    attempt_id: attemptId,
    supplier_cost_version: supplierCostVersion,
    platform_account_id: platformAccountId,
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
    idempotency_key: idempotencyKey,
    snapshot_digest: snapshotDigest,
    created_at: createdAt,
  };
}

interface PricingState {
  request: Row | null;
  attempt: Row | null;
  customerSnapshots: Row[];
  supplierSnapshots: Row[];
}

function emptyState(): PricingState {
  return {
    request: null,
    attempt: null,
    customerSnapshots: [],
    supplierSnapshots: [],
  };
}

class RecordingPricingExecutor implements SqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(
    private readonly state: PricingState,
    private readonly customerPrice = customerPriceRow,
    private readonly supplierPrice = supplierPriceRow,
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.statements.push({ sql, values });
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (statement.startsWith('insert into saas_requests')) {
      this.state.request = requestRow();
      return result<RowType>();
    }
    if (statement.startsWith('insert into saas_attempts')) {
      this.state.attempt = attemptRow();
      return result<RowType>();
    }
    if (statement.startsWith('select supply_mode, protocol, endpoint from saas_requests')) {
      return result(
        this.state.request &&
          String(this.state.request.tenant_id) === String(values[0]) &&
          String(this.state.request.id) === String(values[1])
          ? [
              {
                supply_mode: this.state.request.supply_mode,
                protocol: this.state.request.protocol,
                endpoint: this.state.request.endpoint,
              },
            ]
          : [],
      ) as SqlResult<RowType>;
    }
    if (statement.includes('from saas_request_customer_price_snapshots')) {
      return result(
        this.state.customerSnapshots.filter(
          (row) => String(row.tenant_id) === String(values[0]) && String(row.request_id) === String(values[1]),
        ),
      ) as SqlResult<RowType>;
    }
    if (statement.includes('from saas_attempt_supplier_cost_snapshots')) {
      return result(
        this.state.supplierSnapshots.filter(
          (row) =>
            String(row.tenant_id) === String(values[0]) &&
            String(row.request_id) === String(values[1]) &&
            String(row.attempt_id) === String(values[2]),
        ),
      ) as SqlResult<RowType>;
    }
    if (statement.includes('from saas_customer_price_versions')) {
      return result(
        String(this.customerPrice.id) === String(values[0]) ? [this.customerPrice] : [],
      ) as SqlResult<RowType>;
    }
    if (statement.includes('from saas_supplier_cost_versions')) {
      return result(
        String(this.supplierPrice.id) === String(values[0]) ? [this.supplierPrice] : [],
      ) as SqlResult<RowType>;
    }
    if (statement.startsWith('select id from saas_platform_provider_accounts')) {
      return result(
        values[0] === 'platform-account-1' && values[1] === 'provider-1' && values[2] === 'product-1'
          ? [{ id: values[0] }]
          : [],
      ) as SqlResult<RowType>;
    }
    if (statement.startsWith('select column_name from information_schema.columns')) {
      return result(
        [
          'platform_account_id',
          'provider_id',
          'product_id',
          'endpoint',
          'resolved_model',
          'protocol',
          'supplier_cost_version',
        ].map((column_name) => ({ column_name })),
      ) as SqlResult<RowType>;
    }
    if (statement.includes('from saas_attempts as a')) {
      return result(this.state.attempt ? [this.state.attempt] : []) as SqlResult<RowType>;
    }
    if (statement.startsWith('insert into saas_request_customer_price_snapshots')) {
      const row = customerSnapshotRow(values);
      this.state.customerSnapshots.push(row);
      return result([row]) as SqlResult<RowType>;
    }
    if (statement.startsWith('insert into saas_attempt_supplier_cost_snapshots')) {
      const row = supplierSnapshotRow(values);
      this.state.supplierSnapshots.push(row);
      return result([row]) as SqlResult<RowType>;
    }

    throw new Error(`Unexpected pricing query: ${statement}`);
  }
}

class RecordingPricingDatabase implements SaasDatabase {
  state = emptyState();
  readonly executors: RecordingPricingExecutor[] = [];
  transactionCalls = 0;
  commits = 0;
  rollbacks = 0;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    return new RecordingPricingExecutor(this.state).query<RowType>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const next = structuredClone(this.state);
    const executor = new RecordingPricingExecutor(next);
    this.executors.push(executor);
    try {
      const value = await work(executor);
      this.state = next;
      this.commits += 1;
      return value;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const customerInput: CreateCustomerPriceSnapshotInput = {
  tenantId: 'tenant-1',
  requestId: 'request-1',
  customerPriceVersion: 'customer-price-1',
  holdInput: {
    inputTotal: '2',
    inputUncached: '2',
    cacheRead: '0',
    cacheWrite: '0',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    outputTotal: '0',
    reasoningOutput: '0',
  },
  admissionExpiresAt: '2026-09-28T00:05:00.000Z',
  idempotencyKey: 'request-1',
};

const supplierInput: CreateSupplierCostSnapshotInput = {
  tenantId: 'tenant-1',
  requestId: 'request-1',
  attemptId: 'attempt-1',
  supplierCostVersion: 'supplier-price-1',
  platformAccountId: 'platform-account-1',
  idempotencyKey: 'attempt-1',
};

test('snapshot creation uses the admission executor and preserves standalone transactions', async () => {
  const database = new RecordingPricingDatabase();
  let snapshotId = 0;
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `snapshot-${++snapshotId}`,
  });

  await assert.rejects(
    database.transaction(async (executor) => {
      await executor.query('INSERT INTO saas_requests (tenant_id, id) VALUES ($1, $2)', ['tenant-1', 'request-1']);
      await executor.query('INSERT INTO saas_attempts (tenant_id, request_id, id) VALUES ($1, $2, $3)', [
        'tenant-1',
        'request-1',
        'attempt-1',
      ]);

      const customer = await service.createCustomerPriceSnapshot(customerInput, { executor });
      const supplier = await service.createSupplierCostSnapshot(supplierInput, { executor });

      assert.equal(customer.snapshot.holdAmountMinorUnits, 3n);
      assert.equal(supplier.attemptId, 'attempt-1');
      assert.equal(database.transactionCalls, 1);
      assert.equal(database.executors.length, 1);
      assert.equal(database.executors[0], executor);
      assert.ok(
        database.executors[0]?.statements.some(({ sql }) => sql.includes('saas_request_customer_price_snapshots')),
      );
      assert.ok(
        database.executors[0]?.statements.some(({ sql }) => sql.includes('saas_attempt_supplier_cost_snapshots')),
      );

      throw new Error('wallet admission failed');
    }),
    /wallet admission failed/,
  );

  assert.equal(database.rollbacks, 1);
  assert.equal(database.state.request, null);
  assert.equal(database.state.attempt, null);
  assert.equal(database.state.customerSnapshots.length, 0);
  assert.equal(database.state.supplierSnapshots.length, 0);

  database.state.request = requestRow();
  database.state.attempt = attemptRow();
  const standaloneCustomer = await service.createCustomerPriceSnapshot(customerInput);
  const standaloneSupplier = await service.createSupplierCostSnapshot(supplierInput);

  assert.equal(standaloneCustomer.snapshot.holdAmountMinorUnits, 3n);
  assert.equal(standaloneSupplier.supplierCostVersion, 'supplier-price-1');
  assert.equal(database.transactionCalls, 3);
  assert.equal(database.commits, 2);
  assert.equal(database.state.customerSnapshots.length, 1);
  assert.equal(database.state.supplierSnapshots.length, 1);
});
