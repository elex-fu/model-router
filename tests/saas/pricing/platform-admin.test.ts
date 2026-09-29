import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/index.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminReadHandlerOptions,
} from '../../../src/saas/platform/http/index.js';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';

type Row = Record<string, unknown>;

function result<RowType>(rows: RowType[] = []): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

const PRICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET = {
  public_model_id: 'public-model-1',
  public_model_version: 3,
  public_model_alias: 'chat-model',
  display_name: 'Chat Model',
  provider_id: 'provider-server-resolved',
  product_id: 'product-server-resolved',
  resolved_model: 'provider/model-v3',
  protocol: 'openai',
  endpoint: 'chat-completions',
  capability_version: 7,
};

function customerPriceRow(values: readonly unknown[]): Row {
  return {
    id: values[0],
    version: values[1],
    public_model_id: values[2],
    public_model_version: values[3],
    provider_id: values[4],
    product_id: values[5],
    protocol: values[6],
    endpoint: values[7],
    currency: values[8],
    commercial_policy_version: values[9],
    calculator_version: values[10],
    rounding_version: values[11],
    rounding_mode: values[12],
    rounding_boundary: values[13],
    input_rate_numerator_minor_units: values[14],
    input_rate_denominator_units: values[15],
    cache_read_rate_numerator_minor_units: values[16],
    cache_read_rate_denominator_units: values[17],
    cache_write_rate_numerator_minor_units: values[18],
    cache_write_rate_denominator_units: values[19],
    cache_write_5m_rate_numerator_minor_units: values[20],
    cache_write_5m_rate_denominator_units: values[21],
    cache_write_1h_rate_numerator_minor_units: values[22],
    cache_write_1h_rate_denominator_units: values[23],
    output_rate_numerator_minor_units: values[24],
    output_rate_denominator_units: values[25],
    effective_at: values[26],
    expires_at: values[27],
    idempotency_key: values[28],
    definition_digest: values[29],
    created_at: values[30],
  };
}

function supplierPriceRow(values: readonly unknown[]): Row {
  const customerValues = [
    values[0],
    values[1],
    values[2],
    values[3],
    values[4],
    values[5],
    values[7],
    values[8],
    values[9],
    values[10],
    values[11],
    values[12],
    values[13],
    values[14],
    values[15],
    values[16],
    values[17],
    values[18],
    values[19],
    values[20],
    values[21],
    values[22],
    values[23],
    values[24],
    values[25],
    values[26],
    values[27],
    values[28],
    values[29],
    values[30],
    values[31],
  ];
  return { ...customerPriceRow(customerValues), resolved_model: values[6] };
}

interface PriceState {
  prices: Row[];
  supplierPrices: Row[];
  audits: Row[];
}

