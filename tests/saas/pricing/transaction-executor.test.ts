import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
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
  id: 'attempt-1',
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
  account: Row | null;
  customerSnapshots: Row[];
  supplierSnapshots: Row[];
}

function emptyState(): PricingState {
  return {
    request: null,
    attempt: null,
    account: {
      id: 'platform-account-1',
      provider_id: 'provider-1',
      product_id: 'product-1',
      owner_kind: 'platform',
      supply_mode: 'platform',
    },
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
    private readonly advisoryFailure: 'snapshot' | 'account' | null = null,
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.statements.push({ sql, values });
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (statement.startsWith('select pg_advisory_xact_lock')) {
      const kind = statement.startsWith('select pg_advisory_xact_lock_shared') ? 'account' : 'snapshot';
      if (kind === this.advisoryFailure) throw new Error('synthetic pricing fence failure');
      return result<RowType>();
    }
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
      const account = this.state.account;
      return result(
        account &&
          account.id === values[0] &&
          account.provider_id === values[1] &&
          account.product_id === values[2] &&
          account.owner_kind === 'platform' &&
          account.supply_mode === 'platform'
          ? [{ id: account.id }]
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
      const attempt = this.state.attempt;
      return result(
        attempt &&
          attempt.attempt_tenant_id === values[0] &&
          attempt.id === values[1] &&
          attempt.attempt_request_id === values[2] &&
          attempt.request_tenant_id === values[0] &&
          attempt.request_id === values[2]
          ? [attempt]
          : [],
      ) as SqlResult<RowType>;
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
  advisoryFailure: 'snapshot' | 'account' | null = null;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    return new RecordingPricingExecutor(this.state).query<RowType>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const next = structuredClone(this.state);
    const executor = new RecordingPricingExecutor(next, customerPriceRow, supplierPriceRow, this.advisoryFailure);
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

function readyDatabase(): RecordingPricingDatabase {
  const database = new RecordingPricingDatabase();
  database.state.request = requestRow();
  database.state.attempt = attemptRow();
  return database;
}

function pricingService(database: SaasDatabase): SaasPricingService {
  let id = 0;
  return new SaasPricingService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    idFactory: () => `snapshot-${++id}`,
  });
}

function hasPricingCode(code: ConstructorParameters<typeof SaasPricingError>[0]) {
  return (error: unknown): boolean => error instanceof SaasPricingError && error.code === code;
}

function isSnapshotMutex(sql: string): boolean {
  return sql.startsWith('SELECT pg_advisory_xact_lock(') && sql.includes("'saas-pricing-snapshot-v1'");
}

function assertSnapshotLockOrder(executor: RecordingPricingExecutor, kind: 'customer' | 'supplier'): unknown {
  const statements = executor.statements;
  const requestIndex = statements.findIndex(({ sql }) => sql.includes('FROM saas_requests'));
  const mutexIndex = statements.findIndex(({ sql }) => isSnapshotMutex(sql));
  const table = kind === 'customer' ? 'saas_request_customer_price_snapshots' : 'saas_attempt_supplier_cost_snapshots';
  const snapshotIndex = statements.findIndex(({ sql }) => sql.includes(`FROM ${table}`));
  assert.ok(requestIndex >= 0 && mutexIndex > requestIndex && snapshotIndex > mutexIndex);
  assert.match(statements[requestIndex]?.sql ?? '', /FOR SHARE/);
  const mutex = statements[mutexIndex];
  assert.ok(mutex);
  assert.deepEqual(mutex.values, [kind, 'tenant-1', 'request-1', kind === 'supplier' ? 'attempt-1' : null]);
  for (const slot of [2, 3, 4]) assert.ok(mutex.sql.includes(`$${slot}::uuid::text`));
  for (const { sql } of statements) {
    if (
      /FROM saas_(?:customer_price_versions|supplier_cost_versions|request_customer_price_snapshots|attempt_supplier_cost_snapshots|platform_provider_accounts)\b/.test(sql)
    ) {
      assert.doesNotMatch(sql, /FOR\s+(?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)/i);
    }
  }
  if (kind === 'supplier') {
    const accountFence = statements[0];
    assert.ok(accountFence);
    assert.equal(accountFence.sql, 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))');
    assert.deepEqual(accountFence.values, [saasAdvisoryKey.platformProviderAccount('platform-account-1')]);
    const accountReadIndex = statements.findIndex(({ sql }) => sql.includes('FROM saas_platform_provider_accounts'));
    assert.ok(accountReadIndex > snapshotIndex);
    const accountRead = statements[accountReadIndex];
    assert.ok(accountRead);
    assert.match(accountRead.sql, /owner_kind = 'platform'/);
    assert.match(accountRead.sql, /supply_mode = 'platform'/);
    assert.deepEqual(accountRead.values, ['platform-account-1', 'provider-1', 'product-1']);
    const attemptIndex = statements.findIndex(({ sql }) => sql.includes('FROM saas_attempts AS a'));
    assert.ok(attemptIndex > requestIndex && attemptIndex < mutexIndex);
    assert.match(statements[attemptIndex]?.sql ?? '', /FOR SHARE/);
  }
  return JSON.stringify(mutex.values);
}

