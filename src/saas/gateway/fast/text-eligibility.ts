/** Deliberately narrow text contract. Unknown vendor extensions may change cost
 * ceilings (for example best_of or extra_body), so they belong to strict mode.
 * Apply to BOTH client input and final compiler output, before any reservation.
 */
const TEXT_KEYS = new Set([
  'model',
  'messages',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'stream_options',
  'n',
  'service_tier',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'seed',
  'stop',
  'user',
  'metadata',
  'store',
  'response_format',
]);
const MESSAGE_KEYS = new Set(['role', 'content', 'name']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant']);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function fastTextRequestUnsupported(
  body: Record<string, unknown>,
  options: { readonly allowMissingOutputBound?: boolean } = {},
): string | null {
  if (Object.keys(body).some((key) => !TEXT_KEYS.has(key))) return 'unbounded_request_field';
  if (typeof body.model !== 'string' || !Array.isArray(body.messages)) return 'request_shape';
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return 'request_shape';
  if (body.n !== undefined && body.n !== 1) return 'multiple_choices';
  if (body.service_tier !== undefined && body.service_tier !== 'default') return 'service_tier';
  const outputBounds = [body.max_tokens, body.max_completion_tokens].filter((value) => value !== undefined);
  if (
    (!outputBounds.length && !options.allowMissingOutputBound) ||
    outputBounds.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
  )
    return 'output_bound';
  if (
    body.messages.some(
      (message) =>
        !record(message) ||
        Object.keys(message).some((key) => !MESSAGE_KEYS.has(key)) ||
        typeof message.role !== 'string' ||
        !ROLES.has(message.role) ||
        (typeof message.content !== 'string' && message.content !== null) ||
        (message.name !== undefined && typeof message.name !== 'string'),
    )
  )
    return 'non_text_content';
  if (
    body.stream_options !== undefined &&
    (!record(body.stream_options) ||
      Object.entries(body.stream_options).some(
        ([key, value]) => !['include_usage', 'include_obfuscation'].includes(key) || typeof value !== 'boolean',
      ))
  )
    return 'stream_options';
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (
      !record(format) ||
      !['text', 'json_object', 'json_schema'].includes(String(format.type)) ||
      Object.keys(format).some((key) => !['type', 'json_schema'].includes(key))
    )
      return 'response_format';
    if (format.type !== 'json_schema') {
      if (format.json_schema !== undefined) return 'response_format';
    } else {
      const schema = format.json_schema;
      if (
        !record(schema) ||
        typeof schema.name !== 'string' ||
        !record(schema.schema) ||
        Object.keys(schema).some((key) => !['name', 'schema', 'strict', 'description'].includes(key)) ||
        (schema.strict !== undefined && typeof schema.strict !== 'boolean') ||
        (schema.description !== undefined && typeof schema.description !== 'string')
      )
        return 'response_format';
    }
  }
  return null;
}
