import type { SaasDatabase } from '../db/index.js';
import type { GatewayProtocol } from './contracts.js';
import {
  ProviderAccountScheduler,
  type ProviderAccountSchedulerAffinityBindDecision,
  type ProviderAccountSchedulerAffinityBindingInput,
  type ProviderAccountSchedulerAffinityPort,
  type ProviderAccountSchedulerConcurrencyDecision,
  type ProviderAccountSchedulerEligibilityDecision,
  type ProviderAccountSchedulerHealthPort,
  type ProviderAccountSchedulerInput,
  type ProviderAccountSchedulerOptions,
  type ProviderAccountSchedulerPort,
  type ProviderAccountSchedulerRevalidatedRoute,
  type ProviderAccountSchedulerRights,
} from './provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationDecision,
  RequestPreparationEntitlement,
} from './request-preparation-service.js';
import { blockRequestPreparation } from './request-preparation-service.js';

type Row = Record<string, unknown>;

interface RouteRow extends Row {
  tenant_id: unknown;
  project_id: unknown;
  route_id: unknown;
  current_version: unknown;
  route_version: unknown;
  route_status: unknown;
  public_model_id: unknown;
  public_model_version: unknown;
  protocol: unknown;
  supply_mode: unknown;
  target_mode: unknown;
  upstream_id: unknown;
  endpoint: unknown;
  public_model_alias: unknown;
  public_model_status: unknown;
  public_model_version_status: unknown;
  provider_id: unknown;
  product_id: unknown;
  model: unknown;
}

interface EligibilityRow extends Row {
  product_status: unknown;
  profile_tenant_id: unknown;
  profile_id: unknown;
  profile_supply_mode: unknown;
  profile_status: unknown;
  profile_authz_version: unknown;
  profile_model_scopes: unknown;
  account_owner_kind: unknown;
  account_supply_mode: unknown;
  account_id: unknown;
  account_provider_id: unknown;
  account_product_id: unknown;
  account_credential_type: unknown;
  account_region: unknown;
  account_purpose: unknown;
  account_rights_id: unknown;
  account_rights_version: unknown;
  account_status: unknown;
  account_validation_state: unknown;
  account_authz_version: unknown;
  credential_owner_kind: unknown;
  credential_supply_mode: unknown;
  credential_id: unknown;
  credential_account_id: unknown;
  credential_provider_id: unknown;
  credential_product_id: unknown;
  credential_type: unknown;
  credential_status: unknown;
  credential_validation_state: unknown;
  credential_current_version: unknown;
  credential_expires_at: unknown;
  credential_authz_version: unknown;
  version_owner_kind: unknown;
  version_supply_mode: unknown;
  version_credential_id: unknown;
  credential_version: unknown;
  version_status: unknown;
  version_expires_at: unknown;
  account_rights_provider_id: unknown;
  account_rights_product_id: unknown;
  account_rights_credential_type: unknown;
  account_rights_supply_mode: unknown;
  account_rights_region: unknown;
  account_rights_purpose: unknown;
  account_rights_model_scope: unknown;
  account_rights_endpoint_scope: unknown;
  account_rights_effective_at: unknown;
  account_rights_expires_at: unknown;
  account_rights_status: unknown;
  selected_account_rights_version?: unknown;
  capability_version: unknown;
  capability_protocol: unknown;
  capability_support_level: unknown;
  capability_validation_state: unknown;
  account_capability_version: unknown;
  mapping_tenant_id?: unknown;
  mapping_profile_id?: unknown;
  mapping_supply_mode?: unknown;
  mapping_account_id?: unknown;
  mapping_provider_id?: unknown;
  mapping_product_id?: unknown;
  mapping_account_authz_version?: unknown;
  mapping_status?: unknown;
  mapping_effective_at?: unknown;
  mapping_expires_at?: unknown;
  mapping_authz_version?: unknown;
  pool_id?: unknown;
  pool_provider_id?: unknown;
  pool_product_id?: unknown;
  pool_credential_type?: unknown;
  pool_region?: unknown;
  pool_purpose?: unknown;
  pool_rights_id?: unknown;
  pool_rights_version?: unknown;
  pool_status?: unknown;
  pool_validation_state?: unknown;
  pool_authz_version?: unknown;
  member_pool_id?: unknown;
  member_account_id?: unknown;
  member_provider_id?: unknown;
  member_product_id?: unknown;
  member_status?: unknown;
  member_account_authz_version?: unknown;
  member_authz_version?: unknown;
  grant_tenant_id?: unknown;
  grant_profile_id?: unknown;
  grant_supply_mode?: unknown;
  grant_status?: unknown;
  grant_effective_at?: unknown;
  grant_expires_at?: unknown;
  grant_authz_version?: unknown;
  grant_profile_authz_version?: unknown;
  grant_pool_authz_version?: unknown;
  pool_rights_provider_id?: unknown;
  pool_rights_product_id?: unknown;
  pool_rights_credential_type?: unknown;
  pool_rights_supply_mode?: unknown;
  pool_rights_region?: unknown;
  pool_rights_purpose?: unknown;
  pool_rights_model_scope?: unknown;
  pool_rights_endpoint_scope?: unknown;
  pool_rights_effective_at?: unknown;
  pool_rights_expires_at?: unknown;
  pool_rights_status?: unknown;
  selected_pool_rights_version?: unknown;
}

export interface PostgresProviderAccountSchedulerOptions extends ProviderAccountSchedulerOptions {
  readonly database: SaasDatabase;
  /** Must be the exact maxConcurrency configured on PostgresProviderAccountLeaseService. */
  readonly leaseConcurrencyLimit?: number;
  /** Runtime health source. There is no health/cooldown table in the current SaaS schema. */
  readonly health?: ProviderAccountSchedulerHealthPort;
  /** Optional so an uncomposed runtime fails closed when a request carries affinity. */
  readonly affinity?: ProviderAccountSchedulerAffinityPort;
}

interface PersistedRoute extends ProviderAccountSchedulerRevalidatedRoute {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
}

