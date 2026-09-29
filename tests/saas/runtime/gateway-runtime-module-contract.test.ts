import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { createProviderHttpTestAddressCapability } from '../../../src/saas/gateway/provider-http-address.js';
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

async function loadRuntime(runtimeDependencies: unknown) {
  const module = {
    createManagedSaasGatewayRuntime: () => ({
      dependencies: runtimeDependencies,
      checkReady: () => undefined,
      close: () => undefined,
    }),
  };

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

async function assertContractInvalid(runtimeDependencies: unknown): Promise<void> {
  await assert.rejects(loadRuntime(runtimeDependencies), (error: unknown) => {
    assert.ok(error instanceof GatewayRuntimeModuleError);
    assert.equal(error.code, 'MODULE_CONTRACT_INVALID');
    return true;
  });
}

test('gateway runtime accepts its dependency contract with core-owned affinity key metadata', async () => {
  const runtime = await loadRuntime(dependencies());
  await runtime.checkReady();
  await runtime.close();
});

test('gateway runtime forwards the optional local HTTPS capability only inside a test composition', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const capability = createProviderHttpTestAddressCapability(
      '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----',
    );
    const runtime = await loadRuntime(dependencies({ providerHttpTestAddressCapability: capability }));
    assert.equal(runtime.dependencies.providerHttpTestAddressCapability, capability);
    await runtime.close();

    process.env.NODE_ENV = 'production';
    await assertContractInvalid(dependencies({ providerHttpTestAddressCapability: capability }));
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('gateway runtime keeps dependency and scheduler-authority keys exact', async (t) => {
  await t.test('extra dependency key', async () => {
    await assertContractInvalid(dependencies({ unexpected: true }));
  });

  await t.test('extra scheduler-authority key', async () => {
    await assertContractInvalid({
      ...dependencies(),
      schedulerAuthorities: {
        affinityKeyring: affinityKeyring(),
        leaseConcurrencyLimit: 4,
        unexpected: true,
      },
    });
  });
});

test('gateway runtime keeps leaseConcurrencyLimit as a positive safe integer', async (t) => {
  for (const invalidLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
    await t.test(String(invalidLimit), async () => {
      await assertContractInvalid({
        ...dependencies(),
        schedulerAuthorities: {
          affinityKeyring: affinityKeyring(),
          leaseConcurrencyLimit: invalidLimit,
        },
      });
    });
  }
});
