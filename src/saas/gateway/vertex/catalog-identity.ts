/**
 * Batch-3 Vertex AI service-account catalog identity (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; port of
 * sub2api's backend/internal/service/vertex_service_account.go identity
 * constants). Single source of truth for the Google Vertex AI
 * service-account provider identity shared by the credential sink
 * (platform/vertex-sa/supply-sink.ts), the SA token refresher
 * (platform/vertex-sa/token-service.ts), the catalog registration
 * (catalog/vertex-registration.ts) and the gateway dispatch split. Mirrors
 * the gemini package's catalog-identity contract.
 */

export const VERTEX_PROVIDER_ID = 'google-vertex';
export const VERTEX_PRODUCT_ID = 'vertex-ai';
export const VERTEX_CREDENTIAL_TYPE = 'service_account';
export const VERTEX_SUPPLY_MODE = 'platform' as const;
export const VERTEX_REGION = 'global';
export const VERTEX_PURPOSE = 'inference';
export const VERTEX_DISPLAY_NAME = 'Google Vertex AI (service account)';

/**
 * Catalog endpoint scope; also the gateway dispatch split key for ALL Vertex
 * traffic. The single scope covers the category's dual upstream endpoint
 * families — Anthropic on Vertex (`rawPredict` / `streamRawPredict`, provider
 * protocol `anthropic`) and Gemini on Vertex (`generateContent` /
 * `streamGenerateContent?alt=sse`, provider protocol `gemini`) — because both
 * dial the same `{location}-aiplatform.googleapis.com` surface under one
 * service-account credential. The transport selects the endpoint family from
 * the signed provider protocol on the prepared evidence, never from the
 * client request.
 */
export const VERTEX_ENDPOINT = 'vertex-raw-predict';

/** The two provider protocols the Vertex category serves, both under VERTEX_ENDPOINT. */
export const VERTEX_ANTHROPIC_PROTOCOL = 'anthropic' as const;
export const VERTEX_GEMINI_PROTOCOL = 'gemini' as const;

/**
 * Placeholder Anthropic-on-Vertex model set for the MVP catalog: the dated
 * spellings clients send are normalized onto the `@`-dated Vertex model ids
 * by transform.ts (claude-x-20260101 → claude-x@20260101).
 */
export const VERTEX_ANTHROPIC_MODELS: readonly string[] = Object.freeze([
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);

/** Placeholder Gemini-on-Vertex model set (the F4 gemini model-table ids). */
export const VERTEX_GEMINI_MODELS: readonly string[] = Object.freeze(['gemini-2.5-pro', 'gemini-2.5-flash']);

/** The combined placeholder catalog (Anthropic protocol + Gemini protocol models). */
export const VERTEX_PLACEHOLDER_MODELS: readonly string[] = Object.freeze([
  ...VERTEX_ANTHROPIC_MODELS,
  ...VERTEX_GEMINI_MODELS,
]);

/**
 * Vertex account coordinates carried inside the sealed credential envelope
 * (subset): the project id is load-bearing for every endpoint URL and the
 * per-model location map routes models onto regional endpoints.
 */
export interface VertexAccountCoordinates {
  /** The GCP project the aiplatform URLs interpolate. */
  readonly projectId: string;
  /** Optional per-model location overrides (envelope `vertex_model_locations`). */
  readonly vertexModelLocations?: Readonly<Record<string, string>> | null;
  /** Optional account-wide default location (envelope `location`/`vertex_location`). */
  readonly location?: string | null;
}

/** The unsealed Vertex service-account facts the transport needs (envelope subset). */
export interface VertexUpstreamCredential extends VertexAccountCoordinates {
  /** The OAuth access token obtained by the SA JWT-bearer exchange. */
  readonly accessToken: string;
}

/**
 * Per-account identity namespace `vertex:project:{projectId}`. Empty
 * coordinates throw: an account without a project must never silently share
 * a namespace with another account (the gemini identity-kernel contract).
 */
export function vertexAccountIdentityNamespace(account: VertexAccountCoordinates): string {
  if (typeof account?.projectId !== 'string' || account.projectId.trim().length === 0) {
    throw new Error('vertex account coordinates are malformed');
  }
  return `vertex:project:${account.projectId.trim()}`;
}
