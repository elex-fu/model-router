import type { SqlExecutor } from './types.js';

/** Safe, stable startup error; database details and role credentials are never included. */
export class SaasRuntimePrivilegeError extends Error {
  readonly code = 'SAAS_RUNTIME_PRIVILEGES_UNSAFE' as const;

  constructor() {
    super('Managed SaaS PostgreSQL runtime privileges do not satisfy the production policy');
    this.name = 'SaasRuntimePrivilegeError';
  }
}

export type SaasRuntimeWorkloadRole = 'control_plane' | 'gateway';

export type SaasControlPlaneColumnGrant = readonly [
  table: string,
  column: string,
  privilege: 'INSERT' | 'UPDATE' | 'SELECT',
];

export type SaasControlPlaneTableGrant = readonly [table: string, privilege: 'DELETE'];
export type SaasControlPlaneSequenceGrant = readonly [sequence: string, privilege: 'USAGE'];

function columnGrants(
  table: string,
  privilege: SaasControlPlaneColumnGrant[2],
  columns: readonly string[],
): readonly SaasControlPlaneColumnGrant[] {
  return columns.map((column) => [table, column, privilege] as const);
}

const COMMERCIAL_PRICE_VERSION_COLUMNS = [
  'id',
  'version',
  'public_model_id',
  'public_model_version',
  'provider_id',
  'product_id',
  'protocol',
  'endpoint',
  'currency',
  'commercial_policy_version',
  'calculator_version',
  'rounding_version',
  'rounding_mode',
  'rounding_boundary',
  'input_rate_numerator_minor_units',
  'input_rate_denominator_units',
  'cache_read_rate_numerator_minor_units',
  'cache_read_rate_denominator_units',
  'cache_write_rate_numerator_minor_units',
  'cache_write_rate_denominator_units',
  'cache_write_5m_rate_numerator_minor_units',
  'cache_write_5m_rate_denominator_units',
  'cache_write_1h_rate_numerator_minor_units',
  'cache_write_1h_rate_denominator_units',
  'output_rate_numerator_minor_units',
  'output_rate_denominator_units',
  'effective_at',
  'expires_at',
  'idempotency_key',
  'definition_digest',
  'created_at',
] as const;

/**
 * Exact column ACLs derived from mounted control-plane SQL and managed startup.
 * This is an ACL contract only: PostgreSQL row-lock clauses require UPDATE on
 * at least one column of each locked relation, so this probe does not assert
 * that API SQL executes. Immutable role assignments and policy-history rows
 * remain SELECT-only even where source SQL still asks for a row lock.
 */
