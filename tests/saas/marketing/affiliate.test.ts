import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  deriveAffiliateInviteCode,
  MARKETING_AFFILIATE_IDEMPOTENCY_NAMESPACE,
  MarketingAffiliateError,
  MarketingAffiliateService,
} from '../../../src/saas/marketing/affiliate.js';

// Track R2/G3 service unit tests. The fake database models each production
// statement by normalized prefix; the transaction snapshot rolls back on
// failure, mirroring the real driver. The funding ledger is a recording seam
// with natural-key idempotency, mirroring PlatformWalletLedgerService.

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000a2';
const TENANT_A = '00000000-0000-4000-8000-0000000000b1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';
const TENANT_C = '00000000-0000-4000-8000-0000000000b3';
const TENANT_D = '00000000-0000-4000-8000-0000000000b4';
const TENANT_SUSPENDED = '00000000-0000-4000-8000-0000000000b5';
const SALT = 'affiliate-test-deployment-salt';
const NOW = '2026-10-11T00:00:00.000Z';

interface TenantRow {
  id: string;
  status: string;
}

interface AttributionRow {
  invitee_tenant_id: string;
  inviter_tenant_id: string;
  invite_code: string;
  created_at: string;
}

interface PolicyRow extends Record<string, unknown> {
  id: string;
  reward_bp: number;
  enabled: boolean;
  version: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
}

interface RewardRow extends Record<string, unknown> {
  id: string;
  inviter_tenant_id: string;
  invitee_tenant_id: string;
  source_funding_ref: string;
  source_amount_minor_units: string;
  reward_amount_minor_units: string;
  currency: string;
  reward_bp_snapshot: number;
  ledger_transaction_id: string | null;
  created_at: string;
}

interface AuditRow {
  tenant_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows, rowCount: rows.length } as SqlResult<Row>;
}

function tenantSuffix(id: string): string {
  return id.replace(/-/g, '').slice(-10);
}

class FakeAffiliateDatabase {
  readonly state: {
    tenants: TenantRow[];
    attributions: AttributionRow[];
    policies: PolicyRow[];
    rewards: RewardRow[];
    audit: AuditRow[];
  } = {
    tenants: [
      { id: TENANT_A, status: 'active' },
      { id: TENANT_B, status: 'active' },
      { id: TENANT_C, status: 'active' },
      { id: TENANT_D, status: 'active' },
      { id: TENANT_SUSPENDED, status: 'suspended' },
    ],
    attributions: [],
    policies: [],
    rewards: [],
    audit: [],
  };
  private idCounter = 0;
  private tail: Promise<void> = Promise.resolve();

  nextId(): string {
    this.idCounter += 1;
    return `10000000-0000-4000-8000-${String(this.idCounter).padStart(12, '0')}`;
  }

  seedPolicy(overrides: Partial<PolicyRow> = {}): PolicyRow {
    const row: PolicyRow = {
      id: 'platform',
      reward_bp: 250,
      enabled: true,
      version: '1',
      updated_by_user_id: ACTOR,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    };
    this.state.policies.push(row);
    return row;
  }

  seedAttribution(invitee: string, inviter: string, code?: string): AttributionRow {
    const row: AttributionRow = {
      invitee_tenant_id: invitee,
      inviter_tenant_id: inviter,
      invite_code: code ?? deriveAffiliateInviteCode(inviter, SALT),
      created_at: NOW,
    };
    this.state.attributions.push(row);
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
    const before = structuredClone(this.state);
    try {
      return await work({ query: (sql, values = []) => this.execute(sql, values) });
    } catch (error) {
      this.state.attributions = before.attributions;
      this.state.policies = before.policies;
      this.state.rewards = before.rewards;
      this.state.audit = before.audit;
      throw error;
    } finally {
      release();
    }
  }

