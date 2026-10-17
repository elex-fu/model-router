import { createHash } from 'node:crypto';
import type { RequestPreparationSchedulingContext } from './request-preparation-service.js';

/**
 * Sticky-session reference derivation (roadmap batch 2 §2.1, task #5).
 *
 * This is the trusted-boundary half of the merged sessionHash口径: it
 * extracts the four reference tiers of the sub2api sticky-session design
 * (GenerateSessionHash in gateway_service.go + GenerateSessionHash in
 * openai_gateway_scheduling.go, read-only reference) from a parsed gateway
 * request, and `stickySchedulingContext` feeds them through the single
 * shared priority chain `computeStickySessionHash`
 * (session-id → conversation_id → prompt_cache_key → content-hash) to
 * produce the opaque `input.scheduling.sessionId` reference.
 *
 * Tier mapping (sub2api source → merged tier):
 * - anthropic `metadata.user_id` session UUID (both the legacy
 *   `user_{64hex}_account_{uuid}_session_{36}` shape and the ≥2.1.78 JSON
 *   `{device_id, account_uuid, session_id}` shape) → sessionId (raw value,
 *   never hashed — sub2api returns uid.SessionID verbatim).
 * - `session-id` / `session_id` request header (openai family) → sessionId.
 * - `conversation_id` header or body field (openai/responses) →
 *   conversationId. (anthropic has no conversation reference.)
 * - openai-family body `prompt_cache_key` and the anthropic
 *   cache_control:{type:"ephemeral"} content hash → promptCacheKey. Both are
 *   cache-anchored conversation markers; for anthropic the ephemeral tier is
 *   the sub2api #2 source (messages content first, then system parts).
 * - full content fallback → contentHash: sub2api's IP + normalized UA + key
 *   id + system + message-text digest for anthropic, and its stable-fields
 *   seed (model + instructions + leading system/developer prefix + first
 *   user message + tool names) for the openai family, both prefixed with the
 *   same request-context discriminators.
 *
 * Deviations from sub2api (documented, deliberate):
 * - Hashing is SHA-256 (node:crypto, zero dependencies) with per-tier domain
 *   separation instead of xxhash — hash VALUES are not shared with sub2api,
 *   only the derivation semantics.
 * - The user agent is used bounded-but-raw (sub2api extracts product
 *   tokens); determinism within one session is what the fallback needs.
 * - Statelesss operations (embeddings, sub2api's /v1/images precedent) skip
 *   the content-derived fallback entirely: no explicit session signal means
 *   no sticky reference.
 *
 * The derived reference is request-scoped scheduler input only: it is never
 * logged, never audited, and the durable affinity store HMACs it before any
 * SQL is issued (postgres-provider-account-affinity.ts).
 */

export type StickySessionProtocol = 'anthropic' | 'openai' | 'responses';

export interface StickySessionReferenceRequest {
  readonly protocol: StickySessionProtocol;
  /** Raw (lowercased) inbound request headers; only scalar lookups are made. */
  readonly headers: Readonly<Record<string, readonly string[] | string | undefined>>;
  /** The parsed JSON request body (readJsonBody output; unknown shape is ignored). */
  readonly body: unknown;
  /** Trusted-boundary client IP (ClientAddressResolution address or null). */
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  /** The authenticated proxy key id — the per-caller discriminator. */
  readonly proxyKeyId: string | null;
  /** Stateless operations (embeddings) never use the content fallback. */
  readonly stateless?: boolean;
}

export interface StickySessionReferences {
  readonly sessionId: string | null;
  readonly conversationId: string | null;
  readonly promptCacheKey: string | null;
  readonly contentHash: string | null;
}

const MAX_REFERENCE_BYTES = 512;
const MAX_HEADER_BYTES = 512;
const MAX_METADATA_USER_ID_BYTES = 2048;

