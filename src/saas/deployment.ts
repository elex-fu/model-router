import { isIP } from 'node:net';

/**
 * Deployment configuration is intentionally separate from server startup. This
 * module validates declarations only; composition must still verify PostgreSQL
 * migrations and role-specific provider capabilities before any listener is
 * opened.
 */

export const MODEL_ROUTER_DEPLOYMENT_MODE = 'MODEL_ROUTER_DEPLOYMENT_MODE' as const;
export const MODEL_ROUTER_SAAS_WORKLOAD_ROLE = 'MODEL_ROUTER_SAAS_WORKLOAD_ROLE' as const;
export const MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS = 'MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS' as const;
export const MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE = 'MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE' as const;
export const MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY = 'MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY' as const;
export const MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE = 'MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE' as const;
export const MODEL_ROUTER_SAAS_DATABASE_URL = 'MODEL_ROUTER_SAAS_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL = 'MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL = 'MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL =
  'MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL' as const;
/** Batch-5 §5.1 plugin system: dedicated plugin-host workload settings. */
export const MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL = 'MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  'MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE' as const;
/** JSON object {keyId: base64-ed25519-public-key}; control-plane + plugin-host only. */
export const MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS = 'MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS' as const;
/** Development-only escape hatch; refused in production. */
export const MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED = 'MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED' as const;
/** Shared internal bearer token between the gateway and plugin-host workloads. */
export const MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN = 'MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN' as const;
/** Internal plugin-host listener (never a public listener). */
export const MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS = 'MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS' as const;
export const MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT = 'MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT' as const;
/** Gateway-side base URL of the plugin-host internal listener. */
export const MODEL_ROUTER_SAAS_PLUGIN_HOST_URL = 'MODEL_ROUTER_SAAS_PLUGIN_HOST_URL' as const;
export const MODEL_ROUTER_SAAS_REDIS_URL = 'MODEL_ROUTER_SAAS_REDIS_URL' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL = 'MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL' as const;
export const MODEL_ROUTER_SAAS_REDIS_PROVIDER = 'MODEL_ROUTER_SAAS_REDIS_PROVIDER' as const;
export const MODEL_ROUTER_SAAS_KMS_PROVIDER = 'MODEL_ROUTER_SAAS_KMS_PROVIDER' as const;
export const SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE = 'SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE' as const;
export const SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE = 'SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE' as const;
export const MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  'SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE' as const;
/** Trusted static metadata only; this module is exclusive to the credential-validation worker. */
export const MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE =
  'MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE' as const;
export const SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  'SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE = 'MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE' as const;
/** Optional trusted customer-MFA deployment descriptor, never a readiness Boolean. */
export const MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE =
  'MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE' as const;
/** Optional trusted customer-passkey deployment descriptor, never a readiness Boolean. */
export const MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE =
  'MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE' as const;
/** Optional trusted customer webhook signing-secret protector module descriptor. */
export const MODEL_ROUTER_SAAS_CUSTOMER_WEBHOOK_SIGNING_PROTECTOR_MODULE =
  'MODEL_ROUTER_SAAS_CUSTOMER_WEBHOOK_SIGNING_PROTECTOR_MODULE' as const;
export const MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID =
  'MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID' as const;
export const MODEL_ROUTER_SAAS_DEPLOYMENT_ID = 'MODEL_ROUTER_SAAS_DEPLOYMENT_ID' as const;
export const MODEL_ROUTER_SAAS_ENVIRONMENT_ID = 'MODEL_ROUTER_SAAS_ENVIRONMENT_ID' as const;

export const MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS = 'MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS' as const;
export const MODEL_ROUTER_SAAS_CUSTOMER_PORT = 'MODEL_ROUTER_SAAS_CUSTOMER_PORT' as const;
export const MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN = 'MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN' as const;
export const MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS = 'MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS' as const;
export const MODEL_ROUTER_SAAS_PLATFORM_PORT = 'MODEL_ROUTER_SAAS_PLATFORM_PORT' as const;
export const MODEL_ROUTER_SAAS_PLATFORM_ORIGIN = 'MODEL_ROUTER_SAAS_PLATFORM_ORIGIN' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS = 'MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_PORT = 'MODEL_ROUTER_SAAS_GATEWAY_PORT' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_ORIGIN = 'MODEL_ROUTER_SAAS_GATEWAY_ORIGIN' as const;

/** Descriptive aliases that keep the provider's contract terminology visible to callers. */
export const MODEL_ROUTER_SAAS_CREDENTIAL_PROVIDER_MODULE = MODEL_ROUTER_SAAS_KMS_PROVIDER;
export const MODEL_ROUTER_SAAS_KMS_PROVIDER_MODULE = MODEL_ROUTER_SAAS_KMS_PROVIDER;
export const MODEL_ROUTER_SAAS_REDIS_PROVIDER_MODULE = MODEL_ROUTER_SAAS_REDIS_PROVIDER;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/** Canonical environment names for this contract; no value is read at module load time. */
export const DEPLOYMENT_ENV_VARS = deepFreeze({
  mode: MODEL_ROUTER_DEPLOYMENT_MODE,
  saas: {
    workloadRole: MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
    validationWorkerMaxAttempts: MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS,
    paymentsConfigFile: MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE,
    commercialAttestationTrustFile: MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE,
    databaseUrl: MODEL_ROUTER_SAAS_DATABASE_URL,
    controlPlaneDatabaseUrl: MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
    gatewayDatabaseUrl: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
    validationWorkerDatabaseUrl: MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
    pluginHostDatabaseUrl: MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL,
    pluginHostProviderCredentialDecryptKmsModule: MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    pluginsTrustedPublishers: MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS,
    pluginsAllowUnsigned: MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED,
    pluginHostInternalToken: MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN,
    pluginHostBindAddress: MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS,
    pluginHostPort: MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT,
    gatewayPluginHostUrl: MODEL_ROUTER_SAAS_PLUGIN_HOST_URL,
    redisUrl: MODEL_ROUTER_SAAS_REDIS_URL,
    gatewayRedisUrl: MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
    redisProviderModule: MODEL_ROUTER_SAAS_REDIS_PROVIDER,
    credentialProviderModule: MODEL_ROUTER_SAAS_KMS_PROVIDER,
    providerCredentialSealingKmsModule: SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
    providerCredentialRewrappingKmsModule: SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
    gatewayProviderCredentialDecryptKmsModule: SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    gatewayRuntimeModule: MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
    customerMfaCapabilityModule: MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE,
    customerPasskeyCapabilityModule: MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE,
    validationWorkerProviderCredentialDecryptKmsModule:
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    credentialValidationTargetsModule: MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
    providerCredentialKmsKeyId: MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
    deploymentId: MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
    environmentId: MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
  },
  listeners: {
    customer: {
      bindAddress: MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS,
      port: MODEL_ROUTER_SAAS_CUSTOMER_PORT,
      origin: MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN,
    },
    platform: {
      bindAddress: MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS,
      port: MODEL_ROUTER_SAAS_PLATFORM_PORT,
      origin: MODEL_ROUTER_SAAS_PLATFORM_ORIGIN,
    },
    gateway: {
      bindAddress: MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS,
      port: MODEL_ROUTER_SAAS_GATEWAY_PORT,
      origin: MODEL_ROUTER_SAAS_GATEWAY_ORIGIN,
    },
  },
} as const);

