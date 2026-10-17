import {
  applyGrokCliProxyHeaders,
  GROK_API_KEY_DEFAULT_BASE_URL,
  GROK_OAUTH_DEFAULT_BASE_URL,
  isGrokOfficialHost,
} from '../grok/constants.js';
import type { GrokCredentialResolver } from '../grok/transport.js';
import { VIDEO_TASK_ID_PATTERN } from './video-billing.js';

/**
 * Roadmap batch 4 §4.3 (task #17): the status/content forwarder for the
 * bound Grok video account (sub2api ForwardGrokMedia's video lookup
 * branches). The create rides the ordinary prepared-evidence dispatch
 * chain; these GET lookups are query-endpoint traffic — they re-dial the
 * account that accepted the create and replay its credential.
 *
 * Security posture mirrors the batch-3 Grok transport exactly:
 * - SSRF hard gate: an OAuth token ONLY ever reaches an official xAI host
 *   (api.x.ai / *.api.x.ai / cli-chat-proxy.grok.com); a custom base host
 *   is permitted for api-key credentials and only through the operator
 *   allowlist;
 * - CLI identity masquerade on cli-chat-proxy targets;
 * - redirects rejected, https only, no userinfo/query/fragment on the base;
 * - bounded response bodies (the status JSON cap mirrors the transport's
 *   error-body cap; the content cap is an explicit memory ceiling).
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STATUS_BODY_BYTES = 262_144;
/** Explicit in-memory ceiling for one proxied video content response. */
export const DEFAULT_MAX_VIDEO_CONTENT_BYTES = 64 * 1024 * 1024;

/** The signed video content host (sub2api grokMediaSignedVideoContentURL). */
const SIGNED_VIDEO_CONTENT_HOST = 'vidgen.x.ai';

export type GrokVideoUpstreamErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'HOST_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE'
  | 'BODY_TOO_LARGE';

export class GrokVideoUpstreamError extends Error {
  constructor(
    readonly code: GrokVideoUpstreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GrokVideoUpstreamError';
  }
}

function fail(code: GrokVideoUpstreamErrorCode, message: string): never {
  throw new GrokVideoUpstreamError(code, message);
}

function validateTaskId(requestId: string): string {
  const id = requestId.trim();
  if (!VIDEO_TASK_ID_PATTERN.test(id)) fail('INVALID_INPUT', 'the grok video task id is invalid');
  return id;
}

/**
 * Resolves and validates the outbound status/content URL (pure; the SSRF
 * hard gate). The video lookup family lives under the same base as the
 * batch-3 chat transport: `{base}/videos/{requestId}[/content]`.
 */
export function resolveGrokVideoUrl(input: {
  readonly credentialKind: 'oauth' | 'api-key';
  readonly baseUrl?: string;
  readonly kind: 'status' | 'content';
  readonly requestId: string;
  readonly operatorHostAllowlist?: readonly string[];
}): URL {
  const requestId = validateTaskId(input.requestId);
  const base =
    input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl.trim() !== ''
      ? input.baseUrl.trim()
      : input.credentialKind === 'oauth'
        ? GROK_OAUTH_DEFAULT_BASE_URL
        : GROK_API_KEY_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    fail('HOST_NOT_ALLOWED', 'the grok base URL is invalid');
  }
  if (url.protocol !== 'https:') fail('HOST_NOT_ALLOWED', 'the grok base URL must be https');
  if (url.username !== '' || url.password !== '') fail('HOST_NOT_ALLOWED', 'the grok base URL must not carry userinfo');
  if (url.search !== '' || url.hash !== '') {
    fail('HOST_NOT_ALLOWED', 'the grok base URL must not carry a query or fragment');
  }
  const host = url.hostname.toLowerCase();
  const official = isGrokOfficialHost(host);
  if (input.credentialKind === 'oauth') {
    if (!official) fail('HOST_NOT_ALLOWED', 'grok OAuth traffic may only target official xAI hosts');
  } else if (!official) {
    const allowlist = (input.operatorHostAllowlist ?? []).map((entry) => entry.trim().toLowerCase());
    if (!allowlist.includes(host)) {
      fail('HOST_NOT_ALLOWED', 'the grok custom base host is not on the operator allowlist');
    }
  }
  const path = url.pathname.replace(/\/+$/, '');
  const suffix = input.kind === 'content' ? '/content' : '';
  return new URL(`${url.origin}${path}/videos/${encodeURIComponent(requestId)}${suffix}`);
}

