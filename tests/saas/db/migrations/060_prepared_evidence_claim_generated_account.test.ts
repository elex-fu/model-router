import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/028_prepared_request_evidence_pool_claim_hardening.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';
import {
  PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION,
  PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE,
  PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE,
} from '../../../../src/saas/db/migrations/060_prepared_evidence_claim_generated_account.js';

function extract(source: string, marker: string, endMarker: string): string {
  assert.equal(source.split(marker).length, 2, 'one exact historical marker required');
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= start);
  return source.slice(start, end);
}

test('staged 060 reconstructs the exact 028 body with only the original 050 pool fence rewrite', () => {
  const historical = extract(PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
    'CREATE OR REPLACE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool() RETURNS trigger\nLANGUAGE plpgsql AS $$', '\n$$;') + '\n';
  const sql050 = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql;
  const poolRead = extract(sql050, '  pool_read_anchor constant text := $pool_read_anchor$', '$pool_read_anchor$;');
  const poolFence = extract(sql050, '  pool_fence_preamble constant text := $pool_fence_preamble$', '$pool_fence_preamble$;');
  assert.equal(historical.split(poolRead).length, 2);
  assert.equal(PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE,
    historical.replace(poolRead, poolFence + poolRead.replace('FOR SHARE;', ';')));
  assert.match(PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE, /pg_advisory_xact_lock_shared/);
  assert.match(PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE, /FROM saas_prepared_request_evidence AS e[\s\S]+FOR SHARE;/);
  assert.doesNotMatch(PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE, /FROM saas_platform_provider_pools[\s\S]+FOR SHARE;/);
});

test('060 changes exactly one comparison to the platform base column, not any authority predicate', () => {
  const before = '      OR evidence_record.account_id IS DISTINCT FROM NEW.account_id\n';
  const after = '      OR evidence_record.account_id IS DISTINCT FROM NEW.platform_account_id\n';
  assert.equal(PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE.split(before).length, 2);
  assert.equal(PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE.split(after).length, 2);
  assert.equal(PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE.replace(after, before), PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE);
  assert.doesNotMatch(PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE, /NEW\.account_id\b/);
  for (const preserved of [
    "NEW.account_owner_kind IS DISTINCT FROM 'platform'", "NEW.dispatch_authority_state IS DISTINCT FROM 'bound'",
    "OLD.dispatch_state = 'not_sent'", "NEW.dispatch_state = 'dispatching'", 'IF NOT should_fence THEN',
    'evidence_record.attempt_id IS DISTINCT FROM NEW.id', 'evidence_record.credential_authz_version IS DISTINCT FROM NEW.credential_authz_version',
    'evidence_record.pool_member_authz_version IS DISTINCT FROM NEW.pool_member_authz_version',
    'evidence_record.pool_grant_pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version',
    'evidence_record.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version',
    "pool_record.validation_state IS DISTINCT FROM 'verified'", 'pool_record.authz_version IS DISTINCT FROM NEW.pool_authz_version',
  ]) assert.ok(PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE.includes(preserved));
});

test('060 fails closed on unknown lineage, owner, attributes, generated expression or trigger attachment', () => {
  const migration = PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION;
  assert.equal(migration.version, 60);
  assert.equal(migration.name, 'prepared_evidence_claim_generated_account');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const sql = migration.sql;
  assert.match(sql, /current_user IS DISTINCT FROM 'model_router_saas_migrator' OR session_user IS DISTINCT FROM current_user/);
  assert.match(sql, /routine\.prosrc IS DISTINCT FROM \$expected_claim_guard\$/);
  assert.match(sql, /routine\.prosecdef OR routine\.proconfig IS NOT NULL/);
  assert.match(sql, /t\.tgtype = 23 AND t\.tgenabled = 'O'/);
  assert.match(sql, /count\(\*\) FROM pg_catalog\.pg_trigger WHERE tgfoid = guard_id\) <> 1/);
  assert.match(sql, /a\.attname = 'account_id' AND a\.attgenerated = 's'/);
  assert.match(sql, /pg_catalog\.regexp_replace\(pg_catalog\.pg_get_expr\(d\.adbin, d\.adrelid\), '\[\[:space:\]\]\+', '', 'g'\) =/);
  assert.ok(sql.indexOf('060 owner-specific account projection drifted') < sql.indexOf('EXECUTE $claim_guard_ddl$'));
  assert.ok(sql.includes(PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE));
  assert.ok(sql.includes(PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE));
});

test('060 replaces only the existing body and preserves ACLs, security metadata, bindings and relation catalogs', () => {
  const sql = PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.sql;
  assert.equal(sql.split('CREATE OR REPLACE FUNCTION').length, 2);
  assert.match(sql, /LOCK TABLE model_router_saas\.saas_attempts, model_router_saas\.saas_prepared_request_evidence IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /pg_catalog\.to_jsonb\(p\) - 'prosrc'/);
  assert.match(sql, /metadata_after IS DISTINCT FROM metadata_before OR bindings_after IS DISTINCT FROM bindings_before/);
  assert.match(sql, /relations_after IS DISTINCT FROM relations_before/);
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|SECURITY DEFINER|ALTER ROLE|ALTER TABLE|DROP|TRUNCATE|DISABLE TRIGGER)\b/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:model_router_saas\.)?saas_/);
});
