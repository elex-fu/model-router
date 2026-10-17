import { randomUUID } from 'node:crypto';
import type { UsageBillingMode, UsageSizeTier } from '../../telemetry/usage.js';
import { USAGE_BILLING_MODES, USAGE_SIZE_TIERS } from '../../telemetry/usage.js';
import { saasAdvisoryKey } from '../db/advisory-lock-keys.js';
import type { SqlExecutor } from '../db/types.js';
import { usageCorrectionDigest } from './digest.js';

interface UsageCorrectionMediaInput {
  readonly billingMode?: UsageBillingMode | null;
  readonly units?: ExactIntegerInput | null;
  readonly sizeTier?: UsageSizeTier | null;
}

import { SaasMeteringError, type SaasMeteringErrorCode } from './errors.js';
import type {
  ExactIntegerInput,
  MeteringDatabase,
  MeteringOperationOptions,
  NormalizedUsageExact,
  UsageValues,
} from './types.js';

/**
 * Append-only usage corrections (contract C-1). A correction never modifies
 * the original usage event or settlement; it records a digest-bound event and,
 * for platform supply with a non-zero amount delta, posts a signed wallet
 * reversal through the billing ledger in the same transaction.
 */
export type UsageCorrectionReasonCode =
  | 'provider_reported_correction'
  | 'billing_dispute'
  | 'metering_fault'
  | 'operator_adjustment';

export interface RecordUsageCorrectionInput {
  readonly tenantId: string;
  readonly usageEventId: string;
  /** Required when the corrected usage event already has a settlement. */
  readonly settlementId?: string | null;
  readonly reasonCode: UsageCorrectionReasonCode;
  readonly correctionUsage: UsageValues;
  /**
   * Signed exact integer (bigint/number/string). Positive credits the wallet
   * (the original charge was too high); negative debits it. Zero records an
   * event-only correction and is required for BYOK supply.
   */
  readonly amountDeltaMinorUnits: ExactIntegerInput;
  readonly currency: string;
  /** Platform operator identity captured from the authenticated session. */
  readonly operatorIdentity: string;
  /** Optional opaque SHA-256 reference to external evidence. */
  readonly evidenceRef?: string | null;
}

export interface UsageCorrectionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly correctedUsageEventId: string;
  readonly correctedSettlementId: string | null;
  readonly reasonCode: UsageCorrectionReasonCode;
  readonly correctionUsage: NormalizedUsageExact;
  /** Canonical signed integer text. */
  readonly amountDeltaMinorUnits: string;
  readonly currency: string;
  readonly operatorIdentity: string;
  readonly evidenceRef: string | null;
  readonly correctionDigest: string;
  readonly createdAt: string;
}

export interface UsageCorrectionResult {
  readonly correction: UsageCorrectionRecord;
  readonly replayed: boolean;
  /** Null for event-only corrections and for replays. */
  readonly ledgerTransactionId: string | null;
}

/** Narrow ledger seam; PlatformWalletLedgerService satisfies it structurally. */
export interface UsageCorrectionLedgerPort {
  postUsageCorrection(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly currency: string;
      readonly amountDeltaMinorUnits: bigint;
      readonly correctionEventId: string;
      readonly correctionDigest: string;
    },
  ): Promise<{ readonly transactionId: string; readonly replayed: boolean }>;
}

/**
 * KEY-BUD (contract C-4) budget counter correction slice. Runs in the same
 * correction transaction; errors roll the transaction back. Absent disables
 * budget accounting (pre-081 behavior).
 */
export interface UsageCorrectionKeyBudget {
  correct(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly tokenSettledDelta: string;
      readonly chargeSettledDelta: string;
    },
  ): Promise<boolean>;
}

/**
 * R1 (roadmap 1.3, phase 3): a non-negative settled charge delta moves the
 * settled side of the billing group spend windows of the original admission;
 * a missing row is pre-114 drift (no-op). Negative corrections stay
 * conservative (the window stays consumed), mirroring KEY-BUD.
 */
export interface UsageCorrectionBillingGroupSpend {
  correct(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly chargeSettledDelta: string;
    },
  ): Promise<boolean>;
}

export interface UsageCorrectionServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly ledger?: UsageCorrectionLedgerPort;
  readonly keyBudget?: UsageCorrectionKeyBudget;
  readonly billingGroupSpend?: UsageCorrectionBillingGroupSpend;
}

type Row = Record<string, unknown>;

