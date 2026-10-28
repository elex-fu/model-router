'use strict';
// Local A/B benchmark seed driver (port of the /tmp/mr-bench-20261027 driver).
// Seeds a disposable tenant/project/key/pool inventory via the native fast HTTP
// fixture and writes all credentials and runtime material into a gitignored run
// directory (default /tmp/model-router-local-ab). Nothing secret is committed;
// the KMS master key and the ed25519 signing pair are generated at runtime.
//
// Toggles (environment):
//   LOCAL_AB_RUN_DIR     run directory (default /tmp/model-router-local-ab)
//   LOCAL_AB_PG_PORT     PostgreSQL port (default 5434)
//   LOCAL_AB_REDIS_PORT  Redis port (default 16399)
//   LOCAL_AB_MOCK_PORT   mock upstream port (default 18453)
//   LOCAL_AB_APP_PORT    gateway listen port (default 18088)
//   LOCAL_AB_HTTP_IN_FLIGHT  bounded concurrency / fixture maxConcurrency (default 64)
//   LOCAL_AB_ANTHROPIC=1 seed an extra anthropic /v1/messages route (T5 strict baseline)
//   LOCAL_AB_FAST=off    omit MODEL_ROUTER_FAST_GATEWAY (strict full path, T5)
//                        any other value sets MODEL_ROUTER_FAST_GATEWAY=reserved-max (default)
//   LOCAL_AB_EXTRA_ENV_FILE  optional file with extra KEY=VALUE lines appended to app.env
//
// Prerequisite: `npm run build` (dist/) and compiled fixtures:
//   node scripts/performance/fixed-cpu/compile-fixtures.cjs
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, generateKeyPairSync, createHash } = require('node:crypto');

const R = path.resolve(__dirname, '..', '..', '..');
const directory = process.env.LOCAL_AB_RUN_DIR || '/tmp/model-router-local-ab';
const production = (name) => require(path.join(R, 'dist', name));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

const PG_PORT = Number(process.env.LOCAL_AB_PG_PORT || 5434);
const REDIS_PORT = Number(process.env.LOCAL_AB_REDIS_PORT || 16399);
const MOCK_PORT = Number(process.env.LOCAL_AB_MOCK_PORT || 18453);
const APP_PORT = Number(process.env.LOCAL_AB_APP_PORT || 18088);
const httpInFlight = Number(process.env.LOCAL_AB_HTTP_IN_FLIGHT || 64);
const fastEnabled = process.env.LOCAL_AB_FAST !== 'off';
const withAnthropic = process.env.LOCAL_AB_ANTHROPIC === '1';
const databaseUrl = (role) => `postgresql://${role}@127.0.0.1:${PG_PORT}/model_router_bench`;

async function ensureCompiledFixtures() {
  for (const name of ['seed.cjs', 'runtime.cjs']) {
    try {
      await fs.access(path.join(R, 'scripts/performance/fixed-cpu', name));
    } catch {
      throw new Error(
        `compiled fixture ${name} missing; run: node scripts/performance/fixed-cpu/compile-fixtures.cjs`,
      );
    }
  }
}

