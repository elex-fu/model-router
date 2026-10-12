import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { PaymentError } from '../payments/errors.js';
import type { WalletTopUpPromoEvaluator } from '../payments/types.js';

/**
 * R1/G2 promo codes (design: docs/remaining-capability-plan-2026-10-11.md,
 * migration 090). Promo codes are public-by-design campaign tokens (not
 * credentials), stored as normalized plaintext — deliberately different from
 * G1 redeem codes, which are bearer secrets stored irreversibly. A promo code
 * feeds exactly one seam: the wallet top-up checkout pricing snapshot. The
 * evaluator port runs inside the payment order transaction (locked code row +
 * usage insert + frozen discounted amount); the discounted amount is never
 * repriced afterwards and the pre-discount amount stays on the order so
 * client-request replay compares the customer's original input.
 *
 * No-oversell is structural: the code row is locked FOR UPDATE, the usage
 * count is read under that lock, and the usage insert is backed by
 * UNIQUE(order_id) plus the partial UNIQUE(code_id, tenant_id) index. Every
 * customer-side refusal (unknown, disabled, out of window, exhausted,
 * per-tenant repeat, currency mismatch, zero-priced result) collapses to
 * PROMO_CODE_INVALID so code existence/terms are never disclosed.
 *
 * A full amount_off clamp that would price an order at zero is refused:
 * saas_payment_orders.amount_minor_units is CHECK (amount > 0), so a
 * zero-priced order is not representable and must fail closed.
 */

export type MarketingPromoErrorCode =
  | 'PROMO_INVALID_INPUT'
  | 'PROMO_CODE_CONFLICT'
  | 'PROMO_CODE_NOT_FOUND'
  | 'PROMO_CODE_STATE_CONFLICT'
  | 'PROMO_FORBIDDEN'
  | 'PROMO_STORAGE_ERROR';

export class MarketingPromoError extends Error {
  constructor(
    readonly code: MarketingPromoErrorCode,
    message = 'Marketing promo operation failed',
  ) {
    super(message);
    this.name = 'MarketingPromoError';
  }
}

export type MarketingPromoCodeDatabase = Pick<SaasDatabase, 'query' | 'transaction'>;

const CODE = /^[A-Z0-9-]{4,32}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MINOR_UNITS = /^[0-9]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;
const INT4_MAX = 2_147_483_647;
const MAX_LIST_LIMIT = 100;
const MAX_TEXT_LENGTH = 255;

/** Normalizes a promo code for storage/lookup: trimmed, uppercased, format-checked. */
export function normalizePromoCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new MarketingPromoError('PROMO_INVALID_INPUT');
  const normalized = raw.trim().toUpperCase();
  if (!CODE.test(normalized)) throw new MarketingPromoError('PROMO_INVALID_INPUT');
  return normalized;
}

function requireUuid(value: unknown, code: MarketingPromoErrorCode = 'PROMO_INVALID_INPUT'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new MarketingPromoError(code);
  return value;
}

function requireMinorUnits(raw: unknown): string {
  if (typeof raw !== 'string' || !MINOR_UNITS.test(raw) || /^0+$/.test(raw)) {
    throw new MarketingPromoError('PROMO_INVALID_INPUT');
  }
  return raw.replace(/^0+(?=\d)/, '');
}

function requireCurrency(raw: unknown): string {
  if (typeof raw !== 'string' || !CURRENCY.test(raw)) throw new MarketingPromoError('PROMO_INVALID_INPUT');
  return raw;
}

function optionalTimestamp(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new MarketingPromoError('PROMO_INVALID_INPUT');
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new MarketingPromoError('PROMO_INVALID_INPUT');
  return new Date(parsed).toISOString();
}

function optionalMaxUses(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > INT4_MAX) {
    throw new MarketingPromoError('PROMO_INVALID_INPUT');
  }
  return raw;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export interface PromoCodeView {
  readonly id: string;
  readonly code: string;
  readonly kind: 'percent_off' | 'amount_off';
  readonly percentBp: number | null;
  readonly amountMinorUnits: string | null;
  readonly currency: string | null;
  readonly scope: 'wallet_topup';
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly maxUses: number | null;
  readonly perTenantOnce: boolean;
  readonly status: 'active' | 'disabled';
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
}

