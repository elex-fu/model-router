import {
  type DecryptProviderCredentialDataKeyRequest,
  PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
  type ProviderCredentialUnsealingKms,
} from '../credentials/provider-crypto.js';
import { MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE } from '../deployment.js';
import {
  type ProviderAwaitable,
  type ProviderEnvironment,
  type ProviderLoaderOptions,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
} from './providers.js';

/** Dedicated setting for the isolated credential-validation worker identity. */
export const SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE;

const MAX_ENV_ENTRIES = 512;
const MAX_ENV_KEY_BYTES = 256;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_ENV_TOTAL_BYTES = 256 * 1024;
const MAX_MODULE_SPECIFIER_BYTES = 4096;

export interface ValidationWorkerProviderCredentialKms {
  decryptDataKey(request: DecryptProviderCredentialDataKeyRequest): ProviderAwaitable<Uint8Array>;
  checkReady(): ProviderAwaitable<void>;
  close(): ProviderAwaitable<void>;
}

export interface ValidationWorkerProviderCredentialKmsFactoryOptions {
  readonly env: ProviderEnvironment;
}

/** The trusted worker KMS module exports this exact decrypt-only factory. */
export interface ValidationWorkerProviderCredentialKmsModule {
  createCredentialValidationWorkerUnsealingKms(
    options: ValidationWorkerProviderCredentialKmsFactoryOptions,
  ): ProviderAwaitable<ValidationWorkerProviderCredentialKms>;
}

