import type { SaasDatabase } from '../db/types.js';
import type { CustomerWebhookEventProducer } from './producers.js';

/**
 * F3 scanner for scan-derived customer webhook events: wallet.low_balance and
 * api_key.expiring. Unlike the state-machine producers, these events have no
 * business transaction to ride on, so each candidate is enqueued in its own
 * short transaction and idempotency keys carry the bucket that makes a sweep
 * replay a no-op.
 *
 * Idempotency model:
 * - wallet.low_balance: `<tenant>:<currency>:<day>:band-<n>` — at most eleven
 *   bands (deciles of the threshold below it) per tenant/currency/day. A
 *   re-attempt with a moved balance in the same bucket conflicts on the stored
 *   payload; the scanner treats WEBHOOK_IDEMPOTENCY_CONFLICT as "already
 *   emitted" and skips, so a hoisting balance never fails the sweep.
 * - api_key.expiring: `<key id>:<expires epoch ms>` — one event per key per
 *   committed expiry; occurred_at is the deterministic window-entry timestamp
 *   (expires_at minus the window), so replays match byte-for-byte.
 *
 * Entitlement is enforced twice: the scan queries pre-join the tenant policy
 * (enabled + event-type whitelist) and the producer re-checks through the
 * store. Non-entitled rows never reach the events table.
 */

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 500;
const DEFAULT_EXPIRING_KEY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EXPIRING_KEY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface CustomerWebhookNotificationScannerOptions {
  /** Maximum candidate rows enqueued per event kind per sweep (1..500). */
  readonly batchSize?: number;
  /** How far ahead api_key.expiring fires (1h..30d; default 7d). */
  readonly expiringKeyWindowMs?: number;
  readonly now?: () => Date;
  /** Receives only a stable cycle code. It never receives tenant or key data. */
  readonly onError?: (code: 'scan_event_failed') => void;
}

export interface CustomerWebhookNotificationScanResult {
  readonly lowBalanceEmitted: number;
  readonly lowBalanceSkipped: number;
  readonly expiringKeysEmitted: number;
  readonly expiringKeysSkipped: number;
  readonly failed: number;
}

interface LowBalanceRow {
  readonly tenant_id: unknown;
  readonly currency: unknown;
  readonly posted_balance_minor_units: unknown;
  readonly low_balance_threshold_minor_units: unknown;
}

interface ExpiringKeyRow {
  readonly tenant_id: unknown;
  readonly id: unknown;
  readonly expires_at: unknown;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** PostgreSQL bigint arrives as a string; fail closed on anything else. */
function asMinorUnits(value: unknown): number | null {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string' || typeof value === 'number'
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asIsoMillis(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Decile band of (threshold - balance) relative to the threshold; 0 just below, 10 at zero. */
function lowBalanceBand(balanceMinorUnits: number, thresholdMinorUnits: number): number {
  const band = Math.floor(((thresholdMinorUnits - balanceMinorUnits) / thresholdMinorUnits) * 10);
  return Math.min(10, Math.max(0, band));
}

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'WEBHOOK_IDEMPOTENCY_CONFLICT';
}

export class CustomerWebhookNotificationScanner {
  private readonly batchSize: number;
  private readonly expiringKeyWindowMs: number;
  private readonly now: () => Date;
  private readonly onError?: (code: 'scan_event_failed') => void;

  constructor(
    private readonly database: SaasDatabase,
    private readonly producer: CustomerWebhookEventProducer,
    options: CustomerWebhookNotificationScannerOptions = {},
  ) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
    }
    const windowMs = options.expiringKeyWindowMs ?? DEFAULT_EXPIRING_KEY_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs < 60 * 60 * 1000 || windowMs > MAX_EXPIRING_KEY_WINDOW_MS) {
      throw new RangeError('expiringKeyWindowMs must be between one hour and thirty days');
    }
    if (typeof producer.walletLowBalance !== 'function' || typeof producer.apiKeyExpiring !== 'function') {
      throw new TypeError('producer must implement the customer webhook event producer contract');
    }
    this.batchSize = batchSize;
    this.expiringKeyWindowMs = windowMs;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  async runOnce(): Promise<CustomerWebhookNotificationScanResult> {
    const lowBalance = await this.scanLowBalances();
    const expiring = await this.scanExpiringKeys();
    const failed = lowBalance.failed + expiring.failed;
    if (failed > 0) {
      try {
        this.onError?.('scan_event_failed');
      } catch {
        // Observability hooks must never break the sweep.
      }
    }
    return Object.freeze({
      lowBalanceEmitted: lowBalance.emitted,
      lowBalanceSkipped: lowBalance.skipped,
      expiringKeysEmitted: expiring.emitted,
      expiringKeysSkipped: expiring.skipped,
      failed,
    });
  }

