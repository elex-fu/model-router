import type { TenantContext } from '../identity/types.js';

/** Stage-1 internal contract; no public index, HTTP or runtime registration. */
export interface AuditedCredentialValidationRequeueCommand {
  readonly jobId: string;
  readonly expectedCredentialAuthzVersion: number;
  readonly expectedLeaseGeneration: number;
  readonly expectedSnapshotSha256: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly reasonCode: 'target_approved' | 'retry_provider_validation';
  /** Bounded non-secret operational explanation, never a destination or credential. */
  readonly reason: string;
}

/** Obtained by the authenticated server transport, NEVER deserialized from a command. */
export interface CredentialValidationRequeueActor {
  readonly context: Readonly<TenantContext>;
  readonly sessionToken: string;
}

export const CREDENTIAL_VALIDATION_MANUAL_CYCLE_ATTEMPT_LIMIT = 5;
export const CREDENTIAL_VALIDATION_REQUEUE_DIGEST_DOMAIN = 'model-router-credential-validation-requeue-v1';
export const CREDENTIAL_VALIDATION_REQUEUE_AUDIT_ENTRY_POINT = 'credential-validation-requeue';

export interface AuditedCredentialValidationRequeueReceipt {
  readonly requestId: string;
  readonly cycleId: string;
  readonly jobId: string;
  readonly auditEventId: string;
  readonly requestDigest: string;
  readonly targetEvidenceSha256: string;
  readonly leaseGeneration: number;
  readonly cycleStartAttemptCount: number;
  readonly cycleAttemptLimit: number;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

export type CredentialValidationRequeueErrorCode =
  | 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'SCHEMA_NOT_READY'
  | 'STATE_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'TARGET_NOT_AUTHORIZED' | 'STORAGE_UNAVAILABLE';

export class CredentialValidationRequeueError extends Error {
  constructor(readonly code: CredentialValidationRequeueErrorCode) {
    super(`Credential validation requeue refused: ${code}`);
    this.name = 'CredentialValidationRequeueError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