const ROUTE_SQL = `/* postgres-provider-account-scheduler:route */
SELECT h.tenant_id, h.project_id, h.route_id, h.current_version,
       rv.version AS route_version, rv.status AS route_status,
       rv.public_model_id, rv.public_model_version, rv.protocol,
       rv.supply_mode, rv.target_mode, rv.upstream_id, rv.endpoint,
       pm.alias AS public_model_alias, pm.status AS public_model_status,
       pmv.status AS public_model_version_status,
       pmv.provider_id, pmv.product_id, pmv.model
  FROM saas_route_config_heads h
  JOIN saas_route_config_versions rv
    ON rv.tenant_id = h.tenant_id AND rv.project_id = h.project_id
   AND rv.route_id = h.route_id AND rv.version = h.current_version
  JOIN saas_public_model_versions pmv
    ON pmv.public_model_id = rv.public_model_id
   AND pmv.version = rv.public_model_version
  JOIN saas_public_models pm ON pm.id = pmv.public_model_id
 WHERE h.tenant_id = $1 AND h.project_id = $2
   AND pm.alias = $3 AND rv.protocol = $4 AND rv.supply_mode = $5
   AND h.status = 'active' AND rv.status = 'active'
   AND pm.status = 'active' AND pmv.status = 'active'
 LIMIT 2`;

/* Values held by credentials are intentionally absent from both queries. */
const BYOK_ELIGIBILITY_SQL = `/* postgres-provider-account-scheduler:byok-eligibility */
SELECT product.status AS product_status,
       profile.tenant_id AS profile_tenant_id, profile.id AS profile_id,
       profile.supply_mode AS profile_supply_mode, profile.status AS profile_status,
       profile.authz_version AS profile_authz_version, profile.model_scopes AS profile_model_scopes,
       account.owner_kind AS account_owner_kind, account.supply_mode AS account_supply_mode,
       account.id AS account_id, account.provider_id AS account_provider_id,
       account.product_id AS account_product_id, account.credential_type AS account_credential_type,
       account.region AS account_region, account.purpose AS account_purpose,
       account.rights_id AS account_rights_id, account.rights_version AS account_rights_version,
       account.status AS account_status, account.validation_state AS account_validation_state,
       account.authz_version AS account_authz_version,
       credential.owner_kind AS credential_owner_kind, credential.supply_mode AS credential_supply_mode,
       credential.id AS credential_id, credential.account_id AS credential_account_id,
       credential.provider_id AS credential_provider_id, credential.product_id AS credential_product_id,
       credential.credential_type AS credential_type, credential.status AS credential_status,
       credential.validation_state AS credential_validation_state,
       credential.current_version AS credential_current_version,
       credential.expires_at AS credential_expires_at,
       credential.authz_version AS credential_authz_version,
       credential_version.owner_kind AS version_owner_kind,
       credential_version.supply_mode AS version_supply_mode,
       credential_version.credential_id AS version_credential_id,
       credential_version.version AS credential_version,
       credential_version.status AS version_status,
       credential_version.expires_at AS version_expires_at,
       mapping.tenant_id AS mapping_tenant_id, mapping.supply_profile_id AS mapping_profile_id,
       mapping.supply_mode AS mapping_supply_mode, mapping.account_id AS mapping_account_id,
       mapping.provider_id AS mapping_provider_id, mapping.product_id AS mapping_product_id,
       mapping.account_authz_version AS mapping_account_authz_version,
       mapping.status AS mapping_status, mapping.effective_at AS mapping_effective_at,
       mapping.expires_at AS mapping_expires_at, mapping.authz_version AS mapping_authz_version,
       rights.provider_id AS account_rights_provider_id,
       rights.product_id AS account_rights_product_id,
       rights.credential_type AS account_rights_credential_type,
       rights.supply_mode AS account_rights_supply_mode, rights.region AS account_rights_region,
       rights.purpose AS account_rights_purpose, rights.model_scope AS account_rights_model_scope,
       rights.endpoint_scope AS account_rights_endpoint_scope,
       rights.version AS selected_account_rights_version,
       rights.effective_at AS account_rights_effective_at,
       rights.expires_at AS account_rights_expires_at,
       rights.status AS account_rights_status,
       capability.version AS capability_version, capability.protocol AS capability_protocol,
       capability.support_level AS capability_support_level,
       capability.validation_state AS capability_validation_state,
       account_capability.capability_version AS account_capability_version
  FROM saas_provider_products product
  JOIN saas_supply_profiles profile
    ON profile.tenant_id = $1 AND profile.id = $2
  JOIN saas_tenant_provider_accounts account
    ON account.tenant_id = $1 AND account.id = $3
  JOIN saas_tenant_provider_supply_profile_accounts mapping
    ON mapping.tenant_id = $1 AND mapping.supply_profile_id = $2
   AND mapping.account_id = account.id
  JOIN saas_tenant_provider_credentials credential
    ON credential.tenant_id = account.tenant_id AND credential.account_id = account.id
   AND credential.provider_id = account.provider_id AND credential.product_id = account.product_id
   AND credential.id = $8
  JOIN saas_tenant_provider_credential_versions credential_version
    ON credential_version.tenant_id = credential.tenant_id
   AND credential_version.account_id = credential.account_id
   AND credential_version.credential_id = credential.id
   AND credential_version.version = credential.current_version
  JOIN LATERAL (
    SELECT r.* FROM saas_provider_rights r
     WHERE r.rights_id = account.rights_id AND r.effective_at <= $14::timestamptz
     ORDER BY r.effective_at DESC, r.version DESC LIMIT 1
  ) rights ON TRUE
  JOIN LATERAL (
    SELECT c.* FROM saas_provider_capabilities c
     WHERE c.provider_id = $4 AND c.product_id = $5 AND c.model = $6 AND c.endpoint = $7
     ORDER BY c.version DESC LIMIT 1
  ) capability ON TRUE
  JOIN saas_tenant_provider_account_capabilities account_capability
    ON account_capability.tenant_id = account.tenant_id
   AND account_capability.account_id = account.id
   AND account_capability.provider_id = capability.provider_id
   AND account_capability.product_id = capability.product_id
   AND account_capability.model = capability.model
   AND account_capability.endpoint = capability.endpoint
   AND account_capability.capability_version = capability.version
 WHERE product.provider_id = $4 AND product.product_id = $5 AND product.status = 'active'
   AND profile.supply_mode = 'byok' AND profile.status = 'active'
   AND profile.authz_version = $12 AND profile.model_scopes @> ARRAY[$15]::text[]
   AND account.owner_kind = 'tenant' AND account.supply_mode = 'byok'
   AND account.provider_id = $4 AND account.product_id = $5
   AND account.status = 'active' AND account.validation_state = 'verified'
   AND account.authz_version = $10
   AND mapping.supply_mode = 'byok' AND mapping.provider_id = $4 AND mapping.product_id = $5
   AND mapping.account_authz_version = account.authz_version
   AND mapping.authz_version = $13 AND mapping.status = 'active'
   AND mapping.effective_at <= $14::timestamptz
   AND (mapping.expires_at IS NULL OR mapping.expires_at > $14::timestamptz)
   AND credential.owner_kind = 'tenant' AND credential.supply_mode = 'byok'
   AND credential.credential_type = account.credential_type
   AND credential.status = 'active' AND credential.validation_state = 'verified'
   AND credential.current_version = $9 AND credential.authz_version = $11
   AND (credential.expires_at IS NULL OR credential.expires_at > $14::timestamptz)
   AND credential_version.owner_kind = 'tenant' AND credential_version.supply_mode = 'byok'
   AND credential_version.status = 'active' AND credential_version.version = $9
   AND (credential_version.expires_at IS NULL OR credential_version.expires_at > $14::timestamptz)
   AND rights.version = account.rights_version
   AND rights.provider_id = account.provider_id AND rights.product_id = account.product_id
   AND rights.credential_type = account.credential_type AND rights.supply_mode = 'byok'
   AND rights.region = account.region AND rights.purpose = account.purpose
   AND rights.status = 'active' AND rights.model_scope @> ARRAY[$6]::text[]
   AND rights.endpoint_scope @> ARRAY[$7]::text[]
   AND (rights.expires_at IS NULL OR rights.expires_at > $14::timestamptz)
   AND capability.protocol = $16 AND capability.support_level = 'supported'
   AND capability.validation_state = 'verified'
 LIMIT 2`;