/**
 * The signed video content URL from a done status: https vidgen.x.ai only,
 * no userinfo, no explicit non-443 port (sub2api
 * grokMediaSignedVideoContentURL). Anything else is not a signed URL — the
 * caller re-dials the account-bound content endpoint with credentials.
 */
export function grokVideoSignedContentUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hostname.toLowerCase() !== SIGNED_VIDEO_CONTENT_HOST) return null;
  if (parsed.port !== '' && parsed.port !== '443') return null;
  return parsed.toString();
}

/** The account binding a status/content poll re-dials (the create's account). */
export interface GrokVideoAccountBinding {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
}

export type GrokVideoUpstreamResponse =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: Uint8Array;
      readonly contentType: string | null;
    }
  | {
      readonly kind: 'error';
      readonly status: number | null;
      readonly code: GrokVideoUpstreamErrorCode;
      readonly message: string;
    };

export interface GrokVideoUpstreamOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly resolveCredential: GrokCredentialResolver;
  /** Credential-kind-scoped base override (tests / custom api-key upstreams). */
  readonly baseUrl?: string;
  readonly operatorHostAllowlist?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxContentBytes?: number;
  readonly nowMs?: () => number;
}

interface NormalizedUpstreamOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly resolveCredential: GrokCredentialResolver;
  readonly baseUrl: string | undefined;
  readonly operatorHostAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxContentBytes: number;
}

export interface GrokVideoStatusRequest {
  readonly account: GrokVideoAccountBinding;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface GrokVideoContentRequest {
  readonly account: GrokVideoAccountBinding;
  readonly requestId: string;
  /** The done status's video.url when it is a signed vidgen.x.ai URL. */
  readonly signedContentUrl: string | null;
  /** The client's Range header, passed through to the content fetch. */
  readonly range: string | null;
  readonly signal?: AbortSignal;
}

/**
 * One-shot forwarder; constructed once per process. The credential is
 * resolved per call and exists only inside the resolver callback.
 */
export class GrokVideoUpstreamForwarder {
  private readonly options: NormalizedUpstreamOptions;

  constructor(options: GrokVideoUpstreamOptions) {
    if (!options || typeof options.fetch !== 'function') {
      fail('INVALID_INPUT', 'an injected fetch adapter is required');
    }
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a grok credential resolver is required');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_VIDEO_CONTENT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('INVALID_INPUT', 'the video timeout is invalid');
    if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) {
      fail('INVALID_INPUT', 'the video content ceiling is invalid');
    }
    this.options = {
      fetch: options.fetch,
      resolveCredential: options.resolveCredential,
      baseUrl: options.baseUrl,
      operatorHostAllowlist: options.operatorHostAllowlist ?? [],
      timeoutMs,
      maxContentBytes,
    };
  }

  /** GET {base}/videos/{requestId} — the official status lookup. */
  async fetchStatus(request: GrokVideoStatusRequest): Promise<GrokVideoUpstreamResponse> {
    return this.sendBound(request.account, request.requestId, 'status', null, request.signal, MAX_STATUS_BODY_BYTES);
  }

  /**
   * The content proxy fetch: a signed vidgen.x.ai URL dials without
   * credentials; anything else re-dials the account-bound content
   * endpoint with the account's credential (sub2api
   * forwardGrokMediaVideoContent).
   */
  async fetchContent(request: GrokVideoContentRequest): Promise<GrokVideoUpstreamResponse> {
    const signed = request.signedContentUrl !== null ? grokVideoSignedContentUrl(request.signedContentUrl) : null;
    if (signed !== null) {
      return this.sendUnauthenticated(signed, request.range, request.signal, this.options.maxContentBytes);
    }
    return this.sendBound(
      request.account,
      request.requestId,
      'content',
      request.range,
      request.signal,
      this.options.maxContentBytes,
    );
  }

