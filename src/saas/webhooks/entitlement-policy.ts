import type { SqlExecutor } from '../db/types.js';
import {
  assertWebhookUuid,
  CUSTOMER_WEBHOOK_EVENT_TYPES,
  type CustomerWebhookEventDataByType,
  type CustomerWebhookEventType,
} from './events.js';
import type { CustomerWebhookEventEntitlementPolicy } from './postgres-store.js';

const ALL_EVENT_TYPES: ReadonlySet<string> = new Set<string>(CUSTOMER_WEBHOOK_EVENT_TYPES);

/**
 * Concrete C-5 entitlement authority (F2): the tenant policy row in
 * `saas_customer_webhook_tenant_policies` is the source of truth. There is no
 * plan-feature catalog for platform supply, so a missing row, a disabled
 * policy, or an event type outside `allowed_event_types` all deny — the check
 * fails closed inside the caller's business transaction.
 */
export class PostgresCustomerWebhookEntitlementPolicy implements CustomerWebhookEventEntitlementPolicy {
  async assertEntitled<T extends CustomerWebhookEventType>(input: {
    readonly tx: SqlExecutor;
    readonly tenantId: string;
    readonly eventType: T;
    readonly data: CustomerWebhookEventDataByType[T];
  }): Promise<void> {
    assertWebhookUuid(input.tenantId, 'tenantId');
    const result = await input.tx.query<{ enabled: unknown; allowed_event_types: unknown }>(
      `SELECT enabled, allowed_event_types
       FROM saas_customer_webhook_tenant_policies
       WHERE tenant_id = $1`,
      [input.tenantId],
    );
    const row = result.rows[0];
    if (row?.enabled !== true) throw new Error('WEBHOOK_ENTITLEMENT_DENIED');
    const allowed = storedAllowedEventTypes(row.allowed_event_types);
    if (!allowed.has(input.eventType)) throw new Error('WEBHOOK_ENTITLEMENT_DENIED');
  }
}

/** Stored whitelist values fail closed: malformed rows deny rather than widen. */
function storedAllowedEventTypes(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length < 1 || value.length > CUSTOMER_WEBHOOK_EVENT_TYPES.length) {
    throw new Error('Stored webhook policy allowed_event_types is invalid');
  }
  const allowed = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !ALL_EVENT_TYPES.has(entry) || allowed.has(entry)) {
      throw new Error('Stored webhook policy allowed_event_types is invalid');
    }
    allowed.add(entry);
  }
  return allowed;
}
