/**
 * Shared OAuth account probes for the CLI subscription categories.
 *
 * Two callers need the exact same upstream request shape:
 * - the R6a account-probe service (scheduled/admin liveness probes);
 * - the credential-validation worker's onboarding probe (T02), which must
 *   prove a freshly imported OAuth credential before the account becomes
 *   schedulable.
 *
 * Keeping the builders here prevents the validation request from drifting
 * away from the probe request (the account probe has the same "reuse the
 * gateway's exact masquerade" discipline). The builders are pure: they only
 * take unsealed OAuth material in memory and return a request description.
 * No token, account id or response content is logged or persisted here.
 *
 * Codex and Grok are the OAuth categories with production supply sinks
 * today. Claude and Gemini sinks are still not mounted in the standard
 * deployment (mounting remains the precondition for onboarding), but their
 * request/response surface lives here already: the validation adapters and
 * the account probe share the exact same builders and text extractors, so
 * the sinks become onboarding-ready the moment they land.
 */

import { CLAUDE_MESSAGES_ENDPOINT } from '../gateway/claude/catalog-identity.js';
import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_CLIENT_IDENTITY_HEADERS,
  CLAUDE_CODE_MIMICRY_BETA_HEADER,
  CLAUDE_STAINLESS_HEADERS,
} from '../gateway/claude/constants.js';
import { buildClaudeUserAgent, resolveClaudeCliVersionFromEnv } from '../gateway/claude/identity.js';
import { applyClaudeOAuthTransform } from '../gateway/claude/transform.js';
import { claudeMetadataUserId } from '../gateway/claude/transport.js';
import { buildCanonicalIdentity } from '../gateway/codex/identity.js';
import { CODEX_FALLBACK_INSTRUCTIONS } from '../gateway/codex/instructions.js';
import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import { GEMINI_CLI_BASE_URL } from '../gateway/gemini/catalog-identity.js';
import { GEMINI_CLI_USER_AGENT } from '../gateway/gemini/constants.js';
import { applyGeminiCodeAssistTransform } from '../gateway/gemini/transform.js';
import { GROK_OAUTH_DEFAULT_BASE_URL, grokCliIdentityHeaders } from '../gateway/grok/constants.js';

/** Stable proxy-key id baked into the per-account claude metadata user id. */
const PROBE_PROXY_KEY_ID = 'probe';

export interface OAuthProbeRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CodexOAuthProbeInput {
  readonly accessToken: string;
  readonly chatgptAccountId: string | null;
  readonly model: string;
  readonly challengePrompt: string;
}

/**
 * Canonical Codex CLI `/responses` probe. The identity headers, beta header,
 * fallback instructions and request envelope are byte-for-byte the shape the
 * account probe has used since R6a; the only variable is the job's model.
 */
export function buildCodexOAuthProbeRequest(input: CodexOAuthProbeInput): OAuthProbeRequest {
  const identity = buildCanonicalIdentity();
  return {
    url: CODEX_RESPONSES_ENDPOINT,
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.chatgptAccountId === null ? {} : { 'chatgpt-account-id': input.chatgptAccountId }),
      'user-agent': identity.userAgent,
      originator: identity.originator,
      version: identity.version,
      'openai-beta': 'responses=experimental',
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      instructions: CODEX_FALLBACK_INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: input.challengePrompt }] }],
      max_output_tokens: 16,
      stream: false,
      store: false,
    }),
  };
}

export interface GrokOAuthProbeInput {
  readonly accessToken: string;
  readonly model: string;
  readonly challengePrompt: string;
}

/**
 * Canonical Grok CLI chat-proxy `/responses` probe. The pinned CLI identity
 * headers are the same masquerade the forwarding transport stamps; a probe
 * that omits them would be rejected by the CLI proxy and would not prove the
 * subscription credential's real dispatch path.
 */
export function buildGrokOAuthProbeRequest(input: GrokOAuthProbeInput): OAuthProbeRequest {
  return {
    url: `${GROK_OAUTH_DEFAULT_BASE_URL}/responses`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...grokCliIdentityHeaders(),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: input.challengePrompt }] }],
      max_output_tokens: 16,
      stream: false,
      store: false,
    }),
  };
}

export interface ClaudeOAuthProbeInput {
  readonly accessToken: string;
  readonly accountUuid: string | null;
  readonly model: string;
  readonly challengePrompt: string;
}