test('both immutable snapshot paths lock before fresh reads and replay exactly once', async () => {
  const database = readyDatabase();
  const service = pricingService(database);
  const customer = await service.createCustomerPriceSnapshot(customerInput);
  const supplier = await service.createSupplierCostSnapshot(supplierInput);
  const customerExecutor = database.executors[0];
  const supplierExecutor = database.executors[1];
  assert.ok(customerExecutor && supplierExecutor);
  const customerKey = assertSnapshotLockOrder(customerExecutor, 'customer');
  const supplierKey = assertSnapshotLockOrder(supplierExecutor, 'supplier');
  assert.notEqual(customerKey, supplierKey);
  assert.deepEqual(await service.createCustomerPriceSnapshot(customerInput), customer);
  assert.deepEqual(await service.createSupplierCostSnapshot(supplierInput), supplier);
  for (const [index, expectedKey] of [[2, customerKey], [3, supplierKey]] as const) {
    const replayExecutor = database.executors[index];
    assert.ok(replayExecutor);
    const mutex = replayExecutor.statements.find(({ sql }) => isSnapshotMutex(sql));
    assert.ok(mutex);
    assert.equal(JSON.stringify(mutex.values), expectedKey);
    assert.equal(replayExecutor.statements.some(({ sql }) => sql.startsWith('INSERT INTO')), false);
  }
  assert.equal(database.state.customerSnapshots.length, 1);
  assert.equal(database.state.supplierSnapshots.length, 1);

  await assert.rejects(
    service.createCustomerPriceSnapshot({
      ...customerInput,
      holdInput: { ...customerInput.holdInput, inputTotal: '3', inputUncached: '3' },
    }),
    hasPricingCode('SNAPSHOT_CONFLICT'),
  );
  await assert.rejects(
    service.createSupplierCostSnapshot({ ...supplierInput, idempotencyKey: 'conflicting-key' }),
    hasPricingCode('SNAPSHOT_CONFLICT'),
  );
  await assert.rejects(
    service.createSupplierCostSnapshot({ ...supplierInput, platformAccountId: 'other-account' }),
    hasPricingCode('SNAPSHOT_CONFLICT'),
  );
  assert.equal(database.state.customerSnapshots.length, 1);
  assert.equal(database.state.supplierSnapshots.length, 1);
  assert.equal(database.rollbacks, 3);
  for (const [index, expectedKey] of [[4, customerKey], [5, supplierKey], [6, supplierKey]] as const) {
    const mutex = database.executors[index]?.statements.find(
      ({ sql }) => isSnapshotMutex(sql),
    );
    assert.ok(mutex);
    assert.equal(JSON.stringify(mutex.values), expectedKey);
  }
});