const HEX_DIGEST = /^[0-9a-f]{64}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SIGNED_INTEGER = /^-?\d{1,19}$/;
const MAX_TOKEN_TEXT = '9223372036854775807';
const REASON_CODES: readonly UsageCorrectionReasonCode[] = [
  'provider_reported_correction',
  'billing_dispute',
  'metering_fault',
  'operator_adjustment',
];

const CORRECTION_COLUMNS = `id, tenant_id, corrected_usage_event_id, corrected_settlement_id,
  reason_code, correction_usage, amount_delta_minor_units, currency,
  operator_identity, evidence_ref, correction_digest, created_at`;

function fail(code: SaasMeteringErrorCode, cause?: unknown): never {
  throw new SaasMeteringError(code, cause);
}

function asIdentifier(value: unknown): string {
  if (typeof value !== 'string') fail('METERING_INVALID_INPUT');
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 255) fail('METERING_INVALID_INPUT');
  return normalized;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The operator doubles as the saas_audit_events.actor_user_id FK target. */
function asOperatorIdentity(value: unknown): string {
  const normalized = asIdentifier(value);
  if (!UUID.test(normalized)) fail('METERING_INVALID_INPUT');
  return normalized;
}

function asStoredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
    fail('METERING_STORAGE_ERROR');
  }
  return value;
}

function asOptionalDigest(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) fail('METERING_INVALID_INPUT');
  return value.toLowerCase();
}

function asReasonCode(value: unknown): UsageCorrectionReasonCode {
  if (typeof value !== 'string' || !(REASON_CODES as readonly string[]).includes(value)) {
    fail('METERING_INVALID_INPUT');
  }
  return value as UsageCorrectionReasonCode;
}

function asCurrency(value: unknown): string {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) fail('METERING_INVALID_INPUT');
  return value;
}

function asSignedMinorUnits(value: ExactIntegerInput): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('METERING_INVALID_INPUT');
    return BigInt(value);
  }
  if (typeof value === 'string' && SIGNED_INTEGER.test(value)) return BigInt(value);
  fail('METERING_INVALID_INPUT');
}

function asToken(value: ExactIntegerInput | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(MAX_TOKEN_TEXT)) fail('METERING_INVALID_INPUT');
    return value.toString(10);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('METERING_INVALID_INPUT');
    return value.toString(10);
  }
  if (typeof value === 'string' && /^\d{1,19}$/.test(value) && BigInt(value) <= BigInt(MAX_TOKEN_TEXT)) {
    return BigInt(value).toString(10);
  }
  fail('METERING_INVALID_INPUT');
}

function normalizeUsage(input: UsageValues): NormalizedUsageExact {
  const { status, source, measurementKind, billableBasis } = input;
  if (!['reported', 'partial', 'missing', 'estimated'].includes(status)) fail('METERING_INVALID_INPUT');
  if (!['upstream', 'local-estimate', 'legacy'].includes(source)) fail('METERING_INVALID_INPUT');
  if (!['snapshot', 'delta'].includes(measurementKind)) fail('METERING_INVALID_INPUT');
  if (!['exact', 'estimated', 'unknown', 'not_billable'].includes(billableBasis)) {
    fail('METERING_INVALID_INPUT');
  }
  if (
    typeof input.semanticsVersion !== 'string' ||
    input.semanticsVersion.trim() === '' ||
    input.semanticsVersion.length > 64
  ) {
    fail('METERING_INVALID_INPUT');
  }
  // §4.1: media fields; a non-token mode requires a unit count (never zero).
  const billingMode = (input as UsageCorrectionMediaInput).billingMode ?? 'token';
  if (!USAGE_BILLING_MODES.includes(billingMode)) fail('METERING_INVALID_INPUT');
  const units = asToken((input as UsageCorrectionMediaInput).units ?? null);
  if (billingMode !== 'token' && units === null) fail('METERING_INVALID_INPUT');
  const sizeTier = (input as UsageCorrectionMediaInput).sizeTier ?? null;
  if (sizeTier !== null && !USAGE_SIZE_TIERS.includes(sizeTier)) fail('METERING_INVALID_INPUT');
  return {
    inputTotal: asToken(input.inputTotal),
    inputUncached: asToken(input.inputUncached),
    cacheRead: asToken(input.cacheRead),
    cacheWrite: asToken(input.cacheWrite),
    cacheWrite5m: asToken(input.cacheWrite5m),
    cacheWrite1h: asToken(input.cacheWrite1h),
    outputTotal: asToken(input.outputTotal),
    reasoningOutput: asToken(input.reasoningOutput),
    billingMode,
    units,
    sizeTier,
    status,
    source,
    semanticsVersion: input.semanticsVersion,
    measurementKind,
    billableBasis,
  };
}

