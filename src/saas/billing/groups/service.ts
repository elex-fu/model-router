import { saasAdvisoryKey } from '../../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { SaasBillingGroupsError, type SaasBillingGroupsErrorCode } from './errors.js';
import { computeTopupCredit, parseTopupAmountTierDiscounts } from './multiplier.js';
import { serializeModelPricingJson } from './override.js';
import { mapBillingGroupRow } from './record.js';
import type { AppliedTopupConversion, BillingGroupRecord, BillingGroupUpsertInput, TopupAmountTier } from './types.js';

type Row = Record<string, unknown>;

export interface SaasBillingGroupsServiceOptions {
  readonly now?: () => Date;
  /**
   * Amount-tier topup discounts (settings key
   * saas.payments.topup.amount_tier_discounts). No platform settings store
   * exists yet, so deployments inject the parsed value; an absent value means
   * no tier discounts.
   */
  readonly topupAmountTierDiscounts?: unknown;
}

const GROUP_COLUMNS = `
  id, display_name,
  rate_multiplier_num, rate_multiplier_den,
  topup_multiplier_num, topup_multiplier_den,
  peak_enabled, peak_start, peak_end, peak_multiplier_num, peak_multiplier_den,
  model_pricing,
  rpm_limit, daily_limit_minor_units, weekly_limit_minor_units, monthly_limit_minor_units,
  profit_min_margin_num, profit_min_margin_den, profit_safety_buffer_num, profit_safety_buffer_den,
  claude_code_only, fallback_group_id, supported_model_scopes,
  status, created_at, updated_at`;

function fail(code: SaasBillingGroupsErrorCode): never {
  throw new SaasBillingGroupsError(code);
}

function normalizeUpsert(
  input: BillingGroupUpsertInput,
): BillingGroupUpsertInput & { readonly modelPricingJson: string } {
  if (
    !input ||
    typeof input.id !== 'string' ||
    input.id.trim().length === 0 ||
    input.id.length > 128 ||
    input.id !== input.id.trim() ||
    typeof input.displayName !== 'string' ||
    input.displayName.trim().length === 0 ||
    input.displayName.length > 255
  ) {
    fail('INVALID_INPUT');
  }
  if (input.status !== 'active' && input.status !== 'disabled') fail('INVALID_INPUT');
  if (input.rateMultiplier.numerator <= 0n || input.rateMultiplier.denominator <= 0n) fail('INVALID_MULTIPLIER');
  if (input.topupMultiplier.numerator <= 0n || input.topupMultiplier.denominator <= 0n) fail('INVALID_MULTIPLIER');
  if (input.peakEnabled) {
    if (
      input.peakStart === null ||
      input.peakEnd === null ||
      input.peakMultiplier === null ||
      input.peakMultiplier.numerator <= 0n ||
      input.peakMultiplier.denominator <= 0n
    ) {
      fail('INVALID_INPUT');
    }
  }
  for (const margin of [input.profitMinMargin, input.profitSafetyBuffer]) {
    if (margin !== null && (margin.numerator < 0n || margin.denominator <= 0n)) fail('INVALID_MULTIPLIER');
  }
  if ((input.profitMinMargin === null) !== (input.profitSafetyBuffer === null)) fail('INVALID_INPUT');
  if (input.fallbackGroupId === input.id) fail('INVALID_INPUT');
  const modelPricingJson = serializeModelPricingJson(input.modelPricing === null ? {} : input.modelPricing);
  if (input.rpmLimit !== null && (!Number.isSafeInteger(input.rpmLimit) || input.rpmLimit < 0)) {
    fail('INVALID_INPUT');
  }
  return { ...input, modelPricingJson };
}

/**
 * Control-plane and gateway-facing billing group service. All multiplier
 * composition stays in pure helpers; this class owns SQL only.
 */
export class SaasBillingGroupsService {
  private readonly now: () => Date;
  private readonly topupTiers: readonly TopupAmountTier[];

  constructor(
    private readonly database: SaasDatabase,
    options: SaasBillingGroupsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.topupTiers = parseTopupAmountTierDiscounts(options.topupAmountTierDiscounts);
  }

