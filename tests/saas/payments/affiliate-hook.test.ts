import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  MARKETING_AFFILIATE_IDEMPOTENCY_NAMESPACE,
  MarketingAffiliateService,
} from '../../../src/saas/marketing/affiliate.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import { createFakeFundingLedger, FakePaymentDatabase, FakePaymentProvider, successWebhook } from './fake-sql.js';

// R2/G3 seam tests: the affiliate WalletFundingHook runs inside the payment
// fulfillment transaction. A hook failure keeps fulfillment retryable
// (fail-closed accrual, never a silently skipped reward) and the inbox retry
// replays the hook idempotently — the reward row and the inviter wallet
// posting commit exactly once. The fake payment database is extended with
// the affiliate tables; its transaction snapshot rolls them back with the
// payment state, mirroring the real driver.

const merchantId = 'merchant-test-1';
const TENANT = '00000000-0000-4000-8000-0000000000b2';
const INVITER = '00000000-0000-4000-8000-0000000000b1';
const STRANGER = '00000000-0000-4000-8000-0000000000c1';
const SALT = 'affiliate-hook-test-salt';
const NOW = '2026-10-11T00:00:00.000Z';

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

interface AffiliateState {
  attributions: Array<{ invitee_tenant_id: string; inviter_tenant_id: string; invite_code: string }>;
  policies: PolicyRow[];
  rewards: RewardRow[];
  audit: Array<{ action: string; tenant_id: string | null; target_id: string }>;
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows, rowCount: rows.length } as SqlResult<Row>;
}

class AffiliatePaymentDatabase extends FakePaymentDatabase {
  affiliate: AffiliateState = { attributions: [], policies: [], rewards: [], audit: [] };
  private rewardIdCounter = 0;

  seedPolicy(rewardBp: number, enabled: boolean): void {
    this.affiliate.policies.push({
      id: 'platform',
      reward_bp: rewardBp,
      enabled,
      version: '1',
      updated_by_user_id: '00000000-0000-4000-8000-0000000000a1',
      created_at: NOW,
      updated_at: NOW,
    });
  }

  override async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const handled = this.executeAffiliate<Row>(sql, values);
    if (handled) return handled;
    return super.query(sql, values);
  }

  override async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const before = structuredClone(this.affiliate);
    try {
      return await super.transaction(() => work({ query: (sql, values = []) => this.query(sql, values) }));
    } catch (error) {
      this.affiliate = before;
      throw error;
    }
  }

  private executeAffiliate<Row>(sql: string, values: readonly unknown[]): SqlResult<Row> | undefined {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e] = values;

    if (statement.startsWith('select inviter_tenant_id, invite_code')) {
      const found = this.affiliate.attributions.find((row) => row.invitee_tenant_id === a);
      return result<Row>(
        found ? [{ inviter_tenant_id: found.inviter_tenant_id, invite_code: found.invite_code } as Row] : [],
      );
    }

    if (statement.startsWith('select id, reward_bp, enabled, version')) {
      const policy = this.affiliate.policies[0];
      return result<Row>(policy ? [policy as Row] : []);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_affiliate_rewards')) {
      if (this.affiliate.rewards.some((row) => row.source_funding_ref === d)) {
        return result<Row>(); // ON CONFLICT (source_funding_ref) DO NOTHING
      }
      this.rewardIdCounter += 1;
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
      this.affiliate.rewards.push(row);
      return result<Row>([{ id: row.id } as Row]);
    }

    if (statement.startsWith('insert into model_router_saas.saas_audit_events')) {
      this.affiliate.audit.push({
        action: String(d),
        tenant_id: b === null ? null : String(b),
        target_id: String(values[5]),
      });
      return result<Row>();
    }

    return undefined;
  }
}

