import type { SaasMigration } from './001_initial_schema.js';

/*
 * User abuse controls. Runtime composition (recorder injection into the
 * admission guard, batch anomaly detection scheduling) is wired separately;
 * the schema below is inert until those options are enabled.
 *
 * Daily token/customer-charge accounting stays in the migration-081 immutable
 * reservation ledger. The tables below contain policy and risk markers only;
 * they are not a second usage/balance ledger. IP evidence is accepted only as
 * a deployment-keyed digest, never as a raw address.
 */
const userRiskControlsSql = `
CREATE TABLE saas_user_limit_defaults (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  requests_per_minute bigint CHECK (requests_per_minute >= 0),
  max_concurrent_requests bigint CHECK (max_concurrent_requests >= 0),
  daily_token_units bigint CHECK (daily_token_units >= 0),
  daily_charge_minor_units bigint CHECK (daily_charge_minor_units >= 0),
  charge_currency text,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_user_limit_defaults_charge_pair CHECK (
    (daily_charge_minor_units IS NULL AND charge_currency IS NULL)
    OR (daily_charge_minor_units IS NOT NULL AND btrim(charge_currency) <> '')
  )
);
INSERT INTO saas_user_limit_defaults (id) VALUES (1);

CREATE TABLE saas_user_limit_policies (
  user_id uuid PRIMARY KEY REFERENCES saas_users(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  requests_per_minute bigint CHECK (requests_per_minute >= 0),
  max_concurrent_requests bigint CHECK (max_concurrent_requests >= 0),
  daily_token_units bigint CHECK (daily_token_units >= 0),
  daily_charge_minor_units bigint CHECK (daily_charge_minor_units >= 0),
  charge_currency text,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_user_limit_policies_charge_pair CHECK (
    (daily_charge_minor_units IS NULL AND charge_currency IS NULL)
    OR (daily_charge_minor_units IS NOT NULL AND btrim(charge_currency) <> '')
  )
);
CREATE INDEX saas_api_keys_principal_user_active_idx
  ON saas_api_keys (principal_user_id, tenant_id, project_id, id)
  WHERE principal_user_id IS NOT NULL;
CREATE INDEX saas_api_key_budget_reservations_day_lineage_idx
  ON saas_api_key_budget_reservations (day, tenant_id, project_id, lineage_id)
  INCLUDE (token_units, charge_minor_units, charge_currency, state);

CREATE TABLE saas_user_risk_markers (
  user_id uuid PRIMARY KEY REFERENCES saas_users(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('rate_limited', 'key_suspended', 'account_suspended')),
  requests_per_minute bigint CHECK (requests_per_minute >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_user_risk_rate_requires_ceiling CHECK (
    stage <> 'rate_limited' OR requests_per_minute IS NOT NULL
  )
);

CREATE TABLE saas_user_risk_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  client_address_digest text CHECK (
    client_address_digest IS NULL OR client_address_digest ~ '^[0-9a-f]{64}$'
  ),
  public_model text NOT NULL,
  protocol text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX saas_user_risk_observations_key_time_idx
  ON saas_user_risk_observations (api_key_id, occurred_at, id);
CREATE INDEX saas_user_risk_observations_time_idx
  ON saas_user_risk_observations (occurred_at, id);

CREATE TABLE saas_user_anomaly_detections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rapid_address_switching', 'abrupt_call_pattern')),
  window_start timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (api_key_id, kind, window_start)
);
CREATE INDEX saas_user_anomaly_detections_user_time_idx
  ON saas_user_anomaly_detections (user_id, observed_at);
`;

export const USER_RISK_CONTROLS_SAAS_MIGRATION: SaasMigration = {
  version: 153,
  name: 'user_risk_controls',
  sql: userRiskControlsSql,
};
