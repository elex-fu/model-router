import { performance } from 'node:perf_hooks';
import type { ProviderCredentialValidationJobRecord } from './types.js';
import { isCustomCredentialValidationModel } from './credential-validation-targets.js';

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
  | 'provider_address_rejected'
  | 'provider_response_invalid'
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

/** Structural subset shared by the fixed fetch seam and the pinned Undici transport. */
export interface ProviderCredentialValidationResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface CredentialValidationProbe {
  readonly adapterId: string;
  readonly kind: 'models' | 'messages' | 'chat';
  readonly model: string;
  readonly custom: boolean;
}

export interface CredentialValidationProbeRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: 'manual';
}

interface FixedProviderValidationAdapter {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly capabilityEndpoint: string;
  readonly capabilityProtocol: string;
  readonly adapterId: string;
  readonly url: string;
  readonly probe: 'models' | 'messages';
}

/*
 * These are the only currently verified product bindings in this worker. The
 * protocol profiles in src/providers/profiles.ts are examples for inference;
 * they do not authorize arbitrary validation targets. Products absent here,
 * including all custom products, fail closed. Credential health does not grant
 * catalog capabilities or commercial rights. Messages bindings follow:
 * https://www.kimi.com/code/docs/en/ (CN/global /coding/v1/messages)
 * https://api-docs.deepseek.com/guides/anthropic_api/ (/anthropic/v1/messages)
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
    probe: 'models',
  }),
  Object.freeze({
    providerId: 'kimi',
    productId: 'kimi-platform-global',
    credentialType: 'api-key',
    capabilityEndpoint: 'chat-completions',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'kimi-platform-global-models-v1',
    url: 'https://api.moonshot.ai/v1/models',
    probe: 'models',
  }),
  Object.freeze({
    providerId: 'deepseek',
    productId: 'deepseek-chat',
    credentialType: 'api-key',
    capabilityEndpoint: 'chat-completions',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'deepseek-chat-models-v1',
    url: 'https://api.deepseek.com/models',
    probe: 'models',
  }),
  Object.freeze({
    providerId: 'kimi',
    productId: 'kimi-code',
    credentialType: 'api-key',
    capabilityEndpoint: 'messages',
    capabilityProtocol: 'anthropic-compatible',
    adapterId: 'kimi-code-messages-v1',
    url: 'https://api.kimi.com/coding/v1/messages',
    probe: 'messages',
  }),
  Object.freeze({
    providerId: 'kimi',
    productId: 'kimi-code-global',
    credentialType: 'api-key',
    capabilityEndpoint: 'messages',
    capabilityProtocol: 'anthropic-compatible',
    adapterId: 'kimi-code-global-messages-v1',
    url: 'https://api.kimi.ai/coding/v1/messages',
    probe: 'messages',
  }),
  Object.freeze({
    providerId: 'deepseek',
    productId: 'deepseek-anthropic',
    credentialType: 'api-key',
    capabilityEndpoint: 'messages',
    capabilityProtocol: 'anthropic-compatible',
    adapterId: 'deepseek-anthropic-messages-v1',
    url: 'https://api.deepseek.com/anthropic/v1/messages',
    probe: 'messages',
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
    !job.target || !modelIdentifier(job.target.model) ||
    Object.keys(job.target).some((key) => !['model', 'endpoint', 'version'].includes(key)) ||
    !Array.isArray(job.allowedModels) ||
    !job.allowedModels.includes(job.target.model) ||
    !Number.isSafeInteger(job.target.version) || job.target.version < 1
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

function modelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function asciiCredential(secret: Buffer): string | null {
  if (secret.length < 1 || secret.length > 4_096) return null;
  for (const byte of secret) {
    if (byte < 0x21 || byte > 0x7e) return null;
  }
  return secret.toString('ascii');
}

function cancelResponseBody(response: ProviderCredentialValidationResponse): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Body content is neither consumed nor surfaced.
  }
}

type BoundedBodyResult =
  | { readonly state: 'ok'; readonly bytes: Uint8Array | null }
  | { readonly state: 'too_large' }
  | { readonly state: 'read_error' }
  | { readonly state: 'timeout' };

async function boundedResponseBody(response: ProviderCredentialValidationResponse, signal: AbortSignal, capture: boolean): Promise<BoundedBodyResult> {
  if (signal.aborted) { cancelResponseBody(response); return { state: 'timeout' }; }
  if (!response.body) return { state: 'ok', bytes: capture ? new Uint8Array() : null };
  const reader = response.body.getReader();
  const buffer = capture ? new Uint8Array(PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES) : null;
  let bytesRead = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { state: 'timeout' };
      if (done) return { state: 'ok', bytes: buffer?.subarray(0, bytesRead) ?? null };
      if (!(value instanceof Uint8Array)) { cancel(); return { state: 'read_error' }; }
      if (value.byteLength > PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES - bytesRead) {
        cancel();
        return { state: 'too_large' };
      }
      buffer?.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    cancel();
    return { state: signal.aborted ? 'timeout' : 'read_error' };
  } finally {
    signal.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its reader.
    }
  }
}

type Fields = Record<string, unknown>;
function record(value: unknown): Fields | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// This validates only the bounded probe's Messages envelope, not model
// capabilities or financial usage. Providers may return a canonical model ID
// for an alias; the requested model still comes solely from the allowed job.
function validMessageResponse(response: ProviderCredentialValidationResponse, bytes: Uint8Array, custom: boolean): boolean {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return false;
  try {
    const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!body || body.type !== 'message' || body.role !== 'assistant' ||
      !modelIdentifier(body.id) || !(custom ? isCustomCredentialValidationModel(body.model) : modelIdentifier(body.model)) ||
      (body.error !== undefined && body.error !== null) ||
      typeof body.stop_reason !== 'string' || !['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(body.stop_reason) ||
      (body.stop_sequence !== undefined && body.stop_sequence !== null && typeof body.stop_sequence !== 'string') ||
      !Array.isArray(body.content) || body.content.length < 1) return false;
    if (!body.content.every((value: unknown) => {
      const block = record(value);
      if (!block) return false;
      if (block.type === 'text') return typeof block.text === 'string';
      if (block.type === 'thinking') return typeof block.thinking === 'string' &&
        (block.signature === undefined || typeof block.signature === 'string');
      return block.type === 'redacted_thinking' && typeof block.data === 'string';
    })) return false;
    const usage = record(body.usage);
    if (!usage || !counter(usage.input_tokens) || !counter(usage.output_tokens)) return false;
    let total = usage.input_tokens + usage.output_tokens;
    for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (Object.hasOwn(usage, key)) {
        const value = usage[key];
        if (!counter(value)) return false;
        total += value;
      }
    }
    return Number.isSafeInteger(total);
  } catch {
    // Neither parser failures nor provider bodies may escape as diagnostics.
    return false;
  }
}

function validChatResponse(response: ProviderCredentialValidationResponse, bytes: Uint8Array): boolean {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return false;
  try {
    const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!body || !modelIdentifier(body.id) || body.object !== 'chat.completion' || !counter(body.created) ||
      !isCustomCredentialValidationModel(body.model) || (body.error !== undefined && body.error !== null) ||
      !Array.isArray(body.choices) || body.choices.length !== 1) return false;
    const choice = record(body.choices[0]);
    const message = record(choice?.message);
    if (!choice || choice.index !== 0 || !message || message.role !== 'assistant' ||
      typeof message.content !== 'string' || (message.tool_calls !== undefined && message.tool_calls !== null) ||
      typeof choice.finish_reason !== 'string' || !['stop', 'length', 'content_filter'].includes(choice.finish_reason)) return false;
    const usage = record(body.usage);
    return !!usage && counter(usage.prompt_tokens) && counter(usage.completion_tokens) && counter(usage.total_tokens) &&
      Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens) &&
      usage.total_tokens === usage.prompt_tokens + usage.completion_tokens;
  } catch { return false; }
}

/** Protocol-owned allowlist; never merges job/operator/client supplied headers. */
export function createCredentialValidationProbeRequest(probe: CredentialValidationProbe, secret: Buffer): CredentialValidationProbeRequest | null {
  const token = asciiCredential(secret);
  if (token === null) return null;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'model-router' };
  if (probe.kind === 'messages') {
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${token}`;
  }
  if (probe.kind !== 'models') headers['content-type'] = 'application/json';
  return {
    method: probe.kind === 'models' ? 'GET' : 'POST', headers,
    ...(probe.kind === 'models' ? {} : { body: JSON.stringify({
      model: probe.model, max_tokens: 8, stream: false,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    }) }),
    redirect: 'manual',
  };
}

/** Complete bounded EOF is required; no payload or parser exception leaves this function. */
export async function readCredentialValidationProbeResponse(
  probe: CredentialValidationProbe,
  response: ProviderCredentialValidationResponse,
  signal: AbortSignal,
  startedAt: number,
): Promise<ProviderCredentialValidationResult> {
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (signal.aborted) {
    cancelResponseBody(response);
    return failed('provider_timeout', true, probe.adapterId, response.status, durationMs);
  }
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return failed('provider_response_too_large', false, probe.adapterId, response.status, durationMs);
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return failed('provider_redirect_rejected', false, probe.adapterId, response.status, durationMs);
  }
  const success = response.status >= 200 && response.status < 300;
  const bodyResult = await boundedResponseBody(response, signal, probe.kind !== 'models' && success);
  const completedDurationMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (bodyResult.state === 'too_large') {
    return failed('provider_response_too_large', false, probe.adapterId, response.status, completedDurationMs);
  }
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    return failed(bodyResult.state === 'timeout' ? 'provider_timeout' : 'provider_network_error', true,
      probe.adapterId, response.status, completedDurationMs);
  }
  if (success) {
    if (probe.kind !== 'models' && (!bodyResult.bytes || !(probe.kind === 'messages'
      ? validMessageResponse(response, bodyResult.bytes, probe.custom) : validChatResponse(response, bodyResult.bytes)))) {
      return failed('provider_response_invalid', false, probe.adapterId, response.status, completedDurationMs);
    }
    return { state: 'verified', adapterId: probe.adapterId, httpStatus: response.status, durationMs: completedDurationMs };
  }
  if (response.status === 401 || response.status === 403) return failed('credential_rejected', false, probe.adapterId, response.status, completedDurationMs);
  if (response.status === 404 || response.status === 405) return failed('provider_endpoint_unsupported', false, probe.adapterId, response.status, completedDurationMs);
  if (response.status === 429) return failed('provider_rate_limited', true, probe.adapterId, response.status, completedDurationMs);
  if (response.status >= 500) return failed('provider_unavailable', true, probe.adapterId, response.status, completedDurationMs);
  return failed('provider_endpoint_unsupported', false, probe.adapterId, response.status, completedDurationMs);
}

export async function validateProviderCredential(
  job: ProviderCredentialValidationJobRecord,
  secret: Buffer,
  fetcher: ProviderCredentialValidationFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
): Promise<ProviderCredentialValidationResult> {
  const startedAt = performance.now();
  const adapter = resolveAdapter(job);
  if (!adapter) return failed('adapter_unsupported', false, null, null, 0);

  const url = canonicalAdapterUrl(adapter.url);
  if (!url) return failed('adapter_unsupported', false, adapter.adapterId, null, 0);
  const probe: CredentialValidationProbe = { adapterId: adapter.adapterId, kind: adapter.probe, model: job.target.model, custom: false };
  const init = createCredentialValidationProbeRequest(probe, secret);
  if (!init) return failed('credential_format_invalid', false, adapter.adapterId, null, 0);

  let response: Response | undefined;
  const deadline = AbortSignal.timeout(PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(url, { ...init, signal: timeoutSignal });
  } catch (error) {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const isTimeout = timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    return failed(isTimeout ? 'provider_timeout' : 'provider_network_error', true, adapter.adapterId, null, durationMs);
  }

  return readCredentialValidationProbeResponse(probe, response, timeoutSignal, startedAt);
}

export function isSupportedCredentialValidationTarget(job: ProviderCredentialValidationJobRecord): boolean {
  return resolveAdapter(job) !== null;
}

export function credentialValidationCapabilityProtocol(job: ProviderCredentialValidationJobRecord): string | null {
  return resolveAdapter(job)?.capabilityProtocol ?? null;
}
