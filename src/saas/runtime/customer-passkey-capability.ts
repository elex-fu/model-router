import type { SaasDatabase } from '../db/types.js';
import {
  type DeploymentEnvironment,
  type ManagedSaasDeploymentConfig,
  MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE,
} from '../deployment.js';
import { CustomerPasskeyService } from '../identity/customer-passkey-service.js';
import {
  type LoadedCredentialKeyProvider,
  type ProviderAwaitable,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
} from './providers.js';

export const CUSTOMER_PASSKEY_DEPLOYMENT_PURPOSE = 'customer-passkey-deployment-v1' as const;
/** A deployment choice only, not schema/ACL approval or authenticated-user authority. */
export interface CustomerPasskeyDeploymentDescriptor {
  readonly purpose: typeof CUSTOMER_PASSKEY_DEPLOYMENT_PURPOSE;
  readonly deploymentId: string;
  readonly environmentId: string;
  /** WebAuthn relying-party identity, exact origins and UV policy for the console origin set. */
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  readonly requireUserVerification: boolean;
  /** Exact loaded provider object, never a module-name, key ID or caller Boolean. */
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
}
export interface CustomerPasskeyCapabilityFactoryOptions {
  readonly purpose: typeof CUSTOMER_PASSKEY_DEPLOYMENT_PURPOSE;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
}
/** Trusted code, NOT a sandbox. No database, environment, HTTP or operations supplied. */
export interface CustomerPasskeyCapabilityModule {
  createCustomerPasskeyDeploymentCapability(
    options: CustomerPasskeyCapabilityFactoryOptions,
  ): ProviderAwaitable<CustomerPasskeyDeploymentDescriptor>;
}
export interface CustomerPasskeyCapabilityLoadOptions {
  readonly deployment: ManagedSaasDeploymentConfig;
  readonly environment: DeploymentEnvironment;
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
  readonly importer?: ProviderModuleImporter;
}
export type CustomerPasskeyCapabilityErrorCode =
  | 'CONFIGURATION_INVALID'
  | 'MODULE_FAILED'
  | 'DESCRIPTOR_INVALID'
  | 'READINESS_FAILED';
export class CustomerPasskeyCapabilityError extends Error {
  constructor(readonly code: CustomerPasskeyCapabilityErrorCode) {
    super('Customer passkey deployment capability is unavailable.');
    this.name = 'CustomerPasskeyCapabilityError';
  }
}
function fail(code: CustomerPasskeyCapabilityErrorCode): never {
  throw new CustomerPasskeyCapabilityError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) return fail('DESCRIPTOR_INVALID');
  return descriptor?.value;
}
const keys = [
  'purpose',
  'deploymentId',
  'environmentId',
  'rpId',
  'rpName',
  'origins',
  'requireUserVerification',
  'credentialKeyProvider',
];
/** Opaque core provenance binds the snapshot to this exact loader's inputs. */
const provenance = new WeakMap<
  CustomerPasskeyDeploymentDescriptor,
  {
    readonly deployment: ManagedSaasDeploymentConfig;
    readonly environment: DeploymentEnvironment;
    readonly module: string;
    readonly credentialKeyProvider: LoadedCredentialKeyProvider;
  }
>();

/** Also run before role-specific startup branches: explicit misuse cannot be ignored. */
export function assertCustomerPasskeyDeploymentConfiguration(
  deployment: ManagedSaasDeploymentConfig,
  environment: DeploymentEnvironment,
): string | undefined {
  try {
    const configured = own(deployment, 'customerPasskeyCapabilityModule');
    const declared = own(environment, MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE);
    if (configured !== declared) return fail('CONFIGURATION_INVALID');
    if (configured === undefined) return undefined;
    if (
      deployment.mode !== 'managed-saas' ||
      !['combined', 'control-plane'].includes(deployment.workloadRole) ||
      typeof configured !== 'string' ||
      configured.length === 0 ||
      configured.trim() !== configured ||
      [...configured].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
      Buffer.byteLength(configured, 'utf8') > 4096 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deployment.deploymentId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deployment.environmentId)
    )
      return fail('CONFIGURATION_INVALID');
    return configured;
  } catch {
    return fail('CONFIGURATION_INVALID');
  }
}

function originsValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(
      (origin) =>
        typeof origin === 'string' && origin.length <= 200 && /^https:\/\/[a-z0-9][a-z0-9.:-]{0,252}$/.test(origin),
    ) &&
    new Set(value).size === value.length
  );
}

