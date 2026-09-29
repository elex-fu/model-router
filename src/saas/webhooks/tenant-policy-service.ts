import { randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../db/types.js';
import { assertWebhookUuid } from './events.js';

export interface CustomerWebhookTenantPolicyInput {
  readonly enabled: boolean;
  readonly maxActiveEndpoints: number;
  readonly maxEventsPerMinute: number;
  readonly maxPendingDeliveries: number;
}

export interface CustomerWebhookTenantPolicyActor {
  readonly actorUserId: string;
  readonly requestId: string;
}

export interface CustomerWebhookTenantPolicy extends CustomerWebhookTenantPolicyInput {
  readonly tenantId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

const MAX_REQUEST_ID_LENGTH = 255;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validatePolicy(input: CustomerWebhookTenantPolicyInput): void {
  if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  if (
    !Number.isSafeInteger(input.maxActiveEndpoints) ||
    input.maxActiveEndpoints < 1 ||
    input.maxActiveEndpoints > 100
  ) {
    throw new RangeError('maxActiveEndpoints must be between 1 and 100');
  }
  if (
    !Number.isSafeInteger(input.maxEventsPerMinute) ||
    input.maxEventsPerMinute < 1 ||
    input.maxEventsPerMinute > 10_000
  ) {
    throw new RangeError('maxEventsPerMinute must be between 1 and 10000');
  }
  if (
    !Number.isSafeInteger(input.maxPendingDeliveries) ||
    input.maxPendingDeliveries < 1 ||
    input.maxPendingDeliveries > 100_000
  ) {
    throw new RangeError('maxPendingDeliveries must be between 1 and 100000');
  }
}

function positive(value: unknown, field: string, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`Stored webhook policy ${field} is invalid`);
  return number;
}

/** Platform-side tenant quota provisioning. Missing policies remain fail-closed. */
export class CustomerWebhookTenantPolicyService {
  constructor(private readonly database: SaasDatabase) {}

  async configure(
    actor: CustomerWebhookTenantPolicyActor,
    tenantId: string,
    input: CustomerWebhookTenantPolicyInput,
  ): Promise<CustomerWebhookTenantPolicy> {
    assertWebhookUuid(actor.actorUserId, 'actorUserId');
    assertWebhookUuid(tenantId, 'tenantId');
    if (
      typeof actor.requestId !== 'string' ||
      actor.requestId.length < 1 ||
      actor.requestId.length > MAX_REQUEST_ID_LENGTH ||
      actor.requestId.trim() !== actor.requestId ||
      hasControlCharacters(actor.requestId)
    ) {
      throw new TypeError('requestId is invalid');
    }
    validatePolicy(input);
    return this.database.transaction(async (tx) => {
      const role = await tx.query(
        `SELECT 1 FROM saas_platform_role_assignments
         WHERE user_id = $1 AND role IN ('superadmin','operations') LIMIT 1`,
        [actor.actorUserId],
      );
      if (role.rowCount !== 1) throw new Error('WEBHOOK_POLICY_FORBIDDEN');
      await tx.query(
        `SELECT tenant_id FROM saas_customer_webhook_tenant_policies
         WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      const counts = await tx.query<{ active_endpoints: unknown; pending_deliveries: unknown }>(
        `SELECT
           (SELECT count(*) FROM saas_customer_webhook_endpoints
            WHERE tenant_id = $1 AND state <> 'revoked') AS active_endpoints,
           COALESCE((SELECT pending_deliveries FROM saas_customer_webhook_tenant_usage
                     WHERE tenant_id = $1), 0) AS pending_deliveries`,
        [tenantId],
      );
      const row = counts.rows[0];
      const activeEndpoints = Number(row?.active_endpoints ?? 0);
      const pendingDeliveries = Number(row?.pending_deliveries ?? 0);
      if (activeEndpoints > input.maxActiveEndpoints || pendingDeliveries > input.maxPendingDeliveries) {
        throw new Error('WEBHOOK_POLICY_BELOW_CURRENT_USAGE');
      }
      const auditId = randomUUID();
      const audit = await tx.query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, entry_point, request_id)
         VALUES ($1, $2, $3, 'customer_webhook.tenant_policy_updated', 'customer_webhook_tenant_policy', $2, 'platform_admin', $4)`,
        [auditId, tenantId, actor.actorUserId, actor.requestId],
      );
      if (audit.rowCount !== 1) throw new Error('WEBHOOK_AUDIT_WRITE_FAILED');
      const result = await tx.query<{
        tenant_id: unknown;
        enabled: unknown;
        max_active_endpoints: unknown;
        max_events_per_minute: unknown;
        max_pending_deliveries: unknown;
        revision: unknown;
        updated_at: unknown;
      }>(
        `INSERT INTO saas_customer_webhook_tenant_policies
           (tenant_id, enabled, max_active_endpoints, max_events_per_minute,
            max_pending_deliveries, revision, updated_by_user_id, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
         ON CONFLICT (tenant_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               max_active_endpoints = EXCLUDED.max_active_endpoints,
               max_events_per_minute = EXCLUDED.max_events_per_minute,
               max_pending_deliveries = EXCLUDED.max_pending_deliveries,
               revision = saas_customer_webhook_tenant_policies.revision + 1,
               updated_by_user_id = EXCLUDED.updated_by_user_id,
               audit_event_id = EXCLUDED.audit_event_id,
               updated_at = clock_timestamp()
         RETURNING tenant_id, enabled, max_active_endpoints, max_events_per_minute,
                   max_pending_deliveries, revision, updated_at`,
        [
          tenantId,
          input.enabled,
          input.maxActiveEndpoints,
          input.maxEventsPerMinute,
          input.maxPendingDeliveries,
          actor.actorUserId,
          auditId,
        ],
      );
      if (result.rowCount !== 1) throw new Error('WEBHOOK_POLICY_WRITE_FAILED');
      const stored = result.rows[0];
      if (!stored || typeof stored.enabled !== 'boolean') throw new Error('Stored webhook policy is invalid');
      const updatedAt = stored.updated_at instanceof Date ? stored.updated_at.toISOString() : String(stored.updated_at);
      return Object.freeze({
        tenantId,
        enabled: stored.enabled,
        maxActiveEndpoints: positive(stored.max_active_endpoints, 'max_active_endpoints', 100),
        maxEventsPerMinute: positive(stored.max_events_per_minute, 'max_events_per_minute', 10_000),
        maxPendingDeliveries: positive(stored.max_pending_deliveries, 'max_pending_deliveries', 100_000),
        revision: positive(stored.revision, 'revision', Number.MAX_SAFE_INTEGER),
        updatedAt,
      });
    });
  }
}
