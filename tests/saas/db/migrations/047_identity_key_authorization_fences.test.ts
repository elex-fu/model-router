import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION as migration } from '../../../../src/saas/db/migrations/047_identity_key_authorization_fences.js';

test('migration 047 requires and verifies the exact migration 046 fence contract', () => {
  assert.equal(migration.version, 47);
  assert.equal(migration.name, 'identity_key_authorization_fences');
  assert.match(migration.sql, /to_regprocedure\('saas_platform_authorization_fence_users\(uuid\[\]\)'\)/);
  assert.match(migration.sql, /SELECT DISTINCT candidate\.user_id/);
  assert.match(migration.sql, /ORDER BY candidate\.user_id/);
  assert.match(migration.sql, /pg_advisory_xact_lock\(hashtextextended\(target_user_id::text, 0\)\)/);
  assert.match(migration.sql, /PERFORM set_config\(''lock_timeout'', ''2s'', TRUE\)/);
  assert.match(migration.sql, /PERFORM set_config\(''statement_timeout'', ''10s'', TRUE\)/);
  assert.match(migration.sql, /pg_advisory_xact_lock\(1396788563, 46\)/);
  assert.match(migration.sql, /saas_users_platform_authorization_fence/);
});

test('migration 047 fences every mutable identity and key authorization writer without grants', () => {
  for (const trigger of [
    'saas_tenants_authorization_writer',
    'saas_memberships_authorization_writer',
    'saas_project_memberships_authorization_writer',
    'saas_projects_authorization_writer',
    'saas_project_entitlements_authorization_writer',
    'saas_supply_profiles_authorization_writer',
    'saas_route_config_heads_authorization_writer',
    'saas_provider_rights_authorization_writer',
  ]) {
    assert.match(migration.sql, new RegExp(`CREATE TRIGGER ${trigger}\\b`));
  }
  assert.equal(
    (migration.sql.match(/EXECUTE FUNCTION saas_platform_authorization_writer_statement\(\)/g) ?? []).length,
    8,
  );
  assert.doesNotMatch(migration.sql, /saas_control_plane_authorization_writer_statement/);

  for (const trigger of [
    'saas_tenants_authorization_fence',
    'saas_memberships_authorization_fence',
    'saas_project_memberships_authorization_fence',
    'saas_projects_authorization_fence',
    'saas_project_entitlements_authorization_fence',
    'saas_supply_profiles_authorization_fence',
    'saas_route_config_heads_authorization_fence',
    'saas_provider_rights_authorization_fence',
  ]) {
    assert.match(migration.sql, new RegExp(`CREATE TRIGGER ${trigger}\\b`));
  }

  assert.match(migration.sql, /saas-authz:tenant:/);
  assert.match(migration.sql, /saas-authz:project:/);
  assert.match(migration.sql, /saas-authz:provider-rights/);
  assert.match(migration.sql, /AFTER INSERT OR DELETE OR UPDATE OF tenant_id, project_id/);
  assert.match(migration.sql, /AFTER INSERT OR UPDATE OR DELETE ON saas_route_config_heads/);
  assert.match(migration.sql, /AFTER INSERT OR UPDATE OR DELETE ON saas_provider_rights/);
  assert.match(migration.sql, /AFTER UPDATE OR DELETE ON saas_memberships/);
  assert.match(migration.sql, /AFTER UPDATE OR DELETE ON saas_project_memberships/);
  assert.doesNotMatch(migration.sql, /GRANT\s+UPDATE/i);
  assert.doesNotMatch(migration.sql, /FOR\s+(?:KEY\s+)?(?:NO\s+KEY\s+)?UPDATE|FOR\s+SHARE/i);
});
