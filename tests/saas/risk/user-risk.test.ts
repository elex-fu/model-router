import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresUserAnomalyDetector, PostgresUserRiskObservationRecorder } from '../../../src/saas/risk/user-risk.js';

class RiskFake implements Pick<SqlExecutor, 'query'> {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  inserted: Array<Record<string, unknown>> = [];
  readonly counts = new Map<string, string>();
  readonly audits: Array<Record<string, unknown>> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push({ sql, values });
    let rows: Record<string, unknown>[] = [];
    let rowCount = rows.length;
    if (sql.includes('WITH recent AS')) {
      rows = this.inserted;
    } else if (sql.includes('SELECT count(*)::text AS count FROM saas_user_anomaly_detections')) {
      rows = [{ count: this.counts.get(String(values[0])) ?? '0' }];
    } else if (sql.includes('INSERT INTO saas_audit_events')) {
      this.audits.push({
        tenant_id: values[1],
        actor_user_id: values[2],
        action: values[2],
        target_type: values[3],
        target_id: values[4],
      });
    } else if (sql.includes('INSERT INTO saas_user_risk_markers')) {
      rows = [];
    } else if (sql.includes('UPDATE saas_api_keys')) {
      rows = sql.includes('WHERE id = $2')
        ? [{ id: values[1], tenant_id: 'tenant-1' }]
        : [
            { id: 'key-1', tenant_id: 'tenant-1' },
            { id: 'key-2', tenant_id: 'tenant-2' },
          ];
    } else if (sql.includes('UPDATE saas_users')) {
      rows = [{ id: values[0] }];
    } else if (sql.includes('UPDATE saas_sessions') || sql.includes('UPDATE saas_platform_sessions')) {
      rowCount = 1;
    }
    return { rows: rows as Row[], rowCount: rows.length > 0 ? rows.length : rowCount };
  }

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function detection(userId: string, apiKeyId: string): Record<string, unknown> {
  return {
    id: 1,
    user_id: userId,
    tenant_id: 'tenant-1',
    api_key_id: apiKeyId,
    kind: 'rapid_address_switching',
  };
}

test('observation capture stores only stable deployment-keyed address digests', async () => {
  const executor = new RiskFake();
  const recorder = new PostgresUserRiskObservationRecorder(new Uint8Array(32).fill(7));
  const input = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    apiKeyId: 'key-1',
    publicModel: 'model-a',
    protocol: 'anthropic',
  };
  await recorder.record(executor, {
    ...input,
    clientAddress: { status: 'resolved', address: '192.0.2.10', source: 'socket-peer' },
  });
  await recorder.record(executor, {
    ...input,
    clientAddress: { status: 'resolved', address: '192.0.2.11', source: 'socket-peer' },
  });
  await recorder.record(executor, {
    ...input,
    clientAddress: { status: 'unresolved', reason: 'malformed-forwarded-address' },
  });
  const digests = executor.statements.map(({ values }) => values[3]);
  assert.match(String(digests[0]), /^[0-9a-f]{64}$/);
  assert.match(String(digests[1]), /^[0-9a-f]{64}$/);
  assert.notEqual(digests[0], digests[1]);
  assert.equal(digests[2], null);
  assert.doesNotMatch(JSON.stringify(executor.statements), /192\.0\.2/);
});

test('batch detection audits evidence and escalates rate limit, key suspension, then account suspension', async () => {
  const executor = new RiskFake();
  executor.inserted = [detection('user-rate', 'key-rate')];
  executor.counts.set('user-rate', '1');
  const detector = new PostgresUserAnomalyDetector(executor, {
    now: () => new Date('2026-11-02T00:05:00.000Z'),
    rateLimitedRequestsPerMinute: 3n,
  });
  assert.deepEqual(await detector.runBatch(), {
    detected: 1,
    rateLimited: 1,
    keysSuspended: 0,
    accountsSuspended: 0,
  });
  assert.ok(executor.statements.some(({ values }) => values.includes('rate_limited') && values.includes('3')));
  assert.deepEqual(
    executor.audits.map((event) => event.action),
    ['user_anomaly.detected', 'user_risk.rate_limited'],
  );

  const second = new RiskFake();
  second.inserted = [detection('user-key', 'key-abuse')];
  second.counts.set('user-key', '2');
  assert.deepEqual(await new PostgresUserAnomalyDetector(second).runBatch(), {
    detected: 1,
    rateLimited: 0,
    keysSuspended: 1,
    accountsSuspended: 0,
  });
  assert.ok(second.statements.some(({ values }) => values.includes('key_suspended')));
  assert.deepEqual(
    second.audits.map((event) => event.action),
    ['user_anomaly.detected', 'api_key.revoked'],
  );

  const third = new RiskFake();
  third.inserted = [detection('user-account', 'key-abuse')];
  third.counts.set('user-account', '3');
  assert.deepEqual(await new PostgresUserAnomalyDetector(third).runBatch(), {
    detected: 1,
    rateLimited: 0,
    keysSuspended: 0,
    accountsSuspended: 1,
  });
  assert.equal(
    third.statements.filter(({ sql }) => sql.includes('UPDATE saas_api_keys')).length,
    1,
    'account suspension revokes every active member key',
  );
  assert.ok(third.statements.some(({ sql }) => sql.includes('UPDATE saas_sessions SET revoked_at')));
  assert.deepEqual(
    third.audits.map((event) => event.action),
    ['user_anomaly.detected', 'api_key.revoked', 'api_key.revoked', 'platform_user.disabled'],
  );
});

test('detection insertion is idempotent and abrupt-pattern SQL compares a preceding baseline', async () => {
  const executor = new RiskFake();
  const result = await new PostgresUserAnomalyDetector(executor).runBatch();
  assert.deepEqual(result, { detected: 0, rateLimited: 0, keysSuspended: 0, accountsSuspended: 0 });
  const batch = executor.statements[0];
  assert.ok(batch);
  assert.match(batch.sql, /ON CONFLICT \(api_key_id, kind, window_start\) DO NOTHING/);
  assert.match(batch.sql, /r\.calls >= 2 \* b\.calls/);
  assert.match(batch.sql, /r\.models > b\.models OR r\.protocols > b\.protocols/);
  assert.equal(executor.audits.length, 0);
});

test('detection window_start is bucket-aligned, never the raw batch run time', async () => {
  // The UNIQUE (api_key_id, kind, window_start) conflict key is the idempotency
  // boundary: consecutive scheduled runs inside one observation window must
  // collide, or each run would re-insert the same anomaly and walk the
  // lifetime-count escalation ladder (rate_limited -> key -> account) on its
  // own. window_start therefore derives from a fixed epoch bucket of the
  // window size, not from $1 (the batch "now").
  const executor = new RiskFake();
  await new PostgresUserAnomalyDetector(executor, { windowSeconds: 300 }).runBatch();
  const batch = executor.statements[0];
  assert.ok(batch);
  const insert = batch.sql.slice(batch.sql.indexOf('INSERT INTO saas_user_anomaly_detections'));
  assert.match(insert, /to_timestamp\(floor\(extract\(epoch FROM \$1::timestamptz\) \/ \$2\) \* \$2\)/);
  assert.doesNotMatch(
    insert,
    /window_start[^\n]*\$1::timestamptz,/,
    'window_start must not be the raw batch timestamp',
  );
});
