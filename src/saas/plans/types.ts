import type { MinorUnitInput } from '../billing/money.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { TenantContext } from '../identity/types.js';

export type ServicePlanStatus = 'draft' | 'published' | 'retired';
export type ServicePlanOperation = 'activation' | 'renewal';
export type ServicePlanOrderState =
  | 'pending'
  | 'paid'
  | 'fulfilling'
  | 'fulfilled'
  | 'cancelled'
  | 'reconciliation_pending';
export type ByokSubscriptionStatus = 'pending' | 'active' | 'superseded' | 'expired' | 'cancelled';

export interface ServicePlanRecord {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: ServicePlanStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A published BYOK product version. All commercial fields are append-only. */
export interface ServicePlanVersionRecord {
  readonly id: string;
  readonly planId: string;
  readonly version: number;
  readonly supplyMode: 'byok';
  readonly supplyProfileId: string;
  readonly allowedProviderIds: readonly string[];
  readonly allowedModels: readonly string[];
  readonly priceVersion: string;
  /** Decimal string because PostgreSQL stores the amount as bigint. */
  readonly priceMinorUnits: string;
  readonly currency: string;
  readonly termDays: number;
  readonly policyVersion: string;
  readonly status: ServicePlanStatus;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
}

/** Immutable order-time copy of every plan fact used for fulfillment. */
export interface ServicePlanSnapshotRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly planVersionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly allowedProviderIds: readonly string[];
  readonly allowedModels: readonly string[];
  readonly supplyMode: 'byok';
  readonly supplyProfileId: string;
  readonly priceVersion: string;
  readonly priceMinorUnits: string;
  readonly currency: string;
  readonly termDays: number;
  readonly policyVersion: string;
  readonly snapshotDigest: string;
  readonly createdAt: string;
}

export interface ServicePlanOrderRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly planVersionId: string;
  readonly operation: ServicePlanOperation;
  readonly renewalOfSubscriptionId: string | null;
  readonly clientRequestId: string;
  readonly state: ServicePlanOrderState;
  readonly subscriptionId: string | null;
  readonly snapshot: ServicePlanSnapshotRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paidAt: string | null;
  readonly fulfilledAt: string | null;
}

export interface ByokSubscriptionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly orderId: string;
  readonly snapshotId: string;
  readonly entitlementId: string;
  readonly previousSubscriptionId: string | null;
  readonly operation: ServicePlanOperation;
  readonly status: ByokSubscriptionStatus;
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly activatedAt: string | null;
  readonly supersededAt: string | null;
  readonly expiredAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshot: ServicePlanSnapshotRecord;
}

export interface CreateServicePlanOrderInput {
  readonly planVersionId: string;
  readonly clientRequestId: string;
  readonly operation?: ServicePlanOperation;
  /** Required for renewal and always resolved within the same tenant/project. */
  readonly renewalOfSubscriptionId?: string;
}

/**
 * Internal-only fulfillment evidence.  This is intentionally not a
 * `paid: boolean`: a payment worker must provide a verified settlement
 * identity and immutable matching facts.  No HTTP handler accepts this input.
 */
export interface VerifiedServicePlanFulfillmentInput {
  readonly kind: 'server_verified_service_plan_fulfillment';
  readonly orderId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly settlementId: string;
  readonly providerKey: string;
  readonly merchantId: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly currency: string;
  readonly fulfillmentReference: string;
  readonly fulfillmentEvidenceSha256: string;
  readonly verifiedAt: string | Date;
}

export interface FulfilledServicePlanResult {
  readonly order: ServicePlanOrderRecord;
  readonly subscription: ByokSubscriptionRecord;
  readonly entitlementId: string;
  readonly replayed: boolean;
}

export interface EffectiveByokEntitlement {
  readonly tenantId: string;
  readonly projectId: string;
  readonly entitlementId: string;
  readonly subscriptionId: string;
  readonly snapshot: ServicePlanSnapshotRecord;
  /** Immutable provider scope copied from the fulfilled service-plan snapshot. */
  readonly allowedProviderIds: readonly string[];
  readonly modelScopes: readonly string[];
  readonly entitlementAuthzVersion: number;
  readonly supplyProfileAuthzVersion: number;
  readonly modelScopeVersion: number;
}

export interface ByokPlanEntitlementRequestContext {
  readonly tenantId: string;
  readonly projectId: string;
}

export interface ByokPlanEntitlementResolveOptions {
  /** Reuse the gateway's repeatable-read transaction when one is already open. */
  readonly executor?: SqlExecutor;
  /** Reuse the authoritative database timestamp for all validity checks. */
  readonly now?: Date;
}

/** Narrow bridge used by request preparation to consume the plan snapshot scope. */
export interface ByokPlanEntitlementResolver {
  resolveCurrent(context: TenantContext): Promise<EffectiveByokEntitlement | null>;
  resolveBound(context: TenantContext, entitlementId: string): Promise<EffectiveByokEntitlement | null>;
  resolveBoundForRequest(
    context: ByokPlanEntitlementRequestContext,
    entitlementId: string,
    options?: ByokPlanEntitlementResolveOptions,
  ): Promise<EffectiveByokEntitlement | null>;
}

export interface ServicePlanServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type ServicePlanDatabase = Pick<SaasDatabase, 'query' | 'transaction'>;
export type ServicePlanTransactionExecutor = SqlExecutor;

export interface ServicePlanListInput {
  readonly includeRetired?: boolean;
}
