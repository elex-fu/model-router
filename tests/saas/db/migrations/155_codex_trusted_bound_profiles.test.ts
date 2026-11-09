import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CODEX_TRUSTED_BOUND_PROFILES_SAAS_MIGRATION as migration } from '../../../../src/saas/db/migrations/155_codex_trusted_bound_profiles.js';

test('155 creates the Codex trusted-bound admission ledger with fail-closed lifecycle checks', () => {
  assert.equal(SAAS_MIGRATIONS.at(-2), migration);
  assert.equal(migration.version, 155);
  assert.equal(migration.name, 'codex_trusted_bound_profiles');
  assert.match(migration.sql, /CREATE TABLE saas_codex_trusted_bound_profiles/);
  // The digest is a server-recomputed deduplication key, never a wire assertion.
  assert.match(migration.sql, /digest text NOT NULL UNIQUE CHECK \(digest ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  // Exact-scope columns mirror the in-code CodexTrustedBoundProfile scope axes.
  for (const column of ['endpoint', 'product_id', 'model', 'operation', 'transport', 'continuation_mode']) {
    assert.match(migration.sql, new RegExp(`${column} text NOT NULL`), `scope column ${column} must be NOT NULL text`);
  }
  assert.match(migration.sql, /transport text NOT NULL CHECK \(transport IN \('http', 'websocket'\)\)/);
  assert.match(
    migration.sql,
    /continuation_mode text NOT NULL CHECK \(\s*continuation_mode IN \('full', 'canonical-replay', 'remote-history', 'compact'\)\s*\)/,
  );
  assert.match(migration.sql, /bounds jsonb NOT NULL/);
  // Validity window is a hard constraint, not a service-layer convention.
  assert.match(
    migration.sql,
    /CONSTRAINT saas_codex_bound_validity_window CHECK \(\s*valid_from_ms < expires_at_ms\s*\)/,
  );
  // Approval is the only state carrying lineage: pending/rejected must be
  // lineage-free, retired keeps the audit trail immutable.
  assert.match(
    migration.sql,
    /CONSTRAINT saas_codex_bound_approval_lifecycle CHECK \(\s*\(state = 'approved' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL\)\s*OR \(state IN \('pending', 'rejected'\) AND approved_by_user_id IS NULL AND approved_at IS NULL\)\s*OR state = 'retired'\s*\)/,
  );
  assert.match(
    migration.sql,
    /state text NOT NULL CHECK \(state IN \('pending', 'approved', 'rejected', 'retired'\)\)/,
  );
  // Actor FKs keep submitted/approved lineage undeletable while referenced.
  for (const column of [
    'submitted_by_user_id uuid NOT NULL REFERENCES saas_users\\(id\\) ON DELETE RESTRICT',
    'approved_by_user_id uuid REFERENCES saas_users\\(id\\) ON DELETE RESTRICT',
  ])
    assert.match(migration.sql, new RegExp(column));
  // The gateway resolver refresh reads exactly this partial index predicate.
  assert.match(
    migration.sql,
    /CREATE INDEX saas_codex_trusted_bound_profiles_approved_scope_idx\s+ON saas_codex_trusted_bound_profiles \(\s*endpoint, product_id, model, operation, transport, continuation_mode\s*\)\s+WHERE state = 'approved'/,
  );
  // Schema only: grants live in the roles template, and the migration never
  // writes rows, grants privileges, or escalates privileges.
  assert.doesNotMatch(
    migration.sql,
    /\bGRANT\s+|\bSECURITY\s+DEFINER\b|\bINSERT\s+INTO\b|\bUPDATE\s+saas_|\bDELETE\s+FROM\b/i,
  );
});
