import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { INITIAL_SAAS_MIGRATION, SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/035_credential_validation_jobs.js';
import {
  CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS,
  CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
} from '../../../../src/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.js';
import { PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/059_pre_dispatch_terminal_cancellation.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/060_prepared_evidence_claim_generated_account.js';
import {
  AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION,
  REQUEUE_COUNTER_SOURCE, REQUEUE_CYCLE_COLUMNS, REQUEUE_WRITER_SOURCE,
} from '../../../../src/saas/db/migrations/061_audited_credential_validation_requeue.js';
import {
  REQUEUE_CYCLE_READ_COLUMNS, REQUEUE_JOB_READ_COLUMNS, REQUEUE_REQUEST_INSERT_COLUMNS,
  REQUEUE_REQUEST_READ_COLUMNS,
} from '../../../../src/saas/supply/audited-credential-validation-requeue-service.js';

// Source-contract tests only. Actual restricted-role trigger/worker transactions
// are required in the separate current061 PG root; these are NOT SQL execution.
const migration = AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('061 is one isolated forward-only candidate, unregistered at stage1', () => {
  assert.equal(migration.version, 61);
  assert.equal(migration.name, 'audited_credential_validation_requeue');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.equal(SAAS_MIGRATIONS.length, 60, 'normal generated060 is active; audited061 registration remains an explicit later gate');
  assert.deepEqual(SAAS_MIGRATIONS.map(({ version }) => version), Array.from({ length: 60 }, (_, index) => index + 1));
  assert.equal(SAAS_MIGRATIONS.at(-1), PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION);
  assert.ok(!SAAS_MIGRATIONS.includes(migration));
  for (const [file, expected] of [
    ['035_credential_validation_jobs.ts', '5dce54853124a8bae3ff9f4e43ddd4787f1f77ac07e39fdab484279c8ad410d9'],
    ['058_credential_validation_invalidation_trigger_execution.ts', '2763f296f5f591c8ca3e4ef547d9b217f5c17021b15d1619ad184975ec87b8bc'],
    ['059_pre_dispatch_terminal_cancellation.ts', '7c86dc81ea1ddea6b0a46c2bcea4837c9a83e705ae817106e3cbae5ccdb8b5ed'],
    ['060_prepared_evidence_claim_generated_account.ts', '380bf3a1ceb103a0276b281d1e06eff613d1e4341edd6e7c24581f268280ae6c'],
  ] as const) assert.equal(createHash('sha256').update(readFileSync(resolve(process.cwd(), 'src/saas/db/migrations', file))).digest('hex'), expected);
  assert.doesNotMatch(commands, /\b(?:DROP|DISABLE TRIGGER|CREATE OR REPLACE|ALTER FUNCTION|ALTER ROLE|SET ROLE|NOT VALID)\b/i);
  assert.doesNotMatch(commands, /\b(?:ADD|CREATE)\s+(?:(?:COLUMN|CONSTRAINT|TABLE|INDEX)\s+)?IF\s+NOT\s+EXISTS\b/i);
  assert.doesNotMatch(commands, /(?:^|\n)\s*(?:EXECUTE\s+['"])?GRANT\b/i);
});

test('061 preserves original bodies, exact owner/security/attachments and the frozen managed catalog', () => {
  for (const { source } of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS) {
    assert.ok(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql.includes(source));
    assert.ok(sql.includes(source));
  }
  const marker = 'CREATE FUNCTION saas_reject_immutable_change() RETURNS trigger\nLANGUAGE plpgsql AS $$';
  const start = INITIAL_SAAS_MIGRATION.sql.indexOf(marker);
  const immutable = INITIAL_SAAS_MIGRATION.sql.slice(start + marker.length, INITIAL_SAAS_MIGRATION.sql.indexOf('\n$$;', start) + 1);
  assert.ok(start >= 0 && sql.includes(immutable));
  for (const name of ['function', 'acl', 'column', 'constraint', 'trigger', 'index']) {
    assert.ok(sql.includes(`${name}_after IS DISTINCT FROM ${name}_before`));
  }
  assert.match(sql, /routine\.prosrc IS DISTINCT FROM expected\.source/);
  assert.match(sql, /routine\.prosecdef IS DISTINCT FROM expected\.definer/);
  assert.match(sql, /routine\.proowner IS DISTINCT FROM trusted_owner/);
  assert.match(sql, /t\.tgtype=binding\.type AND t\.tgenabled='O'/);
  assert.match(sql, /t\.tgargs=pg_catalog\.decode\('','hex'\)/);
  assert.match(sql, /attnum>0 AND NOT attisdropped\) <> 22/);
  assert.match(sql, /conrelid=jobs_table\) <> 18/);
  assert.match(sql, /column_after[\s\S]*?NOT \(attrelid=jobs_table AND attnum>22\)/);
  assert.match(sql, /session_user IS DISTINCT FROM current_user/);
  assert.match(sql, /current_setting\('server_version_num'\)::integer < 150000/);
  assert.match(sql, /count\(\*\) FROM model_router_saas\.saas_schema_migrations\) <> 60/);
  assert.match(sql, /min\(version\) FROM model_router_saas\.saas_schema_migrations\) <> 1/);
  assert.match(sql, /max\(version\) FROM model_router_saas\.saas_schema_migrations\) <> 60/);
  for (const dependency of [CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION,
    CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
    PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION, PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION]) {
    const digest = createHash('sha256').update(dependency.name).update('\0').update(dependency.sql).digest('hex');
    const tuple = [String(dependency.version), `'${dependency.name}'`, `'${digest}'`]
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.match(sql, new RegExp(`\\(\\s*${tuple.join('\\s*,\\s*')}\\s*\\)`),
      'normal prerequisite tuples must bind canonical name-NUL-SQL checksums');
  }
});

