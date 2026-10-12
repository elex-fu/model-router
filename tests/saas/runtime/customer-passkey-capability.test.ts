import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  DeploymentConfigError,
  type DeploymentEnvironment,
  type ManagedSaasDeploymentConfig,
  MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE,
  parseDeploymentConfig,
} from '../../../src/saas/deployment.js';
import {
  CUSTOMER_PASSKEY_DEPLOYMENT_PURPOSE,
  CustomerPasskeyCapabilityError,
  type CustomerPasskeyCapabilityFactoryOptions,
  createCustomerPasskeyForDeployment,
  loadCustomerPasskeyDeploymentCapability,
} from '../../../src/saas/runtime/customer-passkey-capability.js';
import type { LoadedCredentialKeyProvider } from '../../../src/saas/runtime/providers.js';

const moduleName = 'synthetic-reviewed-customer-passkey-module';
function declaration(extra: DeploymentEnvironment = {}): DeploymentEnvironment {
  return {
    MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
    MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'control-plane',
    MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: 'postgresql://synthetic.invalid/not-used',
    MODEL_ROUTER_SAAS_REDIS_URL: 'redis://synthetic.invalid/not-used',
    MODEL_ROUTER_SAAS_REDIS_PROVIDER: 'synthetic-redis-module',
    MODEL_ROUTER_SAAS_KMS_PROVIDER: 'synthetic-kms-module',
    MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'synthetic-deployment',
    MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'synthetic-environment',
    MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS: '127.0.0.1',
    MODEL_ROUTER_SAAS_CUSTOMER_PORT: '31001',
    MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN: 'http://127.0.0.1:31001',
    MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS: '127.0.0.1',
    MODEL_ROUTER_SAAS_PLATFORM_PORT: '31002',
    MODEL_ROUTER_SAAS_PLATFORM_ORIGIN: 'http://127.0.0.1:31002',
    ...extra,
  };
}
function managed(environment: DeploymentEnvironment): ManagedSaasDeploymentConfig {
  const config = parseDeploymentConfig(environment);
  assert.equal(config.mode, 'managed-saas');
  if (config.mode !== 'managed-saas') assert.fail('Managed descriptor expected');
  return config;
}
const rp = { rpId: 'console.example.test', rpName: 'Synthetic Console', origins: ['https://console.example.test'] };
/** Unit provider/empty catalog only; never native KMS/schema/ACL approval. No sockets used. */
function fixture(configured = true) {
  const environment = declaration(
    configured ? { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: moduleName } : {},
  );
  const deployment = managed(environment);
  const sql: string[] = [];
  let keyCalls = 0,
    readyCalls = 0,
    imports = 0;
  const provider: LoadedCredentialKeyProvider = {
    async getCurrentKey() {
      ++keyCalls;
      throw new Error('Unit key lookup not expected');
    },
    async getKey() {
      ++keyCalls;
      throw new Error('Unit key lookup not expected');
    },
    async checkReady() {
      ++readyCalls;
    },
    async close() {},
  };
  const database: SaasDatabase = {
    async query<Row>(statement: string): Promise<SqlResult<Row>> {
      sql.push(statement);
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
      return work(database);
    },
    async migrate() {
      assert.fail('No migration');
    },
    async verifySchema() {
      assert.fail('No alternate schema proof');
    },
    async ping() {
      assert.fail('No network');
    },
    async close() {},
  };
  const importer = async () => {
    ++imports;
    return {
      createCustomerPasskeyDeploymentCapability(options: CustomerPasskeyCapabilityFactoryOptions) {
        return { ...options, ...rp, requireUserVerification: true };
      },
    };
  };
  return {
    environment,
    deployment,
    provider,
    database,
    sql,
    importer,
    get keyCalls() {
      return keyCalls;
    },
    get readyCalls() {
      return readyCalls;
    },
    get imports() {
      return imports;
    },
  };
}
const rejected = (error: unknown) => error instanceof CustomerPasskeyCapabilityError;

