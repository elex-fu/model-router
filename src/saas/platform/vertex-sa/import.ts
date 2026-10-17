/**
 * Batch-3 Vertex service-account JSON import (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA). The
 * operator pastes a GCP service-account key file; this parser converts it to
 * the sealed-envelope material the credential pipeline stores. The material
 * carries NO access token yet — the first token exchange happens in the
 * token refresher, so an imported credential is dispatchable only after its
 * first refresh cycle (the probe/validation path exercises the exchange).
 */

import { isSafeVertexLocation, VERTEX_TOKEN_URL } from '../../gateway/vertex/constants.js';
import {
  parseVertexServiceAccountJson,
  type VertexServiceAccountKey,
  VertexServiceAccountParseError,
} from './service-account.js';

export class VertexSaImportError extends Error {
  constructor(readonly code: 'MALFORMED_INPUT' | 'MALFORMED_LOCATION') {
    super(code === 'MALFORMED_INPUT' ? 'the service account json is invalid' : 'the location override is invalid');
    this.name = 'VertexSaImportError';
  }
}

export interface VertexSaImport {
  /** The validated service-account key (token_uri already pinned). */
  readonly key: VertexServiceAccountKey;
  /** Optional account-wide default location, when the input carries one. */
  readonly location: string | null;
  /** Optional per-model location overrides, when the input carries them. */
  readonly vertexModelLocations: Readonly<Record<string, string>> | null;
}

export interface VertexSaImportOptions {
  /** Account-wide default location override ('us-central1' when absent). */
  readonly location?: string | null;
  /** Per-model location overrides keyed by model id. */
  readonly vertexModelLocations?: Readonly<Record<string, string>> | null;
}

/**
 * Parses the pasted service-account JSON plus the operator's location
 * options. `type` must be `service_account` when present (a GCE/gcloud
 * user-credential JSON is rejected fail-closed), and every location value
 * must satisfy the aiplatform location pattern.
 */
export function parseVertexServiceAccountImport(text: string, options: VertexSaImportOptions = {}): VertexSaImport {
  let key: VertexServiceAccountKey;
  let parsedType: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    parsedType = (parsed as Record<string, unknown>).type;
    key = parseVertexServiceAccountJson(parsed as Record<string, unknown>);
  } catch (error) {
    if (error instanceof VertexSaImportError) throw error;
    throw new VertexSaImportError('MALFORMED_INPUT');
  }
  if (parsedType !== undefined && parsedType !== 'service_account') {
    throw new VertexSaImportError('MALFORMED_INPUT');
  }
  if (key.tokenUri !== VERTEX_TOKEN_URL) {
    // Unreachable (the parser pins it); kept as a belt-and-braces assertion.
    throw new VertexSaImportError('MALFORMED_INPUT');
  }
  const location = typeof options.location === 'string' ? options.location.trim() : '';
  if (location !== '' && !isSafeVertexLocation(location)) throw new VertexSaImportError('MALFORMED_LOCATION');
  const rawLocations = options.vertexModelLocations;
  if (rawLocations !== null && rawLocations !== undefined) {
    for (const value of Object.values(rawLocations)) {
      if (!isSafeVertexLocation(value)) throw new VertexSaImportError('MALFORMED_LOCATION');
    }
  }
  return {
    key,
    location: location === '' ? null : location,
    vertexModelLocations: rawLocations ?? null,
  };
}