/** Compatibility spelling for callers that prefer the longer name. */
export const DEPLOYMENT_ENVIRONMENT_VARIABLES = DEPLOYMENT_ENV_VARS;

const LISTENER_NAMES = ['customer', 'platform', 'gateway'] as const;

const LISTENER_ROUTE_PREFIXES = {
  customer: '/console',
  platform: '/admin',
  gateway: '/v1',
} as const satisfies Record<(typeof LISTENER_NAMES)[number], string>;

const WORKLOAD_ROLES = ['combined', 'control-plane', 'gateway', 'credential-validation-worker', 'plugin-host'] as const;

const WORKLOAD_ROLE_LISTENERS = deepFreeze({
  combined: ['customer', 'platform', 'gateway'],
  'control-plane': ['customer', 'platform'],
  gateway: ['gateway'],
  'credential-validation-worker': [],
  'plugin-host': [],
} as const);

/** Exact listener names owned by each managed SaaS workload role. */
export function managedSaasListenerNames(role: ManagedSaasWorkloadRole): readonly ListenerName[] {
  return WORKLOAD_ROLE_LISTENERS[role];
}

/** All SaaS-specific settings that make an implicit local choice unsafe. */
export const SAAS_DEPLOYMENT_ENV_NAMES = deepFreeze([
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS,
  MODEL_ROUTER_SAAS_DATABASE_URL,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
  MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL,
  MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS,
  MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED,
  MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN,
  MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS,
  MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT,
  MODEL_ROUTER_SAAS_PLUGIN_HOST_URL,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE,
  MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
  MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
  MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
  MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
  MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS,
  MODEL_ROUTER_SAAS_CUSTOMER_PORT,
  MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN,
  MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS,
  MODEL_ROUTER_SAAS_PLATFORM_PORT,
  MODEL_ROUTER_SAAS_PLATFORM_ORIGIN,
  MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS,
  MODEL_ROUTER_SAAS_GATEWAY_PORT,
  MODEL_ROUTER_SAAS_GATEWAY_ORIGIN,
] as const);

export type DeploymentMode = 'local' | 'managed-saas';
export type ManagedSaasWorkloadRole = (typeof WORKLOAD_ROLES)[number];
export type ListenerName = (typeof LISTENER_NAMES)[number];
export type DeploymentListenerRoutePrefix = (typeof LISTENER_ROUTE_PREFIXES)[ListenerName];
export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;
export type DeploymentEnvironmentVariable = (typeof SAAS_DEPLOYMENT_ENV_NAMES)[number];

export interface DeploymentListenerConfig<Name extends ListenerName = ListenerName> {
  readonly bindAddress: string;
  readonly port: number;
  /** Exact public Origin; it may be shared by listeners at different fixed route prefixes. */
  readonly origin: string;
  /** Fixed reverse-proxy mount owned by the corresponding handler. */
  readonly routePrefix: (typeof LISTENER_ROUTE_PREFIXES)[Name];
}

export interface LocalDeploymentConfig {
  readonly mode: 'local';
}

export interface ManagedSaasDeploymentConfig {
  readonly mode: 'managed-saas';
  readonly workloadRole: ManagedSaasWorkloadRole;
  readonly validationWorkerMaxAttempts?: number;
  readonly paymentsConfigFile?: string;
  readonly postgresUrl: string;
  readonly redisUrl?: string;
  /**
   * Gateway-scoped optional Redis URL (sticky-session hot path only; the
   * control-plane redisUrl/redisProviderModule pair stays separate). Present
   * only for the gateway workload; every other role fails closed on it.
   */
  readonly gatewayRedisUrl?: string;
  /** Opaque trusted module spec; loading and capability checks belong to composition. */
  readonly redisProviderModule?: string;
  /** Opaque trusted module spec; loading and capability checks belong to composition. */
  readonly credentialProviderModule?: string;
  /** Dedicated decrypt-only KMS module; present only for the gateway role. */
  readonly gatewayProviderCredentialDecryptKmsModule?: string;
  /** Trusted runtime module supplying gateway-only policy and provider capabilities. */
  readonly gatewayRuntimeModule?: string;
  /** Absence leaves customer MFA unavailable; presence requires real core readiness. */
  readonly customerMfaCapabilityModule?: string;
  /** Absence leaves customer passkeys unavailable; presence requires real core readiness. */
  readonly customerPasskeyCapabilityModule?: string;
  /** Dedicated decrypt-only KMS module; present only for the validation worker role. */
  readonly validationWorkerProviderCredentialDecryptKmsModule?: string;
  /** Batch-5 §5.1: dedicated decrypt-only KMS module; plugin-host role only. */
  readonly pluginHostProviderCredentialDecryptKmsModule?: string;
  /** Batch-5 §5.1: shared internal token (gateway ↔ plugin-host); gateway/plugin-host roles only. */
  readonly pluginHostInternalToken?: string;
  /** Batch-5 §5.1: internal plugin-host listener bind; plugin-host role only. */
  readonly pluginHostBindAddress?: string;
  /** Batch-5 §5.1: internal plugin-host listener port; plugin-host role only. */
  readonly pluginHostPort?: number;
  /** Batch-5 §5.1: gateway's plugin-host base URL; gateway role only. */
  readonly gatewayPluginHostUrl?: string;
  /** Batch-5 §5.1: trusted plugin publisher keys (keyId → base64 ed25519 public key). */
  readonly pluginsTrustedPublishers?: Readonly<Record<string, string>>;
  /** Batch-5 §5.1: development-only unsigned plugin acceptance; never true in production. */
  readonly pluginsAllowUnsigned?: boolean;
  /** Reviewed metadata-only target factory; worker-only, never an approval of database catalog authority. */
  readonly credentialValidationTargetsModule?: string;
  /** Stable non-secret AAD identity used when sealing or unsealing provider credentials. */
  readonly deploymentId: string;
  /** Stable non-secret AAD environment identity used when sealing or unsealing provider credentials. */
  readonly environmentId: string;
  /** Opaque KMS key reference; omitted when platform credential sealing is disabled. */
  readonly providerCredentialKmsKeyId?: string;
  /** Dedicated ReEncrypt-only KMS module; supported only by the control-plane workload. */
  readonly providerCredentialRewrappingKmsModule?: string;
  readonly listeners: Readonly<Partial<Record<ListenerName, DeploymentListenerConfig>>>;
}

