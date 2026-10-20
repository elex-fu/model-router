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
 * today. Claude/Gemini OAuth sinks are not mounted yet; they must add their
 * builders here (and a matching validation adapter) before they can claim
 * onboarding coverage.
 */

import { buildCanonicalIdentity } from '../gateway/codex/identity.js';
import { CODEX_FALLBACK_INSTRUCTIONS } from '../gateway/codex/instructions.js';
import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import { GROK_OAUTH_DEFAULT_BASE_URL, grokCliIdentityHeaders } from '../gateway/grok/constants.js';

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
