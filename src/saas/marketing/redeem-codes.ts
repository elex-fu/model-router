import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { isServicePlanError } from '../plans/errors.js';

/**
 * Track G1 redeem codes (design: docs/marketing-domain-design-2026-10-11.md,
 * contract C-6). Balance-type codes redeem into the platform wallet through
 * the shared postVerifiedFunding hook (namespace marketing.redeem,
 * business key <code id>:<tenant id>), so a redemption is exactly-once by
 * construction (locked CAS + UNIQUE(code_id) + ledger idempotency).
 * Subscription-type codes (G1.5) redeem through the plans service's
 * grantMarketingSubscription port inside the same locked transaction: the
 * grant is idempotent by the code id, never touches the wallet ledger, and
 * the redemption row carries ledger_transaction_id = NULL. Any grant
 * failure rolls the whole redemption back, leaving the code active.
 * REDEEM_KIND_UNSUPPORTED is retained purely as the unknown-kind defense.
 *
 * The plaintext code exists only in the generation response; storage is the
 * sha256 of the normalized code plus a short display prefix.
 */

export type MarketingRedeemErrorCode =
  | 'REDEEM_INVALID_INPUT'
  | 'REDEEM_CODE_INVALID'
  | 'REDEEM_CODE_STATE_CONFLICT'
  | 'REDEEM_KIND_UNSUPPORTED'
  | 'REDEEM_FORBIDDEN'
  | 'REDEEM_STORAGE_ERROR';

export class MarketingRedeemError extends Error {
  constructor(
    readonly code: MarketingRedeemErrorCode,
    message = 'Marketing redeem operation failed',
  ) {
    super(message);
    this.name = 'MarketingRedeemError';
  }
}

