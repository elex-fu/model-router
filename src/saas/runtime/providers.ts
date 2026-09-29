import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type CredentialEnvelope,
  type CredentialKeyMaterial,
  type CredentialKeyProvider,
  decryptCredential,
  encryptCredential,
  type UserCredentialContext,
} from '../credentials/crypto.js';
import type { ManagedSaasDeploymentConfig } from '../deployment.js';
import { MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID } from '../deployment.js';
import {
  type LoadedProviderCredentialSealingKms,
  loadProviderCredentialSealingKms,
} from './provider-credential-kms.js';
import {
  type LoadedProviderCredentialRewrappingKms,
  loadProviderCredentialRewrappingKms,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
} from './provider-credential-rewrapping-kms.js';

export type {
  LoadedProviderCredentialSealingKms,
  ProviderCredentialKmsErrorCode,
  ProviderCredentialSealingKms,
  ProviderCredentialSealingKmsFactoryOptions,
  ProviderCredentialSealingKmsModule,
} from './provider-credential-kms.js';
export {
  loadProviderCredentialSealingKms,
  ProviderCredentialKmsError,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from './provider-credential-kms.js';
export type {
  LoadedProviderCredentialRewrappingKms,
  ProviderCredentialRewrappingKmsErrorCode,
  ProviderCredentialRewrappingKmsFactoryOptions,
  ProviderCredentialRewrappingKmsLoaderOptions,
  ProviderCredentialRewrappingKmsModule,
} from './provider-credential-rewrapping-kms.js';
export {
  loadProviderCredentialRewrappingKms,
  ProviderCredentialRewrappingKmsError,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
} from './provider-credential-rewrapping-kms.js';

/** Environment values are copied before they cross the KMS provider boundary. */
export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export type ProviderModuleImporter = (specifier: string) => unknown | PromiseLike<unknown>;

export type ProviderAwaitable<T> = T | PromiseLike<T>;

export const PLATFORM_TOTP_PURPOSE = 'platform-totp' as const;
export const PLATFORM_AUTH_NAMESPACE = 'platform-auth' as const;
export const CUSTOMER_AUTH_NAMESPACE = 'customer-auth' as const;

/** The provider owns the namespace implementation; this is only the application prefix. */
export const MANAGED_SAAS_REDIS_KEY_PREFIX = 'model-router:saas' as const;

/** Keep the managed defaults aligned with the local customer-auth compatibility limiter. */
export const PLATFORM_AUTH_RATE_LIMIT = 10;
export const CUSTOMER_AUTH_RATE_LIMIT = 10;
export const PLATFORM_AUTH_RATE_WINDOW_MS = 15 * 60_000;
export const CUSTOMER_AUTH_RATE_WINDOW_MS = 15 * 60_000;

export interface CredentialKeyProviderFactoryOptions {
  readonly env: ProviderEnvironment;
  readonly purpose: typeof PLATFORM_TOTP_PURPOSE;
}

export interface LoadedCredentialKeyProvider extends CredentialKeyProvider {
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export interface CredentialProviderModule {
  createCredentialKeyProvider(options: CredentialKeyProviderFactoryOptions): Promise<LoadedCredentialKeyProvider>;
}

export type ManagedRateLimiterNamespace = typeof PLATFORM_AUTH_NAMESPACE | typeof CUSTOMER_AUTH_NAMESPACE;

export interface ManagedRateLimiter {
  take(key: string): Promise<number | undefined>;
}

export interface RedisRateLimiterOptions {
  readonly namespace: ManagedRateLimiterNamespace;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RedisProviderFactoryOptions {
  readonly url: string;
  readonly keyPrefix: string;
}

export interface RedisProvider {
  createRateLimiter(options: RedisRateLimiterOptions): ProviderAwaitable<ManagedRateLimiter>;
  checkReady(): ProviderAwaitable<void>;
  close(): ProviderAwaitable<void>;
}

export interface RedisProviderModule {
  createRedisProvider(options: RedisProviderFactoryOptions): Promise<RedisProvider>;
}

export interface ProviderLoaderOptions {
  readonly env?: ProviderEnvironment;
  readonly importer?: ProviderModuleImporter;
  /** Compatibility spelling for callers that name the injection after the operation. */
  readonly importModule?: ProviderModuleImporter;
  /** Override only the base used for relative filesystem module specs in tests. */
  readonly cwd?: string;
}

export interface ManagedSaasProviders {
  readonly credentialKeyProvider: LoadedCredentialKeyProvider;
  readonly providerCredentialSealingKms?: LoadedProviderCredentialSealingKms;
  /** Separate, remote ReEncrypt-only capability for platform credential wrapper rotation. */
  readonly providerCredentialRewrappingKms?: LoadedProviderCredentialRewrappingKms;
  readonly platformAuthRateLimiter: ManagedRateLimiter;
  readonly customerAuthRateLimiter: ManagedRateLimiter;
  close(): Promise<void>;
}

export type ProviderLoaderErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_MODULE_SPECIFIER'
  | 'CREDENTIAL_MODULE_LOAD_FAILED'
  | 'REDIS_MODULE_LOAD_FAILED'
  | 'CREDENTIAL_MODULE_EXPORT_INVALID'
  | 'REDIS_MODULE_EXPORT_INVALID'
  | 'CREDENTIAL_FACTORY_FAILED'
  | 'REDIS_FACTORY_FAILED'
  | 'CREDENTIAL_PROVIDER_INVALID'
  | 'REDIS_PROVIDER_INVALID'
  | 'CREDENTIAL_READINESS_FAILED'
  | 'CREDENTIAL_PROBE_FAILED'
  | 'REDIS_READINESS_FAILED'
  | 'REDIS_RATE_LIMITER_FACTORY_FAILED'
  | 'REDIS_RATE_LIMITER_INVALID'
  | 'PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID'
  | 'PROVIDER_CREDENTIAL_KMS_MODULE_LOAD_FAILED'
  | 'PROVIDER_CREDENTIAL_KMS_MODULE_EXPORT_INVALID'
  | 'PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED'
  | 'PROVIDER_CREDENTIAL_KMS_PROVIDER_INVALID'
  | 'PROVIDER_CREDENTIAL_KMS_READINESS_FAILED'
  | 'PROVIDER_CLOSE_FAILED';

const SAFE_ERROR_MESSAGES: Record<ProviderLoaderErrorCode, string> = {
  INVALID_CONFIGURATION: 'Managed provider configuration is invalid',
  INVALID_MODULE_SPECIFIER: 'Managed provider module configuration is invalid',
  CREDENTIAL_MODULE_LOAD_FAILED: 'Credential provider module could not be loaded',
  REDIS_MODULE_LOAD_FAILED: 'Redis provider module could not be loaded',
  CREDENTIAL_MODULE_EXPORT_INVALID: 'Credential provider module exports an invalid contract',
  REDIS_MODULE_EXPORT_INVALID: 'Redis provider module exports an invalid contract',
  CREDENTIAL_FACTORY_FAILED: 'Credential provider factory failed',
  REDIS_FACTORY_FAILED: 'Redis provider factory failed',
  CREDENTIAL_PROVIDER_INVALID: 'Credential provider returned an invalid contract',
  REDIS_PROVIDER_INVALID: 'Redis provider returned an invalid contract',
  CREDENTIAL_READINESS_FAILED: 'Credential provider readiness check failed',
  CREDENTIAL_PROBE_FAILED: 'Credential provider encryption readiness probe failed',
  REDIS_READINESS_FAILED: 'Redis provider readiness check failed',
  REDIS_RATE_LIMITER_FACTORY_FAILED: 'Redis rate limiter factory failed',
  REDIS_RATE_LIMITER_INVALID: 'Redis rate limiter returned an invalid contract',
  PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID: 'Provider credential KMS configuration is invalid',
  PROVIDER_CREDENTIAL_KMS_MODULE_LOAD_FAILED: 'Provider credential KMS module could not be loaded',
  PROVIDER_CREDENTIAL_KMS_MODULE_EXPORT_INVALID: 'Provider credential KMS module exports an invalid contract',
  PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED: 'Provider credential KMS factory failed',
  PROVIDER_CREDENTIAL_KMS_PROVIDER_INVALID: 'Provider credential KMS returned an invalid contract',
  PROVIDER_CREDENTIAL_KMS_READINESS_FAILED: 'Provider credential KMS readiness check failed',
  PROVIDER_CLOSE_FAILED: 'Managed provider cleanup failed',
};

/** All loader failures intentionally discard module, URL, environment, and provider error details. */
export class ProviderLoaderError extends Error {
  constructor(readonly code: ProviderLoaderErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'ProviderLoaderError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type UnknownFunction = (...args: unknown[]) => unknown;

interface CredentialMethods {
  readonly getCurrentKey: UnknownFunction;
  readonly getKey: UnknownFunction;
  readonly checkReady: UnknownFunction;
  readonly close: UnknownFunction;
}

interface RedisMethods {
  readonly createRateLimiter: UnknownFunction;
  readonly checkReady: UnknownFunction;
  readonly close: UnknownFunction;
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

function providerError(code: ProviderLoaderErrorCode): ProviderLoaderError {
  return new ProviderLoaderError(code);
}

function isProviderLoaderError(error: unknown): error is ProviderLoaderError {
  return error instanceof ProviderLoaderError;
}

function closeOnce(close: UnknownFunction): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    if (closePromise === undefined) {
      closePromise = (async () => {
        await close();
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
    // Preserve the setup failure. Cleanup is still attempted for every resource.
  }
}

async function closeAll(closes: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(closes.map((close) => close()));
  if (results.some((result) => result.status === 'rejected')) throw providerError('PROVIDER_CLOSE_FAILED');
}

function defaultImporter(specifier: string): Promise<unknown> {
  return import(specifier);
}

/**
 * Normalize the four supported trusted-module forms before handing them to the
 * importer. Bare package specifiers remain package specifiers; filesystem paths
 * are converted to absolute file URLs so their base is never this source file.
 */
export function resolveProviderModuleSpecifier(specifier: string, cwd = process.cwd()): string {
  if (typeof specifier !== 'string' || specifier.length === 0 || specifier.trim() !== specifier) {
    throw providerError('INVALID_MODULE_SPECIFIER');
  }

  if (specifier.startsWith('file:')) {
    try {
      const url = new URL(specifier);
      if (url.protocol !== 'file:') throw new Error('not a file URL');
      return url.href;
    } catch {
      throw providerError('INVALID_MODULE_SPECIFIER');
    }
  }

  if (isAbsolute(specifier)) {
    try {
      return pathToFileURL(specifier).href;
    } catch {
      throw providerError('INVALID_MODULE_SPECIFIER');
    }
  }

  if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return pathToFileURL(resolve(cwd, specifier)).href;
    } catch {
      throw providerError('INVALID_MODULE_SPECIFIER');
    }
  }

  // A non-file URL would be a different loading mechanism, not a trusted Node
  // module specifier. Do not let the native importer make that decision here.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
    throw providerError('INVALID_MODULE_SPECIFIER');
  }

  return specifier;
}

function normalizeLoaderOptions(
  optionsOrEnvironment?: ProviderLoaderOptions | ProviderEnvironment | ProviderModuleImporter,
  positionalImporter?: ProviderModuleImporter,
): ProviderLoaderOptions {
  try {
    if (optionsOrEnvironment === undefined) {
      return positionalImporter === undefined ? {} : { importer: positionalImporter };
    }

    if (typeof optionsOrEnvironment === 'function') {
      return { importer: optionsOrEnvironment };
    }

    if (
      isRecord(optionsOrEnvironment) &&
      ('env' in optionsOrEnvironment ||
        'importer' in optionsOrEnvironment ||
        'importModule' in optionsOrEnvironment ||
        'cwd' in optionsOrEnvironment)
    ) {
      return {
        env: optionsOrEnvironment.env as ProviderEnvironment | undefined,
        importer: (positionalImporter ?? optionsOrEnvironment.importer ?? optionsOrEnvironment.importModule) as
          | ProviderModuleImporter
          | undefined,
        cwd: optionsOrEnvironment.cwd as string | undefined,
      };
    }

    return { env: optionsOrEnvironment as ProviderEnvironment, importer: positionalImporter };
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError('INVALID_CONFIGURATION');
  }
}

function credentialModuleSpec(
  configOrModule: Pick<ManagedSaasDeploymentConfig, 'credentialProviderModule'> | string,
): string {
  if (typeof configOrModule === 'string') return configOrModule;
  try {
    if (!isRecord(configOrModule) || typeof configOrModule.credentialProviderModule !== 'string') {
      throw providerError('INVALID_CONFIGURATION');
    }
    return configOrModule.credentialProviderModule;
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError('INVALID_CONFIGURATION');
  }
}

function managedConfigValues(config: ManagedSaasDeploymentConfig): {
  readonly credentialProviderModule: string;
  readonly redisProviderModule: string;
  readonly redisUrl: string;
} {
  try {
    if (
      !isRecord(config) ||
      config.mode !== 'managed-saas' ||
      typeof config.credentialProviderModule !== 'string' ||
      typeof config.redisProviderModule !== 'string' ||
      typeof config.redisUrl !== 'string'
    ) {
      throw providerError('INVALID_CONFIGURATION');
    }
    return {
      credentialProviderModule: config.credentialProviderModule,
      redisProviderModule: config.redisProviderModule,
      redisUrl: config.redisUrl,
    };
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError('INVALID_CONFIGURATION');
  }
}

async function importProviderModule(
  moduleSpec: string,
  options: ProviderLoaderOptions,
  failureCode: 'CREDENTIAL_MODULE_LOAD_FAILED' | 'REDIS_MODULE_LOAD_FAILED',
): Promise<Record<string, unknown>> {
  let resolved: string;
  try {
    resolved = resolveProviderModuleSpecifier(moduleSpec, options.cwd ?? process.cwd());
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError('INVALID_MODULE_SPECIFIER');
  }

  try {
    const imported = await (options.importer ?? defaultImporter)(resolved);
    if (!isRecord(imported))
      throw providerError(
        failureCode === 'CREDENTIAL_MODULE_LOAD_FAILED'
          ? 'CREDENTIAL_MODULE_EXPORT_INVALID'
          : 'REDIS_MODULE_EXPORT_INVALID',
      );
    return imported;
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError(failureCode);
  }
}

function credentialMethods(value: unknown): CredentialMethods | undefined {
  const getCurrentKey = boundMethod(value, 'getCurrentKey');
  const getKey = boundMethod(value, 'getKey');
  const checkReady = boundMethod(value, 'checkReady');
  const close = boundMethod(value, 'close');
  if (!getCurrentKey || !getKey || !checkReady || !close) return undefined;
  return { getCurrentKey, getKey, checkReady, close };
}

function redisMethods(value: unknown): RedisMethods | undefined {
  const createRateLimiter = boundMethod(value, 'createRateLimiter');
  const checkReady = boundMethod(value, 'checkReady');
  const close = boundMethod(value, 'close');
  if (!createRateLimiter || !checkReady || !close) return undefined;
  return { createRateLimiter, checkReady, close };
}

async function credentialReadinessProbe(provider: CredentialKeyProvider): Promise<void> {
  let plaintext: string | undefined = `model-router-provider-readiness:${randomUUID()}`;
  let context: UserCredentialContext | undefined = {
    userId: `provider-readiness-${randomUUID()}`,
    provider: PLATFORM_TOTP_PURPOSE,
    credentialId: `provider-readiness-${randomUUID()}`,
  };
  let envelope: CredentialEnvelope | undefined;
  let decrypted: string | undefined;

  try {
    if (plaintext === undefined || context === undefined) throw new Error('probe state unavailable');
    envelope = await encryptCredential(plaintext, context, provider);
    decrypted = await decryptCredential(envelope, context, provider);
    if (decrypted !== plaintext) throw new Error('probe equality failed');
  } catch {
    throw providerError('CREDENTIAL_PROBE_FAILED');
  } finally {
    // The crypto helpers zero their temporary plaintext and key Buffers. Drop
    // every loader-owned reference as soon as the ephemeral probe completes.
    plaintext = undefined;
    context = undefined;
    envelope = undefined;
    decrypted = undefined;
  }
}

function credentialProviderView(methods: CredentialMethods, close: () => Promise<void>): LoadedCredentialKeyProvider {
  return {
    getCurrentKey: () => methods.getCurrentKey() as ProviderAwaitable<CredentialKeyMaterial>,
    getKey: (keyId: string) =>
      methods.getKey(keyId) as ProviderAwaitable<Uint8Array | CredentialKeyMaterial | undefined>,
    checkReady: async () => {
      await methods.checkReady();
    },
    close,
  };
}

/** Load and readiness-check the named KMS provider for trusted CLI and server callers. */
export async function loadCredentialKeyProvider(
  configOrModule: Pick<ManagedSaasDeploymentConfig, 'credentialProviderModule'> | string,
  optionsOrEnvironment?: ProviderLoaderOptions | ProviderEnvironment | ProviderModuleImporter,
  positionalImporter?: ProviderModuleImporter,
): Promise<LoadedCredentialKeyProvider> {
  const options = normalizeLoaderOptions(optionsOrEnvironment, positionalImporter);
  const moduleSpec = credentialModuleSpec(configOrModule);
  const module = await importProviderModule(moduleSpec, options, 'CREDENTIAL_MODULE_LOAD_FAILED');
  const factory = boundMethod(module, 'createCredentialKeyProvider');
  if (!factory) throw providerError('CREDENTIAL_MODULE_EXPORT_INVALID');

  let rawProvider: unknown;
  try {
    const env = Object.freeze({ ...(options.env ?? process.env) }) as ProviderEnvironment;
    rawProvider = await factory({ env, purpose: PLATFORM_TOTP_PURPOSE });
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError('CREDENTIAL_FACTORY_FAILED');
  }

  const methods = credentialMethods(rawProvider);
  const rawClose = boundMethod(rawProvider, 'close');
  const cleanup = rawClose === undefined ? undefined : closeOnce(rawClose);
  if (methods === undefined || cleanup === undefined) {
    await closeQuietly(cleanup);
    throw providerError('CREDENTIAL_PROVIDER_INVALID');
  }

  try {
    await methods.checkReady();
  } catch {
    await closeQuietly(cleanup);
    throw providerError('CREDENTIAL_READINESS_FAILED');
  }

  const provider = credentialProviderView(methods, cleanup);
  try {
    await credentialReadinessProbe(provider);
  } catch (error) {
    await closeQuietly(cleanup);
    if (isProviderLoaderError(error)) throw error;
    throw providerError('CREDENTIAL_PROBE_FAILED');
  }

  return provider;
}

interface LoadedRedisProvider {
  readonly createRateLimiter: (options: RedisRateLimiterOptions) => Promise<ManagedRateLimiter>;
  readonly close: () => Promise<void>;
}

async function loadRedisProvider(
  moduleSpec: string,
  redisUrl: string,
  options: ProviderLoaderOptions,
): Promise<LoadedRedisProvider> {
  const module = await importProviderModule(moduleSpec, options, 'REDIS_MODULE_LOAD_FAILED');
  const factory = boundMethod(module, 'createRedisProvider');
  if (!factory) throw providerError('REDIS_MODULE_EXPORT_INVALID');

  let rawProvider: unknown;
  try {
    rawProvider = await factory({ url: redisUrl, keyPrefix: MANAGED_SAAS_REDIS_KEY_PREFIX });
  } catch (error) {
    if (isProviderLoaderError(error)) throw error;
    throw providerError('REDIS_FACTORY_FAILED');
  }

  const methods = redisMethods(rawProvider);
  const rawClose = boundMethod(rawProvider, 'close');
  const cleanup = rawClose === undefined ? undefined : closeOnce(rawClose);
  if (methods === undefined || cleanup === undefined) {
    await closeQuietly(cleanup);
    throw providerError('REDIS_PROVIDER_INVALID');
  }

  try {
    await methods.checkReady();
  } catch {
    await closeQuietly(cleanup);
    throw providerError('REDIS_READINESS_FAILED');
  }

  return {
    close: cleanup,
    createRateLimiter: async (limiterOptions) => {
      let limiter: unknown;
      try {
        limiter = await methods.createRateLimiter(limiterOptions);
      } catch (error) {
        if (isProviderLoaderError(error)) throw error;
        throw providerError('REDIS_RATE_LIMITER_FACTORY_FAILED');
      }
      if (!boundMethod(limiter, 'take')) throw providerError('REDIS_RATE_LIMITER_INVALID');
      return limiter as ManagedRateLimiter;
    },
  };
}

/** Load the KMS and Redis contracts needed by managed SaaS authentication. */
export async function loadManagedSaasProviders(
  config: ManagedSaasDeploymentConfig,
  optionsOrEnvironment?: ProviderLoaderOptions | ProviderEnvironment | ProviderModuleImporter,
  positionalImporter?: ProviderModuleImporter,
): Promise<ManagedSaasProviders> {
  const options = normalizeLoaderOptions(optionsOrEnvironment, positionalImporter);
  const values = managedConfigValues(config);
  let credentialKeyProvider: LoadedCredentialKeyProvider | undefined;
  let redisProvider: LoadedRedisProvider | undefined;
  let providerCredentialSealingKms: LoadedProviderCredentialSealingKms | undefined;
  let providerCredentialRewrappingKms: LoadedProviderCredentialRewrappingKms | undefined;

  try {
    credentialKeyProvider = await loadCredentialKeyProvider(
      { credentialProviderModule: values.credentialProviderModule },
      options,
    );
    redisProvider = await loadRedisProvider(values.redisProviderModule, values.redisUrl, options);

    const platformAuthRateLimiter = await redisProvider.createRateLimiter({
      namespace: PLATFORM_AUTH_NAMESPACE,
      limit: PLATFORM_AUTH_RATE_LIMIT,
      windowMs: PLATFORM_AUTH_RATE_WINDOW_MS,
    });
    const customerAuthRateLimiter = await redisProvider.createRateLimiter({
      namespace: CUSTOMER_AUTH_NAMESPACE,
      limit: CUSTOMER_AUTH_RATE_LIMIT,
      windowMs: CUSTOMER_AUTH_RATE_WINDOW_MS,
    });
    providerCredentialSealingKms = await loadProviderCredentialSealingKms(options);
    if (config.providerCredentialRewrappingKmsModule !== undefined) {
      const configuredModule =
        options.env?.[SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE] ??
        process.env[SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE];
      const configuredDestinationKmsKeyId =
        options.env?.[MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID] ??
        process.env[MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID];
      if (
        configuredModule !== config.providerCredentialRewrappingKmsModule ||
        typeof config.providerCredentialKmsKeyId !== 'string' ||
        configuredDestinationKmsKeyId !== config.providerCredentialKmsKeyId
      ) {
        throw providerError('INVALID_CONFIGURATION');
      }
      providerCredentialRewrappingKms = await loadProviderCredentialRewrappingKms({
        ...options,
        destinationKmsKeyId: config.providerCredentialKmsKeyId,
      });
      if (providerCredentialRewrappingKms === undefined) throw providerError('INVALID_CONFIGURATION');
    }

    if (credentialKeyProvider === undefined || redisProvider === undefined) {
      throw providerError('INVALID_CONFIGURATION');
    }
    const loadedCredentialKeyProvider = credentialKeyProvider;
    const loadedRedisProvider = redisProvider;
    const loadedProviderCredentialSealingKms = providerCredentialSealingKms;
    const loadedProviderCredentialRewrappingKms = providerCredentialRewrappingKms;
    const close = closeOnce(async () => {
      await closeAll([
        loadedRedisProvider.close,
        loadedCredentialKeyProvider.close,
        ...(loadedProviderCredentialSealingKms === undefined ? [] : [loadedProviderCredentialSealingKms.close]),
        ...(loadedProviderCredentialRewrappingKms === undefined ? [] : [loadedProviderCredentialRewrappingKms.close]),
      ]);
    });

    return {
      credentialKeyProvider: loadedCredentialKeyProvider,
      ...(loadedProviderCredentialSealingKms === undefined
        ? {}
        : { providerCredentialSealingKms: loadedProviderCredentialSealingKms }),
      ...(loadedProviderCredentialRewrappingKms === undefined
        ? {}
        : { providerCredentialRewrappingKms: loadedProviderCredentialRewrappingKms }),
      platformAuthRateLimiter,
      customerAuthRateLimiter,
      close,
    };
  } catch (error) {
    await Promise.all([
      closeQuietly(redisProvider?.close),
      closeQuietly(credentialKeyProvider?.close),
      closeQuietly(providerCredentialSealingKms?.close),
      closeQuietly(providerCredentialRewrappingKms?.close),
    ]);
    if (isProviderLoaderError(error)) throw error;
    throw providerError('INVALID_CONFIGURATION');
  }
}
