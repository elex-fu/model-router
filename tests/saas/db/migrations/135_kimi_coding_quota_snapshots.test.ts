import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIMI_CODING_QUOTA_SNAPSHOTS_SAAS_MIGRATION as migration } from '../../../../src/saas/db/migrations/135_kimi_coding_quota_snapshots.js';

test('135 adds Kimi account scheduling observations with separate success and attempt freshness', () => {
  assert.equal(migration.version, 135);
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table}`));
    for (const field of [
      '5h_used_percent',
      '5h_reset_at',
      'weekly_used_percent',
      'weekly_reset_at',
      'usage_updated_at',
      'usage_attempted_at',
      'usage_next_due_at',
      'usage_failure_count',
      'rate_limited_until',
    ]) {
      assert.match(migration.sql, new RegExp(`ADD COLUMN kimi_${field} `));
    }
    assert.match(migration.sql, new RegExp(`CREATE INDEX ${table}_kimi_usage_due_idx`));
  }
  assert.match(migration.sql, /zhipu_usage_attempted_at = zhipu_usage_updated_at/);
  assert.match(migration.sql, /zhipu_usage_updated_at = NULL/);
  assert.match(migration.sql, /minimax_usage_updated_at = NULL/);
  assert.doesNotMatch(migration.sql, /quota_remaining_minor_units|wallet|GRANT|REVOKE|access_token|api_key/i);
});