/**
 * Canonical Claude Code subscription `/v1/messages` probe: the full-mimicry
 * request the R6a account probe sends. The OAuth body transform (CLI system
 * rewrite, billing attribution, per-account metadata user id), the beta
 * header set, the CLI user-agent and the stainless/client-identity headers
 * are reused READ-ONLY from src/saas/gateway/claude/** so the probe is
 * indistinguishable from a real dispatch at the protocol layer. The CLI
 * version is resolved at construction time, exactly like the account probe.
 */
export function buildClaudeOAuthProbeRequest(input: ClaudeOAuthProbeInput): OAuthProbeRequest {
  const cliVersion = resolveClaudeCliVersionFromEnv();
  const body = applyClaudeOAuthTransform(
    {
      model: input.model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: input.challengePrompt }],
    },
    {
      cliVersion,
      metadataUserId: input.accountUuid === null ? null : claudeMetadataUserId(PROBE_PROXY_KEY_ID, input.accountUuid),
    },
  );
  return {
    url: `${CLAUDE_MESSAGES_ENDPOINT}?beta=true`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_CODE_MIMICRY_BETA_HEADER,
      'user-agent': buildClaudeUserAgent(cliVersion),
      accept: 'application/json',
      'content-type': 'application/json',
      ...CLAUDE_STAINLESS_HEADERS,
      ...CLAUDE_CLIENT_IDENTITY_HEADERS,
    },
    body: JSON.stringify(body),
  };
}

export interface GeminiOAuthProbeInput {
  readonly accessToken: string;
  readonly projectId: string;
  readonly model: string;
  readonly challengePrompt: string;
}

/**
 * Canonical Gemini CLI (Cloud Code Assist) `v1internal:generateContent`
 * probe: the pinned CLI user agent and the `{model, project, request}`
 * dispatch wrap are reused READ-ONLY from src/saas/gateway/gemini/** — the
 * same masquerade the forwarding transport stamps. A bare bearer call to
 * the endpoint would not prove the subscription credential's dispatch path.
 */
export function buildGeminiOAuthProbeRequest(input: GeminiOAuthProbeInput): OAuthProbeRequest {
  const { body } = applyGeminiCodeAssistTransform(
    {
      model: input.model,
      contents: [{ role: 'user', parts: [{ text: input.challengePrompt }] }],
      generationConfig: { maxOutputTokens: 512 },
    },
    { projectId: input.projectId },
  );
  return {
    url: `${GEMINI_CLI_BASE_URL}/v1internal:generateContent`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': GEMINI_CLI_USER_AGENT,
    },
    body: JSON.stringify(body),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** First `output_text` block of a Responses envelope; null for any other shape. */
export function firstResponsesText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.output)) return null;
  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (isRecord(block) && block.type === 'output_text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return null;
}

/** First `text` block of an Anthropic Messages envelope; null for any other shape. */
export function firstAnthropicText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.content)) return null;
  for (const block of body.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

/** Gemini native text: candidates[0].content.parts[].text (unwrapped when wrapped). */
export function firstGeminiText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const inner = isRecord(body.response) ? (body.response as Record<string, unknown>) : body;
  if (!isRecord(inner) || !Array.isArray(inner.candidates) || !isRecord(inner.candidates[0])) return null;
  const content = (inner.candidates[0] as Record<string, unknown>).content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return null;
  for (const part of content.parts) {
    if (isRecord(part) && typeof part.text === 'string' && part.text.trim() !== '') return part.text;
  }
  return null;
}

/**
 * The probe contract: the model must answer with digits only, exactly equal
 * to the challenge. A wrong or non-numeric answer is a protocol failure, never
 * a success (mirrors the R6a account-probe contract).
 */
export function challengeMatches(
  answer: string,
  extracted: string | null,
): 'ok' | 'non_numeric' | 'mismatch' | 'missing' {
  if (extracted === null || extracted.trim() === '') return 'missing';
  const trimmed = extracted.trim();
  if (!/^[0-9]+$/.test(trimmed)) return 'non_numeric';
  return trimmed === answer ? 'ok' : 'mismatch';
}

/** Prompt used by the validation worker's one-shot OAuth onboarding probe. */
export function oauthValidationChallengePrompt(challenge: string): string {
  return `Reply with exactly the six-digit number ${challenge}. Do not include any other text.`;
}
