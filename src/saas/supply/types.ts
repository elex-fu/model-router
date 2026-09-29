import type { ProviderCredentialEnvelope } from '../credentials/provider-crypto.js';
import type { TenantContext } from '../identity/types.js';

export type ProviderSupplyOwnerKind = 'tenant' | 'platform';
export type ProviderSupplyMode = 'byok' | 'platform';

export type ProviderAccountStatus = 'pending' | 'active' | 'disabled' | 'revoked';
export type ProviderCredentialStatus = 'pending' | 'active' | 'disabled' | 'revoked';
export type ProviderValidationState = 'unverified' | 'verified' | 'failed';
export type ProviderCredentialVersionStatus = 'active' | 'retired' | 'revoked';
export type ProviderSupplyRelationStatus = 'active' | 'disabled' | 'revoked';

export type SupplyTimestamp = string | Date;

/**
 * The owner/supply-mode pair is deliberately discriminated.  A platform
 * record has no tenant identity, while a BYOK record always has one.
 */
export interface TenantProviderSupplyOwner {
  readonly ownerKind: 'tenant';
  readonly tenantId: string;
  readonly supplyMode: 'byok';
}

export interface PlatformProviderSupplyOwner {
  readonly ownerKind: 'platform';
  readonly tenantId: null;
  readonly supplyMode: 'platform';
}

export type ProviderSupplyOwner = TenantProviderSupplyOwner | PlatformProviderSupplyOwner;

export interface ProviderAccountReference {
  readonly ownerKind: ProviderSupplyOwnerKind;
  readonly tenantId: string | null;
  readonly accountId: string;
}

export interface ProviderCredentialReference extends ProviderAccountReference {
  readonly credentialId: string;
  readonly version?: number;
}

export interface ProviderRightsReference {
  readonly rightsId: string;
  readonly rightsVersion: number;
}

export interface ProviderCapabilityReference {
  readonly model: string;
  readonly endpoint: string;
  readonly version: number;
}

/** Explicit actor evidence required for auditable supply-relationship changes. */
export interface ProviderSupplyAuditContext {
  readonly actorUserId: string;
  readonly entryPoint: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export type ProviderCredentialRewrapAuditContext =
  | {
      readonly actorKind: 'user';
      readonly actorUserId: string;
      readonly entryPoint: string;
      readonly requestId: string;
      readonly sourceIp?: string | null;
      readonly userAgent?: string | null;
    }
  | {
      readonly actorKind: 'workload';
      readonly actorWorkloadId: string;
      readonly requestId: string;
    };

/** Non-secret audit facts persisted with an accepted wrapper revision. */
export interface ProviderCredentialWrapperRevisionRecord {
  readonly ownerKind: ProviderSupplyOwnerKind;
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly expectedWrappingRevision: number;
  readonly wrappingRevision: number;
  readonly operationId: string;
  readonly sourceKmsKeyId: string;
  readonly kmsKeyId: string;
  readonly contextSha256: string;
  readonly actorKind: 'user' | 'workload';
  readonly actorUserId: string | null;
  readonly actorWorkloadId: string | null;
  readonly requestId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
}

/** Server-approved inputs for one project-authorized tenant BYOK credential. */
export interface TenantByokProviderAccountInput {
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capability: ProviderCapabilityReference;
}

/** The caller supplies context, never an owner, tenant, or supply-profile ID. */
export interface CreateTenantByokCredentialInput {
  readonly context: TenantContext;
  readonly account: TenantByokProviderAccountInput;
  readonly secret: Uint8Array;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly audit: ProviderSupplyAuditContext;
}

export interface CreatedTenantByokCredential {
  readonly account: ProviderAccountRecord;
  readonly credential: ProviderCredentialRecord;
  readonly version: ProviderCredentialVersionRecord;
}

/** Immutable, non-secret authority snapshot used by the validation worker. */
export interface ProviderCredentialValidationJobInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly allowedModels: readonly string[];
  readonly target: ProviderCapabilityReference;
  /** SHA-256 idempotency key derived by the server from the credential identity. */
  readonly idempotencyKey: string;
}

export type ProviderCredentialValidationJobState = 'queued' | 'leased' | 'verified' | 'failed' | 'cancelled';

