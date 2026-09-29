import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type {
  GatewayProtocol,
  ModelResolutionProvenance,
  SaasRouteTargetMode,
  SupplyMode,
} from '../gateway/contracts.js';

export type MeteringProtocol = GatewayProtocol;
export type MeteringSupplyMode = SupplyMode;
export type MeteringRouteTargetMode = SaasRouteTargetMode;

export type DispatchState = 'not_sent' | 'dispatching' | 'sent' | 'unknown';
export type DispatchAuthorityState = 'unbound' | 'bound';
export type AttemptResultState = 'pending' | 'succeeded' | 'failed' | 'unknown';
export type RequestResultState = AttemptResultState;
export type ReconciliationState = 'none' | 'pending' | 'resolved';
export type FinancialStatus = 'not_applicable' | 'pending' | 'settled' | 'released' | 'reconciliation_pending';

/** Integer input accepted at the boundary and canonicalized before persistence. */
export type ExactIntegerInput = bigint | number | string;
/** Canonical, non-negative PostgreSQL bigint text; null means unknown. */
export type ExactTokenCount = string | null;

export type PrincipalKind = 'member' | 'project_service';

export interface AuthorizationBindingInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly entitlementId: string;
  readonly supplyProfileId: string;
  readonly supplyProfileVersion: ExactIntegerInput;
  readonly modelScopeVersion: ExactIntegerInput;
  readonly supplyMode: MeteringSupplyMode;
  readonly principalKind: PrincipalKind;
  readonly principalId: string;
  readonly authzVersion: ExactIntegerInput;
  readonly entitlementVersion: ExactIntegerInput;
  readonly configVersion: ExactIntegerInput;
  /** Nullable only for pre-021 records; new admission must provide an exact active head. */
  readonly projectPolicyVersion?: ExactIntegerInput | null;
}

/**
 * Exact database-owned route authority selected before metering.  The fields
 * stay optional at the TypeScript boundary so callers can produce a precise
 * metering error; normalizeRequest/normalizeAttempt require all of them for
 * every new row.  Historical rows map them back to null.
 */
export interface RouteAuthoritySnapshotInput {
  readonly routeConfigId?: string | null;
  readonly routeConfigVersion?: ExactIntegerInput | null;
  readonly routePublicModelId?: string | null;
  readonly routePublicModelVersion?: ExactIntegerInput | null;
  readonly routeProtocol?: MeteringProtocol | null;
  readonly routeTargetMode?: MeteringRouteTargetMode | null;
  readonly routeUpstreamId?: string | null;
}

/**
 * Exact commercial authority selected before a new request/attempt is stored.
 * The boundary stays nullable only so historical rows and callers can produce
 * a precise fail-closed metering error; normalizeRequest/normalizeAttempt
 * require every field for new rows.
 */
export interface CommercialMeteringAuthoritySnapshotInput {
  readonly customerMeteringPolicyId?: string | null;
  readonly customerMeteringPolicyVersion?: ExactIntegerInput | null;
  readonly providerMeteringPolicyId?: string | null;
  readonly providerMeteringPolicyVersion?: ExactIntegerInput | null;
  readonly contractAttestationId?: string | null;
}

interface CreateAttemptBase extends RouteAuthoritySnapshotInput, CommercialMeteringAuthoritySnapshotInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly ordinal: number;
  readonly upstreamId: string;
  /** Exact provider account selected before dispatch; never a credential secret. */
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  /** In-memory provenance only; resolvedModel is never used to infer authority. */
  readonly modelResolution?: ModelResolutionProvenance;
  readonly protocol: MeteringProtocol;
  /** Server-owned transport facts from the validated prepared-request snapshot. */
  readonly clientProtocol?: MeteringProtocol;
  readonly providerProtocol?: MeteringProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  /** Migration 029 provenance; new bound writes fail closed when any value is absent. */
  readonly requestFingerprint?: string;
  readonly requestFingerprintVersion?: string;
  readonly payloadSha256?: string;
  readonly payloadCompilerVersion?: string;
  readonly usageEstimatorVersion?: string;
  readonly endpoint: string;
  /** Exact supply-profile mapping selected for this dispatch. */
  readonly dispatchProfileId: string;
  readonly supplyProfileAuthzVersion: ExactIntegerInput;
  /** Exact credential identity and owning credential-row epoch. */
  readonly credentialId: string;
  readonly credentialVersion: ExactIntegerInput;
  readonly credentialAuthzVersion: ExactIntegerInput;
  /** Owning provider-account epoch captured with the selection. */
  readonly accountAuthzVersion: ExactIntegerInput;
  /** Exact project policy selected by the request; absent legacy rows are non-dispatchable. */
  readonly projectPolicyVersion?: ExactIntegerInput | null;
  /** Null for BYOK observations with no platform supplier-cost snapshot. */
  readonly supplierCostVersion?: string | null;
  /** Exact customer price selected by the request; null for BYOK. */
  readonly customerPriceVersion?: string | null;
}

