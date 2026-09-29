import type {
  ProviderCredentialRewrappingKms,
  ReencryptedProviderCredentialDataKey,
  ReencryptProviderCredentialDataKeyRequest,
} from '../credentials/provider-crypto.js';
import {
  MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../deployment.js';
import type { ProviderAwaitable, ProviderEnvironment, ProviderModuleImporter } from './providers.js';
import { resolveProviderModuleSpecifier } from './providers.js';

export { SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE } from '../deployment.js';

const MAX_MODULE_SPECIFIER_BYTES = 4096;
const MAX_WRAPPED_DATA_KEY_BYTES = 16 * 1024;

export type ProviderCredentialRewrappingKmsErrorCode =
  | 'CONFIGURATION_INVALID'
  | 'MODULE_LOAD_FAILED'
  | 'MODULE_CONTRACT_INVALID'
  | 'FACTORY_FAILED'
  | 'PROVIDER_CONTRACT_INVALID'
  | 'READINESS_FAILED'
  | 'REENCRYPT_FAILED'
  | 'PROVIDER_CLOSE_FAILED';

const SAFE_ERROR_MESSAGES: Readonly<Record<ProviderCredentialRewrappingKmsErrorCode, string>> = Object.freeze({
  CONFIGURATION_INVALID: 'Provider credential rewrapping KMS configuration is invalid',
  MODULE_LOAD_FAILED: 'Provider credential rewrapping KMS module could not be loaded',
  MODULE_CONTRACT_INVALID: 'Provider credential rewrapping KMS module exports an invalid contract',
  FACTORY_FAILED: 'Provider credential rewrapping KMS factory failed',
  PROVIDER_CONTRACT_INVALID: 'Provider credential rewrapping KMS returned an invalid contract',
  READINESS_FAILED: 'Provider credential rewrapping KMS readiness check failed',
  REENCRYPT_FAILED: 'Provider credential rewrapping failed',
  PROVIDER_CLOSE_FAILED: 'Provider credential rewrapping KMS cleanup failed',
});

export class ProviderCredentialRewrappingKmsError extends Error {
  constructor(readonly code: ProviderCredentialRewrappingKmsErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'ProviderCredentialRewrappingKmsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface LoadedProviderCredentialRewrappingKms extends ProviderCredentialRewrappingKms {
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderCredentialRewrappingKmsFactoryOptions {
  readonly env: ProviderEnvironment;
}

/** A trusted module exposes a dedicated ReEncrypt-only KMS client. */
export interface ProviderCredentialRewrappingKmsModule {
  createProviderCredentialRewrappingKms(
    options: ProviderCredentialRewrappingKmsFactoryOptions,
  ): ProviderAwaitable<unknown>;
}

export interface ProviderCredentialRewrappingKmsLoaderOptions {
  readonly env?: ProviderEnvironment;
  readonly importer?: ProviderModuleImporter;
  readonly cwd?: string;
  /** Trusted key resolved by the deployment parser; must match the runtime environment. */
  readonly destinationKmsKeyId?: string;
}

type UnknownFunction = (...args: unknown[]) => unknown;

interface ProviderMethods {
  readonly reencryptDataKey: UnknownFunction;
  readonly checkReady: UnknownFunction;
  readonly close: UnknownFunction;
}

function fail(code: ProviderCredentialRewrappingKmsErrorCode): never {
  throw new ProviderCredentialRewrappingKmsError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dedicatedModuleFactory(value: unknown): UnknownFunction | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    const names = keys.filter((key): key is string => typeof key === 'string');
    if (
      names.length !== 1 ||
      names[0] !== 'createProviderCredentialRewrappingKms' ||
      keys.some((key) => typeof key === 'symbol' && key !== Symbol.toStringTag)
    ) {
      return undefined;
    }
    const candidate = Object.getOwnPropertyDescriptor(value, 'createProviderCredentialRewrappingKms')?.value;
    return typeof candidate === 'function' ? (candidate.bind(value) as UnknownFunction) : undefined;
  } catch {
    return undefined;
  }
}

function safeProviderMethods(value: unknown): ProviderMethods | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value).sort((left, right) => String(left).localeCompare(String(right)));
    const expected = ['checkReady', 'close', 'reencryptDataKey'];
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])
    ) {
      return undefined;
    }
    const methods = Object.fromEntries(
      expected.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]),
    );
    if (expected.some((key) => typeof methods[key] !== 'function')) return undefined;
    return {
      reencryptDataKey: (methods.reencryptDataKey as UnknownFunction).bind(value),
      checkReady: (methods.checkReady as UnknownFunction).bind(value),
      close: (methods.close as UnknownFunction).bind(value),
    };
  } catch {
    return undefined;
  }
}

function closeOnce(close: UnknownFunction): () => Promise<void> {
  let closed: Promise<void> | undefined;
  return () => {
    closed ??= (async () => {
      try {
        await close();
      } catch {
        fail('PROVIDER_CLOSE_FAILED');
      }
    })();
    return closed;
  };
}