  private rewardsPage(values: readonly unknown[]): RewardRow[] {
    const [inviter, cursorCreatedAt, cursorId, limit] = values as [string | null, string | null, string | null, number];
    let rows = this.state.rewards.filter((row) => inviter === null || row.inviter_tenant_id === inviter);
    if (cursorCreatedAt !== null && cursorId !== null) {
      rows = rows.filter(
        (row) => row.created_at < cursorCreatedAt || (row.created_at === cursorCreatedAt && row.id < cursorId),
      );
    }
    return [...rows]
      .sort((left, right) =>
        left.created_at === right.created_at
          ? right.id.localeCompare(left.id)
          : right.created_at.localeCompare(left.created_at),
      )
      .slice(0, limit);
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e] = values;

    if (statement.startsWith('set local ') || statement.startsWith('select pg_advisory_xact_lock')) {
      return result<Row>();
    }

    if (statement.startsWith('select id from model_router_saas.saas_tenants')) {
      const matches = this.state.tenants.filter((row) => row.status === 'active' && tenantSuffix(row.id) === a);
      return result<Row>(matches.map((row) => ({ id: row.id }) as Row));
    }

    if (statement.startsWith('select inviter_tenant_id, invite_code')) {
      const found = this.state.attributions.find((row) => row.invitee_tenant_id === a);
      return result<Row>(
        found ? [{ inviter_tenant_id: found.inviter_tenant_id, invite_code: found.invite_code } as Row] : [],
      );
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_affiliate_attributions')) {
      if (this.state.attributions.some((row) => row.invitee_tenant_id === a)) {
        throw Object.assign(new Error('duplicate attribution'), { code: '23505' });
      }
      this.state.attributions.push({
        invitee_tenant_id: String(a),
        inviter_tenant_id: String(b),
        invite_code: String(c),
        created_at: String(d),
      });
      return result<Row>();
    }

    if (statement.startsWith('select count(*)::text as invited_count')) {
      const count = this.state.attributions.filter((row) => row.inviter_tenant_id === a).length;
      return result<Row>([{ invited_count: String(count) } as Row]);
    }

    if (statement.startsWith('select id, reward_bp, enabled, version')) {
      const policy = this.state.policies[0];
      return result<Row>(policy ? [policy as Row] : []);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_affiliate_policies')) {
      const row: PolicyRow = {
        id: 'platform',
        reward_bp: Number(a),
        enabled: Boolean(b),
        version: '1',
        updated_by_user_id: String(c),
        created_at: String(d),
        updated_at: String(d),
      };
      this.state.policies.push(row);
      return result<Row>([row as Row]);
    }

    if (statement.startsWith('update model_router_saas.saas_marketing_affiliate_policies')) {
      const policy = this.state.policies[0];
      if (!policy || policy.version !== String(e)) return result<Row>();
      policy.reward_bp = Number(a);
      policy.enabled = Boolean(b);
      policy.version = String(Number(policy.version) + 1);
      policy.updated_by_user_id = String(c);
      policy.updated_at = String(d);
      return result<Row>([policy as Row]);
    }

    if (statement.startsWith('select id, inviter_tenant_id, invitee_tenant_id')) {
      const inviter = statement.includes('($1::uuid is null') ? (a as string | null) : String(a);
      return result<Row>(this.rewardsPage([inviter, b, c, d]) as Row[]);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_affiliate_rewards')) {
      if (this.state.rewards.some((row) => row.source_funding_ref === d)) {
        return result<Row>(); // ON CONFLICT (source_funding_ref) DO NOTHING
      }
      const row: RewardRow = {
        id: String(a),
        inviter_tenant_id: String(b),
        invitee_tenant_id: String(c),
        source_funding_ref: String(d),
        source_amount_minor_units: String(e),
        reward_amount_minor_units: String(values[5]),
        currency: String(values[6]),
        reward_bp_snapshot: Number(values[7]),
        ledger_transaction_id: values[8] === null ? null : String(values[8]),
        created_at: String(values[9]),
      };
      this.state.rewards.push(row);
      return result<Row>([{ id: row.id } as Row]);
    }