export interface TenantCreateAttemptInput extends CreateAttemptBase {
  /** BYOK dispatch authority is always owned by the requesting tenant. */
  readonly accountOwnerKind: 'tenant';
  /** Exact tenant profile-account mapping epoch. */
  readonly profileAccountAuthzVersion: ExactIntegerInput;
  readonly poolId?: never;
  readonly poolAuthzVersion?: never;
  readonly poolMemberAccountAuthzVersion?: never;
  readonly poolMemberAuthzVersion?: never;
  readonly poolGrantAuthzVersion?: never;
  readonly poolGrantProfileAuthzVersion?: never;
  readonly poolGrantPoolAuthzVersion?: never;
}

export interface PlatformCreateAttemptInput extends CreateAttemptBase {
  /** Platform dispatch authority is always owned by the platform. */
  readonly accountOwnerKind: 'platform';
  /** Exact platform pool, member, and tenant-profile grant epochs. */
  readonly poolId: string;
  readonly poolAuthzVersion: ExactIntegerInput;
  /** Independent epoch of the pool-member relationship itself. */
  readonly poolMemberAuthzVersion: ExactIntegerInput;
  /** Epoch of the bound platform account captured on that member. */
  readonly poolMemberAccountAuthzVersion: ExactIntegerInput;
  readonly poolGrantAuthzVersion: ExactIntegerInput;
  readonly poolGrantProfileAuthzVersion: ExactIntegerInput;
  readonly poolGrantPoolAuthzVersion: ExactIntegerInput;
  readonly profileAccountAuthzVersion?: never;
}

export type CreateAttemptInput = TenantCreateAttemptInput | PlatformCreateAttemptInput;

type InitialAttemptScope<T> = T extends { tenantId: string; requestId: string }
  ? Omit<T, 'tenantId' | 'requestId'>
  : never;

export type InitialAttemptInput = InitialAttemptScope<CreateAttemptInput>;

export interface CreateRequestInput
  extends AuthorizationBindingInput,
    RouteAuthoritySnapshotInput,
    CommercialMeteringAuthoritySnapshotInput {
  readonly publicModel: string;
  readonly protocol: MeteringProtocol;
  readonly endpoint: string;
  /** In-memory provenance only; no migration-backed audit/billing column exists yet. */
  readonly modelResolution?: ModelResolutionProvenance;
  /** Server-owned transport facts carried in-memory until the schema snapshot is extended. */
  readonly clientProtocol?: MeteringProtocol;
  readonly providerProtocol?: MeteringProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  /** This is hashed at the boundary; request or response bodies are never accepted for storage. */
  readonly requestFingerprint: string;
  /** Version of the canonical client-request representation used to produce the fingerprint. */
  readonly requestFingerprintVersion: string;
  /** Optional client material. Only its SHA-256/HMAC digest is persisted. */
  readonly idempotencyKey?: string | null;
  /** Fixed at admission for future platform pricing integration; no amount is stored here. */
  readonly customerPriceVersion?: string | null;
  readonly initialAttempt?: InitialAttemptInput;
}

export interface MeteringOperationOptions {
  /** Use an already-open transaction to compose request/meter facts with future services. */
  readonly executor?: SqlExecutor;
}

export interface IdempotencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly proxyKeyId: string;
  readonly keyDigest: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly requestId: string | null;
  readonly kind: 'active' | 'tombstone';
  readonly createdAt: string;
}

export interface CreateIdempotencyTombstoneInput {
  readonly tenantId: string;
  readonly proxyKeyId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
}

