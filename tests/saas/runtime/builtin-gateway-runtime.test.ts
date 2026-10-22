import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  BuiltinGatewayRuntimeConfigurationError,
  createBuiltinManagedSaasGatewayRuntime,
  createBuiltinProviderTargetResolver,
  MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG,
} from '../../../src/saas/runtime/builtin-gateway-runtime.js';
import { createGatewayCapabilityAdvertisementPolicy } from '../../../src/saas/runtime/gateway-capability-advertisement.js';
import { loadManagedSaasGatewayRuntimeModule } from '../../../src/saas/runtime/gateway-runtime-module.js';
import { PROVIDER_BUNDLE_IDS } from '../../../src/saas/runtime/provider-bundles.js';

const database = {
  query: async () => ({ rows: [], rowCount: 0 }),
  transaction: async (callback: (executor: unknown) => Promise<unknown>) => callback(database),
} as unknown as SaasDatabase;

async function fixture(t: { after(callback: () => Promise<void>): void }, bundles = PROVIDER_BUNDLE_IDS) {
  const directory = await mkdtemp(join(tmpdir(), 'builtin-gateway-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const files = {
    private: join(directory, 'private.pem'),
    public: join(directory, 'public.pem'),
    affinity: join(directory, 'affinity.key'),
    idempotency: join(directory, 'idempotency.key'),
    config: join(directory, 'gateway.json'),
  };
  await writeFile(files.private, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(files.public, keys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 });
  await writeFile(files.affinity, randomBytes(32), { mode: 0o600 });
  await writeFile(files.idempotency, randomBytes(32), { mode: 0o600 });
  const config = {
    apiVersion: 2,
    extensions: { providerBundles: bundles.map((bundle) => ({ bundle, enabled: true })) },
    signing: {
      verifierKeyId: 'runtime-key',
      privateKeyFile: files.private,
      trustedPublicKeys: [{ keyId: 'runtime-key', publicKeyFile: files.public, status: 'active' }],
    },
    affinity: { activeKeyVersion: 'v1', keys: [{ version: 'v1', keyFile: files.affinity }] },
    idempotencyKeyFile: files.idempotency,
  };
  await writeFile(files.config, JSON.stringify(config));
  const hooks: Array<() => unknown> = [];
  return {
    files,
    config,
    options: {
      database,
      env: { [MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG]: files.config },
      deployment: {
        workloadRole: 'gateway' as const,
        deploymentId: 'deployment-test',
        environmentId: 'environment-test',
        listener: {
          bindAddress: '127.0.0.1',
          port: 15005,
          origin: 'http://127.0.0.1:15005',
          routePrefix: '/v1' as const,
        },
      },
      lifecycle: {
        registerCloseHook(hook: () => unknown) {
          hooks.push(hook);
        },
      },
    },
    hooks,
  };
}

test('standard built-in factory constructs all eleven bundles and observes actual transport mounting', async (t) => {
  const f = await fixture(t);
  const runtime = await createBuiltinManagedSaasGatewayRuntime(f.options);
  t.after(() => runtime.close());
  assert.equal(runtime.extensions.providerBundles.length, 11);
  assert.equal(runtime.deploymentFacts.dispatch.generic, false);
  await assert.rejects(runtime.checkReady(), /capability assembly is invalid/);
  const mounted = runtime.dependencies.providerEvidenceTransports?.({
    genericTransport: {
      async send() {
        return { responseStarted: false };
      },
    },
    proofReader: {
      async readDispatchProof() {
        return null;
      },
    },
    unsealer: {
      async withCredential() {
        throw new Error('not dispatching');
      },
    },
  });
  assert.deepEqual(
    Object.keys(mounted ?? {}).sort(),
    [
      'bedrockEvidenceTransport',
      'claudeEvidenceTransport',
      'cnProvidersEvidenceTransport',
      'codexEvidenceTransport',
      'geminiEvidenceTransport',
      'grokEvidenceTransport',
      'opencodeGoEvidenceTransport',
      'vertexEvidenceTransport',
      'responsesCompactEvidenceTransport',
    ].sort(),
  );
  assert.equal(runtime.deploymentFacts.dispatch.generic, true);
  assert.equal(runtime.deploymentFacts.dispatch.routedEndpointScopes.length, 10);
  // Missing commercial inventory is readiness data, never fabricated live validation.
  await runtime.checkReady();
  assert.deepEqual(runtime.deploymentFacts.verification, {});
  assert.equal(runtime.dependencies.providerNativeProtocol?.('kimi', 'kimi-code', 'model', 'openai'), 'anthropic');
  assert.equal(
    runtime.dependencies.providerNativeProtocol?.('openai-codex', 'codex-chatgpt', 'model', 'responses'),
    'responses',
  );
  assert.throws(
    () => runtime.dependencies.providerNativeProtocol?.('openai-codex', 'codex-chatgpt', 'model', 'anthropic'),
    /client protocol is unavailable/,
  );
  assert.equal(runtime.dependencies.responsesCompactNativeSupply, undefined);
  const normal = await runtime.dependencies.providerPayload.estimator.estimate({
    normalizedRequest: { body: { max_tokens: 42 }, providerId: 'kimi', providerProtocol: 'anthropic' },
    compiledPayloadBytes: Buffer.from(
      JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }], max_tokens: 42 }),
    ),
  } as never);
  assert.equal((normal as { inputTotalUpperBound: number }).inputTotalUpperBound, 262_144);
  assert.equal((normal as { outputTotalUpperBound: number }).outputTotalUpperBound, 42);
  assert.throws(
    () =>
      runtime.dependencies.providerPayload.estimator.estimate({
        normalizedRequest: {
          body: { max_output_tokens: 2 },
          providerId: 'openai-codex',
          providerProtocol: 'responses',
        },
        compiledPayloadBytes: Buffer.from(JSON.stringify({ model: 'model-a', input: [] })),
      } as never),
    /usage bound is unavailable/,
  );
  const report = await runtime.getCapabilityReadiness();
  assert.ok(
    report.capabilities
      .find((capability) => capability.providerId === 'openai-codex')
      ?.reasonCodes.includes('USAGE_BOUNDS_UNAVAILABLE'),
  );
  assert.throws(
    () => runtime.dependencies.providerNativeProtocol?.('unknown', 'unknown', 'model', 'openai'),
    /protocol is unavailable/,
  );
  assert.throws(() => runtime.dependencies.providerEvidenceTransports?.({} as never), /already assembled/);
  const secret = runtime.dependencies.idempotencyHmacKey;
  await runtime.close();
  assert.ok(secret.every((byte) => byte === 0));
  assert.equal(runtime.deploymentFacts.dispatch.generic, false);
  await assert.rejects(runtime.checkReady(), /closed/);
});

