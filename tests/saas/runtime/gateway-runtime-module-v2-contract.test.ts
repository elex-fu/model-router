import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  GatewayRuntimeModuleError,
  loadManagedSaasGatewayRuntimeModule,
} from '../../../src/saas/runtime/gateway-runtime-module.js';

const MODULE_SPECIFIER = '@trusted/gateway-runtime';
const RUNTIME_MODULE_ENV = 'MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE';

function affinityKeyring(): Record<string, unknown> {
  return {
    activeKeyVersion: 'test-v1',
    keys: [{ version: 'test-v1', key: new Uint8Array(32).fill(0x5a) }],
  };
}

function dependencies(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entitlementResolver: {},
    schedulerAuthorities: { affinityKeyring: affinityKeyring(), leaseConcurrencyLimit: 4 },
    idempotencyHmacKey: new Uint8Array(32),
    providerPreparationRoute: {},
    providerPayload: {},
    evidenceSigner: {},
    evidenceVerifierKeyId: 'gateway-evidence-key',
    idFactory: () => 'request-id',
    trustedVerifierPublicKeys: [],
    providerTargetResolver: {},
    providerTargetRoute: {},
    resolveAuthenticationHeader: () => 'authorization',
    fetch: async () => new Response(),
    endpointPolicy: {},
    timeoutMs: 1_000,
    maxConcurrency: 4,
    leaseTtlMs: 10_000,
    maxBodyBytes: 1_024,
    entryPoint: {},
    ...overrides,
  };
}

async function loadHandle(handle: unknown) {
  const module = { createManagedSaasGatewayRuntime: () => handle };

  return loadManagedSaasGatewayRuntimeModule({
    deployment: {
      mode: 'managed-saas',
      workloadRole: 'gateway',
      postgresUrl: 'postgres://gateway.invalid/model_router',
      deploymentId: 'deployment-test',
      environmentId: 'environment-test',
      gatewayRuntimeModule: MODULE_SPECIFIER,
      listeners: {
        gateway: {
          bindAddress: '127.0.0.1',
          port: 15_005,
          origin: 'http://127.0.0.1:15005',
          routePrefix: '/v1',
        },
      },
    },
    database: { transaction: async () => undefined } as unknown as SaasDatabase,
    environment: { [RUNTIME_MODULE_ENV]: MODULE_SPECIFIER },
    importer: async () => module,
  });
}

function v2Handle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 2,
    dependencies: dependencies(),
    extensions: { providerBundles: [{ bundle: 'anthropic', enabled: true }] },
    checkReady: () => undefined,
    close: () => undefined,
    ...overrides,
  };
}

async function assertContractInvalid(handle: unknown): Promise<void> {
  await assert.rejects(loadHandle(handle), (error: unknown) => {
    assert.ok(error instanceof GatewayRuntimeModuleError);
    assert.equal(error.code, 'MODULE_CONTRACT_INVALID');
    return true;
  });
}

test('gateway runtime accepts a v2 handle and exposes detached frozen extensions', async () => {
  const sourceBundles = [
    {
      bundle: 'anthropic',
      enabled: true,
      parameters: { region: 'eu-west-1', retries: 3, streaming: true },
      secretReferences: { apiKey: 'env://ANTHROPIC_API_KEY' },
    },
    { bundle: 'bedrock', enabled: false },
  ];
  const runtime = await loadHandle(
    v2Handle({
      extensions: {
        providerBundles: sourceBundles,
        media: {
          storage: 's3',
          parameters: { bucket: 'media' },
          secretReferences: { accessKey: 'kms://media/access' },
        },
        tlsFingerprint: { profile: 'bench-mock', parameters: { sidecar: true } },
      },
    }),
  );
  await runtime.checkReady();

  const extensions = runtime.extensions;
  assert.ok(extensions);
  assert.equal(extensions.providerBundles.length, 2);
  assert.equal(extensions.providerBundles[0]?.bundle, 'anthropic');
  assert.equal(extensions.providerBundles[0]?.enabled, true);
  assert.equal(extensions.providerBundles[0]?.parameters?.region, 'eu-west-1');
  assert.equal(extensions.providerBundles[0]?.secretReferences?.apiKey, 'env://ANTHROPIC_API_KEY');
  assert.equal(extensions.providerBundles[1]?.enabled, false);
  assert.equal(extensions.media?.storage, 's3');
  assert.equal(extensions.media?.parameters?.bucket, 'media');
  assert.equal(extensions.tlsFingerprint?.profile, 'bench-mock');

  assert.ok(Object.isFrozen(extensions));
  assert.ok(Object.isFrozen(extensions.providerBundles));
  assert.ok(Object.isFrozen(extensions.providerBundles[0]));
  assert.ok(Object.isFrozen(extensions.providerBundles[0]?.parameters));
  assert.ok(Object.isFrozen(extensions.providerBundles[0]?.secretReferences));
  assert.ok(Object.isFrozen(extensions.media));
  assert.ok(Object.isFrozen(extensions.tlsFingerprint));

  // The loader detaches from the caller-owned configuration: later mutation cannot change readback.
  const firstSourceBundle = sourceBundles[0];
  assert.ok(firstSourceBundle);
  firstSourceBundle.enabled = false;
  sourceBundles.push({ bundle: 'late', enabled: true });
  assert.equal(runtime.extensions?.providerBundles.length, 2);
  assert.equal(runtime.extensions?.providerBundles[0]?.enabled, true);

  await runtime.close();
});

