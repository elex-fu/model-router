import {
  type GeneratedProviderCredentialDataKey,
  type GenerateProviderCredentialDataKeyRequest,
  PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
} from '../credentials/provider-crypto.js';
import { SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE } from '../deployment.js';
import {
  type ProviderAwaitable,
  type ProviderEnvironment,
  ProviderLoaderError,
  type ProviderLoaderOptions,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
} from './providers.js';

export { SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE } from '../deployment.js';

const MAX_ENV_ENTRIES = 512;
const MAX_ENV_KEY_BYTES = 256;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_ENV_TOTAL_BYTES = 256 * 1024;
const MAX_MODULE_SPECIFIER_BYTES = 4096;
const MAX_WRAPPED_DATA_KEY_BYTES = 16 * 1024;

/** The managed control-plane KMS surface is limited to sealing operations. */
export interface ProviderCredentialSealingKms {
  generateDataKey(
    request: GenerateProviderCredentialDataKeyRequest,
  ): ProviderAwaitable<GeneratedProviderCredentialDataKey>;
  checkReady(): ProviderAwaitable<void>;
  close(): ProviderAwaitable<void>;
}

/** Promise-normalized lifecycle exposed by the runtime loader. */
export interface LoadedProviderCredentialSealingKms extends ProviderCredentialSealingKms {
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderCredentialSealingKmsFactoryOptions {
  readonly env: ProviderEnvironment;
}

/** Trusted modules must export this exact named factory. */
export interface ProviderCredentialSealingKmsModule {
  createProviderCredentialSealingKms(
    options: ProviderCredentialSealingKmsFactoryOptions,
  ): ProviderAwaitable<ProviderCredentialSealingKms>;
}

export type ProviderCredentialKmsErrorCode =
  | 'DATA_KEY_GENERATION_FAILED'
  | 'INVALID_DATA_KEY'
  | 'READINESS_FAILED'
  | 'PROVIDER_CLOSE_FAILED';

const KMS_ERROR_MESSAGES: Readonly<Record<ProviderCredentialKmsErrorCode, string>> = Object.freeze({
  DATA_KEY_GENERATION_FAILED: 'Provider credential data-key generation failed',
  INVALID_DATA_KEY: 'Provider credential KMS returned an invalid data key',
  READINESS_FAILED: 'Provider credential KMS readiness check failed',
  PROVIDER_CLOSE_FAILED: 'Provider credential KMS cleanup failed',
});

/** Safe operation errors omit provider, key, request, and environment details. */
export class ProviderCredentialKmsError extends Error {
  constructor(readonly code: ProviderCredentialKmsErrorCode) {
    super(KMS_ERROR_MESSAGES[code]);
    this.name = 'ProviderCredentialKmsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type UnknownFunction = (...args: unknown[]) => unknown;

interface ProviderMethods {
  readonly generateDataKey: UnknownFunction;
  readonly checkReady: UnknownFunction;
  readonly close: UnknownFunction;
}

function loaderError(code: ConstructorParameters<typeof ProviderLoaderError>[0]): ProviderLoaderError {
  return new ProviderLoaderError(code);
}

function kmsError(code: ProviderCredentialKmsErrorCode): ProviderCredentialKmsError {
  return new ProviderCredentialKmsError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function providerMethods(value: unknown): ProviderMethods | undefined {
  const generateDataKey = boundMethod(value, 'generateDataKey');
  const checkReady = boundMethod(value, 'checkReady');
  const close = boundMethod(value, 'close');
  if (!generateDataKey || !checkReady || !close) return undefined;
  return { generateDataKey, checkReady, close };
}

function environmentRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readModuleSpecifier(source: unknown): string | undefined {
  const environment = environmentRecord(source);
  if (!environment) throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
  try {
    if (!Object.hasOwn(environment, SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE)) return undefined;
    const value = environment[SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_MODULE_SPECIFIER_BYTES) {
      throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
    }
    return value;
  } catch {
    throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
  }
}

function copyEnvironment(source: unknown): ProviderEnvironment {
  const environment = environmentRecord(source);
  if (!environment) throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
  try {
    const keys = Object.keys(environment);
    if (keys.length > MAX_ENV_ENTRIES) throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');

    const snapshot = Object.create(null) as Record<string, string | undefined>;
    let totalBytes = 0;
    for (const key of keys) {
      const keyBytes = Buffer.byteLength(key, 'utf8');
      if (keyBytes === 0 || keyBytes > MAX_ENV_KEY_BYTES || key.includes('\u0000')) {
        throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
      }
      const rawValue = environment[key];
      if (rawValue !== undefined && typeof rawValue !== 'string') {
        throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
      }
      const value = rawValue as string | undefined;
      const valueBytes = value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
      if (valueBytes > MAX_ENV_VALUE_BYTES || (value?.includes('\u0000') ?? false)) {
        throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
      }
      totalBytes += keyBytes + valueBytes;
      if (totalBytes > MAX_ENV_TOTAL_BYTES) throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value,
        writable: false,
      });
    }
    return Object.freeze(snapshot) as ProviderEnvironment;
  } catch {
    throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
  }
}

function closeOnce(close: UnknownFunction): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    if (closePromise === undefined) {
      closePromise = (async () => {
        try {
          await close();
        } catch {
          throw kmsError('PROVIDER_CLOSE_FAILED');
        }
      })();
    }
    return closePromise;
  };
}

