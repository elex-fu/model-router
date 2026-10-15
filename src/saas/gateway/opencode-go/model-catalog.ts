/**
 * R5b OpenCode Go model catalog and model-id normalization (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #21).
 *
 * Pure functions only — no transports, no protocol routing (R5b-2), no
 * /v1/models sync (R5b-4). Semantics are lifted verbatim from the sub2api
 * reference implementation (backend/internal/service/opencode_go.go):
 * `DefaultOpenCodeGoModelIDs`, `normalizeOpenCodeGoModelID` and
 * `DefaultOpenCodeGoTestModel`.
 */

/**
 * Fallback model-id directory for the OpenCode Zen/Go subscription gateway:
 * the officially published ids, used when `/v1/models` has not synced yet
 * (R5b-4) and to prefill account model allowlists. Frozen: callers must not
 * mutate the shared list.
 */
export const OPENCODE_GO_FALLBACK_MODEL_IDS: readonly string[] = Object.freeze([
  'grok-4.7',
  'grok-4.6',
  'gpt-5.6-luna',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'longcat-2.0',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'hy4-preview',
  'hy3',
  'omen-alpha',
]);

/**
 * Default admin connection-test model when the UI does not pick one.
 * `glm-5.3` is a Chat Completions catalog id (sub2api
 * `DefaultOpenCodeGoTestModel`).
 */
export const OPENCODE_GO_TEST_MODEL = 'glm-5.3';

/** Namespace prefixes stripped from incoming OpenCode Go model ids. */
const OPENCODE_GO_MODEL_ID_PREFIXES: readonly string[] = Object.freeze(['opencode-go/', 'opencode_go/', 'opencode/']);

/**
 * Normalizes an OpenCode Go model id: trims surrounding whitespace,
 * lowercases, then strips one occurrence of each known namespace prefix
 * (`opencode-go/`, `opencode_go/`, `opencode/`) in that order — exactly the
 * sub2api `normalizeOpenCodeGoModelID` semantics. The result may be empty
 * (input was only a prefix); callers decide how to reject that.
 */
export function normalizeOpenCodeGoModelId(modelId: string): string {
  let model = modelId.trim().toLowerCase();
  for (const prefix of OPENCODE_GO_MODEL_ID_PREFIXES) {
    if (model.startsWith(prefix)) {
      model = model.slice(prefix.length);
    }
  }
  return model;
}