class PricingTransaction implements SqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  failAudit = false;

  constructor(readonly state: PriceState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.statements.push({ sql, values });
    const statement = sql.replace(/\s+/gu, ' ').trim().toLowerCase();
    if (statement.startsWith('with latest_capability')) return result([TARGET] as RowType[]);
    if (statement.startsWith('select pg_advisory_xact_lock')) return result<RowType>();
    if (statement.startsWith('select id, version') && statement.includes('from saas_supplier_cost_versions')) {
      const found = this.state.supplierPrices.find(
        (row) =>
          row.public_model_id === values[0] &&
          Number(row.public_model_version) === Number(values[1]) &&
          row.provider_id === values[2] &&
          row.product_id === values[3] &&
          row.resolved_model === values[4] &&
          row.protocol === values[5] &&
          row.endpoint === values[6] &&
          row.currency === values[7] &&
          row.idempotency_key === values[8],
      );
      return result(found ? [found as RowType] : []);
    }
    if (statement.startsWith('select version') && statement.includes('from saas_supplier_cost_versions')) {
      const matching = this.state.supplierPrices.filter((row) => row.public_model_id === values[0]);
      const version = matching.reduce<number>((max, row) => Math.max(max, Number(row.version)), 0);
      return result(version > 0 ? [{ version } as RowType] : []);
    }
    if (statement.startsWith('select id, version') && statement.includes('from saas_customer_price_versions')) {
      const found = this.state.prices.find(
        (row) =>
          row.public_model_id === values[0] &&
          Number(row.public_model_version) === Number(values[1]) &&
          row.provider_id === values[2] &&
          row.product_id === values[3] &&
          row.protocol === values[4] &&
          row.endpoint === values[5] &&
          row.currency === values[6] &&
          row.idempotency_key === values[7],
      );
      return result(found ? [found as RowType] : []);
    }
    if (statement.startsWith('select version') && statement.includes('from saas_customer_price_versions')) {
      const matching = this.state.prices.filter((row) => row.public_model_id === values[0]);
      const version = matching.reduce<number>((max, row) => Math.max(max, Number(row.version)), 0);
      return result(version > 0 ? [{ version } as RowType] : []);
    }
    if (statement.startsWith('insert into saas_customer_price_versions')) {
      const row = customerPriceRow(values);
      this.state.prices.push(row);
      return result([row as RowType]);
    }
    if (statement.startsWith('insert into saas_supplier_cost_versions')) {
      const row = supplierPriceRow(values);
      this.state.supplierPrices.push(row);
      return result([row as RowType]);
    }
    if (statement.startsWith('insert into saas_audit_events')) {
      if (this.failAudit) throw new Error('audit insert failed');
      const [id, actorUserId, action, targetType, targetId, occurredAt, sourceIp, userAgent, entryPoint, requestId] =
        values;
      const event = {
        id,
        tenant_id: null,
        actor_user_id: actorUserId,
        action,
        target_type: targetType,
        target_id: targetId,
        occurred_at: occurredAt,
        source_ip: sourceIp,
        user_agent: userAgent,
        entry_point: entryPoint,
        request_id: requestId,
      };
      this.state.audits.push(event);
      return result([event as RowType]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

class PricingDatabase implements SaasDatabase {
  state: PriceState = { prices: [], supplierPrices: [], audits: [] };
  transactions: PricingTransaction[] = [];
  rollbackCount = 0;
  failAudit = false;

  async query<RowType>(): Promise<SqlResult<RowType>> {
    throw new Error('platform price registration must use a transaction executor');
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const transaction = new PricingTransaction({
      prices: [...this.state.prices],
      supplierPrices: [...this.state.supplierPrices],
      audits: [...this.state.audits],
    });
    transaction.failAudit = this.failAudit;
    this.transactions.push(transaction);
    try {
      const value = await work(transaction);
      this.state = transaction.state;
      return value;
    } catch (error) {
      this.rollbackCount += 1;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const priceInput = {
  publicModelId: 'public-model-1',
  publicModelVersion: 3,
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  idempotencyKey: 'rate-set-2026-09',
  effectiveAt: '2026-09-29T00:00:00.000Z',
  commercialPolicyVersion: 'commercial-v1',
  calculatorVersion: 'calculator-v1',
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_even' as const,
  rates: {
    input: { numeratorMinorUnits: '9007199254740993', denominatorUnits: '1000000' },
    output: { numeratorMinorUnits: '18014398509481985', denominatorUnits: '1000000' },
  },
  audit: {
    actorUserId: ACTOR_ID,
    entryPoint: 'platform_admin' as const,
    requestId: 'platform_admin_write_test',
    sourceIp: '203.0.113.9',
    userAgent: 'pricing-test-agent',
  },
};

test('platform price registration resolves catalog identity and appends exact price plus audit on one transaction executor', async () => {
  const database = new PricingDatabase();
  const service = new SaasPricingService(database, {
    now: () => new Date('2026-09-29T01:00:00.000Z'),
    idFactory: () => PRICE_ID,
  });

  const record = await service.registerPlatformCustomerPriceVersion(priceInput);

  assert.equal(record.providerId, 'provider-server-resolved');
  assert.equal(record.productId, 'product-server-resolved');
  assert.equal(record.rates.input?.numeratorMinorUnits, 9007199254740993n);
  assert.equal(record.rates.output?.numeratorMinorUnits, 18014398509481985n);
  assert.equal(database.state.prices.length, 1);
  assert.deepEqual(
    database.state.audits.map(
      ({
        tenant_id: _tenantId,
        actor_user_id,
        action,
        target_type,
        target_id,
        source_ip,
        user_agent,
        entry_point,
        request_id,
      }) => ({
        actor_user_id,
        action,
        target_type,
        target_id,
        source_ip,
        user_agent,
        entry_point,
        request_id,
      }),
    ),
    [
      {
        actor_user_id: ACTOR_ID,
        action: 'pricing.customer_price_version.registered',
        target_type: 'saas_customer_price_versions',
        target_id: PRICE_ID,
        source_ip: '203.0.113.9',
        user_agent: 'pricing-test-agent',
        entry_point: 'platform_admin',
        request_id: 'platform_admin_write_test',
      },
    ],
  );
  const transaction = database.transactions[0];
  assert.ok(transaction);
  assert.ok(transaction.statements.some(({ sql }) => sql.includes('WITH latest_capability')));
  assert.ok(transaction.statements.some(({ sql }) => sql.includes('INSERT INTO saas_customer_price_versions')));
  assert.ok(transaction.statements.some(({ sql }) => sql.includes('INSERT INTO saas_audit_events')));
  assert.equal(database.transactions.length, 1);

  await service.registerPlatformCustomerPriceVersion({
    ...priceInput,
    audit: { ...priceInput.audit, requestId: 'platform_admin_write_retry' },
  });
  assert.equal(database.state.prices.length, 1, 'idempotent retry must not append another commercial version');
});

test('platform price registration rolls back the price version when its audit insert fails', async () => {
  const database = new PricingDatabase();
  database.failAudit = true;
  const service = new SaasPricingService(database, { idFactory: () => PRICE_ID });

  await assert.rejects(
    service.registerPlatformCustomerPriceVersion(priceInput),
    (error: unknown) => error instanceof SaasPricingError && error.code === 'PRICING_STORAGE_ERROR',
  );
  assert.equal(database.rollbackCount, 1);
  assert.equal(database.state.prices.length, 0);
  assert.equal(database.state.audits.length, 0);
  assert.equal(database.transactions[0]?.statements.at(-1)?.sql.includes('INSERT INTO saas_audit_events'), true);
});

test('platform supplier-cost registration resolves its Provider model mapping from the selected catalog target', async () => {
  const database = new PricingDatabase();
  const service = new SaasPricingService(database, { idFactory: () => PRICE_ID });

  const record = await service.registerPlatformSupplierCostVersion({
    ...priceInput,
    currency: 'CNY',
    idempotencyKey: 'supplier-rate-set-2026-09',
    audit: { ...priceInput.audit, requestId: 'platform_admin_supplier_write_test' },
  });

  assert.equal(record.kind, 'supplier');
  assert.equal(record.providerId, TARGET.provider_id);
  assert.equal(record.productId, TARGET.product_id);
  assert.equal(record.resolvedModel, TARGET.resolved_model);
  assert.equal(database.state.supplierPrices.length, 1);
  assert.equal(database.state.audits[0]?.target_type, 'saas_supplier_cost_versions');
  assert.equal(database.state.audits[0]?.target_id, PRICE_ID);
  assert.ok(database.transactions[0]?.statements.some(({ sql }) => sql.includes('saas_platform_provider_accounts')));
});

const WRITE_BODY = {
  publicModelId: 'public-model-1',
  publicModelVersion: 3,
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  idempotencyKey: 'rate-set-2026-09',
  effectiveAt: '2026-09-29T00:00:00.000Z',
  commercialPolicyVersion: 'commercial-v1',
  calculatorVersion: 'calculator-v1',
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_even',
  rates: {
    input: { numeratorMinorUnits: '9007199254740993', denominatorUnits: '1000000' },
    output: { numeratorMinorUnits: '18014398509481985', denominatorUnits: '1000000' },
  },
};

function priceVersionDto() {
  return {
    kind: 'customer',
    id: PRICE_ID,
    version: 1,
    publicModelId: 'public-model-1',
    publicModelVersion: 3,
    providerId: TARGET.provider_id,
    productId: TARGET.product_id,
    protocol: 'openai',
    endpoint: 'chat-completions',
    currency: 'USD',
    commercialPolicyVersion: 'commercial-v1',
    calculatorVersion: 'calculator-v1',
    roundingVersion: 'rounding-v1',
    roundingMode: 'half_even',
    roundingBoundary: 'total',
    rates: {
      input: { numeratorMinorUnits: '9007199254740993', denominatorUnits: '1000000' },
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      output: { numeratorMinorUnits: '18014398509481985', denominatorUnits: '1000000' },
    },
    effectiveAt: '2026-09-29T00:00:00.000Z',
    expiresAt: null,
    definitionDigest: 'c'.repeat(64),
    createdAt: '2026-09-29T01:00:00.000Z',
  };
}

interface ResponseRecorder {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
  writableEnded: boolean;
}

async function invokePriceHandler(
  handler: ReturnType<typeof createPlatformAdminReadHandler>,
  method: string,
  body?: unknown,
  headers: IncomingHttpHeaders = {},
): Promise<{ recorder: ResponseRecorder; data: Record<string, unknown> }> {
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  const request = {
    method,
    url: '/admin/api/v1/pricing/customer-versions',
    headers,
    socket: { remoteAddress: '203.0.113.27' },
    async *[Symbol.asyncIterator]() {
      if (serializedBody !== undefined) yield Buffer.from(serializedBody);
    },
  } as unknown as IncomingMessage;
  const recorder: ResponseRecorder = { status: 0, headers: {}, body: '', writableEnded: false };
  const response = {
    destroyed: false,
    get writableEnded() {
      return recorder.writableEnded;
    },
    writeHead(status: number, responseHeaders: OutgoingHttpHeaders = {}) {
      recorder.status = status;
      recorder.headers = responseHeaders;
      return response;
    },
    end(bodyText?: string | Uint8Array) {
      recorder.body = bodyText === undefined ? '' : Buffer.from(bodyText).toString('utf8');
      recorder.writableEnded = true;
      return response;
    },
  } as unknown as ServerResponse;
  await handler(request, response);
  return { recorder, data: JSON.parse(recorder.body) as Record<string, unknown> };
}

function platformAdminOptions(
  role: PlatformAdminActor['roles'][number],
  registrations: unknown[],
): PlatformAdminReadHandlerOptions {
  const actor: PlatformAdminActor = { userId: ACTOR_ID, sessionId: 'session-1', roles: [role] };
  return {
    access: { authenticate: async () => actor },
    operations: { getSummary: async () => ({}) },
    catalog: {
      listProducts: async () => ({ items: [] }),
      listCapabilities: async () => ({ items: [] }),
      listRights: async () => ({ items: [] }),
    },
    pricing: {
      listPlatformPricingTargets: async () => ({ items: [], hasMore: false, nextCursor: null }),
      listPlatformPriceVersionHistory: async () => ({ items: [], hasMore: false, nextCursor: null }),
      registerPlatformCustomerPriceVersion: async (input: unknown) => {
        registrations.push(input);
        return priceVersionDto() as never;
      },
      registerPlatformSupplierCostVersion: async () => priceVersionDto() as never,
    } as never,
    writeSecurity: {
      publicOrigin: 'https://platform-admin.test',
      authService: { verifyCsrfToken: async () => true },
    },
  };
}

const writeHeaders: IncomingHttpHeaders = {
  origin: 'https://platform-admin.test',
  host: 'platform-admin.test',
  'content-type': 'application/json',
  cookie: 'mr_platform_admin_session=session; mr_platform_admin_csrf=csrf',
  'x-csrf-token': 'csrf',
  'user-agent': 'platform-admin-test',
};

test('platform pricing HTTP derives audit identity from the authenticated actor and returns exact rational strings', async () => {
  const registrations: unknown[] = [];
  const handler = createPlatformAdminReadHandler(platformAdminOptions('operations', registrations));
  const response = await invokePriceHandler(handler, 'POST', WRITE_BODY, writeHeaders);

  assert.equal(response.recorder.status, 201);
  assert.equal((response.data.data as Record<string, unknown>).kind, 'customer');
  const rates = (response.data.data as Record<string, unknown>).rates as Record<string, unknown>;
  assert.equal((rates.input as Record<string, unknown>).numeratorMinorUnits, '9007199254740993');
  const [registration] = registrations as [Record<string, unknown>];
  assert.equal(registration?.providerId, undefined);
  assert.equal(registration?.productId, undefined);
  assert.equal(registration?.resolvedModel, undefined);
  const audit = registration?.audit as Record<string, unknown>;
  assert.equal(audit.actorUserId, ACTOR_ID);
  assert.equal(audit.entryPoint, 'platform_admin');
  assert.equal(audit.sourceIp, '203.0.113.27');
  assert.equal(audit.userAgent, 'platform-admin-test');
  assert.match(String(audit.requestId), /^platform_admin_write_/u);
});

test('platform pricing HTTP rejects client supplied Provider, product, account, model mapping, and audit identity fields', async () => {
  const registrations: unknown[] = [];
  const handler = createPlatformAdminReadHandler(platformAdminOptions('operations', registrations));
  for (const field of ['providerId', 'productId', 'accountId', 'resolvedModel', 'audit', 'actorUserId']) {
    const response = await invokePriceHandler(
      handler,
      'POST',
      { ...WRITE_BODY, [field]: 'attacker-value' },
      writeHeaders,
    );
    assert.equal(response.recorder.status, 400, `${field} must be rejected`);
  }
  assert.equal(registrations.length, 0);
});

test('platform pricing writes still require the operations role', async () => {
  const registrations: unknown[] = [];
  const handler = createPlatformAdminReadHandler(platformAdminOptions('security', registrations));
  const response = await invokePriceHandler(handler, 'POST', WRITE_BODY, writeHeaders);
  assert.equal(response.recorder.status, 403);
  assert.equal(registrations.length, 0);
});
