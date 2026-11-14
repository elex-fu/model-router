// These historical roots consume a successful dual-mode HTTP fixture. Their
// dependency belongs to their own fresh database, never a previous test run.
export const COMMERCIAL_HTTP_ROOT = 'tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts';
const httpConsumers = new Set([
  'tests/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.postgres.integration.test.ts',
  'tests/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.postgres.integration.test.ts',
  'tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts',
  'tests/saas/gateway/pre-dispatch-compensation-postgres.integration.test.ts',
  'tests/saas/gateway/prepared-evidence-concurrent-claim.postgres.integration.test.ts',
  'tests/saas/gateway/dispatch-capacity.postgres.integration.test.ts',
  'tests/saas/console/request-reconciliation-read.postgres.integration.test.ts',
]);

export function postgresFixtureRoots(testRoot) {
  return httpConsumers.has(testRoot) ? [COMMERCIAL_HTTP_ROOT] : [];
}

export function postgresRedisRequired(testRoot) {
  return ['tests/saas/gateway/cached-scheduler-hints.postgres.integration.test.ts',
    'tests/saas/gateway/quota-persistence-lane.postgres.integration.test.ts',
    'tests/saas/gateway/fast/native-http.postgres.integration.test.ts'].includes(testRoot);
}

export function postgresSoftwareKmsRequired(testRoot) {
  return ['tests/saas/supply/account-quarantine.postgres.integration.test.ts',
    'tests/saas/supply/oauth-refresh-onboarding.postgres.integration.test.ts',
    'tests/saas/supply/oauth-token-refresh.postgres.integration.test.ts'].includes(testRoot);
}

export function isManagedPostgresTest(path, source) {
  return /(?:\.|-)postgres.*\.integration\.test\.ts$/.test(path) &&
    /MODEL_ROUTER_SAAS_GATEWAY_E2E|normal-success-postgres-fixture|pre-dispatch-postgres-fixture/.test(source);
}