export interface RequestRecord extends Omit<AuthorizationBindingInput, 'projectPolicyVersion'> {
  readonly id: string;
  /** Null is retained for historical rows created before migration 021. */
  readonly projectPolicyVersion: string | null;
  readonly customerMeteringPolicyId: string | null;
  readonly customerMeteringPolicyVersion: string | null;
  readonly providerMeteringPolicyId: string | null;
  readonly providerMeteringPolicyVersion: string | null;
  readonly contractAttestationId: string | null;
  readonly routeConfigId: string | null;
  readonly routeConfigVersion: string | null;
  readonly routePublicModelId: string | null;
  readonly routePublicModelVersion: string | null;
  readonly routeProtocol: MeteringProtocol | null;
  readonly routeTargetMode: MeteringRouteTargetMode | null;
  readonly routeUpstreamId: string | null;
  readonly publicModel: string;
  readonly protocol: MeteringProtocol;
  readonly endpoint: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly idempotencyKeyDigest: string | null;
  readonly customerPriceVersion: string | null;
  readonly financialStatus: FinancialStatus;
  readonly resultState: RequestResultState;
  readonly reconciliationState: ReconciliationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateVersion: number;
  /** Present only when supplied by an upgraded in-memory admission caller. */
  readonly modelResolution?: ModelResolutionProvenance;
  readonly clientProtocol?: MeteringProtocol;
  readonly providerProtocol?: MeteringProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
}

/** Reconciliation event and outbox identifiers are coordinator-owned and intentionally absent here. */

export interface AttemptRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  /** Null is retained for historical rows created before migration 021. */
  readonly projectPolicyVersion: string | null;
  readonly customerPriceVersion: string | null;
  readonly customerMeteringPolicyId: string | null;
  readonly customerMeteringPolicyVersion: string | null;
  readonly providerMeteringPolicyId: string | null;
  readonly providerMeteringPolicyVersion: string | null;
  readonly contractAttestationId: string | null;
  readonly routeConfigId: string | null;
  readonly routeConfigVersion: string | null;
  readonly routePublicModelId: string | null;
  readonly routePublicModelVersion: string | null;
  readonly routeProtocol: MeteringProtocol | null;
  readonly routeTargetMode: MeteringRouteTargetMode | null;
  readonly ordinal: number;
  readonly upstreamId: string;
  /** Legacy rows remain readable but are explicitly not dispatchable. */
  readonly bindingState: 'legacy' | 'bound';
  /** 019 authority state; unbound rows cannot transition into dispatch. */
  readonly dispatchAuthorityState: DispatchAuthorityState;
  readonly accountOwnerKind: 'tenant' | 'platform' | null;
  readonly accountId: string | null;
  readonly providerId: string | null;
  readonly productId: string | null;
  readonly resolvedModel: string;
  /** Present only in the in-memory contract; historical/durable rows remain unmodified. */
  readonly modelResolution?: ModelResolutionProvenance;
  readonly clientProtocol?: MeteringProtocol;
  readonly providerProtocol?: MeteringProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  readonly requestFingerprint?: string;
  readonly requestFingerprintVersion?: string;
  readonly payloadSha256?: string;
  readonly payloadCompilerVersion?: string;
  readonly usageEstimatorVersion?: string;
  readonly protocol: MeteringProtocol;
  readonly endpoint: string | null;
  readonly supplierCostVersion: string | null;
  readonly dispatchProfileId: string | null;
  readonly supplyProfileAuthzVersion: string | null;
  readonly credentialId: string | null;
  readonly credentialVersion: string | null;
  readonly credentialAuthzVersion: string | null;
  readonly accountAuthzVersion: string | null;
  readonly poolId: string | null;
  readonly poolAuthzVersion: string | null;
  readonly poolMemberAccountAuthzVersion: string | null;
  readonly poolMemberAuthzVersion: string | null;
  readonly poolGrantAuthzVersion: string | null;
  readonly poolGrantProfileAuthzVersion: string | null;
  readonly poolGrantPoolAuthzVersion: string | null;
  readonly profileAccountAuthzVersion: string | null;
  /** Nullable until migration 024 evidence has been claimed; historical rows stay null. */
  readonly preparedEvidenceId?: string | null;
  readonly dispatchState: DispatchState;
  readonly resultState: AttemptResultState;
  readonly responseStarted: boolean;
  readonly responseStartedAt: string | null;
  readonly resultHttpStatus: number | null;
  readonly unknownReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateVersion: number;
}

