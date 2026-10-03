import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATEWAY_METERING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/010_gateway_metering.js';
import {
  PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION,
  PRE_DISPATCH_TERMINAL_CHECK_SQL,
  PRE_DISPATCH_ATTEMPT_GUARD_EXPECTED_SOURCE,
  PRE_DISPATCH_ATTEMPT_GUARD_SOURCE,
} from '../../../../src/saas/db/migrations/059_pre_dispatch_terminal_cancellation.js';

test('059 has a stable forward migration export; central DB owner owns registry integration', () => {
  const migration = PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION;
  assert.equal(migration.version, 59); assert.equal(migration.name, 'pre_dispatch_terminal_cancellation');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.match(migration.sql, /DO \$pre_dispatch_cancellation\$/);
  assert.match(migration.sql, /LOCK TABLE model_router_saas\.saas_attempts IN ACCESS EXCLUSIVE MODE/);
  assert.doesNotMatch(migration.sql, /\b(?:GRANT|REVOKE|TRUNCATE|DISABLE TRIGGER|ALTER ROLE|SECURITY DEFINER)\b/);
  assert.doesNotMatch(migration.sql, /(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:model_router_saas\.)?saas_/);
});

test('059 requires the exact existing guard, trigger binding, owner and validated CHECK before DDL', () => {
  const sql = PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION.sql;
  assert.ok(GATEWAY_METERING_SAAS_MIGRATION.sql.includes(PRE_DISPATCH_ATTEMPT_GUARD_EXPECTED_SOURCE));
  assert.ok(sql.includes(PRE_DISPATCH_ATTEMPT_GUARD_EXPECTED_SOURCE));
  assert.match(sql, /routine\.prosrc IS DISTINCT FROM \$historical_guard\$/);
  assert.match(sql, /routine\.proowner <> owner_id OR routine\.prosecdef OR routine\.proconfig IS NOT NULL/);
  assert.match(sql, /tgname = 'saas_attempts_guard_update'.*tgfoid = guard_id AND tgtype = 19/);
  assert.match(sql, /tgenabled = 'O'.*tgqual IS NULL AND tgattr::text = ''/);
  assert.match(sql, /conname = 'saas_attempts_status_consistency' AND contype = 'c' AND convalidated/);
  assert.match(sql, /pg_catalog\.pg_get_expr\(conbin, conrelid\) =/);
  assert.ok(sql.indexOf('IF check_id IS NULL') < sql.indexOf('DROP CONSTRAINT'));
  assert.match(sql, /acl_after IS DISTINCT FROM acl_before/);
});

test('059 permits only false-response not_sent failed and preserves the dispatched branch', () => {
  assert.match(PRE_DISPATCH_TERMINAL_CHECK_SQL, /dispatch_state = 'not_sent' AND result_state = 'pending' AND response_started = false/);
  assert.match(PRE_DISPATCH_TERMINAL_CHECK_SQL, /dispatch_state = 'not_sent' AND result_state = 'failed' AND response_started = false/);
  assert.match(PRE_DISPATCH_TERMINAL_CHECK_SQL, /response_started_at IS NULL AND result_http_status IS NULL AND unknown_reason IS NULL/);
  assert.match(PRE_DISPATCH_TERMINAL_CHECK_SQL, /OR dispatch_state <> 'not_sent'$/);
  assert.match(PRE_DISPATCH_ATTEMPT_GUARD_SOURCE, /OLD\.dispatch_state = 'not_sent' AND OLD\.result_state = 'failed'/);
  assert.match(PRE_DISPATCH_ATTEMPT_GUARD_SOURCE, /A cancelled pre-dispatch attempt is terminal/);
  assert.match(PRE_DISPATCH_ATTEMPT_GUARD_SOURCE, /OLD\.dispatch_state = 'not_sent' AND OLD\.result_state IN \('pending', 'failed'\)/);
  for (const preserved of [
    'SaaS attempt observations are immutable', 'Invalid SaaS attempt dispatch transition', 'Invalid SaaS attempt result transition',
    'SaaS attempt response_started is monotonic', 'SaaS attempt response_started_at is immutable',
    'SaaS attempt result status is immutable once observed', 'Unknown SaaS attempt states require a reason',
    'SaaS attempt state updates require a monotonic version and timestamp',
  ]) assert.ok(PRE_DISPATCH_ATTEMPT_GUARD_SOURCE.includes(preserved));
  assert.match(PRE_DISPATCH_ATTEMPT_GUARD_SOURCE, /NEW\.state_version <> OLD\.state_version \+ 1/);
});