const PLATFORM_ELIGIBILITY_SQL = `/* postgres-provider-account-scheduler:platform-eligibility */
SELECT product.status AS product_status,
       profile.tenant_id AS profile_tenant_id, profile.id AS profile_id,
       profile.supply_mode AS profile_supply_mode, profile.status AS profile_status,
       profile.authz_version AS profile_authz_version, profile.model_scopes AS profile_model_scopes,
       account.owner_kind AS account_owner_kind, account.supply_mode AS account_supply_mode,
       account.id AS account_id, account.provider_id AS account_provider_id,
       account.product_id AS account_product_id, account.credential_type AS account_credential_type,
       account.region AS account_region, account.purpose AS account_purpose,
       account.rights_id AS account_rights_id, account.rights_version AS account_rights_version,
       account.status AS account_status, account.validation_state AS account_validation_state,
       account.authz_version AS account_authz_version,
       credential.owner_kind AS credential_owner_kind, credential.supply_mode AS credential_supply_mode,
       credential.id AS credential_id, credential.account_id AS credential_account_id,
       credential.provider_id AS credential_provider_id, credential.product_id AS credential_product_id,
       credential.credential_type AS credential_type, credential.status AS credential_status,
       credential.validation_state AS credential_validation_state,
       credential.current_version AS credential_current_version,
       credential.expires_at AS credential_expires_at,
       credential.authz_version AS credential_authz_version,
       credential_version.owner_kind AS version_owner_kind,
       credential_version.supply_mode AS version_supply_mode,
       credential_version.credential_id AS version_credential_id,
       credential_version.version AS credential_version,
       credential_version.status AS version_status,
       credential_version.expires_at AS version_expires_at,
       account_rights.provider_id AS account_rights_provider_id,
       account_rights.product_id AS account_rights_product_id,
       account_rights.credential_type AS account_rights_credential_type,
       account_rights.supply_mode AS account_rights_supply_mode,
       account_rights.region AS account_rights_region,
       account_rights.purpose AS account_rights_purpose,
       account_rights.model_scope AS account_rights_model_scope,
       account_rights.endpoint_scope AS account_rights_endpoint_scope,
       account_rights.version AS selected_account_rights_version,
       account_rights.effective_at AS account_rights_effective_at,
       account_rights.expires_at AS account_rights_expires_at,
       account_rights.status AS account_rights_status,
       capability.version AS capability_version, capability.protocol AS capability_protocol,
       capability.support_level AS capability_support_level,
       capability.validation_state AS capability_validation_state,
       account_capability.capability_version AS account_capability_version,
       pool.id AS pool_id, pool.provider_id AS pool_provider_id,
       pool.product_id AS pool_product_id, pool.credential_type AS pool_credential_type,
       pool.region AS pool_region, pool.purpose AS pool_purpose,
       pool.rights_id AS pool_rights_id, pool.rights_version AS pool_rights_version,
       pool.status AS pool_status, pool.validation_state AS pool_validation_state,
       pool.authz_version AS pool_authz_version,
       member.pool_id AS member_pool_id, member.account_id AS member_account_id,
       member.provider_id AS member_provider_id, member.product_id AS member_product_id,
       member.status AS member_status,
       member.account_authz_version AS member_account_authz_version,
       member.authz_version AS member_authz_version,
       grant_row.tenant_id AS grant_tenant_id,
       grant_row.supply_profile_id AS grant_profile_id,
       grant_row.supply_mode AS grant_supply_mode, grant_row.status AS grant_status,
       grant_row.effective_at AS grant_effective_at, grant_row.expires_at AS grant_expires_at,
       grant_row.authz_version AS grant_authz_version,
       grant_row.profile_authz_version AS grant_profile_authz_version,
       grant_row.pool_authz_version AS grant_pool_authz_version,
       pool_rights.provider_id AS pool_rights_provider_id,
       pool_rights.product_id AS pool_rights_product_id,
       pool_rights.credential_type AS pool_rights_credential_type,
       pool_rights.supply_mode AS pool_rights_supply_mode,
       pool_rights.region AS pool_rights_region,
       pool_rights.purpose AS pool_rights_purpose,
       pool_rights.model_scope AS pool_rights_model_scope,
       pool_rights.endpoint_scope AS pool_rights_endpoint_scope,
       pool_rights.version AS selected_pool_rights_version,
       pool_rights.effective_at AS pool_rights_effective_at,
       pool_rights.expires_at AS pool_rights_expires_at,
       pool_rights.status AS pool_rights_status
  FROM saas_provider_products product
  JOIN saas_supply_profiles profile
    ON profile.tenant_id = $1 AND profile.id = $2
  JOIN saas_platform_provider_accounts account ON account.id = $4
  JOIN saas_platform_provider_pools pool ON pool.id = $3
  JOIN saas_platform_provider_pool_members member
    ON member.pool_id = pool.id AND member.account_id = account.id
  JOIN saas_platform_provider_pool_grants grant_row
    ON grant_row.pool_id = pool.id AND grant_row.tenant_id = $1
   AND grant_row.supply_profile_id = $2
  JOIN saas_platform_provider_credentials credential
    ON credential.account_id = account.id AND credential.id = $9
   AND credential.provider_id = account.provider_id AND credential.product_id = account.product_id
  JOIN saas_platform_provider_credential_versions credential_version
    ON credential_version.account_id = credential.account_id
   AND credential_version.credential_id = credential.id
   AND credential_version.version = credential.current_version
  JOIN LATERAL (
    SELECT r.* FROM saas_provider_rights r
     WHERE r.rights_id = account.rights_id AND r.effective_at <= $20::timestamptz
     ORDER BY r.effective_at DESC, r.version DESC LIMIT 1
  ) account_rights ON TRUE
  JOIN LATERAL (
    SELECT r.* FROM saas_provider_rights r
     WHERE r.rights_id = pool.rights_id AND r.effective_at <= $20::timestamptz
     ORDER BY r.effective_at DESC, r.version DESC LIMIT 1
  ) pool_rights ON TRUE
  JOIN LATERAL (
    SELECT c.* FROM saas_provider_capabilities c
     WHERE c.provider_id = $5 AND c.product_id = $6 AND c.model = $7 AND c.endpoint = $8
     ORDER BY c.version DESC LIMIT 1
  ) capability ON TRUE
  JOIN saas_platform_provider_account_capabilities account_capability
    ON account_capability.account_id = account.id
   AND account_capability.provider_id = capability.provider_id
   AND account_capability.product_id = capability.product_id
   AND account_capability.model = capability.model
   AND account_capability.endpoint = capability.endpoint
   AND account_capability.capability_version = capability.version
 WHERE product.provider_id = $5 AND product.product_id = $6 AND product.status = 'active'
   AND profile.supply_mode = 'platform' AND profile.status = 'active'
   AND profile.authz_version = $13 AND profile.model_scopes @> ARRAY[$21]::text[]
   AND account.owner_kind = 'platform' AND account.supply_mode = 'platform'
   AND account.provider_id = $5 AND account.product_id = $6
   AND account.status = 'active' AND account.validation_state = 'verified'
   AND account.authz_version = $12
   AND pool.owner_kind = 'platform' AND pool.supply_mode = 'platform'
   AND pool.provider_id = $5 AND pool.product_id = $6
   AND pool.credential_type = account.credential_type
   AND pool.region = account.region AND pool.purpose = account.purpose
   AND pool.status = 'active' AND pool.validation_state = 'verified'
   AND pool.authz_version = $14
   AND member.provider_id = account.provider_id AND member.product_id = account.product_id
   AND member.status = 'active' AND member.account_authz_version = account.authz_version
   AND member.account_authz_version = $15
   AND member.authz_version = $16
   AND grant_row.supply_mode = 'platform' AND grant_row.status = 'active'
   AND grant_row.authz_version = $17 AND grant_row.profile_authz_version = $18
   AND grant_row.pool_authz_version = $19
   AND grant_row.effective_at <= $20::timestamptz
   AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $20::timestamptz)
   AND credential.owner_kind = 'platform' AND credential.supply_mode = 'platform'
   AND credential.credential_type = account.credential_type
   AND credential.status = 'active' AND credential.validation_state = 'verified'
   AND credential.current_version = $10 AND credential.authz_version = $11
   AND (credential.expires_at IS NULL OR credential.expires_at > $20::timestamptz)
   AND credential_version.owner_kind = 'platform' AND credential_version.supply_mode = 'platform'
   AND credential_version.status = 'active' AND credential_version.version = $10
   AND (credential_version.expires_at IS NULL OR credential_version.expires_at > $20::timestamptz)
   AND account_rights.version = account.rights_version
   AND account_rights.provider_id = account.provider_id
   AND account_rights.product_id = account.product_id
   AND account_rights.credential_type = account.credential_type
   AND account_rights.supply_mode = 'platform'
   AND account_rights.region = account.region AND account_rights.purpose = account.purpose
   AND account_rights.status = 'active'
   AND account_rights.model_scope @> ARRAY[$7]::text[]
   AND account_rights.endpoint_scope @> ARRAY[$8]::text[]
   AND (account_rights.expires_at IS NULL OR account_rights.expires_at > $20::timestamptz)
   AND pool_rights.version = pool.rights_version
   AND pool_rights.provider_id = pool.provider_id AND pool_rights.product_id = pool.product_id
   AND pool_rights.credential_type = pool.credential_type
   AND pool_rights.supply_mode = 'platform'
   AND pool_rights.region = pool.region AND pool_rights.purpose = pool.purpose
   AND pool_rights.status = 'active'
   AND pool_rights.model_scope @> ARRAY[$7]::text[]
   AND pool_rights.endpoint_scope @> ARRAY[$8]::text[]
   AND (pool_rights.expires_at IS NULL OR pool_rights.expires_at > $20::timestamptz)
   AND capability.protocol = $22 AND capability.support_level = 'supported'
   AND capability.validation_state = 'verified'
 LIMIT 2`;

