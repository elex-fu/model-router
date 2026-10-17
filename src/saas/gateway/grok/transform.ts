/**
 * Batch-3 Grok request transformation (pure). The grok category serves the
 * native OpenAI wire shapes (Responses on the endpoint scope, Chat
 * Completions through the transport's per-request path selection), so the
 * transform is model-id normalization only: the namespaced `grok/<model>`
 * public alias is stripped and the alias table (`grok`, `grok-latest`,
 * `-latest` suffixes) is applied, mirroring sub2api's xai/models.go alias
 * map onto this codebase's copy-on-write conventions.
 */

export const GROK_MAX_MODEL_ID_LENGTH = 128;

/** Client alias → catalog model overrides (sub2api xai/models.go text alias map). */
export const GROK_MODEL_ID_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  grok: 'grok-4.6',
  'grok-latest': 'grok-4.6',
});

export type GrokTransformErrorCode = 'MALFORMED_MODEL';

export class GrokTransformError extends Error {
  constructor(readonly code: GrokTransformErrorCode) {
    super('grok model id is malformed');
    this.name = 'GrokTransformError';
  }
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Whether a model id is safe to interpolate into an upstream path segment. */
export function isSafeGrokModelId(model: string): boolean {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= GROK_MAX_MODEL_ID_LENGTH &&
    MODEL_ID_PATTERN.test(model)
  );
}

/**
 * Maps a client-visible model alias onto the catalog id the upstream accepts:
 * the namespaced `grok/<model>` public alias is stripped, the alias table is
 * applied, and a trailing `-latest` folds onto the family base.
 */
export function normalizeGrokModelId(model: string): string {
  if (typeof model !== 'string' || model.length === 0) return model;
  let stripped = model.startsWith('grok/') ? model.slice('grok/'.length) : model;
  const override = GROK_MODEL_ID_OVERRIDES[stripped];
  if (override !== undefined) return override;
  if (stripped.endsWith('-latest')) {
    stripped = stripped.slice(0, -'-latest'.length);
    const family = GROK_MODEL_ID_OVERRIDES[stripped];
    return family !== undefined && family !== stripped ? family : stripped;
  }
  return stripped;
}

/** Strips/normalizes the model id inside an OpenAI-shaped request body (copy-on-write). */
export function applyGrokModelNormalization(body: Record<string, unknown>): Record<string, unknown> {
  const rawModel = body.model;
  if (typeof rawModel !== 'string' || rawModel.length === 0) return body;
  const normalized = normalizeGrokModelId(rawModel);
  if (normalized === rawModel) return body;
  return { ...body, model: normalized };
}