export async function loadCustomerPasskeyDeploymentCapability(
  options: CustomerPasskeyCapabilityLoadOptions,
): Promise<CustomerPasskeyDeploymentDescriptor | undefined> {
  const configured = assertCustomerPasskeyDeploymentConfiguration(options.deployment, options.environment);
  if (configured === undefined) return undefined; // No DB, KMS, import or new secret.
  try {
    if (
      typeof options.credentialKeyProvider?.getKey !== 'function' ||
      typeof options.credentialKeyProvider.getCurrentKey !== 'function' ||
      typeof options.credentialKeyProvider.checkReady !== 'function'
    )
      return fail('CONFIGURATION_INVALID');
  } catch {
    return fail('CONFIGURATION_INVALID');
  }
  // Snapshot references and dimensions BEFORE trusted module code can yield.
  const context: CustomerPasskeyCapabilityFactoryOptions = Object.freeze({
    purpose: CUSTOMER_PASSKEY_DEPLOYMENT_PURPOSE,
    deploymentId: options.deployment.deploymentId,
    environmentId: options.deployment.environmentId,
    credentialKeyProvider: options.credentialKeyProvider,
  });
  let raw: unknown;
  try {
    const specifier = resolveProviderModuleSpecifier(configured);
    if (specifier.startsWith('file:')) {
      const url = new URL(specifier);
      if (url.hostname || url.username || url.password || url.search || url.hash) return fail('MODULE_FAILED');
    }
    const imported: unknown = await (options.importer ?? ((name: string) => import(name)))(specifier);
    if (!record(imported)) return fail('MODULE_FAILED');
    const factory = own(imported, 'createCustomerPasskeyDeploymentCapability');
    if (typeof factory !== 'function') return fail('MODULE_FAILED');
    raw = await Reflect.apply(factory, imported, [context]);
  } catch {
    return fail('MODULE_FAILED');
  }
  try {
    if (
      !record(raw) ||
      Reflect.ownKeys(raw).length !== keys.length ||
      Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      return fail('DESCRIPTOR_INVALID');
    const purpose = own(raw, 'purpose'),
      deploymentId = own(raw, 'deploymentId'),
      environmentId = own(raw, 'environmentId'),
      rpId = own(raw, 'rpId'),
      rpName = own(raw, 'rpName'),
      origins = own(raw, 'origins'),
      requireUserVerification = own(raw, 'requireUserVerification'),
      credentialKeyProvider = own(raw, 'credentialKeyProvider');
    if (
      purpose !== context.purpose ||
      deploymentId !== context.deploymentId ||
      environmentId !== context.environmentId ||
      credentialKeyProvider !== context.credentialKeyProvider ||
      typeof rpId !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{0,252}\.[a-z]{2,}$/.test(rpId) ||
      typeof rpName !== 'string' ||
      rpName.trim() !== rpName ||
      rpName.length < 1 ||
      rpName.length > 120 ||
      [...rpName].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
      !originsValid(origins) ||
      typeof requireUserVerification !== 'boolean'
    )
      return fail('DESCRIPTOR_INVALID');
    const descriptor: CustomerPasskeyDeploymentDescriptor = Object.freeze({
      ...context,
      rpId,
      rpName,
      origins: Object.freeze([...origins]),
      requireUserVerification,
    });
    provenance.set(
      descriptor,
      Object.freeze({
        deployment: options.deployment,
        environment: options.environment,
        module: configured,
        credentialKeyProvider: context.credentialKeyProvider,
      }),
    );
    return descriptor;
  } catch {
    return fail('DESCRIPTOR_INVALID');
  }
}

/** No injected service factory/readiness seam: only the genuine core service. */
export async function createCustomerPasskeyForDeployment(
  database: SaasDatabase,
  options: CustomerPasskeyCapabilityLoadOptions,
): Promise<CustomerPasskeyService | undefined> {
  const descriptor = await loadCustomerPasskeyDeploymentCapability(options);
  if (!descriptor) return undefined;
  const binding = provenance.get(descriptor);
  if (
    !binding ||
    binding.deployment !== options.deployment ||
    binding.environment !== options.environment ||
    binding.credentialKeyProvider !== options.credentialKeyProvider ||
    descriptor.deploymentId !== options.deployment.deploymentId ||
    descriptor.environmentId !== options.deployment.environmentId ||
    binding.module !== assertCustomerPasskeyDeploymentConfiguration(options.deployment, options.environment)
  )
    return fail('DESCRIPTOR_INVALID');
  const service = new CustomerPasskeyService(database, {
    rpId: descriptor.rpId,
    rpName: descriptor.rpName,
    origins: [...descriptor.origins],
    requireUserVerification: descriptor.requireUserVerification,
    keyProvider: descriptor.credentialKeyProvider,
  });
  try {
    await descriptor.credentialKeyProvider.checkReady();
    await service.checkReady();
    if (
      descriptor.deploymentId !== options.deployment.deploymentId ||
      descriptor.environmentId !== options.deployment.environmentId ||
      binding.credentialKeyProvider !== options.credentialKeyProvider ||
      binding.module !== assertCustomerPasskeyDeploymentConfiguration(options.deployment, options.environment)
    )
      return fail('DESCRIPTOR_INVALID');
  } catch {
    return fail('READINESS_FAILED');
  }
  return service;
}
