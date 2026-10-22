import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  MINIMAX_MODELS_URL,
  ZHIPU_CODING_MODELS_URL,
  ZHIPU_PAYG_MODELS_URL,
} from '../gateway/cn-providers/constants.js';
import {
  CODEX_CREDENTIAL_TYPE,
  CODEX_ENDPOINT,
  CODEX_PRODUCT_ID,
  CODEX_PROTOCOL,
  CODEX_PROVIDER_ID,
} from '../gateway/codex/catalog-identity.js';
import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import {
  GROK_CREDENTIAL_TYPE_OAUTH,
  GROK_ENDPOINT,
  GROK_OAUTH_PRODUCT_ID,
  GROK_PROTOCOL,
  GROK_PROVIDER_ID,
} from '../gateway/grok/catalog-identity.js';
import { GROK_OAUTH_DEFAULT_BASE_URL } from '../gateway/grok/constants.js';
import { OPENCODE_GO_CHAT_COMPLETIONS_URL } from '../gateway/opencode-go/catalog-identity.js';
import {
  OPENROUTER_CAPABILITY_PROTOCOL,
  OPENROUTER_CREDENTIAL_TYPE,
  OPENROUTER_ENDPOINT,
  OPENROUTER_KEY_URL,
  OPENROUTER_PRODUCT_ID,
  OPENROUTER_PROVIDER_ID,
} from '../gateway/openrouter/catalog-identity.js';
import { isCustomCredentialValidationModel } from './credential-validation-targets.js';
import {
  buildCodexOAuthProbeRequest,
  buildGrokOAuthProbeRequest,
  challengeMatches,
  firstResponsesText,
  oauthValidationChallengePrompt,
} from './oauth-probe-builders.js';
import type { ProviderCredentialValidationJobRecord } from './types.js';

export const PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS = 5_000;
export const PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES = 4_096;
/** Fixed model dispatches need room for their JSON envelope as well as output tokens. */
export const PROVIDER_INFERENCE_VALIDATION_TIMEOUT_MS = 15_000;
export const PROVIDER_INFERENCE_VALIDATION_MAX_RESPONSE_BYTES = 16_384;
/**
 * Kimi Code attaches a thinking signature even to an eight-token response.
 * A real valid probe carried 13,385 decoded bytes, including a 12,946-character
 * signature. Keep a finite envelope allowance independent of max_tokens.
 * The 20s deadline leaves completion-write time inside the default 30s lease.
 */
export const KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS = 20_000;
export const KIMI_CODE_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES = 65_536;
/**
 * OAuth onboarding probes are real model dispatches, not metadata reads.
 * They keep the same bounded posture but need a longer deadline and a larger
 * envelope budget than metadata probes; the challenge must survive a
 * normal Responses envelope with usage accounting.
 *
 * Keep this below the worker's 30s default lease TTL: the completion write
 * still has to land before another worker may reclaim an expired lease.
 */
export const PROVIDER_OAUTH_VALIDATION_TIMEOUT_MS = 20_000;
export const PROVIDER_OAUTH_VALIDATION_MAX_RESPONSE_BYTES = 65_536;

export type CredentialValidationProbeKind = 'models' | 'key' | 'messages' | 'chat' | 'oauth-responses';

export type OAuthValidationProvider = 'codex' | 'grok';

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
  // Fetch globals use the DOM stream when DOM is loaded; pinned Undici uses
  // node:stream/web. Keep both concrete byte-stream types, not a cast or shim.
  readonly body: ReadableStream<Uint8Array> | NodeReadableStream<Uint8Array> | null;
}

export interface CredentialValidationProbe {
  readonly adapterId: string;
  /** `key` is an authenticated metadata GET (OpenRouter `GET /key`). */
  readonly kind: CredentialValidationProbeKind;
  readonly model: string;
  readonly custom: boolean;
  /** OAuth categories select the shared request builder and response parser. */
  readonly oauthProvider?: OAuthValidationProvider;
  /** One-shot numeric challenge for the OAuth onboarding probe. */
  readonly challenge?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
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
  readonly probe: CredentialValidationProbeKind;
  readonly oauthProvider?: OAuthValidationProvider;
  readonly limits?: {
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
  };
}