test('known core target bindings preserve real upstream ids and reject wrong protocol or disabled supplies', () => {
  const { resolver, endpointPolicy } = createBuiltinProviderTargetResolver([
    { bundle: 'kimi', enabled: true },
    { bundle: 'openrouter', enabled: true },
    { bundle: 'zhipu', enabled: true },
  ]);
  const result = resolver.resolve({
    upstreamId: 'actual-pool-id',
    productId: 'kimi-code',
    protocol: 'anthropic',
    operation: 'messages',
  });
  assert.equal(result.url, 'https://api.kimi.com/coding/v1/messages');
  assert.deepEqual(result.endpointPolicy, endpointPolicy);
  assert.equal(
    resolver.resolve({
      upstreamId: 'other-pool',
      productId: 'zhipu-glm-coding',
      protocol: 'openai',
      operation: 'chat.completions',
    }).url,
    'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  );
  assert.throws(
    () =>
      resolver.resolve({
        upstreamId: 'pool',
        productId: 'kimi-code',
        protocol: 'openai',
        operation: 'chat.completions',
      }),
    /target is unavailable/,
  );
  assert.throws(
    () =>
      resolver.resolve({
        upstreamId: 'pool',
        productId: 'opencode-go-zen',
        protocol: 'responses',
        operation: 'responses',
      }),
    /target is unavailable/,
  );
});

test('native compact requires an explicit Codex declaration and an active public alias', async (t) => {
  const f = await fixture(t, ['openai-codex']);
  const config = {
    ...f.config,
    extensions: { providerBundles: [{ bundle: 'openai-codex', enabled: true, parameters: { nativeCompact: true } }] },
  };
  await writeFile(f.files.config, JSON.stringify(config));
  const runtime = await createBuiltinManagedSaasGatewayRuntime({
    ...f.options,
    database: {
      ...database,
      async query(sql: string) {
        return {
          rows: sql.includes('SELECT DISTINCT public_model.alias') ? [{ alias: 'configured-codex' }] : [],
          rowCount: 0,
        };
      },
    } as unknown as typeof f.options,
  });
  t.after(() => runtime.close());
  assert.equal(runtime.dependencies.responsesCompactNativeSupply?.('configured-codex'), true);
  assert.equal(runtime.dependencies.responsesCompactNativeSupply?.('unregistered-model'), false);
});

test('built-in loader is usable without any executable module importer', async (t) => {
  const f = await fixture(t, ['kimi']);
  const runtime = await loadManagedSaasGatewayRuntimeModule({
    database,
    environment: { ...f.options.env, MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: 'builtin' },
    deployment: {
      mode: 'managed-saas',
      workloadRole: 'gateway',
      postgresUrl: 'postgres://gateway.invalid/database',
      gatewayRuntimeModule: 'builtin',
      deploymentId: 'deployment-test',
      environmentId: 'environment-test',
      listeners: { gateway: f.options.deployment.listener },
    },
    importer: async () => {
      throw new Error('a standard runtime must not import executable operator modules');
    },
  });
  t.after(() => runtime.close());
  runtime.dependencies.providerEvidenceTransports?.({
    genericTransport: {
      async send() {
        return { responseStarted: false };
      },
    },
    proofReader: {
      async readDispatchProof() {
        return null;
      },
    },
    unsealer: {
      async withCredential() {
        throw new Error('not dispatching');
      },
    },
  });
  await runtime.checkReady();
  const projection = await runtime.getCapabilityReadiness?.();
  assert.equal(projection?.configurationValid, true);
  assert.equal(projection?.capabilities[0]?.assembled, true);
  assert.equal(projection?.capabilities[0]?.operational, false);
  assert.equal(projection?.capabilities[0]?.verified, false);
});

test('built-in runtime rejects unknown bundles, raw credential configuration and missing secret files before listening', async (t) => {
  const f = await fixture(t, ['kimi']);
  for (const config of [
    { ...f.config, extensions: { providerBundles: [{ bundle: 'typo-provider', enabled: true }] } },
    {
      ...f.config,
      extensions: {
        providerBundles: [{ bundle: 'kimi', enabled: true, parameters: { apiKey: randomBytes(32).toString('hex') } }],
      },
    },
    { ...f.config, idempotencyKeyFile: join(tmpdir(), 'missing-runtime-key') },
    { ...f.config, limits: { maxInputTokens: 1 } },
    { ...f.config, signing: { ...f.config.signing, privateKey: 'raw-inline-key' } },
  ]) {
    await writeFile(f.files.config, JSON.stringify(config));
    await assert.rejects(createBuiltinManagedSaasGatewayRuntime(f.options), BuiltinGatewayRuntimeConfigurationError);
  }
});

test('standard media and TLS extensions mount existing core options and verify the sidecar listener', async (t) => {
  const f = await fixture(t, ['kimi']);
  const socketPath = join(tmpdir(), `mr-tls-${randomBytes(6).toString('hex')}.sock`);
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  });
  const config = {
    ...f.config,
    extensions: {
      ...f.config.extensions,
      media: {
        storage: 's3',
        parameters: {
          endpoint: 'https://storage.example.com',
          bucket: 'images',
          region: 'us-east-1',
          forcePathStyle: true,
        },
        secretReferences: { accessKeyId: 'env://MEDIA_ACCESS_ID', secretAccessKey: 'env://MEDIA_SECRET' },
      },
      tlsFingerprint: { profile: 'default', parameters: { sidecarSocketPath: socketPath } },
    },
  };
  await writeFile(f.files.config, JSON.stringify(config));
  const runtime = await createBuiltinManagedSaasGatewayRuntime({
    ...f.options,
    env: {
      ...f.options.env,
      MEDIA_ACCESS_ID: randomBytes(12).toString('hex'),
      MEDIA_SECRET: randomBytes(24).toString('hex'),
    },
  });
  t.after(() => runtime.close());
  assert.equal(runtime.dependencies.imageMedia?.s3.bucket, 'images');
  assert.equal(runtime.dependencies.tlsFingerprintResolution?.sidecarSocketPath, socketPath);
  runtime.dependencies.providerEvidenceTransports?.({
    genericTransport: {
      async send() {
        return { responseStarted: false };
      },
    },
    proofReader: {
      async readDispatchProof() {
        return null;
      },
    },
    unsealer: {
      async withCredential() {
        throw new Error('not dispatching');
      },
    },
  });
  await runtime.checkReady();
  assert.deepEqual(runtime.deploymentFacts.mediaStorages, ['s3']);
  assert.deepEqual(runtime.deploymentFacts.tlsFingerprintProfiles, ['default']);
});

