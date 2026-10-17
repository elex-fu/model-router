/**
 * Batch-3 Vertex service-account key parsing (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; port of
 * sub2api's parseVertexServiceAccountJSON / parseVertexServiceAccountKey
 * from backend/internal/service/vertex_service_account.go). Pure parsing and
 * validation: the operator supplies a GCP service-account JSON key file (or
 * its nested object form); this module extracts exactly the four fields the
 * JWT-bearer exchange needs and NEVER trusts the file's token_uri — the
 * pinned Google endpoint (constants VERTEX_TOKEN_URL) overrides it so a
 * crafted token_uri can never steer the exchange at an attacker host (the
 * sub2api SSRF guard).
 */

import { VERTEX_TOKEN_URL } from '../../gateway/vertex/constants.js';

/** The service-account facts the JWT-bearer exchange needs. */
export interface VertexServiceAccountKey {
  /** `client_email` — the JWT `iss` claim. */
  readonly clientEmail: string;
  /** `private_key` — the PEM RSA private key the assertion is signed with. */
  readonly privateKey: string;
  /** `private_key_id` — the JWT header `kid`, when the file carries one. */
  readonly privateKeyId: string | null;
  /** `project_id` — the GCP project the aiplatform URLs interpolate. */
  readonly projectId: string;
  /**
   * ALWAYS the pinned https://oauth2.googleapis.com/token — the file's
   * `token_uri` is parsed only to be overridden (SSRF guard).
   */
  readonly tokenUri: string;
}

export type VertexServiceAccountParseErrorCode =
  | 'MALFORMED_JSON'
  | 'MISSING_CLIENT_EMAIL'
  | 'MISSING_PRIVATE_KEY'
  | 'MISSING_PROJECT_ID'
  | 'MALFORMED_NESTED_OBJECT';

export class VertexServiceAccountParseError extends Error {
  constructor(readonly code: VertexServiceAccountParseErrorCode) {
    super(`vertex service account json is invalid: ${code}`);
    this.name = 'VertexServiceAccountParseError';
  }
}

const MAX_SERVICE_ACCOUNT_JSON_BYTES = 32_768;
const MAX_FIELD_BYTES = 4_096;

function fieldText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_FIELD_BYTES) return null;
  return trimmed;
}

/**
 * Validates a parsed service-account JSON object into the exchange key.
 * `token_uri` is forced to the pinned Google endpoint regardless of what
 * the file carries; an explicit non-Google token_uri is still accepted
 * (parsed and overridden) so operator key files never need editing — the
 * exchange never dials anything but the pinned endpoint.
 */
export function parseVertexServiceAccountObject(raw: Record<string, unknown>): VertexServiceAccountKey {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VertexServiceAccountParseError('MALFORMED_NESTED_OBJECT');
  }
  const clientEmail = fieldText(raw.client_email);
  if (clientEmail === null) throw new VertexServiceAccountParseError('MISSING_CLIENT_EMAIL');
  const privateKey = fieldText(raw.private_key);
  if (privateKey === null) throw new VertexServiceAccountParseError('MISSING_PRIVATE_KEY');
  const projectId = fieldText(raw.project_id);
  if (projectId === null) throw new VertexServiceAccountParseError('MISSING_PROJECT_ID');
  const privateKeyId = fieldText(raw.private_key_id);
  return {
    clientEmail,
    privateKey,
    privateKeyId,
    projectId,
    tokenUri: VERTEX_TOKEN_URL,
  };
}

/**
 * Parses a service-account JSON key file (text form). The nested-object
 * form (the credentials map carrying `service_account_json` as an object
 * rather than a string) is accepted too — sub2api parity.
 */