  async getBillingGroup(id: string, options: { readonly executor?: SqlExecutor } = {}): Promise<BillingGroupRecord> {
    if (typeof id !== 'string' || id.trim().length === 0) fail('INVALID_INPUT');
    const executor = options.executor ?? this.database;
    const result = await executor.query<Row>(
      `/* saas-billing-groups:get */ SELECT ${GROUP_COLUMNS} FROM saas_billing_groups WHERE id = $1 LIMIT 2`,
      [id],
    );
    if (!result.rows[0]) fail('GROUP_NOT_FOUND');
    return mapBillingGroupRow(result.rows[0]);
  }

  async listBillingGroups(options: { readonly executor?: SqlExecutor } = {}): Promise<readonly BillingGroupRecord[]> {
    const executor = options.executor ?? this.database;
    const result = await executor.query<Row>(
      `/* saas-billing-groups:list */ SELECT ${GROUP_COLUMNS} FROM saas_billing_groups ORDER BY id ASC LIMIT 1000`,
      [],
    );
    return result.rows.map(mapBillingGroupRow);
  }

  async createBillingGroup(input: BillingGroupUpsertInput): Promise<BillingGroupRecord> {
    const normalized = normalizeUpsert(input);
    const createdAt = this.now().toISOString();
    return this.database.transaction(async (tx) => {
      await this.lockFence(tx, [saasAdvisoryKey.tenant('saas-billing-groups')]);
      if (normalized.fallbackGroupId !== null) await this.requireGroup(tx, normalized.fallbackGroupId);
      const result = await tx.query<Row>(
        `INSERT INTO saas_billing_groups
          (id, display_name,
           rate_multiplier_num, rate_multiplier_den,
           topup_multiplier_num, topup_multiplier_den,
           peak_enabled, peak_start, peak_end, peak_multiplier_num, peak_multiplier_den,
           model_pricing,
           rpm_limit, daily_limit_minor_units, weekly_limit_minor_units, monthly_limit_minor_units,
           profit_min_margin_num, profit_min_margin_den, profit_safety_buffer_num, profit_safety_buffer_den,
           claude_code_only, fallback_group_id, supported_model_scopes,
           status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${GROUP_COLUMNS}`,
        upsertValues(normalized, createdAt),
      );
      if (!result.rows[0]) fail('GROUP_CONFLICT');
      return mapBillingGroupRow(result.rows[0]);
    });
  }

  async updateBillingGroup(input: BillingGroupUpsertInput): Promise<BillingGroupRecord> {
    const normalized = normalizeUpsert(input);
    const updatedAt = this.now().toISOString();
    return this.database.transaction(async (tx) => {
      await this.lockFence(tx, [saasAdvisoryKey.tenant('saas-billing-groups')]);
      if (normalized.fallbackGroupId !== null) await this.requireGroup(tx, normalized.fallbackGroupId);
      const values = upsertValues(normalized, updatedAt);
      const result = await tx.query<Row>(
        `UPDATE saas_billing_groups SET
           display_name = $2,
           rate_multiplier_num = $3, rate_multiplier_den = $4,
           topup_multiplier_num = $5, topup_multiplier_den = $6,
           peak_enabled = $7, peak_start = $8, peak_end = $9,
           peak_multiplier_num = $10, peak_multiplier_den = $11,
           model_pricing = $12::jsonb,
           rpm_limit = $13, daily_limit_minor_units = $14, weekly_limit_minor_units = $15,
           monthly_limit_minor_units = $16,
           profit_min_margin_num = $17, profit_min_margin_den = $18,
           profit_safety_buffer_num = $19, profit_safety_buffer_den = $20,
           claude_code_only = $21, fallback_group_id = $22, supported_model_scopes = $23,
           status = $24, updated_at = $26
         WHERE id = $1
         RETURNING ${GROUP_COLUMNS}`,
        values,
      );
      if (!result.rows[0]) fail('GROUP_NOT_FOUND');
      return mapBillingGroupRow(result.rows[0]);
    });
  }

