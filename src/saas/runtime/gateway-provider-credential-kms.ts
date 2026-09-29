import {
  type DecryptProviderCredentialDataKeyRequest,
  PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
} from '../credentials/provider-crypto.js';
import {
  type ProviderAwaitable,
  type ProviderEnvironment,
  ProviderLoaderError,
  type ProviderLoaderOptions,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
} from './providers.js';

/** Independent module setting for the future gateway provider-credential decrypt workload. */
export const SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  'SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE' as const;

const MAX_ENV_ENTRIES = 512;
const MAX_ENV_KEY_BYTES = 256;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_ENV_TOTAL_BYTES = 256 * 1024;
const MAX_MODULE_SPECIFIER_BYTES = 4096;

/** The gateway KMS facade is limited to unsealing operations. */
export interface ProviderCredentialUnsealingKms {
  decryptDataKey(request: DecryptProviderCredentialDataKeyRequest): ProviderAwaitable<Uint8Array>;
  checkReady(): ProviderAwaitable<void>;
  close(): ProviderAwaitable<void>;
}

/** Promise-normalized lifecycle exposed by the runtime loader. */
export interface LoadedProviderCredentialUnsealingKms extends ProviderCredentialUnsealingKms {
  decryptDataKey(request: DecryptProviderCredentialDataKeyRequest): Promise<Uint8Array>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderCredentialUnsealingKmsFactoryOptions {
  readonly env: ProviderEnvironment;
}

/** Trusted modules must export this exact named factory. */
export interface ProviderCredentialUnsealingKmsModule {
  createGatewayProviderCredentialUnsealingKms(
    options: ProviderCredentialUnsealingKmsFactoryOptions,
  ): ProviderAwaitable<ProviderCredentialUnsealingKms>;
}

export type ProviderCredentialUnsealingKmsErrorCode =
  | 'DATA_KEY_DECRYPTION_FAILED'
  | 'INVALID_DATA_KEY'
  | 'READINESS_FAILED'
  | 'PROVIDER_CLOSE_FAILED';

const KMS_ERROR_MESSAGES: Readonly<Record<ProviderCredentialUnsealingKmsErrorCode, string>> = Object.freeze({
  DATA_KEY_DECRYPTION_FAILED: 'Provider credential data-key decryption failed',
  INVALID_DATA_KEY: 'Provider credential KMS returned an invalid data key',
  READINESS_FAILED: 'Provider credential KMS readiness check failed',
  PROVIDER_CLOSE_FAILED: 'Provider credential KMS cleanup failed',
});

/** Safe operation errors omit provider, key, request, and environment details. */
export class ProviderCredentialUnsealingKmsError extends Error {
  constructor(readonly code: ProviderCredentialUnsealingKmsErrorCode) {
    super(KMS_ERROR_MESSAGES[code]);
    this.name = 'ProviderCredentialUnsealingKmsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Compatibility aliases for callers that name the facade by its gateway role. */
export type GatewayProviderCredentialKmsErrorCode = ProviderCredentialUnsealingKmsErrorCode;
export { ProviderCredentialUnsealingKmsError as GatewayProviderCredentialKmsError };

type UnknownFunction = (...args: unknown[]) => unknown;

interface ProviderMethods {
  readonly decryptDataKey: UnknownFunction;
  readonly checkReady: UnknownFunction;
  readonly close: UnknownFunction;
}

function loaderError(code: ConstructorParameters<typeof ProviderLoaderError>[0]): ProviderLoaderError {
  return new ProviderLoaderError(code);
}

function kmsError(code: ProviderCredentialUnsealingKmsErrorCode): ProviderCredentialUnsealingKmsError {
  return new ProviderCredentialUnsealingKmsError(code);
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
  const decryptDataKey = boundMethod(value, 'decryptDataKey');
  const checkReady = boundMethod(value, 'checkReady');
  const close = boundMethod(value, 'close');
  if (!decryptDataKey || !checkReady || !close) return undefined;
  return { decryptDataKey, checkReady, close };
}

function environmentRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readModuleSpecifier(source: unknown, environmentName: string): string | undefined {
  const environment = environmentRecord(source);
  if (!environment) throw loaderError('PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID');
  try {
    if (!Object.hasOwn(environment, environmentName)) return undefined;
    const value = environment[environmentName];
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

function zeroBuffer(value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  try {
    value.fill(0);
  } catch {
    // A malformed or detached typed array cannot be cleared further.
  }
}

function copyDecryptedDataKey(value: unknown): Uint8Array {
  let copy: Buffer | undefined;
  try {
    if (!(value instanceof Uint8Array) || value.byteLength !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES) {
      throw kmsError('INVALID_DATA_KEY');
    }
    copy = Buffer.from(value);
    if (copy.byteLength !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES) throw kmsError('INVALID_DATA_KEY');
    return copy;
  } catch {
    copy?.fill(0);
    zeroBuffer(value);
    throw kmsError('INVALID_DATA_KEY');
  }
}

/**
 * Optionally load the decrypt-only adapter for a future isolated gateway
 * workload. This loader is intentionally not wired into the current
 * multi-listener process.
 */
export async function loadGatewayProviderCredentialUnsealingKms(
  options: ProviderLoaderOptions = {},
): Promise<LoadedProviderCredentialUnsealingKms | undefined> {
  let sourceEnvironment: unknown;
  let rawSpecifier: string | undefined;
  try {
    sourceEnvironment = options.env ?? process.env;
    rawSpecifier = readModuleSpecifier(
      sourceEnvironment,
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    );
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
  const factory = boundMethod(imported, 'createGatewayProviderCredentialUnsealingKms');
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
    decryptDataKey: async (request: DecryptProviderCredentialDataKeyRequest) => {
      let decrypted: unknown;
      try {
        decrypted = await methods.decryptDataKey(request);
      } catch {
        throw kmsError('DATA_KEY_DECRYPTION_FAILED');
      }
      return copyDecryptedDataKey(decrypted);
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