    if (statement.startsWith('insert into model_router_saas.saas_audit_events')) {
      this.state.audit.push({
        tenant_id: b === null ? null : String(b),
        actor_user_id: c === null ? null : String(c),
        action: String(d),
        target_type: String(e),
        target_id: String(values[5]),
      });
      return result<Row>();
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

interface LedgerCall {
  tenantId: string;
  currency: string;
  amountMinorUnits: string;
  sourceOrderRef: string;
  idempotencyKey: string;
  idempotencyNamespace: string;
  metadataRef: string;
}

function createFakeFundingLedger() {
  const state = {
    shouldFail: false,
    calls: [] as LedgerCall[],
    postings: new Map<string, string>(),
    async postVerifiedFunding(
      _executor: SqlExecutor,
      input: LedgerCall,
    ): Promise<{ outcome: 'posted'; replayed: boolean; transactionId: string }> {
      state.calls.push({ ...input });
      if (state.shouldFail) throw new Error('ledger failure');
      const naturalKey = `${input.idempotencyNamespace}:${input.idempotencyKey}`;
      const existing = state.postings.get(naturalKey);
      if (existing) return { outcome: 'posted', replayed: true, transactionId: existing };
      const transactionId = `ledger-tx-${state.postings.size + 1}`;
      state.postings.set(naturalKey, transactionId);
      return { outcome: 'posted', replayed: false, transactionId };
    },
  };
  return state;
}

function createFixture() {
  const database = new FakeAffiliateDatabase();
  const ledger = createFakeFundingLedger();
  const service = new MarketingAffiliateService({
    database: database as never,
    fundingLedger: ledger,
    inviteCodeSalt: SALT,
    idFactory: () => database.nextId(),
    now: () => new Date(NOW),
  });
  return { database, ledger, service };
}

const codeOf = (tenantId: string) => deriveAffiliateInviteCode(tenantId, SALT);

test('invite codes are derived, deterministic, format-conformant and salt-separated', () => {
  const code = codeOf(TENANT_A);
  assert.match(code, /^[A-Z2-7]{16}$/);
  assert.equal(code, codeOf(TENANT_A));
  assert.notEqual(code, codeOf(TENANT_B));
  assert.notEqual(code, deriveAffiliateInviteCode(TENANT_A, 'another-salt'));
  // The locator segment pins the tenant: a foreign verification segment or a
  // foreign locator can never verify against another tenant's code.
  const transplanted = `${codeOf(TENANT_B).slice(0, 8)}${code.slice(8)}`;
  assert.notEqual(transplanted, code);
});

test('bindInviter binds, snapshots the code, audits and replays idempotently', async () => {
  const { database, service } = createFixture();
  const bound = await service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: codeOf(TENANT_A) });
  assert.deepEqual(bound, { outcome: 'bound', inviterTenantId: TENANT_A });
  assert.equal(database.state.attributions.length, 1);
  assert.equal(database.state.attributions[0]?.invitee_tenant_id, TENANT_B);
  assert.equal(database.state.attributions[0]?.inviter_tenant_id, TENANT_A);
  assert.equal(database.state.attributions[0]?.invite_code, codeOf(TENANT_A));
  const binds = database.state.audit.filter((row) => row.action === 'marketing.affiliate.bound');
  assert.equal(binds.length, 1);
  assert.equal(binds[0]?.tenant_id, TENANT_B);
  assert.equal(binds[0]?.actor_user_id, USER);
  assert.equal(binds[0]?.target_type, 'marketing_affiliate_attribution');

  const replay = await service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: codeOf(TENANT_A) });
  assert.deepEqual(replay, { outcome: 'replayed', inviterTenantId: TENANT_A });
  assert.equal(database.state.attributions.length, 1, 'a replay never rewrites the attribution');
  assert.equal(
    database.state.audit.filter((row) => row.action === 'marketing.affiliate.bound').length,
    1,
    'a replay never re-audits',
  );
});

test('bindInviter refuses a second distinct inviter because attribution is lifetime-immutable', async () => {
  const { database, service } = createFixture();
  await service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: codeOf(TENANT_A) });
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: codeOf(TENANT_C) }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_ALREADY_BOUND',
  );
  assert.equal(database.state.attributions.length, 1);
  assert.equal(database.state.attributions[0]?.inviter_tenant_id, TENANT_A);
});