export interface MarketingFundingLedger {
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

export const MARKETING_REDEEM_IDEMPOTENCY_NAMESPACE = 'marketing.redeem' as const;

/**
 * Plans-side subscription grant port (G1.5). Both methods participate in the
 * caller's transaction: the grant runs inside the redeem code's locked CAS
 * transaction so the code transition, the redemption row and the plan grant
 * commit or roll back together. The port is idempotent by grantRef (the
 * redeem code id), which makes replay reads possible without storing a
 * subscription reference on the redemption row.
 */
export interface MarketingSubscriptionGrantPort {
  grantMarketingSubscription(
    executor: SqlExecutor,
    input: {
      tenantId: string;
      userId: string;
      servicePlanVersionId: string;
      /** Redeem code id; the grant's idempotency natural key. */
      grantRef: string;
    },
  ): Promise<{
    subscriptionId: string;
    entitlementId: string;
    expiresAt: string;
    replayed: boolean;
  }>;
  /** Generation-time validation: the plan version must be published and purchasable. */
  assertMarketingGrantPlanVersion(executor: SqlExecutor, servicePlanVersionId: string): Promise<void>;
}

/**
 * Maps a plans-service failure to a redeem refusal. Business conflicts the
 * customer can reason about (plan version retired, an active subscription
 * already in place, the supply profile unavailable) collapse to the shared
 * state conflict; anything else is a storage fault. The caller's transaction
 * rolls back either way, so a failed grant never strands a redeemed code.
 */
function mapPlansGrantError(error: unknown, conflictCode: MarketingRedeemErrorCode): MarketingRedeemError {
  if (
    isServicePlanError(error) &&
    (error.code === 'ACTIVE_SUBSCRIPTION_EXISTS' ||
      error.code === 'PLAN_VERSION_UNAVAILABLE' ||
      error.code === 'ENTITLEMENT_UNAVAILABLE')
  ) {
    return new MarketingRedeemError(conflictCode);
  }
  return new MarketingRedeemError('REDEEM_STORAGE_ERROR');
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_BODY_LENGTH = 20;
const HASH = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MINOR_UNITS = /^[0-9]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_GENERATE_COUNT = 100;

export function normalizeRedeemCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
  const normalized = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (normalized.length < 12 || normalized.length > 64) throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
  return normalized;
}

export function redeemCodeHash(normalizedCode: string): string {
  return createHash('sha256').update(normalizedCode, 'utf8').digest('hex');
}

function generatePlaintextCode(): string {
  const bytes = randomBytes(CODE_BODY_LENGTH);
  let body = '';
  for (let index = 0; index < CODE_BODY_LENGTH; index += 1) {
    body += CODE_ALPHABET[(bytes[index] as number) % CODE_ALPHABET.length];
  }
  return `${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16)}`;
}

function requireUuid(value: unknown, code: MarketingRedeemErrorCode = 'REDEEM_INVALID_INPUT'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new MarketingRedeemError(code);
  return value;
}

function requireMinorUnits(raw: unknown): string {
  if (typeof raw !== 'string' || !MINOR_UNITS.test(raw) || /^0+$/.test(raw)) {
    throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
  }
  return raw.replace(/^0+(?=\d)/, '');
}

function requireCurrency(raw: unknown): string {
  if (typeof raw !== 'string' || !CURRENCY.test(raw)) throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
  return raw;
}

export interface RedeemCodeView {
  readonly id: string;
  readonly codePrefix: string;
  readonly kind: 'balance' | 'subscription';
  readonly amountMinorUnits: string | null;
  readonly currency: string | null;
  readonly servicePlanVersionId: string | null;
  readonly status: 'active' | 'redeemed' | 'disabled';
  readonly batchRef: string;
  readonly createdAt: string;
  readonly redeemedByTenantId: string | null;
  readonly redeemedAt: string | null;
  readonly disabledAt: string | null;
}

interface CodeRow extends Record<string, unknown> {
  id: string;
  code_prefix: string;
  kind: string;
  amount_minor_units: string | null;
  currency: string | null;
  service_plan_version_id: string | null;
  status: string;
  batch_ref: string;
  created_at: string | Date;
  redeemed_by_tenant_id: string | null;
  redeemed_at: string | Date | null;
  disabled_at: string | Date | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** node-pg hands timestamptz back as Date; normalize instead of failing closed. */
function timestampText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

function mapCodeRow(row: CodeRow): RedeemCodeView {
  const id = text(row.id);
  const codePrefix = text(row.code_prefix);
  const kind = text(row.kind);
  const status = text(row.status);
  const batchRef = text(row.batch_ref);
  const createdAt = timestampText(row.created_at);
  if (
    !id ||
    !codePrefix ||
    (kind !== 'balance' && kind !== 'subscription') ||
    !batchRef ||
    !createdAt ||
    (status !== 'active' && status !== 'redeemed' && status !== 'disabled')
  ) {
    throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
  }
  return {
    id,
    codePrefix,
    kind,
    amountMinorUnits: text(row.amount_minor_units),
    currency: text(row.currency),
    servicePlanVersionId: text(row.service_plan_version_id),
    status,
    batchRef,
    createdAt,
    redeemedByTenantId: text(row.redeemed_by_tenant_id),
    redeemedAt: timestampText(row.redeemed_at),
    disabledAt: timestampText(row.disabled_at),
  };
}

const CODE_COLUMNS =
  'id, code_prefix, kind, amount_minor_units, currency, service_plan_version_id, status, batch_ref, created_at, redeemed_by_tenant_id, redeemed_at, disabled_at';

export interface MarketingRedeemServiceOptions {
  readonly database: SaasDatabase;
  readonly fundingLedger: MarketingFundingLedger;
  readonly subscriptionGrants: MarketingSubscriptionGrantPort;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export type RedeemResult =
  | {
      readonly outcome: 'redeemed' | 'replayed';
      readonly kind: 'balance';
      readonly codeId: string;
      readonly amountMinorUnits: string;
      readonly currency: string;
      readonly ledgerTransactionId: string;
    }
  | {
      readonly outcome: 'redeemed' | 'replayed';
      readonly kind: 'subscription';
      readonly codeId: string;
      readonly servicePlanVersionId: string;
      readonly subscriptionId: string;
      readonly entitlementId: string;
      readonly expiresAt: string;
    };

export class MarketingRedeemCodeService {
  private readonly database: SaasDatabase;
  private readonly fundingLedger: MarketingFundingLedger;
  private readonly subscriptionGrants: MarketingSubscriptionGrantPort;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: MarketingRedeemServiceOptions) {
    this.database = options.database;
    this.fundingLedger = options.fundingLedger;
    this.subscriptionGrants = options.subscriptionGrants;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  private async audit(
    executor: SqlExecutor,
    event: { action: string; actorUserId: string; tenantId: string | null; targetId: string },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO model_router_saas.saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, $2, $3, $4, 'marketing_redeem_code', $5, $6, 'platform_marketing')`,
      [this.idFactory(), event.tenantId, event.actorUserId, event.action, event.targetId, this.now().toISOString()],
    );
  }

  /** Operations-side batch generation. Plaintext codes are returned exactly once. */
  async generateBalanceCodes(
    actor: { userId: string },
    input: { count: number; amountMinorUnits: string; currency: string; batchRef?: string },
  ): Promise<{ batchRef: string; codes: string[] }> {
    const amountMinorUnits = requireMinorUnits(input.amountMinorUnits);
    const currency = requireCurrency(input.currency);
    return this.generateCodes(
      actor,
      input.count,
      input.batchRef,
      async (executor, _code, normalized, batchRef, actorId) => {
        const result = await executor.query(
          `INSERT INTO model_router_saas.saas_marketing_redeem_codes
           (id, code_hash, code_prefix, kind, amount_minor_units, currency, batch_ref, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'balance', $4, $5, $6, $7, $8, $8)
         ON CONFLICT (code_hash) DO NOTHING
         RETURNING id`,
          [
            this.idFactory(),
            redeemCodeHash(normalized),
            normalized.slice(0, 4),
            amountMinorUnits,
            currency,
            batchRef,
            actorId,
            this.now().toISOString(),
          ],
        );
        return result.rowCount === 1;
      },
    );
  }

  /**
   * Operations-side batch generation of subscription codes (G1.5). The plan
   * version is validated as published inside the batch transaction; codes
   * reference it and carry no wallet denomination.
   */
  async generateSubscriptionCodes(
    actor: { userId: string },
    input: { count: number; servicePlanVersionId: string; batchRef?: string },
  ): Promise<{ batchRef: string; codes: string[] }> {
    const servicePlanVersionId = requireUuid(input.servicePlanVersionId);
    return this.generateCodes(
      actor,
      input.count,
      input.batchRef,
      async (executor, _code, normalized, batchRef, actorId) => {
        const result = await executor.query(
          `INSERT INTO model_router_saas.saas_marketing_redeem_codes
           (id, code_hash, code_prefix, kind, service_plan_version_id, batch_ref, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'subscription', $4, $5, $6, $7, $7)
         ON CONFLICT (code_hash) DO NOTHING
         RETURNING id`,
          [
            this.idFactory(),
            redeemCodeHash(normalized),
            normalized.slice(0, 4),
            servicePlanVersionId,
            batchRef,
            actorId,
            this.now().toISOString(),
          ],
        );
        return result.rowCount === 1;
      },
      servicePlanVersionId,
    );
  }

  private async generateCodes(
    actor: { userId: string },
    count: number,
    requestedBatchRef: string | undefined,
    insertCode: (
      executor: SqlExecutor,
      code: string,
      normalized: string,
      batchRef: string,
      actorId: string,
    ) => Promise<boolean>,
    servicePlanVersionId?: string,
  ): Promise<{ batchRef: string; codes: string[] }> {
    const actorId = requireUuid(actor.userId, 'REDEEM_FORBIDDEN');
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_GENERATE_COUNT) {
      throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
    }
    const batchRef =
      requestedBatchRef === undefined
        ? `redeem-${this.now().toISOString().slice(0, 10)}-${this.idFactory().slice(0, 8)}`
        : requestedBatchRef;
    if (!LABEL.test(batchRef)) throw new MarketingRedeemError('REDEEM_INVALID_INPUT');

    const plaintext: string[] = [];
    await this.database.transaction(async (executor) => {
      if (servicePlanVersionId !== undefined) {
        try {
          await this.subscriptionGrants.assertMarketingGrantPlanVersion(executor, servicePlanVersionId);
        } catch (error) {
          throw mapPlansGrantError(error, 'REDEEM_INVALID_INPUT');
        }
      }
      for (let index = 0; index < count; index += 1) {
        let inserted = false;
        for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
          const code = generatePlaintextCode();
          const normalized = normalizeRedeemCode(code);
          inserted = await insertCode(executor, code, normalized, batchRef, actorId);
          if (inserted) plaintext.push(code);
        }
        if (!inserted) throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
      }
      await this.audit(executor, {
        action: 'marketing.redeem_codes.generated',
        actorUserId: actorId,
        tenantId: null,
        targetId: batchRef,
      });
    });
    return { batchRef, codes: plaintext };
  }

  /** Operations-side disable. Only an active code can be disabled. */
  async disableCode(actor: { userId: string }, codeId: string): Promise<RedeemCodeView> {
    const actorId = requireUuid(actor.userId, 'REDEEM_FORBIDDEN');
    const id = requireUuid(codeId);
    return this.database.transaction(async (executor) => {
      const locked = await executor.query<CodeRow>(
        `SELECT ${CODE_COLUMNS} FROM model_router_saas.saas_marketing_redeem_codes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = locked.rows[0];
      if (!row) throw new MarketingRedeemError('REDEEM_CODE_INVALID');
      const current = mapCodeRow(row);
      if (current.status === 'disabled') return current;
      if (current.status !== 'active') throw new MarketingRedeemError('REDEEM_CODE_STATE_CONFLICT');
      const updated = await executor.query<CodeRow>(
        `UPDATE model_router_saas.saas_marketing_redeem_codes
            SET status = 'disabled', disabled_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'active'
          RETURNING ${CODE_COLUMNS}`,
        [id, this.now().toISOString()],
      );
      const disabled = updated.rows[0];
      if (!disabled) throw new MarketingRedeemError('REDEEM_CODE_STATE_CONFLICT');
      await this.audit(executor, {
        action: 'marketing.redeem_code.disabled',
        actorUserId: actorId,
        tenantId: null,
        targetId: id,
      });
      return mapCodeRow(disabled);
    });
  }

