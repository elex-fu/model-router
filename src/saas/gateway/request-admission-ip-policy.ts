import type { SqlExecutor } from '../db/types.js';
import { isIpAllowed } from '../keys/ip-policy.js';
import type { ClientAddressResolution } from './client-address.js';

export type RequestAdmissionIpPolicyResult = 'allow' | 'storage_failure' | 'caller_denied';

export interface RequestAdmissionIpPolicyScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
}

/** Shared policy semantics for new admission and current-authority canonical replay. */
export function validateRequestAdmissionIpPolicy(
  rows: readonly Record<string, unknown>[],
  clientAddress: ClientAddressResolution | null | undefined,
): RequestAdmissionIpPolicyResult {
  if (!Array.isArray(rows) || rows.length > 1) return 'storage_failure';
  if (rows.length === 0) return 'allow'; // Missing pre-080 head preserves disabled behavior.
  const policy = rows[0];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return 'storage_failure';
  try {
    // Migration 080 requires disabled heads to have empty rules. A malformed
    // persisted head must never be treated as an absent/disabled policy.
    if (policy.mode === 'disabled') {
      return Array.isArray(policy.rules) && policy.rules.length === 0 ? 'allow' : 'storage_failure';
    }
    const address = clientAddress?.status === 'resolved' ? clientAddress.address : null;
    return address !== null && isIpAllowed(address, { mode: policy.mode, rules: policy.rules })
      ? 'allow' : 'caller_denied';
  } catch {
    return 'storage_failure';
  }
}

/** Caller owns the authorization transaction and matching API-key shared fence. */
export async function readRequestAdmissionIpPolicy(
  executor: SqlExecutor,
  scope: RequestAdmissionIpPolicyScope,
  clientAddress: ClientAddressResolution | null | undefined,
): Promise<RequestAdmissionIpPolicyResult> {
  try {
    const result = await executor.query<Record<string, unknown>>(
      `/* postgres-request-admission:key-ip-policy */ SELECT mode, rules FROM saas_api_key_ip_policies
       WHERE tenant_id = $1 AND project_id = $2 AND key_id = $3 LIMIT 2`,
      [scope.tenantId, scope.projectId, scope.proxyKeyId],
    );
    if (!result || !Array.isArray(result.rows)) return 'storage_failure';
    return validateRequestAdmissionIpPolicy(result.rows, clientAddress);
  } catch {
    return 'storage_failure';
  }
}
