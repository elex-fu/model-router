import { randomUUID } from 'node:crypto';
import { PaymentError } from './errors.js';
import type { PaymentRefundOperationsPort } from './types.js';

const KNOWN_PLATFORM_ROLES = new Set(['superadmin', 'security', 'finance', 'operations', 'support-readonly']);

interface PlatformRefundAuthorityRow {
  readonly session_id: unknown;
  readonly roles: unknown;
}

function sameRoleSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((role, index) => role === sortedRight[index]);
}

/** Production operations port: current finance RBAC is checked inside the refund transaction. */
export function createPlatformPaymentRefundOperations(
  options: { readonly idFactory?: () => string } = {},
): PaymentRefundOperationsPort {
  const idFactory = options.idFactory ?? randomUUID;
  return {
    async authorize(input, executor) {
      if (
        !input.sessionId ||
        !Array.isArray(input.actorRoles) ||
        input.actorRoles.length === 0 ||
        input.actorRoles.some((role) => typeof role !== 'string' || !KNOWN_PLATFORM_ROLES.has(role)) ||
        new Set(input.actorRoles).size !== input.actorRoles.length
      ) {
        throw new PaymentError('REFUND_FORBIDDEN');
      }

      await executor.query(`SET LOCAL lock_timeout = '2s'`);
      await executor.query(`SET LOCAL statement_timeout = '10s'`);
      await executor.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`, [input.actorId]);
      const result = await executor.query<PlatformRefundAuthorityRow>(
        `SELECT s.id AS session_id,
                COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), ARRAY[]::text[]) AS roles
         FROM saas_platform_sessions s
         JOIN saas_users u ON u.id = s.user_id
         JOIN saas_mfa_credentials c
           ON c.id = s.credential_id AND c.user_id = s.user_id
         LEFT JOIN saas_platform_role_assignments r ON r.user_id = u.id
         WHERE s.id = $1 AND s.user_id = $2
           AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
           AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
           AND c.kind = 'totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
         GROUP BY s.id`,
        [input.sessionId, input.actorId],
      );
      const authority = result.rows[0];
      const roles = authority?.roles;
      if (
        authority?.session_id !== input.sessionId ||
        !Array.isArray(roles) ||
        roles.length === 0 ||
        roles.some((role) => typeof role !== 'string' || !KNOWN_PLATFORM_ROLES.has(role)) ||
        !sameRoleSet(roles as string[], input.actorRoles) ||
        (!roles.includes('finance') && !roles.includes('superadmin'))
      ) {
        throw new PaymentError('REFUND_FORBIDDEN');
      }
      return { authorizationRef: idFactory() };
    },

    async recordAudit(executor, input) {
      await executor.query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
         VALUES ($1, $2, $3, $4, 'saas_payment_refund', $5, now(), 'platform_payments')`,
        [idFactory(), input.tenantId, input.actorId, input.action, input.refundId],
      );
    },
  };
}