  /** Fetches an account-bound status/content URL with the account's credential. */
  private async sendBound(
    account: GrokVideoAccountBinding,
    requestId: string,
    kind: 'status' | 'content',
    range: string | null,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<GrokVideoUpstreamResponse> {
    for (const field of ['accountId', 'credentialId', 'credentialVersion'] as const) {
      const value = account[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `the grok video account binding field ${field} is required`);
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      return await this.options.resolveCredential(
        {
          accountId: account.accountId,
          credentialId: account.credentialId,
          credentialVersion: account.credentialVersion,
          signal: controller.signal,
        },
        (credential) => {
          const token = credential.kind === 'oauth' ? credential.accessToken : credential.apiKey;
          if (typeof token !== 'string' || token.length === 0) {
            fail('CREDENTIAL_INVALID', 'grok credential carries no token');
          }
          const url = resolveGrokVideoUrl({
            credentialKind: credential.kind,
            ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
            kind,
            requestId,
            ...(this.options.operatorHostAllowlist.length === 0
              ? {}
              : { operatorHostAllowlist: this.options.operatorHostAllowlist }),
          });
          const headers = applyGrokCliProxyHeaders(
            {
              host: url.host,
              authorization: `Bearer ${token}`,
              accept: kind === 'status' ? 'application/json' : '*/*',
              ...(range !== null && range.trim() !== '' ? { range: range.trim() } : {}),
            },
            url.hostname,
          );
          return this.sendUrl(url.toString(), headers, controller.signal, () => timedOut, maxBytes);
        },
      );
    } catch (error) {
      if (error instanceof GrokVideoUpstreamError) {
        return { kind: 'error', status: null, code: error.code, message: error.message };
      }
      if (timedOut) return { kind: 'error', status: null, code: 'TIMEOUT', message: 'grok video upstream timed out' };
      if (signal?.aborted || controller.signal.aborted) {
        return { kind: 'error', status: null, code: 'ABORTED', message: 'grok video upstream was aborted' };
      }
      return {
        kind: 'error',
        status: null,
        code: 'CREDENTIAL_UNAVAILABLE',
        message: 'grok credential resolution failed',
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  /** Fetches a signed content URL without credentials (its own timeout). */
  private async sendUnauthenticated(
    url: string,
    range: string | null,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<GrokVideoUpstreamResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const headers: Record<string, string> = {
        accept: '*/*',
        ...(range !== null && range.trim() !== '' ? { range: range.trim() } : {}),
      };
      return await this.sendUrl(url, headers, controller.signal, () => timedOut, maxBytes);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async sendUrl(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    timedOut: () => boolean,
    maxBytes: number,
  ): Promise<GrokVideoUpstreamResponse> {
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal,
      });
    } catch {
      if (timedOut()) return { kind: 'error', status: null, code: 'TIMEOUT', message: 'grok video upstream timed out' };
      if (signal.aborted)
        return { kind: 'error', status: null, code: 'ABORTED', message: 'grok video upstream was aborted' };
      return { kind: 'error', status: null, code: 'NETWORK_ERROR', message: 'grok video upstream request failed' };
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      return {
        kind: 'error',
        status: null,
        code: 'INVALID_RESPONSE',
        message: 'grok video upstream returned an invalid response',
      };
    }
    if (response.status >= 300 && response.status <= 399) {
      try {
        await response.body?.cancel();
      } catch {
        // The response is discarded either way.
      }
      return {
        kind: 'error',
        status: response.status,
        code: 'REDIRECT_REJECTED',
        message: 'grok video upstream redirect was rejected',
      };
    }
    if (response.status < 100 || response.status > 599) {
      return {
        kind: 'error',
        status: null,
        code: 'INVALID_RESPONSE',
        message: 'grok video upstream returned an invalid status',
      };
    }
    let body: Uint8Array;
    try {
      body = await readBounded(response, maxBytes);
    } catch (error) {
      if (error instanceof GrokVideoUpstreamError) {
        return { kind: 'error', status: response.status, code: error.code, message: error.message };
      }
      if (timedOut())
        return { kind: 'error', status: response.status, code: 'TIMEOUT', message: 'grok video upstream timed out' };
      return {
        kind: 'error',
        status: response.status,
        code: 'NETWORK_ERROR',
        message: 'grok video upstream body read failed',
      };
    }
    const contentTypeHeader = response.headers?.get?.('content-type') ?? null;
    return {
      kind: 'response',
      status: response.status,
      body,
      contentType: contentTypeHeader !== '' ? contentTypeHeader : null,
    };
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) continue;
    if (value.byteLength > maxBytes - total) {
      try {
        await reader.cancel();
      } catch {
        // The overflow already failed the read.
      }
      fail('BODY_TOO_LARGE', `the grok video upstream response exceeds the ${maxBytes}-byte ceiling`);
    }
    chunks.push(value);
    total += value.byteLength;
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