interface PromoCodeRow extends Record<string, unknown> {
  id: string;
  code: string;
  kind: string;
  percent_bp: number | null;
  amount_minor_units: string | null;
  currency: string | null;
  scope: string;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  max_uses: number | null;
  per_tenant_once: boolean;
  status: string;
  created_by_user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
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

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function mapPromoCodeRow(row: PromoCodeRow): PromoCodeView {
  const id = text(row.id);
  const code = text(row.code);
  const kind = text(row.kind);
  const scope = text(row.scope);
  const status = text(row.status);
  const createdByUserId = text(row.created_by_user_id);
  const createdAt = timestampText(row.created_at);
  const updatedAt = timestampText(row.updated_at);
  const percentBp = integer(row.percent_bp);
  const maxUses = integer(row.max_uses);
  if (
    !id ||
    !code ||
    (kind !== 'percent_off' && kind !== 'amount_off') ||
    scope !== 'wallet_topup' ||
    (status !== 'active' && status !== 'disabled') ||
    !createdByUserId ||
    !createdAt ||
    !updatedAt ||
    typeof row.per_tenant_once !== 'boolean' ||
    (row.percent_bp !== null && percentBp === null) ||
    (row.max_uses !== null && maxUses === null)
  ) {
    throw new MarketingPromoError('PROMO_STORAGE_ERROR');
  }
  return {
    id,
    code,
    kind,
    percentBp,
    amountMinorUnits: text(row.amount_minor_units),
    currency: text(row.currency),
    scope,
    startsAt: timestampText(row.starts_at),
    endsAt: timestampText(row.ends_at),
    maxUses,
    perTenantOnce: row.per_tenant_once,
    status,
    createdByUserId,
    createdAt,
    updatedAt,
    disabledAt: timestampText(row.disabled_at),
  };
}

const CODE_COLUMNS =
  'id, code, kind, percent_bp, amount_minor_units, currency, scope, starts_at, ends_at, max_uses, per_tenant_once, status, created_by_user_id, created_at, updated_at, disabled_at';

export type CreatePromoCodeInput = {
  readonly code: string;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly maxUses?: number | null;
  readonly perTenantOnce?: boolean;
} & (
  | { readonly kind: 'percent_off'; readonly percentBp: number }
  | { readonly kind: 'amount_off'; readonly amountMinorUnits: string; readonly currency: string }
);

export interface ListPromoCodesInput {
  readonly status?: 'active' | 'disabled';
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MarketingPromoCodeServiceOptions {
  readonly database: MarketingPromoCodeDatabase;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class MarketingPromoCodeService implements WalletTopUpPromoEvaluator {
  private readonly database: MarketingPromoCodeDatabase;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: MarketingPromoCodeServiceOptions) {
    this.database = options.database;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  private async audit(
    executor: SqlExecutor,
    event: { action: string; actorUserId: string | null; tenantId: string | null; targetId: string },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO model_router_saas.saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, $2, $3, $4, 'marketing_promo_code', $5, $6, 'platform_marketing')`,
      [this.idFactory(), event.tenantId, event.actorUserId, event.action, event.targetId, this.now().toISOString()],
    );
  }

  /** Operations-side creation. The code is the uniqueness natural key. */
  async createPromoCode(actor: { userId: string }, input: CreatePromoCodeInput): Promise<PromoCodeView> {
    const actorId = requireUuid(actor.userId, 'PROMO_FORBIDDEN');
    const code = normalizePromoCode(input?.code);
    const startsAt = optionalTimestamp(input?.startsAt);
    const endsAt = optionalTimestamp(input?.endsAt);
    if (startsAt !== null && endsAt !== null && Date.parse(startsAt) >= Date.parse(endsAt)) {
      throw new MarketingPromoError('PROMO_INVALID_INPUT');
    }
    const maxUses = optionalMaxUses(input?.maxUses);
    if (input?.perTenantOnce !== undefined && typeof input.perTenantOnce !== 'boolean') {
      throw new MarketingPromoError('PROMO_INVALID_INPUT');
    }
    const perTenantOnce = input?.perTenantOnce ?? true;

    let percentBp: number | null = null;
    let amountMinorUnits: string | null = null;
    let currency: string | null = null;
    // Kind is double-discriminated: the other variant's fields must be absent.
    const raw = (input ?? {}) as Record<string, unknown>;
    if (input?.kind === 'percent_off') {
      if (raw.amountMinorUnits !== undefined || raw.currency !== undefined) {
        throw new MarketingPromoError('PROMO_INVALID_INPUT');
      }
      if (
        typeof input.percentBp !== 'number' ||
        !Number.isSafeInteger(input.percentBp) ||
        input.percentBp < 1 ||
        input.percentBp > 9999
      ) {
        throw new MarketingPromoError('PROMO_INVALID_INPUT');
      }
      percentBp = input.percentBp;
    } else if (input?.kind === 'amount_off') {
      if (raw.percentBp !== undefined) throw new MarketingPromoError('PROMO_INVALID_INPUT');
      amountMinorUnits = requireMinorUnits(input.amountMinorUnits);
      currency = requireCurrency(input.currency);
    } else {
      throw new MarketingPromoError('PROMO_INVALID_INPUT');
    }

    return this.database.transaction(async (executor) => {
      const inserted = await executor.query<PromoCodeRow>(
        `INSERT INTO model_router_saas.saas_marketing_promo_codes
           (id, code, kind, percent_bp, amount_minor_units, currency, scope,
            starts_at, ends_at, max_uses, per_tenant_once, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'wallet_topup', $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (code) DO NOTHING
         RETURNING ${CODE_COLUMNS}`,
        [
          this.idFactory(),
          code,
          input.kind,
          percentBp,
          amountMinorUnits,
          currency,
          startsAt,
          endsAt,
          maxUses,
          perTenantOnce,
          actorId,
          this.now().toISOString(),
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new MarketingPromoError('PROMO_CODE_CONFLICT');
      const view = mapPromoCodeRow(row);
      await this.audit(executor, {
        action: 'marketing.promo_code.created',
        actorUserId: actorId,
        tenantId: null,
        targetId: view.id,
      });
      return view;
    });
  }

  /** Operations-side disable. Only an active code can be disabled; the transition is one-way. */
  async disablePromoCode(actor: { userId: string }, codeId: string): Promise<PromoCodeView> {
    const actorId = requireUuid(actor.userId, 'PROMO_FORBIDDEN');
    const id = requireUuid(codeId);
    return this.database.transaction(async (executor) => {
      const locked = await executor.query<PromoCodeRow>(
        `SELECT ${CODE_COLUMNS} FROM model_router_saas.saas_marketing_promo_codes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = locked.rows[0];
      if (!row) throw new MarketingPromoError('PROMO_CODE_NOT_FOUND');
      const current = mapPromoCodeRow(row);
      if (current.status === 'disabled') return current;
      const updated = await executor.query<PromoCodeRow>(
        `UPDATE model_router_saas.saas_marketing_promo_codes
            SET status = 'disabled', disabled_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'active'
          RETURNING ${CODE_COLUMNS}`,
        [id, this.now().toISOString()],
      );
      const disabled = updated.rows[0];
      if (!disabled) throw new MarketingPromoError('PROMO_CODE_STATE_CONFLICT');
      const view = mapPromoCodeRow(disabled);
      await this.audit(executor, {
        action: 'marketing.promo_code.disabled',
        actorUserId: actorId,
        tenantId: null,
        targetId: id,
      });
      return view;
    });
  }

