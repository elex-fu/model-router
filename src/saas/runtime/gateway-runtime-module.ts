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
  MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
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
import type { GatewayCapabilityReadiness } from './gateway-capability-readiness.js';
import type { GatewayCapabilityDeploymentFacts } from './provider-bundle-readiness-facts.js';
import type { ProviderAwaitable, ProviderEnvironment, ProviderModuleImporter } from './providers.js';
import { resolveProviderModuleSpecifier } from './providers.js';

type CoreOwnedGatewayOption =
  | 'maxHttpInFlight'
  | 'caller'
  | 'entitlement'
  | 'admission'
  | 'attempt'
  | 'compensation'
  | 'schedulerAffinity'
  | 'idempotencyHmacKey'
  | 'providerCredentialUnsealingKms'
  | 'credentialContext'
  | 'capabilityReadiness'
  | 'preparationObserver'
  | 'dispatchObserver'
  | 'preparationFailureObserver';

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
  /** Snapshot excludes database URLs, Redis URLs, and control-plane provider/KMS settings. */
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

/**
 * v2 extension configuration (core-plan §6.1). Extensions stay declarative:
 * bounded scalars and secret references only — never executable content or raw
 * credentials — and every section keeps exact-key validation. The built-in
 * assembly (design §6.2) resolves references through core-owned credential,
 * entitlement and catalog services; an extension never widens core ownership.
 */
export type GatewayRuntimeExtensionScalar = string | number | boolean;

export type GatewayRuntimeExtensionScalarMap = Readonly<Record<string, GatewayRuntimeExtensionScalar>>;

export type GatewayRuntimeExtensionSecretReferences = Readonly<Record<string, string>>;

/** A built-in provider bundle selection; the bundle registry owns the known ids and their parameter schemas. */
export interface ProviderBundleConfiguration {
  readonly bundle: string;
  readonly enabled: boolean;
  readonly parameters?: GatewayRuntimeExtensionScalarMap;
  readonly secretReferences?: GatewayRuntimeExtensionSecretReferences;
}

export interface MediaStorageConfiguration {
  readonly storage: string;
  readonly parameters?: GatewayRuntimeExtensionScalarMap;
  readonly secretReferences?: GatewayRuntimeExtensionSecretReferences;
}

export interface TlsSidecarConfiguration {
  readonly profile: string;
  readonly parameters?: GatewayRuntimeExtensionScalarMap;
  readonly secretReferences?: GatewayRuntimeExtensionSecretReferences;
}

export interface GatewayRuntimeModuleExtensionsV2 {
  readonly providerBundles: readonly ProviderBundleConfiguration[];
  readonly media?: MediaStorageConfiguration;
  readonly tlsFingerprint?: TlsSidecarConfiguration;
}

/** v2 handle: the outermost `apiVersion` selects the contract revision before anything else is read. */
export interface ManagedSaasGatewayRuntimeModuleHandleV2 {
  readonly apiVersion: 2;
  readonly dependencies: ManagedSaasGatewayRuntimeDependencies;
  readonly extensions: GatewayRuntimeModuleExtensionsV2;
  checkReady(): ProviderAwaitable<void>;
  close(): ProviderAwaitable<void>;
}

/** v2 modules export the same factory name and return a versioned handle. */
export interface ManagedSaasGatewayRuntimeModuleV2 {
  createManagedSaasGatewayRuntime(
    options: ManagedSaasGatewayRuntimeModuleOptions,
  ): ProviderAwaitable<ManagedSaasGatewayRuntimeModuleHandleV2>;
}

