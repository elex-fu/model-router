import type { SqlExecutor } from '../db/types.js';
import { PostgresCustomerWebhookEntitlementPolicy } from './entitlement-policy.js';
import {
  CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES,
  type CustomerWebhookEventType,
  type CustomerWebhookSupplyMode,
  type PlatformMaintenanceEventData,
  type RefundStatusChangedEventData,
  type RequestCompletedEventData,
  type ServicePlanOrderStatusChangedEventData,
} from './events.js';
import { type CustomerWebhookEventEntitlementPolicy, enqueueCustomerWebhookEvent } from './postgres-store.js';

/**
 * F3 producer hooks for the payments/plans state machines and the metering
 * settlement terminal commits. Each call is one enqueue inside the caller's
 * business transaction, so the event commits or rolls back with the state
 * change it describes.
 *
 * Idempotency keys are `<event type>:<resource id>:<new status>:<transition
 * ref>`. The transition ref is a fresh per-transition token (lease token or
 * minted id): guarded state-predicate UPDATEs never re-fire a committed
 * transition, while a lifecycle that legitimately re-enters the same status
 * (reconciliation loops) gets a distinct key and never collides with the
 * earlier event.
 *
 * Drop semantics: webhooks are a notification capability, never a gate on the
 * money path. Tenants without a policy row, with the capability disabled,
 * outside their event-type whitelist, or over quota simply get no event —
 * those four fail-closed store codes are swallowed (and reported through the
 * optional onEventDropped hook). Any other failure is a real storage or
 * integrity fault and propagates, rolling the business transaction back.
 */

const TRANSITION_REF = /^[A-Za-z0-9._:-]{1,96}$/;

/** Store codes that mean "this tenant gets no event", not "the business operation failed". */
const DROPPED_EVENT_CODES: ReadonlySet<string> = new Set([
  'WEBHOOK_ENTITLEMENT_DENIED',
  'WEBHOOK_TENANT_POLICY_DISABLED',
  'WEBHOOK_TENANT_QUOTA_EXCEEDED',
  'WEBHOOK_ENDPOINT_SNAPSHOT_CHANGED',
]);

export interface CustomerWebhookEventDrop {
  readonly eventType: CustomerWebhookEventType;
  readonly tenantId: string;
  readonly resourceId: string;
  readonly code: string;
}

export interface CustomerWebhookEventProducerOptions {
  readonly entitlement?: CustomerWebhookEventEntitlementPolicy;
  /** Observability hook for dropped events; must never throw. */
  readonly onEventDropped?: (drop: CustomerWebhookEventDrop) => void;
}

export interface RefundStatusChangedTransition {
  readonly tenantId: string;
  readonly refundId: string;
  readonly status: RefundStatusChangedEventData['status'];
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly occurredAt: string;
  readonly transitionRef: string;
}

export interface ServicePlanOrderStatusChangedTransition {
  readonly tenantId: string;
  readonly orderId: string;
  readonly status: ServicePlanOrderStatusChangedEventData['status'];
  readonly occurredAt: string;
  readonly transitionRef: string;
}

export interface RequestCompletedTransition {
  readonly tenantId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly supplyMode: CustomerWebhookSupplyMode;
  readonly status: RequestCompletedEventData['status'];
  readonly durationMs: number;
  readonly occurredAt: string;
  readonly transitionRef: string;
}

export interface UsageCompletedTransition {
  readonly tenantId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly supplyMode: CustomerWebhookSupplyMode;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly occurredAt: string;
  readonly transitionRef: string;
}

export interface WalletLowBalanceTransition {
  readonly tenantId: string;
  readonly currency: string;
  readonly balanceMinorUnits: number;
  readonly thresholdMinorUnits: number;
  readonly occurredAt: string;
  readonly transitionRef: string;
}

export interface ApiKeyExpiringTransition {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly expiresAt: string;
  readonly occurredAt: string;
  readonly transitionRef: string;
}

/**
 * G4.5 announcement fan-out (design: docs/remaining-capability-plan-2026-10-11.md
 * R8). One event per (announcement, tenant): the idempotency key is
 * `announcement:<announcementId>:<tenantId>`, so a crashed fan-out sweep
 * replays byte-for-byte and never duplicates. `occurredAt` is the
 * announcement's publish timestamp — deterministic per announcement, unlike
 * the worker's sweep time.
 */
export interface PlatformMaintenanceAnnouncementTransition {
  readonly tenantId: string;
  readonly announcementId: string;
  readonly kind: PlatformMaintenanceEventData['kind'];
  readonly severity: PlatformMaintenanceEventData['severity'];
  readonly title: string;
  readonly body: string;
  readonly publishAt: string;
  readonly unpublishAt: string | null;
  readonly occurredAt: string;
}

