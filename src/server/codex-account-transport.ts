/**
 * CS3 (docs/standalone-relay-capability-plan-2026-10-30.md D1): classic
 * ProviderTransportProfile for a Codex subscription ACCOUNT upstream — the
 * credential is an OAuthAccountStore entry ('codex_oauth', kept alive by the
 * CS1 OAuthRefreshEngine) instead of a static API key. Dispatches to
 * `chatgpt.com/backend-api/codex/responses` with the canonical Codex CLI
 * identity.
 *
 * Shared single-source-of-truth modules are IMPORTED from the pure SaaS tree
 * (the plan's 提炼而非复制 principle — verified import chains: node:crypto
 * only, no PG/Redis/SaaS infra):
 * - `src/saas/gateway/codex/identity.ts` (buildCanonicalIdentity,
 *   accountIdentityNamespace, isolateSessionId)
 * - `src/saas/gateway/codex/transform.ts` (applyCodexOAuthTransform)
 * - `src/saas/gateway/codex/instructions.ts` (resolveCodexInstructions)
 * - `src/saas/gateway/codex/quota-headers.ts` (parseCodexRateLimitHeaders is
 *   consumed by the dispatch wiring, not this module)
 *
 * Account selection itself lives in the dispatch wiring (proxy.ts) via the
 * codex account pool, so the chosen account rides the structural
 * `UpstreamProviderSettings.codexAccount` field into `buildAuth`; this keeps
 * the profile stateless and lets the dispatch feed attempt outcomes back to
 * the pool (markSuccess/markFailure) for cooldown scheduling.
 */

import { accountIdentityNamespace, buildCanonicalIdentity, isolateSessionId } from '../saas/gateway/codex/identity.js';
import { resolveCodexInstructions } from '../saas/gateway/codex/instructions.js';
import { applyCodexOAuthTransform } from '../saas/gateway/codex/transform.js';
import type {
  ProviderAuthRequest,
  ProviderRequestBodyContext,
  ProviderTransportProfile,
  ProviderUrlInput,
  UpstreamProviderSettings,
} from './providers/types.js';

/** Transport id — matches the `codexAccount` activation field family. */
export const CODEX_ACCOUNT_TRANSPORT_ID = 'codex-account';
/** Default origin+prefix when the upstream configures no baseUrl. */
export const CODEX_ACCOUNT_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
/** OAuth account provider the pool and engine resolve tokens against. */
export const CODEX_ACCOUNT_PROVIDER = 'codex_oauth';

/**
 * Account failure classification for pool cooldowns (s2a
 * openai_gateway_service.go / MR `src/saas/gateway/oauth-subscription/
 * health-classifier.ts` semantics, reduced to the classic account pool):
 * 401 = credential expired (skip account + refresh retry); 429/quota is a
 * cooldown, NOT unhealthiness; everything else counts strikes.
 */
export type CodexAccountFailureClassification = 'credential_expired' | 'quota' | 'other';

/**
 * The CS1 refresh-engine handle the transport needs (satisfied by
 * OAuthRefreshEngine and test stubs): lazily resolves a live access token
 * for one account, refreshing first when the stored token is inside the
 * expiry margin.
 */
export interface CodexAccountEngine {
  resolveAccessToken(provider: string, accountId?: string, options?: { force?: boolean }): Promise<string>;
}

/**
 * Maps an upstream failure status to the account-pool classification.
 * `body` (when a string) refines 403 quota-window rejections the way the
 * shared health classifier does; 429 is always quota.
 */
export function classifyCodexAccountFailure(status: number, body?: unknown): CodexAccountFailureClassification {
  if (status === 401) return 'credential_expired';
  if (status === 429) return 'quota';
  if (status === 403) {
    const text = typeof body === 'string' ? body.toLowerCase() : '';
    if (text.includes('usage limit') || text.includes('quota will reset')) return 'quota';
  }
  return 'other';
}