  /** Operations-side listing with keyset pagination; the hash never leaves the store. */
  async listCodes(
    actor: { userId: string },
    input: { batchRef?: string; status?: 'active' | 'redeemed' | 'disabled'; limit?: number; cursor?: string } = {},
  ): Promise<{ codes: RedeemCodeView[]; nextCursor: string | null }> {
    requireUuid(actor.userId, 'REDEEM_FORBIDDEN');
    const batchRef = input.batchRef === undefined ? null : input.batchRef;
    if (batchRef !== null && !LABEL.test(batchRef)) throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
    const status = input.status ?? null;
    if (status !== null && !['active', 'redeemed', 'disabled'].includes(status)) {
      throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (input.cursor !== undefined) {
      const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
      const [createdAt, id] = decoded.split('|');
      cursorCreatedAt = typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null;
      cursorId = typeof id === 'string' && UUID.test(id) ? id : null;
      if (cursorCreatedAt === null || cursorId === null) throw new MarketingRedeemError('REDEEM_INVALID_INPUT');
    }
    const rows = await this.database.query<CodeRow>(
      `SELECT ${CODE_COLUMNS} FROM model_router_saas.saas_marketing_redeem_codes
        WHERE ($1::text IS NULL OR batch_ref = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [batchRef, status, cursorCreatedAt, cursorId, limit + 1],
    );
    const page = rows.rows.slice(0, limit).map(mapCodeRow);
    const last = page.at(-1);
    const nextCursor =
      rows.rows.length > limit && last
        ? Buffer.from(`${last.createdAt}|${last.id}`, 'utf8').toString('base64url')
        : null;
    return { codes: page, nextCursor };
  }

  /** Customer-side redemption of a balance code. Replay-safe per code+tenant. */
  async redeem(context: { tenantId: string; userId: string }, input: { code: string }): Promise<RedeemResult> {
    const tenantId = requireUuid(context.tenantId);
    const userId = requireUuid(context.userId);
    const normalized = normalizeRedeemCode(input.code);
    const hash = redeemCodeHash(normalized);
    if (!HASH.test(hash)) throw new MarketingRedeemError('REDEEM_INVALID_INPUT');

    return this.database.transaction(async (executor) => {
      await executor.query(`SET LOCAL lock_timeout = '2s'`);
      await executor.query(`SET LOCAL statement_timeout = '10s'`);
      const locked = await executor.query<CodeRow>(
        `SELECT ${CODE_COLUMNS}, code_hash FROM model_router_saas.saas_marketing_redeem_codes WHERE code_hash = $1 FOR UPDATE`,
        [hash],
      );
      const row = locked.rows[0];
      // Unknown, disabled and foreign-redeemed codes share one refusal: the
      // existence of a code is never disclosed through distinct errors.
      if (!row) throw new MarketingRedeemError('REDEEM_CODE_INVALID');
      const code = mapCodeRow(row);
      if (code.status === 'redeemed') {
        if (code.redeemedByTenantId !== tenantId) throw new MarketingRedeemError('REDEEM_CODE_INVALID');
        const replay = await executor.query<{ id: string; ledger_transaction_id: string | null }>(
          `SELECT id, ledger_transaction_id FROM model_router_saas.saas_marketing_redeem_redemptions WHERE code_id = $1`,
          [code.id],
        );
        const replayRow = replay.rows[0];
        if (!replayRow) throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
        if (code.kind === 'subscription') {
          // The grant port is idempotent by code id, so the replay re-reads
          // the original grant instead of storing a subscription reference
          // on the redemption row.
          if (replayRow.ledger_transaction_id !== null || code.servicePlanVersionId === null) {
            throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
          }
          const grant = await this.grantSubscription(executor, code.id, code.servicePlanVersionId, tenantId, userId);
          if (!grant.replayed) throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
          return {
            outcome: 'replayed' as const,
            kind: 'subscription' as const,
            codeId: code.id,
            servicePlanVersionId: code.servicePlanVersionId,
            subscriptionId: grant.subscriptionId,
            entitlementId: grant.entitlementId,
            expiresAt: grant.expiresAt,
          };
        }
        if (typeof replayRow.ledger_transaction_id !== 'string') {
          throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
        }
        return {
          outcome: 'replayed' as const,
          kind: 'balance' as const,
          codeId: code.id,
          amountMinorUnits: code.amountMinorUnits as string,
          currency: code.currency as string,
          ledgerTransactionId: replayRow.ledger_transaction_id,
        };
      }
      if (code.status !== 'active') throw new MarketingRedeemError('REDEEM_CODE_INVALID');
      if (code.kind === 'balance' && (code.amountMinorUnits === null || code.currency === null)) {
        throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
      }
      if (code.kind === 'subscription' && code.servicePlanVersionId === null) {
        throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
      }

      const transitioned = await executor.query<CodeRow>(
        `UPDATE model_router_saas.saas_marketing_redeem_codes
            SET status = 'redeemed', redeemed_by_tenant_id = $2, redeemed_by_user_id = $3, redeemed_at = $4, updated_at = $4
          WHERE id = $1 AND status = 'active'
          RETURNING ${CODE_COLUMNS}`,
        [code.id, tenantId, userId, this.now().toISOString()],
      );
      if (transitioned.rowCount !== 1) throw new MarketingRedeemError('REDEEM_CODE_STATE_CONFLICT');

      if (code.kind === 'subscription') {
        // G1.5: the plans grant runs in this same locked transaction. Any
        // failure rolls the CAS back, leaving the code active; the wallet
        // ledger is never touched and the redemption row records NULL.
        const servicePlanVersionId = code.servicePlanVersionId as string;
        const grant = await this.grantSubscription(executor, code.id, servicePlanVersionId, tenantId, userId);
        if (grant.replayed) throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');
        await executor.query(
          `INSERT INTO model_router_saas.saas_marketing_redeem_redemptions
             (id, code_id, tenant_id, user_id, ledger_transaction_id, created_at)
           VALUES ($1, $2, $3, $4, NULL, $5)`,
          [this.idFactory(), code.id, tenantId, userId, this.now().toISOString()],
        );
        await this.audit(executor, {
          action: 'marketing.redeem.completed',
          actorUserId: userId,
          tenantId,
          targetId: code.id,
        });
        return {
          outcome: 'redeemed' as const,
          kind: 'subscription' as const,
          codeId: code.id,
          servicePlanVersionId,
          subscriptionId: grant.subscriptionId,
          entitlementId: grant.entitlementId,
          expiresAt: grant.expiresAt,
        };
      }
      // Unknown kinds stay fail-closed; the two stored kinds are handled above.
      if (code.kind !== 'balance') throw new MarketingRedeemError('REDEEM_KIND_UNSUPPORTED');

      const posting = await this.fundingLedger.postVerifiedFunding(executor, {
        tenantId,
        currency: code.currency as string,
        amountMinorUnits: code.amountMinorUnits as string,
        sourceOrderRef: code.id,
        idempotencyKey: `${code.id}:${tenantId}`,
        idempotencyNamespace: MARKETING_REDEEM_IDEMPOTENCY_NAMESPACE,
        metadataRef: code.batchRef,
      });
      if (posting.outcome !== 'posted') throw new MarketingRedeemError('REDEEM_STORAGE_ERROR');

      await executor.query(
        `INSERT INTO model_router_saas.saas_marketing_redeem_redemptions
           (id, code_id, tenant_id, user_id, ledger_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.idFactory(), code.id, tenantId, userId, posting.transactionId, this.now().toISOString()],
      );
      await this.audit(executor, {
        action: 'marketing.redeem.completed',
        actorUserId: userId,
        tenantId,
        targetId: code.id,
      });
      return {
        outcome: 'redeemed' as const,
        kind: 'balance' as const,
        codeId: code.id,
        amountMinorUnits: code.amountMinorUnits as string,
        currency: code.currency as string,
        ledgerTransactionId: posting.transactionId,
      };
    });
  }

  private async grantSubscription(
    executor: SqlExecutor,
    codeId: string,
    servicePlanVersionId: string,
    tenantId: string,
    userId: string,
  ): Promise<{ subscriptionId: string; entitlementId: string; expiresAt: string; replayed: boolean }> {
    try {
      return await this.subscriptionGrants.grantMarketingSubscription(executor, {
        tenantId,
        userId,
        servicePlanVersionId,
        grantRef: codeId,
      });
    } catch (error) {
      throw mapPlansGrantError(error, 'REDEEM_CODE_STATE_CONFLICT');
    }
  }
}
