import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  GatewayRuntimeModuleError,
  loadManagedSaasGatewayRuntimeModule,
} from '../../../src/saas/runtime/gateway-runtime-module.js';

const MODULE_SPECIFIER = '@trusted/gateway-runtime';
const RUNTIME_MODULE_ENV = 'MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE';
const MAX_KEY_VERSIONS = 8;
const MAX_KEY_BYTES = 4 * 1024;
const MAX_TOTAL_KEY_BYTES = 16 * 1024;

function baseDependencies(affinityKeyring: unknown): Record<string, unknown> {
  return {
    entitlementResolver: {},
    schedulerAuthorities: { affinityKeyring, leaseConcurrencyLimit: 4 },
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
  };
}

function keyring(
  versions: readonly string[] = ['v1'],
  activeKeyVersion = versions.at(-1) ?? 'v1',
): Record<string, unknown> {
  return {
    activeKeyVersion,
    keys: versions.map((version, index) => ({ version, key: new Uint8Array(32).fill(index + 1) })),
  };
}

async function loadRuntime(dependencies: unknown) {
  const runtimeModule = {
    createManagedSaasGatewayRuntime: () => ({
      dependencies,
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
    importer: async () => runtimeModule,
  });
}

async function assertInvalid(dependencies: unknown): Promise<void> {
  await assert.rejects(loadRuntime(dependencies), (error: unknown) => {
    assert.ok(error instanceof GatewayRuntimeModuleError);
    assert.equal(error.code, 'MODULE_CONTRACT_INVALID');
    return true;
  });
}

test('gateway runtime accepts current and still-live compatibility affinity key versions', async () => {
  const runtime = await loadRuntime(baseDependencies(keyring(['key-v1', 'key-v2'], 'key-v2')));
  const configured = runtime.dependencies.schedulerAuthorities.affinityKeyring;
  assert.equal(configured.activeKeyVersion, 'key-v2');
  assert.deepEqual(
    configured.keys.map(({ version }) => version),
    ['key-v1', 'key-v2'],
  );
  await runtime.close();
});

test('gateway runtime defensively copies key bytes and freezes keyring structure', async () => {
  const sourceKey = new Uint8Array(32).fill(0x5a);
  const sourceKeyring = { activeKeyVersion: 'v1', keys: [{ version: 'v1', key: sourceKey }] };
  const runtime = await loadRuntime(baseDependencies(sourceKeyring));
  sourceKey.fill(0);

  const copied = runtime.dependencies.schedulerAuthorities.affinityKeyring;
  assert.equal(copied.keys[0]?.key[0], 0x5a);
  assert.notEqual(copied.keys[0]?.key, sourceKey);
  assert.ok(Object.isFrozen(copied));
  assert.ok(Object.isFrozen(copied.keys));
  assert.ok(Object.isFrozen(copied.keys[0]));
  await runtime.close();
});

test('gateway runtime rejects missing keyrings and legacy plugin-owned affinity ports', async (t) => {
  await t.test('missing keyring', async () => {
    const value = baseDependencies(undefined);
    await assertInvalid(value);
  });

  await t.test('legacy arbitrary affinity port', async () => {
    const value = baseDependencies(undefined);
    value.schedulerAuthorities = {
      affinity: {
        resolve: async () => ({ decision: 'allow', accountId: null }),
        bind: async () => ({ decision: 'allow' }),
      },
      leaseConcurrencyLimit: 4,
    };
    await assertInvalid(value);
  });
});

test('gateway runtime rejects malformed, ambiguous, undersized, and oversized keyrings', async (t) => {
  const invalidCases: Array<[string, unknown]> = [
    ['extra keyring field', { ...keyring(), plaintext: 'must-not-leak' }],
    ['active version missing', keyring(['v1'], 'v2')],
    ['empty keys', { activeKeyVersion: 'v1', keys: [] }],
    ['duplicate versions', keyring(['v1', 'v1'])],
    ['invalid version', keyring(['bad/version'])],
    ['key below minimum', { activeKeyVersion: 'v1', keys: [{ version: 'v1', key: new Uint8Array(31) }] }],
    [
      'key above maximum',
      { activeKeyVersion: 'v1', keys: [{ version: 'v1', key: new Uint8Array(MAX_KEY_BYTES + 1) }] },
    ],
    [
      'too many compatibility versions',
      keyring(Array.from({ length: MAX_KEY_VERSIONS + 1 }, (_, index) => `v${index + 1}`)),
    ],
    [
      'total key material above maximum',
      {
        activeKeyVersion: 'v1',
        keys: Array.from({ length: Math.floor(MAX_TOTAL_KEY_BYTES / MAX_KEY_BYTES) + 1 }, (_, index) => ({
          version: `v${index + 1}`,
          key: new Uint8Array(MAX_KEY_BYTES),
        })),
      },
    ],
  ];

  for (const [name, candidate] of invalidCases) {
    await t.test(name, async () => {
      const value = baseDependencies(candidate);
      await assertInvalid(value);
    });
  }
});

test('keyring validation errors never include supplied secret bytes or diagnostics', async () => {
  const sentinel = 'affinity-key-secret-sentinel';
  const invalid = {
    activeKeyVersion: 'v1',
    keys: [{ version: 'v1', key: new Uint8Array(8).fill(0x51), diagnostic: sentinel }],
  };
  await assert.rejects(loadRuntime(baseDependencies(invalid)), (error: unknown) => {
    assert.ok(error instanceof GatewayRuntimeModuleError);
    assert.equal(error.code, 'MODULE_CONTRACT_INVALID');
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
});