function createAffiliateLedger() {
  const state = {
    shouldFail: false,
    calls: [] as Array<{
      tenantId: string;
      currency: string;
      amountMinorUnits: string;
      sourceOrderRef: string;
      idempotencyKey: string;
      idempotencyNamespace: string;
      metadataRef: string;
    }>,
    async postVerifiedFunding(
      _executor: SqlExecutor,
      input: {
        tenantId: string;
        currency: string;
        amountMinorUnits: string;
        sourceOrderRef: string;
        idempotencyKey: string;
        idempotencyNamespace: string;
        metadataRef: string;
      },
    ): Promise<{ outcome: 'posted'; replayed: boolean; transactionId: string }> {
      state.calls.push({ ...input });
      if (state.shouldFail) throw new Error('affiliate ledger failure');
      return { outcome: 'posted', replayed: false, transactionId: `affiliate-tx-${state.calls.length}` };
    },
  };
  return state;
}

function createFixture(options: { attributed?: boolean; rewardBp?: number; enabled?: boolean } = {}) {
  const database = new AffiliatePaymentDatabase();
  if (options.attributed) {
    database.affiliate.attributions.push({
      invitee_tenant_id: TENANT,
      inviter_tenant_id: INVITER,
      invite_code: 'INVOKECODE000000',
    });
  }
  if (options.rewardBp !== undefined) database.seedPolicy(options.rewardBp, options.enabled ?? true);

  const provider = new FakePaymentProvider();
  const fundingLedger = createFakeFundingLedger(database);
  const affiliateLedger = createAffiliateLedger();
  const clock = { value: new Date('2026-09-28T00:00:00.000Z') };
  let nextId = 0;
  const affiliate = new MarketingAffiliateService({
    database: database as unknown as SaasDatabase,
    fundingLedger: affiliateLedger,
    inviteCodeSalt: SALT,
    idFactory: () => `aff-${++nextId}`,
    now: () => new Date(NOW),
  });
  const service = new PaymentFulfillmentService(database, provider, {
    providerKey: provider.providerKey,
    merchantId,
    now: () => new Date(clock.value.getTime()),
    idFactory: () => `order-${++nextId}`,
    walletFundingLedger: fundingLedger,
    walletFundingHook: affiliate,
  });
  return { database, provider, fundingLedger, affiliateLedger, clock, service };
}

async function fulfillTopUp(
  fixture: ReturnType<typeof createFixture>,
  tenantId: string,
  amountMinorUnits = '125',
  currency = 'USD',
) {
  const order = await fixture.service.createWalletTopUp({
    tenantId,
    clientRequestId: `request-${tenantId}`,
    amountMinorUnits,
    currency,
  });
  assert.ok(order.providerOrderId);
  const accepted = await fixture.service.handleWebhook(
    { 'x-test-signature': 'verified-by-fixture' },
    successWebhook(order.providerOrderId, tenantId, `event-${tenantId}`, amountMinorUnits, currency),
  );
  assert.equal(accepted.outcome, 'accepted');
  return order;
}

test('fulfillment runs the affiliate hook: inviter wallet posting, reward row and audit land together', async () => {
  const fixture = createFixture({ attributed: true, rewardBp: 500 });
  const order = await fulfillTopUp(fixture, TENANT);

  const batch = await fixture.service.processPendingWebhooks();
  assert.equal(batch.processed, 1);
  assert.equal(fixture.database.state.orders[0]?.state, 'fulfilled');

  const posting = fixture.affiliateLedger.calls[0];
  assert.equal(fixture.affiliateLedger.calls.length, 1);
  assert.equal(posting?.tenantId, INVITER, 'the reward credits the inviter, not the top-up tenant');
  assert.equal(posting?.amountMinorUnits, '6', 'floor(125 * 500 / 10000)');
  assert.equal(posting?.currency, 'USD');
  assert.equal(posting?.sourceOrderRef, order.id);
  assert.equal(posting?.idempotencyKey, `${order.id}:${INVITER}`);
  assert.equal(posting?.idempotencyNamespace, MARKETING_AFFILIATE_IDEMPOTENCY_NAMESPACE);
  assert.equal(posting?.metadataRef, `affiliate-reward:${order.id}`);

  const reward = fixture.database.affiliate.rewards[0];
  assert.equal(fixture.database.affiliate.rewards.length, 1);
  assert.equal(reward?.inviter_tenant_id, INVITER);
  assert.equal(reward?.invitee_tenant_id, TENANT);
  assert.equal(reward?.source_funding_ref, order.id);
  assert.equal(reward?.source_amount_minor_units, '125');
  assert.equal(reward?.reward_amount_minor_units, '6');
  assert.equal(reward?.reward_bp_snapshot, 500);
  assert.equal(reward?.ledger_transaction_id, 'affiliate-tx-1');
  const accrualAudit = fixture.database.affiliate.audit.filter(
    (row) => row.action === 'marketing.affiliate.reward_accrued',
  );
  assert.equal(accrualAudit.length, 1);
  assert.equal(accrualAudit[0]?.tenant_id, INVITER);
  assert.equal(fixture.database.state.funding.length, 1, 'the invitee funding posting is unaffected');
});