test('standard live-verification declarations require matching evidence artifacts and expire', async (t) => {
  const f = await fixture(t, ['kimi']);
  const evidenceFile = join(tmpdir(), `mr-evidence-${randomBytes(6).toString('hex')}.json`);
  const recordsFile = join(tmpdir(), `mr-verification-${randomBytes(6).toString('hex')}.json`);
  t.after(() =>
    Promise.all([rm(evidenceFile, { force: true }), rm(recordsFile, { force: true })]).then(() => undefined),
  );
  const evidence = JSON.stringify({ kind: 'unit-fixture', status: 200 });
  await writeFile(evidenceFile, evidence);
  const record = {
    capability: 'provider-bundle:kimi',
    level: 'live',
    verifiedAt: new Date().toISOString(),
    evidenceFile,
    evidenceSha256: createHash('sha256').update(evidence).digest('hex'),
  };
  await writeFile(recordsFile, JSON.stringify([record]));
  await writeFile(f.files.config, JSON.stringify({ ...f.config, verificationRecordsFile: recordsFile }));
  const stockedDatabase = {
    ...database,
    query: async () => ({ rows: [{ provider_id: 'kimi', endpoint: 'messages' }], rowCount: 1 }),
  } as unknown as SaasDatabase;
  const runtime = await createBuiltinManagedSaasGatewayRuntime({ ...f.options, database: stockedDatabase });
  t.after(() => runtime.close());
  assert.equal(runtime.deploymentFacts.verification['provider-bundle:kimi'], 'live');
  runtime.dependencies.providerEvidenceTransports?.({
    genericTransport: {
      async send() {
        return { responseStarted: false };
      },
    },
    proofReader: {
      async readDispatchProof() {
        return null;
      },
    },
    unsealer: {
      async withCredential() {
        throw new Error('not dispatching');
      },
    },
  });
  const target = { providerId: 'kimi', productId: 'kimi-code', endpoint: 'messages' };
  assert.equal(createGatewayCapabilityAdvertisementPolicy(await runtime.getCapabilityReadiness())(target), true);
  await writeFile(
    recordsFile,
    JSON.stringify([{ ...record, verifiedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }]),
  );
  await runtime.checkReady();
  assert.equal(runtime.deploymentFacts.verification['provider-bundle:kimi'], 'unverified');
  assert.equal(createGatewayCapabilityAdvertisementPolicy(await runtime.getCapabilityReadiness())(target), false);
  await writeFile(evidenceFile, JSON.stringify({ kind: 'tampered-fixture' }));
  await assert.rejects(runtime.checkReady(), BuiltinGatewayRuntimeConfigurationError);
});