async function closeQuietly(close: (() => Promise<void>) | undefined): Promise<void> {
  if (close === undefined) return;
  try {
    await close();
  } catch {
    // Preserve the safe setup error while still attempting cleanup.
  }
}

function copyGeneratedDataKey(value: unknown): GeneratedProviderCredentialDataKey {
  let plaintextCopy: Buffer | undefined;
  let ciphertextCopy: Buffer | undefined;
  try {
    if (!isRecord(value)) throw kmsError('INVALID_DATA_KEY');
    const ownKeys = Reflect.ownKeys(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.length !== 2 ||
      !Object.hasOwn(value, 'plaintextKey') ||
      !Object.hasOwn(value, 'ciphertextBlob')
    ) {
      throw kmsError('INVALID_DATA_KEY');
    }
    const plaintextKey = value.plaintextKey;
    const ciphertextBlob = value.ciphertextBlob;
    if (
      !(plaintextKey instanceof Uint8Array) ||
      plaintextKey.byteLength !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES ||
      !(ciphertextBlob instanceof Uint8Array) ||
      ciphertextBlob.byteLength === 0 ||
      ciphertextBlob.byteLength > MAX_WRAPPED_DATA_KEY_BYTES
    ) {
      throw kmsError('INVALID_DATA_KEY');
    }
    plaintextCopy = Buffer.from(plaintextKey);
    ciphertextCopy = Buffer.from(ciphertextBlob);
    return Object.freeze({ plaintextKey: plaintextCopy, ciphertextBlob: ciphertextCopy });
  } catch {
    plaintextCopy?.fill(0);
    ciphertextCopy?.fill(0);
    throw kmsError('INVALID_DATA_KEY');
  }
}

/**
 * Optionally load the generate-only adapter using the injected importer and the
 * shared trusted-module resolver. The managed workload is assumed to have
 * GenerateDataKey permission only; a gateway decrypt workload is not provided.
 */
export async function loadProviderCredentialSealingKms(
  options: ProviderLoaderOptions = {},
): Promise<LoadedProviderCredentialSealingKms | undefined> {
  let sourceEnvironment: unknown;
  let rawSpecifier: string | undefined;
  try {
    sourceEnvironment = options.env ?? process.env;
    rawSpecifier = readModuleSpecifier(sourceEnvironment);
  } catch (error) {
    if (error instanceof ProviderLoaderError) throw error;
    throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
  }
  if (rawSpecifier === undefined) return undefined;

  const env = copyEnvironment(sourceEnvironment);
  let specifier: string;
  try {
    specifier = resolveProviderModuleSpecifier(rawSpecifier, options.cwd ?? process.cwd());
  } catch (error) {
    if (error instanceof ProviderLoaderError) throw error;
    throw loaderError('INVALID_MODULE_SPECIFIER');
  }

  let imported: unknown;
  try {
    const importer: ProviderModuleImporter = options.importer ?? options.importModule ?? ((name) => import(name));
    imported = await importer(specifier);
  } catch {
    throw loaderError('PROVIDER_CREDENTIAL_KMS_MODULE_LOAD_FAILED');
  }
  if (!isRecord(imported)) throw loaderError('PROVIDER_CREDENTIAL_KMS_MODULE_EXPORT_INVALID');
  const factory = boundMethod(imported, 'createProviderCredentialSealingKms');
  if (!factory) throw loaderError('PROVIDER_CREDENTIAL_KMS_MODULE_EXPORT_INVALID');

  let rawProvider: unknown;
  try {
    rawProvider = await factory(Object.freeze({ env }));
  } catch {
    throw loaderError('PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED');
  }

  const methods = providerMethods(rawProvider);
  const rawClose = boundMethod(rawProvider, 'close');
  const cleanup = rawClose === undefined ? undefined : closeOnce(rawClose);
  if (!methods || !cleanup) {
    await closeQuietly(cleanup);
    throw loaderError('PROVIDER_CREDENTIAL_KMS_PROVIDER_INVALID');
  }

  try {
    await methods.checkReady();
  } catch {
    await closeQuietly(cleanup);
    throw loaderError('PROVIDER_CREDENTIAL_KMS_READINESS_FAILED');
  }

  return Object.freeze({
    generateDataKey: async (request: GenerateProviderCredentialDataKeyRequest) => {
      let generated: unknown;
      try {
        generated = await methods.generateDataKey(request);
      } catch {
        throw kmsError('DATA_KEY_GENERATION_FAILED');
      }
      return copyGeneratedDataKey(generated);
    },
    checkReady: async () => {
      try {
        await methods.checkReady();
      } catch {
        throw kmsError('READINESS_FAILED');
      }
    },
    close: cleanup,
  });
}