const CONCURRENCY_SQL = `/* postgres-provider-account-scheduler:concurrency */
SELECT count(*)::text AS in_flight
  FROM saas_provider_account_leases
 WHERE owner_kind = $1
   AND owner_tenant_id IS NOT DISTINCT FROM $2
   AND account_id = $3
   AND status = 'held'
   AND lease_expires_at > clock_timestamp()`;

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim() && !value.includes('\u0000');
}

function exactText(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && actual === expected;
}

function versionText(value: unknown): string | null {
  try {
    if (typeof value === 'bigint' && value > 0n) return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return BigInt(value).toString();
  } catch {
    return null;
  }
  return null;
}

function sameVersion(actual: unknown, expected: unknown): boolean {
  const left = versionText(actual);
  const right = versionText(expected);
  return left !== null && right !== null && left === right;
}

function timestamp(value: unknown): Date | null {
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function currentWindow(effectiveAt: unknown, expiresAt: unknown, now: Date): boolean {
  const effective = timestamp(effectiveAt);
  if (!effective || effective.getTime() > now.getTime()) return false;
  if (expiresAt === null) return true;
  const expires = timestamp(expiresAt);
  return expires !== null && expires.getTime() > now.getTime();
}

function unexpired(expiresAt: unknown, now: Date): boolean {
  if (expiresAt === null) return true;
  const expires = timestamp(expiresAt);
  return expires !== null && expires.getTime() > now.getTime();
}

function containsScope(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') && value.includes(expected);
}

function entitlementMatchesInput(input: ProviderAccountSchedulerInput): boolean {
  const { caller, entitlement } = input;
  return (
    entitlement.tenantId === caller.tenantId &&
    entitlement.projectId === caller.projectId &&
    entitlement.proxyKeyId === caller.proxyKeyId &&
    entitlement.entitlementId === caller.entitlementId &&
    sameVersion(entitlement.entitlementVersion, caller.entitlementVersion) &&
    entitlement.supplyProfileId === caller.supplyProfileId &&
    sameVersion(entitlement.supplyProfileVersion, caller.supplyProfileVersion) &&
    entitlement.supplyMode === caller.supplyMode &&
    sameVersion(entitlement.modelScopeVersion, caller.modelScopeVersion) &&
    versionText(entitlement.projectPolicyVersion) !== null &&
    Array.isArray(entitlement.allowedModels) &&
    entitlement.allowedModels.includes(input.publicModel) &&
    Array.isArray(caller.modelScopes) &&
    caller.modelScopes.includes(input.publicModel) &&
    Array.isArray(entitlement.allowedProviderIds) &&
    (caller.supplyMode === 'platform' ? entitlement.allowedProviderIds.length === 0 : true)
  );
}

function parseRoute(row: RouteRow, input: ProviderAccountSchedulerInput): PersistedRoute | null {
  const expectedTargetMode = input.caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  if (
    !exactText(row.tenant_id, input.caller.tenantId) ||
    !exactText(row.project_id, input.caller.projectId) ||
    !exactText(row.public_model_alias, input.publicModel) ||
    row.route_status !== 'active' ||
    row.public_model_status !== 'active' ||
    row.public_model_version_status !== 'active' ||
    !sameVersion(row.route_version, row.current_version) ||
    versionText(row.current_version) === null ||
    !nonEmpty(row.route_id) ||
    !nonEmpty(row.public_model_id) ||
    versionText(row.public_model_version) === null ||
    !exactText(row.protocol, input.protocol) ||
    !exactText(row.supply_mode, input.caller.supplyMode) ||
    !exactText(row.target_mode, expectedTargetMode) ||
    !nonEmpty(row.upstream_id) ||
    !nonEmpty(row.endpoint) ||
    !nonEmpty(row.provider_id) ||
    !nonEmpty(row.product_id) ||
    !nonEmpty(row.model)
  ) {
    return null;
  }
  return {
    tenantId: input.caller.tenantId,
    projectId: input.caller.projectId,
    routeConfigId: row.route_id,
    routeConfigVersion: versionText(row.current_version) as string,
    publicModelId: row.public_model_id,
    publicModelVersion: versionText(row.public_model_version) as string,
    publicModel: input.publicModel,
    protocol: input.protocol,
    supplyMode: input.caller.supplyMode,
    targetMode: expectedTargetMode,
    upstreamId: row.upstream_id,
    providerId: row.provider_id,
    productId: row.product_id,
    model: row.model,
    endpoint: row.endpoint,
  };
}

function candidateMatchesRoute(
  candidate: RequestPreparationCandidateAuthority,
  route: PersistedRoute,
  input: ProviderAccountSchedulerInput,
): boolean {
  if (
    candidate.protocol !== input.protocol ||
    candidate.supplyMode !== input.caller.supplyMode ||
    candidate.resolvedModel !== route.model ||
    candidate.providerId !== route.providerId ||
    candidate.productId !== route.productId ||
    candidate.endpoint !== route.endpoint ||
    candidate.upstreamId !== route.upstreamId
  ) {
    return false;
  }
  return candidate.supplyMode !== 'platform' || candidate.poolId === route.upstreamId;
}

function validateCommonEligibilityRow(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
  input: Pick<ProviderAccountSchedulerInput, 'caller' | 'publicModel' | 'protocol'>,
  now: Date,
): boolean {
  const ownerKind = candidate.supplyMode === 'byok' ? 'tenant' : 'platform';
  return (
    row.product_status === 'active' &&
    exactText(row.profile_tenant_id, input.caller.tenantId) &&
    exactText(row.profile_id, input.caller.supplyProfileId) &&
    exactText(row.profile_supply_mode, candidate.supplyMode) &&
    row.profile_status === 'active' &&
    sameVersion(row.profile_authz_version, input.caller.supplyProfileVersion) &&
    containsScope(row.profile_model_scopes, input.publicModel) &&
    exactText(row.account_owner_kind, ownerKind) &&
    exactText(row.account_supply_mode, candidate.supplyMode) &&
    exactText(row.account_id, candidate.accountId) &&
    exactText(row.account_provider_id, candidate.providerId) &&
    exactText(row.account_product_id, candidate.productId) &&
    nonEmpty(row.account_credential_type) &&
    nonEmpty(row.account_region) &&
    nonEmpty(row.account_purpose) &&
    nonEmpty(row.account_rights_id) &&
    versionText(row.account_rights_version) !== null &&
    row.account_status === 'active' &&
    row.account_validation_state === 'verified' &&
    sameVersion(row.account_authz_version, candidate.accountAuthzVersion) &&
    exactText(row.credential_owner_kind, ownerKind) &&
    exactText(row.credential_supply_mode, candidate.supplyMode) &&
    exactText(row.credential_id, candidate.credentialId) &&
    exactText(row.credential_account_id, candidate.accountId) &&
    exactText(row.credential_provider_id, candidate.providerId) &&
    exactText(row.credential_product_id, candidate.productId) &&
    exactText(row.credential_type, row.account_credential_type) &&
    row.credential_status === 'active' &&
    row.credential_validation_state === 'verified' &&
    sameVersion(row.credential_current_version, candidate.credentialVersion) &&
    sameVersion(row.credential_version, candidate.credentialVersion) &&
    sameVersion(row.credential_authz_version, candidate.credentialAuthzVersion) &&
    exactText(row.version_owner_kind, ownerKind) &&
    exactText(row.version_supply_mode, candidate.supplyMode) &&
    exactText(row.version_credential_id, candidate.credentialId) &&
    row.version_status === 'active' &&
    unexpired(row.credential_expires_at, now) &&
    unexpired(row.version_expires_at, now) &&
    exactText(row.account_rights_provider_id, candidate.providerId) &&
    exactText(row.account_rights_product_id, candidate.productId) &&
    exactText(row.account_rights_credential_type, row.account_credential_type) &&
    exactText(row.account_rights_supply_mode, candidate.supplyMode) &&
    exactText(row.account_rights_region, row.account_region as string) &&
    exactText(row.account_rights_purpose, row.account_purpose as string) &&
    row.account_rights_status === 'active' &&
    sameVersion(row.account_rights_version, row.selected_account_rights_version) &&
    containsScope(row.account_rights_model_scope, candidate.resolvedModel) &&
    containsScope(row.account_rights_endpoint_scope, candidate.endpoint) &&
    currentWindow(row.account_rights_effective_at, row.account_rights_expires_at, now) &&
    sameVersion(row.capability_version, row.account_capability_version) &&
    exactText(row.capability_protocol, input.protocol) &&
    row.capability_support_level === 'supported' &&
    row.capability_validation_state === 'verified'
  );
}

function validateByokRelation(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
  now: Date,
): boolean {
  return (
    candidate.supplyMode === 'byok' &&
    versionText(
      (candidate as RequestPreparationCandidateAuthority & { profileAccountAuthzVersion?: unknown })
        .profileAccountAuthzVersion,
    ) !== null &&
    exactText(row.mapping_tenant_id, candidate.tenantId) &&
    exactText(row.mapping_profile_id, candidate.supplyProfileId) &&
    exactText(row.mapping_supply_mode, 'byok') &&
    exactText(row.mapping_account_id, candidate.accountId) &&
    exactText(row.mapping_provider_id, candidate.providerId) &&
    exactText(row.mapping_product_id, candidate.productId) &&
    sameVersion(row.mapping_account_authz_version, candidate.accountAuthzVersion) &&
    row.mapping_status === 'active' &&
    sameVersion(
      row.mapping_authz_version,
      (candidate as RequestPreparationCandidateAuthority & { profileAccountAuthzVersion?: unknown })
        .profileAccountAuthzVersion,
    ) &&
    currentWindow(row.mapping_effective_at, row.mapping_expires_at, now)
  );
}

function validatePlatformRelation(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
  now: Date,
): boolean {
  const platform = candidate as RequestPreparationCandidateAuthority & {
    poolId?: unknown;
    poolAuthzVersion?: unknown;
    poolMemberAccountAuthzVersion?: unknown;
    poolMemberAuthzVersion?: unknown;
    poolGrantAuthzVersion?: unknown;
    poolGrantProfileAuthzVersion?: unknown;
    poolGrantPoolAuthzVersion?: unknown;
  };
  return (
    candidate.supplyMode === 'platform' &&
    nonEmpty(platform.poolId) &&
    versionText(platform.poolAuthzVersion) !== null &&
    versionText(platform.poolMemberAccountAuthzVersion) !== null &&
    versionText(platform.poolMemberAuthzVersion) !== null &&
    versionText(platform.poolGrantAuthzVersion) !== null &&
    versionText(platform.poolGrantProfileAuthzVersion) !== null &&
    versionText(platform.poolGrantPoolAuthzVersion) !== null &&
    exactText(row.pool_id, platform.poolId) &&
    exactText(row.pool_provider_id, candidate.providerId) &&
    exactText(row.pool_product_id, candidate.productId) &&
    exactText(row.pool_credential_type, row.account_credential_type as string) &&
    exactText(row.pool_region, row.account_region as string) &&
    exactText(row.pool_purpose, row.account_purpose as string) &&
    nonEmpty(row.pool_rights_id) &&
    sameVersion(row.pool_rights_version, row.selected_pool_rights_version) &&
    row.pool_status === 'active' &&
    row.pool_validation_state === 'verified' &&
    sameVersion(row.pool_authz_version, platform.poolAuthzVersion) &&
    exactText(row.member_pool_id, platform.poolId) &&
    exactText(row.member_account_id, candidate.accountId) &&
    exactText(row.member_provider_id, candidate.providerId) &&
    exactText(row.member_product_id, candidate.productId) &&
    row.member_status === 'active' &&
    sameVersion(row.member_account_authz_version, platform.poolMemberAccountAuthzVersion) &&
    sameVersion(row.member_authz_version, platform.poolMemberAuthzVersion) &&
    exactText(row.grant_tenant_id, candidate.tenantId) &&
    exactText(row.grant_profile_id, candidate.supplyProfileId) &&
    exactText(row.grant_supply_mode, 'platform') &&
    row.grant_status === 'active' &&
    sameVersion(row.grant_authz_version, platform.poolGrantAuthzVersion) &&
    sameVersion(row.grant_profile_authz_version, platform.poolGrantProfileAuthzVersion) &&
    sameVersion(row.grant_profile_authz_version, candidate.supplyProfileAuthzVersion) &&
    sameVersion(row.grant_pool_authz_version, platform.poolGrantPoolAuthzVersion) &&
    sameVersion(row.grant_pool_authz_version, platform.poolAuthzVersion) &&
    currentWindow(row.grant_effective_at, row.grant_expires_at, now) &&
    exactText(row.pool_rights_provider_id, candidate.providerId) &&
    exactText(row.pool_rights_product_id, candidate.productId) &&
    exactText(row.pool_rights_credential_type, row.account_credential_type as string) &&
    exactText(row.pool_rights_supply_mode, 'platform') &&
    exactText(row.pool_rights_region, row.account_region as string) &&
    exactText(row.pool_rights_purpose, row.account_purpose as string) &&
    row.pool_rights_status === 'active' &&
    containsScope(row.pool_rights_model_scope, candidate.resolvedModel) &&
    containsScope(row.pool_rights_endpoint_scope, candidate.endpoint) &&
    currentWindow(row.pool_rights_effective_at, row.pool_rights_expires_at, now)
  );
}

function toRights(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
): ProviderAccountSchedulerRights {
  return {
    providerId: row.account_rights_provider_id as string,
    productId: row.account_rights_product_id as string,
    model: candidate.resolvedModel,
    endpoint: candidate.endpoint,
    supplyMode: candidate.supplyMode,
    status: 'active',
    version: row.account_rights_version as string | number,
    effectiveAt: row.account_rights_effective_at as string | Date,
    expiresAt: row.account_rights_expires_at as string | Date | null,
  };
}

function inputScopeIsInvalid(input: ProviderAccountSchedulerInput): boolean {
  return (
    !entitlementMatchesInput(input) ||
    (input.caller.supplyMode === 'byok' &&
      (!Array.isArray(input.entitlement.allowedProviderIds) ||
        input.entitlement.allowedProviderIds.some((value) => !nonEmpty(value))))
  );
}

class PostgresEligibilityAuthority {
  constructor(private readonly database: SaasDatabase) {}

  async revalidate(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerEligibilityDecision> {
    try {
      if (
        inputScopeIsInvalid({
          requestId: 'scheduler-revalidation',
          caller: input.caller,
          entitlement: input.entitlement,
          candidates: [input.candidate],
          publicModel: input.publicModel,
          protocol: input.protocol,
        })
      ) {
        return { decision: 'block', reason: 'persisted caller and entitlement scopes do not agree' };
      }
      if (!isRecord(input.candidate) || !nonEmpty(input.candidate.accountId)) {
        return { decision: 'block', reason: 'candidate account authority is malformed' };
      }
      if (
        input.caller.supplyMode === 'byok' &&
        !input.entitlement.allowedProviderIds.includes(input.candidate.providerId)
      ) {
        return { decision: 'deny', reason: 'provider is outside the persisted BYOK entitlement' };
      }

      return await this.database.transaction(async (tx) => {
        const routeResult = await tx.query<RouteRow>(ROUTE_SQL, [
          input.caller.tenantId,
          input.caller.projectId,
          input.publicModel,
          input.protocol,
          input.caller.supplyMode,
        ]);
        if (routeResult.rows.length === 0) {
          return { decision: 'block', reason: 'active persisted route authority is missing' };
        }
        if (routeResult.rows.length !== 1) {
          return { decision: 'block', reason: 'active persisted route authority is ambiguous' };
        }
        const route = parseRoute(routeResult.rows[0], {
          requestId: 'scheduler-revalidation',
          caller: input.caller,
          entitlement: input.entitlement,
          candidates: [input.candidate],
          publicModel: input.publicModel,
          protocol: input.protocol,
        });
        if (!route) return { decision: 'block', reason: 'active persisted route authority is malformed' };
        if (
          !candidateMatchesRoute(input.candidate, route, {
            requestId: 'scheduler-revalidation',
            caller: input.caller,
            entitlement: input.entitlement,
            candidates: [input.candidate],
            publicModel: input.publicModel,
            protocol: input.protocol,
          })
        ) {
          return { decision: 'deny', reason: 'candidate is outside the exact persisted route provider/product' };
        }

        const rowResult = await tx.query<EligibilityRow>(
          input.caller.supplyMode === 'byok' ? BYOK_ELIGIBILITY_SQL : PLATFORM_ELIGIBILITY_SQL,
          input.caller.supplyMode === 'byok' ? byokValues(input, route) : platformValues(input, route),
        );
        if (rowResult.rows.length === 0) {
          return {
            decision: 'deny',
            reason: 'account, rights, capability, credential, or active supply relation is unavailable',
          };
        }
        if (rowResult.rows.length !== 1) {
          return { decision: 'block', reason: 'persisted account eligibility authority is ambiguous' };
        }
        const row = rowResult.rows[0];
        const relationIsValid =
          input.caller.supplyMode === 'byok'
            ? validateByokRelation(row, input.candidate, input.now)
            : validatePlatformRelation(row, input.candidate, input.now);
        if (!validateCommonEligibilityRow(row, input.candidate, input, input.now) || !relationIsValid) {
          return { decision: 'deny', reason: 'persisted account eligibility facts no longer match the candidate' };
        }
        return {
          decision: 'allow',
          candidate: input.candidate,
          route,
          status: 'active',
          capability: {
            protocol: input.protocol,
            supportLevel: 'supported',
            validationState: 'verified',
          },
          rights: toRights(row, input.candidate),
          // No priority or weight exists in the persisted contract; use a neutral deterministic tie.
          priority: 0,
          weight: 1,
        };
      });
    } catch {
      return { decision: 'block', reason: 'PostgreSQL provider eligibility authority is unavailable' };
    }
  }
}

function byokValues(
  input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly now: Date;
  },
  _route: PersistedRoute,
): readonly unknown[] {
  const candidate = input.candidate as RequestPreparationCandidateAuthority & { profileAccountAuthzVersion?: unknown };
  return [
    input.caller.tenantId,
    input.caller.supplyProfileId,
    candidate.accountId,
    candidate.providerId,
    candidate.productId,
    candidate.resolvedModel,
    candidate.endpoint,
    candidate.credentialId,
    candidate.credentialVersion,
    candidate.accountAuthzVersion,
    candidate.credentialAuthzVersion,
    input.caller.supplyProfileVersion,
    candidate.profileAccountAuthzVersion,
    input.now,
    input.publicModel,
    candidate.protocol,
  ];
}

function platformValues(
  input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly now: Date;
  },
  route: PersistedRoute,
): readonly unknown[] {
  const candidate = input.candidate as RequestPreparationCandidateAuthority & {
    poolId?: unknown;
    poolAuthzVersion?: unknown;
    poolMemberAccountAuthzVersion?: unknown;
    poolMemberAuthzVersion?: unknown;
    poolGrantAuthzVersion?: unknown;
    poolGrantProfileAuthzVersion?: unknown;
    poolGrantPoolAuthzVersion?: unknown;
  };
  return [
    input.caller.tenantId,
    input.caller.supplyProfileId,
    candidate.poolId,
    candidate.accountId,
    candidate.providerId,
    candidate.productId,
    candidate.resolvedModel,
    route.endpoint,
    candidate.credentialId,
    candidate.credentialVersion,
    candidate.credentialAuthzVersion,
    candidate.accountAuthzVersion,
    input.caller.supplyProfileVersion,
    candidate.poolAuthzVersion,
    candidate.poolMemberAccountAuthzVersion,
    candidate.poolMemberAuthzVersion,
    candidate.poolGrantAuthzVersion,
    candidate.poolGrantProfileAuthzVersion,
    candidate.poolGrantPoolAuthzVersion,
    input.now,
    input.publicModel,
    candidate.protocol,
  ];
}