export interface UsageValues {
  readonly inputTotal: ExactIntegerInput | null;
  readonly inputUncached: ExactIntegerInput | null;
  readonly cacheRead: ExactIntegerInput | null;
  readonly cacheWrite: ExactIntegerInput | null;
  readonly cacheWrite5m: ExactIntegerInput | null;
  readonly cacheWrite1h: ExactIntegerInput | null;
  readonly outputTotal: ExactIntegerInput | null;
  readonly reasoningOutput: ExactIntegerInput | null;
  readonly status: 'reported' | 'partial' | 'missing' | 'estimated';
  readonly source: 'upstream' | 'local-estimate' | 'legacy';
  readonly semanticsVersion: string;
  readonly measurementKind: 'snapshot' | 'delta';
  readonly billableBasis: 'exact' | 'estimated' | 'unknown' | 'not_billable';
}

export interface NormalizedUsageExact {
  readonly inputTotal: ExactTokenCount;
  readonly inputUncached: ExactTokenCount;
  readonly cacheRead: ExactTokenCount;
  readonly cacheWrite: ExactTokenCount;
  readonly cacheWrite5m: ExactTokenCount;
  readonly cacheWrite1h: ExactTokenCount;
  readonly outputTotal: ExactTokenCount;
  readonly reasoningOutput: ExactTokenCount;
  readonly status: UsageValues['status'];
  readonly source: UsageValues['source'];
  readonly semanticsVersion: string;
  readonly measurementKind: UsageValues['measurementKind'];
  readonly billableBasis: UsageValues['billableBasis'];
}

export interface RecordUsageEventInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplyMode: MeteringSupplyMode;
  /** Provider/event identity is hashed immediately and is never stored raw. */
  readonly eventKey?: string | null;
  readonly usage: UsageValues;
}

export interface UsageEventRecord extends NormalizedUsageExact {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplyMode: MeteringSupplyMode;
  readonly dedupeKeyDigest: string;
  readonly eventDigest: string;
  readonly createdAt: string;
}

export interface RecordUsageSettlementInput {
  readonly tenantId: string;
  readonly usageEventId: string;
  /** Hashed at the boundary; this is an idempotent effect key, not a raw secret. */
  readonly settlementKey: string;
  readonly settlementKind?: 'usage_recorded' | 'platform_cost_observed';
}

export interface UsageSettlementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly usageEventId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly settlementKeyDigest: string;
  readonly settlementDigest: string;
  readonly kind: 'usage_recorded' | 'platform_cost_observed';
  readonly createdAt: string;
}

export interface RequestAdmissionCreated {
  readonly kind: 'created';
  readonly request: RequestRecord;
  readonly idempotency: IdempotencyRecord | null;
  readonly initialAttempt: AttemptRecord | null;
}

export interface RequestAdmissionReplay {
  readonly kind: 'replayed';
  readonly request: RequestRecord;
  readonly idempotency: IdempotencyRecord;
}

export interface RequestAdmissionTombstone {
  readonly kind: 'tombstone';
  readonly idempotency: IdempotencyRecord;
}

export type RequestAdmission = RequestAdmissionCreated | RequestAdmissionReplay | RequestAdmissionTombstone;

export interface AttemptTransitionInput extends MeteringOperationOptions {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly expectedDispatchState: DispatchState;
  readonly expectedResultState: AttemptResultState;
  readonly expectedResponseStarted: boolean;
  readonly expectedStateVersion?: number;
  readonly dispatchState?: DispatchState;
  readonly resultState?: AttemptResultState;
  readonly responseStarted?: boolean;
  readonly resultHttpStatus?: number | null;
  readonly unknownReason?: string | null;
}

export interface RequestTransitionInput extends MeteringOperationOptions {
  readonly tenantId: string;
  readonly requestId: string;
  readonly expectedResultState: RequestResultState;
  readonly expectedReconciliationState: ReconciliationState;
  readonly expectedStateVersion?: number;
  readonly resultState?: RequestResultState;
  readonly reconciliationState?: ReconciliationState;
}

export interface FinancialTransitionInput extends MeteringOperationOptions {
  readonly tenantId: string;
  readonly requestId: string;
  readonly expectedFinancialStatus: FinancialStatus;
  readonly financialStatus: FinancialStatus;
  readonly expectedStateVersion?: number;
}

export interface RequestListOptions extends MeteringOperationOptions {
  readonly projectId?: string;
  readonly proxyKeyId?: string;
  readonly limit?: number;
}

export interface MeteringTransaction {
  readonly executor: SqlExecutor;
}

export type MeteringDatabase = SaasDatabase;