/**
 * The events table caps `octet_length(payload::text)` at
 * CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES and the egress signer caps the whole
 * envelope at the same size; the envelope adds ~200 bytes around the data
 * (event id, type, schema version, occurred_at, JSON syntax), so the data
 * budget keeps 256 bytes of headroom. Announcement bodies (up to 8000
 * characters, multi-byte UTF-8) can exceed the budget, so the body is
 * truncated deterministically at a code-point boundary: the same
 * announcement always yields the same stored payload and idempotent replays
 * match byte-for-byte. The console/API surface remains the full-content
 * channel; webhook consumers correlate via announcement_id.
 */
export const PLATFORM_MAINTENANCE_MAX_EVENT_DATA_BYTES = CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES - 256;

/** Truncate at a UTF-8 code-point boundary so the encoded length fits the budget. */
function truncateUtf8Bytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let result = '';
  let bytes = 0;
  for (const char of input) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

/** Schema v1 caps request.completed durations at one day (events.ts). */
const MAX_REQUEST_DURATION_MS = 86_400_000;

export interface CustomerWebhookEventProducer {
  refundStatusChanged(tx: SqlExecutor, input: RefundStatusChangedTransition): Promise<void>;
  servicePlanOrderStatusChanged(tx: SqlExecutor, input: ServicePlanOrderStatusChangedTransition): Promise<void>;
  requestCompleted(tx: SqlExecutor, input: RequestCompletedTransition): Promise<void>;
  usageCompleted(tx: SqlExecutor, input: UsageCompletedTransition): Promise<void>;
  walletLowBalance(tx: SqlExecutor, input: WalletLowBalanceTransition): Promise<void>;
  apiKeyExpiring(tx: SqlExecutor, input: ApiKeyExpiringTransition): Promise<void>;
  platformMaintenanceAnnouncement(tx: SqlExecutor, input: PlatformMaintenanceAnnouncementTransition): Promise<void>;
}

function transitionRef(value: unknown): string {
  if (typeof value !== 'string' || !TRANSITION_REF.test(value)) {
    throw new TypeError('transitionRef must be 1-96 safe ASCII characters');
  }
  return value;
}