/*
 * These are the only currently verified product bindings in this worker. The
 * protocol profiles in src/providers/profiles.ts are examples for inference;
 * they do not authorize arbitrary validation targets. Products absent here,
 * including all custom products, fail closed. Credential health does not grant
 * catalog capabilities or commercial rights. Messages bindings follow:
 * https://www.kimi.com/code/docs/en/ (CN/global /coding/v1/messages)
 * https://api-docs.deepseek.com/guides/anthropic_api/ (/anthropic/v1/messages)
 *
 * R5b-4 (plan §R5b task #24, "R6 未动工前先在注册表占位"): the OpenCode Go
 * subscription pool registers its Chat Completions probe here — the R6 probe
 * framework's opencode-go category placeholder. The capability endpoint is
 * the opencode-go catalog endpoint scope (`opencode-go-zen`, the binding
 * account capability rows carry), the wire probe is the pinned Chat
 * Completions endpoint with the default test model supplied by the job
 * (sub2api `DefaultOpenCodeGoTestModel` glm-5.3), and the auth profile is
 * openai-bearer-v1 like the kimi/deepseek API-key precedents.
 */
const FIXED_ADAPTERS: readonly FixedProviderValidationAdapter[] = Object.freeze([
  Object.freeze({
    // Batch-3 CN providers (src/saas/gateway/cn-providers/): the OpenAI-format
    // models endpoint on each product's Chat Completions base (sub2api
    // buildUpstreamModelsRequest matrix — zhipu payg / zhipu coding / minimax
    // share the api.minimaxi.com inference domain). Bearer api-key auth, the
    // kimi/deepseek API-key precedent.
    providerId: 'zhipu',
    productId: 'zhipu-glm',
    credentialType: 'api-key',
    capabilityEndpoint: 'zhipu-glm',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'zhipu-glm-models-v1',
    url: ZHIPU_PAYG_MODELS_URL,
    probe: 'models',
  }),
  Object.freeze({
    providerId: 'zhipu',
    productId: 'zhipu-glm-coding',
    credentialType: 'api-key',
    capabilityEndpoint: 'zhipu-glm-coding',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'zhipu-glm-coding-models-v1',
    url: ZHIPU_CODING_MODELS_URL,
    probe: 'models',
  }),
  Object.freeze({
    providerId: 'minimax',
    productId: 'minimax-m',
    credentialType: 'api-key',
    capabilityEndpoint: 'minimax-m',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'minimax-m-models-v1',
    url: MINIMAX_MODELS_URL,
    probe: 'models',
  }),
  Object.freeze({
    // Batch-3 grok API-key binding (src/saas/gateway/grok/catalog-identity.ts
    // grok-api product): the official api.x.ai models list. The OAuth
    // subscription category has its own pinned CLI-proxy onboarding probe at
    // the end of this table; it is never validated through this generic
    // api-key surface.
    providerId: 'xai-grok',
    productId: 'grok-api',
    credentialType: 'api-key',
    capabilityEndpoint: 'grok-responses',
    capabilityProtocol: 'responses',
    adapterId: 'xai-grok-api-models-v1',
    url: 'https://api.x.ai/v1/models',
    probe: 'models',
  }),
  Object.freeze({
    providerId: 'opencode-go',
    productId: 'opencode-go-zen',
    credentialType: 'api-key',
    capabilityEndpoint: 'opencode-go-zen',
    capabilityProtocol: 'openai-compatible',
    adapterId: 'opencode-go-zen-chat-v1',
    url: OPENCODE_GO_CHAT_COMPLETIONS_URL,
    probe: 'chat',
  }),
  Object.freeze({
    // F6 OpenRouter metered aggregation. `/models` is public, so the truthful
    // proof-of-life is the bearer-authenticated `GET /key` key-info read; the
    // same fixed endpoint backs the api-key account probe. The catalog scope
    // and capability protocol come from the shared identity constants so the
    // validation target cannot drift from the registered `openai` rows.
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    credentialType: OPENROUTER_CREDENTIAL_TYPE,
    capabilityEndpoint: OPENROUTER_ENDPOINT,
    capabilityProtocol: OPENROUTER_CAPABILITY_PROTOCOL,
    adapterId: 'openrouter-api-key-v1',
    url: OPENROUTER_KEY_URL,
    probe: 'key',
  }),
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
    limits: Object.freeze({
      timeoutMs: KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS,
      maxResponseBytes: KIMI_CODE_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
    }),
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
    limits: Object.freeze({
      timeoutMs: KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS,
      maxResponseBytes: KIMI_CODE_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
    }),
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
  Object.freeze({
    // T02 OAuth onboarding. The Codex sink seals the OAuth grant, then the
    // normal platform validation job must prove the credential before the
    // account can become schedulable. This is the same canonical CLI
    // `/responses` request the R6a account probe sends; the response must
    // answer the one-shot numeric challenge.
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    credentialType: CODEX_CREDENTIAL_TYPE,
    capabilityEndpoint: CODEX_ENDPOINT,
    capabilityProtocol: CODEX_PROTOCOL,
    adapterId: 'openai-codex-oauth-probe-v1',
    url: CODEX_RESPONSES_ENDPOINT,
    probe: 'oauth-responses',
    oauthProvider: 'codex',
  }),
  Object.freeze({
    // T02 OAuth onboarding for the Grok CLI subscription. The CLI proxy
    // rejects non-CLI fingerprints, so the shared builder stamps the exact
    // pinned Grok CLI identity headers. A plain bearer probe would not prove
    // the real dispatch path.
    providerId: GROK_PROVIDER_ID,
    productId: GROK_OAUTH_PRODUCT_ID,
    credentialType: GROK_CREDENTIAL_TYPE_OAUTH,
    capabilityEndpoint: GROK_ENDPOINT,
    capabilityProtocol: GROK_PROTOCOL,
    adapterId: 'xai-grok-oauth-probe-v1',
    url: `${GROK_OAUTH_DEFAULT_BASE_URL}/responses`,
    probe: 'oauth-responses',
    oauthProvider: 'grok',
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
    !job.target ||
    !modelIdentifier(job.target.model) ||
    Object.keys(job.target).some((key) => !['model', 'endpoint', 'version'].includes(key)) ||
    !Array.isArray(job.allowedModels) ||
    !job.allowedModels.includes(job.target.model) ||
    !Number.isSafeInteger(job.target.version) ||
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

function modelIdentifier(value: unknown): value is string {
  // Vendor-slug ids (`openai/gpt-4o`) are valid catalog model identifiers for
  // aggregators such as OpenRouter. The model only ever travels in a JSON
  // body (never in the fixed adapter URL), so one `/` is not a path-injection
  // surface; scheme-like `://` and empty `//` segments stay rejected.
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) &&
    !value.includes('://') &&
    !value.includes('//')
  );
}

export interface FixedCredentialProbeEndpoint {
  readonly adapterId: string;
  readonly url: string;
  readonly probe: Extract<CredentialValidationProbeKind, 'models' | 'key' | 'messages' | 'chat'>;
}

/**
 * R6a active probing: resolves the protocol-owned FIXED_ADAPTERS endpoint
 * for an account binding without constructing a validation job. The probe
 * service (account-probe-service.ts) uses this for the api-key category so
 * probe traffic hits exactly the allowlisted fixed endpoints — products
 * absent from the table fail closed, exactly like credential validation.
 */
export function resolveFixedCredentialProbeEndpoint(input: {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly capabilityEndpoint: string;
}): FixedCredentialProbeEndpoint | null {
  if (
    typeof input?.providerId !== 'string' ||
    typeof input?.productId !== 'string' ||
    typeof input?.credentialType !== 'string' ||
    typeof input?.capabilityEndpoint !== 'string'
  ) {
    return null;
  }
  const adapter = FIXED_ADAPTERS.find(
    (candidate) =>
      candidate.providerId === input.providerId &&
      candidate.productId === input.productId &&
      candidate.credentialType === input.credentialType &&
      candidate.capabilityEndpoint === input.capabilityEndpoint &&
      // This resolver backs the API-key account-probe path only. OAuth
      // categories have dedicated probe categories with their own secret
      // material and must never be sent through a bearer api-key probe.
      candidate.probe !== 'oauth-responses',
  );
  if (adapter === undefined || adapter.probe === 'oauth-responses') return null;
  return { adapterId: adapter.adapterId, url: adapter.url, probe: adapter.probe };
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

async function boundedResponseBody(
  response: ProviderCredentialValidationResponse,
  signal: AbortSignal,
  capture: boolean,
  maxResponseBytes: number,
): Promise<BoundedBodyResult> {
  if (signal.aborted) {
    cancelResponseBody(response);
    return { state: 'timeout' };
  }
  if (!response.body) return { state: 'ok', bytes: capture ? new Uint8Array() : null };
  const reader = response.body.getReader();
  const buffer = capture ? new Uint8Array(maxResponseBytes) : null;
  let bytesRead = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { state: 'timeout' };
      if (done) return { state: 'ok', bytes: buffer?.subarray(0, bytesRead) ?? null };
      if (!(value instanceof Uint8Array)) {
        cancel();
        return { state: 'read_error' };
      }
      if (value.byteLength > maxResponseBytes - bytesRead) {
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
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// This validates only the bounded probe's Messages envelope, not model
// capabilities or financial usage. Providers may return a canonical model ID
// for an alias; the requested model still comes solely from the allowed job.
function validMessageResponse(
  response: ProviderCredentialValidationResponse,
  bytes: Uint8Array,
  custom: boolean,
): boolean {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return false;
  try {
    const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (
      !body ||
      body.type !== 'message' ||
      body.role !== 'assistant' ||
      !modelIdentifier(body.id) ||
      !(custom ? isCustomCredentialValidationModel(body.model) : modelIdentifier(body.model)) ||
      (body.error !== undefined && body.error !== null) ||
      typeof body.stop_reason !== 'string' ||
      !['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(body.stop_reason) ||
      (body.stop_sequence !== undefined && body.stop_sequence !== null && typeof body.stop_sequence !== 'string') ||
      !Array.isArray(body.content) ||
      body.content.length < 1
    )
      return false;
    if (
      !body.content.every((value: unknown) => {
        const block = record(value);
        if (!block) return false;
        if (block.type === 'text') return typeof block.text === 'string';
        if (block.type === 'thinking')
          return (
            typeof block.thinking === 'string' && (block.signature === undefined || typeof block.signature === 'string')
          );
        return block.type === 'redacted_thinking' && typeof block.data === 'string';
      })
    )
      return false;
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
    if (
      !body ||
      !modelIdentifier(body.id) ||
      body.object !== 'chat.completion' ||
      !counter(body.created) ||
      !isCustomCredentialValidationModel(body.model) ||
      (body.error !== undefined && body.error !== null) ||
      !Array.isArray(body.choices) ||
      body.choices.length !== 1
    )
      return false;
    const choice = record(body.choices[0]);
    const message = record(choice?.message);
    if (
      !choice ||
      choice.index !== 0 ||
      !message ||
      message.role !== 'assistant' ||
      typeof message.content !== 'string' ||
      (message.tool_calls !== undefined && message.tool_calls !== null) ||
      typeof choice.finish_reason !== 'string' ||
      !['stop', 'length', 'content_filter'].includes(choice.finish_reason)
    )
      return false;
    const usage = record(body.usage);
    return (
      !!usage &&
      counter(usage.prompt_tokens) &&
      counter(usage.completion_tokens) &&
      counter(usage.total_tokens) &&
      Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens) &&
      usage.total_tokens === usage.prompt_tokens + usage.completion_tokens
    );
  } catch {
    return false;
  }
}

const OAUTH_SECRET_MAX_BYTES = 16_384;
const OAUTH_MATERIAL_TEXT_MAX_LENGTH = 8_192;

function parseOAuthSecret(secret: Buffer): Fields | null {
  if (secret.length < 2 || secret.length > OAUTH_SECRET_MAX_BYTES) return null;
  try {
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)));
  } catch {
    return null;
  }
}

function oauthMaterialText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > OAUTH_MATERIAL_TEXT_MAX_LENGTH) return null;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function validOAuthResponsesResponse(
  response: ProviderCredentialValidationResponse,
  bytes: Uint8Array,
  challenge: string,
): boolean {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return false;
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return challengeMatches(challenge, firstResponsesText(body)) === 'ok';
  } catch {
    return false;
  }
}