test('gateway runtime keeps v1 handles free of the extensions key', async () => {
  const runtime = await loadHandle({
    dependencies: dependencies(),
    checkReady: () => undefined,
    close: () => undefined,
  });
  assert.equal(Object.hasOwn(runtime, 'extensions'), false);
  await runtime.close();
});

test('version 2 accepts typed transport and WebSocket dependencies while version 1 stays exact', async () => {
  const codexEvidenceTransport = {
    async send() {
      return { responseStarted: false };
    },
  };
  const responsesWsRoundExecutor = {
    async executeRound() {
      return { events: [] };
    },
  };
  const runtime = await loadHandle(
    v2Handle({ dependencies: dependencies({ codexEvidenceTransport, responsesWsRoundExecutor }) }),
  );
  assert.equal(runtime.dependencies.codexEvidenceTransport, codexEvidenceTransport);
  assert.ok(runtime.deploymentFacts?.dispatch.routedEndpointScopes.includes('codex-responses'));
  await runtime.close();
  await assertContractInvalid({ dependencies: dependencies({ codexEvidenceTransport }), checkReady() {}, close() {} });
  await assertContractInvalid(v2Handle({ dependencies: dependencies({ codexEvidenceTransport: { send: false } }) }));
  await assertContractInvalid(v2Handle({ dependencies: dependencies({ responsesWsRoundExecutor: () => undefined }) }));
  await assertContractInvalid(v2Handle({ dependencies: dependencies({ providerCredentialUnsealingKms: {} }) }));
});

test('gateway runtime reads the outer version marker before trusting a v2 handle', async (t) => {
  await t.test('rejects unsupported revisions', async () => {
    for (const apiVersion of [1, 3, '2', null]) {
      await assertContractInvalid(v2Handle({ apiVersion }));
    }
  });

  await t.test('rejects a partial v2 upgrade without extensions', async () => {
    await assertContractInvalid({
      apiVersion: 2,
      dependencies: dependencies(),
      checkReady: () => undefined,
      close: () => undefined,
    });
  });

  await t.test('rejects extra handle keys', async () => {
    await assertContractInvalid(v2Handle({ unexpected: true }));
    await assertContractInvalid({
      dependencies: dependencies(),
      checkReady: () => undefined,
      close: () => undefined,
      unexpected: true,
    });
  });

  await t.test('keeps v2 dependencies exact', async () => {
    await assertContractInvalid(v2Handle({ dependencies: dependencies({ unexpected: true }) }));
  });
});

