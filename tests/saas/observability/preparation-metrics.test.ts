import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from 'prom-client';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import {
  observePreparationExecutor,
  type PostgresPreparationObservation,
} from '../../../src/saas/gateway/postgres-preparation-observer.js';
import { renderSaasMetrics } from '../../../src/saas/observability/metrics.js';
import {
  createPostgresPreparationMetricsObserver,
  recordPostgresPreparationObservation,
  SAAS_GATEWAY_PREPARATION_QUERY_DURATION_SECONDS,
  SAAS_GATEWAY_PREPARATION_STAGE_DURATION_SECONDS,
} from '../../../src/saas/observability/preparation-metrics.js';

test('preparation metrics register once and convert millisecond observations to seconds', async () => {
  const registry = new Registry();
  const observe = createPostgresPreparationMetricsObserver(registry);
  assert.equal(observe, createPostgresPreparationMetricsObserver(registry));
  observe({ kind: 'phase', phase: 'authority', operation: 'resolve', durationMs: 25.5, outcome: 'ok' });
  observe({
    kind: 'query',
    phase: 'admission-guard',
    operation: 'postgres-request-admission:authority-batch',
    durationMs: 4,
    outcome: 'error',
  });
  const text = await registry.metrics();
  assert.match(
    text,
    /saas_gateway_preparation_stage_duration_seconds_sum\{phase="authority",operation="resolve",outcome="ok"\} 0\.0255/,
  );
  assert.match(
    text,
    /saas_gateway_preparation_query_duration_seconds_sum\{phase="admission-guard",operation="postgres-request-admission:authority-batch",outcome="error"\} 0\.004/,
  );
  assert.equal(registry.getMetricsAsArray().length, 2);
});

test('unknown query identities collapse to one bounded label and never expose SQL or values', async () => {
  const registry = new Registry();
  const observe = createPostgresPreparationMetricsObserver(registry);
  for (let index = 0; index < 1000; index += 1) {
    observe({
      kind: 'query',
      phase: 'admission',
      operation: `SELECT private_tenant_${index}`,
      durationMs: 1,
      outcome: 'ok',
    });
  }
  const text = await registry.metrics();
  assert.match(
    text,
    /saas_gateway_preparation_query_duration_seconds_count\{phase="admission",operation="other",outcome="ok"\} 1000/,
  );
  assert.doesNotMatch(text, /private_tenant|SELECT/);
  assert.equal(
    text.split('\n').filter((line) => line.startsWith(`${SAAS_GATEWAY_PREPARATION_QUERY_DURATION_SECONDS}_count`))
      .length,
    1,
  );
});

test('orchestration stages use four fixed labels for success and failure', async () => {
  const registry = new Registry();
  const observe = createPostgresPreparationMetricsObserver(registry);
  for (const operation of ['scheduler-select', 'affinity-bind', 'evidence-register', 'preparation-total']) {
    for (const outcome of ['ok', 'error'] as const) {
      observe({ kind: 'phase', phase: 'preparation', operation, durationMs: 10, outcome });
    }
  }
  for (let index = 0; index < 1000; index += 1) {
    observe({
      kind: 'phase',
      phase: 'preparation',
      operation: `private-request-${index}`,
      durationMs: 1,
      outcome: 'error',
    });
  }
  const text = await registry.metrics();
  for (const operation of ['scheduler-select', 'affinity-bind', 'evidence-register', 'preparation-total']) {
    for (const outcome of ['ok', 'error']) {
      assert.ok(text.includes(`_count{phase="preparation",operation="${operation}",outcome="${outcome}"} 1`));
    }
  }
  assert.match(text, /_count\{phase="preparation",operation="other",outcome="error"\} 1000/);
  assert.equal(
    text.split('\n').filter((line) => line.startsWith(`${SAAS_GATEWAY_PREPARATION_STAGE_DURATION_SECONDS}_count`))
      .length,
    9,
  );
  assert.doesNotMatch(text, /private-request|requestId|key|body/);
});

test('dispatchable commercial view retains its fixed query label', async () => {
  const registry = new Registry();
  const observe = createPostgresPreparationMetricsObserver(registry);
  const executor: SqlExecutor = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
  await observePreparationExecutor(executor, 'authority', observe).query(
    'SELECT tenant_id FROM saas_route_config_dispatchable WHERE route_id = $1',
    ['private-route'],
  );
  const text = await registry.metrics();
  assert.match(text, /_count\{phase="authority",operation="saas_route_config_dispatchable",outcome="ok"\} 1/);
  assert.doesNotMatch(text, /private-route|operation="other"/);
});

test('invalid observations do not create series or invalid numeric samples', async () => {
  const registry = new Registry();
  const observe = createPostgresPreparationMetricsObserver(registry);
  const base = { kind: 'query', phase: 'admission', operation: 'select', durationMs: 1, outcome: 'ok' } as const;
  for (const invalid of [
    { durationMs: Number.NaN },
    { durationMs: Number.POSITIVE_INFINITY },
    { durationMs: -1 },
    { phase: 'private-tenant' },
    { outcome: 'private-status' },
    { kind: 'private-kind' },
  ])
    observe({ ...base, ...invalid } as PostgresPreparationObservation);
  const text = await registry.metrics();
  assert.doesNotMatch(text, /_count\{/);
  assert.doesNotMatch(text, /private-|NaN|Infinity/);
});

test('nested preparation hooks count each SQL round trip once at its innermost phase', async () => {
  const registry = new Registry();
  const observe = createPostgresPreparationMetricsObserver(registry);
  let queries = 0;
  const executor: SqlExecutor = {
    async query() {
      queries += 1;
      return { rows: [], rowCount: 0 };
    },
  };
  const admission = observePreparationExecutor(executor, 'admission', observe);
  const guard = observePreparationExecutor(admission, 'admission-guard', observe);
  await guard.query('SELECT pg_advisory_xact_lock($1::bigint)', ['private-key']);
  await admission.query('SELECT * FROM saas_wallets WHERE id = $1', ['private-wallet']);
  assert.equal(queries, 2);
  const text = await registry.metrics();
  assert.match(text, /_count\{phase="admission-guard",operation="advisory-lock-exclusive-int8",outcome="ok"\} 1/);
  assert.match(text, /_count\{phase="admission",operation="saas_wallets",outcome="ok"\} 1/);
  assert.equal(
    text.split('\n').filter((line) => line.startsWith(`${SAAS_GATEWAY_PREPARATION_QUERY_DURATION_SECONDS}_count`))
      .length,
    2,
  );
  assert.doesNotMatch(text, /private-key|private-wallet/);
});

test('the shared recorder is exposed by the existing SaaS metrics render surface', async () => {
  recordPostgresPreparationObservation({
    kind: 'phase',
    phase: 'admission',
    operation: 'capacity',
    durationMs: 10,
    outcome: 'ok',
  });
  const text = await renderSaasMetrics();
  assert.match(text, new RegExp(`# HELP ${SAAS_GATEWAY_PREPARATION_STAGE_DURATION_SECONDS} `));
  assert.match(text, /_count\{phase="admission",operation="capacity",outcome="ok"\} 1/);
});
