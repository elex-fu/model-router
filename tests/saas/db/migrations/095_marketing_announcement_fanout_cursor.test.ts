import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { MARKETING_ANNOUNCEMENT_FANOUT_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/095_marketing_announcement_fanout_cursor.js';

// Static candidate/source assertions only.
const migration = MARKETING_ANNOUNCEMENT_FANOUT_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('095 registers after 094 with the documented gaps; 103 is the current forward', () => {
  assert.equal(migration.version, 95);
  assert.equal(migration.name, 'marketing_announcement_fanout_cursor');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  // 104 (R2 embeddings), 105 (R1 billing groups), 106 (R4 registration
  // admission) and 108 (R5b OpenCode Go scheduling) follow at the tail.
  assert.equal(registered.at(-1), 111);
  assert.equal(SAAS_MIGRATIONS[75], migration);
});

test('095 keeps the announcement row as the fan-out cursor with a draft-shape CHECK', () => {
  assert.match(commands, /ALTER TABLE saas_marketing_announcements\s+ADD COLUMN fanout_completed_at timestamptz/);
  // Drafts never fan out; published and withdrawn rows may carry the stamp
  // (withdrawal after a completed fan-out keeps its history).
  assert.match(
    commands,
    /CONSTRAINT saas_marketing_announcements_fanout_shape\s+CHECK \(status <> 'draft' OR fanout_completed_at IS NULL\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_marketing_announcements_fanout_due_idx\s+ON saas_marketing_announcements \(publish_at, id\)\s+WHERE status = 'published' AND fanout_completed_at IS NULL/,
  );
});

test('095 changes no trigger, ACL, event type or lifecycle shape', () => {
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /platform\.maintenance|event_type/i);
});
