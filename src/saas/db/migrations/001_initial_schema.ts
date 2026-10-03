import { PROJECT_AUTHORIZATION_SAAS_MIGRATION } from './002_project_authorization.js';
import { PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION } from './003_project_membership_backfill.js';
import { API_KEYS_SAAS_MIGRATION } from './004_api_keys.js';
import { SUPPLY_PROFILES_AND_ENTITLEMENTS_SAAS_MIGRATION } from './005_supply_profiles_and_entitlements.js';
import { API_KEY_ENTITLEMENT_BINDING_SAAS_MIGRATION } from './006_api_key_entitlement_binding.js';
import { PLATFORM_ADMIN_AUTH_SAAS_MIGRATION } from './007_platform_admin_auth.js';
import { PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION } from './008_provider_catalog_and_rights.js';
import { PROJECT_ENTITLEMENT_VALIDITY_SAAS_MIGRATION } from './009_project_entitlement_validity.js';
import { GATEWAY_METERING_SAAS_MIGRATION } from './010_gateway_metering.js';
import { PLATFORM_WALLET_LEDGER_SAAS_MIGRATION } from './011_platform_wallet_ledger.js';
import { API_KEY_EXECUTION_PRINCIPALS_SAAS_MIGRATION } from './012_api_key_execution_principals.js';
import { PROJECT_ENTITLEMENT_SUPERSESSION_SAAS_MIGRATION } from './013_project_entitlement_supersession.js';
import { REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION } from './014_request_admission_outbox.js';
import { PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION } from './015_provider_supply_accounts.js';
import { PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION } from './016_provider_supply_credentials.js';
import { COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION } from './017_commercial_price_versions.js';
import { ATTEMPT_PROVIDER_ACCOUNT_BINDING_SAAS_MIGRATION } from './018_attempt_provider_account_binding.js';
import { ATTEMPT_DISPATCH_AUTHORITY_SAAS_MIGRATION } from './019_attempt_dispatch_authority.js';
import { SUPPLY_RELATIONSHIP_EPOCHS_SAAS_MIGRATION } from './020_supply_relationship_epochs.js';
import { PROJECT_INFERENCE_POLICY_SAAS_MIGRATION } from './021_project_inference_policy.js';
import { ROUTE_CONFIG_AUTHORITY_SAAS_MIGRATION } from './022_route_config_authority.js';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from './023_commercial_metering_policy_authority.js';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from './024_prepared_request_evidence.js';
import { PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION } from './025_provider_account_leases.js';
import { PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION } from './026_prepared_request_evidence_platform_pool_fence.js';
import { PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION } from './027_prepared_request_evidence_claim_pool_fence.js';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from './028_prepared_request_evidence_pool_claim_hardening.js';
import { MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION } from './029_model_resolution_provenance.js';
import { PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION } from './030_payment_orders_wallet_topup.js';
import { BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION } from './031_byok_service_plan_subscription_fulfillment.js';
import { PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION } from './032_payment_checkout_and_submission_fencing.js';
import { PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION } from './033_payment_webhook_durable_inbox.js';
import { PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION } from './034_provider_catalog_product_write_fence.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from './035_credential_validation_jobs.js';
import { GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION } from './036_gateway_idempotency_keys.js';
import { PAYMENT_REFUNDS_SAAS_MIGRATION } from './037_payment_refunds.js';
import { GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION } from './038_gateway_request_capacity.js';
import { PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION } from './039_provider_credential_wrapper_history.js';
import { GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION } from './040_gateway_provider_account_runtime_health.js';
import { GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION } from './041_gateway_provider_account_affinity.js';
import { CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION } from './042_capacity_policy_audit_details.js';
import { CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION } from './043_customer_webhook_delivery.js';
import { PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION } from './044_project_service_key_authorization.js';
import { BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION } from './045_byok_refund_entitlement_effect.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from './046_platform_authorization_fences.js';
import { IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION } from './047_identity_key_authorization_fences.js';
import { RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION } from './048_runtime_role_lock_fences.js';
import { UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION } from './049_unknown_outcome_reconciliation.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from './050_prepared_evidence_authorization_advisory_fences.js';
import { UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION } from './051_unknown_outcome_support_ticket.js';
import { COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION } from './052_commercial_authority_guard_rowtype_safety.js';
import { COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION } from './053_commercial_authority_read_fences.js';
import { TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION } from './054_trigger_only_trusted_execution.js';
import { PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION } from './055_prepared_evidence_optional_validity_scalars.js';
import { RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION } from './056_restricted_role_check_and_platform_auth_execution.js';
import { NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION } from './057_normal_success_usage_evidence_reference.js';
import { CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION } from './058_credential_validation_invalidation_trigger_execution.js';
import { PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION } from './059_pre_dispatch_terminal_cancellation.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from './060_prepared_evidence_claim_generated_account.js';