export type DeploymentConfig = LocalDeploymentConfig | ManagedSaasDeploymentConfig;
export type SaasDeploymentConfig = ManagedSaasDeploymentConfig;

export type DeploymentConfigErrorCode =
  | 'INVALID_MODE'
  | 'SAAS_SETTINGS_REQUIRE_MANAGED_MODE'
  | 'LOCAL_MODE_HAS_SAAS_SETTINGS'
  | 'MISSING_REQUIRED_SETTING'
  | 'INVALID_WORKLOAD_ROLE'
  | 'INVALID_DATABASE_URL'
  | 'INVALID_REDIS_URL'
  | 'INVALID_PROVIDER_MODULE'
  | 'UNEXPECTED_WORKLOAD_SETTING'
  | 'INVALID_CREDENTIAL_CONTEXT'
  | 'INVALID_PLUGIN_SETTING'
  | 'INVALID_BIND_ADDRESS'
  | 'INVALID_PORT'
  | 'INVALID_ORIGIN'
  | 'INSECURE_ORIGIN'
  | 'DUPLICATE_LISTENER';

/** Safe configuration failure: messages identify declarations, never their values. */
export class DeploymentConfigError extends Error {
  constructor(
    readonly code: DeploymentConfigErrorCode,
    message: string,
    readonly variableName?: string,
  ) {
    super(message);
    this.name = 'DeploymentConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type ParsedOrigin = Readonly<{
  value: string;
  hostname: string;
  loopback: boolean;
  secure: boolean;
}>;

type ParsedListener<Name extends ListenerName = ListenerName> = Readonly<{
  config: DeploymentListenerConfig<Name>;
  origin: ParsedOrigin;
}>;

function invalid(code: DeploymentConfigErrorCode, message: string, variableName?: string): never {
  throw new DeploymentConfigError(code, message, variableName);
}

function isPresent(environment: DeploymentEnvironment, name: string): boolean {
  if (
    name === MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE ||
    name === MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE ||
    name === MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE
  ) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(environment, name);
      // An accessor is an explicit (invalid) declaration, never an implicit
      // missing/default choice. Do not invoke it even when checking local mode.
      return descriptor !== undefined && (!Object.hasOwn(descriptor, 'value') || descriptor.value !== undefined);
    } catch {
      return invalid('INVALID_PROVIDER_MODULE', `${name} must be an own data setting.`, name);
    }
  }
  return environment[name] !== undefined;
}

function optionalCredentialValidationTargetsModule(environment: DeploymentEnvironment): string | undefined {
  const name = MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE;
  let value: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid data setting');
    value = descriptor?.value;
  } catch {
    return invalid('INVALID_PROVIDER_MODULE', `${name} must be an own data setting.`, name);
  }
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    return invalid(
      'INVALID_PROVIDER_MODULE',
      `${name} must be a non-empty trusted static credential-validation metadata module spec.`,
      name,
    );
  }
  return requiredSetting(
    { [name]: value },
    name,
    'trusted static credential-validation metadata module spec',
    'INVALID_PROVIDER_MODULE',
  );
}

function optionalCustomerMfaCapabilityModule(environment: DeploymentEnvironment): string | undefined {
  const name = MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE;
  let value: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid data setting');
    value = descriptor?.value;
  } catch {
    return invalid('INVALID_PROVIDER_MODULE', `${name} must be an own data setting.`, name);
  }
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    return invalid('INVALID_PROVIDER_MODULE', `${name} must be a bounded trusted module spec.`, name);
  }
  return value;
}

function optionalCustomerPasskeyCapabilityModule(environment: DeploymentEnvironment): string | undefined {
  const name = MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE;
  let value: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid data setting');
    value = descriptor?.value;
  } catch {
    return invalid('INVALID_PROVIDER_MODULE', `${name} must be an own data setting.`, name);
  }
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    return invalid('INVALID_PROVIDER_MODULE', `${name} must be a bounded trusted module spec.`, name);
  }
  return value;
}

function hasSaasSettings(environment: DeploymentEnvironment): boolean {
  return SAAS_DEPLOYMENT_ENV_NAMES.some((name) => isPresent(environment, name));
}

function requiredSetting(
  environment: DeploymentEnvironment,
  name: string,
  description: string,
  code: DeploymentConfigErrorCode,
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return invalid(code, `${name} must be a non-empty ${description}.`, name);
  }
  return value;
}

