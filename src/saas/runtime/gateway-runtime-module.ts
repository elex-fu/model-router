import type { ManagedSaasGatewayProductionOptions } from '../../server/managed-saas-gateway.js';
import type { SaasDatabase } from '../db/types.js';
import {
  type DeploymentEnvironment,
  type DeploymentListenerConfig,
  type ManagedSaasDeploymentConfig,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
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
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../deployment.js';
import type { PostgresProviderAccountAffinityHmacKey } from '../gateway/postgres-provider-account-affinity.js';
import { isProviderHttpTestAddressCapability } from '../gateway/provider-http-address.js';
import type { RequestPreparationEntitlementPort } from '../gateway/request-preparation-service.js';
import type { ProviderAwaitable, ProviderEnvironment, ProviderModuleImporter } from './providers.js';
import { resolveProviderModuleSpecifier } from './providers.js';

type CoreOwnedGatewayOption =
  | 'caller'
  | 'entitlement'
  | 'admission'
  | 'attempt'
  | 'compensation'
  | 'schedulerAffinity'
  | 'idempotencyHmacKey'
  | 'providerCredentialUnsealingKms'
  | 'credentialContext';

/** Runtime supplied capabilities; PostgreSQL preparation ports and KMS stay core-owned. */
export type ManagedSaasGatewayRuntimeDependencies = Omit<
  ManagedSaasGatewayProductionOptions,
  CoreOwnedGatewayOption
> & {
  readonly entitlementResolver: RequestPreparationEntitlementPort;
  /** Trusted HMAC key material; persistence and lookup are always core-owned PostgreSQL. */
  readonly schedulerAuthorities: Readonly<{
    affinityKeyring: GatewayProviderAccountAffinityKeyring;
    leaseConcurrencyLimit: number;
  }>;
  readonly idempotencyHmacKey: Uint8Array;
};

/** Every live version must remain available until its persisted affinity rows expire. */
export interface GatewayProviderAccountAffinityKeyring {
  readonly activeKeyVersion: string;
  readonly keys: readonly PostgresProviderAccountAffinityHmacKey[];
}

export interface ManagedSaasGatewayRuntimeModuleOptions {
  readonly database: SaasDatabase;
  readonly deployment: Readonly<{
    workloadRole: 'gateway';
    deploymentId: string;
    environmentId: string;
    listener: DeploymentListenerConfig<'gateway'>;
  }>;
  /** Snapshot excludes database URLs and control-plane provider/KMS settings. */
  readonly env: ProviderEnvironment;
  /** Register construction-time rollback hooks; successful factories transfer ownership to close(). */
  readonly lifecycle: Readonly<{
    registerCloseHook(hook: () => ProviderAwaitable<void>): void;
  }>;
}

export interface ManagedSaasGatewayRuntimeModuleHandle {
  readonly dependencies: ManagedSaasGatewayRuntimeDependencies;
  checkReady(): ProviderAwaitable<void>;
  close(): ProviderAwaitable<void>;
}

/** Trusted gateway modules export this factory; they never receive HTTP/listener ownership. */
export interface ManagedSaasGatewayRuntimeModule {
  createManagedSaasGatewayRuntime(
    options: ManagedSaasGatewayRuntimeModuleOptions,
  ): ProviderAwaitable<ManagedSaasGatewayRuntimeModuleHandle>;
}

export interface LoadedManagedSaasGatewayRuntimeModule {
  readonly dependencies: ManagedSaasGatewayRuntimeDependencies;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export interface LoadManagedSaasGatewayRuntimeModuleOptions {
  readonly deployment: ManagedSaasDeploymentConfig;
  readonly database: SaasDatabase;
  readonly environment: DeploymentEnvironment;
  readonly importer?: ProviderModuleImporter;
  readonly cwd?: string;
}

export type GatewayRuntimeModuleErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_MODULE_SPECIFIER'
  | 'MODULE_LOAD_FAILED'
  | 'MODULE_EXPORT_INVALID'
  | 'FACTORY_FAILED'
  | 'MODULE_CONTRACT_INVALID'
  | 'READINESS_FAILED'
  | 'CLOSE_FAILED';

const ERROR_MESSAGES: Readonly<Record<GatewayRuntimeModuleErrorCode, string>> = Object.freeze({
  INVALID_CONFIGURATION: 'Managed SaaS gateway runtime configuration is invalid',
  INVALID_MODULE_SPECIFIER: 'Managed SaaS gateway runtime module setting is invalid',
  MODULE_LOAD_FAILED: 'Managed SaaS gateway runtime module could not be loaded',
  MODULE_EXPORT_INVALID: 'Managed SaaS gateway runtime module export is invalid',
  FACTORY_FAILED: 'Managed SaaS gateway runtime setup failed',
  MODULE_CONTRACT_INVALID: 'Managed SaaS gateway runtime module contract is incomplete',
  READINESS_FAILED: 'Managed SaaS gateway runtime readiness failed',
  CLOSE_FAILED: 'Managed SaaS gateway runtime cleanup failed',
});

export class GatewayRuntimeModuleError extends Error {
  constructor(readonly code: GatewayRuntimeModuleErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GatewayRuntimeModuleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type UnknownFunction = (...args: unknown[]) => unknown;

const DEPENDENCY_KEYS = Object.freeze([
  'entitlementResolver',
  'schedulerAuthorities',
  'idempotencyHmacKey',
  'providerPreparationRoute',
  'providerPayload',
  'evidenceSigner',
  'evidenceVerifierKeyId',
  'idFactory',
  'trustedVerifierPublicKeys',
  'providerTargetResolver',
  'providerTargetRoute',
  'resolveAuthenticationHeader',
  'fetch',
  'endpointPolicy',
  'timeoutMs',
  'maxConcurrency',
  'leaseTtlMs',
  'maxBodyBytes',
  'entryPoint',
] as const);

const TEST_DEPENDENCY_KEYS = Object.freeze([...DEPENDENCY_KEYS, 'providerHttpTestAddressCapability'] as const);

const AFFINITY_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_AFFINITY_KEY_VERSIONS = 8;
const MAX_AFFINITY_KEY_BYTES = 4 * 1024;
const MAX_TOTAL_AFFINITY_KEY_BYTES = 16 * 1024;

const EXCLUDED_ENVIRONMENT_NAMES = new Set<string>([
  MODEL_ROUTER_SAAS_DATABASE_URL,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
  MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
  MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
]);

function moduleError(code: GatewayRuntimeModuleErrorCode): GatewayRuntimeModuleError {
  return new GatewayRuntimeModuleError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundMethod(value: unknown, name: string): UnknownFunction | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const candidate = value[name];
    return typeof candidate === 'function' ? (candidate.bind(value) as UnknownFunction) : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    return (
      actual.length === expected.length && actual.every((key) => typeof key === 'string' && expected.includes(key))
    );
  } catch {
    return false;
  }
}

function copyRuntimeEnvironment(environment: DeploymentEnvironment): ProviderEnvironment {
  try {
    if (!isRecord(environment)) throw new Error('invalid environment');
    const keys = Object.keys(environment);
    if (keys.length > 512) throw new Error('too many environment values');
    const snapshot = Object.create(null) as Record<string, string | undefined>;
    let totalBytes = 0;
    for (const key of keys) {
      if (EXCLUDED_ENVIRONMENT_NAMES.has(key)) continue;
      const value = environment[key];
      if (value !== undefined && typeof value !== 'string') throw new Error('invalid environment value');
      const keyBytes = Buffer.byteLength(key, 'utf8');
      const valueBytes = value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
      if (keyBytes === 0 || keyBytes > 256 || valueBytes > 16 * 1024) throw new Error('oversized environment value');
      totalBytes += keyBytes + valueBytes;
      if (totalBytes > 256 * 1024) throw new Error('oversized environment');
      Object.defineProperty(snapshot, key, { enumerable: true, value, writable: false, configurable: false });
    }
    return Object.freeze(snapshot);
  } catch {
    throw moduleError('INVALID_CONFIGURATION');
  }
}

function closeOnce(close: UnknownFunction): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve()
      .then(() => close())
      .then(() => undefined)
      .catch(() => {
        throw moduleError('CLOSE_FAILED');
      });
    return result;
  };
}

async function closeQuietly(close: (() => Promise<void>) | undefined): Promise<void> {
  if (!close) return;
  try {
    await close();
  } catch {
    // Retain the setup failure while still attempting module cleanup.
  }
}

function checkedDependencies(value: unknown): ManagedSaasGatewayRuntimeDependencies {
  const productionContract = hasExactKeys(value, DEPENDENCY_KEYS);
  const testContract = hasExactKeys(value, TEST_DEPENDENCY_KEYS);
  if (!productionContract && !testContract) throw moduleError('MODULE_CONTRACT_INVALID');
  if (
    testContract &&
    (process.env.NODE_ENV !== 'test' || !isProviderHttpTestAddressCapability(value.providerHttpTestAddressCapability))
  ) {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
  const rawKey = value.idempotencyHmacKey;
  if (!(rawKey instanceof Uint8Array) || rawKey.byteLength < 32) throw moduleError('MODULE_CONTRACT_INVALID');
  let idempotencyHmacKey: Uint8Array;
  try {
    idempotencyHmacKey = Uint8Array.from(rawKey);
  } catch {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
  if (typeof value.evidenceVerifierKeyId !== 'string' || value.evidenceVerifierKeyId.trim() === '') {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
  let schedulerAuthorities: ManagedSaasGatewayRuntimeDependencies['schedulerAuthorities'];
  try {
    const authorities = value.schedulerAuthorities;
    if (
      !hasExactKeys(authorities, ['affinityKeyring', 'leaseConcurrencyLimit']) ||
      !Number.isSafeInteger(authorities.leaseConcurrencyLimit) ||
      (authorities.leaseConcurrencyLimit as number) < 1
    ) {
      throw moduleError('MODULE_CONTRACT_INVALID');
    }
    schedulerAuthorities = Object.freeze({
      affinityKeyring: checkedAffinityKeyring(authorities.affinityKeyring),
      leaseConcurrencyLimit: authorities.leaseConcurrencyLimit as number,
    });
  } catch {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
  return Object.freeze({
    ...value,
    idempotencyHmacKey,
    schedulerAuthorities,
  }) as ManagedSaasGatewayRuntimeDependencies;
}

function checkedAffinityKeyring(value: unknown): GatewayProviderAccountAffinityKeyring {
  try {
    if (!hasExactKeys(value, ['activeKeyVersion', 'keys'])) throw moduleError('MODULE_CONTRACT_INVALID');
    const activeKeyVersion = value.activeKeyVersion;
    const rawKeys = value.keys;
    if (
      typeof activeKeyVersion !== 'string' ||
      !AFFINITY_KEY_VERSION.test(activeKeyVersion) ||
      !Array.isArray(rawKeys) ||
      !Number.isSafeInteger(rawKeys.length) ||
      rawKeys.length < 1 ||
      rawKeys.length > MAX_AFFINITY_KEY_VERSIONS
    ) {
      throw moduleError('MODULE_CONTRACT_INVALID');
    }

    const versions = new Set<string>();
    const keys: PostgresProviderAccountAffinityHmacKey[] = [];
    let totalBytes = 0;
    for (const rawKey of rawKeys) {
      if (!hasExactKeys(rawKey, ['version', 'key'])) throw moduleError('MODULE_CONTRACT_INVALID');
      const version = rawKey.version;
      const key = rawKey.key;
      if (
        typeof version !== 'string' ||
        !AFFINITY_KEY_VERSION.test(version) ||
        versions.has(version) ||
        !(key instanceof Uint8Array) ||
        !Number.isSafeInteger(key.byteLength) ||
        key.byteLength < 32 ||
        key.byteLength > MAX_AFFINITY_KEY_BYTES
      ) {
        throw moduleError('MODULE_CONTRACT_INVALID');
      }
      versions.add(version);
      totalBytes += key.byteLength;
      if (totalBytes > MAX_TOTAL_AFFINITY_KEY_BYTES) throw moduleError('MODULE_CONTRACT_INVALID');
      keys.push(Object.freeze({ version, key: Uint8Array.from(key) }));
    }
    if (!versions.has(activeKeyVersion)) throw moduleError('MODULE_CONTRACT_INVALID');
    return Object.freeze({ activeKeyVersion, keys: Object.freeze(keys) });
  } catch {
    // Keep contract errors independent of key contents, versions, and module diagnostics.
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
}

/** Load the trusted gateway runtime module. This function accepts gateway deployments only. */
export async function loadManagedSaasGatewayRuntimeModule(
  options: LoadManagedSaasGatewayRuntimeModuleOptions,
): Promise<LoadedManagedSaasGatewayRuntimeModule> {
  const { deployment, database, environment } = options;
  const gatewayListener = deployment.listeners.gateway;
  if (
    deployment?.mode !== 'managed-saas' ||
    deployment.workloadRole !== 'gateway' ||
    typeof deployment.gatewayRuntimeModule !== 'string' ||
    deployment.gatewayRuntimeModule.trim() === '' ||
    typeof environment[MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE] !== 'string' ||
    environment[MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE] !== deployment.gatewayRuntimeModule ||
    !database ||
    typeof database.transaction !== 'function' ||
    !gatewayListener ||
    gatewayListener.routePrefix !== '/v1'
  ) {
    throw moduleError('INVALID_CONFIGURATION');
  }

  const gatewayListenerConfig: DeploymentListenerConfig<'gateway'> = {
    ...gatewayListener,
    routePrefix: '/v1',
  };

  let specifier: string;
  try {
    specifier = resolveProviderModuleSpecifier(deployment.gatewayRuntimeModule, options.cwd);
  } catch {
    throw moduleError('INVALID_MODULE_SPECIFIER');
  }

  let imported: unknown;
  try {
    imported = await (options.importer ?? ((name: string) => import(name)))(specifier);
  } catch {
    throw moduleError('MODULE_LOAD_FAILED');
  }
  const factory = boundMethod(imported, 'createManagedSaasGatewayRuntime');
  if (!factory) throw moduleError('MODULE_EXPORT_INVALID');

  const runtimeModuleOptions: Omit<ManagedSaasGatewayRuntimeModuleOptions, 'lifecycle'> = Object.freeze({
    database,
    deployment: Object.freeze({
      workloadRole: 'gateway',
      deploymentId: deployment.deploymentId,
      environmentId: deployment.environmentId,
      listener: gatewayListenerConfig,
    }),
    env: copyRuntimeEnvironment(environment),
  });

  const partialCloseHooks: UnknownFunction[] = [];
  let factoryFinished = false;
  const runtimeLifecycle = Object.freeze({
    registerCloseHook(hook: unknown) {
      if (factoryFinished || typeof hook !== 'function') throw moduleError('MODULE_CONTRACT_INVALID');
      partialCloseHooks.push(hook as UnknownFunction);
    },
  });
  const closePartialResources = async (): Promise<void> => {
    const hooks = [...partialCloseHooks].reverse();
    partialCloseHooks.length = 0;
    for (const hook of hooks) await hook();
  };
  let partialHooksTransferred = false;

  let raw: unknown;
  try {
    raw = await factory(Object.freeze({ ...runtimeModuleOptions, lifecycle: runtimeLifecycle }));
  } catch {
    factoryFinished = true;
    await closeQuietly(closeOnce(closePartialResources));
    throw moduleError('FACTORY_FAILED');
  }
  factoryFinished = true;

  const rawClose = boundMethod(raw, 'close');
  const cleanup = rawClose
    ? closeOnce(async () => {
        let closeFailure: unknown;
        try {
          await rawClose();
        } catch (error) {
          closeFailure = error;
        }
        if (!partialHooksTransferred) {
          try {
            await closePartialResources();
          } catch (error) {
            closeFailure ??= error;
          }
        }
        if (closeFailure !== undefined) throw closeFailure;
      })
    : undefined;
  try {
    if (!hasExactKeys(raw, ['dependencies', 'checkReady', 'close'])) {
      throw moduleError('MODULE_CONTRACT_INVALID');
    }
    const checkReady = boundMethod(raw, 'checkReady');
    if (!checkReady || !cleanup) throw moduleError('MODULE_CONTRACT_INVALID');
    const dependencies = checkedDependencies(raw.dependencies);
    partialHooksTransferred = true;
    partialCloseHooks.length = 0;
    return Object.freeze({
      dependencies,
      checkReady: async () => {
        try {
          await checkReady();
        } catch {
          throw moduleError('READINESS_FAILED');
        }
      },
      close: cleanup,
    });
  } catch (error) {
    await closeQuietly(cleanup);
    if (!cleanup) await closeQuietly(closeOnce(closePartialResources));
    if (error instanceof GatewayRuntimeModuleError) throw error;
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
}