test('bindInviter refuses self-invites, cycles and deep-chain cycles', async () => {
  const { database, service } = createFixture();
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_A, userId: USER }, { inviteCode: codeOf(TENANT_A) }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_SELF_INVITE',
  );

  await service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: codeOf(TENANT_A) });
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_A, userId: USER }, { inviteCode: codeOf(TENANT_B) }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_CYCLE',
  );
  assert.equal(database.state.attributions.length, 1, 'the refused bind rolls back cleanly');

  // Chain B->A, C->B, D->C is acyclic; closing A->D would cycle and is refused.
  await service.bindInviter({ tenantId: TENANT_C, userId: USER }, { inviteCode: codeOf(TENANT_B) });
  await service.bindInviter({ tenantId: TENANT_D, userId: USER }, { inviteCode: codeOf(TENANT_C) });
  assert.equal(database.state.attributions.length, 3);
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_A, userId: USER }, { inviteCode: codeOf(TENANT_D) }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_CYCLE',
  );
  assert.equal(database.state.attributions.length, 3);
});

test('bindInviter rejects malformed, unknown, transplanted and inactive-inviter codes', async () => {
  const { service } = createFixture();
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: 'SHORT' }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVALID_INPUT',
  );
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: '0011ZZZZ$$######' }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVALID_INPUT',
  );
  // Well-formed but resolvable to no tenant (zero-byte locator suffix).
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: 'AAAAAAAAAAAAAAAA' }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVITE_CODE_INVALID',
  );
  // Transplant: tenant C's verification segment over tenant A's locator.
  const transplanted = `${codeOf(TENANT_C).slice(0, 8)}${codeOf(TENANT_A).slice(8)}`;
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: transplanted }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVITE_CODE_INVALID',
  );
  // A suspended inviter never resolves.
  await assert.rejects(
    service.bindInviter({ tenantId: TENANT_B, userId: USER }, { inviteCode: codeOf(TENANT_SUSPENDED) }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVITE_CODE_INVALID',
  );
});

