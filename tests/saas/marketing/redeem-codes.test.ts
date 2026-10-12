import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  MARKETING_REDEEM_IDEMPOTENCY_NAMESPACE,
  MarketingRedeemCodeService,
  MarketingRedeemError,
  normalizeRedeemCode,
  redeemCodeHash,
} from '../../../src/saas/marketing/redeem-codes.js';
import { ServicePlanError } from '../../../src/saas/plans/errors.js';

// Track G1 service unit tests. The fake database models each production
// statement by normalized prefix; the funding ledger and the G1.5 plans
// subscription grant are recording ports.

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const TENANT = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000a2';
const CODE_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000b2';
const PLAN_VERSION = '00000000-0000-4000-8000-0000000000e1';
const NOW = Date.parse('2026-10-11T00:00:00.000Z');

interface CodeRow extends Record<string, unknown> {
  id: string;
  code_hash: string;
  code_prefix: string;
  kind: string;
  amount_minor_units: string | null;
  currency: string | null;
  service_plan_version_id: string | null;
  status: string;
  batch_ref: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  redeemed_by_tenant_id: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: string | null;
  disabled_at: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeMarketingDatabase {
  readonly state = {
    codes: [] as CodeRow[],
    redemptions: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
  };
  insertConflictsRemaining = 0;
  loseRedeemCas = false;
  lastExecutor: SqlExecutor | null = null;
  private tail: Promise<void> = Promise.resolve();

  seedCode(overrides: Partial<CodeRow> = {}): CodeRow {
    const row: CodeRow = {
      id: CODE_ID,
      code_hash: redeemCodeHash('KZXW6YTBKZXW6YTBKZXW'),
      code_prefix: 'KZXW',
      kind: 'balance',
      amount_minor_units: '1000',
      currency: 'CNY',
      service_plan_version_id: null,
      status: 'active',
      batch_ref: 'batch-1',
      created_by_user_id: ACTOR,
      created_at: '2026-10-11T00:00:00.000Z',
      updated_at: '2026-10-11T00:00:00.000Z',
      redeemed_by_tenant_id: null,
      redeemed_by_user_id: null,
      redeemed_at: null,
      disabled_at: null,
      ...overrides,
    };
    this.state.codes.push(row);
    return row;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = clone(this.state);
    const executor: SqlExecutor = { query: (sql, values = []) => this.execute(sql, values) };
    this.lastExecutor = executor;
    try {
      return await work(executor);
    } catch (error) {
      this.state.codes = before.codes;
      this.state.redemptions = before.redemptions;
      this.state.audit = before.audit;
      throw error;
    } finally {
      release();
    }
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h] = values;
    const result = <R>(rows: R[] = []): SqlResult<R> => ({ rows: clone(rows), rowCount: rows.length });

    if (statement.startsWith('set local ')) return result<Row>();

    if (statement.startsWith('insert into model_router_saas.saas_marketing_redeem_codes')) {
      if (this.insertConflictsRemaining > 0) {
        this.insertConflictsRemaining -= 1;
        return result<Row>();
      }
      if (this.state.codes.some((row) => row.code_hash === b)) return result<Row>();
      if (statement.includes("'subscription'")) {
        this.state.codes.push({
          id: String(a),
          code_hash: String(b),
          code_prefix: String(c),
          kind: 'subscription',
          amount_minor_units: null,
          currency: null,
          service_plan_version_id: String(d),
          status: 'active',
          batch_ref: String(e),
          created_by_user_id: String(f),
          created_at: String(g),
          updated_at: String(g),
          redeemed_by_tenant_id: null,
          redeemed_by_user_id: null,
          redeemed_at: null,
          disabled_at: null,
        });
        return result<Row>([{ id: a } as Row]);
      }
      this.state.codes.push({
        id: String(a),
        code_hash: String(b),
        code_prefix: String(c),
        kind: 'balance',
        amount_minor_units: String(d),
        currency: String(e),
        service_plan_version_id: null,
        status: 'active',
        batch_ref: String(f),
        created_by_user_id: String(g),
        created_at: String(h),
        updated_at: String(h),
        redeemed_by_tenant_id: null,
        redeemed_by_user_id: null,
        redeemed_at: null,
        disabled_at: null,
      });
      return result<Row>([{ id: a } as Row]);
    }

    if (statement.startsWith('insert into model_router_saas.saas_audit_events')) {
      this.state.audit.push({
        id: a,
        tenant_id: b,
        actor_user_id: c,
        action: d,
        target_id: e,
        occurred_at: f,
      });
      return result<Row>();
    }

    if (statement.includes('from model_router_saas.saas_marketing_redeem_codes where id = $1 for update')) {
      const row = this.state.codes.find((item) => item.id === a);
      return result<Row>(row ? [row as Row] : []);
    }

    if (statement.includes('from model_router_saas.saas_marketing_redeem_codes where code_hash = $1 for update')) {
      const row = this.state.codes.find((item) => item.code_hash === a);
      return result<Row>(row ? [row as Row] : []);
    }

    if (statement.startsWith("update model_router_saas.saas_marketing_redeem_codes set status = 'disabled'")) {
      const row = this.state.codes.find((item) => item.id === a && item.status === 'active');
      if (!row) return result<Row>();
      row.status = 'disabled';
      row.disabled_at = String(b);
      row.updated_at = String(b);
      return result<Row>([row as Row]);
    }

    if (statement.startsWith("update model_router_saas.saas_marketing_redeem_codes set status = 'redeemed'")) {
      const row = this.state.codes.find((item) => item.id === a && item.status === 'active');
      if (!row || this.loseRedeemCas) return result<Row>();
      row.status = 'redeemed';
      row.redeemed_by_tenant_id = String(b);
      row.redeemed_by_user_id = String(c);
      row.redeemed_at = String(d);
      row.updated_at = String(d);
      return result<Row>([row as Row]);
    }

    if (
      statement.startsWith(
        'select id, code_prefix, kind, amount_minor_units, currency, service_plan_version_id, status, batch_ref, created_at, redeemed_by_tenant_id, redeemed_at, disabled_at from model_router_saas.saas_marketing_redeem_codes where ($1::text is null',
      )
    ) {
      let rows = this.state.codes.filter(
        (row) => (a === null || row.batch_ref === a) && (b === null || row.status === b),
      );
      if (c !== null) {
        rows = rows.filter((row) => row.created_at < String(c) || (row.created_at === String(c) && row.id < String(d)));
      }
      rows = [...rows].sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      );
      const limit = Number(e);
      return result<Row>(rows.slice(0, limit) as Row[]);
    }

