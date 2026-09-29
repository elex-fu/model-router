import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import {
  type PlatformOperationsSummary,
  PlatformOperationsSummaryError,
  PlatformOperationsSummaryService,
} from '../../../../src/saas/platform/operations/index.js';

type Row = Record<string, unknown>;

function result<RowType>(rows: RowType[]): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

function aggregateRow(): Row {
  return {
    request_count: '900719925474099312345',
    request_pending_count: '1',
    request_succeeded_count: '900719925474099312340',
    request_failed_count: '3',
    request_unknown_count: '1',
    request_financial_not_applicable_count: '1',
    request_financial_pending_count: '2',
    request_financial_settled_count: '900719925474099312338',
    request_financial_released_count: '3',
    request_financial_reconciliation_pending_count: '1',
    attempt_count: '900719925474099312350',
    attempt_pending_count: '2',
    attempt_succeeded_count: '900719925474099312340',
    attempt_failed_count: '7',
    attempt_unknown_count: '1',
    attempt_http_4xx_count: '5',
    attempt_http_5xx_count: '2',
    response_start_latency_sample_count: '2',
    response_start_latency_p50_ms: '12',
    response_start_latency_p95_ms: '109',
    active_provider_account_lease_count: '900719925474099312349',
    billing_reservation_reserved_count: '3',
    billing_reservation_reconciliation_pending_count: '4',
    account_health_observation_count: '4',
    account_health_healthy_count: '2',
    account_health_degraded_count: '1',
    account_health_cooldown_count: '1',
    account_health_unhealthy_count: '0',
    account_health_active_cooldown_count: '1',
    account_health_latest_observed_at: '2026-10-01 15:59:00+00',
    webhook_pending_count: '2',
    webhook_processing_count: '1',
    webhook_oldest_unprocessed_age_ms: '9000',
    snapshot_at: '2026-10-01 16:00:00+00',
  };
}

class FakeExecutor implements SqlExecutor {
  readonly calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  row: Row = aggregateRow();
  error: Error | null = null;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.calls.push({ sql, values });
    if (this.error) throw this.error;
    return result<RowType>([this.row as RowType]);
  }
}

function isOperationsError(code: PlatformOperationsSummaryError['code']) {
  return (error: unknown): boolean => error instanceof PlatformOperationsSummaryError && error.code === code;
}

test('returns exact aggregate counts and a safe projection', async () => {
  const executor = new FakeExecutor();
  const service = new PlatformOperationsSummaryService(executor);

  const summary = await service.getSummary({
    from: '2026-09-01T00:00:00+08:00',
    to: '2026-10-02T00:00:00+08:00',
  });

  const expected: PlatformOperationsSummary = {
    from: '2026-08-31T16:00:00.000Z',
    to: '2026-10-01T16:00:00.000Z',
    requests: {
      total: '900719925474099312345',
      byStatus: {
        pending: '1',
        succeeded: '900719925474099312340',
        failed: '3',
        unknown: '1',
      },
    },
    attempts: {
      total: '900719925474099312350',
      byStatus: {
        pending: '2',
        succeeded: '900719925474099312340',
        failed: '7',
        unknown: '1',
      },
    },
    activeProviderAccountLeaseCount: '900719925474099312349',
    metrics: {
      dataSource: 'postgresql_persisted_aggregates',
      snapshotAt: '2026-10-01T16:00:00.000Z',
      requests: {
        successPercent: '100.00',
        unknownPercent: '0.00',
        financialStatus: {
          notApplicable: '1',
          pending: '2',
          settled: '900719925474099312338',
          released: '3',
          reconciliationPending: '1',
        },
      },
      attempts: {
        successPercent: '100.00',
        unknownPercent: '0.00',
        responseHttp4xxCount: '5',
        responseHttp5xxCount: '2',
        responseStartLatencyMs: { sampleCount: '2', p50: '12', p95: '109' },
      },
      billingReservationBacklog: { reserved: '3', reconciliationPending: '4' },
      platformAccountHealth: {
        observationCount: '4',
        byState: { healthy: '2', degraded: '1', cooldown: '1', unhealthy: '0' },
        activeCooldownCount: '1',
        latestObservedAt: '2026-10-01T15:59:00.000Z',
      },
      paymentWebhookBacklog: { pending: '2', processing: '1', oldestUnprocessedAgeMs: '9000' },
      runtimeProbes: {
        postgresql: 'not_configured',
        redis: 'not_configured',
        kms: 'not_configured',
        worker: 'not_configured',
      },
    },
  };

  assert.deepEqual(summary, expected);
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0]?.values, [expected.from, expected.to]);
  assert.match(executor.calls[0]?.sql ?? '', /COUNT\(\*\)::text/);
  assert.match(executor.calls[0]?.sql ?? '', /saas_requests/);
  assert.match(executor.calls[0]?.sql ?? '', /saas_attempts/);
  assert.match(executor.calls[0]?.sql ?? '', /saas_provider_account_leases/);
  assert.match(executor.calls[0]?.sql ?? '', /saas_billing_reservations/);
  assert.match(executor.calls[0]?.sql ?? '', /saas_provider_account_runtime_health/);
  assert.match(executor.calls[0]?.sql ?? '', /saas_payment_inbox/);
  assert.match(executor.calls[0]?.sql ?? '', /PERCENTILE_DISC\(0\.50\)/);
  assert.match(executor.calls[0]?.sql ?? '', /PERCENTILE_DISC\(0\.95\)/);
  assert.doesNotMatch(
    executor.calls[0]?.sql ?? '',
    /\b(tenant_id|user_id|prompt|response_body|response_text|credential|price|cost|provider_id|account_id|upstream_id)\b/i,
  );
  assert.deepEqual(Object.keys(summary), [
    'from',
    'to',
    'requests',
    'attempts',
    'activeProviderAccountLeaseCount',
    'metrics',
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /tenant-id|request-id|credential|payment-id|secret/i);
});