function optionalContextLabel(
  environment: DeploymentEnvironment,
  name: string,
  description: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return invalid(
      'INVALID_CREDENTIAL_CONTEXT',
      `${name} must be a bounded deployment identity for ${description}.`,
      name,
    );
  }
  return value;
}

function optionalKmsKeyId(environment: DeploymentEnvironment): string | undefined {
  const value = environment[MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) {
    return invalid(
      'INVALID_CREDENTIAL_CONTEXT',
      `${MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID} must be a bounded visible KMS key reference.`,
      MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
    );
  }
  return value;
}

const WORKLOAD_ROLE_DATABASE_ENV_NAMES = {
  'control-plane': MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  gateway: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  'credential-validation-worker': MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
  'plugin-host': MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL,
} as const satisfies Record<Exclude<ManagedSaasWorkloadRole, 'combined'>, string>;

function resolveWorkloadRole(environment: DeploymentEnvironment): ManagedSaasWorkloadRole {
  const name = MODEL_ROUTER_SAAS_WORKLOAD_ROLE;
  const value = environment[name];
  if (value === undefined) {
    if (environment.NODE_ENV === 'production') {
      invalid('MISSING_REQUIRED_SETTING', `${name} must be explicitly set for production.`, name);
    }
    return 'combined';
  }

  if (typeof value !== 'string') {
    invalid(
      'INVALID_WORKLOAD_ROLE',
      `${name} must be exactly combined, control-plane, gateway, credential-validation-worker, or plugin-host.`,
      name,
    );
  }

  const role = WORKLOAD_ROLES.find((candidate) => candidate === value);
  if (role === undefined) {
    invalid(
      'INVALID_WORKLOAD_ROLE',
      `${name} must be exactly combined, control-plane, gateway, credential-validation-worker, or plugin-host.`,
      name,
    );
  }
  if (role === 'combined' && environment.NODE_ENV === 'production') {
    invalid('INVALID_WORKLOAD_ROLE', `${name} cannot be combined in production.`, name);
  }
  return role;
}

function postgresUrlEnvironmentName(role: ManagedSaasWorkloadRole): string {
  return role === 'combined' ? MODEL_ROUTER_SAAS_DATABASE_URL : WORKLOAD_ROLE_DATABASE_ENV_NAMES[role];
}

/** Bounded internal bearer token (gateway ↔ plugin-host); visible charset only. */
function requiredBoundedToken(environment: DeploymentEnvironment, name: string): string {
  const value = requiredSetting(environment, name, 'internal token', 'INVALID_PLUGIN_SETTING');
  if (!/^[\x21-\x7e]{32,256}$/.test(value)) {
    invalid('INVALID_PLUGIN_SETTING', `${name} must be 32-256 visible characters.`, name);
  }
  return value;
}

/** Internal listener bind: an IP literal or localhost (never a public origin). */
function requiredBindAddress(environment: DeploymentEnvironment, name: string): string {
  const value = requiredSetting(environment, name, 'bind address', 'INVALID_PLUGIN_SETTING');
  if (isIP(value) === 0 && value !== 'localhost') {
    invalid('INVALID_PLUGIN_SETTING', `${name} must be an IP literal or localhost.`, name);
  }
  return value;
}

function requiredPort(environment: DeploymentEnvironment, name: string): number {
  const raw = requiredSetting(environment, name, 'port', 'INVALID_PLUGIN_SETTING');
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    invalid('INVALID_PLUGIN_SETTING', `${name} must be an integer between 1 and 65535.`, name);
  }
  return port;
}

function validateHttpServiceUrl(environment: DeploymentEnvironment, name: string): string {
  const value = requiredSetting(environment, name, 'plugin-host URL', 'INVALID_PLUGIN_SETTING');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('INVALID_PLUGIN_SETTING', `${name} must be a valid http(s) URL.`, name);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
    return invalid('INVALID_PLUGIN_SETTING', `${name} must be a valid http(s) URL.`, name);
  }
  return value;
}

/** JSON {keyId: base64 raw ed25519 public key}; strict shape, ≤64 entries. */
function parsePluginsTrustedPublishers(
  environment: DeploymentEnvironment,
  name: string,
): Readonly<Record<string, string>> {
  const value = requiredSetting(environment, name, 'trusted plugin publishers', 'INVALID_PLUGIN_SETTING');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid('INVALID_PLUGIN_SETTING', `${name} must be a JSON object.`, name);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('INVALID_PLUGIN_SETTING', `${name} must be a JSON object.`, name);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 64) {
    return invalid('INVALID_PLUGIN_SETTING', `${name} accepts at most 64 publisher keys.`, name);
  }
  const result: Record<string, string> = {};
  for (const [keyId, keyValue] of entries) {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(keyId) || typeof keyValue !== 'string') {
      return invalid('INVALID_PLUGIN_SETTING', `${name} contains an invalid publisher entry.`, name);
    }
    const keyBytes = Buffer.from(keyValue, 'base64');
    if (keyValue.length > 128 || keyBytes.length !== 32) {
      return invalid('INVALID_PLUGIN_SETTING', `${name} publisher keys must be base64 ed25519 public keys.`, name);
    }
    result[keyId] = keyValue;
  }
  return deepFreeze(result);
}