export interface SaasMigration {
  version: number;
  name: string;
  sql: string;
}

const initialSchemaSql = `
CREATE TABLE saas_users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  email_canonical text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  password_hash text,
  display_name text,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_users_email_nonempty CHECK (email <> ''),
  CONSTRAINT saas_users_email_canonical_unique UNIQUE (email_canonical)
);

CREATE TABLE saas_platform_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initialized boolean NOT NULL DEFAULT false,
  initialized_at timestamptz,
  CONSTRAINT saas_platform_state_initialization_timestamp CHECK (
    (initialized AND initialized_at IS NOT NULL)
    OR (NOT initialized AND initialized_at IS NULL)
  )
);
INSERT INTO saas_platform_state (singleton, initialized, initialized_at)
VALUES (TRUE, FALSE, NULL);

CREATE TABLE saas_tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  slug_canonical text GENERATED ALWAYS AS (lower(btrim(slug))) STORED,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_tenants_slug_nonempty CHECK (slug <> ''),
  CONSTRAINT saas_tenants_slug_canonical_unique UNIQUE (slug_canonical)
);

CREATE TABLE saas_memberships (
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  role text NOT NULL
    CHECK (role IN ('owner', 'admin', 'developer', 'billing', 'viewer')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_memberships_revocation_status CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  ),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE saas_projects (
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  slug_canonical text GENERATED ALWAYS AS (lower(btrim(slug))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT saas_projects_tenant_slug_unique UNIQUE (tenant_id, slug_canonical),
  CONSTRAINT saas_projects_slug_nonempty CHECK (slug <> '')
);

CREATE TABLE saas_platform_role_assignments (
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  role text NOT NULL
    CHECK (role IN ('superadmin', 'security', 'finance', 'operations', 'support-readonly')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE saas_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash text NOT NULL
    CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  source_ip inet,
  user_agent text,
  CONSTRAINT saas_sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX saas_sessions_user_expiry_idx ON saas_sessions (user_id, expires_at);

CREATE TABLE saas_invitations (
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  invited_email text NOT NULL,
  invited_email_canonical text GENERATED ALWAYS AS (lower(btrim(invited_email))) STORED,
  role text NOT NULL
    CHECK (role IN ('owner', 'admin', 'developer', 'billing', 'viewer')),
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid NOT NULL,
  accepted_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT saas_invitations_email_nonempty CHECK (invited_email <> ''),
  CONSTRAINT saas_invitations_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT saas_invitations_created_by_member
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES saas_memberships (tenant_id, user_id),
  CONSTRAINT saas_invitations_accepted_by_member
    FOREIGN KEY (tenant_id, accepted_by_user_id)
    REFERENCES saas_memberships (tenant_id, user_id)
);
CREATE INDEX saas_invitations_tenant_email_idx
  ON saas_invitations (tenant_id, invited_email_canonical);

CREATE TABLE saas_email_action_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT saas_email_action_tokens_expiry_after_creation
    CHECK (expires_at > created_at)
);
CREATE INDEX saas_email_action_tokens_user_purpose_idx
  ON saas_email_action_tokens (user_id, purpose, expires_at);

CREATE TABLE saas_mfa_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('totp', 'passkey')),
  credential_id text,
  public_key bytea,
  encrypted_secret bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT saas_mfa_credentials_kind_data CHECK (
    (kind = 'totp' AND encrypted_secret IS NOT NULL
      AND credential_id IS NULL AND public_key IS NULL)
    OR
    (kind = 'passkey' AND encrypted_secret IS NULL
      AND credential_id IS NOT NULL AND public_key IS NOT NULL)
  )
);
CREATE UNIQUE INDEX saas_mfa_credentials_passkey_id_unique
  ON saas_mfa_credentials (credential_id) WHERE kind = 'passkey';
CREATE INDEX saas_mfa_credentials_user_idx
  ON saas_mfa_credentials (user_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE saas_bootstrap_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  creator_ip inet,
  creator_user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_bootstrap_tokens_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX saas_bootstrap_tokens_expiry_idx
  ON saas_bootstrap_tokens (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE saas_policy_documents (
  policy_key text NOT NULL,
  version text NOT NULL,
  locale text NOT NULL,
  content text NOT NULL,
  content_sha256 text NOT NULL
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (policy_key, version, locale)
);

CREATE TABLE saas_policy_acceptances (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  tenant_id uuid REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  policy_key text NOT NULL,
  policy_version text NOT NULL,
  locale text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  source_ip inet,
  user_agent text,
  entry_point text NOT NULL,
  CONSTRAINT saas_policy_acceptances_document_fk
    FOREIGN KEY (policy_key, policy_version, locale)
    REFERENCES saas_policy_documents (policy_key, version, locale),
  CONSTRAINT saas_policy_acceptances_tenant_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES saas_memberships (tenant_id, user_id)
);

CREATE TABLE saas_audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source_ip inet,
  user_agent text,
  entry_point text NOT NULL,
  request_id text
);
CREATE INDEX saas_audit_events_tenant_time_idx
  ON saas_audit_events (tenant_id, occurred_at DESC);
CREATE INDEX saas_audit_events_actor_time_idx
  ON saas_audit_events (actor_user_id, occurred_at DESC);

CREATE FUNCTION saas_reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS records are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION saas_guard_platform_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SaaS platform state is permanent' USING ERRCODE = '55000';
  END IF;
  IF OLD.initialized THEN
    RAISE EXCEPTION 'SaaS platform state can only be initialized once'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.initialized IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'SaaS platform state can only transition to initialized'
      USING ERRCODE = '55000';
  END IF;
  NEW.initialized_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_reject_user_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS users must be anonymized instead of deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION saas_reject_membership_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS memberships must be revoked instead of deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_platform_state_one_way
  BEFORE UPDATE OR DELETE ON saas_platform_state
  FOR EACH ROW EXECUTE FUNCTION saas_guard_platform_state();
CREATE TRIGGER saas_platform_state_no_truncate
  BEFORE TRUNCATE ON saas_platform_state
  FOR EACH STATEMENT EXECUTE FUNCTION saas_guard_platform_state();
CREATE TRIGGER saas_users_no_delete
  BEFORE DELETE ON saas_users
  FOR EACH ROW EXECUTE FUNCTION saas_reject_user_delete();
CREATE TRIGGER saas_memberships_no_delete
  BEFORE DELETE ON saas_memberships
  FOR EACH ROW EXECUTE FUNCTION saas_reject_membership_delete();

CREATE TRIGGER saas_policy_documents_immutable
  BEFORE UPDATE OR DELETE ON saas_policy_documents
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_policy_acceptances_immutable
  BEFORE UPDATE OR DELETE ON saas_policy_acceptances
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_audit_events_immutable
  BEFORE UPDATE OR DELETE ON saas_audit_events
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
`;

