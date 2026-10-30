/**
 * Provider transport profiles for the classic dispatch layer (plan C3,
 * docs/standalone-relay-capability-plan-2026-10-30.md). Extraction target:
 * the signing/URL/decoding halves of the SaaS Bedrock + Vertex adapters,
 * rebuilt as modules with NO PG/Redis/SaaS dependencies so classic mode can
 * adopt them unchanged.
 *
 * This module defines only the contract the proxy dispatch will consume —
 * no implementations. Wiring into src/server/proxy.ts is a separate change.
 */

import type { Readable } from 'node:stream';

/**
 * The provider-facing subset of a classic upstream configuration. This is a
 * structural interface: the proxy may pass its full `UpstreamConfig` object
 * (or any superset) — only the fields an adapter actually reads are listed
 * here, all optional, so new credential fields land without breaking older
 * configs.
 */
export interface UpstreamProviderSettings {
  /** Static API key material (bearer value / x-api-key / header value). */
  readonly apiKey?: string | null;
  /** Header name for providers whose auth style is a custom header. */
  readonly authHeaderName?: string | null;
  /**
   * GCP service-account key (the JSON text or the parsed object) — the
   * vertex-sa adapter mints OAuth access tokens from it.
   */
  readonly serviceAccountJson?: string | Record<string, unknown> | null;
  /** AWS static credential — the bedrock adapter signs SigV4 with it. */
  readonly awsAccessKeyId?: string | null;
  readonly awsSecretAccessKey?: string | null;
  /** Optional STS session token (adds x-amz-security-token to the signature). */
  readonly awsSessionToken?: string | null;
  /** AWS region for the bedrock invoke URL and signing scope. */
  readonly awsRegion?: string | null;
  /** Vertex location override (defaults to us-central1). */
  readonly vertexLocation?: string | null;
}

/** One outbound request as the dispatch has assembled it pre-auth. */
export interface ProviderAuthRequest {
  readonly method: string;
  /** The absolute request URL — the output of `buildUrl`. */
  readonly url: string;
  /** The serialized request body (empty for bodyless requests). */
  readonly body: Uint8Array;
  /** Header names lowercased; content-type/accept style headers live here. */
  readonly headers: Readonly<Record<string, string>>;
  /** Fixed clock for signing (tests pin it; dispatch passes nothing). */
  readonly nowMs?: number;
}

/** The inputs of `buildUrl`. */
export interface ProviderUrlInput {
  /** Empty string means "use the profile/preset default base". */
  readonly baseUrl: string;
  /**
   * Endpoint convention. Preset profiles use protocol paths
   * (`messages`, `chat/completions`, ...); provider-specific profiles use
   * their own actions (`invoke`, `invoke-with-response-stream`,
   * `rawPredict`, `generateContent`, ...). Adapters document the set they
   * accept and throw on anything else — never guess a path.
   */
  readonly endpoint: string;
  /** The resolved upstream model id, when the URL carries it. */
  readonly model?: string | null;
  /** Streaming intent, when the endpoint set does not already encode it. */
  readonly stream?: boolean;
  /** The upstream settings (region / project / SA material). */
  readonly upstream?: UpstreamProviderSettings;
}

/** Context handed to `transformRequestBody`. */
export interface ProviderRequestBodyContext {
  readonly endpoint?: string;
  readonly model?: string | null;
  readonly stream?: boolean;
}

/**
 * What the classic dispatch layer needs from one upstream provider adapter.
 * Implementations must be free of PG/Redis/SaaS imports; network access is
 * allowed only inside `buildAuth` (token minting) and must be injectable for
 * tests.
 */
export interface ProviderTransportProfile {
  /** Preset/provider id — matches `UpstreamConfig.provider`. */
  readonly id: string;
  /** Default base URL when the upstream configures none. */
  readonly defaultBaseUrl?: string;
  /**
   * Builds the absolute request URL. Pure: no clock, no network.
   */
  buildUrl(input: ProviderUrlInput): string;
  /**
   * Builds the auth headers for one request (and may refresh a cached
   * OAuth token). Returns the headers to SET — with `ownsHeaders` the
   * returned map is the complete outbound header set (see below).
   */
  buildAuth(
    upstream: UpstreamProviderSettings,
    request: ProviderAuthRequest,
  ): Promise<Readonly<Record<string, string>>>;
  /**
   * True when the profile signs its own COMPLETE header set (Bedrock): the
   * signature breaks if any other header rides along, so the dispatch must
   * forward exactly the returned map and nothing else.
   */
  readonly ownsHeaders?: boolean;
  /**
   * Extra body transform for providers whose wire body differs from the
   * protocol default (anthropic_version injection, model-field removal).
   * Returns the new body, or null when nothing changes. Copy-on-write: the
   * input object is never mutated.
   */
  transformRequestBody?(
    body: Record<string, unknown>,
    context?: ProviderRequestBodyContext,
  ): Record<string, unknown> | null;
  /**
   * Response body decoding for providers that answer a binary framing
   * (Bedrock eventstream). Returns a Readable of the decoded protocol bytes
   * so the dispatch's normal streaming path works unchanged.
   */
  decodeResponse?(stream: Readable): Readable;
}