test('policy head reads disabled v0 when absent and enforces CAS on every write', async () => {
  const { database, service } = createFixture();
  const empty = await service.getAffiliatePolicy({ userId: ACTOR });
  assert.deepEqual(empty, {
    rewardBp: 0,
    enabled: false,
    version: 0,
    updatedByUserId: null,
    createdAt: null,
    updatedAt: null,
  });

  await assert.rejects(
    service.replaceAffiliatePolicy({ userId: ACTOR }, { rewardBp: 250, enabled: true, expectedVersion: 1 }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_POLICY_VERSION_CONFLICT',
  );

  const created = await service.replaceAffiliatePolicy(
    { userId: ACTOR },
    { rewardBp: 250, enabled: true, expectedVersion: 0 },
  );
  assert.equal(created.version, 1);
  assert.equal(created.rewardBp, 250);
  assert.equal(created.enabled, true);
  assert.equal(created.updatedByUserId, ACTOR);

  await assert.rejects(
    service.replaceAffiliatePolicy({ userId: ACTOR }, { rewardBp: 500, enabled: true, expectedVersion: 0 }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_POLICY_VERSION_CONFLICT',
  );
  await assert.rejects(
    service.replaceAffiliatePolicy({ userId: ACTOR }, { rewardBp: 500, enabled: true, expectedVersion: 7 }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_POLICY_VERSION_CONFLICT',
  );

  const replaced = await service.replaceAffiliatePolicy(
    { userId: ACTOR },
    { rewardBp: 500, enabled: false, expectedVersion: 1 },
  );
  assert.equal(replaced.version, 2);
  assert.equal(replaced.rewardBp, 500);
  assert.equal(replaced.enabled, false);

  const audits = database.state.audit.filter((row) => row.action === 'marketing.affiliate_policy.replaced');
  assert.equal(audits.length, 2, 'only the two successful CAS writes audit');
  assert.ok(audits.every((row) => row.actor_user_id === ACTOR && row.target_id === 'platform'));

  for (const input of [
    { rewardBp: -1, enabled: true, expectedVersion: 2 },
    { rewardBp: 5001, enabled: true, expectedVersion: 2 },
    { rewardBp: 2.5, enabled: true, expectedVersion: 2 },
    { rewardBp: 250, enabled: 'yes', expectedVersion: 2 },
    { rewardBp: 250, enabled: true, expectedVersion: -1 },
  ]) {
    await assert.rejects(
      service.replaceAffiliatePolicy({ userId: ACTOR }, input),
      (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVALID_INPUT',
    );
  }
});

function fundingInput(overrides: Partial<{ tenantId: string; amountMinorUnits: string; sourceOrderRef: string }> = {}) {
  return {
    tenantId: overrides.tenantId ?? TENANT_B,
    currency: 'CNY',
    amountMinorUnits: overrides.amountMinorUnits ?? '10000',
    sourceOrderRef: overrides.sourceOrderRef ?? '00000000-0000-4000-8000-0000000000f1',
    fundingTransactionId: 'funding-tx-1',
  };
}

async function accrue(fixture: ReturnType<typeof createFixture>, input = fundingInput()) {
  return fixture.database.transaction((executor) => fixture.service.afterVerifiedFunding(executor, input));
}

test('accrual is a zero side effect without attribution, policy, enablement or positive floor', async () => {
  const { database, ledger, service } = createFixture();
  // No attribution at all.
  await database.transaction((executor) => service.afterVerifiedFunding(executor, fundingInput()));
  assert.equal(ledger.calls.length, 0);

  database.seedAttribution(TENANT_B, TENANT_A);
  // Attribution but no policy row.
  await database.transaction((executor) => service.afterVerifiedFunding(executor, fundingInput()));
  assert.equal(ledger.calls.length, 0);

  // Disabled policy.
  const policy = database.seedPolicy({ enabled: false, reward_bp: 500 });
  await database.transaction((executor) => service.afterVerifiedFunding(executor, fundingInput()));
  assert.equal(ledger.calls.length, 0);

  // Enabled but bp = 0.
  policy.enabled = true;
  policy.reward_bp = 0;
  await database.transaction((executor) => service.afterVerifiedFunding(executor, fundingInput()));
  assert.equal(ledger.calls.length, 0);

  // Positive bp but the floor of the reward is zero.
  policy.reward_bp = 1;
  await database.transaction((executor) =>
    service.afterVerifiedFunding(executor, fundingInput({ amountMinorUnits: '9999' })),
  );
  assert.equal(ledger.calls.length, 0);
  assert.equal(database.state.rewards.length, 0);
  assert.equal(database.state.audit.length, 0);
});

test('accrual fixed-point matrix floors exactly and snapshots the policy basis points', async () => {
  const matrix: Array<{ amount: string; bp: number; expected: string }> = [
    { amount: '10000', bp: 1, expected: '1' },
    { amount: '10000', bp: 5000, expected: '5000' },
    { amount: '125', bp: 500, expected: '6' },
    { amount: '200', bp: 5000, expected: '100' },
    { amount: '99999999999999999999', bp: 5000, expected: '49999999999999999999' },
    { amount: '3', bp: 3333, expected: '0' },
  ];
  for (const { amount, bp, expected } of matrix) {
    const fixture = createFixture();
    fixture.database.seedAttribution(TENANT_B, TENANT_A);
    fixture.database.seedPolicy({ reward_bp: bp, enabled: true });
    await accrue(fixture, fundingInput({ amountMinorUnits: amount }));
    if (expected === '0') {
      assert.equal(fixture.ledger.calls.length, 0, `amount ${amount} bp ${bp} floors to a zero side effect`);
      continue;
    }
    assert.equal(fixture.ledger.calls.length, 1);
    assert.equal(fixture.ledger.calls[0]?.amountMinorUnits, expected, `amount ${amount} bp ${bp}`);
    assert.equal(fixture.database.state.rewards[0]?.reward_amount_minor_units, expected);
    assert.equal(fixture.database.state.rewards[0]?.reward_bp_snapshot, bp);
    assert.equal(fixture.database.state.rewards[0]?.source_amount_minor_units, amount);
  }
});

test('accrual posts the C-6 ledger tuple and a later policy change never rewrites history', async () => {
  const { database, ledger, service } = createFixture();
  database.seedAttribution(TENANT_B, TENANT_A);
  database.seedPolicy({ reward_bp: 250, enabled: true });

  await database.transaction((executor) => service.afterVerifiedFunding(executor, fundingInput()));
  const posting = ledger.calls[0];
  assert.equal(posting?.tenantId, TENANT_A, 'the reward credits the inviter wallet');
  assert.equal(posting?.currency, 'CNY');
  assert.equal(posting?.amountMinorUnits, '250');
  assert.equal(posting?.sourceOrderRef, '00000000-0000-4000-8000-0000000000f1');
  assert.equal(posting?.idempotencyKey, `00000000-0000-4000-8000-0000000000f1:${TENANT_A}`);
  assert.equal(posting?.idempotencyNamespace, MARKETING_AFFILIATE_IDEMPOTENCY_NAMESPACE);
  assert.equal(posting?.metadataRef, 'affiliate-reward:00000000-0000-4000-8000-0000000000f1');

  const reward = database.state.rewards[0];
  assert.equal(reward?.inviter_tenant_id, TENANT_A);
  assert.equal(reward?.invitee_tenant_id, TENANT_B);
  assert.equal(reward?.ledger_transaction_id, 'ledger-tx-1');
  const audit = database.state.audit.find((row) => row.action === 'marketing.affiliate.reward_accrued');
  assert.equal(audit?.tenant_id, TENANT_A);
  assert.equal(audit?.actor_user_id, null);
  assert.equal(audit?.target_id, reward?.id);

  // Policy replacement after the accrual: the stored reward keeps its snapshot.
  await service.replaceAffiliatePolicy({ userId: ACTOR }, { rewardBp: 1000, enabled: true, expectedVersion: 1 });
  await database.transaction((executor) =>
    service.afterVerifiedFunding(
      executor,
      fundingInput({ sourceOrderRef: '00000000-0000-4000-8000-0000000000f2', amountMinorUnits: '1000' }),
    ),
  );
  const second = database.state.rewards.find(
    (row) => row.source_funding_ref === '00000000-0000-4000-8000-0000000000f2',
  );
  assert.equal(database.state.rewards.length, 2);
  assert.equal(database.state.rewards[0]?.reward_bp_snapshot, 250, 'the first reward is immutable history');
  assert.equal(database.state.rewards[0]?.reward_amount_minor_units, '250');
  assert.equal(second?.reward_bp_snapshot, 1000);
  assert.equal(second?.reward_amount_minor_units, '100');
});

test('accrual replay is idempotent: the ledger replays and the reward row never duplicates', async () => {
  const { database, ledger, service } = createFixture();
  database.seedAttribution(TENANT_B, TENANT_A);
  database.seedPolicy({ reward_bp: 500, enabled: true });

  await accrue({ database, ledger, service });
  await accrue({ database, ledger, service });
  assert.equal(ledger.calls.length, 2);
  assert.equal(database.state.rewards.length, 1, 'ON CONFLICT (source_funding_ref) DO NOTHING absorbs the replay');
  assert.equal(
    database.state.audit.filter((row) => row.action === 'marketing.affiliate.reward_accrued').length,
    1,
    'a replay never re-audits',
  );
});

test('a ledger failure propagates out of the hook and rolls the accrual transaction back', async () => {
  const { database, ledger, service } = createFixture();
  database.seedAttribution(TENANT_B, TENANT_A);
  database.seedPolicy({ reward_bp: 500, enabled: true });
  ledger.shouldFail = true;
  await assert.rejects(accrue({ database, ledger, service }), /ledger failure/);
  assert.equal(database.state.rewards.length, 0);
  assert.equal(database.state.audit.length, 0);
});

test('the hook validates its inputs fail-closed', async () => {
  const { database, service } = createFixture();
  database.seedAttribution(TENANT_B, TENANT_A);
  database.seedPolicy({ reward_bp: 500, enabled: true });
  const cases: Array<Record<string, unknown>> = [
    { tenantId: 'not-a-uuid' },
    { currency: 'cny' },
    { amountMinorUnits: '0' },
    { amountMinorUnits: '12.5' },
    { sourceOrderRef: '' },
    { fundingTransactionId: '' },
  ];
  for (const patch of cases) {
    await assert.rejects(
      database.transaction((executor) =>
        service.afterVerifiedFunding(executor, { ...fundingInput(), ...patch } as never),
      ),
      (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVALID_INPUT',
    );
  }
  assert.equal(database.state.rewards.length, 0);
});

test('getMyAffiliate returns the derived code, the attribution count and keyset-paged rewards', async () => {
  const { database, ledger, service } = createFixture();
  database.seedAttribution(TENANT_B, TENANT_A);
  database.seedAttribution(TENANT_C, TENANT_A);
  database.seedAttribution(TENANT_D, TENANT_B);
  database.seedPolicy({ reward_bp: 500, enabled: true });
  for (const [invitee, ref] of [
    [TENANT_B, '00000000-0000-4000-8000-0000000000f1'],
    [TENANT_C, '00000000-0000-4000-8000-0000000000f2'],
    [TENANT_B, '00000000-0000-4000-8000-0000000000f3'],
    [TENANT_D, '00000000-0000-4000-8000-0000000000f4'],
  ] as const) {
    await database.transaction((executor) =>
      service.afterVerifiedFunding(executor, fundingInput({ tenantId: invitee, sourceOrderRef: ref })),
    );
  }
  assert.equal(ledger.calls.length, 4);

  const first = await service.getMyAffiliate({ tenantId: TENANT_A, userId: USER }, { limit: 2 });
  assert.equal(first.inviteCode, codeOf(TENANT_A));
  assert.equal(first.invitedCount, 2, 'only tenants that named me as inviter count');
  assert.equal(first.rewards.length, 2);
  assert.ok(first.nextCursor);
  const second = await service.getMyAffiliate(
    { tenantId: TENANT_A, userId: USER },
    { limit: 2, cursor: first.nextCursor },
  );
  assert.equal(second.rewards.length, 1);
  assert.equal(second.nextCursor, null);
  const ids = [...first.rewards, ...second.rewards].map((row) => row.id);
  assert.equal(new Set(ids).size, 3, 'pages never overlap');

  // Tenant B invited only D; D's single funding credits exactly one reward.
  const mine = await service.getMyAffiliate({ tenantId: TENANT_B, userId: USER }, {});
  assert.equal(mine.invitedCount, 1);
  assert.equal(mine.rewards.length, 1);
  assert.equal(mine.rewards[0]?.inviterTenantId, TENANT_B);
  assert.equal(mine.rewards[0]?.inviteeTenantId, TENANT_D);

  await assert.rejects(
    service.getMyAffiliate({ tenantId: TENANT_A, userId: USER }, { cursor: '!!!not-a-cursor!!!' }),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_INVALID_INPUT',
  );
});

test('listRewards pages for operations with an optional inviter filter', async () => {
  const { database, service } = createFixture();
  database.seedAttribution(TENANT_B, TENANT_A);
  database.seedAttribution(TENANT_C, TENANT_B);
  database.seedPolicy({ reward_bp: 500, enabled: true });
  for (const [invitee, ref] of [
    [TENANT_B, '00000000-0000-4000-8000-0000000000f1'],
    [TENANT_C, '00000000-0000-4000-8000-0000000000f2'],
  ] as const) {
    await database.transaction((executor) =>
      service.afterVerifiedFunding(executor, fundingInput({ tenantId: invitee, sourceOrderRef: ref })),
    );
  }

  const all = await service.listRewards({ userId: ACTOR }, { limit: 1 });
  assert.equal(all.rewards.length, 1);
  assert.ok(all.nextCursor);
  const rest = await service.listRewards({ userId: ACTOR }, { limit: 10, cursor: all.nextCursor });
  assert.equal(rest.rewards.length, 1);
  assert.equal(rest.nextCursor, null);

  const filtered = await service.listRewards({ userId: ACTOR }, { inviterTenantId: TENANT_A });
  assert.equal(filtered.rewards.length, 1);
  assert.equal(filtered.rewards[0]?.inviterTenantId, TENANT_A);

  await assert.rejects(
    service.listRewards({ userId: 'nope' }, {}),
    (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_FORBIDDEN',
  );
});
