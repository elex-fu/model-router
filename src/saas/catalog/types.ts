export type CatalogTimestamp = string | Date;

export type ProviderProductStatus = 'active' | 'disabled';

export type PublicModelStatus = 'active' | 'disabled';

export type ProviderCapabilitySupportLevel = 'supported' | 'limited' | 'unsupported';

export type ProviderCapabilityValidationState = 'unverified' | 'verified' | 'failed';

export type ProviderCapabilityDiscoverySource = 'preset' | 'manual';

export type ProviderRightsStatus = 'draft' | 'active' | 'revoked';

export type ProviderCatalogEvidence = Readonly<{
  evidenceReference: string;
  evidenceSha256: string;
}>;

export interface ProviderProductRecord {
  readonly providerId: string;
  readonly productId: string;
  readonly displayName: string;
  readonly status: ProviderProductStatus;
  readonly createdAt: string;
}

export interface RegisterProviderProductInput {
  readonly providerId: string;
  readonly productId: string;
  readonly displayName: string;
  readonly status?: ProviderProductStatus;
}

export interface PublicModelAliasVersionRecord {
  readonly publicModelId: string;
  readonly version: number;
  readonly alias: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpointScope: readonly string[];
  readonly status: PublicModelStatus;
  readonly createdAt: string;
}

export interface RegisterPublicModelAliasInput {
  readonly publicModelId?: string;
  readonly alias: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpointScope: readonly string[];
  readonly status?: PublicModelStatus;
}

export interface RegisterPublicModelAliasVersionInput {
  readonly publicModelId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpointScope: readonly string[];
  readonly status?: PublicModelStatus;
}

export interface ProviderCapabilityRecord extends ProviderCatalogEvidence {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: string;
  readonly version: number;
  readonly supportLevel: ProviderCapabilitySupportLevel;
  readonly validationState: ProviderCapabilityValidationState;
  readonly evidenceVersion: string;
  readonly discoverySource: ProviderCapabilityDiscoverySource;
  readonly createdAt: string;
}

export interface RegisterProviderCapabilityInput extends ProviderCatalogEvidence {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: string;
  readonly supportLevel: ProviderCapabilitySupportLevel;
  readonly validationState: ProviderCapabilityValidationState;
  readonly evidenceVersion: string;
  readonly discoverySource: ProviderCapabilityDiscoverySource;
}

export interface ProviderRightsRecord extends ProviderCatalogEvidence {
  readonly rightsId: string;
  readonly version: number;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly region: string;
  readonly purpose: string;
  readonly modelScope: readonly string[];
  readonly endpointScope: readonly string[];
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly approvalReference: string;
  readonly status: ProviderRightsStatus;
  readonly createdAt: string;
}

/**
 * Optional caller-supplied audit context for governed Provider Rights writes.
 *
 * The context is deliberately metadata-only. It never carries credentials,
 * provider payloads, or an audit action/target that a caller could override.
 */
export interface ProviderRightsAuditContext {
  readonly actorUserId: string;
  readonly entryPoint: string;
  readonly requestId: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
}

export interface RegisterProviderRightsVersionInput extends ProviderCatalogEvidence {
  readonly rightsId?: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly region: string;
  readonly purpose: string;
  readonly modelScope: readonly string[];
  readonly endpointScope: readonly string[];
  readonly effectiveAt: CatalogTimestamp;
  readonly expiresAt?: CatalogTimestamp | null;
  readonly approvalReference: string;
  readonly status?: ProviderRightsStatus;
  /** Optional for existing non-admin catalog callers; required by admin HTTP writes. */
  readonly audit?: ProviderRightsAuditContext;
}

export interface RevokeProviderRightsInput extends ProviderCatalogEvidence {
  readonly rightsId: string;
  readonly approvalReference: string;
  readonly effectiveAt?: CatalogTimestamp;
  /** Optional for existing non-admin catalog callers; required by admin HTTP writes. */
  readonly audit?: ProviderRightsAuditContext;
}

export interface ProviderEligibilityRequest {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialType: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly region: string;
  readonly purpose: string;
}

export type ProviderEligibilityDenyReason =
  | 'provider_product_missing'
  | 'provider_product_disabled'
  | 'capability_missing'
  | 'capability_unsupported'
  | 'capability_unverified'
  | 'capability_failed'
  | 'rights_missing'
  | 'rights_scope_mismatch'
  | 'rights_not_active'
  | 'rights_not_yet_effective'
  | 'rights_expired'
  | 'rights_revoked';

export interface ProviderEligibilityAllowed {
  readonly decision: 'allow';
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly supportLevel: Exclude<ProviderCapabilitySupportLevel, 'unsupported'>;
  readonly limited: boolean;
  readonly capability: Readonly<{
    readonly version: number;
    readonly protocol: string;
    readonly validationState: 'verified';
  }>;
  readonly rights: Readonly<{
    readonly rightsId: string;
    readonly version: number;
    readonly status: 'active';
    readonly effectiveAt: string;
    readonly expiresAt: string | null;
  }>;
}

export interface ProviderEligibilityDenied {
  readonly decision: 'deny';
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly reason: ProviderEligibilityDenyReason;
  readonly supportLevel?: ProviderCapabilitySupportLevel;
  readonly validationState?: ProviderCapabilityValidationState;
  readonly limited?: boolean;
}

export type ProviderEligibilityResult = ProviderEligibilityAllowed | ProviderEligibilityDenied;