test('BYOK and mismatched supplier authority still cannot create snapshots', async () => {
  for (const kind of ['customer', 'supplier'] as const) {
    const database = readyDatabase();
    database.state.request = { ...requestRow(), supply_mode: 'byok' };
    const service = pricingService(database);
    await assert.rejects(
      kind === 'customer'
        ? service.createCustomerPriceSnapshot(customerInput)
        : service.createSupplierCostSnapshot(supplierInput),
      hasPricingCode('PLATFORM_REQUEST_REQUIRED'),
    );
    assert.equal(database.state.customerSnapshots.length + database.state.supplierSnapshots.length, 0);
    assert.equal(database.executors[0]?.statements.some(({ sql }) => sql.startsWith('INSERT INTO')), false);
  }
  for (const field of [
    'platform_account_id',
    'attempt_tenant_id',
    'attempt_request_id',
    'attempt_provider_id',
    'attempt_product_id',
    'attempt_resolved_model',
    'attempt_protocol',
    'attempt_endpoint',
    'attempt_supplier_cost_version',
  ] as const) {
    const database = readyDatabase();
    database.state.attempt = { ...attemptRow(), [field]: 'mismatch' };
    await assert.rejects(
      pricingService(database).createSupplierCostSnapshot(supplierInput),
      hasPricingCode('SUPPLIER_ATTEMPT_BINDING_MISMATCH'),
    );
    assert.equal(database.state.supplierSnapshots.length, 0);
  }
  for (const field of ['provider_id', 'product_id', 'owner_kind', 'supply_mode'] as const) {
    const database = readyDatabase();
    database.state.account = { ...database.state.account, [field]: 'mismatch' };
    await assert.rejects(
      pricingService(database).createSupplierCostSnapshot(supplierInput),
      hasPricingCode('SUPPLIER_ACCOUNT_NOT_FOUND'),
    );
    assert.equal(database.state.supplierSnapshots.length, 0);
  }
  for (const kind of ['customer', 'supplier'] as const) {
    const database = readyDatabase();
    database.state.request = { ...requestRow(), endpoint: 'other-endpoint' };
    const service = pricingService(database);
    await assert.rejects(
      kind === 'customer'
        ? service.createCustomerPriceSnapshot(customerInput)
        : service.createSupplierCostSnapshot(supplierInput),
      hasPricingCode('REQUEST_BINDING_MISMATCH'),
    );
    assert.equal(database.state.customerSnapshots.length + database.state.supplierSnapshots.length, 0);
  }
});

test('snapshot or account fence failure prevents subsequent snapshot reads and inserts', async () => {
  for (const [kind, failure] of [['customer', 'snapshot'], ['supplier', 'snapshot'], ['supplier', 'account']] as const) {
    const database = readyDatabase();
    database.advisoryFailure = failure;
    const service = pricingService(database);
    await assert.rejects(
      kind === 'customer'
        ? service.createCustomerPriceSnapshot(customerInput)
        : service.createSupplierCostSnapshot(supplierInput),
      hasPricingCode('PRICING_STORAGE_ERROR'),
    );
    const executor = database.executors[0];
    assert.ok(executor);
    assert.equal(
      executor.statements.some(({ sql }) => /FROM saas_(?:request_customer_price_snapshots|attempt_supplier_cost_snapshots)/.test(sql)),
      false,
    );
    assert.equal(executor.statements.some(({ sql }) => sql.startsWith('INSERT INTO')), false);
    if (failure === 'account') assert.equal(executor.statements.length, 1);
    assert.equal(database.state.customerSnapshots.length + database.state.supplierSnapshots.length, 0);
  }
});

test('snapshot mutex identities isolate tenants, requests and supplier attempts, not idempotency keys', async () => {
  async function keyFor(
    kind: 'customer' | 'supplier',
    tenantId: string,
    requestId: string,
    attemptId: string,
  ): Promise<unknown> {
    const database = readyDatabase();
    database.state.request = { ...requestRow(), tenant_id: tenantId, id: requestId };
    database.state.attempt = {
      ...attemptRow(),
      id: attemptId,
      attempt_tenant_id: tenantId,
      request_tenant_id: tenantId,
      attempt_request_id: requestId,
      request_id: requestId,
    };
    const service = pricingService(database);
    if (kind === 'customer') await service.createCustomerPriceSnapshot({ ...customerInput, tenantId, requestId });
    else await service.createSupplierCostSnapshot({ ...supplierInput, tenantId, requestId, attemptId });
    const executor = database.executors[0];
    assert.ok(executor);
    const mutex = executor.statements.find(({ sql }) => isSnapshotMutex(sql));
    assert.ok(mutex);
    return JSON.stringify(mutex.values);
  }
  const customer = await keyFor('customer', 'tenant-1', 'request-1', 'attempt-1');
  assert.notEqual(await keyFor('customer', 'tenant-2', 'request-1', 'attempt-1'), customer);
  assert.notEqual(await keyFor('customer', 'tenant-1', 'request-2', 'attempt-1'), customer);
  const supplier = await keyFor('supplier', 'tenant-1', 'request-1', 'attempt-1');
  assert.notEqual(supplier, customer);
  assert.notEqual(await keyFor('supplier', 'tenant-2', 'request-1', 'attempt-1'), supplier);
  assert.notEqual(await keyFor('supplier', 'tenant-1', 'request-2', 'attempt-1'), supplier);
  assert.notEqual(await keyFor('supplier', 'tenant-1', 'request-1', 'attempt-2'), supplier);
});

