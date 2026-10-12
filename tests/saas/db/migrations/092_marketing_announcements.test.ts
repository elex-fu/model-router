import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { MARKETING_ANNOUNCEMENTS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/092_marketing_announcements.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = MARKETING_ANNOUNCEMENTS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('092 registers after 089 with the documented 061/062, retired 064-079, 086 and 090/091 gaps', () => {
  assert.equal(migration.version, 92);
  assert.equal(migration.name, 'marketing_announcements');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 60).map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false, `${skipped} stays a retired Track D-G gap`);
  }
  assert.equal(registered.includes(86), false);
  // 090/091 landed with R1/R2 (wave 3); the R-series re-arbitration keeps
  // 096+ for the remaining reserved domains in landing order.
  assert.equal(SAAS_MIGRATIONS[72], migration);
});

test('092 models the broadcast announcement with bounded text and a one-way status machine', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_announcements \(/);
  assert.match(commands, /CHECK \(kind IN \('maintenance', 'info', 'billing'\)\)/);
  assert.match(commands, /CHECK \(severity IN \('info', 'warning', 'critical'\)\)/);
  assert.match(commands, /CHECK \(status IN \('draft', 'published', 'withdrawn'\)\)/);
  assert.match(commands, /status text NOT NULL DEFAULT 'draft'/);
  assert.match(commands, /version bigint NOT NULL DEFAULT 1/);
  assert.match(
    commands,
    /CONSTRAINT saas_marketing_announcements_title_bounds\s+CHECK \(btrim\(title\) <> '' AND char_length\(title\) <= 200\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_marketing_announcements_body_bounds\s+CHECK \(btrim\(body\) <> '' AND char_length\(body\) <= 8000\)/,
  );
  assert.match(commands, /CONSTRAINT saas_marketing_announcements_version_positive\s+CHECK \(version >= 1\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_marketing_announcements_window_order\s+CHECK \(unpublish_at IS NULL OR unpublish_at > publish_at\)/,
  );
  assert.match(commands, /created_by_user_id uuid NOT NULL REFERENCES saas_users \(id\) ON DELETE RESTRICT/);
});

test('092 makes read receipts per (announcement, user) and append-only at the database level', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_announcement_reads \(/);
  assert.match(commands, /CONSTRAINT saas_marketing_announcement_reads_pk PRIMARY KEY \(announcement_id, user_id\)/);
  assert.match(
    commands,
    /FOREIGN KEY \(announcement_id\) REFERENCES saas_marketing_announcements \(id\) ON DELETE RESTRICT/,
  );
  assert.match(commands, /tenant_id uuid NOT NULL REFERENCES saas_tenants \(id\) ON DELETE RESTRICT/);
  assert.match(
    commands,
    /CREATE TRIGGER saas_marketing_announcement_reads_no_update\s+BEFORE UPDATE ON saas_marketing_announcement_reads/,
  );
  assert.match(commands, /Marketing announcement reads are append-only/);
  for (const table of ['saas_marketing_announcements', 'saas_marketing_announcement_reads']) {
    assert.match(commands, new RegExp(`CREATE TRIGGER ${table}_no_delete\\s+BEFORE DELETE ON ${table}`));
  }
});

test('092 guards identity immutability, one-way transitions and the version CAS with pinned search paths', () => {
  assert.match(commands, /CREATE FUNCTION saas_marketing_announcement_guard\(\) RETURNS trigger/);
  assert.match(commands, /Marketing announcement identity is immutable/);
  assert.match(commands, /Marketing announcement status transitions are one-way/);
  assert.match(commands, /OLD\.status = 'draft' AND NEW\.status IN \('published', 'withdrawn'\)/);
  assert.match(commands, /OLD\.status = 'published' AND NEW\.status = 'withdrawn'/);
  // A published announcement can never return to draft: the only allowed
  // transitions are draft -> published/withdrawn and published -> withdrawn.
  assert.doesNotMatch(commands, /NEW\.status = 'draft'/);
  assert.match(commands, /Marketing announcement version increments by exactly one/);
  assert.match(commands, /NEW\.version <> OLD\.version \+ 1/);
  for (const fn of [
    'saas_marketing_announcement_guard',
    'saas_marketing_announcement_read_guard',
    'saas_marketing_announcement_reject_delete',
  ]) {
    assert.match(
      commands,
      new RegExp(`ALTER FUNCTION ${fn}\\(\\)\\s+SET search_path TO pg_catalog, model_router_saas, pg_temp`),
    );
  }
  assert.match(
    commands,
    /CREATE TRIGGER saas_marketing_announcements_guard\s+BEFORE UPDATE ON saas_marketing_announcements/,
  );
});

test('092 grants no privileges and touches no existing object', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /ALTER TABLE(?! saas_marketing)/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /authz_version/i);
});
