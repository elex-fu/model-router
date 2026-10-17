import { createHash } from 'node:crypto';

import { sigv4AmzDate, sigv4Signature, sigv4SigningKey, sigv4UriEncode } from '../saas/gateway/bedrock/sigv4.js';

/**
 * Roadmap batch 4 §4.2 (task #16) S3-compatible object-storage client for
 * the async image-result offload. Zero dependencies by design (the roadmap's
 * 决策表: no aws-sdk): undici fetch + the batch-3 handwritten SigV4 pure
 * functions from `saas/gateway/bedrock/sigv4.ts` with service = "s3".
 *
 * Two request shapes are supported, both per the AWS SigV4 spec:
 *
 * - `putObject` — header authorization (the payload SHA-256 is signed via
 *   x-amz-content-sha256, the canonical S3 header-set variant used by
 *   aws-sdk-go-v2). Used for AWS S3, Cloudflare R2, MinIO and other
 *   S3-compatible endpoints.
 * - `presignGetObjectUrl` — query-string authorization
 *   (X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Expires=...
 *   &X-Amz-SignedHeaders=host&X-Amz-Signature=...) with the
 *   `UNSIGNED-PAYLOAD` constant, exactly the presign form every S3 SDK
 *   emits (the AWS S3 developer-guide GET-object example pins the vector in
 *   tests/storage/s3-object-client.test.ts).
 *
 * Addressing: `forcePathStyle` selects `https://endpoint/bucket/key`
 * (MinIO, R2-compatible surfaces, any endpoint whose TLS certificate cannot
 * carry the bucket subdomain); the default virtual-host style selects
 * `https://bucket.endpoint/key`.
 *
 * Secret supply: this client receives the resolved access key and secret —
 * it never persists or logs them. Production compositions inject the
 * resolved config (the egress-proxy credential convention: plaintext never
 * lives in a column; a sealed-settings surface is the recorded follow-up).
 */

/** The S3 SigV4 service segment. */
const SIGV4_S3_SERVICE = 's3';
/** Presigned-URL request bodies are never read. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** Default presign lifetime (sub2api: 24 hours). */
const DEFAULT_PRESIGN_EXPIRY_SECONDS = 24 * 60 * 60;
/** Default per-request ceiling while talking to object storage. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface S3ObjectClientConfig {
  /** Base endpoint URL, e.g. `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Path-style `endpoint/bucket/key` addressing (R2/MinIO-style surfaces). */
  readonly forcePathStyle?: boolean;
  /**
   * Optional public-download base URL (e.g. a CDN origin). When set,
   * `objectUrl` returns the direct public link instead of a presigned URL.
   */
  readonly publicBaseUrl?: string | null;
}

export interface S3ObjectClientOptions {
  /** Fetch implementation (undici's global in production; a fake in tests). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Clock injection for the pinned test vectors. */
  readonly nowMs?: () => number;
  /** Presigned-URL lifetime; default 24 hours. */
  readonly presignExpirySeconds?: number;
  /** Per-request ceiling for the PutObject round trip; default 60 s. */
  readonly requestTimeoutMs?: number;
}

export type S3Fetch = (url: string, init: RequestInit) => Promise<Response>;

function configError(message: string): never {
  throw new Error(`s3 object client: ${message}`);
}

interface ResolvedS3ObjectClientConfig {
  readonly endpoint: string;
  readonly protocol: string;
  readonly host: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly publicBaseUrl: string | null;
}

function validatedConfig(config: S3ObjectClientConfig): ResolvedS3ObjectClientConfig {
  if (!config || typeof config !== 'object') configError('config is required');
  let endpoint: URL;
  try {
    endpoint = new URL(String(config.endpoint));
  } catch {
    configError('endpoint is not a valid URL');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    configError('endpoint must be http(s)');
  }
  const bucket = String(config.bucket ?? '').trim();
  if (bucket === '' || bucket.length > 63 || bucket.includes('/')) configError('bucket is invalid');
  const region = String(config.region ?? '').trim();
  if (region === '' || region.length > 64) configError('region is invalid');
  const accessKeyId = String(config.accessKeyId ?? '').trim();
  if (accessKeyId === '' || accessKeyId.length > 128) configError('accessKeyId is invalid');
  const secretAccessKey = String(config.secretAccessKey ?? '');
  if (secretAccessKey === '' || secretAccessKey.length > 256) configError('secretAccessKey is invalid');
  const publicBaseUrl =
    typeof config.publicBaseUrl === 'string' && config.publicBaseUrl.trim() !== ''
      ? config.publicBaseUrl.trim().replace(/\/+$/, '')
      : null;
  if (publicBaseUrl !== null) {
    try {
      const parsed = new URL(publicBaseUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') configError('publicBaseUrl must be http(s)');
    } catch {
      configError('publicBaseUrl is not a valid URL');
    }
  }
  const endpointBase = endpoint.toString().replace(/\/+$/, '');
  return {
    endpoint: endpointBase,
    protocol: endpoint.protocol,
    host: endpoint.host,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: config.forcePathStyle === true,
    publicBaseUrl,
  };
}

/** Encodes one object key for a URL path: every char except unreserved and '/'. */
function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => sigv4UriEncode(segment))
    .join('/');
}

/**
 * The zero-dependency S3-compatible client. One instance per storage
 * binding; all crypto goes through the shared SigV4 primitives.
 */