/**
 * CS3 fix 1 (docs/standalone-relay-capability-plan-2026-10-30.md 已知未闭合项
 * 1): per-account session identity isolation. The same client conversation's
 * `session_id` / `conversation_id` headers (and the body's
 * `prompt_cache_key`) must hash to a different 8-hex identifier under every
 * (proxy key, ChatGPT account) pair, exactly like the SaaS gateway transport
 * (src/saas/gateway/codex/transport.ts buildHeaders): the pool round-robins
 * accounts, so verbatim passthrough would land one conversation's session
 * ids on multiple accounts — the detection-risk gap this closes.
 *
 * `chatgptUserId` falls back to the ChatGPT account id when unknown: the SaaS
 * transport passes the credential's real user id (accountIdentityNamespace
 * throws on empty coordinates — an account without them must never silently
 * share a namespace), while the classic store does not persist one yet; the
 * namespace stays unique per account either way, and the derivation is pure
 * SHA-256 so retries on the SAME account reuse the SAME derived ids.
 */
export interface CodexRequestIdentity {
  /** Proxy key whose client sessions must stay isolated (SaaS `proxyKeyId`). */
  readonly proxyKeyId: string;
  readonly chatgptAccountId: string;
  readonly chatgptUserId?: string;
}

/**
 * The account's identity namespace `chatgpt:{accountId}:user:{userId}` with
 * the classic-mode userId fallback (see CodexRequestIdentity).
 */
export function codexAccountNamespace(identity: CodexRequestIdentity): string {
  return accountIdentityNamespace({
    chatgptAccountId: identity.chatgptAccountId,
    chatgptUserId:
      typeof identity.chatgptUserId === 'string' && identity.chatgptUserId !== ''
        ? identity.chatgptUserId
        : identity.chatgptAccountId,
  });
}

/**
 * Namespaces one client-supplied identifier; `null` when the input is absent
 * or the identity is incomplete (absent stays absent — ids are never
 * fabricated, mirroring the SaaS contract).
 */
export function isolateCodexSessionId(identity: CodexRequestIdentity, raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (typeof identity.proxyKeyId !== 'string' || identity.proxyKeyId.length === 0) return null;
  if (typeof identity.chatgptAccountId !== 'string' || identity.chatgptAccountId.length === 0) return null;
  return isolateSessionId(identity.proxyKeyId, codexAccountNamespace(identity), raw);
}

/** Structural codex account settings the dispatch rides on the provider settings. */
interface CodexAccountSettings {
  readonly accountId: string;
  readonly accessToken?: string;
  readonly chatgptAccountId?: string;
  readonly chatgptUserId?: string;
  readonly proxyKeyId?: string;
}

function headerText(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * CS3 fix 3: bounded SSE aggregation for non-streaming clients. The shared
 * codex wire transform forces `stream: true` upstream, so a non-streaming
 * client meets a `text/event-stream` reply; this drains the stream and
 * resolves the TERMINAL event's payload — `response.completed` /
 * `response.incomplete` deliver their `.response` object (the complete final
 * response, usage included), `response.failed` / `error` events deliver the
 * error object. A stream that ends (or overflows) without a terminal event
 * resolves `ok: false` — the caller fails closed with a 502 and never
 * fabricates a response.
 */
export const CODEX_SSE_AGGREGATION_MAX_BYTES = 32 * 1024 * 1024;

export type CodexSseAggregation =
  | { readonly ok: true; readonly kind: 'response' | 'error'; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'no_terminal_event' | 'size_exceeded' };

interface SseEvent {
  readonly type: string | null;
  readonly data: unknown;
}

const SSE_EVENT_SEPARATOR = /\r?\n\r?\n/;

function parseSseEvent(raw: string): SseEvent | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    // Empty lines and comment lines (leading ':') carry no data.
    if (line.length === 0 || line.charCodeAt(0) === 58) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).replace(/^ /, '');
    } else if (line.startsWith('data:')) {
      // SSE allows exactly one optional leading space after the colon.
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  const payload = data as { type?: unknown };
  const type = typeof payload?.type === 'string' && payload.type !== '' ? payload.type : eventName;
  return { type, data };
}

