import { createHash, createHmac } from 'node:crypto';

/**
 * Batch-3 handwritten AWS Signature Version 4 signer (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Bedrock 核验修正 1).
 * Sub2api signs through aws-sdk-go-v2's v4.Signer; this repo's
 * zero-dependency discipline requires the algorithm as pure functions over
 * node:crypto (no `@smithy/signature-v4`), verified against the official
 * AWS SigV4 test-suite vectors (tests/saas/gateway/bedrock/sigv4.test.ts).
 *
 * Canonical request (AWS General Reference "Signature Version 4"):
 *
 *     CanonicalRequest =
 *       HTTPRequestMethod \n
 *       CanonicalURI \n
 *       CanonicalQueryString \n
 *       CanonicalHeaders \n
 *       SignedHeaders \n
 *       HexEncode(SHA256(RequestPayload))
 *
 * StringToSign = "AWS4-HMAC-SHA256" \n AmzDate \n CredentialScope \n
 *                HexEncode(SHA256(CanonicalRequest))
 * SigningKey  = HMAC(HMAC(HMAC(HMAC("AWS4"+Secret, Date), Region), Service),
 *                    "aws4_request")
 *
 * Bedrock-specific constraints (the litellm lesson from sub2api's
 * bedrock_signer.go comment): the request must carry ONLY the
 * Content-Type/Accept headers when it reaches the signer — every additional
 * non-AWS header that participates in the signature must also be forwarded
 * verbatim by Bedrock's front end or signature verification fails. This
 * module therefore signs exactly the fixed header set it assembles itself:
 * accept, content-type, host, x-amz-content-sha256, x-amz-date (plus
 * x-amz-security-token when the credential carries a session token). The
 * caller never passes arbitrary headers into the signature.
 */

/** The fixed Bedrock service string. */
export const SIGV4_BEDROCK_SERVICE = 'bedrock';

/** The terminal signing-key scope segment. */
const SIGV4_TERMINATOR = 'aws4_request';

/** The algorithm prefix (also the Authorization scheme). */
const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** The unreserved characters SigV4 percent-encoding must not touch. */
const URI_UNRESERVED = /[A-Za-z0-9-._~]/;

/**
 * Percent-encodes one character per the SigV4 rules (everything but
 * unreserved chars, uppercase hex).
 */
export function sigv4UriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    if (URI_UNRESERVED.test(char) || (char === '/' && !encodeSlash)) {
      out += char;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** SHA-256 hex digest of the payload (the x-amz-content-sha256 value). */
export function sigv4PayloadHash(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

export interface SigV4Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token (adds x-amz-security-token to the signature). */
  readonly sessionToken?: string | null;
}

export interface SigV4Request {
  readonly method: string;
  /** The request path as sent on the wire (already percent-encoded). */
  readonly path: string;
  /** Sorted-by-key query parameters (already decoded); empty for Bedrock invoke. */
  readonly query?: ReadonlyArray<readonly [string, string]>;
  /** Lowercased header name → trimmed value; exactly the headers being signed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Uint8Array;
  /** ISO 8601 basic timestamp, e.g. `20260117T091503Z`. */
  readonly amzDate: string;
  /** Credential date, e.g. `20260117` (amzDate's first 8 chars). */
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}

/** Assembles the canonical request string (each line `\n`-separated). */
export function sigv4CanonicalRequest(request: SigV4Request): string {
  const names = Object.keys(request.headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${request.headers[name].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const query = (request.query ?? [])
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${sigv4UriEncode(key)}=${sigv4UriEncode(value)}`)
    .join('&');
  return [request.method, request.path, query, canonicalHeaders, signedHeaders, sigv4PayloadHash(request.payload)].join(
    '\n',
  );
}

/** The signing key derivation (HMAC chain; AWS "deriving the signing key"). */
export function sigv4SigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  let key = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  key = createHmac('sha256', key).update(region).digest();
  key = createHmac('sha256', key).update(service).digest();
  return createHmac('sha256', key).update(SIGV4_TERMINATOR).digest();
}

/** The string-to-sign (algorithm, timestamp, scope, canonical-request hash). */
export function sigv4StringToSign(request: SigV4Request, canonicalRequest: string): string {
  const scope = `${request.dateStamp}/${request.region}/${request.service}/${SIGV4_TERMINATOR}`;
  const canonicalHash = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  return [SIGV4_ALGORITHM, request.amzDate, scope, canonicalHash].join('\n');
}

/** The hex signature over the string-to-sign with the derived key. */
export function sigv4Signature(signingKey: Buffer, stringToSign: string): string {
  return createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
}

export interface SigV4SignedRequest {
  /** The full Authorization header value. */
  readonly authorization: string;
  /** The lowercase header names signed, `;`-joined (SignedHeaders). */
  readonly signedHeaders: string;
  /** The payload hash placed in x-amz-content-sha256. */
  readonly payloadHash: string;
}

/**
 * Signs one request and returns the Authorization header value. Pure: no
 * clock, network, or mutation — the caller supplies `amzDate`/`dateStamp`
 * so tests can pin the official vectors.
 */
export function signSigV4(credential: SigV4Credential, request: SigV4Request): SigV4SignedRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value.trim();
  }
  const normalized: SigV4Request = { ...request, headers };
  const payloadHash = sigv4PayloadHash(request.payload);
  if (headers['x-amz-content-sha256'] !== undefined && headers['x-amz-content-sha256'] !== payloadHash) {
    throw new Error('sigv4: x-amz-content-sha256 header does not match the payload');
  }
  const canonical = sigv4CanonicalRequest(normalized);
  const stringToSign = sigv4StringToSign(normalized, canonical);
  const key = sigv4SigningKey(credential.secretAccessKey, normalized.dateStamp, normalized.region, normalized.service);
  const signature = sigv4Signature(key, stringToSign);
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  return {
    authorization: `${SIGV4_ALGORITHM} Credential=${credential.accessKeyId}/${normalized.dateStamp}/${normalized.region}/${normalized.service}/${SIGV4_TERMINATOR}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    payloadHash,
  };
}

/** ISO 8601 basic timestamp (`YYYYMMDDTHHMMSSZ`) from epoch milliseconds. */
export function sigv4AmzDate(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * The complete Bedrock signing assembly: builds the exact AWS header set
 * (accept, content-type, host, x-amz-content-sha256, x-amz-date and the
 * optional x-amz-security-token), signs it and returns the outbound header
 * map. This is the ONLY header set a Bedrock dispatch may carry (the
 * litellm lesson: extra headers in the signature break verification).
 */
export function signBedrockRequest(input: {
  readonly credential: SigV4Credential;
  readonly method: string;
  readonly host: string;
  /** The wire path (Bedrock model paths carry `%3A` for `:`). */
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly payload: Uint8Array;
  readonly region: string;
  readonly nowMs: number;
}): { readonly headers: Readonly<Record<string, string>>; readonly payloadHash: string } {
  const amzDate = sigv4AmzDate(input.nowMs);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sigv4PayloadHash(input.payload);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    host: input.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const sessionToken = input.credential.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    headers['x-amz-security-token'] = sessionToken;
  }
  const signed = signSigV4(input.credential, {
    method: input.method,
    path: input.path,
    query: input.query,
    headers,
    payload: input.payload,
    amzDate,
    dateStamp,
    region: input.region,
    service: SIGV4_BEDROCK_SERVICE,
  });
  return { headers: { ...headers, authorization: signed.authorization }, payloadHash };
}
