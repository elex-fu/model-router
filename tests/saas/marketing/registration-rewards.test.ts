import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { RegistrationAffiliatePort } from '../../../src/saas/identity/register-service.js';
import type { RegistrationRewardSettings } from '../../../src/saas/identity/registration-settings.js';
import type { MarketingAffiliateService } from '../../../src/saas/marketing/affiliate.js';
import {
  MARKETING_AFFILIATE_REGISTRATION_IDEMPOTENCY_NAMESPACE,
  MARKETING_REGISTRATION_IDEMPOTENCY_NAMESPACE,
  MarketingRegistrationRewards,
} from '../../../src/saas/marketing/registration-rewards.js';

/**
 * R4 registration admission: the affiliate registration-path binding + the
 * three-tier reward scheme. The funding ledger and affiliate service are
 * injected ports, so the fixtures below fake them; MarketingRegistrationRewards
 * itself (the orchestration under test) is the real implementation.
 */

const INVITEE_TENANT = '00000000-0000-0000-0000-00000000000a';
const INVITER_TENANT = '00000000-0000-0000-0000-00000000000b';
const USER_ID = '00000000-0000-0000-0000-00000000000c';
const INVITE_CODE = 'ABCD234EFGH56';

interface PostingCall {
  tenantId: string;
  currency: string;
  amountMinorUnits: string;
  sourceOrderRef: string;
  idempotencyKey: string;
  idempotencyNamespace: string;
  metadataRef?: string;
}

class FakeFundingLedger {
  readonly calls: PostingCall[] = [];
  private transactionCounter = 0;

  async postVerifiedFunding(
    _executor: SqlExecutor,
    input: {
      tenantId: string;
      currency: string;
      amountMinorUnits: string;
      sourceOrderRef: string;
      idempotencyKey: string;
      idempotencyNamespace?: string;
      metadataRef?: string;
    },
  ): Promise<{ outcome: 'posted' | 'replayed'; replayed: boolean; transactionId: string }> {
    const call: PostingCall = {
      tenantId: input.tenantId,
      currency: input.currency,
      amountMinorUnits: input.amountMinorUnits,
      sourceOrderRef: input.sourceOrderRef,
      idempotencyKey: input.idempotencyKey,
      idempotencyNamespace: input.idempotencyNamespace ?? 'saas.wallet.funding',
      ...(input.metadataRef === undefined ? {} : { metadataRef: input.metadataRef }),
    };
    const seen = this.calls.find(
      (previous) =>
        previous.idempotencyNamespace === call.idempotencyNamespace && previous.idempotencyKey === call.idempotencyKey,
    );
    if (seen) {
      return { outcome: 'replayed', replayed: true, transactionId: `tx-${this.calls.indexOf(seen)}` };
    }
    this.calls.push(call);
    this.transactionCounter += 1;
    return { outcome: 'posted', replayed: false, transactionId: `tx-${this.transactionCounter}` };
  }
}

interface BindCall {
  tenantId: string;
  userId: string;
  inviteCode: string;
}

function fakeAffiliate(bindResult: { inviterTenantId: string }) {
  const binds: BindCall[] = [];
  const resolves: string[] = [];
  const service = {
    resolveInviteCode: async (code: string) => {
      resolves.push(code);
      return code === INVITE_CODE ? INVITER_TENANT : null;
    },
    bindInviter: async (context: { tenantId: string; userId: string }, input: { inviteCode: string }) => {
      binds.push({ tenantId: context.tenantId, userId: context.userId, inviteCode: input.inviteCode });
      return { outcome: 'bound' as const, inviterTenantId: bindResult.inviterTenantId };
    },
  };
  return { service: service as unknown as MarketingAffiliateService, binds, resolves };
}

/** Minimal database seam: transactions plus the affiliate reward-row INSERT. */
class FakeRewardsDatabase {
  readonly rewardRows: Array<Record<string, unknown>> = [];
  readonly queryLog: string[] = [];

  async query<Row>(sql: string, _values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queryLog.push(statement);
    if (statement.startsWith('set local ')) return { rows: [], rowCount: 0 };
    if (statement.startsWith('insert into model_router_saas.saas_marketing_affiliate_rewards')) {
      const row = { inserted: true };
      this.rewardRows.push(row);
      return { rows: [row] as Row[], rowCount: 1 };
    }
    throw new Error(`Unimplemented fake SQL: ${statement}`);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: <Row>(sql: string, values?: readonly unknown[]) => this.query<Row>(sql, values) });
  }
}

function rewards(overrides: Partial<RegistrationRewardSettings> = {}): RegistrationRewardSettings {
  return {
    currency: 'USD',
    grantMinorUnits: '0',
    codeFillerMinorUnits: '0',
    codeOwnerMinorUnits: '0',
    codeOwnerMinThresholdMinorUnits: '0',
    ...overrides,
  };
}

function fixture(
  rewardSettings: RegistrationRewardSettings,
  bindTenant = INVITER_TENANT,
): {
  database: FakeRewardsDatabase;
  ledger: FakeFundingLedger;
  affiliate: ReturnType<typeof fakeAffiliate>;
  port: RegistrationAffiliatePort;
} {
  const database = new FakeRewardsDatabase();
  const ledger = new FakeFundingLedger();
  const affiliate = fakeAffiliate({ inviterTenantId: bindTenant });
  const port = new MarketingRegistrationRewards({
    database: database as unknown as SaasDatabase,
    affiliate: affiliate.service,
    fundingLedger: ledger,
    rewards: rewardSettings,
  });
  return { database, ledger, affiliate, port };
}