function terminalSseOutcome(event: SseEvent): CodexSseAggregation | undefined {
  const data = isRecord(event.data) ? event.data : null;
  if (event.type === 'response.completed' || event.type === 'response.incomplete') {
    if (data !== null && isRecord(data.response)) {
      return { ok: true, kind: 'response', body: data.response };
    }
    // A terminal event without a response object cannot be trusted.
    return { ok: false, reason: 'no_terminal_event' };
  }
  if (event.type === 'response.failed' || event.type === 'error') {
    // The error object: a failed response's nested error, else the failed
    // response envelope, else the bare error event payload itself.
    const failedResponse = data !== null && isRecord(data.response) ? data.response : null;
    const errorBody =
      failedResponse !== null && isRecord(failedResponse.error) ? failedResponse.error : (failedResponse ?? data);
    if (errorBody !== null) return { ok: true, kind: 'error', body: errorBody };
    return { ok: false, reason: 'no_terminal_event' };
  }
  return undefined;
}

/**
 * Aggregates one codex SSE reply into its terminal payload. Read errors
 * propagate (the caller maps them through its failure classification); a
 * missing stream is an immediate `no_terminal_event`. Stops reading (and
 * cancels the upstream stream) as soon as the terminal event lands.
 */
export async function aggregateCodexSseResponse(
  stream: ReadableStream<Uint8Array> | null,
  options: { readonly maxBytes?: number; readonly onChunk?: () => void } = {},
): Promise<CodexSseAggregation> {
  if (stream === null || stream === undefined) return { ok: false, reason: 'no_terminal_event' };
  const maxBytes = options.maxBytes ?? CODEX_SSE_AGGREGATION_MAX_BYTES;
  const reader = stream.getReader();
  let buffer = '';
  let bufferedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      options.onChunk?.();
      bufferedBytes += value.byteLength;
      if (bufferedBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'size_exceeded' };
      }
      buffer += Buffer.from(value).toString('utf8');
      for (;;) {
        const match = SSE_EVENT_SEPARATOR.exec(buffer);
        if (match === null) break;
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseSseEvent(rawEvent);
        if (event === null) continue;
        const terminal = terminalSseOutcome(event);
        if (terminal !== undefined) {
          await reader.cancel().catch(() => {});
          return terminal;
        }
      }
    }
    // Lenient tail: a final event flushed without the trailing blank line.
    const tail = buffer.trim();
    if (tail.length > 0) {
      const event = parseSseEvent(tail);
      if (event !== null) {
        const terminal = terminalSseOutcome(event);
        if (terminal !== undefined) return terminal;
      }
    }
    return { ok: false, reason: 'no_terminal_event' };
  } finally {
    reader.releaseLock();
  }
}

export interface CodexAccountTransportDeps {
  /** Lazy token resolution when the selection carries no live token. */
  readonly engine?: CodexAccountEngine;
  /** Account provider id; defaults to 'codex_oauth'. */
  readonly provider?: string;
  /** Canonical identity version override (tests pin the UA). */
  readonly versionOverride?: string;
}

/**
 * Builds the codex account transport profile. The returned profile is
 * stateless (safe to construct once per server and share across requests):
 * every per-request input — account id, token, chatgpt-account-id, proxy key
 * id for the session-identity namespace — rides `upstream.codexAccount` in
 * the provider settings.
 */
