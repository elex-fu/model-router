import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS,
  DEFAULT_SAAS_DATABASE_POOL_MAX,
  SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV,
  SAAS_DATABASE_POOL_MAX_ENV,
  SAAS_DATABASE_PREPARED_STATEMENTS_ENV,
} from '../../src/saas/db/database.js';
import {
  DEPLOYMENT_ENV_VARS,
  type DeploymentEnvironment,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  parseDeploymentConfig,
} from '../../src/saas/deployment.js';
import { type ManagedSaasDatabase, startManagedSaasServer } from '../../src/server/managed-saas.js';

function gatewayEnvironment(mode: string): DeploymentEnvironment {
  return {
    NODE_ENV: 'test',
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'gateway',
    [DEPLOYMENT_ENV_VARS.saas.gatewayDatabaseUrl]: 'postgresql://router@127.0.0.1:1/unused',
    [DEPLOYMENT_ENV_VARS.saas.gatewayProviderCredentialDecryptKmsModule]: 'unit-unused-gateway-kms',
    [DEPLOYMENT_ENV_VARS.saas.gatewayRuntimeModule]: 'unit-unused-gateway-runtime',
    [DEPLOYMENT_ENV_VARS.saas.deploymentId]: 'database-environment-unit',
    [DEPLOYMENT_ENV_VARS.saas.environmentId]: 'test',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.port]: '15007',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: 'http://127.0.0.1:15007',
    [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: mode,
  };
}

function workerEnvironment(mode: string): DeploymentEnvironment {
  return {
    NODE_ENV: 'test',
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'credential-validation-worker',
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl]: 'postgresql://router@127.0.0.1:1/unused',
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]: 'unit-unused-worker-kms',
    [DEPLOYMENT_ENV_VARS.saas.deploymentId]: 'database-environment-unit',
    [DEPLOYMENT_ENV_VARS.saas.environmentId]: 'test',
    [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: mode,
  };
}

test('the standard database factory receives the supplied runtime environment before any SQL or listener', async (t) => {
  for (const makeEnvironment of [gatewayEnvironment, workerEnvironment]) {
    for (const mode of ['off', 'native', 'invalid']) {
      await t.test(`${makeEnvironment.name}: ${mode}`, async () => {
        const environment = makeEnvironment(mode);
        const deployment = parseDeploymentConfig(environment);
        assert.equal(deployment.mode, 'managed-saas');
        if (deployment.mode !== 'managed-saas') assert.fail('managed deployment required');
        let pingCalls = 0;
        let preparedAvailable: boolean | undefined;
        await assert.rejects(
          startManagedSaasServer(deployment, {
            environment,
            async pingDatabase(database) {
              pingCalls += 1;
              preparedAvailable = typeof database.queryPrepared === 'function';
              // Stop before SQL, module loading, listeners or provider construction.
              throw new Error('unit stop before PostgreSQL ping');
            },
            createListener() {
              assert.fail('the database gate must precede every listener');
            },
          }),
          mode === 'invalid'
            ? /must be off or native/
            : /Managed SaaS (?:credential-validation worker )?PostgreSQL ping failed/,
        );
        assert.equal(pingCalls, mode === 'invalid' ? 0 : 1);
        assert.equal(preparedAvailable, mode === 'invalid' ? undefined : mode === 'native');
      });
    }
  }
});

test('an injected managed database factory keeps its connectionString-only call shape', async () => {
  const environment = gatewayEnvironment('native');
  const deployment = parseDeploymentConfig(environment);
  if (deployment.mode !== 'managed-saas') assert.fail('managed deployment required');
  const calls: unknown[] = [];
  let closed = false;
  const database: ManagedSaasDatabase = {
    async query() {
      assert.fail('no SQL is authorized by this unit fixture');
    },
    async transaction() {
      assert.fail('no SQL is authorized by this unit fixture');
    },
    async migrate() {
      assert.fail('no migrations are authorized by this unit fixture');
    },
    async verifySchema() {
      assert.fail('no schema reads are authorized by this unit fixture');
    },
    async ping() {
      assert.fail('the supplied ping port stops startup');
    },
    async close() {
      closed = true;
    },
  };
  await assert.rejects(
    startManagedSaasServer(deployment, {
      environment,
      createDatabase(input) {
        calls.push(input);
        return database;
      },
      async pingDatabase(actual) {
        assert.equal(actual, database);
        throw new Error('unit stop before PostgreSQL ping');
      },
    }),
    /Managed SaaS PostgreSQL ping failed/,
  );
  assert.deepEqual(calls, [{ connectionString: deployment.postgresUrl }]);
  assert.equal(closed, true);
});

test('gateway deployment examples forward database pool controls with the runtime defaults', () => {
  const compose = readFileSync(new URL('../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8');
  const gateway = compose.split('\n  gateway:\n')[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.ok(gateway, 'the standard Compose gateway service must exist');
  const systemdEnvironment = readFileSync(
    new URL('../../deploy/systemd/managed-saas/gateway.env.example', import.meta.url),
    'utf8',
  );
  for (const [name, defaultValue] of [
    [SAAS_DATABASE_POOL_MAX_ENV, DEFAULT_SAAS_DATABASE_POOL_MAX],
    [SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV, DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS],
  ] as const) {
    assert.ok(
      gateway.includes('      ' + name + ': ${' + name + ':-' + defaultValue + '}'),
      `${name} must reach every gateway replica with the runtime default`,
    );
    assert.ok(
      systemdEnvironment.includes('# ' + name + '=' + defaultValue),
      `${name} must have a commented systemd example with the runtime default`,
    );
  }
});

test('gateway deployment examples keep the optional HTTP handler cap disabled by default', () => {
  const compose = readFileSync(new URL('../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8');
  const gateway = compose.split('\n  gateway:\n')[1]?.split(/\n[ ]{2}[a-z][a-z0-9-]*:\n/)[0];
  assert.ok(gateway, 'the standard Compose gateway service must exist');
  assert.ok(
    gateway.includes(
      '      MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: ${MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT:-}',
    ),
    'the optional HTTP handler cap must be forwarded with an empty default',
  );
  const systemdEnvironment = readFileSync(
    new URL('../../deploy/systemd/managed-saas/gateway.env.example', import.meta.url),
    'utf8',
  );
  assert.ok(systemdEnvironment.includes('# MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT=8'));
});
