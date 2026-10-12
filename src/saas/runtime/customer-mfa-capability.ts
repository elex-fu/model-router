import type { SaasDatabase } from '../db/types.js';
import {
  type DeploymentEnvironment,
  type ManagedSaasDeploymentConfig,
  MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE,
} from '../deployment.js';
import { CustomerMfaService } from '../identity/customer-mfa-service.js';
import {
  type LoadedCredentialKeyProvider,
  type ProviderAwaitable,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
} from './providers.js';

export const CUSTOMER_MFA_DEPLOYMENT_PURPOSE = 'customer-mfa-deployment-v1' as const;
/** A deployment choice only, not schema/ACL approval or authenticated-user authority. */
export interface CustomerMfaDeploymentDescriptor {
  readonly purpose: typeof CUSTOMER_MFA_DEPLOYMENT_PURPOSE;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly issuer: string;
  /** Exact loaded provider object, never a module-name, key ID or caller Boolean. */
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
}
export interface CustomerMfaCapabilityFactoryOptions {
  readonly purpose: typeof CUSTOMER_MFA_DEPLOYMENT_PURPOSE;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
}
/** Trusted code, NOT a sandbox. No database, environment, HTTP or operations supplied. */
export interface CustomerMfaCapabilityModule {
  createCustomerMfaDeploymentCapability(
    options: CustomerMfaCapabilityFactoryOptions,
  ): ProviderAwaitable<CustomerMfaDeploymentDescriptor>;
}
export interface CustomerMfaCapabilityLoadOptions {
  readonly deployment: ManagedSaasDeploymentConfig;
  readonly environment: DeploymentEnvironment;
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
  readonly importer?: ProviderModuleImporter;
}
export type CustomerMfaCapabilityErrorCode =
  | 'CONFIGURATION_INVALID'
  | 'MODULE_FAILED'
  | 'DESCRIPTOR_INVALID'
  | 'READINESS_FAILED';
export class CustomerMfaCapabilityError extends Error {
  constructor(readonly code: CustomerMfaCapabilityErrorCode) {
    super('Customer MFA deployment capability is unavailable.');
    this.name = 'CustomerMfaCapabilityError';
  }
}
function fail(code: CustomerMfaCapabilityErrorCode): never {
  throw new CustomerMfaCapabilityError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) return fail('DESCRIPTOR_INVALID');
  return descriptor?.value;
}
const keys = ['purpose', 'deploymentId', 'environmentId', 'issuer', 'credentialKeyProvider'];
/** Opaque core provenance binds the snapshot to this exact loader's inputs. */
const provenance = new WeakMap<
  CustomerMfaDeploymentDescriptor,
  {
    readonly deployment: ManagedSaasDeploymentConfig;
    readonly environment: DeploymentEnvironment;
    readonly module: string;
    readonly credentialKeyProvider: LoadedCredentialKeyProvider;
  }
>();

/** Also run before role-specific startup branches: explicit misuse cannot be ignored. */
export function assertCustomerMfaDeploymentConfiguration(
  deployment: ManagedSaasDeploymentConfig,
  environment: DeploymentEnvironment,
): string | undefined {
  try {
    const configured = own(deployment, 'customerMfaCapabilityModule');
    const declared = own(environment, MODEL_ROUTER_SAAS_CUSTOMER_MFA_CAPABILITY_MODULE);
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

export async function loadCustomerMfaDeploymentCapability(
  options: CustomerMfaCapabilityLoadOptions,
): Promise<CustomerMfaDeploymentDescriptor | undefined> {
  const configured = assertCustomerMfaDeploymentConfiguration(options.deployment, options.environment);
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
  const context: CustomerMfaCapabilityFactoryOptions = Object.freeze({
    purpose: CUSTOMER_MFA_DEPLOYMENT_PURPOSE,
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
    const factory = own(imported, 'createCustomerMfaDeploymentCapability');
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
      issuer = own(raw, 'issuer'),
      credentialKeyProvider = own(raw, 'credentialKeyProvider');
    if (
      purpose !== context.purpose ||
      deploymentId !== context.deploymentId ||
      environmentId !== context.environmentId ||
      credentialKeyProvider !== context.credentialKeyProvider ||
      typeof issuer !== 'string' ||
      issuer.trim() !== issuer ||
      issuer.length < 1 ||
      issuer.length > 120 ||
      [...issuer].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
    )
      return fail('DESCRIPTOR_INVALID');
    const descriptor: CustomerMfaDeploymentDescriptor = Object.freeze({ ...context, issuer });
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
export async function createCustomerMfaForDeployment(
  database: SaasDatabase,
  options: CustomerMfaCapabilityLoadOptions,
): Promise<CustomerMfaService | undefined> {
  const descriptor = await loadCustomerMfaDeploymentCapability(options);
  if (!descriptor) return undefined;
  const binding = provenance.get(descriptor);
  if (
    !binding ||
    binding.deployment !== options.deployment ||
    binding.environment !== options.environment ||
    binding.credentialKeyProvider !== options.credentialKeyProvider ||
    descriptor.deploymentId !== options.deployment.deploymentId ||
    descriptor.environmentId !== options.deployment.environmentId ||
    binding.module !== assertCustomerMfaDeploymentConfiguration(options.deployment, options.environment)
  )
    return fail('DESCRIPTOR_INVALID');
  const service = new CustomerMfaService(database, {
    issuer: descriptor.issuer,
    keyProvider: descriptor.credentialKeyProvider,
  });
  try {
    await descriptor.credentialKeyProvider.checkReady();
    await service.checkReady();
    if (
      descriptor.deploymentId !== options.deployment.deploymentId ||
      descriptor.environmentId !== options.deployment.environmentId ||
      binding.credentialKeyProvider !== options.credentialKeyProvider ||
      binding.module !== assertCustomerMfaDeploymentConfiguration(options.deployment, options.environment)
    )
      return fail('DESCRIPTOR_INVALID');
  } catch {
    return fail('READINESS_FAILED');
  }
  return service;
}
