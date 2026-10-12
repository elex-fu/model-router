import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CUSTOMER_PASSKEY_CEREMONIES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/085_customer_passkey_ceremonies.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = CUSTOMER_PASSKEY_CEREMONIES_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('085 registers after 084 with the documented 061/062 and retired 064-079 gaps', () => {
  assert.equal(migration.version, 85);
  assert.equal(migration.name, 'customer_passkey_ceremonies');
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
  assert.equal(SAAS_MIGRATIONS[66], migration);
});

test('085 adds the passkey-only sign counter, kind-bound like 007 last_used_step', () => {
  assert.match(commands, /ALTER TABLE saas_mfa_credentials\s+ADD COLUMN sign_count bigint,/);
  assert.match(
    commands,
    /CONSTRAINT saas_mfa_credentials_sign_count_nonnegative\s+CHECK \(sign_count IS NULL OR sign_count >= 0\)/,
  );
  // The counter may only exist on passkey rows; TOTP replay state stays
  // last_used_step and the 001 kind_data CHECK keeps the shapes disjoint.
  assert.match(
    commands,
    /CONSTRAINT saas_mfa_credentials_sign_count_passkey_only\s+CHECK \(kind = 'passkey' OR sign_count IS NULL\)/,
  );
  assert.doesNotMatch(commands, /ADD COLUMN sign_count bigint NOT NULL/);
});

test('085 ceremony ledger is single-challenge, session-bound, attempt-capped and closed-once', () => {
  assert.match(commands, /CREATE TABLE saas_customer_passkey_ceremonies \(/);
  assert.match(commands, /ceremony text NOT NULL CHECK \(ceremony IN \('registration', 'assertion'\)\)/);
  assert.match(commands, /challenge_hash text NOT NULL UNIQUE\s+CHECK \(challenge_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(commands, /user_id uuid NOT NULL REFERENCES saas_users\(id\) ON DELETE RESTRICT/);
  assert.match(commands, /session_id uuid NOT NULL REFERENCES saas_sessions\(id\) ON DELETE RESTRICT/);
  assert.match(commands, /attempt_count integer NOT NULL DEFAULT 0\s+CHECK \(attempt_count BETWEEN 0 AND 5\)/);
  assert.match(commands, /expires_at > created_at AND expires_at <= created_at \+ interval '5 minutes'/);
  assert.match(commands, /consumed_at IS NULL OR closed_at IS NOT NULL/);
  // One open ceremony per (user, ceremony); predecessors must close first.
  assert.match(
    commands,
    /CREATE UNIQUE INDEX saas_customer_passkey_one_open_ceremony\s+ON saas_customer_passkey_ceremonies \(user_id, ceremony\) WHERE closed_at IS NULL/,
  );
});

test('085 guard family mirrors the customer-MFA draft fences with a distinct advisory class', () => {
  for (const fn of [
    'saas_customer_passkey_ceremony_guard',
    'saas_customer_passkey_writer',
    'saas_customer_passkey_user_fence',
  ]) {
    assert.match(commands, new RegExp(`CREATE FUNCTION model_router_saas\\.${fn}\\(\\) RETURNS trigger`));
  }
  // No SECURITY DEFINER anywhere; invoker-security with a pinned search_path.
  assert.doesNotMatch(commands, /SECURITY DEFINER/i);
  assert.match(commands, /pg_advisory_xact_lock\(1396788563,85\)/);
  assert.doesNotMatch(commands, /pg_advisory_xact_lock\(1396788563,46\)/);
  assert.match(commands, /hashtextextended\(NEW\.user_id::text,0\)/);
  // Assertion ceremonies bind to an active verified passkey of the same user;
  // platform-role users and dead sessions/users are rejected at INSERT.
  assert.match(commands, /c\.kind='passkey' AND c\.credential_id=NEW\.credential_id/);
  assert.match(commands, /saas_platform_role_assignments p WHERE p\.user_id=NEW\.user_id/);
  assert.match(commands, /s\.revoked_at IS NULL AND s\.expires_at>clock_timestamp\(\)/);
  // Registration credentials arrive only at finish, never at INSERT.
  assert.match(commands, /NEW\.ceremony='registration' AND NEW\.credential_id IS NOT NULL/);
  assert.match(
    commands,
    /OLD\.ceremony='registration' AND OLD\.credential_id IS NULL AND NEW\.consumed_at IS NOT NULL/,
  );
  for (const trigger of [
    'saas_customer_passkey_ceremony_guard',
    'saas_customer_passkey_ceremonies_writer',
    'saas_customer_passkey_ceremonies_user',
  ]) {
    assert.match(commands, new RegExp(`CREATE TRIGGER ${trigger}`));
  }
});

test('085 changes no ACL, epoch, existing trigger, or lifecycle shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION model_router_saas\.(?!saas_customer_passkey)/i);
});
