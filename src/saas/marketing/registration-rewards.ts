import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { RegistrationAffiliatePort } from '../identity/register-service.js';
import type { RegistrationRewardSettings } from '../identity/registration-settings.js';
import {
  MarketingAffiliateError,
  type MarketingAffiliateFundingLedger,
  type MarketingAffiliateService,
} from './affiliate.js';

/**
 * R4 registration admission (plan §R4): the marketing-side implementation of
 * the identity layer's RegistrationAffiliatePort.
 *
 * `resolveInviteCode` is the admission gate (invite mode / open-mode code
 * validation). `completeRegistrationAttribution` runs after the registration
 * transaction commits and performs the sub2api/new-api three-tier reward
 * scheme through the wallet funding terminal:
 *
 *   1. registration grant  — the new tenant's wallet (new user welcome
 *      balance; zero unless configured),
 *   2. code-filler reward  — the new tenant's wallet when an invite code was
 *      presented (zero unless configured),
 *   3. code-owner reward   — the inviter tenant's wallet, gated by the
 *      minimum conversion threshold (new-api's anti-farming rule: amounts
 *      below the configured threshold never post), with an append-only
 *      saas_marketing_affiliate_rewards audit row so the inviter's console
 *      shows it alongside funding rebates.
 *
 * Every posting is idempotent by (namespace, business key) anchored on the
 * immutable registration user id, so a replayed or retried attribution never
 * double-credits. Binding itself is MarketingAffiliateService.bindInviter
 * (domain lock, lifetime-immutable, idempotent replay).
 */

export const MARKETING_REGISTRATION_IDEMPOTENCY_NAMESPACE = 'marketing.registration' as const;
export const MARKETING_AFFILIATE_REGISTRATION_IDEMPOTENCY_NAMESPACE = 'marketing.affiliate.registration' as const;

