import { isIP } from 'node:net';

/**
 * Deployment configuration is intentionally separate from server startup. This
 * module validates declarations only; composition must still verify PostgreSQL
 * migrations and role-specific provider capabilities before any listener is
 * opened.
 */

export const MODEL_ROUTER_DEPLOYMENT_MODE = 'MODEL_ROUTER_DEPLOYMENT_MODE' as const;
export const MODEL_ROUTER_SAAS_WORKLOAD_ROLE = 'MODEL_ROUTER_SAAS_WORKLOAD_ROLE' as const;
export const MODEL_ROUTER_SAAS_DATABASE_URL = 'MODEL_ROUTER_SAAS_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL = 'MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL = 'MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL =
  'MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL' as const;
export const MODEL_ROUTER_SAAS_REDIS_URL = 'MODEL_ROUTER_SAAS_REDIS_URL' as const;
export const MODEL_ROUTER_SAAS_REDIS_PROVIDER = 'MODEL_ROUTER_SAAS_REDIS_PROVIDER' as const;
export const MODEL_ROUTER_SAAS_KMS_PROVIDER = 'MODEL_ROUTER_SAAS_KMS_PROVIDER' as const;
export const SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE = 'SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE' as const;
export const SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE = 'SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE' as const;
export const MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  'SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE' as const;
export const SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  'SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE = 'MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE' as const;
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
    databaseUrl: MODEL_ROUTER_SAAS_DATABASE_URL,
    controlPlaneDatabaseUrl: MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
    gatewayDatabaseUrl: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
    validationWorkerDatabaseUrl: MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
    redisUrl: MODEL_ROUTER_SAAS_REDIS_URL,
    redisProviderModule: MODEL_ROUTER_SAAS_REDIS_PROVIDER,
    credentialProviderModule: MODEL_ROUTER_SAAS_KMS_PROVIDER,
    providerCredentialSealingKmsModule: SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
    providerCredentialRewrappingKmsModule: SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
    gatewayProviderCredentialDecryptKmsModule: SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    gatewayRuntimeModule: MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
    validationWorkerProviderCredentialDecryptKmsModule:
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
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

const WORKLOAD_ROLES = ['combined', 'control-plane', 'gateway', 'credential-validation-worker'] as const;

const WORKLOAD_ROLE_LISTENERS = deepFreeze({
  combined: ['customer', 'platform', 'gateway'],
  'control-plane': ['customer', 'platform'],
  gateway: ['gateway'],
  'credential-validation-worker': [],
} as const);

/** Exact listener names owned by each managed SaaS workload role. */
export function managedSaasListenerNames(role: ManagedSaasWorkloadRole): readonly ListenerName[] {
  return WORKLOAD_ROLE_LISTENERS[role];
}

/** All SaaS-specific settings that make an implicit local choice unsafe. */
export const SAAS_DEPLOYMENT_ENV_NAMES = deepFreeze([
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  MODEL_ROUTER_SAAS_DATABASE_URL,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
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
  readonly postgresUrl: string;
  readonly redisUrl?: string;
  /** Opaque trusted module spec; loading and capability checks belong to composition. */
  readonly redisProviderModule?: string;
  /** Opaque trusted module spec; loading and capability checks belong to composition. */
  readonly credentialProviderModule?: string;
  /** Dedicated decrypt-only KMS module; present only for the gateway role. */
  readonly gatewayProviderCredentialDecryptKmsModule?: string;
  /** Trusted runtime module supplying gateway-only policy and provider capabilities. */
  readonly gatewayRuntimeModule?: string;
  /** Dedicated decrypt-only KMS module; present only for the validation worker role. */
  readonly validationWorkerProviderCredentialDecryptKmsModule?: string;
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
  return environment[name] !== undefined;
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
      `${name} must be exactly combined, control-plane, gateway, or credential-validation-worker.`,
      name,
    );
  }

  const role = WORKLOAD_ROLES.find((candidate) => candidate === value);
  if (role === undefined) {
    invalid(
      'INVALID_WORKLOAD_ROLE',
      `${name} must be exactly combined, control-plane, gateway, or credential-validation-worker.`,
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
  const postgresUrlName = postgresUrlEnvironmentName(workloadRole);
  const listenerNames = managedSaasListenerNames(workloadRole);
  const validationWorker = workloadRole === 'credential-validation-worker';
  const gateway = workloadRole === 'gateway';
  if (validationWorker) {
    const forbiddenSettings = [
      MODEL_ROUTER_SAAS_DATABASE_URL,
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
      MODEL_ROUTER_SAAS_REDIS_URL,
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
  } else {
    const forbiddenSettings = gateway
      ? [
          MODEL_ROUTER_SAAS_DATABASE_URL,
          MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
          MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
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
          MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
          MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
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
    environment.NODE_ENV === 'production' || sealingKmsConfigured || validationWorker || gatewayKmsModule !== undefined;
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
    postgresUrl,
    ...(redisUrl === undefined ? {} : { redisUrl }),
    ...(redisProviderModule === undefined ? {} : { redisProviderModule }),
    ...(credentialProviderModule === undefined ? {} : { credentialProviderModule }),
    ...(providerCredentialRewrappingKmsModule === undefined ? {} : { providerCredentialRewrappingKmsModule }),
    ...(gatewayKmsModule === undefined ? {} : { gatewayProviderCredentialDecryptKmsModule: gatewayKmsModule }),
    ...(gatewayRuntimeModule === undefined ? {} : { gatewayRuntimeModule }),
    ...(validationWorkerKmsModule === undefined
      ? {}
      : { validationWorkerProviderCredentialDecryptKmsModule: validationWorkerKmsModule }),
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