export interface LoadedValidationWorkerProviderCredentialKms extends ProviderCredentialUnsealingKms {
  decryptDataKey(request: DecryptProviderCredentialDataKeyRequest): Promise<Uint8Array>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export type ValidationWorkerProviderCredentialKmsErrorCode =
  | 'CONFIGURATION_INVALID'
  | 'MODULE_LOAD_FAILED'
  | 'MODULE_EXPORT_INVALID'
  | 'FACTORY_FAILED'
  | 'PROVIDER_INVALID'
  | 'READINESS_FAILED'
  | 'DECRYPTION_FAILED'
  | 'INVALID_DATA_KEY'
  | 'CLOSE_FAILED';

const ERROR_MESSAGES: Readonly<Record<ValidationWorkerProviderCredentialKmsErrorCode, string>> = Object.freeze({
  CONFIGURATION_INVALID: 'Validation worker KMS configuration is invalid',
  MODULE_LOAD_FAILED: 'Validation worker KMS module could not be loaded',
  MODULE_EXPORT_INVALID: 'Validation worker KMS module export is invalid',
  FACTORY_FAILED: 'Validation worker KMS initialization failed',
  PROVIDER_INVALID: 'Validation worker KMS adapter is invalid',
  READINESS_FAILED: 'Validation worker KMS is not ready',
  DECRYPTION_FAILED: 'Validation worker credential decryption failed',
  INVALID_DATA_KEY: 'Validation worker KMS returned an invalid data key',
  CLOSE_FAILED: 'Validation worker KMS cleanup failed',
});

export class ValidationWorkerProviderCredentialKmsError extends Error {
  constructor(readonly code: ValidationWorkerProviderCredentialKmsErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ValidationWorkerProviderCredentialKmsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type UnknownFunction = (...args: unknown[]) => unknown;

function kmsError(code: ValidationWorkerProviderCredentialKmsErrorCode): ValidationWorkerProviderCredentialKmsError {
  return new ValidationWorkerProviderCredentialKmsError(code);
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

function clearBytes(value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  try {
    value.fill(0);
  } catch {
    // Detached or otherwise malformed buffers cannot be cleared further.
  }
}

function copyEnvironment(source: unknown): ProviderEnvironment {
  if (!isRecord(source)) throw kmsError('CONFIGURATION_INVALID');
  try {
    const keys = Object.keys(source);
    if (keys.length > MAX_ENV_ENTRIES) throw kmsError('CONFIGURATION_INVALID');
    const snapshot = Object.create(null) as Record<string, string | undefined>;
    let totalBytes = 0;
    for (const key of keys) {
      const keyBytes = Buffer.byteLength(key, 'utf8');
      const rawValue = source[key];
      if (
        keyBytes === 0 ||
        keyBytes > MAX_ENV_KEY_BYTES ||
        key.includes('\u0000') ||
        (rawValue !== undefined && typeof rawValue !== 'string')
      ) {
        throw kmsError('CONFIGURATION_INVALID');
      }
      const value = rawValue as string | undefined;
      const valueBytes = value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
      if (valueBytes > MAX_ENV_VALUE_BYTES || (value?.includes('\u0000') ?? false)) {
        throw kmsError('CONFIGURATION_INVALID');
      }
      totalBytes += keyBytes + valueBytes;
      if (totalBytes > MAX_ENV_TOTAL_BYTES) throw kmsError('CONFIGURATION_INVALID');
      Object.defineProperty(snapshot, key, { configurable: false, enumerable: true, value, writable: false });
    }
    return Object.freeze(snapshot) as ProviderEnvironment;
  } catch {
    throw kmsError('CONFIGURATION_INVALID');
  }
}

function closeOnce(close: UnknownFunction): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= (async () => {
      try {
        await close();
      } catch {
        throw kmsError('CLOSE_FAILED');
      }
    })();
    return closePromise;
  };
}

async function closeQuietly(close: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await close?.();
  } catch {
    // Preserve the safe initialization error while still attempting cleanup.
  }
}

function readModuleSpecifier(source: unknown): string | undefined {
  if (!isRecord(source)) throw kmsError('CONFIGURATION_INVALID');
  try {
    if (!Object.hasOwn(source, SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE)) return undefined;
    const value = source[SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_MODULE_SPECIFIER_BYTES) {
      throw kmsError('CONFIGURATION_INVALID');
    }
    return value;
  } catch {
    throw kmsError('CONFIGURATION_INVALID');
  }
}

function requiredMethod(value: unknown, name: string): UnknownFunction | undefined {
  return boundMethod(value, name);
}

/**
 * Loads only the worker-specific decrypt KMS module. The module is optional at
 * this layer so non-worker roles cannot accidentally inherit it; worker
 * startup treats an absent adapter as a configuration error.
 */
export async function loadValidationWorkerProviderCredentialKms(
  options: ProviderLoaderOptions = {},
): Promise<LoadedValidationWorkerProviderCredentialKms | undefined> {
  const sourceEnvironment = options.env ?? process.env;
  const rawSpecifier = readModuleSpecifier(sourceEnvironment);
  if (rawSpecifier === undefined) return undefined;

  const env = copyEnvironment(sourceEnvironment);
  let specifier: string;
  try {
    specifier = resolveProviderModuleSpecifier(rawSpecifier, options.cwd ?? process.cwd());
  } catch {
    throw kmsError('CONFIGURATION_INVALID');
  }

  let imported: unknown;
  try {
    const importer: ProviderModuleImporter = options.importer ?? options.importModule ?? ((name) => import(name));
    imported = await importer(specifier);
  } catch {
    throw kmsError('MODULE_LOAD_FAILED');
  }
  const factory = requiredMethod(imported, 'createCredentialValidationWorkerUnsealingKms');
  if (!factory) throw kmsError('MODULE_EXPORT_INVALID');

  let rawProvider: unknown;
  try {
    rawProvider = await factory(Object.freeze({ env }));
  } catch {
    throw kmsError('FACTORY_FAILED');
  }

  const decryptDataKey = requiredMethod(rawProvider, 'decryptDataKey');
  const checkReady = requiredMethod(rawProvider, 'checkReady');
  const close = requiredMethod(rawProvider, 'close');
  const cleanup = close === undefined ? undefined : closeOnce(close);
  if (!decryptDataKey || !checkReady || !cleanup) {
    await closeQuietly(cleanup);
    throw kmsError('PROVIDER_INVALID');
  }

  try {
    await checkReady();
  } catch {
    await closeQuietly(cleanup);
    throw kmsError('READINESS_FAILED');
  }

  return Object.freeze({
    decryptDataKey: async (request: DecryptProviderCredentialDataKeyRequest): Promise<Uint8Array> => {
      let decrypted: unknown;
      try {
        decrypted = await decryptDataKey(request);
      } catch {
        throw kmsError('DECRYPTION_FAILED');
      }
      try {
        if (!(decrypted instanceof Uint8Array) || decrypted.byteLength !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES) {
          throw kmsError('INVALID_DATA_KEY');
        }
        return Buffer.from(decrypted);
      } catch {
        throw kmsError('INVALID_DATA_KEY');
      } finally {
        clearBytes(decrypted);
      }
    },
    checkReady: async () => {
      try {
        await checkReady();
      } catch {
        throw kmsError('READINESS_FAILED');
      }
    },
    close: cleanup,
  });
}