  /**
   * Changing a key's billing group changes its scheduling candidates and its
   * pricing, so the mutation mirrors the 047/082 invalidation pattern: hold
   * the tenant/project authorization fences, lock the key row, then bump
   * authz_version atomically with the group change.
   */
  async setKeyBillingGroup(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly keyId: string;
    readonly billingGroupId: string | null;
  }): Promise<{ readonly keyId: string; readonly billingGroupId: string | null; readonly authzVersion: string }> {
    if (
      typeof input.tenantId !== 'string' ||
      typeof input.projectId !== 'string' ||
      typeof input.keyId !== 'string' ||
      (input.billingGroupId !== null &&
        (typeof input.billingGroupId !== 'string' ||
          input.billingGroupId.trim().length === 0 ||
          input.billingGroupId.length > 128))
    ) {
      fail('INVALID_INPUT');
    }
    return this.database.transaction(async (tx) => {
      await this.lockFence(tx, [
        saasAdvisoryKey.tenant(input.tenantId),
        saasAdvisoryKey.project(input.tenantId, input.projectId),
      ]);
      if (input.billingGroupId !== null) await this.requireGroup(tx, input.billingGroupId);
      const locked = await tx.query<Row>(
        `SELECT id, status FROM saas_api_keys
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          FOR UPDATE`,
        [input.tenantId, input.projectId, input.keyId],
      );
      if (!locked.rows[0]) fail('TARGET_NOT_FOUND');
      if (locked.rows[0].status !== 'active') fail('TARGET_NOT_FOUND');
      const result = await tx.query<Row>(
        `UPDATE saas_api_keys
            SET billing_group_id = $4, authz_version = authz_version + 1
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
          RETURNING id, billing_group_id, authz_version`,
        [input.tenantId, input.projectId, input.keyId, input.billingGroupId],
      );
      if (!result.rows[0]) fail('TARGET_NOT_FOUND');
      const row = result.rows[0];
      return {
        keyId: String(row.id),
        billingGroupId: row.billing_group_id === null ? null : String(row.billing_group_id),
        authzVersion: String(row.authz_version),
      };
    });
  }

  /**
   * Replaces one group's account pool membership. Pool membership changes the
   * scheduling candidates for every key bound to the group (explicitly or via
   * a tenant default), so those keys' authz_version is bumped in the same
   * transaction (047/082 invalidation pattern).
   */
  async replaceGroupAccountPool(
    groupId: string,
    entries: readonly { readonly accountId: string; readonly priority: number }[],
  ): Promise<readonly { readonly accountId: string; readonly priority: number }[]> {
    if (typeof groupId !== 'string' || groupId.trim().length === 0) fail('INVALID_INPUT');
    if (!Array.isArray(entries) || entries.length > 10_000) fail('INVALID_INPUT');
    const seen = new Set<string>();
    for (const entry of entries) {
      if (
        typeof entry.accountId !== 'string' ||
        entry.accountId.trim().length === 0 ||
        !Number.isSafeInteger(entry.priority) ||
        entry.priority < 0 ||
        entry.priority > 1000 ||
        seen.has(entry.accountId)
      ) {
        fail('INVALID_INPUT');
      }
      seen.add(entry.accountId);
    }
    return this.database.transaction(async (tx) => {
      await this.lockFence(tx, [saasAdvisoryKey.tenant('saas-billing-groups')]);
      await this.requireGroup(tx, groupId);
      for (const entry of entries) {
        const account = await tx.query<Row>(`SELECT id FROM saas_platform_provider_accounts WHERE id = $1 LIMIT 2`, [
          entry.accountId,
        ]);
        if (!account.rows[0]) fail('TARGET_NOT_FOUND');
      }
      await tx.query(`DELETE FROM saas_billing_group_account_pools WHERE group_id = $1`, [groupId]);
      for (const entry of entries) {
        await tx.query(
          `INSERT INTO saas_billing_group_account_pools (group_id, account_id, priority)
           VALUES ($1, $2, $3)
           ON CONFLICT (group_id, account_id) DO UPDATE SET priority = EXCLUDED.priority`,
          [groupId, entry.accountId, entry.priority],
        );
      }
      await tx.query(
        `UPDATE saas_api_keys
            SET authz_version = authz_version + 1
          WHERE billing_group_id = $1
             OR (billing_group_id IS NULL
                 AND tenant_id IN (SELECT id FROM saas_tenants WHERE default_billing_group_id = $1))`,
        [groupId],
      );
      return entries;
    });
  }

  /**
   * Topup (wallet funding) conversion for one tenant: resolves the tenant's
   * default billing group, applies its topup multiplier and the configured
   * amount-tier discount. Called inside the payment fulfillment transaction;
   * the first successful posting wins on replay (postVerifiedFunding is
   * idempotent per order), so a later group edit never reprices a fulfilled
   * order.
   *
   * F1: `options.tiers` overrides the constructor-injected amount-tier
   * discounts (the platform settings store resolves them store-first at call
   * time; deployments without the store keep the injected value).
   */
  async resolveTopupCredit(
    executor: SqlExecutor,
    input: { readonly tenantId: string; readonly paidMinorUnits: bigint; readonly currency: string },
    options: { readonly tiers?: readonly TopupAmountTier[] } = {},
  ): Promise<AppliedTopupConversion> {
    if (typeof input.tenantId !== 'string' || typeof input.paidMinorUnits !== 'bigint' || input.paidMinorUnits < 0n) {
      fail('INVALID_INPUT');
    }
    const result = await executor.query<Row>(
      `/* saas-billing-groups:topup */
       SELECT g.id, g.display_name,
              g.rate_multiplier_num, g.rate_multiplier_den,
              g.topup_multiplier_num, g.topup_multiplier_den,
              g.peak_enabled, g.peak_start, g.peak_end, g.peak_multiplier_num, g.peak_multiplier_den,
              g.model_pricing,
              g.rpm_limit, g.daily_limit_minor_units, g.weekly_limit_minor_units, g.monthly_limit_minor_units,
              g.profit_min_margin_num, g.profit_min_margin_den,
              g.profit_safety_buffer_num, g.profit_safety_buffer_den,
              g.claude_code_only, g.fallback_group_id, g.supported_model_scopes,
              g.status, g.created_at, g.updated_at
         FROM saas_tenants t
         JOIN saas_billing_groups g ON g.id = COALESCE(t.default_billing_group_id, 'default')
        WHERE t.id = $1
        LIMIT 2`,
      [input.tenantId],
    );
    if (!result.rows[0]) fail('GROUP_NOT_FOUND');
    const group = mapBillingGroupRow(result.rows[0]);
    if (group.status !== 'active') fail('GROUP_INACTIVE');
    return computeTopupCredit({
      paidMinorUnits: input.paidMinorUnits,
      topupMultiplier: group.topupMultiplier,
      tiers: options.tiers ?? this.topupTiers,
    });
  }

  private async requireGroup(tx: SqlExecutor, groupId: string): Promise<void> {
    const result = await tx.query<Row>(`SELECT id FROM saas_billing_groups WHERE id = $1 LIMIT 2`, [groupId]);
    if (!result.rows[0]) fail('GROUP_NOT_FOUND');
  }

  private async lockFence(tx: SqlExecutor, keys: readonly string[]): Promise<void> {
    for (const key of [...keys].sort()) {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
    }
  }
}

