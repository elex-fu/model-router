/**
 * A deliberately high local admission estimate, not a provider token count.
 * JSON framing is included. ASCII is budgeted at one token per character;
 * multibyte text is budgeted at least one token per two UTF-8 bytes.
 * Unknown output limits reserve 1024 tokens per attempt.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 1024;

export function estimateQuotaAttemptReserve(body: Buffer, parsedBody: unknown, override?: number): number {
  if (override !== undefined) return override;
  let characters = 0;
  for (const _character of body.toString('utf8')) characters++;
  const input = Math.max(characters, Math.ceil(body.byteLength / 2));
  const request =
    parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
      ? (parsedBody as Record<string, unknown>)
      : {};
  const limits = [request.max_tokens, request.max_output_tokens, request.max_completion_tokens].filter(
    (value): value is number => Number.isSafeInteger(value) && Number(value) > 0,
  );
  const output = limits.length ? Math.max(...limits) : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return Math.min(Number.MAX_SAFE_INTEGER, input + output);
}