function validateRequiredSettings(
  environment: DeploymentEnvironment,
  postgresUrlName: string,
  listenerNames: readonly ListenerName[],
  workloadRole: ManagedSaasWorkloadRole,
): void {
  const requiredProviderSettings =
    workloadRole === 'combined' || workloadRole === 'control-plane'
      ? [MODEL_ROUTER_SAAS_REDIS_URL, MODEL_ROUTER_SAAS_REDIS_PROVIDER, MODEL_ROUTER_SAAS_KMS_PROVIDER]
      : workloadRole === 'gateway'
        ? [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE, MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE]
        : workloadRole === 'plugin-host'
          ? [
              MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
              MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN,
              MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS,
              MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT,
            ]
          : [MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE];
  const requiredNames = [
    postgresUrlName,
    ...requiredProviderSettings,
    ...listenerNames.flatMap((name) => {
      const variables = DEPLOYMENT_ENV_VARS.listeners[name];
      return [variables.bindAddress, variables.port, variables.origin];
    }),
  ];
  const missing = requiredNames.filter((name) => {
    const value = environment[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    invalid('MISSING_REQUIRED_SETTING', `Managed SaaS deployment requires: ${missing.join(', ')}.`, missing[0]);
  }
}

function validateServiceUrl(
  environment: DeploymentEnvironment,
  name: string,
  protocols: readonly string[],
  description: string,
  code: 'INVALID_DATABASE_URL' | 'INVALID_REDIS_URL',
): string {
  const value = requiredSetting(environment, name, description, code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(code, `${name} must be a valid ${description}.`, name);
  }
  if (!protocols.includes(parsed.protocol) || parsed.hostname.length === 0) {
    return invalid(code, `${name} must identify a ${description} server.`, name);
  }
  return value;
}

function parsePort(value: string, name: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    return invalid('INVALID_PORT', `${name} must be an explicit TCP port from 1 to 65535.`, name);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return invalid('INVALID_PORT', `${name} must be an explicit TCP port from 1 to 65535.`, name);
  }
  return port;
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 6) return normalized === '::1';
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

function parseOrigin(environment: DeploymentEnvironment, name: string): ParsedOrigin {
  const value = requiredSetting(environment, name, 'public Origin', 'INVALID_ORIGIN');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('INVALID_ORIGIN', `${name} must be an exact canonical HTTP(S) Origin.`, name);
  }

  const canonical = parsed.origin;
  const validScheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
  const hasQueryOrFragment = parsed.search !== '' || parsed.hash !== '';
  if (!validScheme || parsed.hostname.length === 0 || hasCredentials || hasQueryOrFragment || value !== canonical) {
    return invalid(
      'INVALID_ORIGIN',
      `${name} must be an exact canonical HTTP(S) Origin without credentials, path, query, or fragment.`,
      name,
    );
  }

  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return invalid('INVALID_ORIGIN', `${name} must use a valid public Origin port.`, name);
    }
  }

  return {
    value,
    hostname: normalizedHostname(parsed.hostname),
    loopback: isLoopbackHostname(parsed.hostname),
    secure: parsed.protocol === 'https:',
  };
}

function parseListener<Name extends ListenerName>(
  environment: DeploymentEnvironment,
  name: Name,
): ParsedListener<Name> {
  const variables = DEPLOYMENT_ENV_VARS.listeners[name];
  const bindAddress = requiredSetting(environment, variables.bindAddress, 'bind address', 'INVALID_BIND_ADDRESS');
  const portText = requiredSetting(environment, variables.port, 'TCP port', 'INVALID_PORT');
  const port = parsePort(portText, variables.port);
  const origin = parseOrigin(environment, variables.origin);
  return {
    config: { bindAddress, port, origin: origin.value, routePrefix: LISTENER_ROUTE_PREFIXES[name] },
    origin,
  };
}

function normalizedBindAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function validateListenerRelationships(
  listeners: Readonly<Partial<Record<ListenerName, ParsedListener>>>,
  listenerNames: readonly ListenerName[],
): void {
  const addresses = new Set<string>();

  for (const name of listenerNames) {
    const listener = listeners[name];
    if (!listener) invalid('MISSING_REQUIRED_SETTING', `Managed SaaS ${name} listener is not configured.`, name);
    const addressKey = `${normalizedBindAddress(listener.config.bindAddress)}\u0000${listener.config.port}`;
    if (addresses.has(addressKey)) {
      invalid('DUPLICATE_LISTENER', `Managed SaaS listeners must not share a bind address and port.`, name);
    }
    addresses.add(addressKey);

    if (!listener.origin.loopback) {
      if (!listener.origin.secure) {
        invalid('INSECURE_ORIGIN', `Non-loopback managed SaaS Origins must use HTTPS.`, name);
      }
    }
  }
}

