/**
 * R2 §7.2 `GET /v1beta/models` response shaping.
 *
 * The list is the CURRENT caller's key permissions ∩ assembled capabilities
 * (§6.3): the boundary passes the scope-validated discovered models (the
 * same `validatedDiscoveredModels` cross-check the OpenAI-compatible
 * `GET /v1/models` uses) and this module renders them in the native Gemini
 * ListModels envelope. The raw provider list is never exposed.
 */

export interface GeminiListModel {
  readonly name: string;
  readonly displayName: string;
}

/** Render the caller-scoped model ids as a Gemini ListModels response body. */
export function geminiModelListResponseBody(models: readonly string[]): { models: GeminiListModel[] } {
  return {
    models: models.map((id) => ({
      // Native Gemini identifies models as `models/{id}` resources.
      name: `models/${id}`,
      displayName: id,
    })),
  };
}
