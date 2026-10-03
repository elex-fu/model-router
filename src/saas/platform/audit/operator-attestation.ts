import type { PlatformAuditEventRecord, PlatformAuditOperatorAttestation } from './types.js';

export const MFA_OPERATOR_METADATA_MAX_BYTES = 1024;
export const MFA_OPERATOR_ENTRY_POINT = 'trusted_operator_cli:platform_mfa_enroll';
export const MFA_OPERATOR_ISSUED_ACTION = 'platform_mfa.enrollment_token.issued';
export const MFA_OPERATOR_DENIED_ACTION = 'platform_mfa.enrollment_token.denied';
export const MFA_OPERATOR_USER_TARGET = 'platform_mfa_enrollment_user';
export const MFA_OPERATOR_DIGEST_TARGET = 'platform_mfa_enrollment_email_digest';

const METADATA_KEYS = new Set([
  'audience', 'actor_kind', 'workload_id', 'database_role', 'operator_id', 'reason_code', 'outcome',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * This is an allow-listed declaration, not identity verification. Never return
 * the stored JSON, an email digest, or another field from the generic UA slot.
 */
export function projectMfaOperatorAttestation(
  event: Pick<PlatformAuditEventRecord, 'tenantId' | 'actorId' | 'action' | 'entityType' | 'entityId' | 'entryPoint'>,
  metadata: unknown,
): PlatformAuditOperatorAttestation | undefined {
  if (event.tenantId !== null || event.actorId !== null || event.entryPoint !== MFA_OPERATOR_ENTRY_POINT
    || (event.action !== MFA_OPERATOR_ISSUED_ACTION && event.action !== MFA_OPERATOR_DENIED_ACTION)
    || (event.entityType !== MFA_OPERATOR_USER_TARGET && event.entityType !== MFA_OPERATOR_DIGEST_TARGET)
    || typeof metadata !== 'string' || metadata.length > MFA_OPERATOR_METADATA_MAX_BYTES
    || Buffer.byteLength(metadata, 'utf8') > MFA_OPERATOR_METADATA_MAX_BYTES) return undefined;

  let value: unknown;
  try { value = JSON.parse(metadata); } catch { return undefined; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== METADATA_KEYS.size || keys.some(key => !METADATA_KEYS.has(key))) return undefined;
  if (candidate.audience !== 'platform' || candidate.actor_kind !== 'trusted_operator'
    || candidate.workload_id !== 'saas:platform-mfa-enroll'
    || candidate.database_role !== 'model_router_saas_control_plane'
    || typeof candidate.operator_id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(candidate.operator_id)) return undefined;
  const reasonCode = candidate.reason_code;
  const outcome = candidate.outcome;
  if (reasonCode !== 'initial-enrollment' && reasonCode !== 'approved-enrollment') return undefined;
  if (outcome !== 'issued' && outcome !== 'target-unavailable'
    && outcome !== 'verified-totp-present' && outcome !== 'enrollment-pending') return undefined;
  if ((event.action === MFA_OPERATOR_ISSUED_ACTION) !== (outcome === 'issued')) return undefined;
  if (event.entityType === MFA_OPERATOR_USER_TARGET) {
    if (typeof event.entityId !== 'string' || !UUID.test(event.entityId)) return undefined;
  } else if (outcome !== 'target-unavailable' || typeof event.entityId !== 'string'
    || !/^[0-9a-f]{64}$/.test(event.entityId)) return undefined;

  // All accepted values are simple strings. Inspect encoded property names as
  // well, rejecting duplicate/escaped duplicate keys instead of last-key-wins.
  try {
    const encodedKeys = [...metadata.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)]
      .map(match => JSON.parse(match[0].slice(0, match[0].lastIndexOf(':')).trim()) as unknown);
    if (encodedKeys.length !== METADATA_KEYS.size || new Set(encodedKeys).size !== METADATA_KEYS.size
      || encodedKeys.some(key => typeof key !== 'string' || !METADATA_KEYS.has(key))) return undefined;
  } catch { return undefined; }

  return { operatorId: candidate.operator_id, reasonCode, outcome };
}
