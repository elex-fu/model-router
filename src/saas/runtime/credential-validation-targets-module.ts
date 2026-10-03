import { compileApprovedCredentialValidationTargets } from '../supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from '../supply/types.js';
import { MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE } from '../deployment.js';
import {
  type ProviderAwaitable,
  type ProviderEnvironment,
  type ProviderLoaderOptions,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
} from './providers.js';

/** Compatibility export for callers of the standalone metadata loader. */
export { MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE } from '../deployment.js';

export const CREDENTIAL_VALIDATION_TARGETS_FACTORY_PURPOSE = 'credential-validation-target-metadata-v1' as const;

/** No environment, database, KMS, job, tenant, headers, fetch, or lifecycle capability crosses this boundary. */
export interface CredentialValidationTargetsFactoryOptions {
  readonly purpose: typeof CREDENTIAL_VALIDATION_TARGETS_FACTORY_PURPOSE;
}

/**
 * Trusted code must return reviewed static metadata only, without acquiring
 * resources. In-process Node modules are not a sandbox: the operator must
 * review the module itself as well as the returned canonical descriptor.
 */
export interface CredentialValidationTargetsModule {
  createCredentialValidationTargets(
    options: CredentialValidationTargetsFactoryOptions,
  ): ProviderAwaitable<readonly ApprovedCredentialValidationTarget[]>;
}

export interface CredentialValidationTargetsModuleLoaderOptions extends ProviderLoaderOptions {
  /** Trusted clock injection for startup expiry checks; never supplied by a job or tenant. */
  readonly now?: () => number;
}

export type LoadedCredentialValidationTargets = readonly Readonly<ApprovedCredentialValidationTarget>[];

const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_CONFIGURATION: 'Credential validation targets loader configuration is invalid',
  INVALID_MODULE_SPECIFIER: 'Credential validation targets module setting is invalid',
  MODULE_LOAD_FAILED: 'Credential validation targets module could not be loaded',
  MODULE_EXPORT_INVALID: 'Credential validation targets module export is invalid',
  FACTORY_FAILED: 'Credential validation targets metadata initialization failed',
  TARGETS_INVALID: 'Credential validation targets metadata is invalid or unavailable',
});

export type CredentialValidationTargetsModuleErrorCode = keyof typeof SAFE_ERROR_MESSAGES;

/** Failures discard specifiers, URLs, metadata, environment values, and untrusted causes. */
export class CredentialValidationTargetsModuleError extends Error {
  constructor(readonly code: CredentialValidationTargetsModuleErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CredentialValidationTargetsModuleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const MAX_MODULE_SPECIFIER_BYTES = 4096;
// The compiler owns descriptor semantics. These are metadata-copy resource bounds.
const MAX_TARGETS = 1024;
const MAX_METADATA_FIELD_BYTES = 4096;
const MAX_METADATA_TOTAL_BYTES = 4 * 1024 * 1024;
const TARGET_KEYS = Object.freeze([
  'providerId', 'productId', 'credentialType', 'model', 'endpoint', 'capabilityVersion',
  'protocol', 'authProfile', 'baseUrl', 'approvalReference', 'expiresAt', 'evidenceSha256',
] as const satisfies readonly (keyof ApprovedCredentialValidationTarget)[]);
const OPTION_KEYS = ['env', 'importer', 'importModule', 'cwd', 'now'] as const;

type UnknownRecord = Record<string, unknown>;
type UnknownFactory = (options: CredentialValidationTargetsFactoryOptions) => unknown;

function moduleError(code: CredentialValidationTargetsModuleErrorCode): CredentialValidationTargetsModuleError {
  return new CredentialValidationTargetsModuleError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Do not invoke accessors while examining configuration or metadata. */
function ownData(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid data property');
  return descriptor;
}

function normalizeOptions(options: CredentialValidationTargetsModuleLoaderOptions): CredentialValidationTargetsModuleLoaderOptions {
  try {
    if (!isPlainRecord(options)) throw new Error('Invalid options');
    const keys = Reflect.ownKeys(options);
    if (keys.some((key) => typeof key !== 'string' || !OPTION_KEYS.includes(key as typeof OPTION_KEYS[number]))) {
      throw new Error('Invalid option keys');
    }
    const env = ownData(options, 'env')?.value as unknown;
    const importer = ownData(options, 'importer')?.value as unknown;
    const importModule = ownData(options, 'importModule')?.value as unknown;
    const cwd = ownData(options, 'cwd')?.value as unknown;
    const now = ownData(options, 'now')?.value as unknown;
    if ((env !== undefined && !isRecord(env)) ||
      (importer !== undefined && typeof importer !== 'function') ||
      (importModule !== undefined && typeof importModule !== 'function') ||
      (now !== undefined && typeof now !== 'function') ||
      (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0 || cwd.trim() !== cwd ||
        /[\x00-\x1f\x7f]/.test(cwd) || Buffer.byteLength(cwd, 'utf8') > MAX_MODULE_SPECIFIER_BYTES))) {
      throw new Error('Invalid options');
    }
    // Snapshot all loading controls before the importer/factory can yield.
    return Object.freeze({
      ...(env === undefined ? {} : { env: env as ProviderEnvironment }),
      ...(importer === undefined ? {} : { importer: importer as ProviderModuleImporter }),
      ...(importModule === undefined ? {} : { importModule: importModule as ProviderModuleImporter }),
      ...(cwd === undefined ? {} : { cwd: cwd as string }),
      ...(now === undefined ? {} : { now: now as () => number }),
    });
  } catch {
    throw moduleError('INVALID_CONFIGURATION');
  }
}

function readModuleSpecifier(environment: ProviderEnvironment): string | undefined {
  let value: unknown;
  try {
    if (!isRecord(environment)) throw new Error('Invalid environment');
    // Read only this own setting. Unrelated secret-bearing values/getters are
    // neither enumerated nor copied, and no environment is passed to the factory.
    value = ownData(environment, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE)?.value;
  } catch {
    throw moduleError('INVALID_CONFIGURATION');
  }
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value, 'utf8') > MAX_MODULE_SPECIFIER_BYTES) {
    throw moduleError('INVALID_MODULE_SPECIFIER');
  }
  return value;
}

