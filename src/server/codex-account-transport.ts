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
 * - `src/saas/gateway/codex/identity.ts` (buildCanonicalIdentity)
 * - `src/saas/gateway/codex/transform.ts` (applyCodexOAuthTransform)
 * - `src/saas/gateway/codex/instructions.ts` (resolveCodexInstructions)
 *
 * Account selection itself lives in the dispatch wiring (proxy.ts) via the
 * codex account pool, so the chosen account rides the structural
 * `UpstreamProviderSettings.codexAccount` field into `buildAuth`; this keeps
 * the profile stateless and lets the dispatch feed attempt outcomes back to
 * the pool (markSuccess/markFailure) for cooldown scheduling.
 */

import { buildCanonicalIdentity } from '../saas/gateway/codex/identity.js';
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
  resolveAccessToken(provider: string, accountId?: string): Promise<string>;
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
 * every per-request input — account id, token, chatgpt-account-id — rides
 * `upstream.codexAccount` in the provider settings.
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
      _request: ProviderAuthRequest,
    ): Promise<Readonly<Record<string, string>>> {
      const account = upstream.codexAccount;
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
      if (typeof account.chatgptAccountId === 'string' && account.chatgptAccountId !== '') {
        headers['chatgpt-account-id'] = account.chatgptAccountId;
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
      return transformed;
    },
  };
}