function parseCount(value: unknown): number | null {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number'
          ? BigInt(value)
          : typeof value === 'string' && /^[0-9]+$/.test(value)
            ? BigInt(value)
            : null;
    if (parsed === null || parsed < 0n || parsed > 1_000_000_000n) return null;
    return Number(parsed);
  } catch {
    return null;
  }
}

function isLeaseConcurrencyLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
}

async function postgresConcurrency(
  database: SaasDatabase,
  leaseConcurrencyLimit: number | undefined,
  input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
  },
): Promise<ProviderAccountSchedulerConcurrencyDecision> {
  if (!isLeaseConcurrencyLimit(leaseConcurrencyLimit)) {
    return {
      decision: 'block',
      reason:
        'provider account lease concurrency limit is missing; configure the same maxConcurrency as the lease service',
    };
  }
  try {
    const ownerKind = input.candidate.supplyMode === 'byok' ? 'tenant' : 'platform';
    const ownerTenantId = ownerKind === 'tenant' ? input.caller.tenantId : null;
    const result = await database.query<{ in_flight: unknown }>(CONCURRENCY_SQL, [
      ownerKind,
      ownerTenantId,
      input.candidate.accountId,
    ]);
    if (result.rows.length !== 1) {
      return { decision: 'block', reason: 'provider account lease concurrency snapshot is unavailable' };
    }
    const inFlight = parseCount(result.rows[0].in_flight);
    if (inFlight === null) {
      return { decision: 'block', reason: 'provider account lease concurrency snapshot is malformed' };
    }
    if (inFlight >= leaseConcurrencyLimit) {
      return { decision: 'deny', reason: 'provider account has no observed free lease slot' };
    }
    return { decision: 'allow', value: { inFlight, limit: leaseConcurrencyLimit } };
  } catch {
    return { decision: 'block', reason: 'provider account lease concurrency authority is unavailable' };
  }
}

