import type {
  ProviderCapabilityDiscoverySource,
  ProviderCapabilitySupportLevel,
  ProviderCapabilityValidationState,
  ProviderProductStatus,
  ProviderRightsStatus,
} from '../../catalog/types.js';
import type { SqlExecutor } from '../../db/types.js';

/** A read-only subset of the SaaS database contract used by this service. */
export type PlatformCatalogQueryDatabase = Pick<SqlExecutor, 'query'>;

export type PlatformCatalogProductStatus = ProviderProductStatus;
export type PlatformCatalogCapabilitySupportLevel = ProviderCapabilitySupportLevel;
export type PlatformCatalogCapabilityValidationState = ProviderCapabilityValidationState;
export type PlatformCatalogCapabilityDiscoverySource = ProviderCapabilityDiscoverySource;
export type PlatformCatalogRightsStatus = ProviderRightsStatus;

export interface PlatformCatalogPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Provider-product metadata. No tenant, account, or credential data is exposed. */
export interface PlatformCatalogProviderProductRecord {
  readonly providerId: string;
  readonly productId: string;
  readonly displayName: string;
  readonly status: PlatformCatalogProductStatus;
  readonly createdAt: string;
}

/** Protocol/model capability metadata, including its validation and evidence state. */
export interface PlatformCatalogCapabilityRecord {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: string;
  readonly version: number;
  readonly supportLevel: PlatformCatalogCapabilitySupportLevel;
  readonly validationState: PlatformCatalogCapabilityValidationState;
  readonly evidenceVersion: string;
  readonly discoverySource: PlatformCatalogCapabilityDiscoverySource;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly createdAt: string;
}

/** Provider-rights metadata. Evidence contents and provider account data are intentionally absent. */
export interface PlatformCatalogRightsRecord {
  readonly rightsId: string;
  readonly version: number;
  readonly providerId: string;
  readonly productId: string;
  /** A credential kind, never a credential or secret value. */
  readonly credentialType: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly region: string;
  readonly purpose: string;
  readonly modelScope: readonly string[];
  readonly endpointScope: readonly string[];
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly approvalReference: string;
  readonly status: PlatformCatalogRightsStatus;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly createdAt: string;
}

export interface PlatformCatalogProviderProductListQuery {
  readonly providerId?: string;
  readonly productId?: string;
  readonly status?: PlatformCatalogProductStatus;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly pageSize?: number;
}

export interface PlatformCatalogCapabilityListQuery {
  readonly providerId?: string;
  readonly productId?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly protocol?: string;
  readonly version?: number;
  readonly supportLevel?: PlatformCatalogCapabilitySupportLevel;
  readonly validationState?: PlatformCatalogCapabilityValidationState;
  readonly evidenceVersion?: string;
  readonly discoverySource?: PlatformCatalogCapabilityDiscoverySource;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly pageSize?: number;
}

export interface PlatformCatalogRightsListQuery {
  readonly rightsId?: string;
  readonly providerId?: string;
  readonly productId?: string;
  readonly version?: number;
  readonly credentialType?: string;
  readonly supplyMode?: 'byok' | 'platform';
  readonly region?: string;
  readonly purpose?: string;
  readonly status?: PlatformCatalogRightsStatus;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly pageSize?: number;
}

export type PlatformCatalogProductPage = PlatformCatalogPage<PlatformCatalogProviderProductRecord>;
export type PlatformCatalogCapabilityPage = PlatformCatalogPage<PlatformCatalogCapabilityRecord>;
export type PlatformCatalogRightsPage = PlatformCatalogPage<PlatformCatalogRightsRecord>;

// Compatibility aliases keep the public vocabulary close to the existing catalog module.
export type PlatformCatalogProductRecord = PlatformCatalogProviderProductRecord;
export type PlatformProviderProductRecord = PlatformCatalogProviderProductRecord;
export type PlatformProviderCapabilityRecord = PlatformCatalogCapabilityRecord;
export type PlatformProviderRightsRecord = PlatformCatalogRightsRecord;
export type ProviderProductGovernanceRecord = PlatformCatalogProviderProductRecord;
export type ProviderCapabilityGovernanceRecord = PlatformCatalogCapabilityRecord;
export type ProviderRightsGovernanceRecord = PlatformCatalogRightsRecord;