/** Legacy metadata.user_id: user_{64hex}_account_{optional uuid}_session_{36}. */
const LEGACY_METADATA_USER_ID = /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes('\0')) return null;
  return Buffer.byteLength(trimmed, 'utf8') > maxBytes ? null : trimmed;
}

function headerValue(
  headers: Readonly<Record<string, readonly string[] | string | undefined>>,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return boundedText(value, MAX_HEADER_BYTES);
}

function sha256Hex(domain: string, ...parts: readonly string[]): string {
  const hash = createHash('sha256').update(domain);
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('hex');
}

/**
 * Anthropic metadata.user_id parsing (sub2api metadata_userid.go): the JSON
 * format used by Claude Code ≥2.1.78 first ({device_id, account_uuid,
 * session_id} with device_id and session_id required), then the legacy
 * concatenated shape. Returns the raw session UUID or null.
 */
export function sessionFromMetadataUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || Buffer.byteLength(value, 'utf8') > MAX_METADATA_USER_ID_BYTES) return null;
  if (value.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const deviceId = boundedText(parsed.device_id, MAX_REFERENCE_BYTES);
    const sessionId = boundedText(parsed.session_id, MAX_REFERENCE_BYTES);
    if (deviceId === null || sessionId === null) return null;
    return sessionId;
  }
  const match = LEGACY_METADATA_USER_ID.exec(value);
  return match === null ? null : boundedText(match[3], MAX_REFERENCE_BYTES);
}

/** True when a content-parts array carries a cache_control:{type:"ephemeral"} marker. */
function contentArrayHasEphemeral(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (isRecord(part) && isRecord(part.cache_control) && part.cache_control.type === 'ephemeral') return true;
  }
  return false;
}

/** All text of one content value: a plain string, or the text parts of an array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * Anthropic ephemeral-cache seed (sub2api extractCacheableContent): the text
 * of the FIRST message whose content array carries an ephemeral marker, else
 * the concatenated text of ephemeral-marked system parts.
 */
function anthropicEphemeralSeed(body: Record<string, unknown>): string | null {
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      if (contentArrayHasEphemeral(message.content)) {
        const text = contentText(message.content);
        if (text !== '') return text;
      }
    }
  }
  if (Array.isArray(body.system)) {
    let text = '';
    for (const part of body.system) {
      if (
        isRecord(part) &&
        isRecord(part.cache_control) &&
        part.cache_control.type === 'ephemeral' &&
        typeof part.text === 'string'
      ) {
        text += part.text;
      }
    }
    if (text !== '') return text;
  }
  return null;
}

/** Anthropic system text: a plain string or the text parts of the system array. */
function anthropicSystemText(body: Record<string, unknown>): string {
  if (typeof body.system === 'string') return body.system;
  return contentText(body.system);
}

/** Anthropic full message text (sub2api appendMessageTextsFromRaw). */
function anthropicMessageText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) return '';
  let text = '';
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    if (message.content !== undefined) text += contentText(message.content);
  }
  return text;
}

/** OpenAI-family stable-field seed (sub2api deriveOpenAIContentSessionSeed). */
function openAiStableContentSeed(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body.model === 'string' && body.model.trim() !== '') parts.push(body.model.trim());
  if (typeof body.instructions === 'string' && body.instructions.trim() !== '') {
    parts.push(body.instructions.trim());
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool)) continue;
      if (typeof tool.name === 'string' && tool.name !== '') parts.push(tool.name);
      const fn = tool.function;
      if (isRecord(fn) && typeof fn.name === 'string' && fn.name !== '') parts.push(fn.name);
    }
  }
  if (Array.isArray(body.messages)) {
    // Leading system/developer prefix plus the first user message: fields
    // that stay stable across the turns of one conversation.
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      const role = message.role;
      if (role === 'system' || role === 'developer') {
        parts.push(contentText(message.content));
        continue;
      }
      if (role === 'user') {
        parts.push(contentText(message.content));
        break;
      }
      break;
    }
  } else if (typeof body.input === 'string') {
    parts.push(body.input);
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isRecord(item) && item.role === 'user') {
        parts.push(contentText(item.content));
        break;
      }
    }
  }
  return parts.join('\0');
}