  private async scanLowBalances(): Promise<{ emitted: number; skipped: number; failed: number }> {
    const nowIso = this.now().toISOString();
    const dayBucket = nowIso.slice(0, 10);
    const rows = await this.database.query<LowBalanceRow>(
      `SELECT w.tenant_id, w.currency, w.posted_balance_minor_units, p.low_balance_threshold_minor_units
       FROM saas_customer_webhook_tenant_policies p
       JOIN saas_wallets w ON w.tenant_id = p.tenant_id
       WHERE p.enabled = TRUE
         AND p.low_balance_threshold_minor_units IS NOT NULL
         AND 'wallet.low_balance' = ANY (p.allowed_event_types)
         AND w.posted_balance_minor_units <= p.low_balance_threshold_minor_units
       ORDER BY w.tenant_id, w.currency
       LIMIT $1`,
      [this.batchSize],
    );
    const outcome = { emitted: 0, skipped: 0, failed: 0 };
    for (const row of rows.rows) {
      const tenantId = asText(row.tenant_id);
      const currency = asText(row.currency);
      const balance = asMinorUnits(row.posted_balance_minor_units);
      const threshold = asMinorUnits(row.low_balance_threshold_minor_units);
      if (tenantId === null || currency === null || balance === null || threshold === null || threshold < 1) {
        outcome.failed += 1;
        continue;
      }
      const band = lowBalanceBand(balance, threshold);
      try {
        await this.database.transaction(async (tx) => {
          await this.producer.walletLowBalance(tx, {
            tenantId,
            currency,
            balanceMinorUnits: balance,
            thresholdMinorUnits: threshold,
            occurredAt: nowIso,
            transitionRef: `${dayBucket}:band-${band}`,
          });
        });
        outcome.emitted += 1;
      } catch (error) {
        if (isIdempotencyConflict(error)) {
          outcome.skipped += 1;
        } else {
          outcome.failed += 1;
        }
      }
    }
    return outcome;
  }

  private async scanExpiringKeys(): Promise<{ emitted: number; skipped: number; failed: number }> {
    const nowMs = this.now().getTime();
    const windowEnd = new Date(nowMs + this.expiringKeyWindowMs);
    const rows = await this.database.query<ExpiringKeyRow>(
      `SELECT k.tenant_id, k.id, k.expires_at
       FROM saas_api_keys k
       JOIN saas_customer_webhook_tenant_policies p
         ON p.tenant_id = k.tenant_id
        AND p.enabled = TRUE
        AND 'api_key.expiring' = ANY (p.allowed_event_types)
       WHERE k.status = 'active'
         AND k.expires_at IS NOT NULL
         AND k.expires_at > $1
         AND k.expires_at <= $2
       ORDER BY k.tenant_id, k.id
       LIMIT $3`,
      [new Date(nowMs).toISOString(), windowEnd.toISOString(), this.batchSize],
    );
    const outcome = { emitted: 0, skipped: 0, failed: 0 };
    for (const row of rows.rows) {
      const tenantId = asText(row.tenant_id);
      const apiKeyId = asText(row.id);
      const expiresAt = asIsoMillis(row.expires_at);
      if (tenantId === null || apiKeyId === null || expiresAt === null) {
        outcome.failed += 1;
        continue;
      }
      const expiresMs = Date.parse(expiresAt);
      try {
        await this.database.transaction(async (tx) => {
          await this.producer.apiKeyExpiring(tx, {
            tenantId,
            apiKeyId,
            expiresAt,
            occurredAt: new Date(expiresMs - this.expiringKeyWindowMs).toISOString(),
            transitionRef: `expires-${expiresMs}`,
          });
        });
        outcome.emitted += 1;
      } catch (error) {
        if (isIdempotencyConflict(error)) {
          outcome.skipped += 1;
        } else {
          outcome.failed += 1;
        }
      }
    }
    return outcome;
  }
}
