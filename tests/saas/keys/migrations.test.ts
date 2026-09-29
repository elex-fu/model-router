import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_KEY_EXECUTION_PRINCIPALS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/012_api_key_execution_principals.js';
import { PROJECT_ENTITLEMENT_SUPERSESSION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/013_project_entitlement_supersession.js';

test('migration 012 backfills historical keys as members without fabricating service principals', () => {
  const { sql } = API_KEY_EXECUTION_PRINCIPALS_SAAS_MIGRATION;

  assert.equal(API_KEY_EXECUTION_PRINCIPALS_SAAS_MIGRATION.version, 12);
  assert.match(
    sql,
    /SET execution_principal_type = 'member',\s*execution_principal_id = principal_user_id,\s*created_by_user_id = principal_user_id/i,
  );
  assert.doesNotMatch(sql, /SET\s+execution_principal_type\s*=\s*'project_service'/i);
  assert.match(sql, /ALTER COLUMN principal_user_id DROP NOT NULL/i);
  assert.match(sql, /execution_principal_type IN \('member', 'project_service'\)/i);
  assert.match(sql, /execution_principal_type = 'project_service'[\s\S]+execution_principal_id = project_id/i);
  assert.match(sql, /created_by_user_id\)[\s\S]+REFERENCES saas_users/i);
  assert.match(sql, /rotated_by_user_id\)[\s\S]+REFERENCES saas_users/i);
  assert.match(sql, /revoked_by_user_id\)[\s\S]+REFERENCES saas_users/i);
  assert.match(sql, /model_scope_version bigint NOT NULL DEFAULT 1/i);
  assert.match(sql, /entitlement_authz_version bigint/i);
  assert.match(sql, /supply_profile_authz_version bigint/i);
  assert.match(sql, /active project membership/i);
});

test('migration 013 separates current and existing-key-only entitlement bindings', () => {
  const { sql } = PROJECT_ENTITLEMENT_SUPERSESSION_SAAS_MIGRATION;

  assert.equal(PROJECT_ENTITLEMENT_SUPERSESSION_SAAS_MIGRATION.version, 13);
  assert.match(sql, /ADD COLUMN superseded_at timestamptz/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS saas_project_entitlements_status_check/i);
  assert.match(sql, /status = 'superseded'[\s\S]+superseded_at IS NOT NULL/i);
  assert.match(sql, /superseded_at IS NULL OR superseded_at >= effective_at/i);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX saas_project_entitlements_one_active_per_project_mode_idx[\s\S]+WHERE status = 'active'/i,
  );
  assert.match(sql, /WHERE status = 'superseded'/i);
});
