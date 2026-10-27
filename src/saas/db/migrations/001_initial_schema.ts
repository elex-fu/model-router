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
import { USAGE_CORRECTIONS_SAAS_MIGRATION } from './063_usage_corrections.js';
import { API_KEY_IP_POLICIES_SAAS_MIGRATION } from './080_api_key_ip_policies.js';
import { API_KEY_BUDGETS_SAAS_MIGRATION } from './081_api_key_budgets.js';
import { PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION } from './082_provider_account_scheduling.js';
import { PLATFORM_CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from './083_platform_credential_validation_jobs.js';
import { PROVIDER_ACCOUNT_REVALIDATION_SAAS_MIGRATION } from './084_provider_account_revalidation.js';
import { CUSTOMER_PASSKEY_CEREMONIES_SAAS_MIGRATION } from './085_customer_passkey_ceremonies.js';
import { CUSTOMER_WEBHOOK_TENANT_POLICY_ENTITLEMENT_SAAS_MIGRATION } from './087_customer_webhook_tenant_policy_entitlement.js';
import { CUSTOMER_WEBHOOK_EVENT_TYPES_CHECK_REWRITE_SAAS_MIGRATION } from './088_customer_webhook_event_types_check_rewrite.js';
import { MARKETING_REDEEM_CODES_SAAS_MIGRATION } from './089_marketing_redeem_codes.js';
import { MARKETING_PROMO_CODES_SAAS_MIGRATION } from './090_marketing_promo_codes.js';
import { MARKETING_AFFILIATE_SAAS_MIGRATION } from './091_marketing_affiliate.js';
import { MARKETING_ANNOUNCEMENTS_SAAS_MIGRATION } from './092_marketing_announcements.js';
import { PROVIDER_ACCOUNT_QUOTA_SNAPSHOTS_SAAS_MIGRATION } from './093_provider_account_quota_snapshots.js';
import { PROVIDER_CREDENTIAL_OAUTH_REFRESH_SAAS_MIGRATION } from './094_provider_credential_oauth_refresh_state.js';
import { MARKETING_ANNOUNCEMENT_FANOUT_SAAS_MIGRATION } from './095_marketing_announcement_fanout_cursor.js';
import { CUSTOMER_WEBHOOK_MAINTENANCE_PAYLOAD_REWRITE_SAAS_MIGRATION } from './096_customer_webhook_maintenance_payload_rewrite.js';
import { PROVIDER_ACCOUNT_QUARANTINE_SAAS_MIGRATION } from './097_provider_account_quarantine_state.js';
import { PROVIDER_ACCOUNT_RATE_AND_HEALTH_SAAS_MIGRATION } from './098_provider_account_rate_counters_and_health_score.js';
import { PROVIDER_ACCOUNT_CODEX_SCHEDULING_SAAS_MIGRATION } from './099_provider_account_codex_scheduling.js';
import { PROVIDER_ACCOUNT_CLAUDE_SCHEDULING_SAAS_MIGRATION } from './100_provider_account_claude_scheduling.js';
import { IDENTITY_OAUTH_IDENTITIES_SAAS_MIGRATION } from './101_identity_oauth_identities.js';
import { OBS_CHANNEL_METRICS_SAAS_MIGRATION } from './102_obs_channel_metrics.js';
import { OBS_ALERTS_SAAS_MIGRATION } from './103_obs_alerts.js';
import { OPENAI_EMBEDDINGS_OPERATION_SAAS_MIGRATION } from './104_openai_embeddings_operation.js';
import { BILLING_GROUPS_SAAS_MIGRATION } from './105_billing_groups.js';
import { REGISTRATION_ADMISSION_SAAS_MIGRATION } from './106_registration_admission.js';
import { EGRESS_PROXIES_SAAS_MIGRATION } from './107_egress_proxies.js';
import { PROVIDER_ACCOUNT_OPENCODE_GO_SCHEDULING_SAAS_MIGRATION } from './108_provider_account_opencode_go_scheduling.js';
import { PROBE_MONITORS_SAAS_MIGRATION } from './109_probe_monitors.js';
import { PLATFORM_SETTINGS_SAAS_MIGRATION } from './110_platform_settings.js';
import { PROVIDER_ACCOUNT_GEMINI_SCHEDULING_SAAS_MIGRATION } from './111_provider_account_gemini_scheduling.js';
import { BILLING_GROUP_SNAPSHOT_LIMITS_SAAS_MIGRATION } from './112_billing_group_snapshot_limits.js';
import { BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION } from './113_billing_group_rate_counters.js';
import { BILLING_GROUP_SPEND_WINDOWS_SAAS_MIGRATION } from './114_billing_group_spend_windows.js';
import { PROVIDER_ACCOUNT_SCHEDULING_THRESHOLD_PAUSE_SAAS_MIGRATION } from './115_provider_account_scheduling_threshold_pause.js';
import { TLS_FINGERPRINT_PROFILES_SAAS_MIGRATION } from './116_tls_fingerprint_profiles.js';
import { PROVIDER_ACCOUNT_BEDROCK_SCHEDULING_SAAS_MIGRATION } from './117_provider_account_bedrock_scheduling.js';
import { PROVIDER_ACCOUNT_VERTEX_SCHEDULING_SAAS_MIGRATION } from './118_provider_account_vertex_scheduling.js';
import { PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION } from './119_provider_account_grok_scheduling.js';
import { CN_PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION } from './120_cn_provider_account_scheduling.js';
import { COMPOSITE_MODEL_ROUTES_SAAS_MIGRATION } from './121_composite_model_routes.js';
import { MULTIMODAL_BILLING_SAAS_MIGRATION } from './122_multimodal_billing_dimensions.js';
import { IMAGE_TASKS_SAAS_MIGRATION } from './123_image_tasks.js';
import { VIDEO_TASKS_SAAS_MIGRATION } from './124_video_tasks.js';
import { RISK_CONTROL_CONTENT_MODERATION_SAAS_MIGRATION } from './125_risk_control_content_moderation.js';
import { PUBLIC_BRAND_SETTINGS_SAAS_MIGRATION } from './126_public_brand_settings.js';
import { OBS_ALERT_SILENCES_SAAS_MIGRATION } from './127_obs_alert_silences_reports.js';
import { PLUGIN_SYSTEM_SAAS_MIGRATION } from './128_plugin_system.js';
import { PROVIDER_ACCOUNT_DURABLE_FAULT_CLASSIFICATION_SAAS_MIGRATION } from './129_provider_account_durable_fault_classification.js';
import { PROVIDER_ACCOUNT_WINDOW_COST_POLICY_SAAS_MIGRATION } from './130_provider_account_window_cost_policy.js';
import { RESOLVED_SUPPLY_BILLING_IDENTITY_SAAS_MIGRATION } from './131_resolved_supply_billing_identity.js';
import { MEDIA_TASK_RECOVERY_SAAS_MIGRATION } from './132_media_task_recovery.js';
import { PROVIDER_ACCOUNT_MODEL_COOLDOWNS_SAAS_MIGRATION } from './133_provider_account_model_cooldowns.js';
import { RESPONSES_COMPACT_OPERATION_SAAS_MIGRATION } from './134_responses_compact_operation.js';
import { KIMI_CODING_QUOTA_SNAPSHOTS_SAAS_MIGRATION } from './135_kimi_coding_quota_snapshots.js';
import { OPS_MEDIA_REQUEUE_REQUESTS_SAAS_MIGRATION } from './136_ops_media_requeue_requests.js';
import { PLATFORM_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION } from './137_platform_credential_validation_requeue.js';
import { REDIS_QUOTA_WRITEBACK_SAAS_MIGRATION } from './138_redis_quota_writeback.js';
import { PLATFORM_INFERENCE_ACCESS_OPERATIONS_SAAS_MIGRATION } from './139_platform_inference_access_operations.js';
import { PAYMENT_MERCHANT_BINDINGS_SAAS_MIGRATION } from './140_payment_merchant_bindings.js';
import { RESPONSES_CONTINUATION_CONTEXTS_SAAS_MIGRATION } from './141_responses_continuation_contexts.js';
import { PAYMENT_CREATE_REQUEST_FINGERPRINT_SAAS_MIGRATION } from './142_payment_create_request_fingerprint.js';
import { FAST_GATEWAY_JOURNAL_SAAS_MIGRATION } from './143_fast_gateway_journal.js';
import { FAST_GATEWAY_RESOLUTION_SAAS_MIGRATION } from './144_fast_gateway_resolution.js';
import { FAST_GATEWAY_CREDIT_STRIPES_SAAS_MIGRATION } from './145_fast_gateway_credit_stripes.js';
import { FAST_RECEIPT_LIABILITY_RELEASES_SAAS_MIGRATION } from './146_fast_receipt_liability_releases.js';
import { BOUNDED_FAST_GATEWAY_BUDGET_SAAS_MIGRATION } from './147_bounded_fast_gateway_budget.js';

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
  // 061 audited_credential_validation_requeue: isolated stage-1 candidate,
  // register only at integration GO. 062: reserved for the FIN request
  // execution fence/recovery design (PROPOSED).
  USAGE_CORRECTIONS_SAAS_MIGRATION,
  // 064-079: retired unregistered (serial integration landed 080/081 first;
  // lower numbers can never be applied on top, per the fail-closed ordering
  // rule). Tracks D/E/F/G consume 082+ per the contracts-m0-freeze ledger.
  API_KEY_IP_POLICIES_SAAS_MIGRATION,
  API_KEY_BUDGETS_SAAS_MIGRATION,
  PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION,
  PLATFORM_CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION,
  PROVIDER_ACCOUNT_REVALIDATION_SAAS_MIGRATION,
  CUSTOMER_PASSKEY_CEREMONIES_SAAS_MIGRATION,
  // 086: reserved for Track E and intentionally unused (E4 required no schema
  // change). Track F consumes 087 per the same ledger.
  CUSTOMER_WEBHOOK_TENANT_POLICY_ENTITLEMENT_SAAS_MIGRATION,
  // 088: Track F evidence repair — the 043 event-types CHECK becomes
  // equivalent pg_catalog-only SQL so restricted-role writes do not require
  // EXECUTE on the non-callable schema helper (migration 056's pattern).
  CUSTOMER_WEBHOOK_EVENT_TYPES_CHECK_REWRITE_SAAS_MIGRATION,
  // 089: Track G1 redeem codes (docs/marketing-domain-design-2026-10-11.md);
  // 090/091 remain reserved for G2 promo codes / G3 affiliate rewards per the
  // same ledger.
  MARKETING_REDEEM_CODES_SAAS_MIGRATION,
  // 090: R1/G2 promo codes — checkout pricing snapshot discounts only, never
  // repriced after the fact; orders keep the insert-only original amount so
  // client-request replay compares the customer's original input.
  MARKETING_PROMO_CODES_SAAS_MIGRATION,
  // 091: R2/G3 affiliate rebates — lifetime-immutable attribution, singleton
  // versioned policy head, append-only rewards with basis-point snapshots.
  MARKETING_AFFILIATE_SAAS_MIGRATION,
  // 092: Track G4 announcements — platform broadcast drafts with a one-way
  // publish/withdraw state machine, version CAS and append-only read receipts.
  MARKETING_ANNOUNCEMENTS_SAAS_MIGRATION,
  // 093: Track D4 provider account quota snapshots (scheduling signal only,
  // never billing). Arbitration: 090/091 stay reserved for G2 promo codes /
  // G3 affiliate rewards; the marketing-reserved segment's 093 slot was
  // reassigned to Track D4 and the marketing evolution segment defers to
  // 094-098 per the contracts-m0-freeze ledger.
  PROVIDER_ACCOUNT_QUOTA_SNAPSHOTS_SAAS_MIGRATION,
  // 094: R4 OAuth token refresh scheduling/observability state. Refresh
  // secrets stay inside the credential envelopes; the gateway never writes
  // credential relations (pin invariant) — the validation worker sets the
  // force-refresh flag on 401-class failures and the refresh worker
  // consumes and clears it.
  PROVIDER_CREDENTIAL_OAUTH_REFRESH_SAAS_MIGRATION,
  // 095: R8/G4.5 announcement webhook fan-out cursor — the announcement row
  // is the cursor; the timestamp lands only after every entitled tenant has
  // the event durably enqueued. Re-arbitration 2026-10-11: the plan's
  // reservation order (095 quarantine / 096 group / 097 counters / 098
  // fan-out) would have stranded lower numbers behind the head, so the
  // fan-out takes 095; R5 quarantine / R9 group / R6 counters take 096+ in
  // landing order per docs/remaining-capability-plan-2026-10-11.md.
  MARKETING_ANNOUNCEMENT_FANOUT_SAAS_MIGRATION,
  // 096: R8 evidence repair — the 043 platform.maintenance payload contract
  // pinned a placeholder shape that never had a producer; the announcement
  // fan-out emits the real payload. Guarded one-CHECK swap (088's pattern):
  // fails closed if any platform.maintenance event rows exist.
  CUSTOMER_WEBHOOK_MAINTENANCE_PAYLOAD_REWRITE_SAAS_MIGRATION,
  // 097: R5 credential quarantine — observation state between failed and
  // verified (scheduling-excluded but probed on a longer cadence); entry only
  // from failed, exit only towards verified, entry facts immutable.
  PROVIDER_ACCOUNT_QUARANTINE_SAAS_MIGRATION,
  // 098: R6/D5 PG-authoritative per-account rate counters (admission upsert,
  // scheduling reads the trailing window) + R7/D6 continuous health score and
  // half-open probe state. NULL keeps pre-R6/R7 behavior for existing rows.
  PROVIDER_ACCOUNT_RATE_AND_HEALTH_SAAS_MIGRATION,
  // 099: P1b Codex subscription scheduling signals — the 5h/7d usage
  // snapshots parsed from x-codex rate-limit headers, the per-account
  // auto-pause thresholds and the opt-in identity fingerprint mode/seed
  // (default off; the seed is an identity-derivation input, never credential
  // material). Scheduling signal only, never billing; plan metadata stays
  // inside the sealed credential envelope, so no migration 100 is needed.
  PROVIDER_ACCOUNT_CODEX_SCHEDULING_SAAS_MIGRATION,
  // 100: R5 Claude subscription scheduling signals — the 5h/7d/7d_sonnet/
  // 7d_oi usage-window snapshots parsed from anthropic-ratelimit-unified
  // headers and /api/oauth/usage, the 429-derived session window, and the
  // per-account CLI version override. 099's header reserved this slot for
  // the claude scheduling-column family. Scheduling signal only, never
  // billing; 101 is sub2api parity Phase 2 (COM-01).
  PROVIDER_ACCOUNT_CLAUDE_SCHEDULING_SAAS_MIGRATION,
  IDENTITY_OAUTH_IDENTITIES_SAAS_MIGRATION,
  // 102/103: sub2api parity Phase 3 observability — passive channel metrics
  // rollup (1m + hourly + watermark cursor) and alert rules/events.
  OBS_CHANNEL_METRICS_SAAS_MIGRATION,
  OBS_ALERTS_SAAS_MIGRATION,
  // 104: R2 embeddings endpoint — the OpenAI protocol family additionally
  // hosts the embeddings operation; widens 029's provenance-shape CHECK.
  OPENAI_EMBEDDINGS_OPERATION_SAAS_MIGRATION,
  // 105: R1 billing groups — new-api/sub2api group multipliers as an OUTER
  // rational multiplier snapshotted at admission (settlement never re-queries
  // the group table), account-pool M2M, key/tenant group binding, and the
  // topup multiplier skeleton. Numbered 105 because R2 consumed the plan's
  // 104 slot first (fail-closed serial ordering).
  BILLING_GROUPS_SAAS_MIGRATION,
  // 106: R4 registration admission — the durable email-verification-code
  // ledger (hash-only storage, purpose isolation, attempt bounds, one-time
  // consume). Admission switches (registration mode / Turnstile / SMTP /
  // domain lists) live in the settings surface, not the schema.
  REGISTRATION_ADMISSION_SAAS_MIGRATION,
  // 107: R3 egress proxies — the sub2api per-account egress survival line
  // (KMS-sealed proxy credentials, protocol whitelist with socks5→socks5h
  // upgrade, expiry fallback modes, probe-quality scheduling signal). The
  // plan's 105 slot was consumed by R1 billing groups (documented
  // re-arbitration); 107 is the reserved slot between the applied head 106
  // and the already-registered 108.
  EGRESS_PROXIES_SAAS_MIGRATION,
  // 108: R5b OpenCode Go scheduling — the rolling-5h/weekly/monthly usage
  // window snapshots plus the attempt-stamp/next-due/failure-streak/cooldown
  // columns the usage worker claims through, and the opencode_go_protocol_rules
  // jsonb rule table (multi-protocol adaptive routing). Scheduling signal
  // only, never billing; 107 is taken by R3 egress proxies above.
  PROVIDER_ACCOUNT_OPENCODE_GO_SCHEDULING_SAAS_MIGRATION,
  // 109: R6a active probing — the per-account probe monitors (arithmetic
  // few-shot challenge, consecutive-failure threshold) plus the append-only
  // run history with worker-side 30-day retention, and the
  // probe_temp_unschedulable_until scheduling signal on both account owner
  // tables (probe-success-only recovery). The plan reserved 107 for this
  // workstream; R3 egress proxies took it (documented re-arbitration), so
  // 109 is the next free slot after the applied 108 head.
  PROBE_MONITORS_SAAS_MIGRATION,
  // 110: F1 platform settings store — the platform-owned mutable runtime
  // configuration surface (one versioned row per settings key, CAS on
  // version, KMS-sealed envelopes for secret-suffixed keys, no plaintext
  // secret columns). Registration admission and topup amount-tier discounts
  // consume it store-first with env fallback; 111 is being registered
  // concurrently by the Gemini OAuth workstream (both tails are valid next
  // applications under the fail-closed serial ordering rule).
  PLATFORM_SETTINGS_SAAS_MIGRATION,
  // 111: F4 Gemini subscription scheduling — the tier-shaped daily/minute
  // quota windows (shared or per-model-class pro/flash, Pacific-midnight
  // reset), the 429 cooldown deadline, the loadCodeAssist tier id, and the
  // probe-category CHECK rewrite that admits the 'gemini' probe category on
  // the migration-109 monitors table. Scheduling signal only, never billing;
  // 110 is taken by the parallel F1 platform-settings workstream above.
  PROVIDER_ACCOUNT_GEMINI_SCHEDULING_SAAS_MIGRATION,
  // 112: R1 billing-group limit enforcement phase 1 — the snapshot
  // cross-cut: the group RPM/spend ceilings, supported model scopes and
  // fallback group id frozen onto the customer price snapshot row so the
  // later enforcement phases (113/114) can honor the R1 red line (enforce
  // from the frozen snapshot, never the mutable group table). All columns
  // nullable; existing rows backfill to NULL (no limit).
  BILLING_GROUP_SNAPSHOT_LIMITS_SAAS_MIGRATION,
  // 113: R1 billing-group limit enforcement phase 2 — the group RPM counter
  // store (the 098 per-account pattern at group scope). The capacity adapter
  // reads the frozen group_rpm_limit from the 112 snapshot columns and
  // atomically upserts this counter inside the admission fence; a rejection
  // rolls back with the transaction.
  BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION,
  // 114: R1 billing-group limit enforcement phase 3 — the group
  // daily/weekly/monthly spend counters and per-request reservations (the
  // KEY-BUD reserve-first-then-check pattern at group scope, UTC calendar
  // buckets), plus the API key 5h/7d rolling USD caps on the budget policy
  // head and the settled-amount column + lineage/created_at index that let
  // the reservation ledger answer trailing-window sums exactly.
  BILLING_GROUP_SPEND_WINDOWS_SAAS_MIGRATION,
  // 115: R-dormant activation (batch 2.2) — the scheduling-threshold
  // temporary-pause columns on both account owner tables. The lazy
  // candidate-collection evaluator writes them when a 099/100/108/111
  // quota-snapshot window is at or above the account's dormant
  // auto_pause_*_threshold (099); the pause runs to the latest breaching
  // window reset and recovers when the deadline passes (the 109
  // probe_temp_unschedulable_until eligibility precedent). Scheduling
  // signal only — never billing.
  PROVIDER_ACCOUNT_SCHEDULING_THRESHOLD_PAUSE_SAAS_MIGRATION,
  // 116: batch-2 §2.4 TLS fingerprints — the ClientHello profile registry
  // (sub2api tls_fingerprint_profiles parity) plus the tri-state account
  // binding column (NULL=off, 0=built-in Node 24.x default, -1=randomized,
  // >0=specific profile). Orthogonal to 099's dormant
  // codex_fingerprint_mode/seed (application-layer Codex device identity —
  // see the migration comment for the adjudication); 115 is the parallel
  // batch-2 threshold-pause workstream tail above.
  TLS_FINGERPRINT_PROFILES_SAAS_MIGRATION,
  // 117: batch-3 Bedrock scheduling signals — the minimal defensible
  // column family (bedrock_rate_limited_until + bedrock_usage_updated_at on
  // both account tables; Bedrock responses expose no quota windows, so the
  // ThrottlingException cooldown is the only observable scheduling signal)
  // plus the probe-category CHECK rewrite that admits the 'bedrock' probe
  // category on the migration-109 monitors table. Scheduling signal only,
  // never billing (the 099/111 precedent); 118 stays reserved for the
  // parallel Vertex workstream.
  PROVIDER_ACCOUNT_BEDROCK_SCHEDULING_SAAS_MIGRATION,
  // 118: batch-3 Vertex AI service-account scheduling signals — the minimal
  // defensible column family (vertex_rate_limited_until +
  // vertex_usage_updated_at on both account tables; Vertex service accounts
  // are pay-as-you-go with no daily quota windows, so the 429 cooldown —
  // retry-after, else google.rpc.RetryInfo capped at 15 minutes, else the
  // 60-second fallback — is the only observable scheduling signal) plus the
  // probe-category CHECK rewrite that admits the 'vertex' probe category on
  // the migration-109 monitors table. Scheduling signal only, never billing
  // (the 099/111/117 precedent).
  PROVIDER_ACCOUNT_VERTEX_SCHEDULING_SAAS_MIGRATION,
  // 119: batch-3 Grok scheduling signals — the xAI quota-header window
  // family (token + request windows with the ms/s/relative reset
  // disambiguation), the 429 cooldown deadline, the access-token-derived
  // subscription tier and the weekly/monthly billing probe snapshot, plus
  // the probe-category CHECK rewrite that admits the 'grok' probe category
  // on the migration-109 monitors table. 117/118 stay reserved for the
  // parallel batch-3 Bedrock/Vertex workstreams. Scheduling signal only,
  // never billing (the 099/111 precedent).
  PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION,
  // 120: batch-3 CN providers (zhipu / minimax) — the dual-mode account
  // configuration columns (account_mode payg/coding + api_protocol
  // chat_completions/anthropic/responses/adaptive, the adaptive mode routing
  // the native endpoint per inbound client protocol) plus the Coding Plan
  // rolling-window quota snapshot family ({provider}_5h/weekly
  // used_percent/reset_at + the worker lease/backoff/cooldown columns) the
  // cn-providers quota worker writes and the 115 threshold evaluator
  // consumes. Scheduling signal only — never billing (the 099/108
  // precedent).
  CN_PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION,
  // 121: batch-4 §4.4 composite model routing (task #18) — the admin route
  // registry saas_composite_model_routes (public model → concrete provider
  // platform + optional upstream model; the gateway resolves composite-group
  // requests with the three-level resolver in
  // src/saas/gateway/composite-route-resolver.ts) plus the composite marker
  // column on the migration-105 billing-group head. Control-plane CRUD with
  // gateway read-only (the 105 grants mirror); unknown models fail closed.
  COMPOSITE_MODEL_ROUTES_SAAS_MIGRATION,
  // 122: batch-4 §4.1 multimodal billing (task #15) — per_unit rate pair +
  // tier ladder + token-multiplier policy on both 017 version tables, the
  // per-unit hold witness on customer price snapshots, the media metering
  // columns on usage events, the per-unit evidence envelope columns on
  // prepared-request evidence (with the 024 immutability function's
  // hardcoded column list extended). All additive/defaulted: token-only
  // rows and their digests are byte-identical (the #14 anti-drift policy).
  MULTIMODAL_BILLING_SAAS_MIGRATION,
  // 123: batch-4 §4.2 async image tasks (task #16) — the saas_image_tasks
  // lifecycle registry (processing/completed/failed + 24 h TTL); gateway
  // role owns the lifecycle (column-scoped INSERT/UPDATE + dynamic read),
  // control plane has no access.
  IMAGE_TASKS_SAAS_MIGRATION,
  // 124: batch-4 §4.3 async video tasks (task #17) — the create-time
  // billing snapshot + bound-account binding + one-shot billing claim
  // (pending → billed atomically, released on settlement failure, skipped
  // fail-closed when the snapshot is missing).
  VIDEO_TASKS_SAAS_MIGRATION,
  // 125: batch-5 §5.4 content risk control (task #19) — single-row gateway-
  // readable JSONB config, the moderation decision log (hit/non-hit rows,
  // auto-ban violation counting, admin filter dimensions), and the pre-hash
  // blocklist for previously flagged inputs. Retention cleanup runs on the
  // control plane; the gateway seam writes logs and hashes only.
  RISK_CONTROL_CONTENT_MODERATION_SAAS_MIGRATION,
  // 126: batch-5 §5.2 OEM white-label (task #20) — the gateway-readable
  // public brand snapshot single-row table. The control plane materializes
  // the non-secret `saas.brand.*` settings subset into it; the gateway and
  // the console-serving workloads read it (SSR `window.__APP_CONFIG__`
  // injection, `GET /settings/public`) through read-only grants.
  PUBLIC_BRAND_SETTINGS_SAAS_MIGRATION,
  // 127: batch-5 §5.6 alert/report gaps (task #23) — the operator silence
  // table the alert evaluator consults each cycle (a silenced rule neither
  // triggers nor auto-resolves; rule/platform scope, group/region reserved)
  // plus the per-report-type last_run state row the scheduled email reports
  // claim under a SKIP LOCKED lease BEFORE generating content, so a broken
  // SMTP config can never retry every minute.
  OBS_ALERT_SILENCES_SAAS_MIGRATION,
  // 128: batch-5 §5.1 plugin system (task #24) — the DB-authoritative
  // installation registry (with the signed artifact bytes for replica
  // re-verify), the capability-scope binding table (partial unique index =
  // one enabled plugin per capability scope), and the PG-backed host-service
  // KV store. The plugin-host workload converges from these rows (1s
  // reconcile); grants live in runtime-privileges.ts and the new
  // plugin-host role template. 123/124/127 stay reserved for the parallel
  // media/websearch/observability workstreams.
  PLUGIN_SYSTEM_SAAS_MIGRATION,
  // 129: K2 account-attributable runtime-health outcomes — extends the 040
  // last_outcome/outcome_shape CHECKs with gateway_account_access_failure
  // (401/403), gateway_rate_limited_failure (429) and
  // gateway_stream_abort_failure (mid-stream abort after ≥1 delivered chunk)
  // so the durable classification can cool a faulted account in the
  // scheduler's P17 fail-open fallback. Same-table constraint rewrite only;
  // authored as 112 on main (head 111) and renumbered to 129 here because
  // 112-128 are taken by the capability-parity workstream.
  PROVIDER_ACCOUNT_DURABLE_FAULT_CLASSIFICATION_SAAS_MIGRATION,
  // 130: core-plan 9.2 window three-state — the per-account window cost
  // policy (`window_cost_limit_minor_units` / `window_cost_sticky_reserve_
  // minor_units`, NULL = the gate is OFF; the control plane freezes the
  // values, the gateway only reads) plus the missing supplier half of the
  // metering pipeline: `saas_attempt_supplier_costs`, ONE append-only exact
  // amount per settled attempt (the customer side was durable in
  // holds/settlements, the supplier side existed only as 017 rates). The
  // normal-success settlement transaction is the sole writer (platform
  // supply mode only); the scheduler aggregates the fact per account window
  // (schedulingThresholdWindowStartMs) for the reserve band gate.
  PROVIDER_ACCOUNT_WINDOW_COST_POLICY_SAAS_MIGRATION,
  // R3 §8.1: the supplier identity guard accepts the composite target
  // platform (capability-verified) while the customer guard stays pinned to
  // the public model version's nominal identity.
  RESOLVED_SUPPLY_BILLING_IDENTITY_SAAS_MIGRATION,
  // Gap-remediation G-A1 (migration 132): the async-video recovery
  // substrate — next_poll_at due cursor, lease owner/epoch/until for the
  // PG-lease recovery claim, and the six-class poll failure counter. The
  // recovery worker claims pending rows past next_poll_at under a 90 s
  // lease, re-dials the bound account, and drives the existing one-shot
  // billing state machine without any client poll (new-api task_polling
  // CAS-winner-settles + sub2api heartbeat-lease fusion). Image tasks need
  // no columns: their recovery is the guarded stuck-fail sweep.
  MEDIA_TASK_RECOVERY_SAAS_MIGRATION,
  // Core-plan 9.1 (migration 133): the durable (account, model) cooldown
  // table backing the model-level rate-limit registry. The dispatch side
  // records model-unavailable outcomes (404 / plan-gated 400) as a 30-minute
  // pair cooldown; every instance reads the same rows instead of a private
  // in-process Map, with `cooled_until > now()` as the invalidation bound and
  // GREATEST-merge upserts so cooldowns never shorten across instances.
  PROVIDER_ACCOUNT_MODEL_COOLDOWNS_SAAS_MIGRATION,
  RESPONSES_COMPACT_OPERATION_SAAS_MIGRATION,
  KIMI_CODING_QUOTA_SNAPSHOTS_SAAS_MIGRATION,
  OPS_MEDIA_REQUEUE_REQUESTS_SAAS_MIGRATION,
  PLATFORM_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION,
  REDIS_QUOTA_WRITEBACK_SAAS_MIGRATION,
  PLATFORM_INFERENCE_ACCESS_OPERATIONS_SAAS_MIGRATION,
  PAYMENT_MERCHANT_BINDINGS_SAAS_MIGRATION,
  RESPONSES_CONTINUATION_CONTEXTS_SAAS_MIGRATION,
  PAYMENT_CREATE_REQUEST_FINGERPRINT_SAAS_MIGRATION,
  FAST_GATEWAY_JOURNAL_SAAS_MIGRATION,
  FAST_GATEWAY_RESOLUTION_SAAS_MIGRATION,
  FAST_GATEWAY_CREDIT_STRIPES_SAAS_MIGRATION,
  FAST_RECEIPT_LIABILITY_RELEASES_SAAS_MIGRATION,
  BOUNDED_FAST_GATEWAY_BUDGET_SAAS_MIGRATION,
];