test('optional absent descriptor preserves default startup without import KMS lookup readiness or passkey catalog SQL', async () => {
  const f = fixture(false);
  assert.equal(
    await createCustomerPasskeyForDeployment(f.database, {
      deployment: f.deployment,
      environment: f.environment,
      credentialKeyProvider: f.provider,
      importer: f.importer,
    }),
    undefined,
  );
  assert.equal(f.imports, 0);
  assert.equal(f.keyCalls, 0);
  assert.equal(f.readyCalls, 0);
  assert.deepEqual(f.sql, []);
});
test('real deployment parser requires explicit context for passkeys and rejects local wrong-role blank and accessor declarations', () => {
  for (const extra of [
    { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: '' },
    { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: ' true ' },
    { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: moduleName, MODEL_ROUTER_SAAS_DEPLOYMENT_ID: undefined },
    { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: moduleName, MODEL_ROUTER_SAAS_ENVIRONMENT_ID: undefined },
    { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: moduleName, MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway' },
    { [MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE]: moduleName, MODEL_ROUTER_DEPLOYMENT_MODE: 'local' },
  ])
    assert.throws(() => parseDeploymentConfig(declaration(extra)), DeploymentConfigError);
  let getters = 0;
  const env = declaration();
  Object.defineProperty(env, MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE, {
    enumerable: true,
    get() {
      ++getters;
      return moduleName;
    },
  });
  assert.throws(() => parseDeploymentConfig(env), DeploymentConfigError);
  assert.equal(getters, 0);
});
test('trusted descriptor binds exact purpose deployment environment relying party and same actual provider, without operations or ready proof', async () => {
  const f = fixture();
  const cap = await loadCustomerPasskeyDeploymentCapability({
    deployment: f.deployment,
    environment: f.environment,
    credentialKeyProvider: f.provider,
    importer: f.importer,
  });
  assert.ok(cap);
  assert.equal(cap.purpose, CUSTOMER_PASSKEY_DEPLOYMENT_PURPOSE);
  assert.equal(cap.credentialKeyProvider, f.provider);
  assert.equal(cap.deploymentId, f.deployment.deploymentId);
  assert.equal(cap.environmentId, f.deployment.environmentId);
  assert.equal(cap.rpId, 'console.example.test');
  assert.equal(cap.rpName, 'Synthetic Console');
  assert.deepEqual(cap.origins, ['https://console.example.test']);
  assert.equal(cap.requireUserVerification, true);
  assert.ok(Object.isFrozen(cap));
  assert.ok(Object.isFrozen(cap.origins));
  assert.deepEqual(f.sql, []);
  assert.equal(f.keyCalls, 0);
});
test('wrong dimensions replacement provider invalid relying-party fields additional operations and descriptor getters fail closed', async () => {
  const f = fixture();
  const invalid: readonly ((o: CustomerPasskeyCapabilityFactoryOptions) => unknown)[] = [
    (o) => ({ ...o, ...rp, requireUserVerification: true, purpose: 'customer-mfa-deployment-v1' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, deploymentId: 'other' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, environmentId: 'other' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, credentialKeyProvider: { ...f.provider } }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, ready: true }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, status: async () => ({ enabled: false }) }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, rpId: 'Console.Example.Test' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, rpId: 'no-tld' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, rpName: ' padded ' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, origins: [] }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, origins: ['http://console.example.test'] }),
    (o) => ({
      ...o,
      ...rp,
      requireUserVerification: true,
      origins: ['https://console.example.test', 'https://console.example.test'],
    }),
    (o) => ({ ...o, ...rp, requireUserVerification: 'yes' }),
    (o) => ({ ...o, ...rp, requireUserVerification: true, rpId: undefined }),
    (o) =>
      Object.defineProperty({ ...o, ...rp, requireUserVerification: true }, 'rpId', {
        get() {
          assert.fail('Accessor must not run');
        },
      }),
  ];
  for (const factory of invalid)
    await assert.rejects(
      loadCustomerPasskeyDeploymentCapability({
        deployment: f.deployment,
        environment: f.environment,
        credentialKeyProvider: f.provider,
        importer: async () => ({ createCustomerPasskeyDeploymentCapability: factory }),
      }),
      rejected,
    );
  assert.deepEqual(f.sql, []);
  assert.equal(f.readyCalls, 0);
});
test('declared missing or failed module and mismatched config environment cannot silently disable passkeys', async () => {
  const f = fixture();
  for (const importer of [
    async () => ({}),
    async () => {
      throw new Error('synthetic private module error');
    },
  ]) {
    await assert.rejects(
      createCustomerPasskeyForDeployment(f.database, {
        deployment: f.deployment,
        environment: f.environment,
        credentialKeyProvider: f.provider,
        importer,
      }),
      rejected,
    );
  }
  await assert.rejects(
    loadCustomerPasskeyDeploymentCapability({
      deployment: f.deployment,
      environment: {},
      credentialKeyProvider: f.provider,
      importer: f.importer,
    }),
    rejected,
  );
  assert.deepEqual(f.sql, []);
});
test('explicit valid capability invokes actual service catalog readiness and refuses an unactivated schema', async () => {
  const f = fixture();
  await assert.rejects(
    createCustomerPasskeyForDeployment(f.database, {
      deployment: f.deployment,
      environment: f.environment,
      credentialKeyProvider: f.provider,
      importer: f.importer,
    }),
    (error) => error instanceof CustomerPasskeyCapabilityError && error.code === 'READINESS_FAILED',
  );
  assert.equal(f.readyCalls, 1);
  assert.equal(f.sql.length, 1);
  assert.match(f.sql[0] ?? '', /WITH wanted\(relation_name,column_name,type_name\)/);
  assert.equal(f.keyCalls, 0);
});
test('actual startup composition awaits the core factory before listeners and keeps service and readiness core-owned', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/server/managed-saas.ts'), 'utf8');
  const guard = source.indexOf('assertCustomerPasskeyDeploymentConfiguration(deployment');
  const worker = source.indexOf("deployment.workloadRole === 'credential-validation-worker'");
  const factory = source.indexOf('await createCustomerPasskeyForDeployment(database');
  const bind = source.indexOf('const listenerConfig = deploymentListener(deployment');
  assert.ok(guard > 0 && worker > guard);
  assert.ok(factory > 0 && bind > factory);
  assert.match(source, /customerPasskeyService === undefined \? \{\} : \{ customerPasskey: customerPasskeyService \}/);
  const core = readFileSync(resolve(process.cwd(), 'src/saas/runtime/customer-passkey-capability.ts'), 'utf8');
  assert.match(core, /new CustomerPasskeyService\(database/);
  assert.match(core, /await service\.checkReady\(\)/);
  assert.doesNotMatch(core, /enabled:|ready:|randomBytes|migrate\(|operations:/);
});

test('module tampering with bound deployment between awaits cannot create a usable service', async () => {
  const f = fixture();
  const mutable = { ...f.deployment };
  await assert.rejects(
    createCustomerPasskeyForDeployment(f.database, {
      deployment: mutable,
      environment: f.environment,
      credentialKeyProvider: f.provider,
      importer: async () => ({
        createCustomerPasskeyDeploymentCapability(options: CustomerPasskeyCapabilityFactoryOptions) {
          mutable.deploymentId = 'replacement-deployment';
          return { ...options, ...rp, requireUserVerification: true };
        },
      }),
    }),
    rejected,
  );
  assert.equal(f.readyCalls, 0);
  assert.deepEqual(f.sql, []);
});

test('explicit KMS readiness failure aborts without schema fallback or private provider detail', async () => {
  const f = fixture();
  const provider: LoadedCredentialKeyProvider = {
    ...f.provider,
    async checkReady() {
      throw new Error('synthetic private KMS detail');
    },
  };
  await assert.rejects(
    createCustomerPasskeyForDeployment(f.database, {
      deployment: f.deployment,
      environment: f.environment,
      credentialKeyProvider: provider,
      importer: f.importer,
    }),
    (error) => {
      assert.ok(error instanceof CustomerPasskeyCapabilityError);
      assert.equal(error.code, 'READINESS_FAILED');
      assert.equal(error.message.includes('synthetic private'), false);
      return true;
    },
  );
  assert.deepEqual(f.sql, []);
});