export function createCodexAccountTransport(deps: CodexAccountTransportDeps = {}): ProviderTransportProfile {
  const provider = deps.provider ?? CODEX_ACCOUNT_PROVIDER;
  return {
    id: CODEX_ACCOUNT_TRANSPORT_ID,
    defaultBaseUrl: CODEX_ACCOUNT_DEFAULT_BASE_URL,
    buildUrl(input: ProviderUrlInput): string {
      // The codex wire is the responses protocol; streaming rides the body
      // (store/stream flags), never the URL. Anything else fails closed.
      if (input.endpoint !== 'responses') {
        throw new Error(`codex account transport profile does not support endpoint "${input.endpoint}"`);
      }
      const base =
        input.baseUrl === undefined || input.baseUrl.trim() === ''
          ? CODEX_ACCOUNT_DEFAULT_BASE_URL
          : input.baseUrl.trim();
      return `${base.replace(/\/+$/, '')}/responses`;
    },
    async buildAuth(
      upstream: UpstreamProviderSettings,
      request: ProviderAuthRequest,
    ): Promise<Readonly<Record<string, string>>> {
      const account = upstream.codexAccount as CodexAccountSettings | undefined;
      if (
        account === undefined ||
        account === null ||
        typeof account.accountId !== 'string' ||
        account.accountId === ''
      ) {
        throw new Error('codex account transport profile requires a selected codex account');
      }
      let accessToken: string | undefined =
        typeof account.accessToken === 'string' && account.accessToken !== '' ? account.accessToken : undefined;
      if (accessToken === undefined) {
        if (deps.engine === undefined) {
          throw new Error(`codex account transport profile cannot resolve a token for account ${account.accountId}`);
        }
        accessToken = await deps.engine.resolveAccessToken(provider, account.accountId);
      }
      const identity = buildCanonicalIdentity(deps.versionOverride);
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        'user-agent': identity.userAgent,
        originator: identity.originator,
        version: identity.version,
        'openai-beta': 'responses=experimental',
      };
      const chatgptAccountId =
        typeof account.chatgptAccountId === 'string' && account.chatgptAccountId !== ''
          ? account.chatgptAccountId
          : null;
      if (chatgptAccountId !== null) {
        headers['chatgpt-account-id'] = chatgptAccountId;
        // CS3 fix 1: per-account session identity isolation. The dispatch
        // forwards the client's session_id/conversation_id on the auth
        // request; rewrite them through the account's namespace so the same
        // client conversation derives a different id on every account (and
        // the SAME id on retries of the same account). Absent ids stay
        // absent — the client's verbatim value is only left in place when
        // the namespace or proxy key is unknown.
        const identitySource: CodexRequestIdentity = {
          proxyKeyId: account.proxyKeyId ?? '',
          chatgptAccountId,
          ...(typeof account.chatgptUserId === 'string' && account.chatgptUserId !== ''
            ? { chatgptUserId: account.chatgptUserId }
            : {}),
        };
        const namespacedSession = isolateCodexSessionId(identitySource, headerText(request.headers['session_id']));
        if (namespacedSession !== null) headers.session_id = namespacedSession;
        const namespacedConversation = isolateCodexSessionId(
          identitySource,
          headerText(request.headers['conversation_id']),
        );
        if (namespacedConversation !== null) headers.conversation_id = namespacedConversation;
      }
      return headers;
    },
    // NOT ownsHeaders: the canonical identity merges with the dispatch's
    // content-type/accept choices (the dispatch's transport-header loop sets
    // them after the client header copy, so identity values always win).
    transformRequestBody(
      body: Record<string, unknown>,
      context?: ProviderRequestBodyContext,
    ): Record<string, unknown> | null {
      // The shared SaaS wire transform: field whitelist, store=false,
      // stream=true, model normalize + effort lifting, tool-call id
      // normalization. Always returns a fresh object (input never mutated).
      const transformed = applyCodexOAuthTransform(body) as Record<string, unknown>;
      // The upstream rejects an empty instructions field: inject the family
      // base prompt when the client carried none (shared resolver — client
      // instructions win verbatim). Prefer the post-normalization model id.
      const model =
        typeof transformed.model === 'string' && transformed.model !== ''
          ? transformed.model
          : typeof context?.model === 'string'
            ? context.model
            : '';
      transformed.instructions = resolveCodexInstructions(transformed.instructions, model);
      // CS3 fix 1: namespace the body's prompt_cache_key under the selected
      // account too, so the upstream's prompt cache never correlates one
      // client conversation across pooled accounts. The dispatch rides the
      // identity on the context (structural extension — the shared
      // ProviderRequestBodyContext stays untouched); absent or non-string
      // values pass through the whitelist verbatim.
      const identity = (context as (ProviderRequestBodyContext & { codexIdentity?: CodexRequestIdentity }) | undefined)
        ?.codexIdentity;
      if (
        identity !== undefined &&
        typeof transformed.prompt_cache_key === 'string' &&
        transformed.prompt_cache_key !== ''
      ) {
        const namespacedCacheKey = isolateCodexSessionId(identity, transformed.prompt_cache_key);
        if (namespacedCacheKey !== null) transformed.prompt_cache_key = namespacedCacheKey;
      }
      return transformed;
    },
  };
}