export const INITIAL_SAAS_MIGRATION: SaasMigration = {
  version: 1,
  name: 'initial_saas_identity_and_tenant_schema',
  sql: initialSchemaSql,
};

export const SAAS_MIGRATIONS: readonly SaasMigration[] = [
  INITIAL_SAAS_MIGRATION,
  PROJECT_AUTHORIZATION_SAAS_MIGRATION,
  PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION,
  API_KEYS_SAAS_MIGRATION,
  SUPPLY_PROFILES_AND_ENTITLEMENTS_SAAS_MIGRATION,
  API_KEY_ENTITLEMENT_BINDING_SAAS_MIGRATION,
  PLATFORM_ADMIN_AUTH_SAAS_MIGRATION,
  PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION,
  PROJECT_ENTITLEMENT_VALIDITY_SAAS_MIGRATION,
  GATEWAY_METERING_SAAS_MIGRATION,
  PLATFORM_WALLET_LEDGER_SAAS_MIGRATION,
  API_KEY_EXECUTION_PRINCIPALS_SAAS_MIGRATION,
  PROJECT_ENTITLEMENT_SUPERSESSION_SAAS_MIGRATION,
  REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION,
  PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION,
  PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION,
  COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION,
  ATTEMPT_PROVIDER_ACCOUNT_BINDING_SAAS_MIGRATION,
  ATTEMPT_DISPATCH_AUTHORITY_SAAS_MIGRATION,
  SUPPLY_RELATIONSHIP_EPOCHS_SAAS_MIGRATION,
  PROJECT_INFERENCE_POLICY_SAAS_MIGRATION,
  ROUTE_CONFIG_AUTHORITY_SAAS_MIGRATION,
  COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION,
  PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION,
  PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION,
  PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION,
  PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION,
  PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION,
  MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION,
  PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION,
  BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION,
  PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION,
  PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION,
  PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION,
  CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION,
  GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION,
  PAYMENT_REFUNDS_SAAS_MIGRATION,
  GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION,
  PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION,
  GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION,
  GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION,
  CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION,
  CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION,
  PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION,
  BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION,
  PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
  IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION,
  RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION,
  UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION,
  PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION,
  UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION,
  COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION,
  COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION,
  TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION,
  PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION,
  RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION,
  NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION,
  CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
  PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION,
  PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION,
];