function asStoredUsage(value: unknown): NormalizedUsageExact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('METERING_STORAGE_ERROR');
  const stored = value as Record<string, unknown>;
  const usage: UsageValues = {
    inputTotal: stored.inputTotal as ExactIntegerInput | null,
    inputUncached: stored.inputUncached as ExactIntegerInput | null,
    cacheRead: stored.cacheRead as ExactIntegerInput | null,
    cacheWrite: stored.cacheWrite as ExactIntegerInput | null,
    cacheWrite5m: stored.cacheWrite5m as ExactIntegerInput | null,
    cacheWrite1h: stored.cacheWrite1h as ExactIntegerInput | null,
    outputTotal: stored.outputTotal as ExactIntegerInput | null,
    reasoningOutput: stored.reasoningOutput as ExactIntegerInput | null,
    billingMode: 'token',
    units: null,
    sizeTier: null,
    status: stored.status as UsageValues['status'],
    source: stored.source as UsageValues['source'],
    semanticsVersion: stored.semanticsVersion as string,
    measurementKind: stored.measurementKind as UsageValues['measurementKind'],
    billableBasis: stored.billableBasis as UsageValues['billableBasis'],
  };
  try {
    return normalizeUsage(usage);
  } catch (error) {
    if (error instanceof SaasMeteringError) fail('METERING_STORAGE_ERROR', error);
    throw error;
  }
}

function asStoredSignedMinorUnits(value: unknown): string {
  if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') {
    fail('METERING_STORAGE_ERROR');
  }
  const text = typeof value === 'string' ? value : (value as number | bigint).toString(10);
  if (!SIGNED_INTEGER.test(text)) fail('METERING_STORAGE_ERROR');
  return BigInt(text).toString(10);
}

function asStoredTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') return value;
  fail('METERING_STORAGE_ERROR');
}

function mapCorrection(row: Row): UsageCorrectionRecord {
  const reasonCode = row.reason_code;
  return {
    id: asStoredIdentifier(row.id),
    tenantId: asStoredIdentifier(row.tenant_id),
    correctedUsageEventId: asStoredIdentifier(row.corrected_usage_event_id),
    correctedSettlementId:
      row.corrected_settlement_id === null || row.corrected_settlement_id === undefined
        ? null
        : asStoredIdentifier(row.corrected_settlement_id),
    reasonCode: (REASON_CODES as readonly string[]).includes(reasonCode as string)
      ? (reasonCode as UsageCorrectionReasonCode)
      : fail('METERING_STORAGE_ERROR'),
    correctionUsage: asStoredUsage(row.correction_usage),
    amountDeltaMinorUnits: asStoredSignedMinorUnits(row.amount_delta_minor_units),
    currency:
      typeof row.currency === 'string' && CURRENCY_PATTERN.test(row.currency)
        ? row.currency
        : fail('METERING_STORAGE_ERROR'),
    operatorIdentity: asStoredIdentifier(row.operator_identity),
    evidenceRef:
      row.evidence_ref === null || row.evidence_ref === undefined
        ? null
        : typeof row.evidence_ref === 'string' && HEX_DIGEST.test(row.evidence_ref)
          ? row.evidence_ref.toLowerCase()
          : fail('METERING_STORAGE_ERROR'),
    correctionDigest:
      typeof row.correction_digest === 'string' && HEX_DIGEST.test(row.correction_digest)
        ? row.correction_digest.toLowerCase()
        : fail('METERING_STORAGE_ERROR'),
    createdAt: asStoredTimestamp(row.created_at),
  };
}

/** Original exact token total (input + output) from a stored usage event row. */
function storedTokenTotal(inputTotal: unknown, outputTotal: unknown): bigint | null {
  if (inputTotal === null || inputTotal === undefined || outputTotal === null || outputTotal === undefined) {
    return null;
  }
  try {
    const input = BigInt(String(inputTotal));
    const output = BigInt(String(outputTotal));
    if (input < 0n || output < 0n) return null;
    return input + output;
  } catch {
    return null;
  }
}

/** Corrected exact token total from the normalized correction usage. */
function correctedTokenTotal(usage: NormalizedUsageExact): bigint | null {
  if (usage.inputTotal === null || usage.outputTotal === null) return null;
  return BigInt(usage.inputTotal) + BigInt(usage.outputTotal);
}

export class UsageCorrectionService {
  private readonly database: MeteringDatabase;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly ledger: UsageCorrectionLedgerPort | undefined;
  private readonly keyBudget: UsageCorrectionKeyBudget | undefined;
  private readonly billingGroupSpend: UsageCorrectionBillingGroupSpend | undefined;