export interface LoadedManagedSaasGatewayRuntimeModule {
  readonly dependencies: ManagedSaasGatewayRuntimeDependencies;
  /** Present only for v2 modules; v1 handles never carry the key. */
  readonly extensions?: GatewayRuntimeModuleExtensionsV2;
  /** Observations of mounted production faces, copied by the readiness collector. */
  readonly deploymentFacts?: GatewayCapabilityDeploymentFacts;
  getCapabilityReadiness?(): Promise<GatewayCapabilityReadiness>;
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

/** Version 2 adds typed dispatch/operations faces; no core auth, KMS or listener ownership is delegated. */
const V2_OPTIONAL_DEPENDENCY_KEYS = Object.freeze([
  'providerHttpEgressAllowlist',
  'codexEvidenceTransport',
  'claudeEvidenceTransport',
  'geminiEvidenceTransport',
  'opencodeGoEvidenceTransport',
  'cnProvidersEvidenceTransport',
  'grokEvidenceTransport',
  'bedrockEvidenceTransport',
  'vertexEvidenceTransport',
  'responsesCompactEvidenceTransport',
  'providerEvidenceTransports',
  'providerNativeProtocol',
  'responsesWsRoundExecutor',
  'responsesWsLimits',
  'responsesCompactNativeSupply',
  'pluginRouting',
  'opencodeGoProtocolRouting',
  'opencodeGoCrossResponsesRouting',
  'cnProvidersProtocolRouting',
  'imageMedia',
  'videoMedia',
  'openRouterAttribution',
  'egressProxyResolution',
  'tlsFingerprintResolution',
  'customerWebhooks',
  'schedulerStrategies',
  'schedulerStickyWait',
  'schedulerRedisConcurrencySlots',
  'schedulerAffinityStickyCache',
  'trustedProxyCidrs',
  'modelPlazaSettingsOverlay',
  'modelPlazaSessionAuth',
  'riskControl',
] as const);

/**
 * Exact handle shapes: v1 modules stay byte-identical, and v2 is recognized
 * only when the full five-key shape is present (an `apiVersion` on an
 * otherwise-v1 handle is rejected — the outer version marker never partially
 * upgrades a contract).
 */
const V1_HANDLE_KEYS = Object.freeze(['dependencies', 'checkReady', 'close'] as const);
const V2_HANDLE_KEYS = Object.freeze(['apiVersion', 'dependencies', 'extensions', 'checkReady', 'close'] as const);

const EXTENSION_KEYS: readonly string[] = Object.freeze(['providerBundles', 'media', 'tlsFingerprint'] as const);
const BUNDLE_KEYS = Object.freeze(['bundle', 'enabled', 'parameters', 'secretReferences'] as const);
const MEDIA_KEYS = Object.freeze(['storage', 'parameters', 'secretReferences'] as const);
const TLS_FINGERPRINT_KEYS = Object.freeze(['profile', 'parameters', 'secretReferences'] as const);

const EXTENSION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EXTENSION_KEY = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
const MAX_PROVIDER_BUNDLES = 64;
const MAX_EXTENSION_MAP_ENTRIES = 32;
const MAX_EXTENSION_STRING_BYTES = 4 * 1024;
const MAX_SECRET_REFERENCE_BYTES = 1024;

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
  // The gateway-scoped Redis URL is also excluded: core owns the gateway
  // RESP connection and its lifecycle, handing the runtime module already
  // constructed capabilities — the module never dials Redis on its own.
  MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

/** The outermost version marker: v1 keeps its exact shape, v2 must match the full five-key handle. */
function detectHandleContract(value: unknown): 'v1' | 'v2' | undefined {
  if (hasExactKeys(value, V1_HANDLE_KEYS)) return 'v1';
  if (hasExactKeys(value, V2_HANDLE_KEYS)) return 'v2';
  return undefined;
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

function checkedDependencies(value: unknown, version: 'v1' | 'v2' = 'v1'): ManagedSaasGatewayRuntimeDependencies {
  const productionContract = hasExactKeys(value, DEPENDENCY_KEYS);
  const testContract = hasExactKeys(value, TEST_DEPENDENCY_KEYS);
  const v2Contract =
    version === 'v2' &&
    isRecord(value) &&
    DEPENDENCY_KEYS.every((key) => hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        (
          [...DEPENDENCY_KEYS, ...V2_OPTIONAL_DEPENDENCY_KEYS, 'providerHttpTestAddressCapability'] as readonly string[]
        ).includes(key),
    );
  if (!productionContract && !testContract && !v2Contract) throw moduleError('MODULE_CONTRACT_INVALID');
  if (
    hasOwn(value, 'providerHttpTestAddressCapability') &&
    (process.env.NODE_ENV !== 'test' || !isProviderHttpTestAddressCapability(value.providerHttpTestAddressCapability))
  ) {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
  if (v2Contract) {
    for (const key of [
      'codexEvidenceTransport',
      'claudeEvidenceTransport',
      'geminiEvidenceTransport',
      'opencodeGoEvidenceTransport',
      'cnProvidersEvidenceTransport',
      'grokEvidenceTransport',
      'bedrockEvidenceTransport',
      'vertexEvidenceTransport',
      'responsesCompactEvidenceTransport',
    ] as const) {
      if (hasOwn(value, key) && !boundMethod(value[key], 'send')) throw moduleError('MODULE_CONTRACT_INVALID');
    }
    for (const key of [
      'providerEvidenceTransports',
      'providerNativeProtocol',
      'responsesCompactNativeSupply',
    ] as const) {
      if (hasOwn(value, key) && typeof value[key] !== 'function') throw moduleError('MODULE_CONTRACT_INVALID');
    }
    if (hasOwn(value, 'responsesWsRoundExecutor') && !boundMethod(value.responsesWsRoundExecutor, 'executeRound'))
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

function checkedExtensionScalarMap(value: unknown): GatewayRuntimeExtensionScalarMap {
  try {
    if (!isRecord(value)) throw moduleError('MODULE_CONTRACT_INVALID');
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_EXTENSION_MAP_ENTRIES) throw moduleError('MODULE_CONTRACT_INVALID');
    const snapshot = Object.create(null) as Record<string, GatewayRuntimeExtensionScalar>;
    for (const key of keys) {
      if (typeof key !== 'string' || !EXTENSION_KEY.test(key)) throw moduleError('MODULE_CONTRACT_INVALID');
      const scalar = (value as Record<string, unknown>)[key];
      if (typeof scalar === 'string') {
        if (Buffer.byteLength(scalar, 'utf8') > MAX_EXTENSION_STRING_BYTES)
          throw moduleError('MODULE_CONTRACT_INVALID');
      } else if (typeof scalar === 'number') {
        // Bounded finite numbers only: NaN, Infinity and precision-loss values are configuration errors.
        if (!Number.isFinite(scalar) || Math.abs(scalar) > Number.MAX_SAFE_INTEGER) {
          throw moduleError('MODULE_CONTRACT_INVALID');
        }
      } else if (typeof scalar !== 'boolean') {
        throw moduleError('MODULE_CONTRACT_INVALID');
      }
      Object.defineProperty(snapshot, key, { enumerable: true, value: scalar, writable: false, configurable: false });
    }
    return Object.freeze(snapshot);
  } catch {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
}

function checkedSecretReferences(value: unknown): GatewayRuntimeExtensionSecretReferences {
  try {
    if (!isRecord(value)) throw moduleError('MODULE_CONTRACT_INVALID');
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_EXTENSION_MAP_ENTRIES) throw moduleError('MODULE_CONTRACT_INVALID');
    const snapshot = Object.create(null) as Record<string, string>;
    for (const key of keys) {
      if (typeof key !== 'string' || !EXTENSION_KEY.test(key)) throw moduleError('MODULE_CONTRACT_INVALID');
      const reference = (value as Record<string, unknown>)[key];
      if (
        typeof reference !== 'string' ||
        reference.length === 0 ||
        Buffer.byteLength(reference, 'utf8') > MAX_SECRET_REFERENCE_BYTES ||
        hasControlCharacters(reference)
      ) {
        throw moduleError('MODULE_CONTRACT_INVALID');
      }
      Object.defineProperty(snapshot, key, {
        enumerable: true,
        value: reference,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
}

/** References must be printable: control characters never belong in a configuration reference. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

type CheckedExtensionSection = Readonly<{
  identity: string;
  enabled?: boolean;
  parameters?: GatewayRuntimeExtensionScalarMap;
  secretReferences?: GatewayRuntimeExtensionSecretReferences;
}>;

function checkedExtensionSection(
  value: unknown,
  identityKey: 'bundle' | 'storage' | 'profile',
  allowedKeys: readonly string[],
): CheckedExtensionSection {
  if (!isRecord(value)) throw moduleError('MODULE_CONTRACT_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw moduleError('MODULE_CONTRACT_INVALID');
  }
  const identity = value[identityKey];
  if (typeof identity !== 'string' || !EXTENSION_ID.test(identity)) throw moduleError('MODULE_CONTRACT_INVALID');
  const section: {
    identity: string;
    enabled?: boolean;
    parameters?: GatewayRuntimeExtensionScalarMap;
    secretReferences?: GatewayRuntimeExtensionSecretReferences;
  } = { identity };
  if (hasOwn(value, 'enabled')) {
    const enabled = value.enabled;
    if (typeof enabled !== 'boolean') throw moduleError('MODULE_CONTRACT_INVALID');
    section.enabled = enabled;
  }
  if (hasOwn(value, 'parameters')) section.parameters = checkedExtensionScalarMap(value.parameters);
  if (hasOwn(value, 'secretReferences')) section.secretReferences = checkedSecretReferences(value.secretReferences);
  return section;
}

function checkedBundleConfiguration(value: unknown): ProviderBundleConfiguration {
  const section = checkedExtensionSection(value, 'bundle', BUNDLE_KEYS);
  // `enabled` is explicit: readiness must never assume an assembled bundle was requested.
  if (section.enabled === undefined) throw moduleError('MODULE_CONTRACT_INVALID');
  return Object.freeze({
    bundle: section.identity,
    enabled: section.enabled,
    ...(section.parameters ? { parameters: section.parameters } : {}),
    ...(section.secretReferences ? { secretReferences: section.secretReferences } : {}),
  });
}

function checkedMediaConfiguration(value: unknown): MediaStorageConfiguration {
  const section = checkedExtensionSection(value, 'storage', MEDIA_KEYS);
  return Object.freeze({
    storage: section.identity,
    ...(section.parameters ? { parameters: section.parameters } : {}),
    ...(section.secretReferences ? { secretReferences: section.secretReferences } : {}),
  });
}

function checkedTlsSidecarConfiguration(value: unknown): TlsSidecarConfiguration {
  const section = checkedExtensionSection(value, 'profile', TLS_FINGERPRINT_KEYS);
  return Object.freeze({
    profile: section.identity,
    ...(section.parameters ? { parameters: section.parameters } : {}),
    ...(section.secretReferences ? { secretReferences: section.secretReferences } : {}),
  });
}

export function parseGatewayRuntimeExtensions(value: unknown): GatewayRuntimeModuleExtensionsV2 {
  try {
    if (!isRecord(value)) throw moduleError('MODULE_CONTRACT_INVALID');
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !EXTENSION_KEYS.includes(key))) {
      throw moduleError('MODULE_CONTRACT_INVALID');
    }
    if (!hasOwn(value, 'providerBundles')) throw moduleError('MODULE_CONTRACT_INVALID');
    const rawBundles = value.providerBundles;
    if (!Array.isArray(rawBundles) || rawBundles.length > MAX_PROVIDER_BUNDLES) {
      throw moduleError('MODULE_CONTRACT_INVALID');
    }
    const identities = new Set<string>();
    const bundles: ProviderBundleConfiguration[] = [];
    for (const rawBundle of rawBundles) {
      const bundle = checkedBundleConfiguration(rawBundle);
      // One configuration per built-in bundle id: accidental double assembly must fail closed.
      if (identities.has(bundle.bundle)) throw moduleError('MODULE_CONTRACT_INVALID');
      identities.add(bundle.bundle);
      bundles.push(bundle);
    }
    const extensions: {
      providerBundles: readonly ProviderBundleConfiguration[];
      media?: MediaStorageConfiguration;
      tlsFingerprint?: TlsSidecarConfiguration;
    } = { providerBundles: Object.freeze(bundles) };
    if (hasOwn(value, 'media')) extensions.media = checkedMediaConfiguration(value.media);
    if (hasOwn(value, 'tlsFingerprint'))
      extensions.tlsFingerprint = checkedTlsSidecarConfiguration(value.tlsFingerprint);
    return Object.freeze(extensions);
  } catch {
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

  if (deployment.gatewayRuntimeModule === 'builtin') {
    // Built-in composition is compiled into the normal CLI/release package;
    // no executable module or importer is needed for standard deployments.
    const { createBuiltinManagedSaasGatewayRuntime } = await import('./builtin-gateway-runtime.js');
    const hooks: Array<() => ProviderAwaitable<void>> = [];
    try {
      const handle = await createBuiltinManagedSaasGatewayRuntime({
        database,
        deployment: Object.freeze({
          workloadRole: 'gateway',
          deploymentId: deployment.deploymentId,
          environmentId: deployment.environmentId,
          listener: gatewayListenerConfig,
        }),
        env: copyRuntimeEnvironment(environment),
        lifecycle: {
          registerCloseHook(hook) {
            hooks.push(hook);
          },
        },
      });
      return Object.freeze({
        dependencies: handle.dependencies,
        extensions: handle.extensions,
        deploymentFacts: handle.deploymentFacts,
        getCapabilityReadiness: handle.getCapabilityReadiness,
        checkReady: handle.checkReady,
        close: closeOnce(handle.close),
      });
    } catch {
      for (const hook of hooks.reverse())
        await closeQuietly(async () => {
          await hook();
        });
      throw moduleError('FACTORY_FAILED');
    }
  }

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
    const contract = detectHandleContract(raw);
    if (!contract) throw moduleError('MODULE_CONTRACT_INVALID');
    if (!isRecord(raw)) throw moduleError('MODULE_CONTRACT_INVALID');
    // The outer version marker is read before any other v2 field is trusted.
    if (contract === 'v2' && raw.apiVersion !== 2) throw moduleError('MODULE_CONTRACT_INVALID');
    const checkReady = boundMethod(raw, 'checkReady');
    if (!checkReady || !cleanup) throw moduleError('MODULE_CONTRACT_INVALID');
    const checked = checkedDependencies(raw.dependencies, contract);
    const extensions = contract === 'v2' ? parseGatewayRuntimeExtensions(raw.extensions) : undefined;
    let mounted: Partial<ManagedSaasGatewayProductionOptions> = {};
    const dependencies =
      checked.providerEvidenceTransports === undefined
        ? checked
        : Object.freeze({
            ...checked,
            providerEvidenceTransports: (
              context: Parameters<NonNullable<ManagedSaasGatewayProductionOptions['providerEvidenceTransports']>>[0],
            ) => {
              const result = checked.providerEvidenceTransports?.(context) ?? {};
              mounted = result;
              return result;
            },
          });
    const routedScopes = () => {
      const scopeByKey = [
        ['codexEvidenceTransport', 'codex-responses'],
        ['claudeEvidenceTransport', 'claude-messages'],
        ['geminiEvidenceTransport', 'gemini-generate-content'],
        ['opencodeGoEvidenceTransport', 'opencode-go-zen'],
        ['cnProvidersEvidenceTransport', 'zhipu-glm'],
        ['cnProvidersEvidenceTransport', 'zhipu-glm-coding'],
        ['cnProvidersEvidenceTransport', 'minimax-m'],
        ['grokEvidenceTransport', 'grok-responses'],
        ['bedrockEvidenceTransport', 'bedrock-invoke'],
        ['vertexEvidenceTransport', 'vertex-raw-predict'],
      ] as const;
      return Object.freeze(
        scopeByKey.filter(([key]) => (mounted[key] ?? checked[key]) !== undefined).map(([, scope]) => scope),
      );
    };
    const deploymentFacts: GatewayCapabilityDeploymentFacts | undefined =
      extensions === undefined
        ? undefined
        : Object.freeze({
            get dispatch() {
              return Object.freeze({ generic: true, routedEndpointScopes: routedScopes() });
            },
            mediaStorages: Object.freeze(extensions.media && checked.imageMedia ? [extensions.media.storage] : []),
            tlsFingerprintProfiles: Object.freeze(
              extensions.tlsFingerprint && checked.tlsFingerprintResolution?.enabled
                ? [extensions.tlsFingerprint.profile]
                : [],
            ),
            verification: Object.freeze({}),
          });
    partialHooksTransferred = true;
    partialCloseHooks.length = 0;
    return Object.freeze({
      dependencies,
      ...(extensions ? { extensions } : {}),
      ...(deploymentFacts && extensions
        ? {
            deploymentFacts,
            async getCapabilityReadiness() {
              const { collectGatewayCapabilityFacts } = await import('./provider-bundle-readiness-facts.js');
              const { projectGatewayCapabilityReadiness } = await import('./gateway-capability-readiness.js');
              return projectGatewayCapabilityReadiness({
                extensions,
                facts: await collectGatewayCapabilityFacts(database, deploymentFacts),
              });
            },
          }
        : {}),
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