export interface ProviderCredentialValidationJobRecord extends ProviderCredentialValidationJobInput {
  readonly id: string;
  readonly state: ProviderCredentialValidationJobState;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly leaseUntil: string | null;
  readonly leaseGeneration: number;
  readonly lastErrorCode: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantProviderCredentialLifecycleInput {
  readonly context: TenantContext;
  readonly credential: ProviderCredentialReference & { readonly ownerKind: 'tenant'; readonly tenantId: string };
  readonly expectedAuthzVersion: number;
  readonly audit: ProviderSupplyAuditContext;
}

export interface ReplaceTenantProviderCredentialSecretInput {
  readonly context: TenantContext;
  readonly credential: ProviderCredentialReference & { readonly ownerKind: 'tenant'; readonly tenantId: string };
  readonly expectedVersion: number;
  readonly secret: Uint8Array;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly audit: ProviderSupplyAuditContext;
}

interface ProviderAccountInputCommon {
  readonly id?: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  /** The provider-rights purpose; it is also the KMS purpose bound to the envelope. */
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities?: readonly ProviderCapabilityReference[];
  /** Convenience form for an account with one capability anchor. */
  readonly capability?: ProviderCapabilityReference;
  readonly status?: ProviderAccountStatus;
  readonly validationState?: ProviderValidationState;
}

export type CreateProviderAccountInput =
  | (ProviderAccountInputCommon & {
      readonly ownerKind: 'tenant';
      readonly tenantId: string;
      readonly supplyMode?: 'byok';
    })
  | (ProviderAccountInputCommon & {
      readonly ownerKind: 'platform';
      readonly tenantId?: null;
      readonly supplyMode?: 'platform';
    });

export type ProviderAccountRecord = ProviderSupplyOwner & {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
  readonly status: ProviderAccountStatus;
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly authzVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
};

export interface PlatformPoolMemberRecord {
  readonly poolId: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  /** Epoch of the bound platform account. */
  readonly accountAuthzVersion: number;
  /** Independent epoch of this pool-member relationship. */
  readonly authzVersion: number;
  readonly status: ProviderSupplyRelationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
}

export interface PlatformPoolMemberStateChangeInput {
  readonly poolId: string;
  readonly accountId: string;
  readonly expectedAuthzVersion: number;
  readonly audit: ProviderSupplyAuditContext;
}

export interface RebindPlatformPoolMemberInput extends PlatformPoolMemberStateChangeInput {
  readonly newAccountId: string;
}

export interface CreateTenantProviderSupplyProfileAccountInput {
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly accountId: string;
  readonly effectiveAt?: SupplyTimestamp;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly audit?: ProviderSupplyAuditContext;
}

export interface TenantProviderSupplyProfileAccountRecord {
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: 'byok';
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly accountAuthzVersion: number;
  readonly status: ProviderSupplyRelationStatus;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly authzVersion: number;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
}

export interface TenantProviderSupplyProfileAccountStateChangeInput {
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly accountId: string;
  readonly expectedAuthzVersion: number;
  readonly audit?: ProviderSupplyAuditContext;
}

export interface RebindTenantProviderSupplyProfileAccountInput
  extends TenantProviderSupplyProfileAccountStateChangeInput {
  readonly newAccountId: string;
  readonly effectiveAt?: SupplyTimestamp;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly evidenceReference?: string;
  readonly evidenceSha256?: string;
}

export interface PlatformPoolGrantStateChangeInput {
  readonly poolId: string;
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly expectedAuthzVersion: number;
  readonly audit?: ProviderSupplyAuditContext;
}

export interface RebindPlatformPoolGrantInput extends PlatformPoolGrantStateChangeInput {
  readonly newPoolId?: string;
  readonly newSupplyProfileId?: string;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly evidenceReference?: string;
  readonly evidenceSha256?: string;
}

export interface ProviderAccountListFilter {
  readonly ownerKind?: ProviderSupplyOwnerKind;
  readonly tenantId?: string;
  readonly providerId?: string;
  readonly productId?: string;
  readonly status?: ProviderAccountStatus;
  readonly validationState?: ProviderValidationState;
}

export interface CreateProviderCredentialInput {
  readonly account: ProviderAccountReference;
  readonly id?: string;
  readonly credentialType?: string;
  /** The secret is accepted only for sealing and is never returned or persisted as plaintext. */
  readonly secret: Uint8Array;
  readonly expiresAt?: SupplyTimestamp | null;
}

export interface ReplaceProviderCredentialSecretInput {
  readonly credential: ProviderCredentialReference;
  readonly expectedVersion: number | null;
  /** The secret is accepted only for sealing and is never returned or persisted as plaintext. */
  readonly secret: Uint8Array;
  readonly expiresAt?: SupplyTimestamp | null;
}

export type ProviderCredentialRecord = ProviderSupplyOwner & {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly status: ProviderCredentialStatus;
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly currentVersion: number | null;
  readonly expiresAt: string | null;
  readonly authzVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
};

/** Metadata safe for management/list/read responses.  It contains no envelope bytes. */
export interface ProviderCredentialVersionRecord {
  readonly ownerKind: ProviderSupplyOwnerKind;
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly version: number;
  readonly status: ProviderCredentialVersionStatus;
  readonly envelopeSchemaVersion: number;
  readonly contextVersion: number;
  readonly algorithm: string;
  readonly kmsPurpose: string;
  readonly wrappingRevision: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly retiredAt: string | null;
  readonly revokedAt: string | null;
}

export interface ProviderCredentialWriteResult {
  readonly credential: ProviderCredentialRecord;
  readonly version: ProviderCredentialVersionRecord;
}

export interface ProviderCredentialListFilter {
  readonly account?: ProviderAccountReference;
  readonly ownerKind?: ProviderSupplyOwnerKind;
  readonly tenantId?: string;
  readonly status?: ProviderCredentialStatus;
  readonly validationState?: ProviderValidationState;
}

/** Internal persistence shape; the envelope is never part of a public DTO. */
export interface StoredProviderCredentialVersion extends ProviderCredentialVersionRecord {
  readonly envelope: ProviderCredentialEnvelope;
  readonly kmsKeyId: string;
}

/**
 * The only caller-supplied handle accepted by the dispatch credential
 * boundary.  All authority facts are read from the database proof snapshot;
 * caller-supplied workload, request, account, or credential fields are not
 * part of this contract.
 */
export interface ProviderCredentialAccessGrant {
  readonly evidenceId: string;
}

/** The dispatch state in which a provider credential may be unsealed. */
export type ProviderCredentialDispatchState = 'not_sent' | 'dispatching' | 'sent' | 'unknown';
export type ProviderCredentialDispatchResultState = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type ProviderCredentialDispatchProtocol = 'anthropic' | 'openai' | 'gemini' | 'responses';
export type ProviderCredentialDispatchTargetMode = 'tenant_account' | 'platform_pool';

/** Non-secret authority facts copied independently from evidence and attempt rows. */
export interface ProviderCredentialDispatchBinding {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly supplyMode: ProviderSupplyMode;
  readonly accountOwnerKind: ProviderSupplyOwnerKind;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: ProviderCredentialDispatchProtocol;
  readonly endpoint: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: number;
  readonly routePublicModelId: string;
  readonly routePublicModelVersion: number;
  readonly routeProtocol: ProviderCredentialDispatchProtocol;
  readonly routeTargetMode: ProviderCredentialDispatchTargetMode;
  readonly routeUpstreamId: string;
  readonly upstreamId: string;
  readonly resolvedModel: string;
  readonly dispatchProfileId: string;
  readonly supplyProfileAuthzVersion: number;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly credentialAuthzVersion: number;
  readonly accountAuthzVersion: number;
  readonly profileAccountAuthzVersion: number | null;
  readonly poolId: string | null;
  readonly poolAuthzVersion: number | null;
  readonly poolMemberAccountAuthzVersion: number | null;
  readonly poolMemberAuthzVersion: number | null;
  readonly poolGrantAuthzVersion: number | null;
  readonly poolGrantProfileAuthzVersion: number | null;
  readonly poolGrantPoolAuthzVersion: number | null;
}

export interface ProviderCredentialDispatchEvidence extends ProviderCredentialDispatchBinding {
  readonly evidenceId: string;
  readonly supplyProfileId: string;
  readonly supplyProfileVersion: number;
  readonly publicModel: string;
  readonly status: 'registered' | 'claimed';
  readonly claimedAt: string | null;
  readonly claimedAttemptId: string | null;
  readonly dispatchDeadline: string;
  readonly expiresAt: string;
}

export interface ProviderCredentialDispatchAttempt extends ProviderCredentialDispatchBinding {
  readonly preparedEvidenceId: string | null;
  readonly dispatchAuthorityState: 'unbound' | 'bound';
  readonly dispatchState: ProviderCredentialDispatchState;
  readonly resultState: ProviderCredentialDispatchResultState;
  readonly responseStarted: boolean;
}

/** Current provider-account facts required to derive the KMS context. */
export type ProviderCredentialDispatchAccountSnapshot = ProviderSupplyOwner & {
  readonly id: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly purpose: string;
  readonly status: ProviderAccountStatus;
  readonly validationState: ProviderValidationState;
  readonly authzVersion: number;
};

export type ProviderCredentialDispatchCredentialSnapshot = ProviderSupplyOwner & {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly status: ProviderCredentialStatus;
  readonly validationState: ProviderValidationState;
  readonly currentVersion: number | null;
  readonly expiresAt: string | null;
  readonly authzVersion: number;
};

export interface ProviderCredentialDispatchProfileSnapshot {
  readonly tenantId: string;
  readonly id: string;
  readonly supplyMode: ProviderSupplyMode;
  readonly status: ProviderSupplyRelationStatus;
  readonly authzVersion: number;
}

export interface ProviderCredentialDispatchProfileAccountSnapshot {
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: 'byok';
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly accountAuthzVersion: number;
  readonly status: ProviderSupplyRelationStatus;
  readonly authzVersion: number;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

export interface ProviderCredentialDispatchPoolSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly productId: string;
  readonly status: ProviderAccountStatus;
  readonly validationState: ProviderValidationState;
  readonly authzVersion: number;
}

export interface ProviderCredentialDispatchPoolMemberSnapshot {
  readonly poolId: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly accountAuthzVersion: number;
  readonly authzVersion: number;
  readonly status: ProviderSupplyRelationStatus;
}

export interface ProviderCredentialDispatchPoolGrantSnapshot {
  readonly poolId: string;
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: 'platform';
  readonly profileAuthzVersion: number;
  readonly poolAuthzVersion: number;
  readonly authzVersion: number;
  readonly status: ProviderSupplyRelationStatus;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

export interface ProviderCredentialDispatchClaimAuditSnapshot {
  readonly action: 'saas_prepared_request_evidence.claimed';
  readonly targetType: 'saas_prepared_request_evidence';
  readonly targetId: string;
}

/**
 * A database-owned, single-snapshot proof.  Implementations must read all
 * members atomically in a short transaction (or one statement), return no
 * row for any mismatch, and never hold that transaction while KMS or the
 * callback executes.  It contains ciphertext/envelope metadata only.
 */
export interface ProviderCredentialDispatchProof {
  readonly evidence: ProviderCredentialDispatchEvidence;
  readonly attempt: ProviderCredentialDispatchAttempt;
  readonly account: ProviderCredentialDispatchAccountSnapshot;
  readonly credential: ProviderCredentialDispatchCredentialSnapshot;
  readonly version: StoredProviderCredentialVersion;
  readonly profile: ProviderCredentialDispatchProfileSnapshot;
  readonly profileAccount: ProviderCredentialDispatchProfileAccountSnapshot | null;
  readonly pool: ProviderCredentialDispatchPoolSnapshot | null;
  readonly poolMember: ProviderCredentialDispatchPoolMemberSnapshot | null;
  readonly poolGrant: ProviderCredentialDispatchPoolGrantSnapshot | null;
  readonly claimAudit: ProviderCredentialDispatchClaimAuditSnapshot;
}

/**
 * Server-owned proof source used by ProviderCredentialAccessService.  The
 * implementation is responsible for the atomic DB snapshot contract above;
 * a caller cannot authorize itself by constructing this object.
 */
export interface ProviderCredentialDispatchProofReader {
  readDispatchProof(evidenceId: string): Promise<ProviderCredentialDispatchProof | null>;
}