function resolveModuleSpecifier(raw: string, cwd: string | undefined): string {
  try {
    const resolved = resolveProviderModuleSpecifier(raw, cwd ?? process.cwd());
    if (resolved.startsWith('file:')) {
      const url = new URL(resolved);
      if (url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Invalid file module');
    }
    return resolved;
  } catch {
    throw moduleError('INVALID_MODULE_SPECIFIER');
  }
}

function readFactory(imported: unknown): UnknownFactory {
  try {
    if (!isPlainRecord(imported)) throw new Error('Invalid module');
    const factory = ownData(imported, 'createCredentialValidationTargets')?.value as unknown;
    if (typeof factory !== 'function') throw new Error('Invalid factory');
    return factory as UnknownFactory;
  } catch {
    throw moduleError('MODULE_EXPORT_INVALID');
  }
}

function copyMetadata(raw: unknown): LoadedCredentialValidationTargets {
  try {
    if (!Array.isArray(raw)) throw new Error('Invalid targets');
    const length = ownData(raw, 'length')?.value as unknown;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_TARGETS ||
      Reflect.ownKeys(raw).length !== length + 1) throw new Error('Invalid target array');
    const snapshot: Readonly<ApprovedCredentialValidationTarget>[] = [];
    let totalBytes = 0;
    for (let index = 0; index < length; index += 1) {
      const slot = ownData(raw, String(index));
      if (!slot?.enumerable || !isPlainRecord(slot.value)) throw new Error('Invalid target entry');
      const input = slot.value;
      const keys = Reflect.ownKeys(input);
      if (keys.length !== TARGET_KEYS.length ||
        keys.some((key) => typeof key !== 'string' || !TARGET_KEYS.includes(key as typeof TARGET_KEYS[number]))) {
        throw new Error('Invalid target fields');
      }
      const copied = Object.create(null) as UnknownRecord;
      for (const key of TARGET_KEYS) {
        const descriptor = ownData(input, key);
        if (!descriptor?.enumerable) throw new Error('Missing target data');
        const value: unknown = descriptor.value;
        if (typeof value !== 'string' && typeof value !== 'number' && value !== null) {
          throw new Error('Invalid metadata value');
        }
        if (typeof value === 'string') {
          const bytes = Buffer.byteLength(value, 'utf8');
          if (bytes > MAX_METADATA_FIELD_BYTES) throw new Error('Oversized metadata value');
          totalBytes += bytes;
          if (totalBytes > MAX_METADATA_TOTAL_BYTES) throw new Error('Oversized metadata');
        }
        copied[key] = value;
      }
      snapshot.push(Object.freeze(copied) as unknown as Readonly<ApprovedCredentialValidationTarget>);
    }
    // Validate the copy, never repeatedly read caller-owned descriptors/getters.
    // The existing compiler checks canonical HTTPS/profile/model/version/expiry
    // shape, exact tuple uniqueness and the supplied full-descriptor digest.
    compileApprovedCredentialValidationTargets(snapshot);
    return Object.freeze(snapshot);
  } catch {
    throw moduleError('TARGETS_INVALID');
  }
}

function checkedNow(now: () => number): number {
  try {
    const value = now();
    if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new Error('Invalid clock');
    return value;
  } catch {
    throw moduleError('INVALID_CONFIGURATION');
  }
}

/**
 * Missing configuration returns undefined (custom targets remain unavailable).
 * Explicit malformed or expired configuration fails as a whole, without a
 * fallback to another target source, partial filtering, or digest generation.
 *
 * Returned metadata is compatible with the existing SDK credentialValidationTargets
 * option. It is not catalog approval: independently approved capability digest,
 * live account/rights and version authority must still be rechecked by the worker.
 * This module performs no SQL, fetch, DDL, approval write, or requeue operation.
 */
export async function loadCredentialValidationTargetsModule(
  options: CredentialValidationTargetsModuleLoaderOptions = {},
): Promise<LoadedCredentialValidationTargets | undefined> {
  const normalized = normalizeOptions(options);
  const rawSpecifier = readModuleSpecifier(normalized.env ?? process.env);
  if (rawSpecifier === undefined) return undefined;
  const specifier = resolveModuleSpecifier(rawSpecifier, normalized.cwd);
  const importer = normalized.importer ?? normalized.importModule ?? ((name: string) => import(name));
  const now = normalized.now ?? Date.now;

  let imported: unknown;
  try {
    imported = await importer(specifier);
  } catch {
    throw moduleError('MODULE_LOAD_FAILED');
  }
  const factory = readFactory(imported);
  let raw: unknown;
  try {
    raw = await Reflect.apply(factory, imported, [Object.freeze({ purpose: CREDENTIAL_VALIDATION_TARGETS_FACTORY_PURPOSE })]);
  } catch {
    throw moduleError('FACTORY_FAILED');
  }
  const targets = copyMetadata(raw);
  const loadedAt = checkedNow(now);
  if (targets.some((target) => target.expiresAt !== null && Date.parse(target.expiresAt) <= loadedAt)) {
    throw moduleError('TARGETS_INVALID');
  }
  return targets;
}
