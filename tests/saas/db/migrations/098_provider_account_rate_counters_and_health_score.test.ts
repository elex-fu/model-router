import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_RATE_AND_HEALTH_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/098_provider_account_rate_counters_and_health_score.js';

// Static candidate/source assertions only.
const migration = PROVIDER_ACCOUNT_RATE_AND_HEALTH_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('098 registers after 097 ahead of later forwards with the documented gaps', () => {
  assert.equal(migration.version, 98);
  assert.equal(migration.name, 'provider_account_rate_counters_and_health_score');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  // 104 (R2 embeddings), 105 (R1 billing groups), 106 (R4 registration
  // admission) and 108 (R5b OpenCode Go scheduling) follow at the tail.
  // K2: 129 (provider_account_durable_fault_classification, renumbered
  // from main's 112 in this merge) is the new head.
  assert.equal(registered.at(-1), 137);
  assert.equal(SAAS_MIGRATIONS[78], migration);
});

test('098 creates the PG-authoritative per-account per-second counter store', () => {
  assert.match(commands, /CREATE TABLE saas_provider_account_rate_counters \(/);
  assert.match(commands, /account_scope text NOT NULL\s+CHECK \(account_scope IN \('tenant', 'platform'\)\)/);
  assert.match(commands, /account_id text NOT NULL/);
  assert.match(commands, /window_start timestamptz NOT NULL/);
  assert.match(commands, /requests integer NOT NULL DEFAULT 0\s+CHECK \(requests >= 0\)/);
  assert.match(commands, /tokens bigint NOT NULL DEFAULT 0\s+CHECK \(tokens >= 0\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_provider_account_rate_counters_pk\s+PRIMARY KEY \(account_scope, account_id, window_start\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_provider_account_rate_counters_window_idx\s+ON saas_provider_account_rate_counters \(account_scope, account_id, window_start DESC\)/,
  );
});

test('098 adds nullable rpm/tpm caps and the continuous health score with backward-compatible NULLs', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN rpm_limit integer,\\s+ADD COLUMN tpm_limit integer`),
    );
    assert.match(
      commands,
      new RegExp(`ADD CONSTRAINT ${table}_rpm_limit_positive\\s+CHECK \\(rpm_limit IS NULL OR rpm_limit > 0\\)`),
    );
    assert.match(
      commands,
      new RegExp(`ADD CONSTRAINT ${table}_tpm_limit_positive\\s+CHECK \\(tpm_limit IS NULL OR tpm_limit > 0\\)`),
    );
    assert.doesNotMatch(commands, /ADD COLUMN rpm_limit integer NOT NULL/);
  }
  assert.match(commands, /ALTER TABLE saas_provider_account_runtime_health\s+ADD COLUMN health_score numeric\(4,3\),/);
  assert.match(commands, /ADD COLUMN half_open_probe_at timestamptz/);
  assert.match(
    commands,
    /ADD CONSTRAINT saas_provider_account_runtime_health_score_range\s+CHECK \(health_score IS NULL OR \(health_score >= 0 AND health_score <= 1\)\)/,
  );
});

test('098 grants no privileges and changes no trigger or lifecycle shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /DROP /i);
});
