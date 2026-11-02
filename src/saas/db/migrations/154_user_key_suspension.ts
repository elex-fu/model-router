import type { SaasMigration } from './001_initial_schema.js';

const userKeySuspensionSql = `
ALTER TABLE saas_api_keys ADD COLUMN suspended_at timestamptz;
ALTER TABLE saas_api_keys ADD COLUMN suspended_by_user_id uuid
  REFERENCES saas_users (id) ON DELETE RESTRICT;
ALTER TABLE saas_api_keys
  DROP CONSTRAINT IF EXISTS saas_api_keys_status_check,
  ADD CONSTRAINT saas_api_keys_status_check CHECK (status IN ('active', 'revoked', 'suspended'));
ALTER TABLE saas_api_keys
  DROP CONSTRAINT saas_api_keys_revocation_status,
  ADD CONSTRAINT saas_api_keys_revocation_status CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND suspended_at IS NULL)
    OR (status = 'active' AND revoked_at IS NULL AND suspended_at IS NULL)
    OR (status = 'suspended' AND revoked_at IS NULL AND suspended_at IS NOT NULL)
  );
`;

/**
 * M3 §7.2 reversible key pause: the anomaly ladder's second rung (and the
 * operator risk-control surface) can suspend a key instead of revoking it.
 * Gateway admission already fails closed on any status other than 'active',
 * so the status CHECK widening is the whole gateway-side change. Revocation
 * stays the terminal, non-reversible disposition.
 */
export const USER_KEY_SUSPENSION_SAAS_MIGRATION: SaasMigration = {
  version: 154,
  name: 'user_key_suspension',
  sql: userKeySuspensionSql,
};