    if (
      statement.startsWith(
        'select id, ledger_transaction_id from model_router_saas.saas_marketing_redeem_redemptions where code_id = $1',
      )
    ) {
      const row = this.state.redemptions.find((item) => item.code_id === a);
      return result<Row>(row ? [row as Row] : []);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_redeem_redemptions')) {
      if (this.state.redemptions.some((item) => item.code_id === b)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const carriesLedger = !statement.includes('null, $5');
      this.state.redemptions.push({
        id: a,
        code_id: b,
        tenant_id: c,
        user_id: d,
        ledger_transaction_id: carriesLedger ? e : null,
        created_at: carriesLedger ? f : e,
      });
      return result<Row>();
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

function createFixture() {
  const database = new FakeMarketingDatabase();
  const fundingCalls: Array<Record<string, unknown>> = [];
  const grantCalls: Array<Record<string, unknown>> = [];
  const grantExecutors: unknown[] = [];
  const versionAssertCalls: string[] = [];
  let nextTx = 0;
  const behavior: {
    grantError?: unknown;
    grantResults?: Array<{ subscriptionId: string; entitlementId: string; expiresAt: string; replayed: boolean }>;
    versionAssertError?: unknown;
  } = {};
  const service = new MarketingRedeemCodeService({
    database,
    fundingLedger: {
      async postVerifiedFunding(_executor, input) {
        fundingCalls.push({ ...input });
        nextTx += 1;
        return { outcome: 'posted' as const, replayed: false, transactionId: `ledger-tx-${nextTx}` };
      },
    },
    subscriptionGrants: {
      async grantMarketingSubscription(executor, input) {
        grantCalls.push({ ...input });
        grantExecutors.push(executor);
        if (behavior.grantError !== undefined) throw behavior.grantError;
        const queued = behavior.grantResults?.shift();
        return (
          queued ?? {
            subscriptionId: 'subscription-1',
            entitlementId: 'entitlement-1',
            expiresAt: '2026-11-10T00:00:00.000Z',
            replayed: false,
          }
        );
      },
      async assertMarketingGrantPlanVersion(_executor, servicePlanVersionId) {
        versionAssertCalls.push(servicePlanVersionId);
        if (behavior.versionAssertError !== undefined) throw behavior.versionAssertError;
      },
    },
    idFactory: (() => {
      let counter = 0;
      return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
    })(),
    now: () => new Date(NOW),
  });
  return { database, service, fundingCalls, grantCalls, grantExecutors, versionAssertCalls, behavior };
}

test('normalization accepts mixed case and separators, and rejects short or long input', () => {
  assert.equal(normalizeRedeemCode('kzxw-6ytb-kzxw 6ytbkzxw'), 'KZXW6YTBKZXW6YTBKZXW');
  for (const raw of ['short', 42, null, `${'A'.repeat(65)}`]) {
    assert.throws(
      () => normalizeRedeemCode(raw),
      (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_INVALID_INPUT',
    );
  }
});

test('generation stores only the hash and prefix, returns plaintext once, and audits the batch', async () => {
  const { database, service } = createFixture();
  const { batchRef, codes } = await service.generateBalanceCodes(
    { userId: ACTOR },
    { count: 3, amountMinorUnits: '1000', currency: 'CNY', batchRef: 'batch-1' },
  );
  assert.equal(batchRef, 'batch-1');
  assert.equal(codes.length, 3);
  for (const code of codes) {
    assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    assert.ok(!/[01ILO]/.test(code), 'alphabet excludes ambiguous glyphs');
  }
  assert.equal(database.state.codes.length, 3);
  const hashes = new Set(database.state.codes.map((row) => row.code_hash));
  assert.equal(hashes.size, 3);
  for (const row of database.state.codes) {
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.match(row.code_prefix, /^[A-Z2-9]{4}$/);
    assert.equal(row.status, 'active');
    assert.equal(row.amount_minor_units, '1000');
    assert.ok(!codes.some((code) => code.includes(row.code_hash)), 'plaintext never touches storage');
  }
  assert.equal(database.state.audit.length, 1);
  assert.equal(database.state.audit[0]?.action, 'marketing.redeem_codes.generated');
  assert.equal(database.state.audit[0]?.actor_user_id, ACTOR);
  assert.equal(database.state.audit[0]?.target_id, 'batch-1');
});

test('generation validates count, fixed-point amount and currency before any write', async () => {
  const { database, service } = createFixture();
  for (const input of [
    { count: 0, amountMinorUnits: '1000', currency: 'CNY' },
    { count: 101, amountMinorUnits: '1000', currency: 'CNY' },
    { count: 1.5, amountMinorUnits: '1000', currency: 'CNY' },
    { count: 1, amountMinorUnits: '0', currency: 'CNY' },
    { count: 1, amountMinorUnits: '12.5', currency: 'CNY' },
    { count: 1, amountMinorUnits: '-5', currency: 'CNY' },
    { count: 1, amountMinorUnits: '1000', currency: 'cny' },
    { count: 1, amountMinorUnits: '1000', currency: 'CN' },
  ]) {
    await assert.rejects(
      service.generateBalanceCodes({ userId: ACTOR }, input),
      (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_INVALID_INPUT',
    );
  }
  assert.equal(database.state.codes.length, 0);
  assert.equal(database.state.audit.length, 0);
});

test('generation retries a hash collision and fails closed after bounded attempts', async () => {
  const { database, service } = createFixture();
  database.insertConflictsRemaining = 2;
  const { codes } = await service.generateBalanceCodes(
    { userId: ACTOR },
    { count: 1, amountMinorUnits: '1000', currency: 'CNY' },
  );
  assert.equal(codes.length, 1);
  database.insertConflictsRemaining = 3;
  await assert.rejects(
    service.generateBalanceCodes({ userId: ACTOR }, { count: 1, amountMinorUnits: '1000', currency: 'CNY' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_STORAGE_ERROR',
  );
  // The failed batch rolls its audit row back with the transaction.
  assert.equal(database.state.audit.length, 1);
});

test('subscription generation validates the plan version and stores hash, prefix and version reference', async () => {
  const { database, service, versionAssertCalls } = createFixture();
  const { batchRef, codes } = await service.generateSubscriptionCodes(
    { userId: ACTOR },
    { count: 2, servicePlanVersionId: PLAN_VERSION, batchRef: 'sub-batch-1' },
  );
  assert.equal(batchRef, 'sub-batch-1');
  assert.equal(codes.length, 2);
  assert.deepEqual(versionAssertCalls, [PLAN_VERSION]);
  assert.equal(database.state.codes.length, 2);
  for (const row of database.state.codes) {
    assert.equal(row.kind, 'subscription');
    assert.equal(row.service_plan_version_id, PLAN_VERSION);
    assert.equal(row.amount_minor_units, null);
    assert.equal(row.currency, null);
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!codes.some((code) => code.includes(row.code_hash)), 'plaintext never touches storage');
  }
  assert.equal(database.state.audit.length, 1);
  assert.equal(database.state.audit[0]?.action, 'marketing.redeem_codes.generated');
  assert.equal(database.state.audit[0]?.target_id, 'sub-batch-1');
});

test('subscription generation validates count and version id before any write', async () => {
  const { database, service, versionAssertCalls } = createFixture();
  for (const input of [
    { count: 0, servicePlanVersionId: PLAN_VERSION },
    { count: 101, servicePlanVersionId: PLAN_VERSION },
    { count: 1.5, servicePlanVersionId: PLAN_VERSION },
    { count: 1, servicePlanVersionId: 'not-a-uuid' },
  ]) {
    await assert.rejects(
      service.generateSubscriptionCodes({ userId: ACTOR }, input),
      (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_INVALID_INPUT',
    );
  }
  assert.equal(database.state.codes.length, 0);
  assert.equal(database.state.audit.length, 0);
  assert.equal(versionAssertCalls.length, 0);
});

test('subscription generation rolls the batch back when the plan version is not purchasable', async () => {
  const { database, service, behavior } = createFixture();
  behavior.versionAssertError = new ServicePlanError('PLAN_VERSION_UNAVAILABLE');
  await assert.rejects(
    service.generateSubscriptionCodes({ userId: ACTOR }, { count: 2, servicePlanVersionId: PLAN_VERSION }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_INVALID_INPUT',
  );
  assert.equal(database.state.codes.length, 0);
  assert.equal(database.state.audit.length, 0);
  behavior.versionAssertError = new ServicePlanError('STORAGE_ERROR');
  await assert.rejects(
    service.generateSubscriptionCodes({ userId: ACTOR }, { count: 1, servicePlanVersionId: PLAN_VERSION }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_STORAGE_ERROR',
  );
  assert.equal(database.state.codes.length, 0);
});

test('disable transitions an active code once, replays for a disabled code, and refuses a redeemed one', async () => {
  const { database, service } = createFixture();
  database.seedCode();
  const disabled = await service.disableCode({ userId: ACTOR }, CODE_ID);
  assert.equal(disabled.status, 'disabled');
  assert.equal(database.state.audit.at(-1)?.action, 'marketing.redeem_code.disabled');
  const replay = await service.disableCode({ userId: ACTOR }, CODE_ID);
  assert.equal(replay.status, 'disabled');
  assert.equal(database.state.audit.filter((row) => row.action === 'marketing.redeem_code.disabled').length, 1);
  await assert.rejects(
    service.disableCode({ userId: ACTOR }, '00000000-0000-4000-8000-000000000099'),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
  );
  const seeded = database.state.codes[0];
  assert.ok(seeded);
  seeded.status = 'redeemed';
  await assert.rejects(
    service.disableCode({ userId: ACTOR }, CODE_ID),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
  );
});

test('redemption credits the wallet through the C-6 hook and is exactly-once per code', async () => {
  const { database, service, fundingCalls } = createFixture();
  database.seedCode();
  const result = await service.redeem({ tenantId: TENANT, userId: USER }, { code: 'kzxw-6ytb-kzxw-6ytbkzxw' });
  assert.equal(result.outcome, 'redeemed');
  assert.equal(result.amountMinorUnits, '1000');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.ledgerTransactionId, 'ledger-tx-1');
  assert.equal(fundingCalls.length, 1);
  assert.equal(fundingCalls[0]?.tenantId, TENANT);
  assert.equal(fundingCalls[0]?.idempotencyNamespace, MARKETING_REDEEM_IDEMPOTENCY_NAMESPACE);
  assert.equal(fundingCalls[0]?.idempotencyKey, `${CODE_ID}:${TENANT}`);
  assert.equal(fundingCalls[0]?.sourceOrderRef, CODE_ID);
  const code = database.state.codes[0];
  assert.ok(code);
  assert.equal(code.status, 'redeemed');
  assert.equal(code.redeemed_by_tenant_id, TENANT);
  assert.equal(database.state.redemptions.length, 1);
  assert.equal(database.state.redemptions[0]?.ledger_transaction_id, 'ledger-tx-1');
  assert.equal(database.state.audit.at(-1)?.action, 'marketing.redeem.completed');

  const replay = await service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.ledgerTransactionId, 'ledger-tx-1');
  assert.equal(fundingCalls.length, 1, 'a replay never re-posts the wallet');
  assert.equal(database.state.redemptions.length, 1);
});

test('redemption hides code existence across unknown, disabled and foreign-redeemed codes', async () => {
  const { database, service, fundingCalls } = createFixture();
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'AAAA-BBBB-CCCC-DDDD-EEEE' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
  );
  database.seedCode({ status: 'disabled', disabled_at: '2026-10-11T00:00:00.000Z' });
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
  );
  const seeded = database.state.codes[0];
  assert.ok(seeded);
  seeded.status = 'redeemed';
  seeded.redeemed_by_tenant_id = OTHER_TENANT;
  seeded.redeemed_at = '2026-10-11T00:00:00.000Z';
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
  );
  assert.equal(fundingCalls.length, 0);
});

test('a subscription code grants the plan inside the redeem transaction and never touches the wallet', async () => {
  const { database, service, fundingCalls, grantCalls, grantExecutors } = createFixture();
  database.seedCode({
    kind: 'subscription',
    amount_minor_units: null,
    currency: null,
    service_plan_version_id: PLAN_VERSION,
  });
  const result = await service.redeem({ tenantId: TENANT, userId: USER }, { code: 'kzxw-6ytb-kzxw-6ytbkzxw' });
  assert.deepEqual(result, {
    outcome: 'redeemed',
    kind: 'subscription',
    codeId: CODE_ID,
    servicePlanVersionId: PLAN_VERSION,
    subscriptionId: 'subscription-1',
    entitlementId: 'entitlement-1',
    expiresAt: '2026-11-10T00:00:00.000Z',
  });
  assert.equal(fundingCalls.length, 0, 'subscription redemption never posts to the wallet');
  assert.equal(grantCalls.length, 1);
  assert.deepEqual(grantCalls[0], {
    tenantId: TENANT,
    userId: USER,
    servicePlanVersionId: PLAN_VERSION,
    grantRef: CODE_ID,
  });
  assert.equal(grantExecutors[0], database.lastExecutor, 'the grant runs inside the redeem transaction');
  assert.equal(database.state.codes[0]?.status, 'redeemed');
  assert.equal(database.state.redemptions.length, 1);
  assert.equal(database.state.redemptions[0]?.ledger_transaction_id, null);
  assert.equal(database.state.audit.at(-1)?.action, 'marketing.redeem.completed');
});

test('a subscription redemption replays the original grant for the same tenant without re-granting', async () => {
  const { database, service, grantCalls, behavior } = createFixture();
  database.seedCode({
    kind: 'subscription',
    amount_minor_units: null,
    currency: null,
    service_plan_version_id: PLAN_VERSION,
  });
  const first = await service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' });
  assert.equal(first.outcome, 'redeemed');
  behavior.grantResults = [
    {
      subscriptionId: 'subscription-1',
      entitlementId: 'entitlement-1',
      expiresAt: '2026-11-10T00:00:00.000Z',
      replayed: true,
    },
  ];
  const replay = await service.redeem({ tenantId: TENANT, userId: USER }, { code: 'kzxw6ytbkzxw6ytbkzxw' });
  if (replay.kind !== 'subscription') assert.fail('expected a subscription-kind replay result');
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.subscriptionId, 'subscription-1');
  assert.equal(grantCalls.length, 2, 'the replay re-reads the grant through the idempotent port');
  assert.equal(database.state.redemptions.length, 1, 'a replay never adds a second redemption row');

  behavior.grantResults = [
    {
      subscriptionId: 'subscription-1',
      entitlementId: 'entitlement-1',
      expiresAt: '2026-11-10T00:00:00.000Z',
      replayed: false,
    },
  ];
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_STORAGE_ERROR',
  );
});

test('a foreign tenant replaying a subscription code gets the shared refusal without a grant call', async () => {
  const { database, service, grantCalls } = createFixture();
  database.seedCode({
    kind: 'subscription',
    amount_minor_units: null,
    currency: null,
    service_plan_version_id: PLAN_VERSION,
    status: 'redeemed',
    redeemed_by_tenant_id: OTHER_TENANT,
    redeemed_at: '2026-10-11T00:00:00.000Z',
  });
  database.state.redemptions.push({
    id: 'redemption-1',
    code_id: CODE_ID,
    tenant_id: OTHER_TENANT,
    user_id: USER,
    ledger_transaction_id: null,
    created_at: '2026-10-11T00:00:00.000Z',
  });
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
  );
  assert.equal(grantCalls.length, 0);
});

test('a subscription grant conflict rolls the redemption back and leaves the code active', async () => {
  const { database, service, behavior, fundingCalls } = createFixture();
  database.seedCode({
    kind: 'subscription',
    amount_minor_units: null,
    currency: null,
    service_plan_version_id: PLAN_VERSION,
  });
  behavior.grantError = new ServicePlanError('ACTIVE_SUBSCRIPTION_EXISTS');
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
  );
  assert.equal(database.state.codes[0]?.status, 'active', 'the transaction rolls the CAS back');
  assert.equal(database.state.redemptions.length, 0);
  assert.equal(database.state.audit.length, 0);
  assert.equal(fundingCalls.length, 0);

  for (const failure of [
    new ServicePlanError('PLAN_VERSION_UNAVAILABLE'),
    new ServicePlanError('ENTITLEMENT_UNAVAILABLE'),
  ]) {
    behavior.grantError = failure;
    await assert.rejects(
      service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
      (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
    );
  }

  for (const failure of [new ServicePlanError('STORAGE_ERROR'), new Error('connection reset')]) {
    behavior.grantError = failure;
    await assert.rejects(
      service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
      (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_STORAGE_ERROR',
    );
  }
  assert.equal(database.state.codes[0]?.status, 'active');
  assert.equal(database.state.redemptions.length, 0);
});

test('a lost subscription redemption CAS refuses before calling the grant port', async () => {
  const { database, service, grantCalls } = createFixture();
  database.seedCode({
    kind: 'subscription',
    amount_minor_units: null,
    currency: null,
    service_plan_version_id: PLAN_VERSION,
  });
  database.loseRedeemCas = true;
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
  );
  assert.equal(grantCalls.length, 0);
  assert.equal(database.state.codes[0]?.status, 'active');
  assert.equal(database.state.redemptions.length, 0);
});

test('a lost redemption CAS rolls back without a wallet posting', async () => {
  const { database, service, fundingCalls } = createFixture();
  database.seedCode();
  database.loseRedeemCas = true;
  await assert.rejects(
    service.redeem({ tenantId: TENANT, userId: USER }, { code: 'KZXW6YTBKZXW6YTBKZXW' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
  );
  assert.equal(fundingCalls.length, 0);
  assert.equal(database.state.codes[0]?.status, 'active', 'the transaction rolls the CAS loser back');
  assert.equal(database.state.redemptions.length, 0);
});

test('listing filters, paginates by keyset, and never exposes the code hash', async () => {
  const { database, service } = createFixture();
  for (let index = 0; index < 5; index += 1) {
    database.seedCode({
      id: `00000000-0000-4000-8000-0000000000c${index}`,
      code_hash: String(index).padStart(64, '0'),
      batch_ref: index < 3 ? 'batch-1' : 'batch-2',
      status: index === 4 ? 'disabled' : 'active',
      created_at: `2026-10-1${index}T00:00:00.000Z`,
    });
  }
  const first = await service.listCodes({ userId: ACTOR }, { limit: 2 });
  assert.equal(first.codes.length, 2);
  assert.ok(first.nextCursor);
  assert.equal(first.codes[0]?.batchRef, 'batch-2');
  for (const view of first.codes) {
    assert.ok(!('codeHash' in view) && !('code_hash' in view), 'the hash never leaves the store');
  }
  const second = await service.listCodes({ userId: ACTOR }, { limit: 2, cursor: first.nextCursor as string });
  assert.equal(second.codes.length, 2);
  assert.ok(!second.codes.some((view) => first.codes.some((seen) => seen.id === view.id)));
  const filtered = await service.listCodes({ userId: ACTOR }, { batchRef: 'batch-1', status: 'active' });
  assert.equal(filtered.codes.length, 3);
  assert.equal(filtered.nextCursor, null);
  await assert.rejects(
    service.listCodes({ userId: ACTOR }, { cursor: 'not-a-cursor' }),
    (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_INVALID_INPUT',
  );
});
