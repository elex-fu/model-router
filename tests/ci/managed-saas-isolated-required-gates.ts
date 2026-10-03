import { spawnSync } from 'node:child_process';
import {
  createSaasDatabase,
  verifyCredentialValidationWorkerRuntimePrivileges,
  verifySaasRuntimeDatabasePrivileges,
} from '../../src/saas/db/index.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../../src/saas/db/credential-validation-worker-schema-readiness.js';

// CI-only fixed runner, not a general database/command dispatcher. Every matrix
// item owns its own postgres service. Reuse normal provisioning/CLI/manifests;
// no database reset, bootstrap repair, inline grants or fixture manufacture.
const gates = {
  'cancellation-059': { root: 'tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts', httpFixture: true },
  'pre-dispatch-compensation': { root: 'tests/saas/gateway/pre-dispatch-compensation-postgres.integration.test.ts', httpFixture: true },
  'concurrent-claim': { root: 'tests/saas/gateway/prepared-evidence-concurrent-claim.postgres.integration.test.ts', httpFixture: true },
  'normal-success-terminal-replay': { root: 'tests/saas/metering/normal-success-terminal-replay.postgres.integration.test.ts', httpFixture: false },
  'member-directory': { root: 'tests/saas/identity/tenant-member-directory.postgres.integration.test.ts', httpFixture: false },
  'member-directory-http': { root: 'tests/saas/identity/tenant-member-directory-http.postgres.integration.test.ts', httpFixture: false },
} as const;
const databaseUrls = {
  migrator: 'postgresql://model_router_saas_migrator@postgres:5432/model_router_saas_ci',
  control_plane: 'postgresql://model_router_saas_control_plane@postgres:5432/model_router_saas_ci',
  gateway: 'postgresql://model_router_saas_gateway@postgres:5432/model_router_saas_ci',
  validation_worker: 'postgresql://model_router_saas_validation_worker@postgres:5432/model_router_saas_ci',
} as const;
// Do not inherit PG*, provider/KMS/config URLs, user config or optional-gate
// environment. The only endpoints passed to subprocesses are these literals.
const childEnv = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  NODE_ENV: 'test',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL: databaseUrls.migrator,
  MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL: databaseUrls.control_plane,
  MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL: databaseUrls.gateway,
};
let phase = 'ci_guard';

function run(command: 'bash' | 'node', args: readonly string[]): void {
  const result = spawnSync(command, [...args], { env: childEnv, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    process.exitCode = result.status !== null && result.status > 0 ? result.status : 1;
    throw new Error('required CI subprocess failed');
  }
}

async function runtimeProbes(): Promise<void> {
  for (const family of ['migrator', 'control_plane', 'gateway', 'validation_worker'] as const) {
    const database = createSaasDatabase({ connectionString: databaseUrls[family], max: 1, connectionTimeoutMillis: 5_000 });
    try {
      await database.transaction(async tx => {
        await tx.query('SET TRANSACTION READ ONLY');
        await tx.query("SET LOCAL statement_timeout = '30s'");
        await tx.query("SET LOCAL lock_timeout = '5s'");
        const identity = (await tx.query<{
          principal: string; session: string; database: string; safe_role: boolean; version: number;
        }>(`SELECT current_user AS principal, session_user AS session, current_database() AS database,
          NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS safe_role,
          current_setting('server_version_num')::integer / 10000 AS version
          FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`)).rows[0];
        const expectedRole = `model_router_saas_${family}`;
        if (!identity || identity.principal !== expectedRole || identity.session !== expectedRole ||
          identity.database !== 'model_router_saas_ci' || !identity.safe_role || ![15, 18].includes(identity.version)) {
          throw new Error('restricted CI database identity mismatch');
        }
        if (family === 'control_plane' || family === 'gateway') await verifySaasRuntimeDatabasePrivileges(tx, family);
        if (family === 'validation_worker') {
          await verifyCredentialValidationWorkerSchemaReadiness(tx);
          await verifyCredentialValidationWorkerRuntimePrivileges(tx);
        }
      });
      if (family === 'migrator') {
        await database.verifySchema();
        const virgin = (await database.query<{ virgin: boolean }>(
          'SELECT NOT initialized AS virgin FROM saas_platform_state WHERE singleton = TRUE',
        )).rows;
        if (virgin.length !== 1 || virgin[0]?.virgin !== true) throw new Error('CI fixture database is already consumed');
      }
    } finally { await database.close(); }
  }
}

async function main(): Promise<void> {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.argv.length !== 3 || !Object.hasOwn(gates, process.argv[2]!)) {
    throw new Error('one fixed CI matrix selector in GitHub Actions is required');
  }
  const gate = gates[process.argv[2] as keyof typeof gates];
  phase = 'provision';
  run('bash', ['tests/saas/db/managed-postgres-runtime-privileges.integration.sh']);
  phase = 'runtime_probes';
  await runtimeProbes();
  // Only these three roots need the actual dual-mode successful HTTP fixture.
  // The other three seed independent legitimate rows, never a second bootstrap.
  if (gate.httpFixture) {
    phase = 'http_fixture';
    run('node', ['--import', 'tsx', '--test', 'tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts']);
  }
  phase = 'required_root';
  run('node', ['--import', 'tsx', '--test', gate.root]);
}

void main().catch(error => {
  const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
  const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const sqlStates = new Set(['42501', '55000', '55006', '23502', '23503', '23505', '23514', '42P01', '42703',
    '42883', '42601', '40P01', '40001', '55P03', '57014', '08001', '08006', '28P01', '3D000']);
  const sqlState = typeof code === 'string' && sqlStates.has(code) ? code : null;
  console.error('isolated_required_gate_failure ' + JSON.stringify({ phase, sqlState }));
  process.exitCode ??= 1;
});
