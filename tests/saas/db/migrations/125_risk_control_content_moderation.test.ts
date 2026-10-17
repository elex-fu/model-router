import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { RISK_CONTROL_CONTENT_MODERATION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/125_risk_control_content_moderation.js';

// Static candidate/source assertions only (the 121 pattern); the real-
// database gate (migrate + role template re-apply + privilege probes + store
// round-trip) lives in the disposable-loopback integration harness.
const migration = RISK_CONTROL_CONTENT_MODERATION_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('125 registers after the 122 multimodal tail without squatting reserved slots', () => {
  assert.equal(migration.version, 125);
  assert.equal(migration.name, 'risk_control_content_moderation');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(registered.includes(125));
  assert.ok(registered.indexOf(125) > registered.indexOf(122));
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(125)], migration);
  // 124 stays reserved for the parallel websearch line: this migration must
  // not squat it (123 belongs to the parallel images line).
  assert.equal(registered.includes(124), false);
});

test('125 creates the single-row gateway-readable config table', () => {
  assert.match(commands, /CREATE TABLE saas_risk_control_config \(/);
  assert.match(commands, /id smallint PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/);
  assert.match(commands, /config jsonb NOT NULL/);
  assert.match(commands, /updated_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test('125 creates the moderation decision log with every persisted dimension', () => {
  assert.match(commands, /CREATE TABLE saas_content_moderation_logs \(/);
  assert.match(commands, /id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  for (const column of [
    'request_id text NOT NULL',
    'tenant_id text NOT NULL',
    'user_id text',
    'api_key_id text NOT NULL',
    'api_key_name text NOT NULL DEFAULT',
    'model text NOT NULL DEFAULT',
    'protocol text NOT NULL DEFAULT',
    'mode text NOT NULL',
    'action text NOT NULL',
    'flagged boolean NOT NULL DEFAULT false',
    'highest_category text NOT NULL DEFAULT',
    'highest_score double precision NOT NULL DEFAULT 0',
    'matched_keyword text NOT NULL DEFAULT',
    'category_scores jsonb NOT NULL DEFAULT',
    'threshold_snapshot jsonb NOT NULL DEFAULT',
    'input_excerpt text NOT NULL DEFAULT',
    'input_hash text',
    'upstream_latency_ms integer',
    'error text NOT NULL DEFAULT',
    'violation_count integer NOT NULL DEFAULT 0',
    'auto_banned boolean NOT NULL DEFAULT false',
    'email_sent boolean NOT NULL DEFAULT false',
    'created_at timestamptz NOT NULL DEFAULT now',
  ]) {
    assert.ok(commands.includes(column), `missing log column: ${column}`);
  }
  assert.match(commands, /CHECK \(action IN \('allow', 'block', 'hash_block', 'keyword_block', 'error'\)\)/);
  assert.match(commands, /CHECK \(mode IN \('off', 'observe', 'pre_block'\)\)/);
});

test('125 indexes the admin filter dimensions and the violation window', () => {
  assert.match(commands, /CREATE INDEX saas_content_moderation_logs_created_at_idx/);
  assert.match(
    commands,
    /CREATE INDEX saas_content_moderation_logs_tenant_created_idx\s+ON saas_content_moderation_logs \(tenant_id, created_at\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_content_moderation_logs_action_created_idx\s+ON saas_content_moderation_logs \(action, created_at\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_content_moderation_logs_model_created_idx\s+ON saas_content_moderation_logs \(model, created_at\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_content_moderation_logs_user_flagged_created_idx\s+ON saas_content_moderation_logs \(user_id, created_at\)\s+WHERE flagged AND user_id IS NOT NULL/,
  );
});

test('125 creates the flagged-hash blocklist with a hex-digest guard', () => {
  assert.match(commands, /CREATE TABLE saas_content_moderation_flagged_hashes \(/);
  assert.match(commands, /input_hash text PRIMARY KEY/);
  assert.match(commands, /CHECK \(input_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(commands, /CREATE INDEX saas_content_moderation_flagged_hashes_created_at_idx/);
});

test('125 grants no privileges and mounts no trigger or function', () => {
  assert.equal(commands.includes('GRANT '), false);
  assert.equal(commands.includes('CREATE TRIGGER '), false);
  assert.equal(commands.includes('CREATE FUNCTION '), false);
  // The log table is cross-tenant by design (platform-wide risk control), so
  // no tenant_id FK or per-tenant scoping exists.
  assert.equal(commands.includes('REFERENCES '), false);
});