  /** Operations-side listing with keyset pagination on (created_at, id) DESC. */
  async listPromoCodes(
    actor: { userId: string },
    input: ListPromoCodesInput = {},
  ): Promise<{ codes: PromoCodeView[]; nextCursor: string | null }> {
    requireUuid(actor.userId, 'PROMO_FORBIDDEN');
    const status = input.status ?? null;
    if (status !== null && status !== 'active' && status !== 'disabled') {
      throw new MarketingPromoError('PROMO_INVALID_INPUT');
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new MarketingPromoError('PROMO_INVALID_INPUT');
    }
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (input.cursor !== undefined) {
      const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
      const [createdAt, id] = decoded.split('|');
      cursorCreatedAt = typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null;
      cursorId = typeof id === 'string' && UUID.test(id) ? id : null;
      if (cursorCreatedAt === null || cursorId === null) throw new MarketingPromoError('PROMO_INVALID_INPUT');
    }
    const rows = await this.database.query<PromoCodeRow>(
      `SELECT ${CODE_COLUMNS} FROM model_router_saas.saas_marketing_promo_codes
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [status, cursorCreatedAt, cursorId, limit + 1],
    );
    const page = rows.rows.slice(0, limit).map(mapPromoCodeRow);
    const last = page.at(-1);
    const nextCursor =
      rows.rows.length > limit && last
        ? Buffer.from(`${last.createdAt}|${last.id}`, 'utf8').toString('base64url')
        : null;
    return { codes: page, nextCursor };
  }

  /**
   * WalletTopUpPromoEvaluator (R1): runs inside the payment order transaction
   * on the caller's executor. The code row is locked, all applicability
   * checks re-read under that lock, the usage row and the audit land in the
   * same transaction as the order insert. Every refusal is PROMO_CODE_INVALID
   * so code existence/terms are never disclosed through distinct errors.
   */
  async priceWalletTopUp(
    executor: SqlExecutor,
    input: {
      readonly orderId: string;
      readonly tenantId: string;
      readonly amountMinorUnits: string;
      readonly currency: string;
      readonly promoCode: string;
    },
  ): Promise<{ readonly amountMinorUnits: string; readonly originalAmountMinorUnits: string }> {
    const orderId = checkoutText(input?.orderId);
    const tenantId = checkoutText(input?.tenantId);
    const amount = checkoutAmount(input?.amountMinorUnits);
    const orderCurrency = checkoutCurrency(input?.currency);
    let code: string;
    try {
      code = normalizePromoCode(input?.promoCode);
    } catch {
      throw new PaymentError('PROMO_CODE_INVALID');
    }

    const locked = await executor.query<PromoCodeRow>(
      `SELECT ${CODE_COLUMNS} FROM model_router_saas.saas_marketing_promo_codes WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const row = locked.rows[0];
    if (!row) throw new PaymentError('PROMO_CODE_INVALID');
    let promo: PromoCodeView;
    try {
      promo = mapPromoCodeRow(row);
    } catch {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }

    const invalid = () => new PaymentError('PROMO_CODE_INVALID');
    if (promo.scope !== 'wallet_topup') throw invalid();
    if (promo.status !== 'active') throw invalid();
    const nowMs = this.now().getTime();
    if (promo.startsAt !== null && nowMs < Date.parse(promo.startsAt)) throw invalid();
    if (promo.endsAt !== null && nowMs >= Date.parse(promo.endsAt)) throw invalid();

    if (promo.kind === 'amount_off') {
      if (promo.amountMinorUnits === null || promo.currency === null) {
        throw new PaymentError('PAYMENT_STORAGE_ERROR');
      }
      if (promo.currency !== orderCurrency) throw invalid();
    } else if (promo.percentBp === null) {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }

    if (promo.perTenantOnce) {
      const existing = await executor.query<Record<string, unknown>>(
        `SELECT id FROM model_router_saas.saas_marketing_promo_usages WHERE code_id = $1 AND tenant_id = $2 LIMIT 1`,
        [promo.id, tenantId],
      );
      if (existing.rows.length > 0) throw invalid();
    }

    if (promo.maxUses !== null) {
      const counted = await executor.query<{ used: string }>(
        `SELECT count(*)::text AS used FROM model_router_saas.saas_marketing_promo_usages WHERE code_id = $1`,
        [promo.id],
      );
      const used = Number(counted.rows[0]?.used);
      if (!Number.isSafeInteger(used)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      if (used >= promo.maxUses) throw invalid();
    }

    // Fixed-point discount, BigInt throughout: percent floors, amount_off
    // clamps at the full order amount. A zero-priced order is refused because
    // saas_payment_orders.amount_minor_units is CHECK (amount > 0).
    let discount: bigint;
    if (promo.kind === 'percent_off') {
      discount = (amount * BigInt(promo.percentBp as number)) / 10_000n;
    } else {
      const off = BigInt(promo.amountMinorUnits as string);
      discount = off < amount ? off : amount;
    }
    const discounted = amount - discount;
    if (discounted <= 0n) throw invalid();

    try {
      await executor.query(
        `INSERT INTO model_router_saas.saas_marketing_promo_usages
           (id, code_id, tenant_id, order_id, discount_minor_units, per_tenant_once, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          this.idFactory(),
          promo.id,
          tenantId,
          orderId,
          discount.toString(),
          promo.perTenantOnce,
          this.now().toISOString(),
        ],
      );
    } catch (error) {
      // UNIQUE(order_id) or the per-tenant-once partial index is the last
      // backstop; any unique conflict collapses into the unified refusal.
      if (isUniqueViolation(error)) throw invalid();
      throw error;
    }

    await this.audit(executor, {
      action: 'marketing.promo_code.used',
      actorUserId: null,
      tenantId,
      targetId: promo.id,
    });

    return {
      amountMinorUnits: discounted.toString(),
      originalAmountMinorUnits: amount.toString(),
    };
  }
}

function checkoutText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new PaymentError('PROMO_CODE_INVALID');
  }
  return value;
}

function checkoutAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !MINOR_UNITS.test(value)) throw new PaymentError('PROMO_CODE_INVALID');
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_MINOR_UNITS) throw new PaymentError('PROMO_CODE_INVALID');
  return parsed;
}

function checkoutCurrency(value: unknown): string {
  if (typeof value !== 'string' || !CURRENCY.test(value)) throw new PaymentError('PROMO_CODE_INVALID');
  return value;
}