test('no invite code and zero rewards: pure binding skip, zero wallet activity', async () => {
  const fxt = fixture(rewards());
  await fxt.port.completeRegistrationAttribution({ inviteeTenantId: INVITEE_TENANT, userId: USER_ID });
  assert.equal(fxt.ledger.calls.length, 0);
  assert.equal(fxt.affiliate.binds.length, 0);
});

test('invite code binds attribution and posts all three tiers', async () => {
  const fxt = fixture(
    rewards({
      grantMinorUnits: '1000',
      codeFillerMinorUnits: '500',
      codeOwnerMinorUnits: '300',
      codeOwnerMinThresholdMinorUnits: '100',
    }),
  );
  await fxt.port.completeRegistrationAttribution({
    inviteeTenantId: INVITEE_TENANT,
    userId: USER_ID,
    inviteCode: INVITE_CODE,
  });
  assert.deepEqual(fxt.affiliate.binds, [{ tenantId: INVITEE_TENANT, userId: USER_ID, inviteCode: INVITE_CODE }]);

  assert.equal(fxt.ledger.calls.length, 3);
  const grant = fxt.ledger.calls[0];
  assert.equal(grant.tenantId, INVITEE_TENANT);
  assert.equal(grant.amountMinorUnits, '1000');
  assert.equal(grant.sourceOrderRef, `registration-grant:${USER_ID}`);
  assert.equal(grant.idempotencyNamespace, MARKETING_REGISTRATION_IDEMPOTENCY_NAMESPACE);

  const filler = fxt.ledger.calls[1];
  assert.equal(filler.tenantId, INVITEE_TENANT);
  assert.equal(filler.amountMinorUnits, '500');
  assert.equal(filler.sourceOrderRef, `registration-filler:${USER_ID}`);
  assert.equal(filler.idempotencyNamespace, MARKETING_REGISTRATION_IDEMPOTENCY_NAMESPACE);

  const owner = fxt.ledger.calls[2];
  assert.equal(owner.tenantId, INVITER_TENANT);
  assert.equal(owner.amountMinorUnits, '300');
  assert.equal(owner.sourceOrderRef, `registration-owner:${USER_ID}`);
  assert.equal(owner.idempotencyNamespace, MARKETING_AFFILIATE_REGISTRATION_IDEMPOTENCY_NAMESPACE);
  // The code-owner reward leaves the append-only affiliate audit row.
  assert.equal(fxt.database.rewardRows.length, 1);
});

test('registration grant posts even without an invite code when configured', async () => {
  const fxt = fixture(rewards({ grantMinorUnits: '700' }));
  await fxt.port.completeRegistrationAttribution({ inviteeTenantId: INVITEE_TENANT, userId: USER_ID });
  assert.equal(fxt.ledger.calls.length, 1);
  assert.equal(fxt.ledger.calls[0]?.amountMinorUnits, '700');
  assert.equal(fxt.ledger.calls[0]?.tenantId, INVITEE_TENANT);
  assert.equal(fxt.database.rewardRows.length, 0);
});

test('code-owner reward below the minimum conversion threshold never posts', async () => {
  const fxt = fixture(
    rewards({ codeFillerMinorUnits: '100', codeOwnerMinorUnits: '50', codeOwnerMinThresholdMinorUnits: '100' }),
  );
  await fxt.port.completeRegistrationAttribution({
    inviteeTenantId: INVITEE_TENANT,
    userId: USER_ID,
    inviteCode: INVITE_CODE,
  });
  // Filler posts; owner (50 < 100 threshold) does not.
  assert.equal(fxt.ledger.calls.length, 1);
  assert.equal(fxt.ledger.calls[0]?.sourceOrderRef, `registration-filler:${USER_ID}`);
  assert.equal(fxt.database.rewardRows.length, 0);
});

test('replaying the same registration never double-credits (idempotent namespaces and refs)', async () => {
  const fxt = fixture(
    rewards({
      grantMinorUnits: '1000',
      codeFillerMinorUnits: '500',
      codeOwnerMinorUnits: '300',
      codeOwnerMinThresholdMinorUnits: '0',
    }),
  );
  const input = { inviteeTenantId: INVITEE_TENANT, userId: USER_ID, inviteCode: INVITE_CODE };
  await fxt.port.completeRegistrationAttribution(input);
  const firstCount = fxt.ledger.calls.length;
  await fxt.port.completeRegistrationAttribution(input);
  assert.equal(fxt.ledger.calls.length, firstCount, 'no new postings on replay');
  // The ledger reported replays; the adapter accepted them without error.
});

test('resolveInviteCode delegates to the affiliate service', async () => {
  const fxt = fixture(rewards());
  assert.equal(await fxt.port.resolveInviteCode(INVITE_CODE), INVITER_TENANT);
  assert.equal(await fxt.port.resolveInviteCode('WRONGCODE123'), null);
  assert.deepEqual(fxt.affiliate.resolves, [INVITE_CODE, 'WRONGCODE123']);
});