function upsertValues(
  normalized: BillingGroupUpsertInput & { modelPricingJson: string },
  timestamp: string,
): unknown[] {
  return [
    normalized.id,
    normalized.displayName,
    normalized.rateMultiplier.numerator,
    normalized.rateMultiplier.denominator,
    normalized.topupMultiplier.numerator,
    normalized.topupMultiplier.denominator,
    normalized.peakEnabled,
    normalized.peakEnabled ? normalized.peakStart : null,
    normalized.peakEnabled ? normalized.peakEnd : null,
    normalized.peakEnabled && normalized.peakMultiplier ? normalized.peakMultiplier.numerator : null,
    normalized.peakEnabled && normalized.peakMultiplier ? normalized.peakMultiplier.denominator : null,
    normalized.modelPricingJson,
    normalized.rpmLimit,
    normalized.dailyLimitMinorUnits,
    normalized.weeklyLimitMinorUnits,
    normalized.monthlyLimitMinorUnits,
    normalized.profitMinMargin ? normalized.profitMinMargin.numerator : null,
    normalized.profitMinMargin ? normalized.profitMinMargin.denominator : null,
    normalized.profitSafetyBuffer ? normalized.profitSafetyBuffer.numerator : null,
    normalized.profitSafetyBuffer ? normalized.profitSafetyBuffer.denominator : null,
    normalized.claudeCodeOnly,
    normalized.fallbackGroupId,
    normalized.supportedModelScopes === null ? null : [...normalized.supportedModelScopes],
    normalized.status,
    timestamp,
    timestamp,
  ];
}