test('gateway runtime keeps the v2 extension sections exact', async (t) => {
  await t.test('requires providerBundles and rejects unknown extension keys', async () => {
    await assertContractInvalid(v2Handle({ extensions: {} }));
    await assertContractInvalid(v2Handle({ extensions: { providerBundles: [], unexpected: true } }));
    await assertContractInvalid(v2Handle({ extensions: { providerBundles: 'anthropic' } }));
  });

  await t.test('accepts an empty bundle list and rejects unbounded lists or duplicated ids', async () => {
    const runtime = await loadHandle(v2Handle({ extensions: { providerBundles: [] } }));
    assert.deepEqual(runtime.extensions?.providerBundles.length, 0);
    await runtime.close();

    await assertContractInvalid(
      v2Handle({
        extensions: {
          providerBundles: Array.from({ length: 65 }, (_value, index) => ({
            bundle: `bundle-${index}`,
            enabled: true,
          })),
        },
      }),
    );
    await assertContractInvalid(
      v2Handle({
        extensions: {
          providerBundles: [
            { bundle: 'anthropic', enabled: true },
            { bundle: 'anthropic', enabled: false },
          ],
        },
      }),
    );
  });

  await t.test('rejects media and tls sections that do not match their exact keys', async () => {
    await assertContractInvalid(v2Handle({ extensions: { providerBundles: [], media: { parameters: {} } } }));
    await assertContractInvalid(
      v2Handle({ extensions: { providerBundles: [], media: { storage: 's3', enabled: true } } }),
    );
    await assertContractInvalid(v2Handle({ extensions: { providerBundles: [], media: { storage: 'S3/../x' } } }));
    await assertContractInvalid(v2Handle({ extensions: { providerBundles: [], tlsFingerprint: { storage: 's3' } } }));
    await assertContractInvalid(
      v2Handle({ extensions: { providerBundles: [], tlsFingerprint: { profile: 'mock', enabled: true } } }),
    );
  });
});

test('gateway runtime bounds provider bundle configuration', async (t) => {
  const withBundle = (bundle: unknown) => v2Handle({ extensions: { providerBundles: [bundle] } });

  await t.test('rejects unknown, missing and mistyped bundle fields', async () => {
    await assertContractInvalid(withBundle({ bundle: 'anthropic', enabled: true, unexpected: true }));
    await assertContractInvalid(withBundle({ bundle: 'anthropic' }));
    await assertContractInvalid(withBundle({ bundle: 'anthropic', enabled: 'yes' }));
    for (const bundle of ['', 'Anthropic', 'a b', '-leading', 'a'.repeat(65)]) {
      await assertContractInvalid(withBundle({ bundle, enabled: true }));
    }
  });

  await t.test('bounds parameter maps and scalar values', async () => {
    await assertContractInvalid(
      withBundle({
        bundle: 'anthropic',
        enabled: true,
        parameters: Object.fromEntries(Array.from({ length: 33 }, (_value, index) => [`key-${index}`, index])),
      }),
    );
    await assertContractInvalid(withBundle({ bundle: 'anthropic', enabled: true, parameters: { '1bad': true } }));
    for (const value of [
      null,
      [1],
      { nested: true },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
    ]) {
      await assertContractInvalid(withBundle({ bundle: 'anthropic', enabled: true, parameters: { value } }));
    }
    await assertContractInvalid(
      withBundle({ bundle: 'anthropic', enabled: true, parameters: { value: 'x'.repeat(4 * 1024 + 1) } }),
    );

    const runtime = await loadHandle(
      withBundle({
        bundle: 'anthropic',
        enabled: true,
        parameters: { text: 'ok', zero: 0, negative: -12, flag: false },
      }),
    );
    assert.equal(runtime.extensions?.providerBundles[0]?.parameters?.zero, 0);
    assert.equal(runtime.extensions?.providerBundles[0]?.parameters?.negative, -12);
    assert.equal(runtime.extensions?.providerBundles[0]?.parameters?.flag, false);
    await runtime.close();
  });

  await t.test('keeps secret references non-empty, printable and bounded', async () => {
    await assertContractInvalid(withBundle({ bundle: 'anthropic', enabled: true, secretReferences: { apiKey: 42 } }));
    await assertContractInvalid(withBundle({ bundle: 'anthropic', enabled: true, secretReferences: { apiKey: '' } }));
    await assertContractInvalid(
      withBundle({ bundle: 'anthropic', enabled: true, secretReferences: { apiKey: 'bad\nreference' } }),
    );
    await assertContractInvalid(
      withBundle({ bundle: 'anthropic', enabled: true, secretReferences: { apiKey: `env://${'x'.repeat(1_024)}` } }),
    );

    const runtime = await loadHandle(
      withBundle({ bundle: 'anthropic', enabled: true, secretReferences: { accessKey: 'kms://media/access-key' } }),
    );
    assert.equal(runtime.extensions?.providerBundles[0]?.secretReferences?.accessKey, 'kms://media/access-key');
    await runtime.close();
  });
});