/** Protocol-owned allowlist; never merges job/operator/client supplied headers. */
export function createCredentialValidationProbeRequest(
  probe: CredentialValidationProbe,
  secret: Buffer,
): CredentialValidationProbeRequest | null {
  if (probe.kind === 'oauth-responses') {
    if (!probe.oauthProvider || !probe.challenge) return null;
    const material = parseOAuthSecret(secret);
    if (!material) return null;
    const accessToken = oauthMaterialText(material.access_token);
    if (accessToken === null) return null;
    const challengePrompt = oauthValidationChallengePrompt(probe.challenge);
    if (probe.oauthProvider === 'codex') {
      const rawAccountId = material.chatgpt_account_id;
      const chatgptAccountId =
        rawAccountId === undefined || rawAccountId === null ? null : oauthMaterialText(rawAccountId);
      if (rawAccountId !== undefined && rawAccountId !== null && chatgptAccountId === null) return null;
      const built = buildCodexOAuthProbeRequest({
        accessToken,
        chatgptAccountId,
        model: probe.model,
        challengePrompt,
      });
      return { method: built.method, headers: built.headers, body: built.body, redirect: 'manual' };
    }
    const built = buildGrokOAuthProbeRequest({ accessToken, model: probe.model, challengePrompt });
    return { method: built.method, headers: built.headers, body: built.body, redirect: 'manual' };
  }
  const token = asciiCredential(secret);
  if (token === null) return null;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'model-router' };
  if (probe.kind === 'messages') {
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${token}`;
  }
  if (probe.kind !== 'models' && probe.kind !== 'key') headers['content-type'] = 'application/json';
  return {
    method: probe.kind === 'models' || probe.kind === 'key' ? 'GET' : 'POST',
    headers,
    ...(probe.kind === 'models' || probe.kind === 'key'
      ? {}
      : {
          body: JSON.stringify({
            model: probe.model,
            max_tokens: 8,
            stream: false,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
          }),
        }),
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
  const maxResponseBytes = probe.maxResponseBytes ?? PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES;
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > maxResponseBytes) {
    cancelResponseBody(response);
    return failed('provider_response_too_large', false, probe.adapterId, response.status, durationMs);
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return failed('provider_redirect_rejected', false, probe.adapterId, response.status, durationMs);
  }
  const success = response.status >= 200 && response.status < 300;
  const bodyResult = await boundedResponseBody(
    response,
    signal,
    probe.kind !== 'models' && probe.kind !== 'key' && success,
    maxResponseBytes,
  );
  const completedDurationMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (bodyResult.state === 'too_large') {
    return failed('provider_response_too_large', false, probe.adapterId, response.status, completedDurationMs);
  }
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    return failed(
      bodyResult.state === 'timeout' ? 'provider_timeout' : 'provider_network_error',
      true,
      probe.adapterId,
      response.status,
      completedDurationMs,
    );
  }
  if (success) {
    if (
      probe.kind !== 'models' &&
      probe.kind !== 'key' &&
      (!bodyResult.bytes ||
        !(probe.kind === 'messages'
          ? validMessageResponse(response, bodyResult.bytes, probe.custom)
          : probe.kind === 'chat'
            ? validChatResponse(response, bodyResult.bytes)
            : probe.challenge !== undefined &&
              validOAuthResponsesResponse(response, bodyResult.bytes, probe.challenge)))
    ) {
      return failed('provider_response_invalid', false, probe.adapterId, response.status, completedDurationMs);
    }
    return {
      state: 'verified',
      adapterId: probe.adapterId,
      httpStatus: response.status,
      durationMs: completedDurationMs,
    };
  }
  if (response.status === 401 || response.status === 403)
    return failed('credential_rejected', false, probe.adapterId, response.status, completedDurationMs);
  if (response.status === 404 || response.status === 405)
    return failed('provider_endpoint_unsupported', false, probe.adapterId, response.status, completedDurationMs);
  if (response.status === 429)
    return failed('provider_rate_limited', true, probe.adapterId, response.status, completedDurationMs);
  if (response.status >= 500)
    return failed('provider_unavailable', true, probe.adapterId, response.status, completedDurationMs);
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
  const oauth = adapter.probe === 'oauth-responses';
  // Only protocol-owned fixed adapters select an expanded budget. Custom
  // targets retain the default bounds in their separately pinned transport.
  const limits =
    adapter.limits ??
    (oauth
      ? {
          timeoutMs: PROVIDER_OAUTH_VALIDATION_TIMEOUT_MS,
          maxResponseBytes: PROVIDER_OAUTH_VALIDATION_MAX_RESPONSE_BYTES,
        }
      : adapter.probe === 'messages' || adapter.probe === 'chat'
        ? {
            timeoutMs: PROVIDER_INFERENCE_VALIDATION_TIMEOUT_MS,
            maxResponseBytes: PROVIDER_INFERENCE_VALIDATION_MAX_RESPONSE_BYTES,
          }
        : {
            timeoutMs: PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS,
            maxResponseBytes: PROVIDER_CREDENTIAL_VALIDATION_MAX_RESPONSE_BYTES,
          });
  const probe: CredentialValidationProbe = {
    adapterId: adapter.adapterId,
    kind: adapter.probe,
    model: job.target.model,
    custom: false,
    ...(adapter.oauthProvider === undefined ? {} : { oauthProvider: adapter.oauthProvider }),
    // Six digits, generated inside the worker for exactly one probe. The
    // account/credential are only marked verified when the upstream answer
    // matches; a cached or fixed "OK" body cannot satisfy it.
    ...(oauth ? { challenge: randomInt(100_000, 1_000_000).toString() } : {}),
    ...limits,
  };
  const init = createCredentialValidationProbeRequest(probe, secret);
  if (!init) return failed('credential_format_invalid', false, adapter.adapterId, null, 0);

  let response: Response | undefined;
  const deadline = AbortSignal.timeout(probe.timeoutMs ?? PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS);
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