test('legacy cycle metadata stays NULL; original cumulative history is never reset or backfilled', () => {
  assert.deepEqual(REQUEUE_CYCLE_COLUMNS, REQUEUE_JOB_READ_COLUMNS);
  for (const [name, type] of [['current_cycle_id', 'uuid'], ['cycle_start_attempt_count', 'integer'], ['cycle_attempt_limit', 'smallint']]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${name} ${type}[,\\n]`));
    assert.doesNotMatch(sql, new RegExp(`ADD COLUMN ${name} ${type} (?:NOT NULL|DEFAULT)`));
  }
  assert.match(sql, /cycle_start_attempt_count=prior_attempt_count/);
  assert.match(sql, /attempt_count BETWEEN cycle_start_attempt_count AND cycle_start_attempt_count\+cycle_attempt_limit/);
  assert.match(sql, /current_cycle_id IS NULL AND cycle_start_attempt_count IS NULL AND cycle_attempt_limit IS NULL/);
  assert.match(sql, /attnotnull OR atthasdef OR attacl IS NOT NULL/);
  assert.doesNotMatch(REQUEUE_WRITER_SOURCE, /(?:\bSET|,)\s*attempt_count\s*=/i);
  assert.match(REQUEUE_WRITER_SOURCE, /AND attempt_count=job_row\.attempt_count/);
  assert.match(REQUEUE_COUNTER_SOURCE, /NEW\.attempt_count IS DISTINCT FROM OLD\.attempt_count/);
  assert.match(REQUEUE_COUNTER_SOURCE, /NEW\.attempt_count-NEW\.cycle_start_attempt_count < NEW\.cycle_attempt_limit/);
  assert.match(REQUEUE_COUNTER_SOURCE, /NEW\.last_error_code='attempt_limit'/);
  assert.match(REQUEUE_COUNTER_SOURCE, /ELSIF NEW\.current_cycle_id IS NOT NULL THEN/);
});

test('trusted trigger opens exactly one durable request/cycle/audit in the original queue transaction', () => {
  assert.match(sql, /CREATE TABLE model_router_saas\.saas_credential_validation_requeue_requests/);
  assert.match(sql, /CREATE TABLE model_router_saas\.saas_credential_validation_cycles/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /UNIQUE\(tenant_id,idempotency_key\), UNIQUE\(tenant_id,request_id\)/);
  assert.match(sql, /UNIQUE\(tenant_id,job_id,prior_lease_generation\)/);
  assert.match(sql, /reason ~ '\^\[ -~\]\{1,512\}\$' AND reason=btrim\(reason\)/);
  assert.match(sql, /CREATE TRIGGER saas_validation_(?:requeue_requests|cycles)_immutable BEFORE UPDATE OR DELETE/g);
  assert.match(sql, /CREATE TRIGGER saas_validation_(?:requeue_requests|cycles)_no_truncate BEFORE TRUNCATE/g);
  assert.ok(REQUEUE_WRITER_SOURCE.indexOf('INSERT INTO model_router_saas.saas_audit_events') <
    REQUEUE_WRITER_SOURCE.indexOf('INSERT INTO model_router_saas.saas_credential_validation_cycles'));
  assert.ok(REQUEUE_WRITER_SOURCE.indexOf('INSERT INTO model_router_saas.saas_credential_validation_cycles') <
    REQUEUE_WRITER_SOURCE.indexOf('UPDATE model_router_saas.saas_tenant_provider_credential_validation_jobs'));
  assert.match(REQUEUE_WRITER_SOURCE, /GET DIAGNOSTICS changed = ROW_COUNT/);
  assert.match(REQUEUE_WRITER_SOURCE, /IF changed <> 1 THEN RAISE EXCEPTION/);
  assert.match(REQUEUE_COUNTER_SOURCE, /pg_trigger_depth\(\) <> 2/);
  assert.match(REQUEUE_COUNTER_SOURCE, /c\.prior_snapshot IS NOT DISTINCT FROM pg_catalog\.to_jsonb\(OLD\)/);
  assert.match(REQUEUE_WRITER_SOURCE, /NEW\.audit_event_id IS NOT NULL OR NEW\.target_evidence_sha256 IS NOT NULL/);
});

test('fences precede row locks in exact tenant/account/credential/version order; late DB-time rechecks persist', () => {
  const fence = ['pg_advisory_xact_lock_shared(1396788563, 46)', "'saas-authz:tenant:'", 'NEW.actor_user_id::text, 0',
    "'saas-authz:tenant-provider-account:'", "'saas-authz:tenant-provider-credential:'", "'saas-authz:credential-version:tenant:'"];
  const positions = fence.map((part) => REQUEUE_WRITER_SOURCE.indexOf(part));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)));
  assert.ok(positions.at(-1)! < REQUEUE_WRITER_SOURCE.indexOf('FOR UPDATE'));
  assert.ok(REQUEUE_WRITER_SOURCE.indexOf('INTO account_row') < REQUEUE_WRITER_SOURCE.indexOf('INTO credential_row'));
  assert.ok(REQUEUE_WRITER_SOURCE.indexOf('FOR SHARE;') < REQUEUE_WRITER_SOURCE.indexOf('INTO job_row'));
  assert.match(REQUEUE_WRITER_SOURCE, /current_setting\('transaction_isolation'\) IS DISTINCT FROM 'read committed'/);
  assert.equal(REQUEUE_WRITER_SOURCE.split('checked_time := pg_catalog.clock_timestamp();').length - 1, 2);
  assert.match(REQUEUE_WRITER_SOURCE, /credential_row\.expires_at <= checked_time/);
  assert.match(REQUEUE_WRITER_SOURCE, /version_row\.expires_at <= checked_time/);
  assert.match(REQUEUE_WRITER_SOURCE, /s\.expires_at > checked_time/);
  assert.match(REQUEUE_WRITER_SOURCE, /r\.expires_at > checked_time/);
  assert.match(REQUEUE_WRITER_SOURCE, /job_row\.status NOT IN \('failed', 'cancelled'\) OR job_row\.lease_until IS NOT NULL/);
  assert.match(REQUEUE_WRITER_SOURCE, /account_row\.status NOT IN \('pending', 'active'\)/);
  assert.match(REQUEUE_WRITER_SOURCE, /credential_row\.authz_version IS DISTINCT FROM NEW\.expected_credential_authz_version/);
});

test('all application routine EXECUTE/job UPDATE stay denied; only one new trigger definer exists', () => {
  assert.equal((commands.match(/LANGUAGE plpgsql SECURITY DEFINER/g) ?? []).length, 1);
  assert.equal((commands.match(/LANGUAGE plpgsql SECURITY INVOKER/g) ?? []).length, 1);
  assert.match(sql, /SET search_path TO pg_catalog,model_router_saas,pg_temp/g);
  assert.equal((commands.match(/REVOKE ALL ON FUNCTION/g) ?? []).length, 4);
  assert.match(sql, /pg_catalog\.has_function_privilege\(r\.oid,p\.oid,'EXECUTE'\)/);
  assert.match(sql, /pg_catalog\.has_any_column_privilege\(r\.oid,jobs_table,'UPDATE'\)/);
  assert.match(REQUEUE_WRITER_SOURCE, /session_user IS DISTINCT FROM 'model_router_saas_control_plane'/);
  assert.match(REQUEUE_WRITER_SOURCE, /current_user IS DISTINCT FROM 'model_router_saas_migrator'/);
  const calls = [...REQUEUE_WRITER_SOURCE.matchAll(/(?:PERFORM|SELECT)\s+(?:model_router_saas\.)?(saas_[a-z_]+)\s*\(/g)];
  assert.deepEqual(calls, [], 'no nested schema helper EXECUTE escape');
  for (const column of ['audit_event_id', 'target_evidence_sha256', 'result_lease_generation', 'cycle_start_attempt_count', 'cycle_attempt_limit', 'recorded_at']) {
    assert.ok(!REQUEUE_REQUEST_INSERT_COLUMNS.some((allowed) => allowed === column));
    assert.ok(REQUEUE_REQUEST_READ_COLUMNS.some((allowed) => allowed === column));
  }
  for (const forbidden of ['ciphertext', 'wrapped_dek', 'kms_key_id', 'auth_tag', 'nonce']) {
    assert.ok(![...REQUEUE_REQUEST_INSERT_COLUMNS, ...REQUEUE_REQUEST_READ_COLUMNS, ...REQUEUE_CYCLE_READ_COLUMNS].some((column) => column === forbidden));
  }
});

test('snapshot and request digests bind actual frozen facts using compact JSON, not caller-chosen algorithms', () => {
  assert.match(REQUEUE_WRITER_SOURCE, /'model-router-credential-validation-job-v1'::text/);
  assert.match(REQUEUE_WRITER_SOURCE, /'model-router-credential-validation-requeue-v1'::text/);
  assert.match(REQUEUE_WRITER_SOURCE, /pg_catalog\.to_json\(job_row\.allowed_models\)::text/);
  assert.match(REQUEUE_WRITER_SOURCE, /YYYY-MM-DD"T"HH24:MI:SS.MS"Z"/);
  assert.match(REQUEUE_WRITER_SOURCE, /command_digest IS DISTINCT FROM NEW\.request_digest/);
  assert.match(REQUEUE_WRITER_SOURCE, /snapshot_digest IS DISTINCT FROM NEW\.snapshot_sha256/);
  assert.match(REQUEUE_WRITER_SOURCE, /capability_evidence_sha256,credential_row\.authz_version/);
  assert.doesNotMatch(REQUEUE_WRITER_SOURCE, /UPDATE model_router_saas\.saas_(?:provider_capabilities|provider_rights|tenant_provider_accounts|tenant_provider_credentials|tenant_provider_credential_versions)\b/);
});
