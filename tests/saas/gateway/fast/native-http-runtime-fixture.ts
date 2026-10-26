// Test-only local TLS target, with real built-in estimator or explicitly named fixed control; all fast ports
// are created by the real CLI composition. Authority callbacks retain real SQL reads.
import { fetch as undiciFetch } from 'undici';
import { createBuiltinUsageUpperBoundEstimator } from '../../../../src/saas/runtime/builtin-usage-bounds.js';
import type {
  ManagedSaasGatewayRuntimeDependencies,
  ManagedSaasGatewayRuntimeModuleHandle,
  ManagedSaasGatewayRuntimeModuleOptions,
} from '../../../../src/saas/runtime/gateway-runtime-module.js';

export interface NativeFastHttpRoute {
  protocol: 'openai';
  providerId: string;
  productId: string;
  providerModel: string;
  publicModel: string;
  endpoint: string;
  poolId: string;
  accountIds: string[];
}
export interface NativeFastHttpConfig {
  estimator: 'builtin' | 'fixed-4096';
  privateKeyFile: string;
  publicKeyFile: string;
  mockPort: number;
  routes: NativeFastHttpRoute[];
  affinityKey: string;
  idempotencyKey: string;
}

export async function createManagedSaasGatewayRuntime(
  options: ManagedSaasGatewayRuntimeModuleOptions,
): Promise<ManagedSaasGatewayRuntimeModuleHandle> {
  const { readFile } = await import('node:fs/promises');
  const { createPrivateKey, createPublicKey, randomUUID } = await import('node:crypto');
  const { createBuiltinGatewayEntitlementResolver } = await import(
    '../../../../src/saas/runtime/builtin-gateway-runtime.js'
  );
  const { TrustedPreparedRequestVerifierKeyRegistry } = await import(
    '../../../../src/saas/runtime/prepared-evidence-verifier-keys.js'
  );
  const { PreparedRequestEvidenceSigner } = await import(
    '../../../../src/saas/runtime/prepared-request-evidence-signer.js'
  );
  const configPath = options.env.NATIVE_FAST_HTTP_CONFIG;
  if (!configPath) throw new Error('Native HTTP fixture configuration is required');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as NativeFastHttpConfig;
  const registry = new TrustedPreparedRequestVerifierKeyRegistry({
    keys: [
      { keyId: 'r9-local-test', publicKey: createPublicKey(await readFile(config.publicKeyFile)), status: 'active' },
    ],
  });
  const signer = new PreparedRequestEvidenceSigner({
    registry,
    verifierKeyId: 'r9-local-test',
    privateKey: createPrivateKey(await readFile(config.privateKeyFile)),
  });
  const endpointPolicy = { allowedHosts: ['127.0.0.1'], allowedPorts: [config.mockPort] };
  // The explicit operator egress allowlist permits this one loopback address;
  // the core transport still checks TLS, exact host/port and address pinning.
  // No test-runner capability or environment marker is fabricated.
  const targets: ManagedSaasGatewayRuntimeDependencies['providerTargetResolver'] = {
    resolve(input) {
      const route = config.routes.find(
        (entry) =>
          entry.poolId === input.upstreamId &&
          entry.productId === (input.productId ?? input.product) &&
          entry.protocol === input.protocol,
      );
      if (!route || input.operation !== (route.protocol === 'openai' ? 'chat.completions' : 'messages'))
        throw new Error('R9 fixed mock target is unavailable');
      return { url: `https://127.0.0.1:${config.mockPort}${route.endpoint}`, method: 'POST', endpointPolicy };
    },
  };
  return {
    dependencies: {
      entitlementResolver: createBuiltinGatewayEntitlementResolver(options.database),
      schedulerAuthorities: {
        affinityKeyring: {
          activeKeyVersion: 'r9-test-v1',
          keys: [{ version: 'r9-test-v1', key: Buffer.from(config.affinityKey, 'base64') }],
        },
        leaseConcurrencyLimit: 64,
      },
      idempotencyHmacKey: Buffer.from(config.idempotencyKey, 'base64'),
      providerPreparationRoute: async ({ authority }) => {
        if (!authority.modelResolution) throw new Error('Missing model resolution');
        return {
          clientProtocol: authority.route.protocol,
          providerProtocol: authority.route.protocol,
          clientOperation: authority.route.protocol === 'openai' ? 'chat.completions' : 'messages',
          providerOperation: authority.route.protocol === 'openai' ? 'chat.completions' : 'messages',
          modelResolution: authority.modelResolution,
        };
      },
      providerPayload: {
        estimator:
          config.estimator === 'builtin'
            ? createBuiltinUsageUpperBoundEstimator({ maxInputTokens: 262144, maxOutputTokens: 131072 })
            : {
                version: 'r9-local-mock-upper-bound/v1',
                estimate: () => ({
                  inputTotalUpperBound: 4096,
                  inputUncachedUpperBound: 4096,
                  cacheReadUpperBound: 0,
                  cacheWriteUpperBound: 0,
                  cacheWrite5mUpperBound: 0,
                  cacheWrite1hUpperBound: 0,
                  outputTotalUpperBound: 4096,
                  reasoningOutputUpperBound: 0,
                  feasibleInputBuckets: ['input'],
                }),
              },
        modelCompatibility: async (input) => {
          const result = await options.database.query<{
            support_level: string;
            validation_state: string;
            protocol: string;
          }>(
            'SELECT support_level, validation_state, protocol FROM saas_provider_capabilities WHERE provider_id=$1 AND product_id=$2 AND model=$3 AND endpoint=ANY($4::text[]) ORDER BY version DESC LIMIT 1',
            [input.providerId, input.productId, input.providerModel, ['/v1/chat/completions']],
          );
          const row = result.rows[0];
          return (
            row?.support_level === 'supported' &&
            row.validation_state === 'verified' &&
            row.protocol === input.providerProtocol
          );
        },
        maxPayloadBytes: 1048576,
        compilerVersion: 'r9-local-mock-test-compiler/v1',
      },
      evidenceSigner: signer,
      evidenceVerifierKeyId: 'r9-local-test',
      idFactory: { requestId: randomUUID, attemptId: randomUUID, evidenceId: randomUUID },
      trustedVerifierPublicKeys: new Map([['r9-local-test', createPublicKey(await readFile(config.publicKeyFile))]]),
      providerTargetResolver: targets,
      providerTargetRoute: async (input) => {
        const route = config.routes.find((route) => route.poolId === input.upstreamId);
        return route
          ? {
              productId: route.productId,
              providerProtocol: route.protocol,
              providerOperation: route.protocol === 'openai' ? 'chat.completions' : 'messages',
            }
          : null;
      },
      resolveAuthenticationHeader: async (input) => {
        const result = await options.database.query<{ credential_type: string }>(
          'SELECT account.credential_type FROM saas_platform_provider_credentials credential JOIN saas_platform_provider_accounts account ON account.id=credential.account_id WHERE credential.id=$1 AND account.id=$2 UNION ALL SELECT account.credential_type FROM saas_tenant_provider_credentials credential JOIN saas_tenant_provider_accounts account ON account.tenant_id=credential.tenant_id AND account.id=credential.account_id WHERE credential.tenant_id=$3 AND credential.id=$1 AND account.id=$2',
          [input.credentialId, input.accountId, input.tenantId],
        );
        if (result.rows.length !== 1 || result.rows[0]?.credential_type !== 'api-key')
          throw new Error('Fixture credential policy unavailable');
        return 'authorization';
      },
      fetch: (url, init) => undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
      endpointPolicy,
      timeoutMs: 60000,
      maxConcurrency: 64,
      leaseTtlMs: 90000,
      maxBodyBytes: 1048576,
      entryPoint: 'r9-current-build-mock-test-assembly',
    },
    checkReady: async () => {},
    close: async () => {},
  };
}
