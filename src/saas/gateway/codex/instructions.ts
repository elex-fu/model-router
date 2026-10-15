/**
 * P1c Codex instructions asset (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.4/1.5). The ChatGPT
 * codex backend rejects a request whose `instructions` field is empty, so the
 * gateway injects a fallback instruction whenever the compiled outbound body
 * carries none.
 *
 * The constant below mirrors `instructions/fallback.txt`. It is intentionally
 * a minimal generic instruction, not the Codex CLI's full system prompt: the
 * full per-family assets and their update workflow are described in
 * `instructions/README.md` (TODO: codex-version-sync asset updates).
 */
export const CODEX_FALLBACK_INSTRUCTIONS_VERSION = 'codex-instructions-fallback/v1';

export const CODEX_FALLBACK_INSTRUCTIONS = [
  'You are a helpful software engineering assistant working inside a',
  'terminal-based coding tool. Answer concisely, prefer runnable code over prose,',
  'and ask for clarification only when the request is genuinely ambiguous.',
].join('\n');

/**
 * Resolves the outbound instructions for one request: client-provided
 * instructions always win; otherwise the fallback is injected so the upstream
 * never sees an empty field. Returns `null` only for non-string input, which
 * the caller treats as "inject the fallback" as well.
 */
export function resolveCodexInstructions(clientInstructions: unknown): string {
  if (typeof clientInstructions === 'string' && clientInstructions.trim().length > 0) {
    return clientInstructions;
  }
  return CODEX_FALLBACK_INSTRUCTIONS;
}