export function parseVertexServiceAccountJson(raw: string | Record<string, unknown>): VertexServiceAccountKey {
  if (typeof raw === 'string') {
    if (raw.trim() === '' || raw.length > MAX_SERVICE_ACCOUNT_JSON_BYTES) {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    return parseVertexServiceAccountObject(parsed as Record<string, unknown>);
  }
  return parseVertexServiceAccountObject(raw);
}

/**
 * Extracts the service-account key from a sealed-envelope material object
 * (the JSON the credential envelope decrypts to). Accepts both the string
 * form (`service_account_json` / `service_account`) and the nested object
 * form, mirroring sub2api's parseVertexServiceAccountKey precedence.
 */
export function vertexServiceAccountKeyFromEnvelopeMaterial(
  material: Record<string, unknown>,
): VertexServiceAccountKey {
  if (material === null || typeof material !== 'object' || Array.isArray(material)) {
    throw new VertexServiceAccountParseError('MALFORMED_NESTED_OBJECT');
  }
  for (const field of ['service_account_json', 'service_account'] as const) {
    const raw = material[field];
    if (typeof raw === 'string' && raw.trim() !== '') return parseVertexServiceAccountJson(raw);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return parseVertexServiceAccountObject(raw as Record<string, unknown>);
    }
  }
  // Envelope flat form: the four fields ride the material directly.
  if (
    typeof material.client_email === 'string' &&
    typeof material.private_key === 'string' &&
    typeof material.project_id === 'string'
  ) {
    return parseVertexServiceAccountObject(material);
  }
  throw new VertexServiceAccountParseError('MISSING_CLIENT_EMAIL');
}

/**
 * Builds the sealed-envelope plaintext material for a service-account
 * credential. The SA key fields ride flat (the transport's credential
 * resolver reads project_id / location / vertex_model_locations from the
 * same material); an exchanged access token and its expiry are merged in by
 * the token refresher's rotations.
 */
export function buildVertexSaEnvelopeMaterial(
  key: VertexServiceAccountKey,
  options: {
    readonly location?: string | null;
    readonly vertexModelLocations?: Readonly<Record<string, string>> | null;
    readonly accessToken?: string | null;
    readonly expiresAtMs?: number | null;
  } = {},
): Record<string, unknown> {
  const material: Record<string, unknown> = {
    type: 'service_account',
    client_email: key.clientEmail,
    private_key: key.privateKey,
    project_id: key.projectId,
    token_uri: VERTEX_TOKEN_URL,
  };
  if (key.privateKeyId !== null) material.private_key_id = key.privateKeyId;
  if (typeof options.location === 'string' && options.location.trim() !== '') {
    material.location = options.location.trim();
  }
  if (options.vertexModelLocations !== null && options.vertexModelLocations !== undefined) {
    material.vertex_model_locations = options.vertexModelLocations;
  }
  if (typeof options.accessToken === 'string' && options.accessToken !== '') {
    material.access_token = options.accessToken;
    if (typeof options.expiresAtMs === 'number' && Number.isFinite(options.expiresAtMs)) {
      material.expires_at = new Date(options.expiresAtMs).toISOString();
    }
  }
  return material;
}

/**
 * Reads the transport-facing credential view out of a sealed-envelope
 * material object: the access token (when the refresher has exchanged one)
 * plus the project/location facts. Returns null when the material carries
 * no usable access token yet (the caller routes through the token
 * refresher before dispatch).
 */
export function vertexUpstreamCredentialFromMaterial(material: Record<string, unknown>): {
  readonly accessToken: string;
  readonly projectId: string;
  readonly location: string | null;
  readonly vertexModelLocations: Readonly<Record<string, string>> | null;
  readonly expiresAtMs: number | null;
} | null {
  if (material === null || typeof material !== 'object' || Array.isArray(material)) return null;
  const accessToken = typeof material.access_token === 'string' ? material.access_token : '';
  if (accessToken === '') return null;
  const projectId = typeof material.project_id === 'string' ? material.project_id.trim() : '';
  if (projectId === '') return null;
  const location = typeof material.location === 'string' && material.location.trim() !== '' ? material.location : null;
  const rawLocations = material.vertex_model_locations;
  const vertexModelLocations =
    rawLocations !== null && typeof rawLocations === 'object' && !Array.isArray(rawLocations)
      ? (rawLocations as Record<string, string>)
      : null;
  const expiresAt = typeof material.expires_at === 'string' ? Date.parse(material.expires_at) : Number.NaN;
  return {
    accessToken,
    projectId,
    location,
    vertexModelLocations,
    expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}