export interface MarketingRegistrationRewardsOptions {
  readonly database: SaasDatabase;
  readonly affiliate: MarketingAffiliateService;
  readonly fundingLedger: MarketingAffiliateFundingLedger;
  readonly rewards: RegistrationRewardSettings;
  /**
   * F1 platform settings store: dynamic store-first reward resolution. When
   * present it supersedes the static snapshot at attribution time; a resolver
   * failure fails closed to the constructor snapshot (rewards already granted
   * under earlier settings are immutable wallet facts and never repriced).
   */
  readonly rewardsResolver?: () => Promise<RegistrationRewardSettings>;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class MarketingRegistrationRewards implements RegistrationAffiliatePort {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: MarketingRegistrationRewardsOptions) {
    if (
      !options?.database ||
      typeof options.database.transaction !== 'function' ||
      !options?.affiliate ||
      typeof options.affiliate.resolveInviteCode !== 'function' ||
      !options?.fundingLedger ||
      typeof options.fundingLedger.postVerifiedFunding !== 'function' ||
      !options?.rewards
    ) {
      throw new TypeError('Invalid marketing registration rewards configuration');
    }
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async resolveInviteCode(inviteCode: string): Promise<string | null> {
    return this.options.affiliate.resolveInviteCode(inviteCode);
  }

  async completeRegistrationAttribution(input: {
    readonly inviteeTenantId: string;
    readonly userId: string;
    readonly inviteCode?: string;
  }): Promise<void> {
    const { inviteeTenantId, userId, inviteCode } = input;
    if (typeof inviteeTenantId !== 'string' || typeof userId !== 'string') {
      throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
    }

    // Tier 0: the attribution binding itself (idempotent; only when a code
    // was presented and admitted).
    let inviterTenantId: string | null = null;
    if (inviteCode !== undefined) {
      const bound = await this.options.affiliate.bindInviter({ tenantId: inviteeTenantId, userId }, { inviteCode });
      inviterTenantId = bound.inviterTenantId;
    }

    let rewards = this.options.rewards;
    if (this.options.rewardsResolver !== undefined) {
      try {
        rewards = await this.options.rewardsResolver();
      } catch (error) {
        console.error('model-router registration rewards resolution failed; using the startup snapshot', error);
        rewards = this.options.rewards;
      }
    }
    const { currency, grantMinorUnits, codeFillerMinorUnits, codeOwnerMinorUnits, codeOwnerMinThresholdMinorUnits } =
      rewards;

    // Tiers 1 and 2: the invitee's wallet (registration grant, code filler).
    const grant = BigInt(grantMinorUnits);
    if (grant > 0n) {
      await this.postReward({
        tenantId: inviteeTenantId,
        currency,
        amountMinorUnits: grant,
        sourceOrderRef: `registration-grant:${userId}`,
        metadataRef: 'registration-grant',
      });
    }
    const filler = inviteCode === undefined ? 0n : BigInt(codeFillerMinorUnits);
    if (filler > 0n) {
      await this.postReward({
        tenantId: inviteeTenantId,
        currency,
        amountMinorUnits: filler,
        sourceOrderRef: `registration-filler:${userId}`,
        metadataRef: 'registration-code-filler',
      });
    }

    // Tier 3: the code owner's wallet, behind the minimum conversion
    // threshold (anti-farming: below-threshold configured amounts never post).
    if (inviterTenantId !== null) {
      const owner = BigInt(codeOwnerMinorUnits);
      const threshold = BigInt(codeOwnerMinThresholdMinorUnits);
      if (owner > 0n && owner >= threshold) {
        await this.postInviterRegistrationReward({
          inviterTenantId,
          inviteeTenantId,
          userId,
          currency,
          amountMinorUnits: owner,
        });
      }
    }
  }

  private async postReward(input: {
    readonly tenantId: string;
    readonly currency: string;
    readonly amountMinorUnits: bigint;
    readonly sourceOrderRef: string;
    readonly metadataRef: string;
  }): Promise<void> {
    await this.options.database.transaction(async (executor: SqlExecutor) => {
      await executor.query(`SET LOCAL lock_timeout = '2s'`);
      await executor.query(`SET LOCAL statement_timeout = '10s'`);
      // 'replayed' is a legitimate idempotent outcome: the exact posting has
      // already happened (retried attribution), never a double credit.
      await this.options.fundingLedger.postVerifiedFunding(executor, {
        tenantId: input.tenantId,
        currency: input.currency,
        amountMinorUnits: input.amountMinorUnits.toString(),
        sourceOrderRef: input.sourceOrderRef,
        idempotencyKey: `${input.sourceOrderRef}:${input.tenantId}`,
        idempotencyNamespace: MARKETING_REGISTRATION_IDEMPOTENCY_NAMESPACE,
        metadataRef: input.metadataRef,
      });
    });
  }

  /**
   * The code-owner registration reward: wallet posting plus the append-only
   * affiliate reward row (reward_bp_snapshot 0 — this is a fixed configured
   * amount, not a funding-percentage rebate) in one transaction.
   */
  private async postInviterRegistrationReward(input: {
    readonly inviterTenantId: string;
    readonly inviteeTenantId: string;
    readonly userId: string;
    readonly currency: string;
    readonly amountMinorUnits: bigint;
  }): Promise<void> {
    const sourceFundingRef = `registration-owner:${input.userId}`;
    await this.options.database.transaction(async (executor: SqlExecutor) => {
      await executor.query(`SET LOCAL lock_timeout = '2s'`);
      await executor.query(`SET LOCAL statement_timeout = '10s'`);
      const posting = await this.options.fundingLedger.postVerifiedFunding(executor, {
        tenantId: input.inviterTenantId,
        currency: input.currency,
        amountMinorUnits: input.amountMinorUnits.toString(),
        sourceOrderRef: sourceFundingRef,
        idempotencyKey: `${sourceFundingRef}:${input.inviterTenantId}`,
        idempotencyNamespace: MARKETING_AFFILIATE_REGISTRATION_IDEMPOTENCY_NAMESPACE,
        metadataRef: 'affiliate-registration-reward',
      });
      const inserted = await executor.query<{ id: string }>(
        `INSERT INTO model_router_saas.saas_marketing_affiliate_rewards
           (id, inviter_tenant_id, invitee_tenant_id, source_funding_ref, source_amount_minor_units,
            reward_amount_minor_units, currency, reward_bp_snapshot, ledger_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9)
         ON CONFLICT (source_funding_ref) DO NOTHING
         RETURNING id`,
        [
          this.idFactory(),
          input.inviterTenantId,
          input.inviteeTenantId,
          sourceFundingRef,
          input.amountMinorUnits.toString(),
          input.amountMinorUnits.toString(),
          input.currency,
          posting.transactionId,
          this.now().toISOString(),
        ],
      );
      if (!inserted.rows[0]?.id) return; // replay: the reward row already exists
    });
  }
}