export function createCustomerWebhookEventProducer(
  options: CustomerWebhookEventProducerOptions = {},
): CustomerWebhookEventProducer {
  const entitlement = options.entitlement ?? new PostgresCustomerWebhookEntitlementPolicy();
  const onEventDropped = options.onEventDropped;
  const reportDrop = (drop: CustomerWebhookEventDrop): void => {
    try {
      onEventDropped?.(drop);
    } catch {
      // Observability hooks must never break the business transaction.
    }
  };
  const dropped = (error: unknown): string | undefined =>
    error instanceof Error && DROPPED_EVENT_CODES.has(error.message) ? error.message : undefined;
  return Object.freeze({
    refundStatusChanged: async (tx: SqlExecutor, input: RefundStatusChangedTransition) => {
      const key = `refund.status_changed:${input.refundId}:${input.status}:${transitionRef(input.transitionRef)}`;
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: key,
            eventType: 'refund.status_changed',
            occurredAt: input.occurredAt,
            data: {
              refund_id: input.refundId,
              status: input.status,
              amount_minor_units: input.amountMinorUnits,
              currency: input.currency,
            },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({ eventType: 'refund.status_changed', tenantId: input.tenantId, resourceId: input.refundId, code });
      }
    },
    servicePlanOrderStatusChanged: async (tx: SqlExecutor, input: ServicePlanOrderStatusChangedTransition) => {
      const key = `service_plan_order.status_changed:${input.orderId}:${input.status}:${transitionRef(input.transitionRef)}`;
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: key,
            eventType: 'service_plan_order.status_changed',
            occurredAt: input.occurredAt,
            data: {
              service_plan_order_id: input.orderId,
              status: input.status,
            },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({
          eventType: 'service_plan_order.status_changed',
          tenantId: input.tenantId,
          resourceId: input.orderId,
          code,
        });
      }
    },
    requestCompleted: async (tx: SqlExecutor, input: RequestCompletedTransition) => {
      const ref = transitionRef(input.transitionRef);
      // A request older than the schema's one-day cap cannot be represented;
      // skip the notification instead of breaking the settlement transaction.
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs > MAX_REQUEST_DURATION_MS) {
        reportDrop({
          eventType: 'request.completed',
          tenantId: input.tenantId,
          resourceId: input.requestId,
          code: 'WEBHOOK_EVENT_UNREPRESENTABLE',
        });
        return;
      }
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: `request.completed:${input.requestId}:${input.status}:${ref}`,
            eventType: 'request.completed',
            occurredAt: input.occurredAt,
            data: {
              request_id: input.requestId,
              project_id: input.projectId,
              supply_mode: input.supplyMode,
              status: input.status,
              duration_ms: input.durationMs,
            },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({
          eventType: 'request.completed',
          tenantId: input.tenantId,
          resourceId: input.requestId,
          code,
        });
      }
    },
    usageCompleted: async (tx: SqlExecutor, input: UsageCompletedTransition) => {
      const ref = transitionRef(input.transitionRef);
      // Exact token counts beyond the safe-integer range cannot be represented
      // in schema v1; skip the notification instead of breaking settlement.
      if (!Number.isSafeInteger(input.inputTokens) || !Number.isSafeInteger(input.outputTokens)) {
        reportDrop({
          eventType: 'usage.completed',
          tenantId: input.tenantId,
          resourceId: input.requestId,
          code: 'WEBHOOK_EVENT_UNREPRESENTABLE',
        });
        return;
      }
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: `usage.completed:${input.requestId}:${ref}`,
            eventType: 'usage.completed',
            occurredAt: input.occurredAt,
            data: {
              request_id: input.requestId,
              project_id: input.projectId,
              supply_mode: input.supplyMode,
              input_tokens: input.inputTokens,
              output_tokens: input.outputTokens,
              total_tokens: input.inputTokens + input.outputTokens,
            },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({
          eventType: 'usage.completed',
          tenantId: input.tenantId,
          resourceId: input.requestId,
          code,
        });
      }
    },
    walletLowBalance: async (tx: SqlExecutor, input: WalletLowBalanceTransition) => {
      const ref = transitionRef(input.transitionRef);
      // Schema v1 requires 0 <= balance <= threshold with both safe integers.
      if (
        !Number.isSafeInteger(input.balanceMinorUnits) ||
        !Number.isSafeInteger(input.thresholdMinorUnits) ||
        input.thresholdMinorUnits < 1 ||
        input.balanceMinorUnits < 0 ||
        input.balanceMinorUnits > input.thresholdMinorUnits
      ) {
        reportDrop({
          eventType: 'wallet.low_balance',
          tenantId: input.tenantId,
          resourceId: input.tenantId,
          code: 'WEBHOOK_EVENT_UNREPRESENTABLE',
        });
        return;
      }
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: `wallet.low_balance:${input.tenantId}:${input.currency}:${ref}`,
            eventType: 'wallet.low_balance',
            occurredAt: input.occurredAt,
            data: {
              supply_mode: 'platform',
              balance_minor_units: input.balanceMinorUnits,
              threshold_minor_units: input.thresholdMinorUnits,
              currency: input.currency,
            },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({
          eventType: 'wallet.low_balance',
          tenantId: input.tenantId,
          resourceId: input.tenantId,
          code,
        });
      }
    },
    apiKeyExpiring: async (tx: SqlExecutor, input: ApiKeyExpiringTransition) => {
      const ref = transitionRef(input.transitionRef);
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: `api_key.expiring:${input.apiKeyId}:${ref}`,
            eventType: 'api_key.expiring',
            occurredAt: input.occurredAt,
            data: {
              api_key_id: input.apiKeyId,
              expires_at: input.expiresAt,
            },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({
          eventType: 'api_key.expiring',
          tenantId: input.tenantId,
          resourceId: input.apiKeyId,
          code,
        });
      }
    },
    platformMaintenanceAnnouncement: async (tx: SqlExecutor, input: PlatformMaintenanceAnnouncementTransition) => {
      const skeleton: PlatformMaintenanceEventData = {
        announcement_id: input.announcementId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: '',
        publish_at: input.publishAt,
        unpublish_at: input.unpublishAt,
      };
      const bodyBudget =
        PLATFORM_MAINTENANCE_MAX_EVENT_DATA_BYTES - Buffer.byteLength(JSON.stringify(skeleton), 'utf8');
      const body = truncateUtf8Bytes(input.body, Math.max(0, bodyBudget));
      // A body that truncates to nothing cannot honor the schema's non-empty
      // bound; skip the notification instead of breaking the fan-out sweep.
      if (body.length < 1) {
        reportDrop({
          eventType: 'platform.maintenance',
          tenantId: input.tenantId,
          resourceId: input.announcementId,
          code: 'WEBHOOK_EVENT_UNREPRESENTABLE',
        });
        return;
      }
      try {
        await enqueueCustomerWebhookEvent(
          tx,
          {
            tenantId: input.tenantId,
            idempotencyKey: `announcement:${input.announcementId}:${input.tenantId}`,
            eventType: 'platform.maintenance',
            occurredAt: input.occurredAt,
            data: { ...skeleton, body },
          },
          entitlement,
        );
      } catch (error) {
        const code = dropped(error);
        if (code === undefined) throw error;
        reportDrop({
          eventType: 'platform.maintenance',
          tenantId: input.tenantId,
          resourceId: input.announcementId,
          code,
        });
      }
    },
  });
}
