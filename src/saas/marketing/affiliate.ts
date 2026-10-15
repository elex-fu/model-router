import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';

/**
 * Track R2/G3 affiliate rebates (design: docs/remaining-capability-plan-2026-10-11.md
 * R2, G0 freeze docs/marketing-domain-design-2026-10-11.md §6, migration 091).
 *
 * Attribution is lifetime-immutable: an invitee tenant binds at most one
 * inviter tenant, self-invites and cycles are refused inside the bind
 * transaction, and the row never changes afterwards (migration trigger).
 * Binds serialize on a domain-wide transaction advisory lock so two
 * concurrent binds can never close a cycle (A->B while B->A).
 *
 * Rewards accrue at the invitee's wallet top-up fulfillment terminal through
 * the WalletFundingHook seam (contract C-6): the hook runs inside the
 * fulfillment transaction, posts into the inviter's platform wallet through
 * the shared postVerifiedFunding primitive (namespace marketing.affiliate,
 * business key <source funding ref>:<inviter tenant id>) and appends the
 * reward row with the policy basis points snapshotted, so later policy
 * changes never rewrite history. Replay (inbox retry after a rolled-back
 * attempt) is idempotent: the ledger posting replays by natural key and the
 * reward insert is ON CONFLICT DO NOTHING on source_funding_ref. Any hook
 * failure propagates so fulfillment stays retryable — accrual is
 * fail-closed, never silently skipped.
 *
 * Invite codes are derived, never stored in a code table: each code is a
 * 16-character RFC4648-base32 token = 8-char verification segment
 * (base32(sha256('affiliate-invite-v1' | tenant id | deployment salt))[0:8])
 * + 8-char locator segment (base32 of the tenant uuid's last 5 bytes).
 * Binding resolves the locator to the candidate tenant(s) by uuid suffix and
 * verifies the full derived code, so a presented code can be checked without
 * enumerating tenants and cannot be transplanted onto another tenant. Codes
 * are public referral material, not credentials; the salt is a
 * deployment-level non-secret constant injected at construction.
 */

export type MarketingAffiliateErrorCode =
  | 'AFFILIATE_INVALID_INPUT'
  | 'AFFILIATE_INVITE_CODE_INVALID'
  | 'AFFILIATE_SELF_INVITE'
  | 'AFFILIATE_CYCLE'
  | 'AFFILIATE_ALREADY_BOUND'
  | 'AFFILIATE_POLICY_VERSION_CONFLICT'
  | 'AFFILIATE_FORBIDDEN'
  | 'AFFILIATE_STORAGE_ERROR';

export class MarketingAffiliateError extends Error {
  constructor(
    readonly code: MarketingAffiliateErrorCode,
    message = 'Marketing affiliate operation failed',
  ) {
    super(message);
    this.name = 'MarketingAffiliateError';
  }
}

/** Narrow ledger port; implemented by PlatformWalletLedgerService. */
export interface MarketingAffiliateFundingLedger {
  postVerifiedFunding(
    executor: SqlExecutor,
    input: {
      tenantId: string;
      currency: string;
      amountMinorUnits: string;
      sourceOrderRef: string;
      idempotencyKey: string;
      idempotencyNamespace: string;
      metadataRef: string;
    },
  ): Promise<{ outcome: 'posted'; replayed: boolean; transactionId: string }>;
}

export const MARKETING_AFFILIATE_IDEMPOTENCY_NAMESPACE = 'marketing.affiliate' as const;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const INVITE_CODE_DOMAIN = 'affiliate-invite-v1';
const INVITE_CODE = /^[A-Z2-7]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MINOR_UNITS = /^[0-9]{1,20}$/;
const MAX_REF_LENGTH = 255;
const MAX_CYCLE_DEPTH = 32;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const POLICY_COLUMNS = 'id, reward_bp, enabled, version, updated_by_user_id, created_at, updated_at';
const REWARD_COLUMNS =
  'id, inviter_tenant_id, invitee_tenant_id, source_funding_ref, source_amount_minor_units, reward_amount_minor_units, currency, reward_bp_snapshot, ledger_transaction_id, created_at';