export class S3ObjectClient {
  private readonly config: ResolvedS3ObjectClientConfig;
  private readonly fetchImpl: S3Fetch;
  private readonly nowMs: () => number;
  private readonly presignExpirySeconds: number;
  private readonly requestTimeoutMs: number;

  constructor(config: S3ObjectClientConfig, options: S3ObjectClientOptions = {}) {
    this.config = validatedConfig(config);
    this.fetchImpl = options.fetch ?? (((url: string, init: RequestInit) => fetch(url, init)) as unknown as S3Fetch);
    this.nowMs = options.nowMs ?? (() => Date.now());
    const presignExpirySeconds = options.presignExpirySeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    if (!Number.isSafeInteger(presignExpirySeconds) || presignExpirySeconds < 1 || presignExpirySeconds > 604_800) {
      configError('presignExpirySeconds must be an integer in 1..604800');
    }
    this.presignExpirySeconds = presignExpirySeconds;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      configError('requestTimeoutMs must be a positive integer');
    }
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /** The wire path (`/bucket/key` or `/key`). */
  private objectPath(key: string): string {
    if (typeof key !== 'string' || key === '' || key.startsWith('/') || key.includes('?') || key.includes('#')) {
      configError('object key is invalid');
    }
    const encoded = encodeKeyPath(key);
    return this.config.forcePathStyle ? `/${this.config.bucket}/${encoded}` : `/${encoded}`;
  }

  private objectUrl(key: string): { url: string; host: string; path: string } {
    const path = this.objectPath(key);
    if (this.config.forcePathStyle) {
      return { url: `${this.config.endpoint}${path}`, host: this.config.host, path };
    }
    const host = `${this.config.bucket}.${this.config.host}`;
    return { url: `${this.config.protocol}//${host}${path}`, host, path };
  }

  /**
   * PUT one object with a header-signed SigV4 request. The payload SHA-256
   * is signed (`x-amz-content-sha256`) — the standard S3 signature variant,
   * accepted by AWS S3, R2 and MinIO alike.
   */
  async putObject(input: {
    readonly key: string;
    readonly contentType: string;
    readonly data: Uint8Array;
  }): Promise<void> {
    if (!input || typeof input !== 'object') configError('putObject input is required');
    const contentType = String(input.contentType ?? '').trim();
    if (!/^image\/[a-z0-9.+-]{2,32}$/.test(contentType)) configError('contentType must be an image media type');
    if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) configError('data must be non-empty bytes');
    const { url, host, path } = this.objectUrl(input.key);
    const payloadHash = createHash('sha256').update(input.data).digest('hex');
    const amzDate = sigv4AmzDate(this.nowMs());
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host,
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name]?.trim() ?? ''}\n`).join('');
    const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
    const scope = `${dateStamp}/${this.config.region}/${SIGV4_S3_SERVICE}/aws4_request`;
    const canonicalHash = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalHash].join('\n');
    const key = sigv4SigningKey(this.config.secretAccessKey, dateStamp, this.config.region, SIGV4_S3_SERVICE);
    const signature = sigv4Signature(key, stringToSign);
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: { ...headers, authorization },
      body: Buffer.from(input.data) as unknown as BodyInit,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        // The status is the durable fact.
      }
      throw new Error(`S3 PutObject failed with status ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    try {
      await response.body?.cancel();
    } catch {
      // The status is already classified.
    }
  }

  /**
   * Returns a client-downloadable URL for one object: the direct public
   * link when `publicBaseUrl` is configured, otherwise a 24-hour presigned
   * GET (query-string SigV4, UNSIGNED-PAYLOAD).
   */
  objectUrlForDownload(key: string, presignExpirySeconds?: number): string {
    if (this.config.publicBaseUrl !== null) {
      return `${this.config.publicBaseUrl}/${encodeKeyPath(key)}`;
    }
    return this.presignGetObjectUrl(key, presignExpirySeconds);
  }

  /**
   * Builds a query-string-authorized GET URL without touching the network
   * (the AWS S3 developer-guide GET-object example pins this construction in
   * tests/storage/s3-object-client.test.ts).
   */
  presignGetObjectUrl(key: string, expiresSeconds?: number): string {
    const { url, host, path } = this.objectUrl(key);
    const expires = expiresSeconds ?? this.presignExpirySeconds;
    if (!Number.isSafeInteger(expires) || expires < 1 || expires > 604_800) {
      configError('presign expiry must be an integer in 1..604800');
    }
    const amzDate = sigv4AmzDate(this.nowMs());
    const dateStamp = amzDate.slice(0, 8);
    const credential = `${this.config.accessKeyId}/${dateStamp}/${this.config.region}/${SIGV4_S3_SERVICE}/aws4_request`;
    const query: ReadonlyArray<readonly [string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', credential],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expires)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    const canonicalQuery = query
      .slice()
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${sigv4UriEncode(name)}=${sigv4UriEncode(value)}`)
      .join('&');
    const canonicalRequest = ['GET', path, canonicalQuery, `host:${host}\n`, 'host', UNSIGNED_PAYLOAD].join('\n');
    const scope = `${dateStamp}/${this.config.region}/${SIGV4_S3_SERVICE}/aws4_request`;
    const canonicalHash = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalHash].join('\n');
    const signingKey = sigv4SigningKey(this.config.secretAccessKey, dateStamp, this.config.region, SIGV4_S3_SERVICE);
    const signature = sigv4Signature(signingKey, stringToSign);
    return `${url}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}