const MISSING_HEALTH: ProviderAccountSchedulerHealthPort = {
  async get() {
    return {
      decision: 'block',
      reason:
        'runtime health authority is missing: the SaaS schema has no account health/cooldown observation contract; validation_state is not runtime health',
    };
  },
};

const MISSING_AFFINITY: ProviderAccountSchedulerAffinityPort = {
  async resolve() {
    return {
      decision: 'block',
      reason:
        'affinity authority is missing: the SaaS schema has no persisted session/response-to-account mapping contract',
    };
  },
  async bind() {
    return {
      decision: 'block',
      reason:
        'affinity authority is missing: the SaaS schema has no persisted session/response-to-account mapping contract',
    };
  },
};

/**
 * PostgreSQL revalidation for the commercial gateway. Every eligible account
 * must match the current route, explicit rights, verified account-bound
 * capability, current credential metadata, and active supply relationship.
 * Health/affinity are never inferred from account labels or validation state.
 * The lease snapshot is observational; dispatch must still acquire the fenced
 * lease through PostgresProviderAccountLeaseService before transport I/O.
 */
export class PostgresProviderAccountScheduler implements ProviderAccountSchedulerPort {
  private readonly scheduler: ProviderAccountScheduler;
  private readonly healthAuthorityConfigured: boolean;

  constructor(options: PostgresProviderAccountSchedulerOptions) {
    if (
      !options?.database ||
      typeof options.database.query !== 'function' ||
      typeof options.database.transaction !== 'function'
    ) {
      throw new TypeError('a transactional PostgreSQL SaaS database is required');
    }
    this.healthAuthorityConfigured = options.health !== undefined;
    const eligibility = new PostgresEligibilityAuthority(options.database);
    this.scheduler = new ProviderAccountScheduler(
      {
        eligibility,
        health: options.health ?? MISSING_HEALTH,
        concurrency: {
          get: (input) => postgresConcurrency(options.database, options.leaseConcurrencyLimit, input),
        },
        affinity: options.affinity ?? MISSING_AFFINITY,
      },
      options,
    );
  }

  select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>> {
    if (!this.healthAuthorityConfigured) {
      return Promise.resolve(
        blockRequestPreparation(
          'capability_unavailable',
          'runtime health authority is missing: the SaaS schema has no account health/cooldown observation contract; validation_state is not runtime health',
        ),
      );
    }
    return this.scheduler.select(input);
  }

  bindAffinity(
    input: ProviderAccountSchedulerAffinityBindingInput,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision> {
    return this.scheduler.bindAffinity(input);
  }
}
