import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { MARKETING_AFFILIATE_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/091_marketing_affiliate.js';

// Static candidate/source assertions only.
const migration = MARKETING_AFFILIATE_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('091 registers after 090 with the documented gaps', () => {
  assert.equal(migration.version, 91);
  assert.equal(migration.name, 'marketing_affiliate');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  assert.equal(SAAS_MIGRATIONS[71], migration);
});

test('091 makes attribution lifetime-immutable and refuses self-invites at the database level', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_affiliate_attributions \(/);
  assert.match(commands, /invitee_tenant_id uuid PRIMARY KEY REFERENCES saas_tenants \(id\) ON DELETE RESTRICT/);
  assert.match(commands, /CONSTRAINT saas_marketing_affiliate_attributions_no_self\s+CHECK \(inviter_tenant_id <> invitee_tenant_id\)/);
  assert.match(commands, /CREATE TRIGGER saas_marketing_affiliate_attributions_no_update\s+BEFORE UPDATE ON saas_marketing_affiliate_attributions/);
  assert.match(commands, /CREATE TRIGGER saas_marketing_affiliate_attributions_no_delete\s+BEFORE DELETE ON saas_marketing_affiliate_attributions/);
});

test('091 keeps the platform policy a singleton versioned head with exact +1 bumps', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_affiliate_policies \(/);
  assert.match(commands, /id text PRIMARY KEY\s+CHECK \(id = 'platform'\)/);
  assert.match(commands, /CHECK \(reward_bp >= 0 AND reward_bp <= 5000\)/);
  assert.match(commands, /NEW\.version IS DISTINCT FROM OLD\.version \+ 1/);
  assert.match(commands, /CREATE TRIGGER saas_marketing_affiliate_policies_guard\s+BEFORE UPDATE ON saas_marketing_affiliate_policies/);
});

test('091 makes rewards append-only with the idempotent source key and basis-point snapshots', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_affiliate_rewards \(/);
  assert.match(commands, /CONSTRAINT saas_marketing_affiliate_rewards_source_unique UNIQUE \(source_funding_ref\)/);
  assert.match(commands, /reward_bp_snapshot integer NOT NULL\s+CHECK \(reward_bp_snapshot >= 0 AND reward_bp_snapshot <= 5000\)/);
  assert.match(commands, /CHECK \(source_amount_minor_units ~ '\^\[0-9\]\{1,20\}\$'\)/);
  assert.match(commands, /CREATE TRIGGER saas_marketing_affiliate_rewards_no_update\s+BEFORE UPDATE ON saas_marketing_affiliate_rewards/);
  assert.match(commands, /CREATE TRIGGER saas_marketing_affiliate_rewards_no_delete\s+BEFORE DELETE ON saas_marketing_affiliate_rewards/);
});

test('091 grants no privileges and pins every guard search_path', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /ALTER TABLE(?! saas_marketing_affiliate)/i);
  const pins = commands.match(/SET search_path TO pg_catalog, model_router_saas, pg_temp/g);
  assert.equal(pins?.length, 4);
});