function parseManagedSaasDeployment(environment: DeploymentEnvironment): ManagedSaasDeploymentConfig {
  const workloadRole = resolveWorkloadRole(environment);
  const validationAttemptsRaw = environment[MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS];
  let validationWorkerMaxAttempts: number | undefined;
  if (validationAttemptsRaw !== undefined) {
    if (workloadRole !== 'credential-validation-worker' || typeof validationAttemptsRaw !== 'string' || !/^[1-9]\d?$/u.test(validationAttemptsRaw) || Number(validationAttemptsRaw) > 20) {
      invalid('INVALID_PROVIDER_MODULE', 'Validation worker max attempts must be an integer from 1 to 20 on the credential-validation-worker role.', MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS);
    }
    validationWorkerMaxAttempts = Number(validationAttemptsRaw);
  }
  const historyMode = environment.MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE;
  // Read only this feature's declared settings. Enumerating the whole object
  // invokes unrelated Proxy descriptor traps before their safe parsers run.
  const historyConfigured = ['SAAS_RESPONSES_HISTORY_KMS_MODULE', ...['KMS_KEY_ID', 'KEYRING_FILE', 'TTL_MS', 'MAX_BYTES', 'AWS_REGION', 'AWS_CREDENTIALS_FILE', 'KMS_PREVIOUS_KEY_IDS'].map(suffix => `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_${suffix}`)].some(key => environment[key] !== undefined);
  if (historyMode !== undefined && !['disabled', 'production-kms', 'pilot-file-keyring'].includes(historyMode) || (historyMode !== undefined && historyMode !== 'disabled' || historyConfigured) && workloadRole !== 'gateway' && workloadRole !== 'combined') {
    invalid('INVALID_PROVIDER_MODULE', 'Responses history configuration is invalid for this role.', 'MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE');
  }
  const commercialTrustFile = environment[MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE];
  if (commercialTrustFile !== undefined && (workloadRole !== 'combined' && workloadRole !== 'control-plane' || commercialTrustFile.length < 1 || commercialTrustFile.length > 4096 || commercialTrustFile.trim() !== commercialTrustFile || /[\u0000-\u001f]/u.test(commercialTrustFile))) {
    invalid('INVALID_PROVIDER_MODULE', 'Commercial attestation trust configuration is invalid for this role.', MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE);
  }
  const paymentsConfigFile = environment[MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE];
  if (environment[MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY] !== undefined && workloadRole !== 'combined' && workloadRole !== 'control-plane') {
    invalid('INVALID_PROVIDER_MODULE', 'Payment credentials are restricted to control-plane workloads.', MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY);
  }
  if (paymentsConfigFile !== undefined) {
    if (workloadRole !== 'combined' && workloadRole !== 'control-plane') {
      invalid('INVALID_PROVIDER_MODULE', 'Payments configuration is restricted to control-plane workloads.', MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE);
    }
    if (paymentsConfigFile.length === 0 || paymentsConfigFile.length > 4096 || paymentsConfigFile.trim() !== paymentsConfigFile || /[\u0000-\u001f]/u.test(paymentsConfigFile)) {
      invalid('INVALID_PROVIDER_MODULE', 'Payments configuration file path is invalid.', MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE);
    }
  }
  const postgresUrlName = postgresUrlEnvironmentName(workloadRole);
  const listenerNames = managedSaasListenerNames(workloadRole);
  const validationWorker = workloadRole === 'credential-validation-worker';
  const gateway = workloadRole === 'gateway';
  const pluginHost = workloadRole === 'plugin-host';
  const customerMfaCapabilityModule = optionalCustomerMfaCapabilityModule(environment);
  if (customerMfaCapabilityModule !== undefined && workloadRole !== 'combined' && workloadRole !== 'control-plane') {
    invalid(
      'UNEXPECTED_WORKLOAD_SETTING',
      `${MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE} is control-plane-only.`,
      MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE,
    );
  }
  const customerPasskeyCapabilityModule = optionalCustomerPasskeyCapabilityModule(environment);
  if (
    customerPasskeyCapabilityModule !== undefined &&
    workloadRole !== 'combined' &&
    workloadRole !== 'control-plane'
  ) {
    invalid(
      'UNEXPECTED_WORKLOAD_SETTING',
      `${MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE} is control-plane-only.`,
      MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE,
    );
  }
  if (!validationWorker && isPresent(environment, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE)) {
    invalid(
      'UNEXPECTED_WORKLOAD_SETTING',
      `${MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE} is permitted only for the credential-validation-worker workload.`,
      MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
    );
  }
  if (validationWorker) {
    const forbiddenSettings = [
      MODEL_ROUTER_SAAS_DATABASE_URL,
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_URL,
      MODEL_ROUTER_SAAS_REDIS_URL,
      MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
      MODEL_ROUTER_SAAS_REDIS_PROVIDER,
      MODEL_ROUTER_SAAS_KMS_PROVIDER,
      SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
      MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
      MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
      ...Object.values(DEPLOYMENT_ENV_VARS.listeners).flatMap((listener) => Object.values(listener)),
    ];
    const unexpected = forbiddenSettings.find((name) => isPresent(environment, name));
    if (unexpected) {
      invalid(
        'UNEXPECTED_WORKLOAD_SETTING',
        `${unexpected} is not permitted for the credential-validation worker workload.`,
        unexpected,
      );
    }
  } else if (pluginHost) {
    // The plugin-host is an isolated workload: it loads none of the other
    // roles' providers, opens no public listener, and must not even see the
    // other database URL spellings.
    const forbiddenSettings = [
      MODEL_ROUTER_SAAS_DATABASE_URL,
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
      MODEL_ROUTER_SAAS_PLUGIN_HOST_URL,
      MODEL_ROUTER_SAAS_REDIS_URL,
      MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
      MODEL_ROUTER_SAAS_REDIS_PROVIDER,
      MODEL_ROUTER_SAAS_KMS_PROVIDER,
      SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
      SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
      MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
      MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
      ...Object.values(DEPLOYMENT_ENV_VARS.listeners).flatMap((listener) => Object.values(listener)),
    ];
    const unexpected = forbiddenSettings.find((name) => isPresent(environment, name));
    if (unexpected) {
      invalid(
        'UNEXPECTED_WORKLOAD_SETTING',
        `${unexpected} is not permitted for the plugin-host workload.`,
        unexpected,
      );
    }
  } else {
    // The gateway keeps rejecting the control-plane Redis pair (a gateway
    // must not load the control-plane Redis provider module or its URL
    // spelling); its own optional gateway-scoped URL is parsed separately
    // below. Every non-gateway role likewise rejects the gateway spelling.
    const forbiddenSettings = gateway
      ? [
          MODEL_ROUTER_SAAS_DATABASE_URL,
          MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
          MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT,
          MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS,
          MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED,
          MODEL_ROUTER_SAAS_REDIS_URL,
          MODEL_ROUTER_SAAS_REDIS_PROVIDER,
          MODEL_ROUTER_SAAS_KMS_PROVIDER,
          SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
          MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
          MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          ...Object.entries(DEPLOYMENT_ENV_VARS.listeners)
            .filter(([name]) => name !== 'gateway')
            .flatMap(([, listener]) => Object.values(listener)),
        ]
      : [
          MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
          MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_DATABASE_URL,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT,
          MODEL_ROUTER_SAAS_PLUGIN_HOST_URL,
        ];
    const unexpected = forbiddenSettings.find((name) => isPresent(environment, name));
    if (unexpected) {
      invalid(
        'UNEXPECTED_WORKLOAD_SETTING',
        `${unexpected} is not permitted for the ${workloadRole} workload.`,
        unexpected,
      );
    }
  }
  validateRequiredSettings(environment, postgresUrlName, listenerNames, workloadRole);

  const postgresUrl = validateServiceUrl(
    environment,
    postgresUrlName,
    ['postgres:', 'postgresql:'],
    'PostgreSQL URL',
    'INVALID_DATABASE_URL',
  );
  const usesControlPlaneProviders = workloadRole === 'combined' || workloadRole === 'control-plane';
  const redisUrl = !usesControlPlaneProviders
    ? undefined
    : validateServiceUrl(
        environment,
        MODEL_ROUTER_SAAS_REDIS_URL,
        ['redis:', 'rediss:'],
        'Redis URL',
        'INVALID_REDIS_URL',
      );
  const redisProviderModule = !usesControlPlaneProviders
    ? undefined
    : requiredSetting(
        environment,
        MODEL_ROUTER_SAAS_REDIS_PROVIDER,
        'trusted Redis-provider module spec',
        'INVALID_PROVIDER_MODULE',
      );
  // Gateway-scoped Redis: optional, hot-path cache only (the sticky-session
  // fast path). Absent ⇒ the pure-PG affinity path, exactly as before.
  const gatewayRedisUrl =
    gateway && isPresent(environment, MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL)
      ? validateServiceUrl(
          environment,
          MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
          ['redis:', 'rediss:'],
          'Redis URL',
          'INVALID_REDIS_URL',
        )
      : undefined;
  const credentialProviderModule = !usesControlPlaneProviders
    ? undefined
    : requiredSetting(
        environment,
        MODEL_ROUTER_SAAS_KMS_PROVIDER,
        'trusted credential-provider module spec',
        'INVALID_PROVIDER_MODULE',
      );
  const gatewayKmsModule = gateway
    ? requiredSetting(
        environment,
        SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
        'trusted gateway credential-decryption KMS module spec',
        'INVALID_PROVIDER_MODULE',
      )
    : undefined;
  const gatewayRuntimeModule = gateway
    ? requiredSetting(
        environment,
        MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
        'trusted gateway runtime module spec',
        'INVALID_PROVIDER_MODULE',
      )
    : undefined;
  const validationWorkerKmsModule = validationWorker
    ? requiredSetting(
        environment,
        MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
        'trusted validation-worker credential-decryption KMS module spec',
        'INVALID_PROVIDER_MODULE',
      )
    : undefined;
  const credentialValidationTargetsModule = validationWorker
    ? optionalCredentialValidationTargetsModule(environment)
    : undefined;

  // Batch-5 §5.1 plugin-host settings.
  const pluginHostKmsModule = pluginHost
    ? requiredSetting(
        environment,
        MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
        'trusted plugin-host credential-decryption KMS module spec',
        'INVALID_PROVIDER_MODULE',
      )
    : undefined;
  const pluginHostInternalToken = pluginHost
    ? requiredBoundedToken(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN)
    : undefined;
  const pluginHostBindAddress = pluginHost
    ? requiredBindAddress(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_BIND_ADDRESS)
    : undefined;
  const pluginHostPort = pluginHost ? requiredPort(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_PORT) : undefined;
  const gatewayPluginHostUrl = gateway
    ? isPresent(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_URL)
      ? validateHttpServiceUrl(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_URL)
      : undefined
    : undefined;
  const gatewayPluginHostInternalToken =
    gateway && isPresent(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN)
      ? requiredBoundedToken(environment, MODEL_ROUTER_SAAS_PLUGIN_HOST_INTERNAL_TOKEN)
      : undefined;
  const pluginsTrustedPublishers =
    (workloadRole === 'combined' || workloadRole === 'control-plane' || pluginHost) &&
    isPresent(environment, MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS)
      ? parsePluginsTrustedPublishers(environment, MODEL_ROUTER_SAAS_PLUGINS_TRUSTED_PUBLISHERS)
      : undefined;
  const pluginsAllowUnsignedSetting = environment[MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED];
  if (pluginsAllowUnsignedSetting !== undefined && pluginsAllowUnsignedSetting !== 'true') {
    invalid(
      'INVALID_PLUGIN_SETTING',
      `${MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED} must be exactly 'true' or unset.`,
      MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED,
    );
  }
  const pluginsAllowUnsigned = pluginsAllowUnsignedSetting === 'true';
  if (pluginsAllowUnsigned && environment.NODE_ENV === 'production') {
    invalid(
      'INVALID_PLUGIN_SETTING',
      `${MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED} is not permitted in production.`,
      MODEL_ROUTER_SAAS_PLUGINS_ALLOW_UNSIGNED,
    );
  }

  const sealingKmsModule = environment[SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE];
  const providerCredentialKmsKeyId = optionalKmsKeyId(environment);
  const sealingKmsConfigured = sealingKmsModule !== undefined || providerCredentialKmsKeyId !== undefined;
  if (sealingKmsConfigured && (sealingKmsModule === undefined || providerCredentialKmsKeyId === undefined)) {
    const missingName =
      sealingKmsModule === undefined
        ? SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE
        : MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID;
    invalid(
      'MISSING_REQUIRED_SETTING',
      `${SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE} and ${MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID} must be configured together.`,
      missingName,
    );
  }
  if (sealingKmsModule !== undefined) {
    requiredSetting(
      environment,
      SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
      'trusted credential-sealing KMS module spec',
      'INVALID_PROVIDER_MODULE',
    );
  }

  const rewrappingKmsModuleSetting = environment[SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE];
  const providerCredentialRewrappingKmsModule =
    rewrappingKmsModuleSetting === undefined
      ? undefined
      : requiredSetting(
          environment,
          SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
          'trusted credential-rewrapping KMS module spec',
          'INVALID_PROVIDER_MODULE',
        );
  if (providerCredentialRewrappingKmsModule !== undefined) {
    if (workloadRole !== 'control-plane' || !sealingKmsConfigured) {
      invalid(
        'INVALID_PROVIDER_MODULE',
        `${SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE} is supported only by a control-plane workload with the current provider credential key configured.`,
        SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
      );
    }
    if (
      providerCredentialRewrappingKmsModule === sealingKmsModule ||
      providerCredentialRewrappingKmsModule === gatewayKmsModule ||
      providerCredentialRewrappingKmsModule === validationWorkerKmsModule
    ) {
      invalid(
        'INVALID_PROVIDER_MODULE',
        `${SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE} must identify a dedicated ReEncrypt-only module.`,
        SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
      );
    }
  }

  const deploymentIdSetting = optionalContextLabel(environment, MODEL_ROUTER_SAAS_DEPLOYMENT_ID, 'deployment');
  const environmentIdSetting = optionalContextLabel(environment, MODEL_ROUTER_SAAS_ENVIRONMENT_ID, 'environment');
  const needsExplicitContext =
    environment.NODE_ENV === 'production' ||
    sealingKmsConfigured ||
    validationWorker ||
    pluginHost ||
    gatewayKmsModule !== undefined ||
    customerMfaCapabilityModule !== undefined ||
    customerPasskeyCapabilityModule !== undefined;
  if (needsExplicitContext && deploymentIdSetting === undefined) {
    invalid(
      'MISSING_REQUIRED_SETTING',
      `${MODEL_ROUTER_SAAS_DEPLOYMENT_ID} is required for production or provider credential encryption.`,
      MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
    );
  }
  if (needsExplicitContext && environmentIdSetting === undefined) {
    invalid(
      'MISSING_REQUIRED_SETTING',
      `${MODEL_ROUTER_SAAS_ENVIRONMENT_ID} is required for production or provider credential encryption.`,
      MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
    );
  }
  if (environment.NODE_ENV === 'production' && workloadRole === 'control-plane' && !sealingKmsConfigured) {
    invalid(
      'MISSING_REQUIRED_SETTING',
      `Production control-plane deployments require ${SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE} and ${MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID}.`,
      SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
    );
  }

  const parsedListeners: Partial<Record<ListenerName, ParsedListener>> = {};
  for (const name of listenerNames) parsedListeners[name] = parseListener(environment, name);
  validateListenerRelationships(parsedListeners, listenerNames);

  return deepFreeze({
    mode: 'managed-saas',
    workloadRole,
    ...(validationWorkerMaxAttempts === undefined ? {} : { validationWorkerMaxAttempts }),
    ...(paymentsConfigFile === undefined ? {} : { paymentsConfigFile }),
    postgresUrl,
    ...(redisUrl === undefined ? {} : { redisUrl }),
    ...(gatewayRedisUrl === undefined ? {} : { gatewayRedisUrl }),
    ...(redisProviderModule === undefined ? {} : { redisProviderModule }),
    ...(credentialProviderModule === undefined ? {} : { credentialProviderModule }),
    ...(providerCredentialRewrappingKmsModule === undefined ? {} : { providerCredentialRewrappingKmsModule }),
    ...(gatewayKmsModule === undefined ? {} : { gatewayProviderCredentialDecryptKmsModule: gatewayKmsModule }),
    ...(gatewayRuntimeModule === undefined ? {} : { gatewayRuntimeModule }),
    ...(customerMfaCapabilityModule === undefined ? {} : { customerMfaCapabilityModule }),
    ...(customerPasskeyCapabilityModule === undefined ? {} : { customerPasskeyCapabilityModule }),
    ...(validationWorkerKmsModule === undefined
      ? {}
      : { validationWorkerProviderCredentialDecryptKmsModule: validationWorkerKmsModule }),
    ...(credentialValidationTargetsModule === undefined ? {} : { credentialValidationTargetsModule }),
    ...(pluginHostKmsModule === undefined ? {} : { pluginHostProviderCredentialDecryptKmsModule: pluginHostKmsModule }),
    ...(pluginHostInternalToken === undefined ? {} : { pluginHostInternalToken }),
    ...(pluginHostBindAddress === undefined ? {} : { pluginHostBindAddress }),
    ...(pluginHostPort === undefined ? {} : { pluginHostPort }),
    ...(gatewayPluginHostUrl === undefined ? {} : { gatewayPluginHostUrl }),
    ...(gatewayPluginHostInternalToken === undefined
      ? {}
      : { pluginHostInternalToken: gatewayPluginHostInternalToken }),
    ...(pluginsTrustedPublishers === undefined ? {} : { pluginsTrustedPublishers }),
    ...(pluginsAllowUnsigned ? { pluginsAllowUnsigned: true } : {}),
    deploymentId: deploymentIdSetting ?? 'model-router-development',
    environmentId:
      environmentIdSetting ??
      optionalContextLabel(
        { [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: environment.NODE_ENV },
        MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
        'environment',
      ) ??
      'development',
    ...(providerCredentialKmsKeyId === undefined ? {} : { providerCredentialKmsKeyId }),
    listeners: {
      ...Object.fromEntries(Object.entries(parsedListeners).map(([name, parsed]) => [name, parsed?.config])),
    },
  });
}

/**
 * Parse an environment declaration without mutating or loading anything from
 * it. With no SaaS settings, the only implicit result is immutable local mode.
 */
export function parseDeploymentConfig(environment: DeploymentEnvironment = process.env): DeploymentConfig {
  const mode = environment[MODEL_ROUTER_DEPLOYMENT_MODE];
  if (mode === undefined) {
    if (hasSaasSettings(environment)) {
      invalid(
        'SAAS_SETTINGS_REQUIRE_MANAGED_MODE',
        `SaaS deployment settings are present; set ${MODEL_ROUTER_DEPLOYMENT_MODE}=managed-saas.`,
        MODEL_ROUTER_DEPLOYMENT_MODE,
      );
    }
    return deepFreeze({ mode: 'local' });
  }

  if (mode !== 'local' && mode !== 'managed-saas') {
    invalid(
      'INVALID_MODE',
      `${MODEL_ROUTER_DEPLOYMENT_MODE} must be exactly local or managed-saas.`,
      MODEL_ROUTER_DEPLOYMENT_MODE,
    );
  }

  if (mode === 'local') {
    if (hasSaasSettings(environment)) {
      invalid(
        'LOCAL_MODE_HAS_SAAS_SETTINGS',
        `${MODEL_ROUTER_DEPLOYMENT_MODE}=local cannot be combined with SaaS deployment settings; remove them or select managed-saas.`,
        MODEL_ROUTER_DEPLOYMENT_MODE,
      );
    }
    return deepFreeze({ mode: 'local' });
  }

  return parseManagedSaasDeployment(environment);
}

/** Explicit alias for integration code that prefers a SaaS-specific name. */
export const parseSaasDeploymentConfig = parseDeploymentConfig;
