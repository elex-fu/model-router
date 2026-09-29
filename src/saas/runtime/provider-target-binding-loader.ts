import {
  createProviderTargetResolver,
  type ProviderTargetBindingMap,
  type ProviderTargetResolver,
} from './provider-target-resolver.js';
import { type ProviderEnvironment, type ProviderModuleImporter, resolveProviderModuleSpecifier } from './providers.js';

/** Required deployment-owned module for the managed provider target contract. */
export const SAAS_PROVIDER_TARGET_BINDINGS_MODULE = 'SAAS_PROVIDER_TARGET_BINDINGS_MODULE' as const;

const MAX_MODULE_SPECIFIER_BYTES = 4096;

const SAFE_ERROR_MESSAGES = Object.freeze({
  MISSING_CONFIGURATION: 'Provider target bindings module configuration is required',
  INVALID_CONFIGURATION: 'Provider target bindings loader configuration is invalid',
  INVALID_MODULE_SPECIFIER: 'Provider target bindings module specifier is invalid',
  MODULE_LOAD_FAILED: 'Provider target bindings module could not be loaded',
  MODULE_EXPORT_INVALID: 'Provider target bindings module exports an invalid contract',
  BINDINGS_INVALID: 'Provider target bindings are invalid',
} satisfies Record<string, string>);

export type ProviderTargetBindingLoaderErrorCode = keyof typeof SAFE_ERROR_MESSAGES;

/** Loader failures intentionally omit module specs, URLs, hosts, and causes. */
export class ProviderTargetBindingLoaderError extends Error {
  constructor(readonly code: ProviderTargetBindingLoaderErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'ProviderTargetBindingLoaderError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Exact static contract for a deployment-owned binding module. The binding
 * entry type is imported from the resolver so this module cannot introduce a
 * second endpoint schema or a parallel target source of truth.
 */
export interface ProviderTargetBindingsModule {
  readonly providerTargetBindings: ProviderTargetBindingMap;
}

export interface ProviderTargetBindingLoaderOptions {
  readonly env?: ProviderEnvironment;
  readonly importer?: ProviderModuleImporter;
  /** Compatibility spelling used by the other runtime loaders. */
  readonly importModule?: ProviderModuleImporter;
  /** Override only the base used for relative filesystem module specs in tests. */
  readonly cwd?: string;
}

type UnknownRecord = Record<string, unknown>;

function loaderError(code: ProviderTargetBindingLoaderErrorCode): ProviderTargetBindingLoaderError {
  return new ProviderTargetBindingLoaderError(code);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function normalizeOptions(options: ProviderTargetBindingLoaderOptions | undefined): ProviderTargetBindingLoaderOptions {
  if (options === undefined) return {};
  if (!isPlainRecord(options)) throw loaderError('INVALID_CONFIGURATION');

  try {
    const allowedKeys = ['env', 'importer', 'importModule', 'cwd'] as const;
    if (
      Reflect.ownKeys(options).some(
        (key) => typeof key !== 'string' || !allowedKeys.includes(key as (typeof allowedKeys)[number]),
      )
    ) {
      throw loaderError('INVALID_CONFIGURATION');
    }
    if (options.env !== undefined && !isPlainRecord(options.env)) throw loaderError('INVALID_CONFIGURATION');
    if (options.importer !== undefined && typeof options.importer !== 'function') {
      throw loaderError('INVALID_CONFIGURATION');
    }
    if (options.importModule !== undefined && typeof options.importModule !== 'function') {
      throw loaderError('INVALID_CONFIGURATION');
    }
    if (options.cwd !== undefined && typeof options.cwd !== 'string') throw loaderError('INVALID_CONFIGURATION');
    return options;
  } catch (error) {
    if (error instanceof ProviderTargetBindingLoaderError) throw error;
    throw loaderError('INVALID_CONFIGURATION');
  }
}
function readModuleSpecifier(environment: ProviderEnvironment): string {
  let value: unknown;
  try {
    if (!Object.hasOwn(environment, SAAS_PROVIDER_TARGET_BINDINGS_MODULE)) {
      throw loaderError('MISSING_CONFIGURATION');
    }
    value = environment[SAAS_PROVIDER_TARGET_BINDINGS_MODULE];
  } catch (error) {
    if (error instanceof ProviderTargetBindingLoaderError) throw error;
    throw loaderError('INVALID_CONFIGURATION');
  }

  if (value === undefined) throw loaderError('MISSING_CONFIGURATION');
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\u0000') ||
    Buffer.byteLength(value, 'utf8') > MAX_MODULE_SPECIFIER_BYTES
  ) {
    throw loaderError('INVALID_MODULE_SPECIFIER');
  }
  return value;
}

function defaultImporter(specifier: string): Promise<unknown> {
  return import(specifier);
}

function resolveModuleSpecifier(rawSpecifier: string, cwd: string | undefined): string {
  try {
    return resolveProviderModuleSpecifier(rawSpecifier, cwd ?? process.cwd());
  } catch {
    throw loaderError('INVALID_MODULE_SPECIFIER');
  }
}

function readBindings(imported: unknown): ProviderTargetBindingMap {
  if (!isPlainRecord(imported) || !hasExactKeys(imported, ['providerTargetBindings'])) {
    throw loaderError('MODULE_EXPORT_INVALID');
  }

  let bindings: unknown;
  try {
    bindings = imported.providerTargetBindings;
  } catch {
    throw loaderError('MODULE_EXPORT_INVALID');
  }
  if (!Array.isArray(bindings)) throw loaderError('MODULE_EXPORT_INVALID');
  if (bindings.length === 0) throw loaderError('BINDINGS_INVALID');
  return bindings as ProviderTargetBindingMap;
}

/**
 * Load the required deployment target contract during startup.
 *
 * V2 runtime configuration is deliberately not read here: its upstream
 * `baseUrl` and relative endpoint fields are not a deployment-trusted
 * provider/product binding and carry no exact host/port policy. The static
 * module export below is therefore the deployment source for this missing
 * contract, while the resolver remains the single binding schema and policy
 * validator.
 */
export async function loadProviderTargetResolver(
  options: ProviderTargetBindingLoaderOptions = {},
): Promise<ProviderTargetResolver> {
  const normalizedOptions = normalizeOptions(options);
  const environment = (normalizedOptions.env ?? process.env) as ProviderEnvironment;
  if (!isPlainRecord(environment)) throw loaderError('INVALID_CONFIGURATION');

  const rawSpecifier = readModuleSpecifier(environment);
  const specifier = resolveModuleSpecifier(rawSpecifier, normalizedOptions.cwd);
  const importer = normalizedOptions.importer ?? normalizedOptions.importModule ?? defaultImporter;

  let imported: unknown;
  try {
    imported = await importer(specifier);
  } catch {
    throw loaderError('MODULE_LOAD_FAILED');
  }

  const bindings = readBindings(imported);
  try {
    const resolver = createProviderTargetResolver({ bindings });
    if (!Object.isFrozen(resolver)) throw loaderError('BINDINGS_INVALID');
    return resolver;
  } catch (error) {
    if (error instanceof ProviderTargetBindingLoaderError) throw error;
    throw loaderError('BINDINGS_INVALID');
  }
}