function contextDiscriminators(input: StickySessionReferenceRequest): string {
  // The agent is bounded but otherwise raw (documented deviation from
  // sub2api's product-token extraction): determinism within a session is
  // what the fallback needs, and an over-long agent is noise, not identity.
  const userAgent = boundedText(input.userAgent, 2048) ?? '';
  return sha256Hex('model-router:sticky:context:v1', input.clientIp ?? '', userAgent, input.proxyKeyId ?? '');
}

function sessionIdReference(input: StickySessionReferenceRequest): string | null {
  if (input.protocol === 'anthropic') {
    const metadata = isRecord(input.body) ? input.body.metadata : undefined;
    const userId = isRecord(metadata) ? metadata.user_id : undefined;
    return sessionFromMetadataUserId(userId);
  }
  return headerValue(input.headers, 'session-id') ?? headerValue(input.headers, 'session_id');
}

function conversationIdReference(input: StickySessionReferenceRequest): string | null {
  // Batch-3 grok: the CLI proxy's own conversation header is a first-class
  // conversation reference (upstream shard routing keys on it).
  if (headerValue(input.headers, 'x-grok-conv-id') !== null) return headerValue(input.headers, 'x-grok-conv-id');
  const fromHeader = headerValue(input.headers, 'conversation_id');
  if (fromHeader !== null) return fromHeader;
  if (isRecord(input.body)) return boundedText(input.body.conversation_id, MAX_REFERENCE_BYTES);
  return null;
}

function promptCacheKeyReference(input: StickySessionReferenceRequest): string | null {
  if (input.protocol === 'anthropic') {
    if (!isRecord(input.body)) return null;
    const seed = anthropicEphemeralSeed(input.body);
    return seed === null ? null : sha256Hex('model-router:sticky:ephemeral:v1', seed);
  }
  if (isRecord(input.body)) return boundedText(input.body.prompt_cache_key, MAX_REFERENCE_BYTES);
  return null;
}

function contentHashReference(input: StickySessionReferenceRequest): string | null {
  if (input.stateless === true) return null;
  if (!isRecord(input.body)) return null;
  let content: string;
  if (input.protocol === 'anthropic') {
    const systemText = anthropicSystemText(input.body);
    const messageText = anthropicMessageText(input.body);
    if (systemText === '' && messageText === '') return null;
    content = `${systemText}\0${messageText}`;
  } else {
    content = openAiStableContentSeed(input.body);
  }
  if (content.trim() === '') return null;
  return sha256Hex('model-router:sticky:content:v1', contextDiscriminators(input), content);
}

/** Eagerly derives all four reference tiers (tests and diagnostics). */
export function deriveStickySessionReferences(input: StickySessionReferenceRequest): StickySessionReferences {
  return {
    sessionId: sessionIdReference(input),
    conversationId: conversationIdReference(input),
    promptCacheKey: promptCacheKeyReference(input),
    contentHash: contentHashReference(input),
  };
}

/**
 * The production seam: derives the sticky scheduling context for one request,
 * evaluating the tiers lazily in priority order so a metadata session UUID
 * never pays for a content hash. Returns undefined when no reference exists —
 * the default (non-sticky) preparation path stays byte-identical.
 */
export function stickySchedulingContext(
  input: StickySessionReferenceRequest,
): RequestPreparationSchedulingContext | undefined {
  const tiers: Array<() => string | null> = [
    () => sessionIdReference(input),
    () => conversationIdReference(input),
    () => promptCacheKeyReference(input),
    () => contentHashReference(input),
  ];
  for (const tier of tiers) {
    const reference = tier();
    if (reference !== null) return { sessionId: reference };
  }
  return undefined;
}