test('calculates rates with exact decimal arithmetic beyond JavaScript safe integers', async () => {
  const executor = new FakeExecutor();
  executor.row = {
    ...aggregateRow(),
    request_count: '900719925474099312345',
    request_pending_count: '0',
    request_succeeded_count: '600479950316066208230',
    request_failed_count: '0',
    request_unknown_count: '300239975158033104115',
    request_financial_not_applicable_count: '0',
    request_financial_pending_count: '0',
    request_financial_settled_count: '900719925474099312345',
    request_financial_released_count: '0',
    request_financial_reconciliation_pending_count: '0',
  };

  const summary = await new PlatformOperationsSummaryService(executor).getSummary({
    from: '2026-09-01',
    to: '2026-09-02',
  });

  assert.equal(summary.metrics.requests.successPercent, '66.67');
  assert.equal(summary.metrics.requests.unknownPercent, '33.33');
});

test('represents absent persisted platform account observations as zero observations, never as healthy', async () => {
  const executor = new FakeExecutor();
  executor.row = {
    ...aggregateRow(),
    account_health_observation_count: '0',
    account_health_healthy_count: '0',
    account_health_degraded_count: '0',
    account_health_cooldown_count: '0',
    account_health_unhealthy_count: '0',
    account_health_active_cooldown_count: '0',
    account_health_latest_observed_at: null,
  };

  const summary = await new PlatformOperationsSummaryService(executor).getSummary({
    from: '2026-09-01',
    to: '2026-09-02',
  });

  assert.equal(summary.metrics.platformAccountHealth.observationCount, '0');
  assert.deepEqual(summary.metrics.platformAccountHealth.byState, {
    healthy: '0',
    degraded: '0',
    cooldown: '0',
    unhealthy: '0',
  });
  assert.equal(summary.metrics.platformAccountHealth.latestObservedAt, null);
  assert.equal(summary.metrics.runtimeProbes.postgresql, 'not_configured');
  assert.equal(summary.metrics.runtimeProbes.redis, 'not_configured');
  assert.equal(summary.metrics.runtimeProbes.kms, 'not_configured');
  assert.equal(summary.metrics.runtimeProbes.worker, 'not_configured');
});

test('rejects malformed, reversed, and overlong ranges before querying', async () => {
  const executor = new FakeExecutor();
  const service = new PlatformOperationsSummaryService(executor);

  for (const input of [
    { from: 'not-an-iso-date', to: '2026-09-02T00:00:00Z' },
    { from: '2026-02-30T00:00:00Z', to: '2026-03-01T00:00:00Z' },
    { from: '2026-09-02T00:00:00Z', to: '2026-09-02T00:00:00Z' },
    { from: '2026-09-03T00:00:00Z', to: '2026-09-02T00:00:00Z' },
    { from: '2026-01-01T00:00:00Z', to: '2026-02-02T00:00:00Z' },
  ]) {
    await assert.rejects(service.getSummary(input), isOperationsError('OPERATIONS_INVALID_INPUT'));
  }

  assert.equal(executor.calls.length, 0);
});

test('wraps executor failures and malformed aggregate rows in a safe domain error', async () => {
  const executor = new FakeExecutor();
  const service = new PlatformOperationsSummaryService(executor);
  executor.error = new Error('password=top-secret database failure');

  await assert.rejects(service.getSummary({ from: '2026-09-01', to: '2026-09-02' }), (error: unknown) => {
    assert.ok(error instanceof PlatformOperationsSummaryError);
    assert.equal(error.code, 'OPERATIONS_STORAGE_ERROR');
    assert.equal(error.status, 500);
    assert.equal(error.message, 'The operations summary could not be completed.');
    assert.doesNotMatch(error.message, /top-secret|password/i);
    return true;
  });

  executor.error = null;
  executor.row = { ...aggregateRow(), attempt_failed_count: 'not-a-count' };
  await assert.rejects(
    service.getSummary({ from: '2026-09-01', to: '2026-09-02' }),
    isOperationsError('OPERATIONS_STORAGE_ERROR'),
  );

  executor.row = { ...aggregateRow(), request_count: Number.MAX_SAFE_INTEGER + 1 };
  await assert.rejects(
    service.getSummary({ from: '2026-09-01', to: '2026-09-02' }),
    isOperationsError('OPERATIONS_STORAGE_ERROR'),
  );
});