test('supplier account identity is read fresh after its native shared fence wait', async () => {
  const database = readyDatabase();
  const recording = new RecordingPricingExecutor(database.state);
  const executor: SqlExecutor = {
    query: async <RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> => {
      const result = await recording.query<RowType>(sql, values);
      if (sql === 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))') {
        database.state.account = { ...database.state.account, owner_kind: 'tenant' };
      }
      return result;
    },
  };
  await assert.rejects(
    pricingService(database).createSupplierCostSnapshot(supplierInput, { executor }),
    hasPricingCode('SUPPLIER_ACCOUNT_NOT_FOUND'),
  );
  assert.equal(database.transactionCalls, 0);
  assert.equal(
    recording.statements.filter(({ sql }) => sql.includes('FROM saas_platform_provider_accounts')).length,
    1,
  );
  assert.equal(recording.statements.some(({ sql }) => sql.startsWith('INSERT INTO')), false);
});

// This unit executor models only transaction-held advisory waits; real PG verifies the actual locks/ACLs.
class ConcurrentPricingDatabase extends RecordingPricingDatabase {
  private readonly tails = new Map<string, Promise<void>>();

  private async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    assert.ok(release);
    const unlock = release;
    return () => {
      unlock();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  override async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const executor = new RecordingPricingExecutor(this.state);
    this.executors.push(executor);
    const held = new Set<string>();
    const releases: Array<() => void> = [];
    const transaction: SqlExecutor = {
      query: async <RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> => {
        if (isSnapshotMutex(sql)) {
          const key = JSON.stringify(values);
          if (!held.has(key)) {
            releases.push(await this.acquire(key));
            held.add(key);
          }
        }
        return executor.query<RowType>(sql, values);
      },
    };
    try {
      const value = await work(transaction);
      this.commits += 1;
      return value;
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

test('concurrent identical snapshot creators serialize missing rows into one insert per family', { timeout: 5_000 }, async () => {
  for (const kind of ['customer', 'supplier'] as const) {
    const database = new ConcurrentPricingDatabase();
    database.state.request = requestRow();
    database.state.attempt = attemptRow();
    const service = pricingService(database);
    const create = kind === 'customer'
      ? async () => (await service.createCustomerPriceSnapshot(customerInput)).snapshot
      : () => service.createSupplierCostSnapshot(supplierInput);
    const [first, replay] = await Promise.all([create(), create()]);
    assert.equal(first.id, replay.id);
    assert.equal(first.snapshotDigest, replay.snapshotDigest);
    assert.equal(database.state.customerSnapshots.length + database.state.supplierSnapshots.length, 1);
    assert.equal(
      database.executors.flatMap(({ statements }) => statements).filter(({ sql }) => sql.startsWith('INSERT INTO')).length,
      1,
    );
    assert.equal(database.commits, 2);
  }
});

test('concurrent conflicting snapshot creators observe the committed digest and do not insert again', { timeout: 5_000 }, async () => {
  for (const kind of ['customer', 'supplier'] as const) {
    const database = new ConcurrentPricingDatabase();
    database.state.request = requestRow();
    database.state.attempt = attemptRow();
    const service = pricingService(database);
    const first = kind === 'customer'
      ? service.createCustomerPriceSnapshot(customerInput)
      : service.createSupplierCostSnapshot(supplierInput);
    const conflict = kind === 'customer'
      ? service.createCustomerPriceSnapshot({ ...customerInput, idempotencyKey: 'conflicting-key' })
      : service.createSupplierCostSnapshot({ ...supplierInput, idempotencyKey: 'conflicting-key' });
    await Promise.all([first, assert.rejects(conflict, hasPricingCode('SNAPSHOT_CONFLICT'))]);
    assert.equal(database.state.customerSnapshots.length + database.state.supplierSnapshots.length, 1);
    assert.equal(
      database.executors.flatMap(({ statements }) => statements).filter(({ sql }) => sql.startsWith('INSERT INTO')).length,
      1,
    );
    assert.equal(database.commits, 1);
  }
});
