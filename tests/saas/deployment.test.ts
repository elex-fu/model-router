import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEPLOYMENT_ENV_VARS,
  DeploymentConfigError,
  type DeploymentEnvironment,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
  MODEL_ROUTER_SAAS_DATABASE_URL,
  MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
  MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  managedSaasListenerNames,
  parseDeploymentConfig,
  SAAS_DEPLOYMENT_ENV_NAMES,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../../src/saas/deployment.js';

function managedEnvironment(
  overrides: Partial<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
    [MODEL_ROUTER_SAAS_DATABASE_URL]: 'postgresql://saas-user:db-secret@db.example/saas',
    [MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL]: 'postgresql://control-plane:secret@db.example/control-plane',
    [MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL]: 'postgresql://gateway:secret@db.example/gateway',
    [MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL]:
      'postgresql://validation-worker:secret@db.example/validation-worker',
    [MODEL_ROUTER_SAAS_REDIS_URL]: 'rediss://redis-user:redis-secret@redis.example:6380/0',
    [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: '@example/trusted-redis-provider',
    [MODEL_ROUTER_SAAS_KMS_PROVIDER]: '@example/trusted-credential-provider',
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: '@example/trusted-provider-seal-kms',
    [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: 'kms/model-router/provider-supply',
    [MODEL_ROUTER_SAAS_DEPLOYMENT_ID]: 'model-router-test-deployment',
    [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: 'test',
    [DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.customer.port]: '3101',
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: 'http://127.0.0.1:4101',
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: '3102',
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: 'http://127.0.0.1:4102',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.port]: '3103',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: 'http://127.0.0.1:4103',
    ...overrides,
  };
}

function validationWorkerEnvironment(
  overrides: Partial<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return managedEnvironment({
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'credential-validation-worker',
    [MODEL_ROUTER_SAAS_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: undefined,
    [MODEL_ROUTER_SAAS_KMS_PROVIDER]: undefined,
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: undefined,
    [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]:
      '@example/trusted-validation-worker-kms',
    [DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: undefined,
    ...overrides,
  });
}

function gatewayEnvironment(
  overrides: Partial<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return managedEnvironment({
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'gateway',
    [MODEL_ROUTER_SAAS_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: undefined,
    [MODEL_ROUTER_SAAS_KMS_PROVIDER]: undefined,
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: undefined,
    [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]: undefined,
    [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: '@example/trusted-gateway-kms',
    [MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE]: '@example/trusted-gateway-runtime',
    [DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: undefined,
    ...overrides,
  });
}

function assertDeploymentError(
  action: () => unknown,
  code: DeploymentConfigError['code'],
  expectedText?: RegExp,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DeploymentConfigError);
    assert.equal(error.code, code);
    if (expectedText) assert.match(error.message, expectedText);
    return true;
  });
}

test('defaults to immutable local mode only when no SaaS settings are present', () => {
  const environment = Object.freeze({});
  const config = parseDeploymentConfig(environment);

  assert.deepEqual(config, { mode: 'local' });
  assert.equal(Object.isFrozen(config), true);
});

test('mode matrix keeps local and managed-saas mutually exclusive', () => {
  const cases: Array<{
    name: string;
    environment: DeploymentEnvironment;
    result?: 'local' | 'managed-saas';
    error?: DeploymentConfigError['code'];
  }> = [
    { name: 'implicit local', environment: {}, result: 'local' },
    { name: 'explicit local', environment: { [MODEL_ROUTER_DEPLOYMENT_MODE]: 'local' }, result: 'local' },
    {
      name: 'SaaS setting without mode',
      environment: { [MODEL_ROUTER_SAAS_REDIS_URL]: 'redis://redis.example' },
      error: 'SAAS_SETTINGS_REQUIRE_MANAGED_MODE',
    },
    {
      name: 'provider credential KMS setting without mode',
      environment: { [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: 'kms/provider-supply' },
      error: 'SAAS_SETTINGS_REQUIRE_MANAGED_MODE',
    },
    {
      name: 'gateway decrypt-only KMS setting without mode',
      environment: { [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: '@example/trusted-gateway-kms' },
      error: 'SAAS_SETTINGS_REQUIRE_MANAGED_MODE',
    },
    {
      name: 'explicit local with SaaS setting',
      environment: {
        [MODEL_ROUTER_DEPLOYMENT_MODE]: 'local',
        [MODEL_ROUTER_SAAS_DATABASE_URL]: 'postgresql://db.example/saas',
      },
      error: 'LOCAL_MODE_HAS_SAAS_SETTINGS',
    },
    { name: 'explicit managed SaaS', environment: managedEnvironment(), result: 'managed-saas' },
    {
      name: 'unknown mode',
      environment: { [MODEL_ROUTER_DEPLOYMENT_MODE]: 'production' },
      error: 'INVALID_MODE',
    },
  ];

  for (const scenario of cases) {
    if (scenario.error) {
      assertDeploymentError(() => parseDeploymentConfig(scenario.environment), scenario.error);
    } else {
      assert.equal(parseDeploymentConfig(scenario.environment).mode, scenario.result, scenario.name);
    }
  }
});

test('managed SaaS reports all missing declarations without exposing values', () => {
  assertDeploymentError(
    () => parseDeploymentConfig({ [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas' }),
    'MISSING_REQUIRED_SETTING',
    /MODEL_ROUTER_SAAS_DATABASE_URL.*MODEL_ROUTER_SAAS_REDIS_URL.*MODEL_ROUTER_SAAS_REDIS_PROVIDER.*MODEL_ROUTER_SAAS_KMS_PROVIDER/s,
  );
});

test('managed SaaS retains declarations but does not load databases, Redis, or providers', () => {
  const config = parseDeploymentConfig(managedEnvironment());

  assert.equal(config.mode, 'managed-saas');
  if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.equal(config.workloadRole, 'combined');
  assert.equal(config.postgresUrl, 'postgresql://saas-user:db-secret@db.example/saas');
  assert.equal(config.redisUrl, 'rediss://redis-user:redis-secret@redis.example:6380/0');
  assert.equal(config.redisProviderModule, '@example/trusted-redis-provider');
  assert.equal(config.credentialProviderModule, '@example/trusted-credential-provider');
  assert.equal(config.deploymentId, 'model-router-test-deployment');
  assert.equal(config.environmentId, 'test');
  assert.equal(config.providerCredentialKmsKeyId, 'kms/model-router/provider-supply');
  assert.notEqual(config.redisProviderModule, config.credentialProviderModule);
  assert.deepEqual(config.listeners.customer, {
    bindAddress: '127.0.0.1',
    port: 3101,
    origin: 'http://127.0.0.1:4101',
    routePrefix: '/console',
  });
  assert.deepEqual(config.listeners.platform, {
    bindAddress: '127.0.0.1',
    port: 3102,
    origin: 'http://127.0.0.1:4102',
    routePrefix: '/admin',
  });
  assert.deepEqual(config.listeners.gateway, {
    bindAddress: '127.0.0.1',
    port: 3103,
    origin: 'http://127.0.0.1:4103',
    routePrefix: '/v1',
  });
});

test('validation-worker deployment requires only its isolated database, KMS and context', () => {
  const environment = managedEnvironment({
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'credential-validation-worker',
    [MODEL_ROUTER_SAAS_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: undefined,
    [MODEL_ROUTER_SAAS_KMS_PROVIDER]: undefined,
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: undefined,
    [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]:
      '@example/trusted-validation-worker-kms',
  });
  const config = parseDeploymentConfig(environment);
  assert.equal(config.mode, 'managed-saas');
  if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.equal(config.workloadRole, 'credential-validation-worker');
  assert.equal(config.redisUrl, undefined);
  assert.equal(config.redisProviderModule, undefined);
  assert.equal(config.credentialProviderModule, undefined);
  assert.equal(config.validationWorkerProviderCredentialDecryptKmsModule, '@example/trusted-validation-worker-kms');
  assert.equal(config.deploymentId, 'model-router-test-deployment');
  assert.equal(config.environmentId, 'test');
  assert.deepEqual(config.listeners, {});

  assertDeploymentError(
    () =>
      parseDeploymentConfig({
        ...environment,
        [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]: undefined,
      }),
    'MISSING_REQUIRED_SETTING',
    /SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE/,
  );
  assertDeploymentError(
    () => parseDeploymentConfig({ ...environment, [MODEL_ROUTER_SAAS_REDIS_URL]: 'redis://redis.example' }),
    'UNEXPECTED_WORKLOAD_SETTING',
    /MODEL_ROUTER_SAAS_REDIS_URL/,
  );
  assertDeploymentError(
    () =>
      parseDeploymentConfig({
        ...environment,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: '@example/trusted-gateway-kms',
      }),
    'UNEXPECTED_WORKLOAD_SETTING',
    new RegExp(SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE),
  );
  assertDeploymentError(
    () =>
      parseDeploymentConfig(
        managedEnvironment({
          [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]:
            '@example/trusted-validation-worker-kms',
        }),
      ),
    'UNEXPECTED_WORKLOAD_SETTING',
    /SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE/,
  );
  assertDeploymentError(
    () => parseDeploymentConfig({ ...environment, [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: undefined }),
    'MISSING_REQUIRED_SETTING',
    new RegExp(MODEL_ROUTER_SAAS_ENVIRONMENT_ID),
  );
});

test('worker metadata module is an optional immutable standard deployment declaration, not a default target source', () => {
  assert.equal(DEPLOYMENT_ENV_VARS.saas.credentialValidationTargetsModule,
    MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE);
  assert.ok(SAAS_DEPLOYMENT_ENV_NAMES.includes(MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE));
  const missing = parseDeploymentConfig(validationWorkerEnvironment());
  assert.equal(missing.mode, 'managed-saas');
  if (missing.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.equal(Object.hasOwn(missing, 'credentialValidationTargetsModule'), false);
  for (const specifier of ['@operator/reviewed-targets', './reviewed-targets.mjs', 'file:///operator/reviewed-targets.mjs']) {
    const environment = Object.freeze(validationWorkerEnvironment({
      [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: specifier,
    }));
    const config = parseDeploymentConfig(environment);
    assert.equal(config.mode, 'managed-saas');
    if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
    assert.equal(config.credentialValidationTargetsModule, specifier);
    assert.equal(Object.isFrozen(config), true);
    assert.deepEqual(config.listeners, {});
  }
});

test('metadata module declarations fail closed in local mode and every non-worker workload', () => {
  const name = MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE;
  const specifier = 'operator-target-module-value-must-not-be-public';
  assertDeploymentError(() => parseDeploymentConfig({ [name]: specifier }), 'SAAS_SETTINGS_REQUIRE_MANAGED_MODE');
  assertDeploymentError(() => parseDeploymentConfig({
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'local', [name]: specifier,
  }), 'LOCAL_MODE_HAS_SAAS_SETTINGS');
  const nonWorkers = [
    managedEnvironment(),
    managedEnvironment({ [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'combined' }),
    managedEnvironment({ [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane' }),
    gatewayEnvironment(),
  ];
  for (const environment of nonWorkers) {
    assert.throws(() => parseDeploymentConfig({ ...environment, [name]: specifier }), (error: unknown) => {
      assert.ok(error instanceof DeploymentConfigError);
      assert.equal(error.code, 'UNEXPECTED_WORKLOAD_SETTING');
      assert.equal(error.variableName, name);
      assert.equal(error.message.includes(specifier), false);
      return true;
    });
  }
});

test('explicit empty or mistyped worker metadata setting is rejected without echoing its value', () => {
  const name = MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE;
  for (const value of ['', ' ', ' private-target-module-secret ', null, 1]) {
    assert.throws(() => parseDeploymentConfig(validationWorkerEnvironment({ [name]: value as never })), (error: unknown) => {
      assert.ok(error instanceof DeploymentConfigError);
      assert.equal(error.code, 'INVALID_PROVIDER_MODULE');
      assert.equal(error.variableName, name);
      assert.equal(error.message.includes('private-target-module-secret'), false);
      return true;
    });
  }
});

test('metadata declaration uses own data without invoking getters or leaking configuration proxy failures', () => {
  const name = MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE;
  const diagnostic = 'private-deployment-metadata-secret https://private-deployment-target.example.test/module.mjs';
  let getterReads = 0;
  const accessor = Object.defineProperty(validationWorkerEnvironment(), name, {
    get() { getterReads += 1; throw new Error(diagnostic); },
  });
  assertDeploymentError(() => parseDeploymentConfig(accessor), 'INVALID_PROVIDER_MODULE', new RegExp(name));
  assert.equal(getterReads, 0);
  const ownData = validationWorkerEnvironment({ [name]: '@operator/reviewed-targets' });
  const guarded = new Proxy(ownData, {
    get(value, key, receiver) {
      if (key === name) { getterReads += 1; throw new Error(diagnostic); }
      return Reflect.get(value, key, receiver);
    },
  });
  const config = parseDeploymentConfig(guarded);
  assert.equal(config.mode, 'managed-saas');
  if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.equal(config.credentialValidationTargetsModule, '@operator/reviewed-targets');
  assert.equal(getterReads, 0);
  const failedDescriptor = new Proxy(ownData, {
    getOwnPropertyDescriptor(value, key) {
      if (key === name) throw Object.assign(new Error(diagnostic), { cause: diagnostic });
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
  assert.throws(() => parseDeploymentConfig(failedDescriptor), (error: unknown) => {
    assert.ok(error instanceof DeploymentConfigError);
    assert.equal(error.code, 'INVALID_PROVIDER_MODULE');
    assert.equal(error.message.includes('private-deployment'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});

test('production gateway requires its isolated database, listener, context, runtime module, and decrypt-only KMS module', () => {
  assert.equal(
    DEPLOYMENT_ENV_VARS.saas.gatewayProviderCredentialDecryptKmsModule,
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  );
  const valid = gatewayEnvironment({ NODE_ENV: 'production' });
  const config = parseDeploymentConfig(valid);
  assert.equal(config.mode, 'managed-saas');
  if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.equal(config.workloadRole, 'gateway');
  assert.equal(config.postgresUrl, 'postgresql://gateway:secret@db.example/gateway');
  assert.equal(config.gatewayProviderCredentialDecryptKmsModule, '@example/trusted-gateway-kms');
  assert.equal(config.gatewayRuntimeModule, '@example/trusted-gateway-runtime');
  assert.equal(config.redisUrl, undefined);
  assert.equal(config.redisProviderModule, undefined);
  assert.equal(config.credentialProviderModule, undefined);
  assert.equal(config.validationWorkerProviderCredentialDecryptKmsModule, undefined);
  assert.equal(config.deploymentId, 'model-router-test-deployment');
  assert.equal(config.environmentId, 'test');
  assert.deepEqual(Object.keys(config.listeners), ['gateway']);

  const requiredSettings = [
    MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
    DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress,
    DEPLOYMENT_ENV_VARS.listeners.gateway.port,
    DEPLOYMENT_ENV_VARS.listeners.gateway.origin,
    MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
    MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
  ];
  for (const name of requiredSettings) {
    assertDeploymentError(
      () => parseDeploymentConfig(gatewayEnvironment({ NODE_ENV: 'production', [name]: undefined })),
      'MISSING_REQUIRED_SETTING',
      new RegExp(name),
    );
  }

  for (const name of [MODEL_ROUTER_SAAS_DEPLOYMENT_ID, MODEL_ROUTER_SAAS_ENVIRONMENT_ID]) {
    assertDeploymentError(
      () => parseDeploymentConfig(gatewayEnvironment({ [name]: undefined })),
      'MISSING_REQUIRED_SETTING',
      new RegExp(name),
    );
  }
});

test('gateway rejects control-plane and other-role-only settings', () => {
  const controlPlaneOnlySettings = [
    MODEL_ROUTER_SAAS_DATABASE_URL,
    MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
    MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
    MODEL_ROUTER_SAAS_REDIS_URL,
    MODEL_ROUTER_SAAS_REDIS_PROVIDER,
    MODEL_ROUTER_SAAS_KMS_PROVIDER,
    SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
    MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
    DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule,
    DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress,
    DEPLOYMENT_ENV_VARS.listeners.customer.port,
    DEPLOYMENT_ENV_VARS.listeners.customer.origin,
    DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress,
    DEPLOYMENT_ENV_VARS.listeners.platform.port,
    DEPLOYMENT_ENV_VARS.listeners.platform.origin,
  ];

  for (const name of controlPlaneOnlySettings) {
    assertDeploymentError(
      () => parseDeploymentConfig(gatewayEnvironment({ [name]: 'unexpected-setting' })),
      'UNEXPECTED_WORKLOAD_SETTING',
      new RegExp(name),
    );
  }

  assertDeploymentError(
    () =>
      parseDeploymentConfig(
        managedEnvironment({
          [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
          [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: '@example/trusted-gateway-kms',
        }),
      ),
    'UNEXPECTED_WORKLOAD_SETTING',
    new RegExp(SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE),
  );
  assertDeploymentError(
    () =>
      parseDeploymentConfig(
        managedEnvironment({
          [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
          [MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE]: '@example/trusted-gateway-runtime',
        }),
      ),
    'UNEXPECTED_WORKLOAD_SETTING',
    new RegExp(MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE),
  );
});

test('binds provider credential sealing to explicit deployment and environment identities', () => {
  assert.equal(DEPLOYMENT_ENV_VARS.saas.providerCredentialSealingKmsModule, SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE);
  assert.equal(DEPLOYMENT_ENV_VARS.saas.providerCredentialKmsKeyId, MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID);

  assertDeploymentError(
    () => parseDeploymentConfig(managedEnvironment({ [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: undefined })),
    'MISSING_REQUIRED_SETTING',
    new RegExp(MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID),
  );
  assertDeploymentError(
    () => parseDeploymentConfig(managedEnvironment({ [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: 'not a valid label' })),
    'INVALID_CREDENTIAL_CONTEXT',
    new RegExp(MODEL_ROUTER_SAAS_ENVIRONMENT_ID),
  );

  const missingProductionSeal = managedEnvironment({
    NODE_ENV: 'production',
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: undefined,
    [MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]: undefined,
  });
  assertDeploymentError(
    () => parseDeploymentConfig(missingProductionSeal),
    'MISSING_REQUIRED_SETTING',
    new RegExp(SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE),
  );
  assertDeploymentError(
    () =>
      parseDeploymentConfig(
        managedEnvironment({
          NODE_ENV: 'production',
          [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
          [MODEL_ROUTER_SAAS_DEPLOYMENT_ID]: undefined,
        }),
      ),
    'MISSING_REQUIRED_SETTING',
    new RegExp(MODEL_ROUTER_SAAS_DEPLOYMENT_ID),
  );
});

test('requires an explicit isolated workload role in production and rejects combined mode', () => {
  assert.equal(DEPLOYMENT_ENV_VARS.saas.workloadRole, MODEL_ROUTER_SAAS_WORKLOAD_ROLE);
  assertDeploymentError(
    () => parseDeploymentConfig({ ...managedEnvironment(), NODE_ENV: 'production' }),
    'MISSING_REQUIRED_SETTING',
    /MODEL_ROUTER_SAAS_WORKLOAD_ROLE/,
  );
  assertDeploymentError(
    () =>
      parseDeploymentConfig({
        ...managedEnvironment(),
        NODE_ENV: 'production',
        [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'combined',
      }),
    'INVALID_WORKLOAD_ROLE',
    /MODEL_ROUTER_SAAS_WORKLOAD_ROLE/,
  );
});

test('returns the exact listener names for every managed SaaS workload role', () => {
  assert.deepEqual(managedSaasListenerNames('combined'), ['customer', 'platform', 'gateway']);
  assert.deepEqual(managedSaasListenerNames('control-plane'), ['customer', 'platform']);
  assert.deepEqual(managedSaasListenerNames('gateway'), ['gateway']);
  assert.deepEqual(managedSaasListenerNames('credential-validation-worker'), []);
});

test('selects the matching role-specific PostgreSQL URL for separated production roles', () => {
  const cases = [
    {
      role: 'control-plane' as const,
      variable: MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
      url: 'postgresql://control-plane:production-secret@db.example/control-plane',
    },
    {
      role: 'gateway' as const,
      variable: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
      url: 'postgresql://gateway:production-secret@db.example/gateway',
    },
    {
      role: 'credential-validation-worker' as const,
      variable: MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
      url: 'postgresql://validation-worker:production-secret@db.example/validation-worker',
    },
  ];

  for (const scenario of cases) {
    const overrides = {
      NODE_ENV: 'production',
      [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: scenario.role,
      [scenario.variable]: scenario.url,
    };
    const environment =
      scenario.role === 'credential-validation-worker'
        ? validationWorkerEnvironment(overrides)
        : scenario.role === 'gateway'
          ? gatewayEnvironment(overrides)
          : managedEnvironment(overrides);
    const config = parseDeploymentConfig(environment);
    assert.equal(config.mode, 'managed-saas');
    if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
    assert.equal(config.workloadRole, scenario.role);
    assert.equal(config.postgresUrl, scenario.url);
  }
});

test('requires and validates only listeners assigned to the selected workload', () => {
  const controlPlaneEnvironment = managedEnvironment({
    NODE_ENV: 'production',
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
  });
  delete controlPlaneEnvironment[DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress];
  delete controlPlaneEnvironment[DEPLOYMENT_ENV_VARS.listeners.gateway.port];
  delete controlPlaneEnvironment[DEPLOYMENT_ENV_VARS.listeners.gateway.origin];
  const controlPlane = parseDeploymentConfig(controlPlaneEnvironment);
  assert.equal(controlPlane.mode, 'managed-saas');
  if (controlPlane.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.deepEqual(Object.keys(controlPlane.listeners).sort(), ['customer', 'platform']);
  assert.equal(controlPlane.listeners.gateway, undefined);

  const gateway = parseDeploymentConfig(gatewayEnvironment({ NODE_ENV: 'production' }));
  assert.equal(gateway.mode, 'managed-saas');
  if (gateway.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.deepEqual(Object.keys(gateway.listeners), ['gateway']);

  const workerEnvironment = validationWorkerEnvironment({
    NODE_ENV: 'production',
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'credential-validation-worker',
  });
  const worker = parseDeploymentConfig(workerEnvironment);
  assert.equal(worker.mode, 'managed-saas');
  if (worker.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.deepEqual(worker.listeners, {});
});

test('requires the matching role-specific PostgreSQL URL without falling back to the generic URL', () => {
  const cases = [
    { role: 'control-plane' as const, variable: MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL },
    { role: 'gateway' as const, variable: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL },
    { role: 'credential-validation-worker' as const, variable: MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL },
  ];

  for (const scenario of cases) {
    const createEnvironment =
      scenario.role === 'credential-validation-worker'
        ? validationWorkerEnvironment
        : scenario.role === 'gateway'
          ? gatewayEnvironment
          : managedEnvironment;
    const environment = createEnvironment({
      NODE_ENV: 'production',
      [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: scenario.role,
      [scenario.variable]: undefined,
    });
    assertDeploymentError(
      () => parseDeploymentConfig(environment),
      'MISSING_REQUIRED_SETTING',
      new RegExp(scenario.variable),
    );
  }
});

test('rejects unknown, whitespace, and unsafe workload role values without echoing them', () => {
  const values = ['', ' ', '\t', 'control-plane ', ' gateway', 'CONTROL-PLANE', 'gateway/worker'];
  for (const value of values) {
    assert.throws(
      () =>
        parseDeploymentConfig(
          managedEnvironment({
            [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: value,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof DeploymentConfigError);
        assert.equal(error.code, 'INVALID_WORKLOAD_ROLE');
        assert.equal(error.variableName, MODEL_ROUTER_SAAS_WORKLOAD_ROLE);
        assert.match(error.message, /MODEL_ROUTER_SAAS_WORKLOAD_ROLE/);
        assert.equal(error.message.includes('gateway/worker'), false);
        return true;
      },
    );
  }
});

test('requires a trusted Redis provider declaration independently of the Redis URL', () => {
  assert.equal(DEPLOYMENT_ENV_VARS.saas.redisProviderModule, MODEL_ROUTER_SAAS_REDIS_PROVIDER);
  assertDeploymentError(
    () => parseDeploymentConfig(managedEnvironment({ [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: undefined })),
    'MISSING_REQUIRED_SETTING',
    /MODEL_ROUTER_SAAS_REDIS_PROVIDER/,
  );

  for (const name of [MODEL_ROUTER_SAAS_REDIS_URL, MODEL_ROUTER_SAAS_REDIS_PROVIDER, MODEL_ROUTER_SAAS_KMS_PROVIDER]) {
    assertDeploymentError(
      () =>
        parseDeploymentConfig(
          managedEnvironment({
            [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
            [name]: undefined,
          }),
        ),
      'MISSING_REQUIRED_SETTING',
      new RegExp(name),
    );
  }
});

test('validates required service URL schemes and provider declaration', () => {
  const cases: Array<{
    name: string;
    overrides: Record<string, string | undefined>;
    code: DeploymentConfigError['code'];
  }> = [
    {
      name: 'database scheme',
      overrides: { [MODEL_ROUTER_SAAS_DATABASE_URL]: 'mysql://db.example/saas' },
      code: 'INVALID_DATABASE_URL',
    },
    {
      name: 'Redis scheme',
      overrides: { [MODEL_ROUTER_SAAS_REDIS_URL]: 'http://redis.example' },
      code: 'INVALID_REDIS_URL',
    },
    {
      name: 'provider is not empty',
      overrides: { [MODEL_ROUTER_SAAS_KMS_PROVIDER]: ' ' },
      code: 'MISSING_REQUIRED_SETTING',
    },
    {
      name: 'Redis provider is not empty',
      overrides: { [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: ' ' },
      code: 'MISSING_REQUIRED_SETTING',
    },
  ];

  for (const scenario of cases) {
    assertDeploymentError(
      () => parseDeploymentConfig(managedEnvironment(scenario.overrides)),
      scenario.code,
      /MODEL_ROUTER/,
    );
  }
});

test('requires exact canonical Origins and rejects credentials, components, and malformed ports', () => {
  const cases = [
    'https://user:secret@example.com',
    'https://customer.example.com/',
    'https://customer.example.com/path',
    'https://customer.example.com?tenant=1',
    'https://customer.example.com#fragment',
    'https://customer.example.com:443',
    'https://customer.example.com:65536',
    'not-an-origin',
  ];

  for (const origin of cases) {
    assertDeploymentError(
      () => parseDeploymentConfig(managedEnvironment({ [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: origin })),
      'INVALID_ORIGIN',
      /MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN/,
    );
  }
});

test('requires HTTPS for non-loopback Origins and allows a shared production Origin', () => {
  const insecure = managedEnvironment({
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: 'http://customer.example.com',
  });
  assertDeploymentError(() => parseDeploymentConfig(insecure), 'INSECURE_ORIGIN');

  const sharedOrigin = 'https://saas.example.com';
  const config = parseDeploymentConfig(
    managedEnvironment({
      [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: sharedOrigin,
      [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: sharedOrigin,
      [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: sharedOrigin,
    }),
  );
  if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.ok(config.listeners.customer);
  assert.ok(config.listeners.platform);
  assert.ok(config.listeners.gateway);
  assert.equal(config.listeners.customer.origin, sharedOrigin);
  assert.equal(config.listeners.platform.origin, sharedOrigin);
  assert.equal(config.listeners.gateway.origin, sharedOrigin);
  assert.deepEqual(
    {
      customer: config.listeners.customer.routePrefix,
      platform: config.listeners.platform.routePrefix,
      gateway: config.listeners.gateway.routePrefix,
    },
    {
      customer: '/console',
      platform: '/admin',
      gateway: '/v1',
    },
  );
});

test('allows distinct HTTPS subdomains and distinct public Origin ports', () => {
  const subdomains = parseDeploymentConfig(
    managedEnvironment({
      [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: 'https://customer.example.com',
      [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: 'https://admin.example.com',
      [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: 'https://gateway.example.com',
    }),
  );
  if (subdomains.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.ok(subdomains.listeners.customer);
  assert.ok(subdomains.listeners.platform);
  assert.ok(subdomains.listeners.gateway);
  assert.equal(subdomains.listeners.customer.origin, 'https://customer.example.com');
  assert.equal(subdomains.listeners.platform.origin, 'https://admin.example.com');
  assert.equal(subdomains.listeners.gateway.origin, 'https://gateway.example.com');

  const distinctPorts = parseDeploymentConfig(
    managedEnvironment({
      [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: 'https://edge.example.com:8443',
      [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: 'https://edge.example.com:9443',
      [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: 'https://edge.example.com:10443',
    }),
  );
  if (distinctPorts.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.ok(distinctPorts.listeners.customer);
  assert.ok(distinctPorts.listeners.platform);
  assert.ok(distinctPorts.listeners.gateway);
  assert.equal(distinctPorts.listeners.customer.origin, 'https://edge.example.com:8443');
  assert.equal(distinctPorts.listeners.platform.origin, 'https://edge.example.com:9443');
  assert.equal(distinctPorts.listeners.gateway.origin, 'https://edge.example.com:10443');
});

test('allows loopback HTTP Origins for development and test deployments', () => {
  const environment = managedEnvironment({
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: 'http://localhost:4101',
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: 'http://[::1]:4102',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: 'http://127.0.0.1:4103',
  });
  const config = parseDeploymentConfig(environment);
  assert.equal(config.mode, 'managed-saas');
});

test('rejects malformed or implicit listener ports', () => {
  const cases = ['', '0', '65536', '-1', '3.14', ' 3101', '03101', 'port'];
  for (const port of cases) {
    assertDeploymentError(
      () => parseDeploymentConfig(managedEnvironment({ [DEPLOYMENT_ENV_VARS.listeners.customer.port]: port })),
      port === '' ? 'MISSING_REQUIRED_SETTING' : 'INVALID_PORT',
      /MODEL_ROUTER_SAAS_CUSTOMER_PORT/,
    );
  }
});

test('rejects duplicate listener address/port while allowing duplicate Origins', () => {
  const duplicateListener = managedEnvironment({
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: '3101',
  });
  assertDeploymentError(() => parseDeploymentConfig(duplicateListener), 'DUPLICATE_LISTENER');

  const duplicateOrigin = managedEnvironment({
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: 'https://shared.example.com',
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: 'https://shared.example.com',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: 'https://shared.example.com',
  });
  const config = parseDeploymentConfig(duplicateOrigin);
  assert.equal(config.mode, 'managed-saas');
});

test('returns a deeply immutable managed contract and leaves input untouched', () => {
  const environment = managedEnvironment();
  const before = { ...environment };
  const config = parseDeploymentConfig(environment);

  assert.deepEqual(environment, before);
  assert.equal(Object.isFrozen(config), true);
  if (config.mode !== 'managed-saas') throw new Error('expected managed-saas');
  assert.ok(config.listeners.customer);
  assert.equal(Object.isFrozen(config.listeners), true);
  assert.equal(Object.isFrozen(config.listeners.customer), true);
  assert.equal(Reflect.set(config.listeners.customer, 'port', 9999), false);
  assert.equal(config.listeners.customer.port, 3101);
});

test('sanitizes database and provider values from validation errors', () => {
  const databaseSecret = 'database-password-that-must-not-leak';
  const providerSecret = '/private/provider/module-spec';

  assertDeploymentError(
    () =>
      parseDeploymentConfig(
        managedEnvironment({
          [MODEL_ROUTER_SAAS_DATABASE_URL]: `mysql://user:${databaseSecret}@db.example/saas`,
        }),
      ),
    'INVALID_DATABASE_URL',
  );
  assertDeploymentError(
    () =>
      parseDeploymentConfig(
        managedEnvironment({
          [MODEL_ROUTER_SAAS_KMS_PROVIDER]: providerSecret,
          [DEPLOYMENT_ENV_VARS.listeners.customer.port]: 'not-a-port',
        }),
      ),
    'INVALID_PORT',
  );

  try {
    parseDeploymentConfig(
      managedEnvironment({
        [MODEL_ROUTER_SAAS_DATABASE_URL]: `mysql://user:${databaseSecret}@db.example/saas`,
      }),
    );
  } catch (error) {
    assert.ok(error instanceof DeploymentConfigError);
    assert.equal(error.message.includes(databaseSecret), false);
    assert.equal(error.message.includes(providerSecret), false);
  }
});
