import { performance } from 'node:perf_hooks';
import type { ProviderCredentialValidationJobRecord } from './types.js';

export const PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS = 5_000;
export const PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES = 4_096;

export type ProviderCredentialValidationErrorCode =
  | 'adapter_unsupported'
  | 'credential_format_invalid'
  | 'credential_unavailable'
  | 'credential_rejected'
  | 'provider_endpoint_unsupported'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected';

export interface ProviderCredentialValidationSuccess {
  readonly state: 'verified';
  readonly adapterId: string;
  readonly httpStatus: number;
  readonly durationMs: number;
}

export interface ProviderCredentialValidationFailure {
  readonly state: 'failed';
  readonly errorCode: ProviderCredentialValidationErrorCode;
  readonly retryable: boolean;
  readonly adapterId: string | null;
  readonly httpStatus: number | null;
  readonly durationMs: number;
}

export type ProviderCredentialValidationResult =
  | ProviderCredentialValidationSuccess
  | ProviderCredentialValidationFailure;

export type ProviderCredentialValidationFetch = (url: URL, init: RequestInit) => Promise<Response>;

interface FixedProviderValidationAdapter {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly capabilityEndpoint: string;
  readonly capabilityProtocol: string;
  readonly adapterId: string;
  readonly url: string;
}

/*
 * These are the only currently verified product bindings in this worker. The
 * protocol profiles in src/providers/profiles.ts are examples for inference;
 * they do not authorize arbitrary validation targets. Products absent here,
 * including Kimi Code, DeepSeek Anthropic, and all custom products, fail closed.
 */
const FIXED_ADAPTERS: readonly FixedProviderValidationAdapter[] = Object.freeze([
  Object.freeze({
    providerId: 'kimi',
    productId: 'kimi-platform',
    credentialType: 'api-key',
    capabilityEndpoint: 'chat-completions',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'kimi-platform-models-v1',
    url: 'https://api.moonshot.cn/v1/models',
  }),
  Object.freeze({
    providerId: 'kimi',
    productId: 'kimi-platform-global',
    credentialType: 'api-key',
    capabilityEndpoint: 'chat-completions',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'kimi-platform-global-models-v1',
    url: 'https://api.moonshot.ai/v1/models',
  }),
  Object.freeze({
    providerId: 'deepseek',
    productId: 'deepseek-chat',
    credentialType: 'api-key',
    capabilityEndpoint: 'chat-completions',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'deepseek-chat-models-v1',
    url: 'https://api.deepseek.com/models',
  }),
]);

function failed(
  errorCode: ProviderCredentialValidationErrorCode,
  retryable: boolean,
  adapterId: string | null,
  httpStatus: number | null,
  durationMs: number,
): ProviderCredentialValidationFailure {
  return { state: 'failed', errorCode, retryable, adapterId, httpStatus, durationMs };
}

function canonicalAdapterUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.href !== value
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function resolveAdapter(job: ProviderCredentialValidationJobRecord): FixedProviderValidationAdapter | null {
  if (
    !job.allowedModels.includes(job.target.model) ||
    job.target.endpoint !== 'chat-completions' ||
    job.target.version < 1
  ) {
    return null;
  }
  return (
    FIXED_ADAPTERS.find(
      (candidate) =>
        candidate.providerId === job.providerId &&
        candidate.productId === job.productId &&
        candidate.credentialType === job.credentialType &&
        candidate.capabilityEndpoint === job.target.endpoint,
    ) ?? null
  );
}

function asciiCredential(secret: Buffer): string | null {
  if (secret.length < 1 || secret.length > 4_096) return null;
  for (const byte of secret) {
    if (byte < 0x21 || byte > 0x7e) return null;
  }
  return secret.toString('ascii');
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Body content is neither consumed nor surfaced.
  }
}

type BoundedBodyResult = 'ok' | 'too_large' | 'read_error';

async function discardResponseBody(response: Response): Promise<BoundedBodyResult> {
  if (!response.body) return 'ok';
  const reader = response.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return 'ok';
      if (value.byteLength > PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES - bytesRead) {
        void reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      bytesRead += value.byteLength;
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return 'read_error';
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its reader.
    }
  }
}

export async function validateProviderCredential(
  job: ProviderCredentialValidationJobRecord,
  secret: Buffer,
  fetcher: ProviderCredentialValidationFetch = (url, init) => fetch(url, init),
): Promise<ProviderCredentialValidationResult> {
  const startedAt = performance.now();
  const adapter = resolveAdapter(job);
  if (!adapter) return failed('adapter_unsupported', false, null, null, 0);

  const url = canonicalAdapterUrl(adapter.url);
  if (!url) return failed('adapter_unsupported', false, adapter.adapterId, null, 0);
  const token = asciiCredential(secret);
  if (token === null) return failed('credential_format_invalid', false, adapter.adapterId, null, 0);

  let response: Response | undefined;
  const timeoutSignal = AbortSignal.timeout(PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS);
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal: timeoutSignal,
    });
  } catch (error) {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const isTimeout = timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    return failed(isTimeout ? 'provider_timeout' : 'provider_network_error', true, adapter.adapterId, null, durationMs);
  }

  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return failed('provider_response_too_large', false, adapter.adapterId, response.status, durationMs);
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return failed('provider_redirect_rejected', false, adapter.adapterId, response.status, durationMs);
  }
  const bodyResult = await discardResponseBody(response);
  if (bodyResult === 'too_large') {
    return failed('provider_response_too_large', false, adapter.adapterId, response.status, durationMs);
  }
  if (bodyResult === 'read_error') {
    const isTimeout = timeoutSignal.aborted;
    return failed(
      isTimeout ? 'provider_timeout' : 'provider_network_error',
      true,
      adapter.adapterId,
      response.status,
      durationMs,
    );
  }
  if (response.status >= 200 && response.status < 300) {
    return { state: 'verified', adapterId: adapter.adapterId, httpStatus: response.status, durationMs };
  }

  if (response.status === 401 || response.status === 403) {
    return failed('credential_rejected', false, adapter.adapterId, response.status, durationMs);
  }
  if (response.status === 404 || response.status === 405) {
    return failed('provider_endpoint_unsupported', false, adapter.adapterId, response.status, durationMs);
  }
  if (response.status === 429) {
    return failed('provider_rate_limited', true, adapter.adapterId, response.status, durationMs);
  }
  if (response.status >= 500) {
    return failed('provider_unavailable', true, adapter.adapterId, response.status, durationMs);
  }
  return failed('provider_endpoint_unsupported', false, adapter.adapterId, response.status, durationMs);
}

export function isSupportedCredentialValidationTarget(job: ProviderCredentialValidationJobRecord): boolean {
  return resolveAdapter(job) !== null;
}

export function credentialValidationCapabilityProtocol(job: ProviderCredentialValidationJobRecord): string | null {
  return resolveAdapter(job)?.capabilityProtocol ?? null;
}
