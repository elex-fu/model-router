import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { IMAGE_TASKS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/123_image_tasks.js';

// Static candidate/source assertions only (the 121/122 pattern).
const migration = IMAGE_TASKS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('123 registers directly after the 122 multimodal billing tail', () => {
  assert.equal(migration.version, 123);
  assert.equal(migration.name, 'image_tasks');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(registered.includes(123));
  assert.ok(registered.indexOf(123) > registered.indexOf(122));
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(123)], migration);
});

test('123 creates the async image task lifecycle table', () => {
  assert.match(commands, /CREATE TABLE saas_image_tasks \(/);
  assert.match(commands, /id varchar\(48\) PRIMARY KEY CHECK \(id ~ '\^imgtask_\[0-9a-f\]\{32\}\$'\)/);
  assert.match(commands, /tenant_id text NOT NULL/);
  assert.match(commands, /proxy_key_id text NOT NULL/);
  assert.match(commands, /status text NOT NULL CHECK \(status IN \('processing', 'completed', 'failed'\)\)/);
  assert.match(commands, /http_status integer CHECK \(http_status IS NULL OR \(http_status BETWEEN 100 AND 599\)\)/);
  assert.match(commands, /result jsonb/);
  assert.match(commands, /error jsonb/);
  assert.match(commands, /created_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(commands, /completed_at timestamptz/);
  assert.match(commands, /expires_at timestamptz NOT NULL/);
  // The terminal-shape invariant: processing rows carry no result/error,
  // completed rows carry a result, failed rows carry an error envelope.
  assert.match(
    commands,
    /CONSTRAINT saas_image_tasks_terminal_shape CHECK \(\s*\(status = 'processing' AND http_status IS NULL AND result IS NULL AND error IS NULL AND completed_at IS NULL\)\s*OR \(status = 'completed' AND http_status IS NOT NULL AND result IS NOT NULL AND error IS NULL AND completed_at IS NOT NULL\)\s*OR \(status = 'failed' AND http_status IS NOT NULL AND result IS NULL AND error IS NOT NULL AND completed_at IS NOT NULL\)\s*\)/,
  );
  assert.match(commands, /CONSTRAINT saas_image_tasks_expiry_after_creation CHECK \(expires_at > created_at\)/);
});

test('123 carries the ownership, expiry and processing covering indexes', () => {
  assert.match(commands, /CREATE INDEX saas_image_tasks_owner_idx ON saas_image_tasks \(tenant_id, proxy_key_id\)/);
  assert.match(commands, /CREATE INDEX saas_image_tasks_expiry_idx ON saas_image_tasks \(expires_at\)/);
  assert.match(
    commands,
    /CREATE INDEX saas_image_tasks_processing_idx ON saas_image_tasks \(status, created_at\) WHERE status = 'processing'/,
  );
});

test('123 carries no triggers, no credentials and no authz_version bumps', () => {
  assert.doesNotMatch(commands, /CREATE TRIGGER|CREATE OR REPLACE FUNCTION/);
  assert.doesNotMatch(commands, /auth_sealed_envelope|kmsKeyId|ciphertext/);
  assert.doesNotMatch(commands, /authz_version/);
});
