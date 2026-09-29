import type { SqlExecutor } from '../db/types.js';
import type { SupplyMode } from '../gateway/contracts.js';
import type { TenantContext } from '../identity/types.js';

/** The only execution principals a SaaS Proxy Key may bind to. */
export type ApiKeyPrincipalKind = 'member' | 'project_service';

export interface SupplyProfileResolution {
  readonly entitlementId: string;
  readonly profileId: string;
  readonly mode: SupplyMode;
  readonly allowedModels: readonly string[];
  /** Positive, server-owned authorization revision of the project entitlement. */
  readonly entitlementAuthzVersion: number;
  /** Positive, server-owned authorization revision of the supply profile. */
  readonly supplyProfileAuthzVersion: number;
  /** Version of the effective model-scope snapshot; derived when not supplied by the resolver. */
  readonly modelScopeVersion?: number;
}

/**
 * Resolves the server-owned supply profile and entitlement for one authorized
 * tenant/project context. The client supplies only the desired mode; profile
 * and entitlement identifiers are always resolved from the authorized project.
 * An executor can be supplied when the caller has already opened a transaction
 * so the entitlement lock and the eventual key write share one snapshot.
 */
export interface SupplyProfileResolveOptions {
  readonly executor?: SqlExecutor;
  /** Restrict resolution to one stored entitlement during rotation. */
  readonly entitlementId?: string;
}

export interface SupplyProfileResolver {
  resolve(
    context: TenantContext,
    mode: SupplyMode,
    options?: SupplyProfileResolveOptions,
  ): Promise<SupplyProfileResolution | null>;
}

export interface CreateApiKeyInput {
  readonly name: string;
  /** An explicit non-empty subset of the resolver's allowed model set. */
  readonly modelScopes: readonly string[];
  /** The client may select the supply mode, but not its backing IDs. */
  readonly supplyMode: SupplyMode;
  /** Selects the execution principal; its ID is always resolved from the authorized context. */
  readonly principalKind?: ApiKeyPrincipalKind;
  readonly expiresAt?: string | Date | null;
}

export type ApiKeyStatus = 'active' | 'revoked';

export interface ApiKeyMetadata {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  /** Legacy member column; null for project-service keys. */
  readonly principalUserId: string | null;
  readonly executionPrincipalType: ApiKeyPrincipalKind;
  readonly executionPrincipalId: string;
  readonly createdByUserId: string;
  readonly rotatedByUserId: string | null;
  readonly revokedByUserId: string | null;
  readonly entitlementId: string | null;
  readonly supplyProfileId: string;
  readonly supplyMode: SupplyMode;
  readonly name: string;
  readonly prefix: string;
  readonly modelScopes: readonly string[];
  readonly status: ApiKeyStatus;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly authzVersion: number;
  readonly modelScopeVersion: number;
  readonly entitlementAuthzVersion: number | null;
  readonly supplyProfileAuthzVersion: number | null;
}

/** Server-owned authorization facts captured from a persisted proxy key. */
export interface ApiKeyAuthorizationSnapshot {
  readonly keyId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly principalKind: ApiKeyPrincipalKind;
  readonly principalId: string;
  readonly entitlementId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: SupplyMode;
  readonly modelScopes: readonly string[];
  readonly authzVersion: number;
  readonly modelScopeVersion: number;
  readonly entitlementAuthzVersion: number;
  readonly supplyProfileAuthzVersion: number;
}

/** Safe metadata and the key's stored authorization snapshot; never contains a raw key or digest. */
export interface AuthenticatedApiKey {
  readonly metadata: ApiKeyMetadata;
  readonly authorization: ApiKeyAuthorizationSnapshot;
}

export interface CreatedApiKey extends ApiKeyMetadata {
  /** Returned only by create/rotate and never persisted. */
  readonly secret: string;
}

export type SaasKeyErrorCode =
  | 'KEY_INVALID_INPUT'
  | 'KEY_ACCESS_DENIED'
  | 'KEY_NOT_FOUND'
  | 'KEY_ALREADY_REVOKED'
  | 'KEY_SUPPLY_UNAVAILABLE'
  | 'KEY_NO_ENTITLEMENT'
  | 'KEY_PROFILE_INVALID'
  | 'KEY_SCOPE_NOT_ALLOWED'
  | 'KEY_STORAGE_ERROR';

export class SaasKeyError extends Error {
  readonly status: number;
  readonly code: SaasKeyErrorCode;

  constructor(status: number, code: SaasKeyErrorCode, message: string) {
    super(message);
    this.name = 'SaasKeyError';
    this.status = status;
    this.code = code;
  }
}

export interface SaasKeyServiceOptions {
  readonly resolver?: SupplyProfileResolver;
  readonly now?: () => Date;
}
