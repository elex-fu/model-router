/**
 * F6 OpenRouter model catalog and model-id normalization (plan §R8a,
 * task #39). Pure functions only — no transports, no pricing sync (that is
 * supply/openrouter-model-pricing-sync-worker.ts).
 *
 * OpenRouter upstream model ids are namespaced `<vendor>/<model>` slugs
 * (e.g. `openai/gpt-4o`, `meta-llama/llama-3.3-70b-instruct`). Unlike the
 * OpenCode Go normalizer (which lowercases, following sub2api), case is
 * preserved here: the catalog ids are the exact strings sent upstream in
 * the request body, and rewriting case could break exact-match routing.
 * Only the `openrouter/` / `openrouter_` namespace prefixes are stripped,
 * so a catalog or client id spelled `openrouter/openai/gpt-4o` and the bare
 * `openai/gpt-4o` collapse onto one provider model.
 */

/**
 * Fallback model-id directory used to seed capability/rights structure
 * before the pricing sync worker has ever run (and by the one-call
 * registration applier for operators/tests). Frozen: callers must not
 * mutate the shared list. The live 200+ model catalog arrives exclusively
 * through the sync worker.
 */
export const OPENROUTER_SEED_MODEL_IDS: readonly string[] = Object.freeze([
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'anthropic/claude-sonnet-4',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat',
]);

/** Namespace prefixes stripped from incoming OpenRouter model ids. */
const OPENROUTER_MODEL_ID_PREFIXES: readonly string[] = Object.freeze(['openrouter/', 'openrouter_']);

/** Same charset contract as the OpenCode Go catalog ids (vendor slugs included). */
const OPENROUTER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const OPENROUTER_MODEL_MAX_ID_LENGTH = 200;

/**
 * Normalizes an OpenRouter model id: trims surrounding whitespace, then
 * strips one occurrence of each known namespace prefix (`openrouter/`,
 * `openrouter_`) in that order. Case is preserved. The result may be empty
 * (input was only a prefix); callers decide how to reject that.
 */
export function normalizeOpenRouterModelId(modelId: string): string {
  let model = modelId.trim();
  for (const prefix of OPENROUTER_MODEL_ID_PREFIXES) {
    if (model.startsWith(prefix)) {
      model = model.slice(prefix.length);
    }
  }
  return model;
}

/**
 * A model id the catalog accepts on capability, rights, alias and pricing
 * rows: non-empty, bounded, printable vendor-slug charset. Model ids that
 * fail this check are dropped by the sync worker before any write.
 */
export function isOpenRouterModelIdValid(model: string): boolean {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= OPENROUTER_MODEL_MAX_ID_LENGTH &&
    OPENROUTER_MODEL_ID_PATTERN.test(model)
  );
}