export const SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS: readonly SaasControlPlaneColumnGrant[] = [
  ...columnGrants('saas_schema_migrations', 'SELECT', ['version', 'name', 'checksum']),
  ...columnGrants('saas_platform_state', 'SELECT', ['singleton', 'initialized', 'initialized_at']),
  ...columnGrants('saas_platform_state', 'UPDATE', ['initialized']),
  ...columnGrants('saas_users', 'SELECT', [
    'id',
    'email',
    'email_canonical',
    'display_name',
    'password_hash',
    'disabled_at',
    'anonymized_at',
    'email_verified_at',
    'created_at',
  ]),
  ...columnGrants('saas_users', 'INSERT', [
    'id',
    'email',
    'password_hash',
    'display_name',
    'email_verified_at',
    'disabled_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_platform_role_assignments', 'SELECT', ['user_id', 'role']),
  ...columnGrants('saas_platform_role_assignments', 'INSERT', ['user_id', 'role', 'granted_at', 'granted_by_user_id']),
  ...columnGrants('saas_bootstrap_tokens', 'SELECT', ['token_hash', 'expires_at', 'consumed_at']),
  ...columnGrants('saas_bootstrap_tokens', 'INSERT', [
    'token_hash',
    'expires_at',
    'consumed_at',
    'created_by_user_id',
    'created_at',
  ]),
  ...columnGrants('saas_bootstrap_tokens', 'UPDATE', ['consumed_at']),
  ...columnGrants('saas_sessions', 'SELECT', [
    'id',
    'user_id',
    'token_hash',
    'csrf_token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_sessions', 'INSERT', [
    'id',
    'user_id',
    'token_hash',
    'csrf_token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_sessions', 'UPDATE', ['revoked_at']),
  ...columnGrants('saas_platform_sessions', 'SELECT', [
    'id',
    'user_id',
    'credential_id',
    'token_hash',
    'csrf_token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_sessions', 'INSERT', [
    'id',
    'user_id',
    'credential_id',
    'token_hash',
    'csrf_token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_sessions', 'UPDATE', ['revoked_at']),
  ...columnGrants('saas_mfa_credentials', 'SELECT', [
    'id',
    'user_id',
    'kind',
    'encrypted_secret',
    'created_at',
    'verified_at',
    'revoked_at',
    'last_used_step',
  ]),
  ...columnGrants('saas_mfa_credentials', 'INSERT', [
    'id',
    'user_id',
    'kind',
    'encrypted_secret',
    'created_at',
    'verified_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_mfa_credentials', 'UPDATE', ['verified_at', 'revoked_at', 'last_used_step']),
  ...columnGrants('saas_platform_mfa_enrollment_tokens', 'SELECT', [
    'id',
    'user_id',
    'token_hash',
    'created_at',
    'expires_at',
    'consumed_at',
  ]),
  ...columnGrants('saas_platform_mfa_enrollment_tokens', 'INSERT', [
    'id',
    'user_id',
    'token_hash',
    'created_at',
    'expires_at',
    'consumed_at',
  ]),
  ...columnGrants('saas_platform_mfa_enrollment_tokens', 'UPDATE', ['consumed_at']),
  ...columnGrants('saas_platform_mfa_setup_tokens', 'SELECT', [
    'id',
    'user_id',
    'credential_id',
    'token_hash',
    'attempt_count',
    'attempt_limit',
    'created_at',
    'expires_at',
    'consumed_at',
    'locked_at',
  ]),
  ...columnGrants('saas_platform_mfa_setup_tokens', 'INSERT', [
    'id',
    'user_id',
    'credential_id',
    'token_hash',
    'attempt_count',
    'attempt_limit',
    'created_at',
    'expires_at',
    'consumed_at',
    'locked_at',
  ]),
  ...columnGrants('saas_platform_mfa_setup_tokens', 'UPDATE', ['attempt_count', 'locked_at', 'consumed_at']),
  ...columnGrants('saas_tenants', 'SELECT', [
    'id',
    'name',
    'slug',
    'slug_canonical',
    'status',
    'created_at',
    'updated_at',
    'capacity_policy_revision',
    'requests_per_minute',
    'tokens_per_minute',
    'max_concurrent_requests',
  ]),
  ...columnGrants('saas_tenants', 'INSERT', ['id', 'name', 'slug', 'status', 'created_at', 'updated_at']),
  ...columnGrants('saas_tenants', 'UPDATE', [
    'requests_per_minute',
    'tokens_per_minute',
    'max_concurrent_requests',
    'capacity_policy_revision',
    'updated_at',
  ]),
  ...columnGrants('saas_memberships', 'SELECT', ['tenant_id', 'user_id', 'role', 'status', 'revoked_at']),
  ...columnGrants('saas_memberships', 'INSERT', ['tenant_id', 'user_id', 'role', 'created_at', 'updated_at']),
  ...columnGrants('saas_projects', 'SELECT', [
    'tenant_id',
    'id',
    'name',
    'slug',
    'slug_canonical',
    'is_default',
    'created_at',
    'updated_at',
    'inference_policy_version',
    'inference_policy_status',
  ]),
  ...columnGrants('saas_projects', 'INSERT', [
    'tenant_id',
    'id',
    'name',
    'slug',
    'is_default',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_projects', 'UPDATE', ['inference_policy_version', 'inference_policy_status', 'updated_at']),
  ...columnGrants('saas_project_memberships', 'SELECT', [
    'tenant_id',
    'project_id',
    'user_id',
    'role',
    'status',
    'revoked_at',
  ]),
  ...columnGrants('saas_project_memberships', 'INSERT', [
    'tenant_id',
    'project_id',
    'user_id',
    'role',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_invitations', 'SELECT', [
    'tenant_id',
    'id',
    'invited_email',
    'invited_email_canonical',
    'role',
    'token_hash',
    'created_by_user_id',
    'accepted_by_user_id',
    'created_at',
    'expires_at',
    'accepted_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_invitations', 'INSERT', [
    'tenant_id',
    'id',
    'invited_email',
    'role',
    'token_hash',
    'created_by_user_id',
    'created_at',
    'expires_at',
    'accepted_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_invitations', 'UPDATE', ['accepted_by_user_id', 'accepted_at', 'revoked_at']),
  ...columnGrants('saas_project_inference_policy_versions', 'SELECT', [
    'tenant_id',
    'project_id',
    'version',
    'status',
    'changed_by_user_id',
    'created_at',
    'requests_per_minute',
    'tokens_per_minute',
    'max_concurrent_requests',
  ]),
  ...columnGrants('saas_project_inference_policy_versions', 'INSERT', [
    'tenant_id',
    'project_id',
    'version',
    'status',
    'changed_by_user_id',
    'created_at',
    'requests_per_minute',
    'tokens_per_minute',
    'max_concurrent_requests',
  ]),
  ...columnGrants('saas_api_keys', 'SELECT', [
    'id',
    'tenant_id',
    'project_id',
    'principal_user_id',
    'execution_principal_type',
    'execution_principal_id',
    'created_by_user_id',
    'rotated_by_user_id',
    'revoked_by_user_id',
    'entitlement_id',
    'supply_profile_id',
    'supply_mode',
    'name',
    'prefix',
    'key_hash',
    'model_scopes',
    'status',
    'created_at',
    'expires_at',
    'revoked_at',
    'last_used_at',
    'authz_version',
    'model_scope_version',
    'entitlement_authz_version',
    'supply_profile_authz_version',
    'requests_per_minute',
    'tokens_per_minute',
    'max_concurrent_requests',
  ]),
  ...columnGrants('saas_api_keys', 'INSERT', [
    'id',
    'tenant_id',
    'project_id',
    'principal_user_id',
    'execution_principal_type',
    'execution_principal_id',
    'created_by_user_id',
    'entitlement_id',
    'supply_profile_id',
    'supply_mode',
    'name',
    'prefix',
    'key_hash',
    'model_scopes',
    'status',
    'created_at',
    'expires_at',
    'revoked_at',
    'last_used_at',
    'authz_version',
    'model_scope_version',
    'entitlement_authz_version',
    'supply_profile_authz_version',
  ]),
  ...columnGrants('saas_api_keys', 'UPDATE', [
    'status',
    'revoked_at',
    'revoked_by_user_id',
    'rotated_by_user_id',
    'last_used_at',
    'authz_version',
    'model_scope_version',
    'entitlement_authz_version',
    'supply_profile_authz_version',
    'requests_per_minute',
    'tokens_per_minute',
    'max_concurrent_requests',
  ]),
  ...columnGrants('saas_route_config_heads', 'SELECT', [
    'tenant_id',
    'project_id',
    'route_id',
    'current_version',
    'status',
  ]),
  ...columnGrants('saas_route_config_versions', 'SELECT', [
    'tenant_id',
    'project_id',
    'route_id',
    'version',
    'public_model_id',
    'public_model_version',
    'status',
    'supply_mode',
    'endpoint',
  ]),
  ...columnGrants('saas_audit_events', 'SELECT', [
    'id',
    'tenant_id',
    'actor_user_id',
    'action',
    'target_type',
    'target_id',
    'occurred_at',
    'source_ip',
    'user_agent',
    'entry_point',
    'request_id',
  ]),
  ...columnGrants('saas_audit_events', 'INSERT', [
    'id',
    'tenant_id',
    'actor_user_id',
    'action',
    'target_type',
    'target_id',
    'occurred_at',
    'source_ip',
    'user_agent',
    'entry_point',
    'request_id',
  ]),
  ...columnGrants('saas_capacity_policy_audit_details', 'SELECT', ['audit_event_id']),
  ...columnGrants('saas_capacity_policy_audit_details', 'INSERT', [
    'audit_event_id',
    'scope',
    'tenant_id',
    'project_id',
    'api_key_id',
    'reason',
    'revision_kind',
    'before_revision',
    'after_revision',
    'before_requests_per_minute',
    'before_tokens_per_minute',
    'before_max_concurrent_requests',
    'after_requests_per_minute',
    'after_tokens_per_minute',
    'after_max_concurrent_requests',
  ]),
  ...columnGrants('saas_provider_products', 'SELECT', [
    'provider_id',
    'product_id',
    'display_name',
    'status',
    'created_at',
  ]),
  ...columnGrants('saas_provider_products', 'INSERT', [
    'provider_id',
    'product_id',
    'display_name',
    'status',
    'created_at',
  ]),
  ...columnGrants('saas_public_models', 'SELECT', ['id', 'alias', 'display_name', 'status', 'created_at']),
  ...columnGrants('saas_public_models', 'INSERT', ['id', 'alias', 'display_name', 'status', 'created_at']),
  ...columnGrants('saas_public_model_versions', 'SELECT', [
    'public_model_id',
    'version',
    'provider_id',
    'product_id',
    'model',
    'endpoint_scope',
    'status',
    'created_at',
  ]),
  ...columnGrants('saas_public_model_versions', 'INSERT', [
    'public_model_id',
    'version',
    'provider_id',
    'product_id',
    'model',
    'endpoint_scope',
    'status',
    'created_at',
  ]),
  ...columnGrants('saas_provider_capabilities', 'SELECT', [
    'provider_id',
    'product_id',
    'model',
    'endpoint',
    'protocol',
    'version',
    'support_level',
    'validation_state',
    'evidence_version',
    'discovery_source',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
  ]),
  ...columnGrants('saas_provider_capabilities', 'INSERT', [
    'provider_id',
    'product_id',
    'model',
    'endpoint',
    'protocol',
    'version',
    'support_level',
    'validation_state',
    'evidence_version',
    'discovery_source',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
  ]),
  ...columnGrants('saas_provider_rights', 'SELECT', [
    'rights_id',
    'version',
    'provider_id',
    'product_id',
    'credential_type',
    'supply_mode',
    'region',
    'purpose',
    'model_scope',
    'endpoint_scope',
    'effective_at',
    'expires_at',
    'approval_ref',
    'status',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
  ]),
  ...columnGrants('saas_provider_rights', 'INSERT', [
    'rights_id',
    'version',
    'provider_id',
    'product_id',
    'credential_type',
    'supply_mode',
    'region',
    'purpose',
    'model_scope',
    'endpoint_scope',
    'effective_at',
    'expires_at',
    'approval_ref',
    'status',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
  ]),
  ...columnGrants('saas_provider_rights_events', 'INSERT', [
    'id',
    'rights_id',
    'rights_version',
    'from_status',
    'to_status',
    'event_type',
    'occurred_at',
  ]),
  ...columnGrants('saas_project_entitlements', 'SELECT', [
    'id',
    'tenant_id',
    'project_id',
    'supply_profile_id',
    'supply_mode',
    'status',
    'model_scopes',
    'authz_version',
    'effective_at',
    'expires_at',
    'superseded_at',
    'disabled_at',
    'updated_at',
    'last_audited_at',
    'source_type',
    'source_ref',
    'service_plan_snapshot_id',
  ]),
  ...columnGrants('saas_project_entitlements', 'INSERT', [
    'id',
    'tenant_id',
    'project_id',
    'supply_profile_id',
    'supply_mode',
    'status',
    'model_scopes',
    'authz_version',
    'created_at',
    'updated_at',
    'last_audited_at',
    'disabled_at',
    'effective_at',
    'expires_at',
    'superseded_at',
    'source_type',
    'source_ref',
    'service_plan_snapshot_id',
  ]),
  ...columnGrants('saas_project_entitlements', 'UPDATE', [
    'status',
    'disabled_at',
    'superseded_at',
    'authz_version',
    'updated_at',
    'last_audited_at',
  ]),
  ...columnGrants('saas_supply_profiles', 'SELECT', [
    'tenant_id',
    'id',
    'supply_mode',
    'status',
    'model_scopes',
    'authz_version',
  ]),
  ...columnGrants('saas_tenant_provider_accounts', 'SELECT', [
    'owner_kind',
    'tenant_id',
    'supply_mode',
    'id',
    'display_name',
    'provider_id',
    'product_id',
    'credential_type',
    'region',
    'purpose',
    'rights_id',
    'rights_version',
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'authz_version',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_tenant_provider_accounts', 'INSERT', [
    'tenant_id',
    'id',
    'display_name',
    'provider_id',
    'product_id',
    'credential_type',
    'region',
    'purpose',
    'rights_id',
    'rights_version',
    'status',
    'validation_state',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_tenant_provider_accounts', 'UPDATE', [
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'authz_version',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_accounts', 'SELECT', [
    'owner_kind',
    'supply_mode',
    'id',
    'display_name',
    'provider_id',
    'product_id',
    'credential_type',
    'region',
    'purpose',
    'rights_id',
    'rights_version',
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'authz_version',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_accounts', 'INSERT', [
    'id',
    'display_name',
    'provider_id',
    'product_id',
    'credential_type',
    'region',
    'purpose',
    'rights_id',
    'rights_version',
    'status',
    'validation_state',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_platform_provider_accounts', 'UPDATE', [
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'authz_version',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_tenant_provider_account_capabilities', 'SELECT', [
    'tenant_id',
    'account_id',
    'provider_id',
    'product_id',
    'model',
    'endpoint',
    'capability_version',
  ]),
  ...columnGrants('saas_tenant_provider_account_capabilities', 'INSERT', [
    'tenant_id',
    'account_id',
    'provider_id',
    'product_id',
    'model',
    'endpoint',
    'capability_version',
  ]),
  ...columnGrants('saas_platform_provider_account_capabilities', 'SELECT', [
    'account_id',
    'provider_id',
    'product_id',
    'model',
    'endpoint',
    'capability_version',
  ]),
  ...columnGrants('saas_platform_provider_account_capabilities', 'INSERT', [
    'account_id',
    'provider_id',
    'product_id',
    'model',
    'endpoint',
    'capability_version',
  ]),
  ...columnGrants('saas_customer_price_versions', 'SELECT', COMMERCIAL_PRICE_VERSION_COLUMNS),
  ...columnGrants('saas_customer_price_versions', 'INSERT', COMMERCIAL_PRICE_VERSION_COLUMNS),
  ...columnGrants('saas_supplier_cost_versions', 'SELECT', [
    ...COMMERCIAL_PRICE_VERSION_COLUMNS.slice(0, 6),
    'resolved_model',
    ...COMMERCIAL_PRICE_VERSION_COLUMNS.slice(6),
  ]),
  ...columnGrants('saas_supplier_cost_versions', 'INSERT', [
    ...COMMERCIAL_PRICE_VERSION_COLUMNS.slice(0, 6),
    'resolved_model',
    ...COMMERCIAL_PRICE_VERSION_COLUMNS.slice(6),
  ]),
  ...columnGrants('saas_tenant_provider_credentials', 'SELECT', [
    'owner_kind',
    'tenant_id',
    'supply_mode',
    'id',
    'account_id',
    'provider_id',
    'product_id',
    'credential_type',
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'current_version',
    'expires_at',
    'authz_version',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_tenant_provider_credentials', 'INSERT', [
    'tenant_id',
    'id',
    'account_id',
    'provider_id',
    'product_id',
    'credential_type',
    'status',
    'validation_state',
    'expires_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_tenant_provider_credentials', 'UPDATE', [
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'current_version',
    'expires_at',
    'authz_version',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_credentials', 'SELECT', [
    'owner_kind',
    'supply_mode',
    'id',
    'account_id',
    'provider_id',
    'product_id',
    'credential_type',
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'current_version',
    'expires_at',
    'authz_version',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_credentials', 'INSERT', [
    'id',
    'account_id',
    'provider_id',
    'product_id',
    'credential_type',
    'status',
    'validation_state',
    'expires_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_platform_provider_credentials', 'UPDATE', [
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'current_version',
    'expires_at',
    'authz_version',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_tenant_provider_credential_versions', 'SELECT', [
    'owner_kind',
    'tenant_id',
    'supply_mode',
    'account_id',
    'credential_id',
    'version',
    'status',
    'schema_version',
    'context_version',
    'algorithm',
    'kms_purpose',
    'kms_key_id',
    'wrapping_revision',
    'wrapped_dek',
    'nonce',
    'ciphertext',
    'auth_tag',
    'created_at',
    'expires_at',
    'retired_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_tenant_provider_credential_versions', 'INSERT', [
    'tenant_id',
    'account_id',
    'credential_id',
    'version',
    'schema_version',
    'context_version',
    'algorithm',
    'kms_purpose',
    'kms_key_id',
    'wrapping_revision',
    'wrapped_dek',
    'nonce',
    'ciphertext',
    'auth_tag',
    'created_at',
    'expires_at',
  ]),
  ...columnGrants('saas_tenant_provider_credential_versions', 'UPDATE', ['status', 'retired_at', 'revoked_at']),
  ...columnGrants('saas_platform_provider_credential_versions', 'SELECT', [
    'owner_kind',
    'supply_mode',
    'account_id',
    'credential_id',
    'version',
    'status',
    'schema_version',
    'context_version',
    'algorithm',
    'kms_purpose',
    'kms_key_id',
    'wrapping_revision',
    'wrapped_dek',
    'nonce',
    'ciphertext',
    'auth_tag',
    'created_at',
    'expires_at',
    'retired_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_credential_versions', 'INSERT', [
    'account_id',
    'credential_id',
    'version',
    'schema_version',
    'context_version',
    'algorithm',
    'kms_purpose',
    'kms_key_id',
    'wrapping_revision',
    'wrapped_dek',
    'nonce',
    'ciphertext',
    'auth_tag',
    'created_at',
    'expires_at',
  ]),
  ...columnGrants('saas_platform_provider_credential_versions', 'UPDATE', ['status', 'retired_at', 'revoked_at']),
  ...columnGrants('saas_tenant_provider_credential_wrappings', 'SELECT', [
    'owner_kind',
    'tenant_id',
    'account_id',
    'credential_id',
    'credential_version',
    'expected_wrapping_revision',
    'wrapping_revision',
    'operation_id',
    'source_kms_key_id',
    'kms_key_id',
    'context_sha256',
    'actor_kind',
    'actor_user_id',
    'actor_workload_id',
    'request_id',
    'reason_code',
    'created_at',
  ]),
  ...columnGrants('saas_tenant_provider_credential_wrappings', 'INSERT', [
    'tenant_id',
    'account_id',
    'credential_id',
    'credential_version',
    'wrapping_revision',
    'expected_wrapping_revision',
    'operation_id',
    'source_kms_key_id',
    'kms_key_id',
    'wrapped_dek',
    'context_sha256',
    'actor_kind',
    'actor_user_id',
    'actor_workload_id',
    'request_id',
    'reason_code',
    'created_at',
  ]),
  ...columnGrants('saas_platform_provider_credential_wrappings', 'SELECT', [
    'owner_kind',
    'account_id',
    'credential_id',
    'credential_version',
    'expected_wrapping_revision',
    'wrapping_revision',
    'operation_id',
    'source_kms_key_id',
    'kms_key_id',
    'context_sha256',
    'actor_kind',
    'actor_user_id',
    'actor_workload_id',
    'request_id',
    'reason_code',
    'created_at',
  ]),
  ...columnGrants('saas_platform_provider_credential_wrappings', 'INSERT', [
    'account_id',
    'credential_id',
    'credential_version',
    'wrapping_revision',
    'expected_wrapping_revision',
    'operation_id',
    'source_kms_key_id',
    'kms_key_id',
    'wrapped_dek',
    'context_sha256',
    'actor_kind',
    'actor_user_id',
    'actor_workload_id',
    'request_id',
    'reason_code',
    'created_at',
  ]),
  ...columnGrants('saas_platform_provider_pools', 'SELECT', [
    'owner_kind',
    'supply_mode',
    'id',
    'display_name',
    'provider_id',
    'product_id',
    'credential_type',
    'region',
    'purpose',
    'rights_id',
    'rights_version',
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'authz_version',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_pools', 'INSERT', [
    'id',
    'owner_kind',
    'supply_mode',
    'display_name',
    'provider_id',
    'product_id',
    'credential_type',
    'region',
    'purpose',
    'rights_id',
    'rights_version',
    'status',
    'validation_state',
    'validation_error_code',
    'last_validated_at',
    'authz_version',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_pool_members', 'SELECT', [
    'pool_id',
    'account_id',
    'provider_id',
    'product_id',
    'account_authz_version',
    'authz_version',
    'status',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_pool_members', 'INSERT', [
    'pool_id',
    'account_id',
    'provider_id',
    'product_id',
    'account_authz_version',
    'authz_version',
    'status',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_platform_provider_pool_members', 'UPDATE', [
    'status',
    'disabled_at',
    'revoked_at',
    'authz_version',
    'updated_at',
  ]),
  ...columnGrants('saas_platform_provider_pool_grants', 'SELECT', [
    'pool_id',
    'tenant_id',
    'supply_profile_id',
    'supply_mode',
    'profile_authz_version',
    'pool_authz_version',
    'status',
    'effective_at',
    'expires_at',
    'authz_version',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_platform_provider_pool_grants', 'INSERT', [
    'pool_id',
    'tenant_id',
    'supply_profile_id',
    'supply_mode',
    'profile_authz_version',
    'pool_authz_version',
    'status',
    'effective_at',
    'expires_at',
    'authz_version',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_platform_provider_pool_grants', 'UPDATE', [
    'status',
    'disabled_at',
    'revoked_at',
    'authz_version',
    'updated_at',
  ]),
  ...columnGrants('saas_tenant_provider_supply_profile_accounts', 'SELECT', [
    'tenant_id',
    'supply_profile_id',
    'supply_mode',
    'account_id',
    'provider_id',
    'product_id',
    'account_authz_version',
    'status',
    'effective_at',
    'expires_at',
    'authz_version',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
    'updated_at',
    'disabled_at',
    'revoked_at',
  ]),
  ...columnGrants('saas_tenant_provider_supply_profile_accounts', 'INSERT', [
    'tenant_id',
    'supply_profile_id',
    'supply_mode',
    'account_id',
    'provider_id',
    'product_id',
    'account_authz_version',
    'status',
    'effective_at',
    'expires_at',
    'authz_version',
    'evidence_ref',
    'evidence_sha256',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_tenant_provider_supply_profile_accounts', 'UPDATE', [
    'status',
    'disabled_at',
    'revoked_at',
    'authz_version',
    'updated_at',
  ]),
  ...columnGrants('saas_tenant_provider_credential_validation_jobs', 'SELECT', [
    'id',
    'tenant_id',
    'account_id',
    'credential_id',
    'credential_version',
    'provider_id',
    'product_id',
    'credential_type',
    'allowed_models',
    'target_model',
    'target_endpoint',
    'capability_version',
    'idempotency_key',
    'status',
    'attempt_count',
    'available_at',
    'lease_until',
    'lease_generation',
    'last_error_code',
    'completed_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_tenant_provider_credential_validation_jobs', 'INSERT', [
    'tenant_id',
    'account_id',
    'credential_id',
    'credential_version',
    'provider_id',
    'product_id',
    'credential_type',
    'allowed_models',
    'target_model',
    'target_endpoint',
    'capability_version',
    'idempotency_key',
  ]),
  ...columnGrants('saas_service_plans', 'SELECT', ['id', 'slug', 'display_name', 'status', 'created_at', 'updated_at']),
  ...columnGrants('saas_service_plan_versions', 'SELECT', [
    'id',
    'plan_id',
    'version',
    'supply_mode',
    'supply_profile_id',
    'allowed_provider_ids',
    'allowed_models',
    'price_version',
    'price_minor_units',
    'currency',
    'term_days',
    'policy_version',
    'status',
    'created_at',
    'published_at',
    'retired_at',
  ]),
  ...columnGrants('saas_service_plan_orders', 'SELECT', [
    'id',
    'tenant_id',
    'project_id',
    'plan_version_id',
    'operation',
    'renewal_of_subscription_id',
    'client_request_id',
    'state',
    'subscription_id',
    'verified_settlement_id',
    'verified_provider_key',
    'verified_merchant_id',
    'verified_amount_minor_units',
    'verified_currency',
    'fulfillment_reference',
    'fulfillment_evidence_sha256',
    'verified_at',
    'created_at',
    'updated_at',
    'paid_at',
    'fulfilled_at',
    'provider_key',
    'merchant_id',
    'provider_order_id',
    'provider_attempts',
    'provider_failure_code',
    'checkout_kind',
    'checkout_url',
    'checkout_text',
    'checkout_expires_at',
    'provider_submission_state',
    'provider_submission_lease_token',
    'provider_submission_lease_expires_at',
  ]),
  ...columnGrants('saas_service_plan_orders', 'INSERT', [
    'id',
    'tenant_id',
    'project_id',
    'plan_version_id',
    'operation',
    'renewal_of_subscription_id',
    'client_request_id',
    'state',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_service_plan_orders', 'UPDATE', [
    'state',
    'subscription_id',
    'verified_settlement_id',
    'verified_provider_key',
    'verified_merchant_id',
    'verified_amount_minor_units',
    'verified_currency',
    'fulfillment_reference',
    'fulfillment_evidence_sha256',
    'verified_at',
    'paid_at',
    'fulfilled_at',
    'updated_at',
    'provider_key',
    'merchant_id',
    'provider_order_id',
    'provider_attempts',
    'provider_failure_code',
    'checkout_kind',
    'checkout_url',
    'checkout_text',
    'checkout_expires_at',
    'provider_submission_state',
    'provider_submission_lease_token',
    'provider_submission_lease_expires_at',
  ]),
  ...columnGrants('saas_service_plan_snapshots', 'SELECT', [
    'id',
    'tenant_id',
    'order_id',
    'plan_version_id',
    'plan_id',
    'plan_version',
    'allowed_provider_ids',
    'allowed_models',
    'supply_mode',
    'supply_profile_id',
    'price_version',
    'price_minor_units',
    'currency',
    'term_days',
    'policy_version',
    'snapshot_digest',
    'created_at',
  ]),
  ...columnGrants('saas_service_plan_snapshots', 'INSERT', [
    'id',
    'tenant_id',
    'order_id',
    'plan_version_id',
    'plan_id',
    'plan_version',
    'allowed_provider_ids',
    'allowed_models',
    'supply_mode',
    'supply_profile_id',
    'price_version',
    'price_minor_units',
    'currency',
    'term_days',
    'policy_version',
    'snapshot_digest',
    'created_at',
  ]),
  ...columnGrants('saas_service_plan_subscriptions', 'SELECT', [
    'id',
    'tenant_id',
    'project_id',
    'order_id',
    'snapshot_id',
    'entitlement_id',
    'previous_subscription_id',
    'operation',
    'status',
    'effective_at',
    'expires_at',
    'activated_at',
    'superseded_at',
    'expired_at',
    'cancelled_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_service_plan_subscriptions', 'INSERT', [
    'id',
    'tenant_id',
    'project_id',
    'order_id',
    'snapshot_id',
    'entitlement_id',
    'previous_subscription_id',
    'operation',
    'status',
    'effective_at',
    'expires_at',
    'activated_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_service_plan_subscriptions', 'UPDATE', [
    'status',
    'activated_at',
    'superseded_at',
    'expired_at',
    'cancelled_at',
    'updated_at',
  ]),
  ...columnGrants('saas_refund_service_plan_effects', 'SELECT', [
    'effect_ref',
    'tenant_id',
    'refund_order_id',
    'project_id',
    'source_service_plan_order_id',
    'source_subscription_id',
    'source_snapshot_id',
    'source_entitlement_id',
    'refund_policy_version',
    'service_plan_policy_version',
    'amount_minor_units',
    'currency',
    'cutoff_at',
    'requested_by_user_id',
    'reason_code',
    'state',
    'suspended_authz_version',
    'suspended_at',
    'suspension_released_at',
    'released_authz_version',
    'request_audit_event_id',
    'outcome_audit_event_id',
    'created_at',
    'updated_at',
    'completed_at',
  ]),
  ...columnGrants('saas_refund_service_plan_effects', 'INSERT', [
    'effect_ref',
    'tenant_id',
    'refund_order_id',
    'project_id',
    'source_service_plan_order_id',
    'source_subscription_id',
    'source_snapshot_id',
    'source_entitlement_id',
    'refund_policy_version',
    'service_plan_policy_version',
    'amount_minor_units',
    'currency',
    'cutoff_at',
    'requested_by_user_id',
    'reason_code',
    'state',
    'suspended_authz_version',
    'suspended_at',
    'request_audit_event_id',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_refund_service_plan_effects', 'UPDATE', [
    'state',
    'suspension_released_at',
    'released_authz_version',
    'outcome_audit_event_id',
    'updated_at',
    'completed_at',
  ]),
  ...columnGrants('saas_payment_orders', 'SELECT', [
    'id',
    'tenant_id',
    'order_type',
    'provider_key',
    'merchant_id',
    'client_request_id',
    'local_order_ref',
    'funding_reference',
    'amount_minor_units',
    'currency',
    'state',
    'provider_order_id',
    'provider_attempts',
    'provider_failure_code',
    'funding_transaction_id',
    'created_at',
    'updated_at',
    'paid_at',
    'fulfilled_at',
    'checkout_kind',
    'checkout_url',
    'checkout_text',
    'checkout_expires_at',
    'provider_submission_state',
    'provider_submission_lease_token',
    'provider_submission_lease_expires_at',
  ]),
  ...columnGrants('saas_payment_orders', 'INSERT', [
    'id',
    'tenant_id',
    'order_type',
    'provider_key',
    'merchant_id',
    'client_request_id',
    'local_order_ref',
    'funding_reference',
    'amount_minor_units',
    'currency',
    'state',
    'provider_attempts',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_payment_orders', 'UPDATE', [
    'state',
    'provider_order_id',
    'provider_attempts',
    'provider_failure_code',
    'funding_transaction_id',
    'paid_at',
    'fulfilled_at',
    'checkout_kind',
    'checkout_url',
    'checkout_text',
    'checkout_expires_at',
    'provider_submission_state',
    'provider_submission_lease_token',
    'provider_submission_lease_expires_at',
    'updated_at',
  ]),
  ...columnGrants('saas_payment_inbox', 'SELECT', [
    'id',
    'provider_key',
    'merchant_id',
    'provider_event_id',
    'event_type',
    'provider_order_id',
    'event_tenant_id',
    'tenant_id',
    'local_order_id',
    'event_status',
    'amount_minor_units',
    'currency',
    'occurred_at',
    'received_at',
    'processing_outcome',
    'outcome_code',
    'processing_state',
    'attempt_count',
    'next_attempt_at',
    'lease_token',
    'lease_expires_at',
    'processed_at',
    'last_error_code',
    'updated_at',
  ]),
  ...columnGrants('saas_payment_inbox', 'INSERT', [
    'id',
    'provider_key',
    'merchant_id',
    'provider_event_id',
    'event_type',
    'provider_order_id',
    'event_tenant_id',
    'tenant_id',
    'local_order_id',
    'event_status',
    'amount_minor_units',
    'currency',
    'occurred_at',
    'received_at',
    'next_attempt_at',
    'updated_at',
    'processing_outcome',
    'outcome_code',
  ]),
  ...columnGrants('saas_payment_inbox', 'UPDATE', [
    'processing_outcome',
    'outcome_code',
    'processing_state',
    'attempt_count',
    'next_attempt_at',
    'lease_token',
    'lease_expires_at',
    'processed_at',
    'last_error_code',
    'updated_at',
  ]),
  ...columnGrants('saas_refund_orders', 'SELECT', [
    'id',
    'tenant_id',
    'refund_type',
    'wallet_topup_order_id',
    'service_plan_order_id',
    'original_funding_transaction_id',
    'wallet_id',
    'provider_key',
    'merchant_id',
    'provider_order_id',
    'original_local_order_ref',
    'idempotency_namespace',
    'client_request_id',
    'requested_by_user_id',
    'authorization_ref',
    'reason_code',
    'amount_minor_units',
    'currency',
    'state',
    'provider_refund_id',
    'failure_code',
    'blocked_code',
    'wallet_refund_transaction_id',
    'provider_attempts',
    'lease_action',
    'service_plan_effect_ref',
    'lease_token',
    'lease_expires_at',
    'next_reconcile_at',
    'created_at',
    'updated_at',
    'completed_at',
  ]),
  ...columnGrants('saas_refund_orders', 'INSERT', [
    'id',
    'tenant_id',
    'refund_type',
    'wallet_topup_order_id',
    'service_plan_order_id',
    'original_funding_transaction_id',
    'wallet_id',
    'provider_key',
    'merchant_id',
    'provider_order_id',
    'original_local_order_ref',
    'idempotency_namespace',
    'client_request_id',
    'requested_by_user_id',
    'authorization_ref',
    'reason_code',
    'amount_minor_units',
    'currency',
    'state',
    'blocked_code',
    'service_plan_effect_ref',
    'provider_attempts',
    'lease_action',
    'lease_token',
    'lease_expires_at',
    'next_reconcile_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_refund_orders', 'UPDATE', [
    'state',
    'provider_refund_id',
    'failure_code',
    'blocked_code',
    'wallet_refund_transaction_id',
    'provider_attempts',
    'lease_action',
    'lease_token',
    'lease_expires_at',
    'next_reconcile_at',
    'updated_at',
    'completed_at',
  ]),
  ...columnGrants('saas_refund_wallet_freezes', 'SELECT', [
    'refund_order_id',
    'tenant_id',
    'wallet_id',
    'currency',
    'amount_minor_units',
    'created_at',
  ]),
  ...columnGrants('saas_refund_wallet_freezes', 'INSERT', [
    'refund_order_id',
    'tenant_id',
    'wallet_id',
    'currency',
    'amount_minor_units',
    'created_at',
  ]),
  ...columnGrants('saas_wallets', 'SELECT', [
    'id',
    'tenant_id',
    'currency',
    'posted_balance_minor_units',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_wallets', 'INSERT', [
    'id',
    'tenant_id',
    'currency',
    'posted_balance_minor_units',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_wallets', 'UPDATE', ['posted_balance_minor_units', 'updated_at']),
  ...columnGrants('saas_billing_spending_freezes', 'SELECT', ['tenant_id', 'reason_ref', 'frozen_at']),
  ...columnGrants('saas_billing_spending_freezes', 'INSERT', ['tenant_id', 'reason_ref', 'frozen_at']),
  ...columnGrants('saas_billing_reservations', 'SELECT', [
    'id',
    'tenant_id',
    'wallet_id',
    'currency',
    'request_id',
    'idempotency_namespace',
    'business_key',
    'amount_minor_units',
    'state',
    'price_snapshot_ref',
    'metadata_ref',
    'expires_at',
    'settlement_id',
    'settlement_amount_minor_units',
    'usage_evidence_ref',
    'reconciliation_reference',
    'reconciliation_evidence_ref',
    'release_id',
    'release_evidence_ref',
    'ledger_transaction_id',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_billing_reservations', 'INSERT', [
    'id',
    'tenant_id',
    'wallet_id',
    'currency',
    'request_id',
    'idempotency_namespace',
    'business_key',
    'amount_minor_units',
    'state',
    'price_snapshot_ref',
    'metadata_ref',
    'expires_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_billing_reservations', 'UPDATE', [
    'state',
    'settlement_id',
    'settlement_amount_minor_units',
    'usage_evidence_ref',
    'reconciliation_reference',
    'reconciliation_evidence_ref',
    'release_id',
    'release_evidence_ref',
    'ledger_transaction_id',
    'updated_at',
  ]),
  ...columnGrants('saas_ledger_transactions', 'SELECT', [
    'id',
    'tenant_id',
    'currency',
    'idempotency_namespace',
    'business_key',
    'source_type',
    'amount_minor_units',
    'metadata_ref',
    'source_order_ref',
    'price_snapshot_ref',
    'usage_evidence_ref',
    'created_at',
  ]),
  ...columnGrants('saas_ledger_transactions', 'INSERT', [
    'id',
    'tenant_id',
    'currency',
    'idempotency_namespace',
    'business_key',
    'source_type',
    'amount_minor_units',
    'metadata_ref',
    'source_order_ref',
    'price_snapshot_ref',
    'usage_evidence_ref',
    'created_at',
  ]),
  ...columnGrants('saas_ledger_entries', 'SELECT', [
    'id',
    'transaction_id',
    'tenant_id',
    'currency',
    'direction',
    'amount_minor_units',
    'account_type',
    'account_ref',
    'wallet_id',
    'created_at',
  ]),
  ...columnGrants('saas_ledger_entries', 'INSERT', [
    'id',
    'transaction_id',
    'tenant_id',
    'currency',
    'direction',
    'amount_minor_units',
    'account_type',
    'account_ref',
    'wallet_id',
    'created_at',
  ]),
  ...columnGrants('saas_provider_account_leases', 'SELECT', ['status', 'lease_expires_at']),
  ...columnGrants('saas_provider_account_runtime_health', 'SELECT', [
    'owner_scope_key',
    'owner_kind',
    'state',
    'cooldown_until',
    'observed_at',
  ]),
  ...columnGrants('saas_requests', 'SELECT', [
    'id',
    'tenant_id',
    'project_id',
    'public_model',
    'protocol',
    'supply_mode',
    'execution_state',
    'financial_status',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_attempts', 'SELECT', [
    'id',
    'tenant_id',
    'request_id',
    'ordinal',
    'result_state',
    'response_started',
    'response_started_at',
    'result_http_status',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_usage_events', 'SELECT', [
    'id',
    'tenant_id',
    'request_id',
    'supply_mode',
    'input_total',
    'input_uncached',
    'cache_read',
    'cache_write',
    'cache_write_5m',
    'cache_write_1h',
    'output_total',
    'reasoning_output',
    'status',
    'source',
    'measurement_kind',
    'billable_basis',
    'created_at',
  ]),
  // The control-plane recovery scanner and operator resolution repository use
  // only the durable case lifecycle and append-only observation projections.
  ...columnGrants('saas_unknown_outcome_reconciliation_cases', 'SELECT', [
    'id',
    'tenant_id',
    'project_id',
    'request_id',
    'supply_mode',
    'case_state',
    'scan_attempt_count',
    'next_attempt_at',
    'lease_token',
    'lease_expires_at',
    'last_error_code',
    'created_at',
    'resolution_idempotency_key',
    'resolution_digest',
    'resolution_support_ticket_ref',
  ]),
  ...columnGrants('saas_unknown_outcome_reconciliation_cases', 'INSERT', [
    'id',
    'tenant_id',
    'project_id',
    'request_id',
    'supply_mode',
    'case_state',
    'scan_attempt_count',
    'next_attempt_at',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_unknown_outcome_reconciliation_cases', 'UPDATE', [
    'case_state',
    'scan_attempt_count',
    'next_attempt_at',
    'lease_token',
    'lease_expires_at',
    'last_error_code',
    'resolution_idempotency_key',
    'resolution_digest',
    'resolution_support_ticket_ref',
    'resolution_actor_user_id',
    'resolution_reason',
    'resolution_evidence_digest',
    'resolution_audit_event_id',
    'resolved_at',
    'updated_at',
  ]),
  ...columnGrants('saas_unknown_outcome_reconciliation_observations', 'SELECT', [
    'id',
    'tenant_id',
    'case_id',
    'observation_kind',
    'observed_at',
    'attempt_id',
    'usage_event_id',
    'supply_mode',
    'execution_state',
    'reconciliation_state',
    'financial_status',
    'request_state_version',
    'dispatch_state',
    'result_state',
    'response_started',
    'attempt_state_version',
    'upstream_id',
    'account_owner_kind',
    'account_id',
    'provider_id',
    'product_id',
    'resolved_model',
    'attempt_unknown_reason',
    'usage_event_digest',
    'provider_status',
    'provider_operation_id',
    'provider_identity_digest',
    'provider_usage',
    'evidence_reference',
    'operator_outcome',
    'actor_user_id',
    'reason',
    'audit_event_id',
    'support_ticket_ref',
  ]),
  ...columnGrants('saas_unknown_outcome_reconciliation_observations', 'INSERT', [
    'id',
    'tenant_id',
    'case_id',
    'request_id',
    'attempt_id',
    'usage_event_id',
    'observation_kind',
    'supply_mode',
    'execution_state',
    'reconciliation_state',
    'financial_status',
    'request_state_version',
    'dispatch_state',
    'result_state',
    'response_started',
    'attempt_state_version',
    'upstream_id',
    'account_owner_kind',
    'account_id',
    'provider_id',
    'product_id',
    'resolved_model',
    'attempt_unknown_reason',
    'usage_event_digest',
    'evidence_reference',
    'operator_outcome',
    'actor_user_id',
    'reason',
    'audit_event_id',
    'support_ticket_ref',
    'observed_at',
    'provider_status',
    'provider_operation_id',
    'provider_identity_digest',
    'provider_usage',
  ]),
  // Mounted customer endpoint lifecycle and delivery worker. Event payloads
  // and target URLs are read by the worker's send path; the currently mounted
  // endpoint metadata API also selects target_url. The safe delivery-history
  // projection adds only outcome metadata; enqueue, replay, and retention stay
  // outside this mounted contract.
  ...columnGrants('saas_customer_webhook_tenant_policies', 'SELECT', ['tenant_id', 'enabled', 'max_active_endpoints']),
  // PostgreSQL requires UPDATE on at least one column for SELECT ... FOR UPDATE.
  // This low-impact timestamp column keeps that requirement column-scoped.
  ...columnGrants('saas_customer_webhook_tenant_policies', 'UPDATE', ['updated_at']),
  ...columnGrants('saas_customer_webhook_endpoints', 'SELECT', [
    'tenant_id',
    'id',
    'current_version',
    'state',
    'created_at',
    'updated_at',
  ]),
  ...columnGrants('saas_customer_webhook_endpoints', 'INSERT', [
    'tenant_id',
    'id',
    'current_version',
    'state',
    'created_by_user_id',
  ]),
  ...columnGrants('saas_customer_webhook_endpoints', 'UPDATE', ['current_version', 'state', 'updated_at']),
  ...columnGrants('saas_customer_webhook_endpoint_versions', 'SELECT', [
    'tenant_id',
    'endpoint_id',
    'version',
    'target_url',
    'event_types',
  ]),
  ...columnGrants('saas_customer_webhook_endpoint_versions', 'INSERT', [
    'tenant_id',
    'endpoint_id',
    'version',
    'target_url',
    'event_types',
    'created_by_user_id',
    'audit_event_id',
  ]),
  ...columnGrants('saas_customer_webhook_signing_secrets', 'SELECT', [
    'tenant_id',
    'endpoint_id',
    'secret_version',
    'state',
    'overlap_expires_at',
    'encrypted_envelope',
    'created_at',
  ]),
  ...columnGrants('saas_customer_webhook_signing_secrets', 'INSERT', [
    'tenant_id',
    'endpoint_id',
    'secret_version',
    'state',
    'encrypted_envelope',
    'audit_event_id',
  ]),
  ...columnGrants('saas_customer_webhook_signing_secrets', 'UPDATE', ['state', 'overlap_expires_at']),
  ...columnGrants('saas_customer_webhook_events', 'SELECT', [
    'tenant_id',
    'event_id',
    'event_type',
    'schema_version',
    'occurred_at',
    'payload',
  ]),
  ...columnGrants('saas_customer_webhook_deliveries', 'SELECT', [
    'tenant_id',
    'id',
    'event_id',
    'endpoint_id',
    'endpoint_version',
    'secret_version',
    'overlap_secret_version',
    'payload_version',
    'state',
    'attempt_count',
    'attempt_sequence',
    'last_http_status',
    'last_latency_ms',
    'last_error_code',
    'available_at',
    'lease_token',
    'lease_expires_at',
    'fencing_token',
    'created_at',
  ]),
  ...columnGrants('saas_customer_webhook_deliveries', 'UPDATE', [
    'state',
    'attempt_count',
    'attempt_sequence',
    'available_at',
    'lease_token',
    'lease_expires_at',
    'fencing_token',
    'last_http_status',
    'last_latency_ms',
    'last_error_code',
    'delivered_at',
    'updated_at',
  ]),
  ...columnGrants('saas_customer_webhook_delivery_attempts', 'SELECT', [
    'tenant_id',
    'delivery_id',
    'fencing_token',
    'lease_token',
    'state',
  ]),
  ...columnGrants('saas_customer_webhook_delivery_attempts', 'INSERT', [
    'tenant_id',
    'delivery_id',
    'attempt_sequence',
    'fencing_token',
    'lease_token',
    'state',
  ]),
  // The worker may finish only an in-flight attempt; immutable identity stays fixed.
  ...columnGrants('saas_customer_webhook_delivery_attempts', 'UPDATE', [
    'state',
    'http_status',
    'latency_ms',
    'error_code',
    'finished_at',
  ]),
  ...columnGrants('saas_customer_webhook_tenant_usage', 'SELECT', ['tenant_id', 'pending_deliveries']),
  ...columnGrants('saas_customer_webhook_tenant_usage', 'UPDATE', ['pending_deliveries', 'updated_at']),
] as const;

/** Table-level DELETE is the narrowest PostgreSQL privilege for these two SQL statements. */
export const SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS: readonly SaasControlPlaneTableGrant[] = [
  ['saas_billing_spending_freezes', 'DELETE'],
  ['saas_refund_wallet_freezes', 'DELETE'],
];

/** Control-plane IDs are application-generated; the provider lease sequence is gateway-only. */
export const SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS: readonly SaasControlPlaneSequenceGrant[] = [];

const controlPlaneColumnValues = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.map(
  ([table, column, privilege]) => `('${table}', '${column}', '${privilege}')`,
).join(',\n    ');
const controlPlaneTableValues = SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS.map(
  ([table, privilege]) => `('${table}', '${privilege}')`,
).join(',\n    ');
const controlPlaneSequenceValues = SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS.length
  ? SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS.map(([sequence, privilege]) => `('${sequence}', '${privilege}')`).join(
      ',\n    ',
    )
  : 'SELECT NULL::text AS sequence_name, NULL::text AS privilege_type WHERE FALSE';

interface RuntimePrivilegeProbeRow {
  readonly role_exists: boolean;
  readonly server_version_supported: boolean;
  readonly managed_schema: boolean;
  readonly login_role: boolean;
  readonly session_role_unchanged: boolean;
  readonly superuser: boolean;
  readonly create_database: boolean;
  readonly create_role: boolean;
  readonly replication_role: boolean;
  readonly bypass_rls: boolean;
  readonly any_role_membership: boolean;
  readonly owns_database: boolean;
  readonly owns_application_schema: boolean;
  readonly owns_database_objects: boolean;
  readonly schema_create: boolean;
  readonly database_create: boolean;
  readonly database_temp: boolean;
  readonly truncate_privilege: boolean;
  readonly extra_table_privilege: boolean;
  readonly missing_table_privilege_count: number | string;
  readonly out_of_schema_table_privilege: boolean;
  readonly out_of_schema_sequence_privilege: boolean;
  readonly out_of_schema_function_privilege: boolean;
  readonly application_table_count: number | string;
  readonly missing_select_count: number | string;
  readonly missing_insert_count: number | string;
  readonly missing_update_count: number | string;
  readonly unsafe_delete_privilege: boolean;
  readonly missing_sequence_privilege_count: number | string;
  readonly unexpected_sequence_privilege_count: number | string;
  readonly missing_function_execute_count: number | string;
  readonly unsafe_security_definer_function_count: number | string;
}

/** Verifies the dedicated control-plane role's exact column-level contract. */
export const SAAS_RUNTIME_PRIVILEGE_PROBE_SQL = `
WITH RECURSIVE runtime_role AS (
  SELECT oid, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
),
application_schema AS (
  SELECT namespace.oid, namespace.nspname
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname = pg_catalog.current_schema()
),
role_closure(role_oid) AS (
  SELECT oid FROM runtime_role
  UNION
  SELECT membership.roleid
  FROM pg_catalog.pg_auth_members AS membership
  JOIN role_closure AS parent_role ON parent_role.role_oid = membership.member
),
expected_column_privileges(table_name, column_name, privilege_type) AS (VALUES
    ${controlPlaneColumnValues}
),
expected_table_privileges(table_name, privilege_type) AS (VALUES
    ${controlPlaneTableValues}
),
expected_sequence_privileges(sequence_name, privilege_type) AS (
    ${controlPlaneSequenceValues}
),
application_relations AS (
  SELECT relation.oid, relation.relname, relation.relkind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.oid = (SELECT oid FROM application_schema)
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
application_tables AS (
  SELECT oid FROM application_relations WHERE relkind IN ('r', 'p')
),
application_sequences AS (
  SELECT oid, relname FROM application_relations WHERE relkind = 'S'
),
application_columns AS (
  SELECT relation.oid, relation.relname, attribute.attnum, attribute.attname
  FROM application_relations AS relation
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND attribute.attnum > 0 AND NOT attribute.attisdropped
)
SELECT
  current_user = 'model_router_saas_control_plane'
    AND coalesce((SELECT NOT rolinherit FROM runtime_role), false) AS role_exists,
  pg_catalog.current_setting('server_version_num')::integer >= 150000 AS server_version_supported,
  (
    pg_catalog.current_schema() = 'model_router_saas'
    AND pg_catalog.current_setting('search_path') = 'model_router_saas'
    AND pg_catalog.current_schemas(false) = ARRAY['model_router_saas']::pg_catalog.name[]
    AND pg_catalog.current_schemas(true) = ARRAY['pg_catalog', 'model_router_saas']::pg_catalog.name[]
  ) AS managed_schema,
  coalesce((SELECT rolcanlogin FROM runtime_role), false) AS login_role,
  current_user = session_user AS session_role_unchanged,
  coalesce((SELECT rolsuper FROM runtime_role), true) AS superuser,
  coalesce((SELECT rolcreatedb FROM runtime_role), true) AS create_database,
  coalesce((SELECT rolcreaterole FROM runtime_role), true) AS create_role,
  coalesce((SELECT rolreplication FROM runtime_role), true) AS replication_role,
  coalesce((SELECT rolbypassrls FROM runtime_role), true) AS bypass_rls,
  EXISTS (
    SELECT 1 FROM role_closure
    WHERE role_oid <> (SELECT oid FROM runtime_role)
  ) AS any_role_membership,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_database
    WHERE datname = pg_catalog.current_database() AND datdba = (SELECT oid FROM runtime_role)
  ) AS owns_database,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE oid = (SELECT oid FROM application_schema) AND nspowner = (SELECT oid FROM runtime_role)
  ) AS owns_application_schema,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_shdepend AS dependency
    JOIN pg_catalog.pg_database AS db ON db.datname = pg_catalog.current_database()
    WHERE dependency.dbid = db.oid
      AND dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = (SELECT oid FROM runtime_role)
      AND dependency.deptype = 'o'
  ) AS owns_database_objects,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'CREATE')
  ) AS schema_create,
  coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE'), true) AS database_create,
  coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP'), true) AS database_temp,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND relation.relkind IN ('r', 'p')
      AND pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
  ) AS truncate_privilege,
  EXISTS (
    SELECT 1
    FROM application_relations AS relation
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR (pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
          AND NOT EXISTS (
            SELECT 1 FROM expected_table_privileges AS expected
            WHERE expected.table_name = relation.relname AND expected.privilege_type = 'DELETE'
          ))
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
        OR CASE
          WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
            THEN pg_catalog.has_table_privilege(current_user, relation.oid, 'MAINTAIN')
          ELSE false
        END
      )
  ) OR EXISTS (
    SELECT 1
    FROM application_columns AS actual
    WHERE (
      pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'SELECT')
      AND NOT EXISTS (
        SELECT 1 FROM expected_column_privileges AS expected
        WHERE expected.table_name = actual.relname AND expected.column_name = actual.attname
          AND expected.privilege_type = 'SELECT'
      )
    ) OR (
      pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'INSERT')
      AND NOT EXISTS (
        SELECT 1 FROM expected_column_privileges AS expected
        WHERE expected.table_name = actual.relname AND expected.column_name = actual.attname
          AND expected.privilege_type = 'INSERT'
      )
    ) OR (
      pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'UPDATE')
      AND NOT EXISTS (
        SELECT 1 FROM expected_column_privileges AS expected
        WHERE expected.table_name = actual.relname AND expected.column_name = actual.attname
          AND expected.privilege_type = 'UPDATE'
      )
    ) OR pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'REFERENCES')
  ) AS extra_table_privilege,
  (SELECT pg_catalog.count(*)::integer FROM application_tables) AS application_table_count,
  (SELECT pg_catalog.count(*)::integer
   FROM expected_table_privileges AS expected
   LEFT JOIN application_relations AS relation
     ON relation.relname = expected.table_name AND relation.relkind IN ('r', 'p')
   WHERE relation.oid IS NULL
      OR NOT pg_catalog.has_table_privilege(current_user, relation.oid, expected.privilege_type))
    AS missing_table_privilege_count,
  (SELECT pg_catalog.count(*)::integer
   FROM expected_column_privileges AS expected
   LEFT JOIN application_columns AS actual
     ON actual.relname = expected.table_name AND actual.attname = expected.column_name
   WHERE expected.privilege_type = 'SELECT'
     AND (actual.oid IS NULL OR NOT pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'SELECT')))
    AS missing_select_count,
  (SELECT pg_catalog.count(*)::integer
   FROM expected_column_privileges AS expected
   LEFT JOIN application_columns AS actual
     ON actual.relname = expected.table_name AND actual.attname = expected.column_name
   WHERE expected.privilege_type = 'INSERT'
     AND (actual.oid IS NULL OR NOT pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'INSERT')))
    AS missing_insert_count,
  (SELECT pg_catalog.count(*)::integer
   FROM expected_column_privileges AS expected
   LEFT JOIN application_columns AS actual
     ON actual.relname = expected.table_name AND actual.attname = expected.column_name
   WHERE expected.privilege_type = 'UPDATE'
     AND (actual.oid IS NULL OR NOT pg_catalog.has_column_privilege(current_user, actual.oid, actual.attnum, 'UPDATE')))
    AS missing_update_count,
  EXISTS (
    SELECT 1
    FROM application_relations AS relation
    WHERE relation.relkind IN ('r', 'p')
      AND pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
      AND NOT EXISTS (
        SELECT 1 FROM expected_table_privileges AS expected
        WHERE expected.table_name = relation.relname AND expected.privilege_type = 'DELETE'
      )
  ) AS unsafe_delete_privilege,
  (SELECT pg_catalog.count(*)::integer
   FROM expected_sequence_privileges AS expected
   LEFT JOIN application_sequences AS sequence ON sequence.relname = expected.sequence_name
   WHERE sequence.oid IS NULL
      OR NOT pg_catalog.has_sequence_privilege(current_user, sequence.oid, expected.privilege_type))
    AS missing_sequence_privilege_count,
  (SELECT pg_catalog.count(*)::integer
   FROM application_sequences AS sequence
   CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS privilege(privilege_type)
   WHERE pg_catalog.has_sequence_privilege(current_user, sequence.oid, privilege.privilege_type)
     AND NOT EXISTS (
       SELECT 1 FROM expected_sequence_privileges AS expected
       WHERE expected.sequence_name = sequence.relname
         AND expected.privilege_type = privilege.privilege_type
     )) AS unexpected_sequence_privilege_count,
  (SELECT pg_catalog.count(*)::integer
   FROM pg_catalog.pg_proc AS proc
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.oid = (SELECT oid FROM application_schema)
     AND pg_catalog.has_function_privilege(current_user, proc.oid, 'EXECUTE'))
    AS missing_function_execute_count,
  (SELECT pg_catalog.count(*)::integer
   FROM pg_catalog.pg_proc AS proc
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.oid = (SELECT oid FROM application_schema)
     AND proc.prosecdef
     AND pg_catalog.has_function_privilege(current_user, proc.oid, 'EXECUTE'))
    AS unsafe_security_definer_function_count,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
        OR CASE
          WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
            THEN pg_catalog.has_table_privilege(current_user, relation.oid, 'MAINTAIN')
          ELSE false
        END
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS column_acl
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND column_acl.grantee IN (0, (SELECT oid FROM runtime_role))
  ) AS out_of_schema_table_privilege,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS seq
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = seq.relnamespace
    WHERE seq.relkind = 'S'
      AND namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND (
        pg_catalog.has_sequence_privilege(current_user, seq.oid, 'UPDATE')
        OR pg_catalog.has_sequence_privilege(current_user, seq.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege(current_user, seq.oid, 'SELECT')
      )
  ) AS out_of_schema_sequence_privilege,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS proc
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND pg_catalog.has_function_privilege(current_user, proc.oid, 'EXECUTE')
  ) AS out_of_schema_function_privilege
` as const;

/**
 * Relations the dedicated gateway reads. A number of the authority adapters
 * deliberately use SELECT * while they validate and lock a complete immutable
 * snapshot. The role template grants SELECT by column on these relations only;
 * new columns remain inaccessible until the template is reconciled again.
 */
export const SAAS_GATEWAY_RUNTIME_READ_TABLES = [
  'saas_tenants',
  'saas_projects',
  'saas_project_inference_policy_versions',
  'saas_users',
  'saas_memberships',
  'saas_project_memberships',
  'saas_api_keys',
  'saas_requests',
  'saas_attempts',
  'saas_project_entitlements',
  'saas_supply_profiles',
  'saas_route_config_versions',
  'saas_route_config_heads',
  'saas_route_config_dispatchable',
  'saas_route_config_commercial_authorities',
  'saas_public_model_versions',
  'saas_public_models',
  'saas_customer_metering_policy_heads',
  'saas_customer_metering_policy_versions',
  'saas_provider_metering_policy_heads',
  'saas_provider_metering_policy_versions',
  'saas_contract_test_attestations',
  'saas_provider_products',
  'saas_provider_capabilities',
  'saas_provider_rights',
  'saas_tenant_provider_supply_profile_accounts',
  'saas_tenant_provider_accounts',
  'saas_tenant_provider_credentials',
  'saas_tenant_provider_credential_versions',
  'saas_tenant_provider_account_capabilities',
  'saas_platform_provider_pools',
  'saas_platform_provider_pool_members',
  'saas_platform_provider_pool_grants',
  'saas_platform_provider_accounts',
  'saas_platform_provider_credentials',
  'saas_platform_provider_credential_versions',
  'saas_platform_provider_account_capabilities',
  'saas_service_plan_subscriptions',
  'saas_service_plan_snapshots',
  'saas_customer_price_versions',
  'saas_supplier_cost_versions',
  'saas_request_customer_price_snapshots',
  'saas_attempt_supplier_cost_snapshots',
  'saas_billing_reservations',
  'saas_wallets',
  'saas_refund_wallet_freezes',
  'saas_billing_spending_freezes',
  'saas_ledger_transactions',
  'saas_gateway_request_idempotency_keys',
  'saas_prepared_request_evidence',
  'saas_provider_account_leases',
  'saas_gateway_capacity_reservations',
  'saas_usage_events',
  'saas_usage_settlements',
] as const;

export type SaasGatewayColumnGrant = readonly [
  table: string,
  column: string,
  privilege: 'INSERT' | 'UPDATE' | 'SELECT',
];

/** Column DML used by gateway request preparation, compensation, evidence and settlement. */
export const SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS: readonly SaasGatewayColumnGrant[] = [
  // Startup schema verification reads only the registered migration identity and checksum.
  ['saas_schema_migrations', 'version', 'SELECT'],
  ['saas_schema_migrations', 'name', 'SELECT'],
  ['saas_schema_migrations', 'checksum', 'SELECT'],
  // Legacy metering reads the existing digest while replaying a durable request.
  ['saas_idempotency_records', 'tenant_id', 'SELECT'],
  ['saas_idempotency_records', 'request_id', 'SELECT'],
  ['saas_idempotency_records', 'kind', 'SELECT'],
  ['saas_idempotency_records', 'key_digest', 'SELECT'],
  // Health reads include filter predicates; the UPSERT reads current/EXCLUDED expressions and RETURNING.
  ...(
    [
      'owner_scope_key',
      'owner_kind',
      'owner_tenant_id',
      'account_id',
      'state',
      'failure_count',
      'observed_at',
      'cooldown_until',
      'last_outcome',
      'source_fencing_token',
      'revision',
    ] as const
  ).map((column) => ['saas_provider_account_runtime_health', column, 'SELECT'] as const),
  ...(
    [
      'owner_scope_key',
      'owner_kind',
      'owner_tenant_id',
      'account_id',
      'state',
      'failure_count',
      'observed_at',
      'cooldown_until',
      'last_outcome',
      'source_fencing_token',
      'revision',
    ] as const
  ).map((column) => ['saas_provider_account_runtime_health', column, 'INSERT'] as const),
  ...(
    [
      'state',
      'failure_count',
      'observed_at',
      'cooldown_until',
      'last_outcome',
      'source_fencing_token',
      'revision',
    ] as const
  ).map((column) => ['saas_provider_account_runtime_health', column, 'UPDATE'] as const),
  // Affinity resolution reads only its scoped key and target state; inserts create the full
  // immutable identity, while UPDATE is limited to binding/lifecycle fields.
  ...(
    [
      'tenant_id',
      'project_id',
      'supply_profile_id',
      'supply_mode',
      'account_owner_kind',
      'route_config_id',
      'route_config_version',
      'public_model_id',
      'public_model_version',
      'public_model',
      'protocol',
      'target_mode',
      'upstream_id',
      'provider_id',
      'product_id',
      'reference_kind',
      'hmac_key_version',
      'key_digest',
      'account_id',
      'state',
      'revision',
      'fencing_token',
      'expires_at',
      'created_at',
      'updated_at',
    ] as const
  ).map((column) => ['saas_gateway_provider_account_affinity', column, 'INSERT'] as const),
  ...(
    [
      'tenant_id',
      'project_id',
      'supply_profile_id',
      'supply_mode',
      'account_owner_kind',
      'route_config_id',
      'route_config_version',
      'public_model_id',
      'public_model_version',
      'public_model',
      'protocol',
      'target_mode',
      'upstream_id',
      'provider_id',
      'product_id',
      'reference_kind',
      'hmac_key_version',
      'key_digest',
      'account_id',
      'state',
      'revision',
      'fencing_token',
      'expires_at',
    ] as const
  ).map((column) => ['saas_gateway_provider_account_affinity', column, 'SELECT'] as const),
  ...(['account_id', 'state', 'revision', 'fencing_token', 'expires_at', 'updated_at'] as const).map(
    (column) => ['saas_gateway_provider_account_affinity', column, 'UPDATE'] as const,
  ),
  // Gateway reads only the opaque wrapped DEK and its key/revision binding.
  ...(
    [
      'tenant_id',
      'account_id',
      'credential_id',
      'credential_version',
      'wrapping_revision',
      'kms_key_id',
      'wrapped_dek',
    ] as const
  ).map((column) => ['saas_tenant_provider_credential_wrappings', column, 'SELECT'] as const),
  ...(
    ['account_id', 'credential_id', 'credential_version', 'wrapping_revision', 'kms_key_id', 'wrapped_dek'] as const
  ).map((column) => ['saas_platform_provider_credential_wrappings', column, 'SELECT'] as const),
  // Request and attempt rows are created by admission and advanced by dispatch.
  ...(
    [
      'id',
      'tenant_id',
      'project_id',
      'project_policy_version',
      'proxy_key_id',
      'entitlement_id',
      'supply_profile_id',
      'supply_profile_version',
      'model_scope_version',
      'supply_mode',
      'principal_kind',
      'principal_id',
      'authz_version',
      'entitlement_version',
      'config_version',
      'customer_metering_policy_id',
      'customer_metering_policy_version',
      'provider_metering_policy_id',
      'provider_metering_policy_version',
      'contract_attestation_id',
      'route_config_id',
      'route_config_version',
      'route_public_model_id',
      'route_public_model_version',
      'route_protocol',
      'route_target_mode',
      'route_upstream_id',
      'public_model',
      'protocol',
      'endpoint',
      'request_fingerprint',
      'request_fingerprint_version',
      'customer_price_version',
      'execution_state',
      'financial_status',
      'reconciliation_state',
      'created_at',
      'updated_at',
      'state_version',
    ] as const
  ).map((column) => ['saas_requests', column, 'INSERT'] as const),
  ...(['execution_state', 'reconciliation_state', 'financial_status', 'updated_at', 'state_version'] as const).map(
    (column) => ['saas_requests', column, 'UPDATE'] as const,
  ),
  ...(
    [
      'id',
      'tenant_id',
      'request_id',
      'project_policy_version',
      'customer_price_version',
      'customer_metering_policy_id',
      'customer_metering_policy_version',
      'provider_metering_policy_id',
      'provider_metering_policy_version',
      'contract_attestation_id',
      'route_config_id',
      'route_config_version',
      'route_public_model_id',
      'route_public_model_version',
      'route_protocol',
      'route_target_mode',
      'ordinal',
      'upstream_id',
      'binding_state',
      'dispatch_authority_state',
      'account_owner_kind',
      'tenant_account_id',
      'platform_account_id',
      'provider_id',
      'product_id',
      'resolved_model',
      'protocol',
      'endpoint',
      'supplier_cost_version',
      'dispatch_profile_id',
      'supply_profile_authz_version',
      'credential_id',
      'credential_version',
      'credential_authz_version',
      'account_authz_version',
      'pool_id',
      'pool_authz_version',
      'pool_member_account_authz_version',
      'pool_member_authz_version',
      'pool_grant_authz_version',
      'pool_grant_profile_authz_version',
      'pool_grant_pool_authz_version',
      'profile_account_authz_version',
      'model_resolution_requested_model',
      'model_resolution_mapped_model',
      'model_resolution_mapping_source',
      'model_resolution_mapping_version',
      'provider_protocol',
      'client_operation',
      'provider_operation',
      'request_fingerprint',
      'request_fingerprint_version',
      'payload_compiler_version',
      'usage_estimator_version',
      'payload_sha256',
      'dispatch_state',
      'result_state',
      'response_started',
      'created_at',
      'updated_at',
      'state_version',
    ] as const
  ).map((column) => ['saas_attempts', column, 'INSERT'] as const),
  ...(
    [
      'dispatch_state',
      'result_state',
      'response_started',
      'response_started_at',
      'result_http_status',
      'unknown_reason',
      'updated_at',
      'state_version',
      'prepared_evidence_id',
    ] as const
  ).map((column) => ['saas_attempts', column, 'UPDATE'] as const),
  // Durable idempotency: immutable identity on INSERT; only terminal state fields can change.
  ...(
    [
      'tenant_id',
      'project_id',
      'proxy_key_id',
      'key_digest',
      'request_fingerprint',
      'request_fingerprint_version',
      'request_id',
      'state',
    ] as const
  ).map((column) => ['saas_gateway_request_idempotency_keys', column, 'INSERT'] as const),
  ...(['state', 'updated_at', 'completed_at', 'unknown_at'] as const).map(
    (column) => ['saas_gateway_request_idempotency_keys', column, 'UPDATE'] as const,
  ),
  // Admission emits an outbox row; dispatch does not lease or deliver it.
  ...(
    [
      'id',
      'tenant_id',
      'project_id',
      'request_id',
      'attempt_id',
      'supply_mode',
      'event_key',
      'event_type',
      'schema_version',
      'payload',
      'delivery_state',
      'delivery_attempts',
      'available_at',
      'lease_token',
      'lease_expires_at',
      'last_error_code',
      'delivered_at',
      'created_at',
      'updated_at',
    ] as const
  ).map((column) => ['saas_request_admission_outbox', column, 'INSERT'] as const),
  // Evidence is inserted as the adapter's complete immutable EVIDENCE_COLUMNS record.
  ...(['status', 'claimed_at', 'claimed_attempt_id'] as const).map(
    (column) => ['saas_prepared_request_evidence', column, 'UPDATE'] as const,
  ),
  // Capacity rows are append-only; compensation can only release/retain a reservation.
  ...(
    [
      'tenant_id',
      'project_id',
      'proxy_key_id',
      'request_id',
      'attempt_id',
      'supply_mode',
      'project_policy_version',
      'key_authz_version',
      'idempotency_scope_key',
      'request_fingerprint',
      'request_fingerprint_version',
      'token_units',
      'quota_reservation_id',
      'rate_reservation_id',
    ] as const
  ).map((column) => ['saas_gateway_capacity_reservations', column, 'INSERT'] as const),
  ...(['state', 'updated_at'] as const).map(
    (column) => ['saas_gateway_capacity_reservations', column, 'UPDATE'] as const,
  ),
  // The lease adapter writes only lease identity at creation and lifecycle timestamps thereafter.
  ...(
    [
      'id',
      'tenant_id',
      'owner_kind',
      'owner_tenant_id',
      'account_id',
      'upstream_id',
      'attempt_id',
      'slot',
      'fencing_token',
      'status',
      'lease_expires_at',
    ] as const
  ).map((column) => ['saas_provider_account_leases', column, 'INSERT'] as const),
  ...(['status', 'lease_expires_at', 'released_at', 'updated_at'] as const).map(
    (column) => ['saas_provider_account_leases', column, 'UPDATE'] as const,
  ),
  // Platform holds may be reserved, settled, released, or retained for reconciliation.
  ...(
    [
      'id',
      'tenant_id',
      'wallet_id',
      'currency',
      'request_id',
      'idempotency_namespace',
      'business_key',
      'amount_minor_units',
      'state',
      'price_snapshot_ref',
      'metadata_ref',
      'expires_at',
      'created_at',
      'updated_at',
    ] as const
  ).map((column) => ['saas_billing_reservations', column, 'INSERT'] as const),
  ...(
    [
      'state',
      'settlement_id',
      'settlement_amount_minor_units',
      'usage_evidence_ref',
      'reconciliation_evidence_ref',
      'ledger_transaction_id',
      'release_id',
      'release_evidence_ref',
      'reconciliation_reference',
      'updated_at',
    ] as const
  ).map((column) => ['saas_billing_reservations', column, 'UPDATE'] as const),
  ...(['posted_balance_minor_units', 'updated_at'] as const).map(
    (column) => ['saas_wallets', column, 'UPDATE'] as const,
  ),
  ...(['tenant_id', 'reason_ref', 'frozen_at'] as const).map(
    (column) => ['saas_billing_spending_freezes', column, 'INSERT'] as const,
  ),
  // Ledger postings are insert-only; wallet projection updates remain separate.
  ...(
    [
      'id',
      'tenant_id',
      'currency',
      'idempotency_namespace',
      'business_key',
      'source_type',
      'amount_minor_units',
      'metadata_ref',
      'source_order_ref',
      'price_snapshot_ref',
      'usage_evidence_ref',
      'created_at',
    ] as const
  ).map((column) => ['saas_ledger_transactions', column, 'INSERT'] as const),
  ...(
    [
      'id',
      'transaction_id',
      'tenant_id',
      'currency',
      'direction',
      'amount_minor_units',
      'account_type',
      'account_ref',
      'wallet_id',
      'created_at',
    ] as const
  ).map((column) => ['saas_ledger_entries', column, 'INSERT'] as const),
  // Usage records and settlements are append-only idempotent facts.
  ...(
    [
      'id',
      'tenant_id',
      'request_id',
      'attempt_id',
      'supply_mode',
      'dedupe_key_digest',
      'event_digest',
      'input_total',
      'input_uncached',
      'cache_read',
      'cache_write',
      'cache_write_5m',
      'cache_write_1h',
      'output_total',
      'reasoning_output',
      'status',
      'source',
      'semantics_version',
      'measurement_kind',
      'billable_basis',
      'created_at',
    ] as const
  ).map((column) => ['saas_usage_events', column, 'INSERT'] as const),
  ['saas_usage_events', 'event_digest', 'UPDATE'],
  ...(
    [
      'id',
      'tenant_id',
      'usage_event_id',
      'request_id',
      'attempt_id',
      'settlement_key_digest',
      'settlement_digest',
      'kind',
      'created_at',
    ] as const
  ).map((column) => ['saas_usage_settlements', column, 'INSERT'] as const),
  ['saas_usage_settlements', 'settlement_digest', 'UPDATE'],
  // The gateway audit stream is append-only.
  ...(
    [
      'id',
      'tenant_id',
      'actor_user_id',
      'action',
      'target_type',
      'target_id',
      'occurred_at',
      'source_ip',
      'user_agent',
      'entry_point',
      'request_id',
    ] as const
  ).map((column) => ['saas_audit_events', column, 'INSERT'] as const),
] as const;

const GATEWAY_COLUMN_GRANTS = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS;

const GATEWAY_FULL_INSERT_TABLES = ['saas_prepared_request_evidence'] as const;
const GATEWAY_DELETE_TABLES = ['saas_billing_spending_freezes'] as const;
const GATEWAY_SEQUENCE = 'saas_provider_account_lease_fencing_seq' as const;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const gatewayReadValues = SAAS_GATEWAY_RUNTIME_READ_TABLES.map((table) => `(${sqlText(table)})`).join(',\n    ');
const gatewayColumnValues = GATEWAY_COLUMN_GRANTS.map(
  ([table, column, privilege]) => `(${sqlText(table)}, ${sqlText(column)}, ${sqlText(privilege)})`,
).join(',\n    ');
const gatewayFullInsertValues = GATEWAY_FULL_INSERT_TABLES.map((table) => `(${sqlText(table)})`).join(', ');
const gatewayDeleteValues = GATEWAY_DELETE_TABLES.map((table) => `(${sqlText(table)})`).join(', ');

interface GatewayRuntimePrivilegeProbeRow {
  readonly role_exists: boolean;
  readonly gateway_role: boolean;
  readonly server_version_supported: boolean;
  readonly managed_schema: boolean;
  readonly application_schema_usage: boolean;
  readonly login_role: boolean;
  readonly session_role_unchanged: boolean;
  readonly superuser: boolean;
  readonly create_database: boolean;
  readonly create_role: boolean;
  readonly inherit_role: boolean;
  readonly replication_role: boolean;
  readonly bypass_rls: boolean;
  readonly any_role_membership: boolean;
  readonly owns_database: boolean;
  readonly owns_application_schema: boolean;
  readonly owns_database_objects: boolean;
  readonly schema_create: boolean;
  readonly database_create: boolean;
  readonly database_temp: boolean;
  readonly missing_required_relation_count: number | string;
  readonly missing_column_privilege_count: number | string;
  readonly missing_read_column_count: number | string;
  readonly missing_full_insert_column_count: number | string;
  readonly unexpected_column_privilege_count: number | string;
  readonly unexpected_table_privilege_count: number | string;
  readonly unexpected_delete_privilege_count: number | string;
  readonly missing_spending_freeze_delete: boolean;
  readonly missing_sequence_usage_count: number | string;
  readonly unexpected_sequence_privilege_count: number | string;
  readonly application_function_execute_count: number | string;
  readonly out_of_schema_table_privilege: boolean;
  readonly out_of_schema_sequence_privilege: boolean;
  readonly out_of_schema_function_privilege: boolean;
  readonly unsafe_security_definer_function_count: number | string;
}

const gatewayPrivilegePairs = [
  ['SELECT', 'table_select'],
  ['INSERT', 'table_insert'],
  ['UPDATE', 'table_update'],
  ['DELETE', 'table_delete'],
  ['TRUNCATE', 'table_truncate'],
  ['REFERENCES', 'table_references'],
  ['TRIGGER', 'table_trigger'],
] as const;

const gatewayTablePrivilegeChecks = gatewayPrivilegePairs
  .map(([privilege, alias]) => `pg_catalog.has_table_privilege(current_user, relation.oid, '${privilege}') AS ${alias}`)
  .join(',\n      ');

/**
 * Catalog probe for the dedicated commercial gateway. It requires the named
 * standalone role, all currently present columns on read-only gateway relations,
 * and the exact column DML manifest above. Table-wide DML, unlisted relations,
 * sequences, routines, ownership, memberships, or newly added ungranted columns
 * fail closed.
 */
export const SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL = `
WITH RECURSIVE runtime_role AS (
  SELECT oid, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles WHERE rolname = current_user
),
application_schema AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = pg_catalog.current_schema()
),
role_closure(role_oid) AS (
  SELECT oid FROM runtime_role
  UNION
  SELECT membership.roleid
  FROM pg_catalog.pg_auth_members AS membership
  JOIN role_closure AS parent_role ON parent_role.role_oid = membership.member
),
expected_read_tables(table_name) AS (VALUES
    ${gatewayReadValues}
),
expected_column_privileges(table_name, column_name, privilege_type) AS (VALUES
    ${gatewayColumnValues}
),
expected_full_insert_tables(table_name) AS (VALUES ${gatewayFullInsertValues}),
expected_delete_tables(table_name) AS (VALUES ${gatewayDeleteValues}),
expected_relations(table_name) AS (
  SELECT table_name FROM expected_read_tables
  UNION SELECT table_name FROM expected_column_privileges
  UNION SELECT table_name FROM expected_full_insert_tables
  UNION SELECT table_name FROM expected_delete_tables
),
application_relations AS (
  SELECT relation.oid, relation.relname, relation.relkind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.oid = (SELECT oid FROM application_schema)
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
),
application_columns AS (
  SELECT relation.oid, relation.relname, attribute.attnum, attribute.attname
  FROM application_relations AS relation
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
  WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
),
sequence_access AS (
  SELECT sequence.oid, sequence.relname,
         pg_catalog.has_sequence_privilege(current_user, sequence.oid, 'USAGE') AS can_use,
         pg_catalog.has_sequence_privilege(current_user, sequence.oid, 'SELECT') AS can_select,
         pg_catalog.has_sequence_privilege(current_user, sequence.oid, 'UPDATE') AS can_update
  FROM pg_catalog.pg_class AS sequence
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
  WHERE namespace.oid = (SELECT oid FROM application_schema) AND sequence.relkind = 'S'
),
application_privileges AS (
  SELECT relation.oid, relation.relname,
         ${gatewayTablePrivilegeChecks},
         CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
           THEN pg_catalog.has_table_privilege(current_user, relation.oid, 'MAINTAIN') ELSE false END AS table_maintain
  FROM application_relations AS relation
),
column_privileges AS (
  SELECT column_row.*,
         pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'SELECT') AS can_select,
         pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'INSERT') AS can_insert,
         pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'UPDATE') AS can_update,
         pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'REFERENCES') AS can_reference
  FROM application_columns AS column_row
)
SELECT
  EXISTS (SELECT 1 FROM runtime_role) AS role_exists,
  current_user = 'model_router_saas_gateway' AS gateway_role,
  pg_catalog.current_setting('server_version_num')::integer >= 150000 AS server_version_supported,
  (
    pg_catalog.current_schema() = 'model_router_saas'
    AND pg_catalog.current_setting('search_path') = 'model_router_saas'
    AND pg_catalog.current_schemas(false) = ARRAY['model_router_saas']::pg_catalog.name[]
    AND pg_catalog.current_schemas(true) = ARRAY['pg_catalog', 'model_router_saas']::pg_catalog.name[]
  ) AS managed_schema,
  coalesce(pg_catalog.has_schema_privilege(current_user, (SELECT oid FROM application_schema), 'USAGE'), false)
    AS application_schema_usage,
  coalesce((SELECT rolcanlogin FROM runtime_role), false) AS login_role,
  current_user = session_user AS session_role_unchanged,
  coalesce((SELECT rolsuper FROM runtime_role), true) AS superuser,
  coalesce((SELECT rolcreatedb FROM runtime_role), true) AS create_database,
  coalesce((SELECT rolcreaterole FROM runtime_role), true) AS create_role,
  coalesce((SELECT rolinherit FROM runtime_role), true) AS inherit_role,
  coalesce((SELECT rolreplication FROM runtime_role), true) AS replication_role,
  coalesce((SELECT rolbypassrls FROM runtime_role), true) AS bypass_rls,
  EXISTS (SELECT 1 FROM role_closure WHERE role_oid <> (SELECT oid FROM runtime_role)) AS any_role_membership,
  EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()
          AND datdba = (SELECT oid FROM runtime_role)) AS owns_database,
  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE oid = (SELECT oid FROM application_schema)
          AND nspowner = (SELECT oid FROM runtime_role)) AS owns_application_schema,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
    JOIN pg_catalog.pg_database AS db ON db.datname = pg_catalog.current_database()
    WHERE dependency.dbid = db.oid AND dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = (SELECT oid FROM runtime_role) AND dependency.deptype = 'o'
  ) AS owns_database_objects,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%' AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'CREATE')
  ) AS schema_create,
  coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE'), true)
    AS database_create,
  coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP'), true)
    AS database_temp,
  (SELECT count(*)::integer FROM expected_relations AS expected
   WHERE NOT EXISTS (SELECT 1 FROM application_relations AS relation WHERE relation.relname = expected.table_name))
    AS missing_required_relation_count,
  (SELECT count(*)::integer FROM expected_column_privileges AS expected
   LEFT JOIN application_columns AS column_row
     ON column_row.relname = expected.table_name AND column_row.attname = expected.column_name
   WHERE column_row.oid IS NULL OR CASE expected.privilege_type
     WHEN 'SELECT' THEN NOT pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'SELECT')
     WHEN 'INSERT' THEN NOT pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'INSERT')
     WHEN 'UPDATE' THEN NOT pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'UPDATE')
     ELSE true END) AS missing_column_privilege_count,
  (SELECT count(*)::integer FROM application_columns AS column_row
   JOIN expected_read_tables AS expected ON expected.table_name = column_row.relname
   WHERE NOT pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'SELECT'))
    AS missing_read_column_count,
  (SELECT count(*)::integer FROM application_columns AS column_row
   JOIN expected_full_insert_tables AS expected ON expected.table_name = column_row.relname
   WHERE NOT pg_catalog.has_column_privilege(current_user, column_row.oid, column_row.attnum, 'INSERT'))
    AS missing_full_insert_column_count,
  (SELECT count(*)::integer FROM column_privileges AS actual
   WHERE (actual.can_select AND NOT EXISTS (
            SELECT 1 FROM expected_read_tables AS read_table WHERE read_table.table_name = actual.relname
          ) AND NOT EXISTS (
            SELECT 1 FROM expected_column_privileges AS expected
            WHERE expected.table_name = actual.relname AND expected.column_name = actual.attname
              AND expected.privilege_type = 'SELECT'))
      OR (actual.can_insert AND NOT EXISTS (
            SELECT 1 FROM expected_full_insert_tables AS insert_table WHERE insert_table.table_name = actual.relname
          ) AND NOT EXISTS (
            SELECT 1 FROM expected_column_privileges AS expected
            WHERE expected.table_name = actual.relname AND expected.column_name = actual.attname
              AND expected.privilege_type = 'INSERT'))
      OR (actual.can_update AND NOT EXISTS (
            SELECT 1 FROM expected_column_privileges AS expected
            WHERE expected.table_name = actual.relname AND expected.column_name = actual.attname
              AND expected.privilege_type = 'UPDATE'))
      OR actual.can_reference)
    AS unexpected_column_privilege_count,
  (SELECT count(*)::integer FROM application_privileges AS actual
   WHERE actual.table_select OR actual.table_insert OR actual.table_update OR actual.table_truncate
      OR actual.table_references OR actual.table_trigger OR actual.table_maintain)
    AS unexpected_table_privilege_count,
  (SELECT count(*)::integer FROM application_privileges AS actual
   WHERE actual.table_delete AND NOT EXISTS (
     SELECT 1 FROM expected_delete_tables AS expected WHERE expected.table_name = actual.relname))
    AS unexpected_delete_privilege_count,
  NOT EXISTS (SELECT 1 FROM application_privileges AS actual
              WHERE actual.relname = 'saas_billing_spending_freezes' AND actual.table_delete)
    AS missing_spending_freeze_delete,
  (SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM sequence_access AS sequence
      WHERE sequence.relname = '${GATEWAY_SEQUENCE}' AND sequence.can_use
    ) THEN 1 ELSE 0 END)::integer
    AS missing_sequence_usage_count,
  (SELECT count(*)::integer FROM sequence_access AS sequence
   WHERE (sequence.relname <> '${GATEWAY_SEQUENCE}' AND (sequence.can_use OR sequence.can_select OR sequence.can_update))
      OR (sequence.relname = '${GATEWAY_SEQUENCE}' AND (sequence.can_select OR sequence.can_update)))
    AS unexpected_sequence_privilege_count,
  (SELECT count(*)::integer FROM pg_catalog.pg_proc AS routine
   WHERE routine.pronamespace = (SELECT oid FROM application_schema)
     AND pg_catalog.has_function_privilege(current_user, routine.oid, 'EXECUTE'))
    AS application_function_execute_count,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%' AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        (pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
        OR CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
             THEN pg_catalog.has_table_privilege(current_user, relation.oid, 'MAINTAIN') ELSE false END)
        OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND (pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attnum, 'SELECT')
            OR pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attnum, 'INSERT')
            OR pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attnum, 'UPDATE')
            OR pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attnum, 'REFERENCES'))
        )
      )
  ) AS out_of_schema_table_privilege,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS sequence
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
    WHERE sequence.relkind = 'S' AND namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%' AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND (pg_catalog.has_sequence_privilege(current_user, sequence.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
        OR pg_catalog.has_sequence_privilege(current_user, sequence.oid, 'USAGE'))
  ) AS out_of_schema_sequence_privilege,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%' AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND pg_catalog.has_function_privilege(current_user, routine.oid, 'EXECUTE')
  ) AS out_of_schema_function_privilege,
  (SELECT count(*)::integer FROM pg_catalog.pg_proc AS routine
   WHERE routine.pronamespace = (SELECT oid FROM application_schema)
     AND routine.prosecdef
     AND pg_catalog.has_function_privilege(current_user, routine.oid, 'EXECUTE'))
    AS unsafe_security_definer_function_count
` as const;

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function countValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function isProbeRow(value: unknown): value is RuntimePrivilegeProbeRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const booleans = [
    'role_exists',
    'server_version_supported',
    'managed_schema',
    'login_role',
    'session_role_unchanged',
    'superuser',
    'create_database',
    'create_role',
    'replication_role',
    'bypass_rls',
    'any_role_membership',
    'owns_database',
    'owns_application_schema',
    'owns_database_objects',
    'schema_create',
    'database_create',
    'database_temp',
    'truncate_privilege',
    'extra_table_privilege',
    'unsafe_delete_privilege',
    'out_of_schema_table_privilege',
    'out_of_schema_sequence_privilege',
    'out_of_schema_function_privilege',
  ] as const;
  const counts = [
    'application_table_count',
    'missing_table_privilege_count',
    'missing_select_count',
    'missing_insert_count',
    'missing_update_count',
    'missing_sequence_privilege_count',
    'unexpected_sequence_privilege_count',
    'missing_function_execute_count',
    'unsafe_security_definer_function_count',
  ] as const;
  return booleans.every((key) => isBoolean(row[key])) && counts.every((key) => countValue(row[key]) !== undefined);
}

function isGatewayProbeRow(value: unknown): value is GatewayRuntimePrivilegeProbeRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const booleans = [
    'role_exists',
    'gateway_role',
    'server_version_supported',
    'managed_schema',
    'application_schema_usage',
    'login_role',
    'session_role_unchanged',
    'superuser',
    'create_database',
    'create_role',
    'inherit_role',
    'replication_role',
    'bypass_rls',
    'any_role_membership',
    'owns_database',
    'owns_application_schema',
    'owns_database_objects',
    'schema_create',
    'database_create',
    'database_temp',
    'missing_spending_freeze_delete',
    'out_of_schema_table_privilege',
    'out_of_schema_sequence_privilege',
    'out_of_schema_function_privilege',
  ] as const;
  const counts = [
    'missing_required_relation_count',
    'missing_column_privilege_count',
    'missing_read_column_count',
    'missing_full_insert_column_count',
    'unexpected_column_privilege_count',
    'unexpected_table_privilege_count',
    'unexpected_delete_privilege_count',
    'missing_sequence_usage_count',
    'unexpected_sequence_privilege_count',
    'application_function_execute_count',
    'unsafe_security_definer_function_count',
  ] as const;
  return booleans.every((key) => isBoolean(row[key])) && counts.every((key) => countValue(row[key]) !== undefined);
}

async function verifyGatewayRuntimeDatabasePrivileges(database: Pick<SqlExecutor, 'query'>): Promise<void> {
  let row: GatewayRuntimePrivilegeProbeRow | undefined;
  try {
    const result = await database.query<GatewayRuntimePrivilegeProbeRow>(SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL);
    if (result.rows.length !== 1 || !isGatewayProbeRow(result.rows[0])) throw new SaasRuntimePrivilegeError();
    row = result.rows[0];
  } catch (error) {
    if (error instanceof SaasRuntimePrivilegeError) throw error;
    throw new SaasRuntimePrivilegeError();
  }

  if (
    !row.role_exists ||
    !row.gateway_role ||
    !row.server_version_supported ||
    !row.managed_schema ||
    !row.application_schema_usage ||
    !row.login_role ||
    !row.session_role_unchanged ||
    row.superuser ||
    row.create_database ||
    row.create_role ||
    row.inherit_role ||
    row.replication_role ||
    row.bypass_rls ||
    row.any_role_membership ||
    row.owns_database ||
    row.owns_application_schema ||
    row.owns_database_objects ||
    row.schema_create ||
    row.database_create ||
    row.database_temp ||
    row.out_of_schema_table_privilege ||
    row.out_of_schema_sequence_privilege ||
    row.out_of_schema_function_privilege ||
    countValue(row.missing_required_relation_count) !== 0 ||
    countValue(row.missing_column_privilege_count) !== 0 ||
    countValue(row.missing_read_column_count) !== 0 ||
    countValue(row.missing_full_insert_column_count) !== 0 ||
    countValue(row.unexpected_column_privilege_count) !== 0 ||
    countValue(row.unexpected_table_privilege_count) !== 0 ||
    countValue(row.unexpected_delete_privilege_count) !== 0 ||
    row.missing_spending_freeze_delete ||
    countValue(row.missing_sequence_usage_count) !== 0 ||
    countValue(row.unexpected_sequence_privilege_count) !== 0 ||
    countValue(row.application_function_execute_count) !== 0 ||
    countValue(row.unsafe_security_definer_function_count) !== 0
  ) {
    throw new SaasRuntimePrivilegeError();
  }
}

async function verifyControlPlaneRuntimeDatabasePrivileges(database: Pick<SqlExecutor, 'query'>): Promise<void> {
  let row: RuntimePrivilegeProbeRow | undefined;
  try {
    const result = await database.query<RuntimePrivilegeProbeRow>(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL);
    if (result.rows.length !== 1 || !isProbeRow(result.rows[0])) throw new SaasRuntimePrivilegeError();
    row = result.rows[0];
  } catch (error) {
    if (error instanceof SaasRuntimePrivilegeError) throw error;
    throw new SaasRuntimePrivilegeError();
  }

  if (
    !row.role_exists ||
    !row.server_version_supported ||
    !row.managed_schema ||
    !row.login_role ||
    !row.session_role_unchanged ||
    row.superuser ||
    row.create_database ||
    row.create_role ||
    row.replication_role ||
    row.bypass_rls ||
    row.any_role_membership ||
    row.owns_database ||
    row.owns_application_schema ||
    row.owns_database_objects ||
    row.schema_create ||
    row.database_create ||
    row.database_temp ||
    row.truncate_privilege ||
    row.extra_table_privilege ||
    row.out_of_schema_table_privilege ||
    row.out_of_schema_sequence_privilege ||
    row.out_of_schema_function_privilege ||
    countValue(row.application_table_count) === 0 ||
    countValue(row.missing_select_count) !== 0 ||
    countValue(row.missing_insert_count) !== 0 ||
    countValue(row.missing_update_count) !== 0 ||
    countValue(row.missing_table_privilege_count) !== 0 ||
    row.unsafe_delete_privilege ||
    countValue(row.missing_sequence_privilege_count) !== 0 ||
    countValue(row.unexpected_sequence_privilege_count) !== 0 ||
    countValue(row.missing_function_execute_count) !== 0 ||
    countValue(row.unsafe_security_definer_function_count) !== 0
  ) {
    throw new SaasRuntimePrivilegeError();
  }
}

/**
 * Verifies the effective runtime principal. Omitting `role` preserves the
 * existing control-plane policy; the dedicated gateway is checked against its
 * independent, column-scoped privilege contract.
 */
export async function verifySaasRuntimeDatabasePrivileges(
  database: Pick<SqlExecutor, 'query'>,
  role: SaasRuntimeWorkloadRole = 'control_plane',
): Promise<void> {
  if (role === 'gateway') return verifyGatewayRuntimeDatabasePrivileges(database);
  if (role === 'control_plane') return verifyControlPlaneRuntimeDatabasePrivileges(database);
  throw new SaasRuntimePrivilegeError();
}