test('a hook failure keeps fulfillment retryable and the inbox retry accrues exactly once', async () => {
  const fixture = createFixture({ attributed: true, rewardBp: 500 });
  const order = await fulfillTopUp(fixture, TENANT);
  fixture.affiliateLedger.shouldFail = true;

  const failed = await fixture.service.processPendingWebhooks();
  assert.equal(failed.retrying, 1);
  assert.equal(fixture.database.state.orders[0]?.state, 'pending', 'the order transition rolls back');
  assert.equal(fixture.database.state.funding.length, 0, 'the funding posting rolls back');
  assert.equal(fixture.database.affiliate.rewards.length, 0, 'no reward survives the rollback');
  assert.equal(fixture.database.affiliate.audit.length, 0);

  fixture.affiliateLedger.shouldFail = false;
  fixture.clock.value = new Date(fixture.clock.value.getTime() + 2_000); // outlast the retry backoff
  const retried = await fixture.service.processPendingWebhooks();
  assert.equal(retried.processed, 1);
  assert.equal(fixture.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.funding.length, 1);
  assert.equal(fixture.database.affiliate.rewards.length, 1, 'the retried hook accrues exactly one reward');
  assert.equal(fixture.database.affiliate.rewards[0]?.source_funding_ref, order.id);
  assert.equal(fixture.affiliateLedger.calls.length, 2, 'the hook re-ran after the rollback');
  assert.equal(
    fixture.database.affiliate.audit.filter((row) => row.action === 'marketing.affiliate.reward_accrued').length,
    1,
  );

  // A late duplicate delivery replays the terminal state without re-accrual.
  const replay = await fixture.service.handleWebhook(
    { 'x-test-signature': 'verified-by-fixture' },
    successWebhook(order.providerOrderId as string, TENANT, `event-${TENANT}`, '125'),
  );
  assert.equal(replay.outcome, 'fulfilled');
  assert.equal(replay.replayed, true);
  assert.equal(fixture.database.affiliate.rewards.length, 1);
  assert.equal(fixture.affiliateLedger.calls.length, 2, 'a terminal replay never re-runs the hook');
});

test('fulfillment without attribution or with a disabled policy stays a zero side effect', async () => {
  // No attribution row at all: the hook never touches the ledger.
  const unattributed = createFixture({ rewardBp: 500 });
  await fulfillTopUp(unattributed, STRANGER);
  const first = await unattributed.service.processPendingWebhooks();
  assert.equal(first.processed, 1);
  assert.equal(unattributed.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(unattributed.affiliateLedger.calls.length, 0);
  assert.equal(unattributed.database.affiliate.rewards.length, 0);
  assert.equal(unattributed.database.affiliate.audit.length, 0);

  // Attribution present but the policy is disabled: same zero side effect.
  const disabled = createFixture({ attributed: true, rewardBp: 500, enabled: false });
  await fulfillTopUp(disabled, TENANT);
  const second = await disabled.service.processPendingWebhooks();
  assert.equal(second.processed, 1);
  assert.equal(disabled.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(disabled.affiliateLedger.calls.length, 0);
  assert.equal(disabled.database.affiliate.rewards.length, 0);

  // Enabled policy with a floor-to-zero reward: still a zero side effect.
  const floored = createFixture({ attributed: true, rewardBp: 1 });
  await fulfillTopUp(floored, TENANT, '199');
  const third = await floored.service.processPendingWebhooks();
  assert.equal(third.processed, 1);
  assert.equal(floored.affiliateLedger.calls.length, 0, 'floor(199 * 1 / 10000) = 0 accrues nothing');
  assert.equal(floored.database.affiliate.rewards.length, 0);
});
