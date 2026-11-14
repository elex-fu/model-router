import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMERCIAL_HTTP_ROOT, isManagedPostgresTest, postgresFixtureRoots, postgresRedisRequired } from '../../scripts/ci/postgres-test-plan.mjs';

test('historical cancellation dependencies are explicit and scoped to their fresh database', () => {
  assert.deepEqual(postgresFixtureRoots('tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts'), [COMMERCIAL_HTTP_ROOT]);
  assert.deepEqual(postgresFixtureRoots('tests/saas/gateway/dispatch-capacity.postgres.integration.test.ts'), [COMMERCIAL_HTTP_ROOT]);
  assert.deepEqual(postgresFixtureRoots('tests/saas/db/migrations/122_multimodal_billing_dimensions.postgres.integration.test.ts'), []);
  assert.deepEqual(postgresFixtureRoots(COMMERCIAL_HTTP_ROOT), []);
  assert.deepEqual(postgresFixtureRoots('tests/saas/risk/content-moderation.postgres.integration.test.ts'), []);
  assert.deepEqual(postgresFixtureRoots('tests/saas/console/request-reconciliation-read.postgres.integration.test.ts'), [COMMERCIAL_HTTP_ROOT]);
});

test('only declared Redis consumers receive the runner-owned disposable Redis', () => {
  for (const root of ['cached-scheduler-hints', 'quota-persistence-lane']) {
    assert.equal(postgresRedisRequired(`tests/saas/gateway/${root}.postgres.integration.test.ts`), true);
  }
  assert.equal(postgresRedisRequired('tests/saas/gateway/fast/native-http.postgres.integration.test.ts'), true);
  assert.equal(postgresRedisRequired('tests/saas/risk/content-moderation.postgres.integration.test.ts'), false);
});

test('only managed disposable PostgreSQL integration roots enter the isolated runner', () => {
  for (const suffix of ['.postgres.integration.test.ts', '-postgres.integration.test.ts', 'managed-postgres-financial.integration.test.ts']) {
    assert.equal(isManagedPostgresTest(`tests/saas/example${suffix}`, 'normal-success-postgres-fixture'), true);
  }
  assert.equal(isManagedPostgresTest('tests/saas/local.postgres.integration.test.ts', 'unrelated schema'), false);
  assert.equal(isManagedPostgresTest('tests/integration/kimi-live.test.ts', 'MODEL_ROUTER_SAAS_GATEWAY_E2E'), false);
});
