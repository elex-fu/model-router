import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/044_project_service_key_authorization.js';

const migration = PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION;
const sql = migration.sql;

test('migration 044 defines transactional project-policy invalidation without duplicating policy authority', () => {
  assert.equal(migration.version, 44);
  assert.equal(migration.name, 'project_service_key_authorization_and_policy_invalidation');
  assert.match(sql, /CREATE TABLE saas_project_policy_invalidation_outbox/i);
  assert.match(sql, /UNIQUE \(tenant_id, project_id, policy_version\)/i);
  assert.match(sql, /REFERENCES saas_projects \(tenant_id, id\)/i);
  assert.match(sql, /REFERENCES saas_project_inference_policy_versions \(tenant_id, project_id, version\)/i);
  assert.doesNotMatch(sql, /ADD COLUMN[^;]*(?:policy_status|suspension_status)/i);
});

test('migration 044 emits durable outbox records and transactional notifications from policy-head changes', () => {
  assert.match(
    sql,
    /CREATE FUNCTION saas_projects_emit_inference_policy_invalidation\(\)[\s\S]+SECURITY DEFINER[\s\S]+INSERT INTO public\.saas_project_policy_invalidation_outbox/i,
  );
  assert.match(sql, /pg_catalog\.pg_notify\([\s\S]+saas_project_policy_invalidation/i);
  assert.match(
    sql,
    /CREATE TRIGGER saas_projects_policy_invalidation_outbox\s+AFTER UPDATE OF inference_policy_version, inference_policy_status ON saas_projects/i,
  );
  assert.match(sql, /WHEN \(OLD\.inference_policy_version IS DISTINCT FROM NEW\.inference_policy_version/i);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|TRIGGER|FUNCTION)/i);
});
