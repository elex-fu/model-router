import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  DEFAULT_USER_RISK_OBSERVATION_RETENTION_DAYS,
  resolveUserRiskObservationRetentionDays,
  runRiskControlRetentionOnce,
} from '../../../src/saas/risk/retention-worker.js';

class CleanupFake implements Pick<SqlExecutor, 'query'> {
  readonly deletions: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    if (sql.startsWith('DELETE')) this.deletions.push({ sql, values });
    return { rows: [] as Row[], rowCount: 0 };
  }
}

test('observation retention days resolve from env with strict bounds and a safe default', () => {
  assert.equal(DEFAULT_USER_RISK_OBSERVATION_RETENTION_DAYS, 7);
  assert.equal(resolveUserRiskObservationRetentionDays({}), 7);
  assert.equal(
    resolveUserRiskObservationRetentionDays({ MODEL_ROUTER_SAAS_USER_RISK_OBSERVATION_RETENTION_DAYS: undefined }),
    7,
  );
  assert.equal(
    resolveUserRiskObservationRetentionDays({ MODEL_ROUTER_SAAS_USER_RISK_OBSERVATION_RETENTION_DAYS: '30' }),
    30,
  );
  assert.equal(
    resolveUserRiskObservationRetentionDays({ MODEL_ROUTER_SAAS_USER_RISK_OBSERVATION_RETENTION_DAYS: '3650' }),
    3650,
  );
  for (const raw of ['', ' ', '0', '-1', '30.5', '9999', 'thirty', '0x1e']) {
    assert.throws(
      () => resolveUserRiskObservationRetentionDays({ MODEL_ROUTER_SAAS_USER_RISK_OBSERVATION_RETENTION_DAYS: raw }),
      RangeError,
      JSON.stringify(raw),
    );
  }
});

test('one retention sweep deletes observations past the retention cutoff', async () => {
  const executor = new CleanupFake();
  const now = Date.parse('2026-11-03T12:00:00Z');
  await runRiskControlRetentionOnce(executor, () => now, 7);
  const observation = executor.deletions.find(({ sql }) => sql.includes('saas_user_risk_observations'));
  assert.ok(observation);
  assert.match(observation.sql, /DELETE FROM saas_user_risk_observations WHERE occurred_at < \$1/);
  assert.equal(
    observation.values[0],
    new Date(now - 7 * 86_400_000).toISOString(),
    'the cutoff is exactly the retention window before now',
  );
  assert.equal(
    executor.deletions.some(({ sql }) => sql.includes('saas_content_moderation_logs')),
    true,
    'the moderation sweeps ride the same cycle',
  );
});