/** Serializes all binds so concurrent attributions can never close a cycle. */
const BIND_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('marketing.affiliate.bind'))`;

/** RFC4648 base32 without padding; the alphabet is a subset of the migration CHECK's [A-Z2-9]. */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of text) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

function tenantUuidBytes(tenantId: string): Uint8Array {
  return Uint8Array.from(Buffer.from(tenantId.replace(/-/g, ''), 'hex'));
}

/** Derive a tenant's public invite code; pure and deterministic per (tenant, salt). */
export function deriveAffiliateInviteCode(tenantId: string, inviteCodeSalt: string): string {
  const digest = createHash('sha256').update(`${INVITE_CODE_DOMAIN}:${tenantId}:${inviteCodeSalt}`, 'utf8').digest();
  const verification = base32Encode(digest.subarray(0, 5));
  const locator = base32Encode(tenantUuidBytes(tenantId).subarray(11, 16));
  return `${verification}${locator}`;
}

function requireUuid(value: unknown, code: MarketingAffiliateErrorCode = 'AFFILIATE_INVALID_INPUT'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new MarketingAffiliateError(code);
  return value;
}

function requireRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REF_LENGTH) {
    throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
  }
  return value;
}

function requireMinorUnits(raw: unknown): string {
  if (typeof raw !== 'string' || !MINOR_UNITS.test(raw) || /^0+$/.test(raw)) {
    throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
  }
  return raw.replace(/^0+(?=\d)/, '');
}

function requireCurrency(raw: unknown): string {
  if (typeof raw !== 'string' || !CURRENCY.test(raw)) throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
  return raw;
}

function requireLimit(raw: unknown): number {
  const limit = raw ?? DEFAULT_LIST_LIMIT;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
  }
  return limit;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** node-pg hands timestamptz back as Date; normalize instead of failing closed. */
function timestampText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

/** node-pg hands bigint back as string; the version counter stays well inside 2^53. */
function versionNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function countNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export interface AffiliatePolicyView {
  readonly rewardBp: number;
  readonly enabled: boolean;
  /** 0 denotes the defensive empty head: no policy row has ever been written. */
  readonly version: number;
  readonly updatedByUserId: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface AffiliateRewardView {
  readonly id: string;
  readonly inviterTenantId: string;
  readonly inviteeTenantId: string;
  readonly sourceFundingRef: string;
  readonly sourceAmountMinorUnits: string;
  readonly rewardAmountMinorUnits: string;
  readonly currency: string;
  readonly rewardBpSnapshot: number;
  readonly ledgerTransactionId: string | null;
  readonly createdAt: string;
}

export interface MyAffiliateView {
  readonly inviteCode: string;
  readonly invitedCount: number;
  readonly rewards: AffiliateRewardView[];
  readonly nextCursor: string | null;
}

export type BindInviterResult = {
  readonly outcome: 'bound' | 'replayed';
  readonly inviterTenantId: string;
};

interface PolicyRow extends Record<string, unknown> {
  id: string;
  reward_bp: number;
  enabled: boolean;
  version: string | number;
  updated_by_user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
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
  created_at: string | Date;
}

function mapPolicyRow(row: PolicyRow): AffiliatePolicyView {
  const version = versionNumber(row.version);
  const updatedByUserId = text(row.updated_by_user_id);
  const createdAt = timestampText(row.created_at);
  const updatedAt = timestampText(row.updated_at);
  if (
    row.id !== 'platform' ||
    typeof row.reward_bp !== 'number' ||
    !Number.isSafeInteger(row.reward_bp) ||
    row.reward_bp < 0 ||
    row.reward_bp > 5000 ||
    typeof row.enabled !== 'boolean' ||
    version === null ||
    !updatedByUserId ||
    !createdAt ||
    !updatedAt
  ) {
    throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');
  }
  return { rewardBp: row.reward_bp, enabled: row.enabled, version, updatedByUserId, createdAt, updatedAt };
}

function mapRewardRow(row: RewardRow): AffiliateRewardView {
  const id = text(row.id);
  const inviterTenantId = text(row.inviter_tenant_id);
  const inviteeTenantId = text(row.invitee_tenant_id);
  const sourceFundingRef = text(row.source_funding_ref);
  const sourceAmountMinorUnits = text(row.source_amount_minor_units);
  const rewardAmountMinorUnits = text(row.reward_amount_minor_units);
  const currency = text(row.currency);
  const createdAt = timestampText(row.created_at);
  if (
    !id ||
    !inviterTenantId ||
    !inviteeTenantId ||
    !sourceFundingRef ||
    !sourceAmountMinorUnits ||
    !rewardAmountMinorUnits ||
    !currency ||
    typeof row.reward_bp_snapshot !== 'number' ||
    !createdAt
  ) {
    throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');
  }
  return {
    id,
    inviterTenantId,
    inviteeTenantId,
    sourceFundingRef,
    sourceAmountMinorUnits,
    rewardAmountMinorUnits,
    currency,
    rewardBpSnapshot: row.reward_bp_snapshot,
    ledgerTransactionId: text(row.ledger_transaction_id),
    createdAt,
  };
}

function decodeCursor(raw: unknown): { createdAt: string; id: string } | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [createdAt, id] = decoded.split('|');
  if (
    typeof createdAt !== 'string' ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof id !== 'string' ||
    !UUID.test(id)
  ) {
    throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
  }
  return { createdAt, id };
}

function encodeCursor(reward: AffiliateRewardView): string {
  return Buffer.from(`${reward.createdAt}|${reward.id}`, 'utf8').toString('base64url');
}

export interface MarketingAffiliateServiceOptions {
  readonly database: SaasDatabase;
  readonly fundingLedger: MarketingAffiliateFundingLedger;
  /** Deployment-level non-secret constant; domain-separates invite code derivation. */
  readonly inviteCodeSalt: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class MarketingAffiliateService {
  private readonly database: SaasDatabase;
  private readonly fundingLedger: MarketingAffiliateFundingLedger;
  private readonly inviteCodeSalt: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: MarketingAffiliateServiceOptions) {
    if (
      typeof options.inviteCodeSalt !== 'string' ||
      options.inviteCodeSalt.length === 0 ||
      options.inviteCodeSalt.length > 256
    ) {
      throw new TypeError('inviteCodeSalt must be a bounded non-empty string');
    }
    this.database = options.database;
    this.fundingLedger = options.fundingLedger;
    this.inviteCodeSalt = options.inviteCodeSalt;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  /** The tenant's own public invite code; derived, never stored. */
  inviteCodeFor(tenantId: string): string {
    return deriveAffiliateInviteCode(requireUuid(tenantId), this.inviteCodeSalt);
  }

  private async audit(
    executor: SqlExecutor,
    event: {
      action: string;
      actorUserId: string | null;
      tenantId: string | null;
      targetType: string;
      targetId: string;
    },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO model_router_saas.saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'platform_marketing')`,
      [
        this.idFactory(),
        event.tenantId,
        event.actorUserId,
        event.action,
        event.targetType,
        event.targetId,
        this.now().toISOString(),
      ],
    );
  }

  /**
   * Resolve a presented invite code to its inviter tenant. The locator
   * segment narrows candidates by uuid suffix; the full derived code must
   * then match in constant time, so a code can never be transplanted onto
   * another tenant. Only active tenants resolve.
   */
  private async resolveInviter(executor: SqlExecutor, code: string): Promise<string | null> {
    const locator = base32Decode(code.slice(8));
    if (locator === null || locator.length !== 5) throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
    const hexSuffix = Buffer.from(locator).toString('hex');
    const candidates = await executor.query<{ id: string }>(
      `SELECT id FROM model_router_saas.saas_tenants
        WHERE status = 'active' AND right(replace(id::text, '-', ''), 10) = $1`,
      [hexSuffix],
    );
    const expected = Buffer.from(code, 'utf8');
    for (const candidate of candidates.rows) {
      const id = text(candidate.id);
      if (id === null || !UUID.test(id)) throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');
      const derived = Buffer.from(deriveAffiliateInviteCode(id, this.inviteCodeSalt), 'utf8');
      if (derived.length === expected.length && timingSafeEqual(derived, expected)) return id;
    }
    return null;
  }

  private async findAttribution(
    executor: SqlExecutor,
    inviteeTenantId: string,
  ): Promise<{ inviterTenantId: string; inviteCode: string } | null> {
    const result = await executor.query<{ inviter_tenant_id: string; invite_code: string }>(
      `SELECT inviter_tenant_id, invite_code
         FROM model_router_saas.saas_marketing_affiliate_attributions
        WHERE invitee_tenant_id = $1`,
      [inviteeTenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const inviterTenantId = text(row.inviter_tenant_id);
    const inviteCode = text(row.invite_code);
    if (!inviterTenantId || !inviteCode) throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');
    return { inviterTenantId, inviteCode };
  }

  /**
   * Customer-side binding of the caller's tenant to the invite code's owner.
   * The transaction holds the domain bind lock, so the cycle walk observes
   * every committed attribution and no concurrent bind can close a cycle
   * behind it. Repeating the same bind is an idempotent replay; a different
   * inviter is refused because attribution is lifetime-immutable.
   */
  async bindInviter(
    context: { tenantId: string; userId: string },
    input: { inviteCode: unknown },
  ): Promise<BindInviterResult> {
    const tenantId = requireUuid(context.tenantId);
    const userId = requireUuid(context.userId);
    if (typeof input.inviteCode !== 'string') throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
    const code = input.inviteCode.trim().toUpperCase();
    if (!INVITE_CODE.test(code)) throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');

    return this.database.transaction(async (executor) => {
      await executor.query(`SET LOCAL lock_timeout = '2s'`);
      await executor.query(`SET LOCAL statement_timeout = '10s'`);
      await executor.query(BIND_LOCK_SQL);

      const existing = await this.findAttribution(executor, tenantId);
      const inviterTenantId = await this.resolveInviter(executor, code);
      if (inviterTenantId === null) throw new MarketingAffiliateError('AFFILIATE_INVITE_CODE_INVALID');
      if (existing) {
        if (existing.inviterTenantId === inviterTenantId) {
          return { outcome: 'replayed' as const, inviterTenantId };
        }
        throw new MarketingAffiliateError('AFFILIATE_ALREADY_BOUND');
      }
      if (inviterTenantId === tenantId) throw new MarketingAffiliateError('AFFILIATE_SELF_INVITE');

      // Cycle walk: inserting invitee -> inviter closes a cycle exactly when
      // the invitee is reachable from the inviter along the inviter chain.
      // Chains deeper than the bound fail closed.
      const visited = new Set<string>([tenantId]);
      let current = inviterTenantId;
      for (let depth = 0; depth <= MAX_CYCLE_DEPTH; depth += 1) {
        if (visited.has(current)) throw new MarketingAffiliateError('AFFILIATE_CYCLE');
        visited.add(current);
        const upstream = await this.findAttribution(executor, current);
        if (upstream === null) {
          await executor.query(
            `INSERT INTO model_router_saas.saas_marketing_affiliate_attributions
               (invitee_tenant_id, inviter_tenant_id, invite_code, created_at)
             VALUES ($1, $2, $3, $4)`,
            [tenantId, inviterTenantId, code, this.now().toISOString()],
          );
          await this.audit(executor, {
            action: 'marketing.affiliate.bound',
            actorUserId: userId,
            tenantId,
            targetType: 'marketing_affiliate_attribution',
            targetId: tenantId,
          });
          return { outcome: 'bound' as const, inviterTenantId };
        }
        current = upstream.inviterTenantId;
      }
      throw new MarketingAffiliateError('AFFILIATE_CYCLE');
    });
  }

  /**
   * R4 registration admission gate: resolve an invite code to its inviter
   * tenant without binding. Pure read; the code must be shape-valid or it
   * resolves to null (the registration surface treats a shape failure the
   * same as an unknown code — no existence oracle beyond "resolvable").
   */
  async resolveInviteCode(code: string): Promise<string | null> {
    if (typeof code !== 'string') throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
    const normalized = code.trim().toUpperCase();
    if (!INVITE_CODE.test(normalized)) return null;
    return this.resolveInviter(this.database, normalized);
  }

  /** Customer view: own invite code, attribution count and keyset-paged rewards. */
  async getMyAffiliate(
    context: { tenantId: string; userId: string },
    input: { limit?: unknown; cursor?: unknown } = {},
  ): Promise<MyAffiliateView> {
    const tenantId = requireUuid(context.tenantId);
    requireUuid(context.userId);
    const limit = requireLimit(input.limit);
    const cursor = decodeCursor(input.cursor);

    const counts = await this.database.query<{ invited_count: string }>(
      `SELECT count(*)::text AS invited_count
         FROM model_router_saas.saas_marketing_affiliate_attributions
        WHERE inviter_tenant_id = $1`,
      [tenantId],
    );
    const invitedCount = countNumber(counts.rows[0]?.invited_count);
    if (invitedCount === null) throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');

    const rows = await this.database.query<RewardRow>(
      `SELECT ${REWARD_COLUMNS} FROM model_router_saas.saas_marketing_affiliate_rewards
        WHERE inviter_tenant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const page = rows.rows.slice(0, limit).map(mapRewardRow);
    const last = page.at(-1);
    const nextCursor = rows.rows.length > limit && last ? encodeCursor(last) : null;
    return { inviteCode: this.inviteCodeFor(tenantId), invitedCount, rewards: page, nextCursor };
  }

  /** Operations-side policy read; a missing head row reads as the disabled v0 default. */
  async getAffiliatePolicy(actor: { userId: string }): Promise<AffiliatePolicyView> {
    requireUuid(actor.userId, 'AFFILIATE_FORBIDDEN');
    const result = await this.database.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM model_router_saas.saas_marketing_affiliate_policies WHERE id = 'platform'`,
      [],
    );
    const row = result.rows[0];
    if (!row) {
      return { rewardBp: 0, enabled: false, version: 0, updatedByUserId: null, createdAt: null, updatedAt: null };
    }
    return mapPolicyRow(row);
  }

  /**
   * Operations-side policy replacement with CAS. The first write requires
   * expectedVersion 0 and inserts the singleton head at version 1; later
   * writes must name the current version, and the migration guard trigger
   * enforces the exact +1 advance. The audit row commits with the write.
   */
  async replaceAffiliatePolicy(
    actor: { userId: string },
    input: { rewardBp: unknown; enabled: unknown; expectedVersion: unknown },
  ): Promise<AffiliatePolicyView> {
    const actorId = requireUuid(actor.userId, 'AFFILIATE_FORBIDDEN');
    if (
      typeof input.rewardBp !== 'number' ||
      !Number.isSafeInteger(input.rewardBp) ||
      input.rewardBp < 0 ||
      input.rewardBp > 5000 ||
      typeof input.enabled !== 'boolean' ||
      typeof input.expectedVersion !== 'number' ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      throw new MarketingAffiliateError('AFFILIATE_INVALID_INPUT');
    }
    const { rewardBp, enabled, expectedVersion } = input;

    return this.database.transaction(async (executor) => {
      const locked = await executor.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS} FROM model_router_saas.saas_marketing_affiliate_policies
          WHERE id = 'platform' FOR UPDATE`,
        [],
      );
      const current = locked.rows[0];
      if (!current) {
        if (expectedVersion !== 0) throw new MarketingAffiliateError('AFFILIATE_POLICY_VERSION_CONFLICT');
        const inserted = await executor.query<PolicyRow>(
          `INSERT INTO model_router_saas.saas_marketing_affiliate_policies
             (id, reward_bp, enabled, version, updated_by_user_id, created_at, updated_at)
           VALUES ('platform', $1, $2, 1, $3, $4, $4)
           RETURNING ${POLICY_COLUMNS}`,
          [rewardBp, enabled, actorId, this.now().toISOString()],
        );
        const row = inserted.rows[0];
        if (!row) throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');
        const view = mapPolicyRow(row);
        await this.audit(executor, {
          action: 'marketing.affiliate_policy.replaced',
          actorUserId: actorId,
          tenantId: null,
          targetType: 'marketing_affiliate_policy',
          targetId: 'platform',
        });
        return view;
      }
      const head = mapPolicyRow(current);
      if (head.version !== expectedVersion) {
        throw new MarketingAffiliateError('AFFILIATE_POLICY_VERSION_CONFLICT');
      }
      const updated = await executor.query<PolicyRow>(
        `UPDATE model_router_saas.saas_marketing_affiliate_policies
            SET reward_bp = $1, enabled = $2, version = version + 1, updated_by_user_id = $3, updated_at = $4
          WHERE id = 'platform' AND version = $5
          RETURNING ${POLICY_COLUMNS}`,
        [rewardBp, enabled, actorId, this.now().toISOString(), expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new MarketingAffiliateError('AFFILIATE_POLICY_VERSION_CONFLICT');
      const view = mapPolicyRow(row);
      await this.audit(executor, {
        action: 'marketing.affiliate_policy.replaced',
        actorUserId: actorId,
        tenantId: null,
        targetType: 'marketing_affiliate_policy',
        targetId: 'platform',
      });
      return view;
    });
  }

  /** Operations-side reward listing with keyset pagination and an optional inviter filter. */
  async listRewards(
    actor: { userId: string },
    input: { inviterTenantId?: unknown; limit?: unknown; cursor?: unknown } = {},
  ): Promise<{ rewards: AffiliateRewardView[]; nextCursor: string | null }> {
    requireUuid(actor.userId, 'AFFILIATE_FORBIDDEN');
    const inviterTenantId = input.inviterTenantId === undefined ? null : requireUuid(input.inviterTenantId);
    const limit = requireLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = await this.database.query<RewardRow>(
      `SELECT ${REWARD_COLUMNS} FROM model_router_saas.saas_marketing_affiliate_rewards
        WHERE ($1::uuid IS NULL OR inviter_tenant_id = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [inviterTenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const page = rows.rows.slice(0, limit).map(mapRewardRow);
    const last = page.at(-1);
    const nextCursor = rows.rows.length > limit && last ? encodeCursor(last) : null;
    return { rewards: page, nextCursor };
  }

  /**
   * WalletFundingHook port (R2, contract C-6). Runs inside the payment
   * fulfillment transaction after the verified funding posting. No
   * attribution, a missing/disabled policy, bp = 0 or a floor-to-zero reward
   * are all zero side effects. Otherwise the reward posts into the inviter's
   * wallet under namespace marketing.affiliate (business key
   * <source funding ref>:<inviter tenant id>) and the append-only reward row
   * snapshots the policy basis points. Replay is idempotent by construction;
   * any failure propagates so fulfillment stays retryable (fail-closed).
   */
  async afterVerifiedFunding(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly currency: string;
      readonly amountMinorUnits: string;
      readonly sourceOrderRef: string;
      readonly fundingTransactionId: string;
    },
  ): Promise<void> {
    const tenantId = requireUuid(input.tenantId);
    const currency = requireCurrency(input.currency);
    const amountMinorUnits = requireMinorUnits(input.amountMinorUnits);
    const sourceOrderRef = requireRef(input.sourceOrderRef);
    requireRef(input.fundingTransactionId);

    const attribution = await this.findAttribution(executor, tenantId);
    if (attribution === null) return;

    const locked = await executor.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM model_router_saas.saas_marketing_affiliate_policies
        WHERE id = 'platform' FOR UPDATE`,
      [],
    );
    const policyRow = locked.rows[0];
    if (!policyRow) return;
    const policy = mapPolicyRow(policyRow);
    if (!policy.enabled || policy.rewardBp === 0) return;

    const reward = (BigInt(amountMinorUnits) * BigInt(policy.rewardBp)) / 10_000n;
    if (reward === 0n) return;

    const posting = await this.fundingLedger.postVerifiedFunding(executor, {
      tenantId: attribution.inviterTenantId,
      currency,
      amountMinorUnits: reward.toString(),
      sourceOrderRef,
      idempotencyKey: `${sourceOrderRef}:${attribution.inviterTenantId}`,
      idempotencyNamespace: MARKETING_AFFILIATE_IDEMPOTENCY_NAMESPACE,
      metadataRef: `affiliate-reward:${sourceOrderRef}`,
    });
    if (posting.outcome !== 'posted') throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');

    const inserted = await executor.query<{ id: string }>(
      `INSERT INTO model_router_saas.saas_marketing_affiliate_rewards
         (id, inviter_tenant_id, invitee_tenant_id, source_funding_ref, source_amount_minor_units,
          reward_amount_minor_units, currency, reward_bp_snapshot, ledger_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_funding_ref) DO NOTHING
       RETURNING id`,
      [
        this.idFactory(),
        attribution.inviterTenantId,
        tenantId,
        sourceOrderRef,
        amountMinorUnits,
        reward.toString(),
        currency,
        policy.rewardBp,
        posting.transactionId,
        this.now().toISOString(),
      ],
    );
    const rewardId = inserted.rows[0]?.id;
    if (!rewardId) return; // replay: the reward row already exists, zero new side effects
    await this.audit(executor, {
      action: 'marketing.affiliate.reward_accrued',
      actorUserId: null,
      tenantId: attribution.inviterTenantId,
      targetType: 'marketing_affiliate_reward',
      targetId: rewardId,
    });
  }
}
