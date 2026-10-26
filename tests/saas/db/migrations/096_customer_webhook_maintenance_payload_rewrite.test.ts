import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CUSTOMER_WEBHOOK_MAINTENANCE_PAYLOAD_REWRITE_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/096_customer_webhook_maintenance_payload_rewrite.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = CUSTOMER_WEBHOOK_MAINTENANCE_PAYLOAD_REWRITE_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('096 registers after 095 with the documented gaps; 145 is the current head', () => {
  assert.equal(migration.version, 96);
  assert.equal(migration.name, 'customer_webhook_maintenance_payload_rewrite');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.deepEqual(registered.slice(-5), [141, 142, 143, 144, 145]);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  // Later forwards retain their order through 143 journal, 144 audited
  // resolution and the current 145 credit-stripe head.
  assert.equal(registered.at(-1), 145);
  assert.equal(SAAS_MIGRATIONS[76], migration);
});

test('096 replaces only the platform.maintenance disjunct with the announcement payload shape', () => {
  assert.match(commands, /payload ->> 'announcement_id' ~ '\^\[0-9a-f\]\{8\}/);
  assert.match(commands, /payload ->> 'kind' IN \('maintenance','info','billing'\)/);
  assert.match(commands, /payload ->> 'severity' IN \('info','warning','critical'\)/);
  assert.match(commands, /char_length\(payload ->> 'title'\) BETWEEN 1 AND 200/);
  assert.match(commands, /char_length\(payload ->> 'body'\) BETWEEN 1 AND 8000/);
  assert.match(commands, /payload -> 'unpublish_at' = 'null'::jsonb/);
  // Every other event-type disjunct stays byte-identical with 043.
  for (const marker of [
    "payload ->> 'supply_mode' = 'platform'",
    "payload ->> 'status' IN ('submitting','pending','succeeded','failed','unknown','blocked')",
    "payload ->> 'supply_mode' = request_supply_mode",
    "(payload ->> 'input_tokens')::numeric + (payload ->> 'output_tokens')::numeric = (payload ->> 'total_tokens')::numeric",
  ]) {
    assert.ok(commands.includes(marker), marker);
  }
});

test('096 pins the ISO timestamp regexes with escaped character classes', () => {
  // The TS template literal must carry double backslashes so the runtime SQL
  // string receives \d and \. (single backslash in the runtime string is the
  // correct form; a literal 'd'/'.' would reject every payload — the R8 PG
  // gate caught exactly that).
  assert.match(commands, /publish_at' ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\\d\{2\}:\\d\{2\}:\\d\{2\}\\.\\d\{3\}Z\$/);
  assert.doesNotMatch(commands, /\^d\{4\}-d\{2\}/);
});

test('096 fails closed on drift or pre-existing maintenance events, under one guarded swap', () => {
  assert.match(commands, /historical_def NOT LIKE '%''starts_at''%'/);
  assert.match(commands, /historical_def NOT LIKE '%''ends_at''%'/);
  assert.match(commands, /historical_def NOT LIKE '%''impact''%'/);
  assert.ok(commands.includes("OR historical_def LIKE '%''announcement_id''%'"));
  assert.match(
    commands,
    /IF EXISTS \(SELECT 1 FROM model_router_saas\.saas_customer_webhook_events\s+WHERE event_type = 'platform\.maintenance'\)\s+THEN RAISE EXCEPTION 'Migration 096 found pre-existing platform\.maintenance events; operator review required'/,
  );
  assert.match(commands, /LOCK TABLE model_router_saas\.saas_customer_webhook_events IN ACCESS EXCLUSIVE MODE/);
  assert.match(
    commands,
    /DROP CONSTRAINT saas_customer_webhook_events_payload_contract,\s+ADD CONSTRAINT saas_customer_webhook_events_payload_contract CHECK/,
  );
  assert.match(commands, /'Migration 096 validated constraint shape or pg_catalog-only postcondition failed'/);
  assert.match(commands, /'Migration 096 exceeded its one-CHECK catalog and unchanged ACL contract'/);
});

test('096 changes no function, trigger, ACL or table data', () => {
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /DROP FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /\bINSERT INTO\b|\bUPDATE model_router_saas/i);
  assert.doesNotMatch(commands, /DROP TABLE/i);
});
