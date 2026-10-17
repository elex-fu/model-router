import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { VIDEO_TASKS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/124_video_tasks.js';

// Static candidate/source assertions only (the 123 pattern).
const migration = VIDEO_TASKS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('124 registers directly after the 123 image tasks tail', () => {
  assert.equal(migration.version, 124);
  assert.equal(migration.name, 'video_tasks');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(registered.includes(124));
  assert.ok(registered.indexOf(124) > registered.indexOf(123));
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(124)], migration);
});

test('124 creates the async video task snapshot + binding + claim table', () => {
  assert.match(commands, /CREATE TABLE saas_video_tasks \(/);
  // The upstream request id is the public task id: opaque printable ASCII.
  assert.match(commands, /request_id varchar\(255\) PRIMARY KEY CHECK \(request_id ~ '\^\[!-\~\]\{1,255\}\$'\)/);
  // Ownership + bound account + deferred settlement anchor.
  assert.match(commands, /tenant_id text NOT NULL/);
  assert.match(commands, /proxy_key_id text NOT NULL/);
  assert.match(commands, /provider_account_id text NOT NULL/);
  assert.match(commands, /credential_id text NOT NULL/);
  assert.match(commands, /credential_version text NOT NULL/);
  assert.match(commands, /gateway_request_id text NOT NULL/);
  assert.match(commands, /gateway_attempt_id text NOT NULL/);
  // The create-time billing snapshot (resolution authority — the done
  // status never echoes it).
  assert.match(commands, /model text NOT NULL CHECK \(char_length\(btrim\(model\)\) > 0\)/);
  assert.match(commands, /resolution text NOT NULL CHECK \(resolution IN \('480p', '720p', '1080p'\)\)/);
  assert.match(commands, /duration_seconds integer NOT NULL CHECK \(duration_seconds BETWEEN 1 AND 15\)/);
  assert.match(commands, /video_count integer NOT NULL CHECK \(video_count BETWEEN 1 AND 10\)/);
  // The one-shot billing claim state machine + frozen settlement facts.
  assert.match(commands, /billing_state text NOT NULL CHECK \(billing_state IN \('pending', 'billed', 'skipped'\)\)/);
  assert.match(commands, /settlement_facts jsonb/);
  assert.match(
    commands,
    /CONSTRAINT saas_video_tasks_billed_at_shape CHECK \(\s*\(billing_state = 'pending' AND billed_at IS NULL\)\s*OR \(billing_state = 'billed' AND billed_at IS NOT NULL\)\s*OR \(billing_state = 'skipped' AND billed_at IS NULL\)/,
  );
  // The 24 h TTL is enforced on read plus the purge sweep.
  assert.match(commands, /expires_at timestamptz NOT NULL/);
  assert.match(commands, /CONSTRAINT saas_video_tasks_expiry_after_creation CHECK \(expires_at > created_at\)/);
  assert.match(commands, /CREATE INDEX saas_video_tasks_owner_idx ON saas_video_tasks \(tenant_id, proxy_key_id\)/);
  assert.match(commands, /CREATE INDEX saas_video_tasks_expiry_idx ON saas_video_tasks \(expires_at\)/);
  assert.match(
    commands,
    /CREATE INDEX saas_video_tasks_pending_idx ON saas_video_tasks \(billing_state, created_at\) WHERE billing_state = 'pending'/,
  );
});