function copiedReencryptedDataKey(
  value: unknown,
  request: ReencryptProviderCredentialDataKeyRequest,
): ReencryptedProviderCredentialDataKey {
  if (!isRecord(value)) fail('REENCRYPT_FAILED');
  try {
    const keys = Reflect.ownKeys(value).sort((left, right) => String(left).localeCompare(String(right)));
    const expected = ['ciphertextBlob', 'destinationKmsKeyId', 'sourceKmsKeyId'];
    const prototype = Object.getPrototypeOf(value);
    const sourceKmsKeyId = Object.getOwnPropertyDescriptor(value, 'sourceKmsKeyId')?.value;
    const destinationKmsKeyId = Object.getOwnPropertyDescriptor(value, 'destinationKmsKeyId')?.value;
    const ciphertextBlob = Object.getOwnPropertyDescriptor(value, 'ciphertextBlob')?.value;
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      sourceKmsKeyId !== request.sourceKmsKeyId ||
      destinationKmsKeyId !== request.destinationKmsKeyId ||
      !(ciphertextBlob instanceof Uint8Array) ||
      ciphertextBlob.byteLength === 0 ||
      ciphertextBlob.byteLength > MAX_WRAPPED_DATA_KEY_BYTES
    ) {
      fail('REENCRYPT_FAILED');
    }
    return {
      sourceKmsKeyId,
      destinationKmsKeyId,
      ciphertextBlob: Buffer.from(ciphertextBlob),
    };
  } catch (error) {
    if (error instanceof ProviderCredentialRewrappingKmsError) throw error;
    fail('REENCRYPT_FAILED');
  }
}

function moduleSpecifier(env: ProviderEnvironment): string | undefined {
  const raw = env[SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE];
  if (raw === undefined) return undefined;
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.trim() !== raw ||
    Buffer.byteLength(raw, 'utf8') > MAX_MODULE_SPECIFIER_BYTES ||
    raw === env[SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE] ||
    raw === env[SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE] ||
    raw === env[MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]
  ) {
    fail('CONFIGURATION_INVALID');
  }
  if (!env[MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID]) fail('CONFIGURATION_INVALID');
  return raw;
}

/**
 * Load a distinct ReEncrypt-only module. Its returned object is allowlisted to
 * exactly reencryptDataKey/checkReady/close, so sealing or decrypting KMS
 * capabilities cannot cross this boundary.
 */
export async function loadProviderCredentialRewrappingKms(
  options: ProviderCredentialRewrappingKmsLoaderOptions = {},
): Promise<LoadedProviderCredentialRewrappingKms | undefined> {
  const source = options.env ?? (process.env as ProviderEnvironment);
  const rawSpecifier = moduleSpecifier(source);
  if (rawSpecifier === undefined) return undefined;
  const environmentDestinationKmsKeyId = source[MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID];
  const destinationKmsKeyId = options.destinationKmsKeyId ?? environmentDestinationKmsKeyId;
  if (
    typeof destinationKmsKeyId !== 'string' ||
    destinationKmsKeyId.trim() === '' ||
    environmentDestinationKmsKeyId !== destinationKmsKeyId
  ) {
    fail('CONFIGURATION_INVALID');
  }

  let specifier: string;
  try {
    specifier = resolveProviderModuleSpecifier(rawSpecifier, options.cwd ?? process.cwd());
  } catch {
    fail('CONFIGURATION_INVALID');
  }
  for (const setting of [
    SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
    MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  ]) {
    const otherSpecifier = source[setting];
    if (otherSpecifier === undefined) continue;
    let resolvedOtherSpecifier: string;
    try {
      resolvedOtherSpecifier = resolveProviderModuleSpecifier(otherSpecifier, options.cwd ?? process.cwd());
    } catch {
      fail('CONFIGURATION_INVALID');
    }
    if (resolvedOtherSpecifier === specifier) fail('CONFIGURATION_INVALID');
  }

  let imported: unknown;
  try {
    imported = await (options.importer ?? ((name) => import(name)))(specifier);
  } catch {
    fail('MODULE_LOAD_FAILED');
  }
  const factory = dedicatedModuleFactory(imported);
  if (!factory) fail('MODULE_CONTRACT_INVALID');

  let rawProvider: unknown;
  try {
    rawProvider = await factory(Object.freeze({ env: Object.freeze({ ...source }) }));
  } catch {
    fail('FACTORY_FAILED');
  }
  const methods = safeProviderMethods(rawProvider);
  if (!methods) fail('PROVIDER_CONTRACT_INVALID');
  const close = closeOnce(methods.close);
  try {
    await methods.checkReady();
  } catch {
    try {
      await close();
    } catch {
      // Preserve the safe readiness error.
    }
    fail('READINESS_FAILED');
  }

  return Object.freeze({
    async reencryptDataKey(request: ReencryptProviderCredentialDataKeyRequest) {
      let ciphertextBlob: Buffer | undefined;
      try {
        if (
          request.destinationKmsKeyId !== destinationKmsKeyId ||
          !(request.ciphertextBlob instanceof Uint8Array) ||
          request.ciphertextBlob.byteLength === 0
        ) {
          fail('REENCRYPT_FAILED');
        }
        ciphertextBlob = Buffer.from(request.ciphertextBlob);
        const copiedRequest = Object.freeze({
          sourceKmsKeyId: request.sourceKmsKeyId,
          destinationKmsKeyId: request.destinationKmsKeyId,
          ciphertextBlob,
          sourceEncryptionContext: Object.freeze({ ...request.sourceEncryptionContext }),
          destinationEncryptionContext: Object.freeze({ ...request.destinationEncryptionContext }),
        });
        let result: unknown;
        try {
          result = await methods.reencryptDataKey(copiedRequest);
        } catch {
          fail('REENCRYPT_FAILED');
        }
        return copiedReencryptedDataKey(result, request);
      } catch (error) {
        if (error instanceof ProviderCredentialRewrappingKmsError) throw error;
        fail('REENCRYPT_FAILED');
      } finally {
        ciphertextBlob?.fill(0);
      }
    },
    async checkReady() {
      try {
        await methods.checkReady();
      } catch {
        fail('READINESS_FAILED');
      }
    },
    close,
  });
}