async function seed() {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureCompiledFixtures();
  const { createSaasDatabase } = production('saas/db/index.js');
  const database = createSaasDatabase({ connectionString: databaseUrl('model_router_saas_migrator'), max: 2 });
  const kms = {
    MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: randomBytes(32).toString('hex'),
    MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'r9-local-test',
  };
  try {
    const extraRoutes = withAnthropic
      ? [{ protocol: 'anthropic', endpoint: '/v1/messages', publicModel: 'native-fast-ci-model-anthropic' }]
      : [];
    const seeded = await require(path.join(R, 'scripts/performance/fixed-cpu/seed.cjs')).seedNativeFastHttpInventory(
      database,
      kms,
      httpInFlight,
      extraRoutes,
    );
    const keys = generateKeyPairSync('ed25519');
    await fs.writeFile(path.join(directory, 'signing-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'signing-public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const namespace = `bench-${randomUUID()}`;
    const deploymentId = 'r9-current-test';
    const creditCap = String(2 * 524480 * httpInFlight);
    const { registerBoundedDeployment, ensureBoundedCreditBudget } = production('saas/gateway/fast/bounded-deployment-budget.js');
    const { saasAdvisoryKey, WALLET_FENCE_SQL } = production('saas/db/advisory-lock-keys.js');
    const spec = { deploymentId, policyDigest: digest({ contract: 'fixed-cpu-single-control/v1', http: httpInFlight, cap: creditCap }), creditCapMinorUnits: creditCap };
    await registerBoundedDeployment(database, spec);
    await database.transaction(async (tx) => {
      await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(seeded.tenantId, 'USD')]);
      const cap = await ensureBoundedCreditBudget(tx, spec, seeded.tenantId, 'USD');
      if (String(cap) !== creditCap) throw new Error(`credit budget mismatch: ${cap}`);
    });
    await save('runtime.json', {
      estimator: 'builtin',
      maxConcurrency: httpInFlight,
      privateKeyFile: path.join(directory, 'signing-private.pem'),
      publicKeyFile: path.join(directory, 'signing-public.pem'),
      mockPort: MOCK_PORT,
      routes: seeded.inventory,
      affinityKey: randomBytes(32).toString('base64'),
      idempotencyKey: randomBytes(32).toString('base64'),
    });
    await fs.writeFile(path.join(directory, 'api-key'), seeded.key, { mode: 0o600 });
    await save('identity.json', { tenantId: seeded.tenantId, projectId: seeded.projectId, keyId: seeded.keyId, namespace, anthropic: withAnthropic });
    // When the run directory carries a local CA (gen-certs.sh output) the
    // gateway trusts it for the loopback mock upstream; plain-HTTP runs omit
    // the override and keep the process default trust store.
    let tlsCa = {};
    try {
      await fs.access(path.join(directory, 'certificate.pem'));
      tlsCa = { NODE_EXTRA_CA_CERTS: path.join(directory, 'certificate.pem') };
    } catch {}
    const env = {
      ...tlsCa,
      ...kms,
      NODE_ENV: 'production',
      MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT: 'true',
      MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
      MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
      MODEL_ROUTER_SAAS_DEPLOYMENT_ID: deploymentId,
      MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: databaseUrl('model_router_saas_gateway'),
      MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
      MODEL_ROUTER_SAAS_DB_POOL_MAX: '16',
      MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: String(httpInFlight),
      ...(fastEnabled
        ? {
            MODEL_ROUTER_FAST_GATEWAY: 'reserved-max',
            MODEL_ROUTER_FAST_NAMESPACE: namespace,
            MODEL_ROUTER_FAST_OWNER: namespace,
            MODEL_ROUTER_FAST_CREDIT_STRIPES: '8',
            MODEL_ROUTER_FAST_RECEIPT_MODE: 'memory-queue',
            MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES: '256',
            MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES: '2097152',
            MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT: '64',
            MODEL_ROUTER_FAST_RECEIPT_WORKERS: '8',
            MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS: '5000',
            MODEL_ROUTER_FAST_RECEIPT_DRAIN_TIMEOUT_MS: '10000',
            MODEL_ROUTER_FAST_CONNECTION_REUSE: '1',
          }
        : {}),
      MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1',
      MODEL_ROUTER_SAAS_GATEWAY_PORT: String(APP_PORT),
      MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
      MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: path.join(R, 'scripts/performance/fixed-cpu/runtime.cjs'),
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: path.join(R, 'dist/saas/runtime/software-provider-credential-kms.js'),
      MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST: '127.0.0.1/32',
      NATIVE_FAST_HTTP_CONFIG: path.join(directory, 'runtime.json'),
    };
    let lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    if (process.env.LOCAL_AB_EXTRA_ENV_FILE) {
      lines = lines.concat((await fs.readFile(process.env.LOCAL_AB_EXTRA_ENV_FILE, 'utf8')).split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#')));
    }
    await fs.writeFile(path.join(directory, 'app.env'), lines.join('\n') + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ seeded: true, tenantId: seeded.tenantId, httpInFlight, creditCap, fastEnabled, withAnthropic, runDir: directory }));
  } finally {
    await database.close();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