  constructor(database: MeteringDatabase, options: UsageCorrectionServiceOptions = {}) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.ledger = options.ledger;
    this.keyBudget = options.keyBudget;
    this.billingGroupSpend = options.billingGroupSpend;
  }

  /**
   * Record an append-only correction. The request row is locked and must not
   * be under reconciliation; the correction insert and (for platform supply)
   * the wallet reversal commit atomically. Re-submitting the same correction
   * replays the original record because the digest covers every field.
   */
  async recordUsageCorrection(
    input: RecordUsageCorrectionInput,
    options: MeteringOperationOptions = {},
  ): Promise<UsageCorrectionResult> {
    const tenantId = asIdentifier(input.tenantId);
    const usageEventId = asIdentifier(input.usageEventId);
    const settlementId =
      input.settlementId === undefined || input.settlementId === null ? null : asIdentifier(input.settlementId);
    const reasonCode = asReasonCode(input.reasonCode);
    const currency = asCurrency(input.currency);
    const operatorIdentity = asOperatorIdentity(input.operatorIdentity);
    const evidenceRef = asOptionalDigest(input.evidenceRef);
    const delta = asSignedMinorUnits(input.amountDeltaMinorUnits);
    const usage = normalizeUsage(input.correctionUsage);

    return this.write(options.executor, async (tx) => {
      // Usage events are append-only with immutable identity columns, so this
      // unlocked read is safe; the advisory fence below covers the request.
      // The original token totals are only needed when KEY-BUD budget
      // correction is wired; without it the read stays byte-identical.
      const event = await this.one<Row>(
        tx,
        this.keyBudget
          ? `SELECT e.id, e.tenant_id, e.request_id, e.supply_mode, e.input_total, e.output_total
             FROM saas_usage_events e
             WHERE e.tenant_id = $1 AND e.id = $2
             LIMIT 1`
          : `SELECT e.id, e.tenant_id, e.request_id, e.supply_mode
             FROM saas_usage_events e
             WHERE e.tenant_id = $1 AND e.id = $2
             LIMIT 1`,
        [tenantId, usageEventId],
      );
      if (!event) fail('USAGE_EVENT_NOT_FOUND');
      const requestId = asStoredIdentifier(event.request_id);

      // House advisory fence (no FOR UPDATE: the control-plane runtime role
      // holds no UPDATE privilege on saas_requests by design). Serializes
      // corrections for one request against each other and against any
      // reconciliation writer that takes the same key.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        saasAdvisoryKey.usageCorrectionRequest(tenantId, requestId),
      ]);

      const settlements = await this.rows<Row>(
        tx,
        `SELECT id FROM saas_usage_settlements
         WHERE tenant_id = $1 AND usage_event_id = $2
         LIMIT 2`,
        [tenantId, usageEventId],
      );
      if (settlementId === null && settlements.length > 0) fail('METERING_INVALID_INPUT');
      if (
        settlementId !== null &&
        !settlements.some((settlement) => asStoredIdentifier(settlement.id) === settlementId)
      ) {
        fail('USAGE_SETTLEMENT_CONFLICT');
      }

      const request = await this.one<Row>(
        tx,
        `SELECT reconciliation_state
         FROM saas_requests
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, requestId],
      );
      if (!request) fail('REQUEST_NOT_FOUND');
      if (request.reconciliation_state === 'pending') fail('USAGE_CORRECTION_STATE_CONFLICT');

      const supplyMode = event.supply_mode;
      if (supplyMode !== 'byok' && supplyMode !== 'platform') fail('METERING_STORAGE_ERROR');
      // BYOK never touches the platform wallet (red line): event-only.
      if (supplyMode === 'byok' && delta !== 0n) fail('METERING_INVALID_INPUT');

      const digest = usageCorrectionDigest({
        tenantId,
        correctedUsageEventId: usageEventId,
        correctedSettlementId: settlementId,
        reasonCode,
        correctionUsage: usage,
        amountDeltaMinorUnits: delta.toString(10),
        currency,
        operatorIdentity,
        evidenceRef,
      });

      const inserted = await this.rows<Row>(
        tx,
        `INSERT INTO saas_usage_correction_events
           (id, tenant_id, corrected_usage_event_id, corrected_settlement_id,
            reason_code, correction_usage, amount_delta_minor_units, currency,
            operator_identity, evidence_ref, correction_digest, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (correction_digest) DO NOTHING
         RETURNING ${CORRECTION_COLUMNS}`,
        [
          this.idFactory(),
          tenantId,
          usageEventId,
          settlementId,
          reasonCode,
          JSON.stringify(usage),
          delta.toString(10),
          currency,
          operatorIdentity,
          evidenceRef,
          digest,
          this.now().toISOString(),
        ],
      );

      if (!inserted[0]) {
        const existing = await this.one<Row>(
          tx,
          `SELECT ${CORRECTION_COLUMNS}
           FROM saas_usage_correction_events
           WHERE correction_digest = $1
           LIMIT 1`,
          [digest],
        );
        if (!existing) fail('METERING_STORAGE_ERROR');
        const record = mapCorrection(existing);
        if (record.tenantId !== tenantId || record.correctedUsageEventId !== usageEventId) {
          fail('USAGE_CORRECTION_CONFLICT');
        }
        return { correction: record, replayed: true, ledgerTransactionId: null };
      }

      const correction = mapCorrection(inserted[0]);
      let ledgerTransactionId: string | null = null;
      if (supplyMode === 'platform' && delta !== 0n) {
        if (!this.ledger) fail('METERING_STORAGE_ERROR');
        const posting = await this.ledger.postUsageCorrection(tx, {
          tenantId,
          currency,
          amountDeltaMinorUnits: delta,
          correctionEventId: correction.id,
          correctionDigest: digest,
        });
        if (posting.replayed) fail('METERING_STORAGE_ERROR');
        ledgerTransactionId = posting.transactionId;
      }
      // KEY-BUD (contract C-4): a non-negative settled delta moves the settled
      // counters of the original admission day and lifetime in the same
      // transaction; a missing reservation row is pre-081 drift (no-op).
      // TODO(KEY-BUD): negative usage corrections require a counter-decrement
      // path; downward token/charge corrections leave the budget counters
      // unchanged (conservative: the budget stays consumed).
      if (this.keyBudget) {
        const originalTokens = storedTokenTotal(event.input_total, event.output_total);
        const correctedTokens = correctedTokenTotal(usage);
        if (originalTokens !== null && correctedTokens !== null) {
          const tokenDelta = correctedTokens - originalTokens;
          if (tokenDelta >= 0n && delta >= 0n && (tokenDelta > 0n || delta > 0n)) {
            await this.keyBudget.correct(tx, {
              tenantId,
              requestId,
              tokenSettledDelta: tokenDelta.toString(10),
              chargeSettledDelta: delta.toString(10),
            });
          }
        }
      }
      if (this.billingGroupSpend && delta > 0n) {
        await this.billingGroupSpend.correct(tx, {
          tenantId,
          requestId,
          chargeSettledDelta: delta.toString(10),
        });
      }
      // Contract C-1.4: every created correction appends a platform audit row
      // in the same transaction; replays add nothing.
      await tx.query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
         VALUES ($1, $2, $3, 'usage_correction_recorded', 'saas_usage_correction_event', $4, $5, 'platform_metering')`,
        [this.idFactory(), tenantId, operatorIdentity, correction.id, this.now().toISOString()],
      );
      return { correction, replayed: false, ledgerTransactionId };
    });
  }

  async listUsageCorrections(
    input: { readonly tenantId: string; readonly usageEventId?: string; readonly limit?: number },
    options: MeteringOperationOptions = {},
  ): Promise<readonly UsageCorrectionRecord[]> {
    const tenantId = asIdentifier(input.tenantId);
    const usageEventId = input.usageEventId === undefined ? null : asIdentifier(input.usageEventId);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('METERING_INVALID_INPUT');
    const executor = options.executor ?? this.database;
    const rows =
      usageEventId === null
        ? await this.rows<Row>(
            executor,
            `SELECT ${CORRECTION_COLUMNS}
           FROM saas_usage_correction_events
           WHERE tenant_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
            [tenantId, limit],
          )
        : await this.rows<Row>(
            executor,
            `SELECT ${CORRECTION_COLUMNS}
           FROM saas_usage_correction_events
           WHERE tenant_id = $1 AND corrected_usage_event_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3`,
            [tenantId, usageEventId, limit],
          );
    return rows.map(mapCorrection);
  }

  private async write<T>(executor: SqlExecutor | undefined, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return executor ? work(executor) : this.database.transaction(work);
  }

  private async one<RowType extends Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[],
  ): Promise<RowType | undefined> {
    const result = await executor.query<RowType>(sql, values);
    return result.rows[0];
  }

  private async rows<RowType extends Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[],
  ): Promise<RowType[]> {
    const result = await executor.query<RowType>(sql, values);
    return result.rows;
  }
}
