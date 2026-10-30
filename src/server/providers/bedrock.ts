/**
 * AWS Bedrock adapter for the classic dispatch layer — extraction (plan C3)
 * of the SaaS implementation in src/saas/gateway/bedrock/{sigv4.ts,
 * eventstream.ts, response-bridge.ts, transform.ts}. Extraction, not import:
 * this module must stay free of PG/Redis/SaaS dependencies.
 *
 * Two halves:
 *
 * 1. AWS Signature Version 4 signing for the `bedrock` service over the
 *    canonical request (host, method, path, query, headers, payload hash),
 *    implemented as pure functions over node:crypto (no aws-sdk). The signer
 *    signs EXACTLY the fixed AWS header set it assembles itself — every
 *    additional non-AWS header that participates in the signature must also
 *    be forwarded verbatim by Bedrock's front end or verification fails (the
 *    litellm lesson).
 *
 * 2. The `application/vnd.amazon.eventstream` response decoder: an
 *    incremental frame parser that reassembles frames split across chunk
 *    boundaries (buffer-state machine: accumulate → decode whole frames at
 *    the head → retain the remainder) and verifies both CRC-32s.
 */

import { createHash, createHmac } from 'node:crypto';
import { type Readable, Transform } from 'node:stream';
import type { ProviderAuthRequest, ProviderTransportProfile, UpstreamProviderSettings } from './types.js';

/** Default region when the upstream carries no awsRegion. */
export const BEDROCK_DEFAULT_REGION = 'us-east-1';

/** `anthropic_version` value Bedrock InvokeModel requires in the request body. */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

// ---------------------------------------------------------------------------
// SigV4 (extraction of sigv4.ts; verified against the official AWS SigV4
// test-suite vectors — see tests/server/providers/bedrock-sigv4.test.ts).

/** The fixed Bedrock service string. */
export const SIGV4_BEDROCK_SERVICE = 'bedrock';

/** The terminal signing-key scope segment. */
const SIGV4_TERMINATOR = 'aws4_request';

/** The algorithm prefix (also the Authorization scheme). */
const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** The unreserved characters SigV4 percent-encoding must not touch. */
const URI_UNRESERVED = /[A-Za-z0-9-._~]/;

/**
 * Percent-encodes one string per the SigV4 rules (everything but
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
 * map. This is the ONLY header set a Bedrock dispatch may carry.
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

// ---------------------------------------------------------------------------
// AWS EventStream codec (extraction of eventstream.ts + constants.ts).
//
// Frame layout:
//
//     [total_byte_length: 4 bytes BE][headers_byte_length: 4 bytes BE]
//     [prelude_crc: 4 bytes BE]
//     [headers: variable][payload: variable]
//     [message_crc: 4 bytes BE]
//
// Both CRCs are CRC-32/IEEE. The prelude CRC covers the first 8 bytes; the
// message CRC covers prelude + headers + payload. Headers are
// `[name_len: 1][name][value_type: 1][value]` records; string values
// (type 7) are `[value_len: 2 BE][utf-8 bytes]`.

/** EventStream frame prelude length: total(4) + headers(4) + prelude_crc(4). */
export const EVENTSTREAM_PRELUDE_BYTES = 12;

/** Minimum frame length: prelude + message_crc(4). */
export const EVENTSTREAM_MIN_FRAME_BYTES = 16;

/** Maximum accepted frame length (guards against a corrupt length prefix). */
export const EVENTSTREAM_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** EventStream header value types (the wire spec's enum). */
export const EVENTSTREAM_HEADER_VALUE_TYPE = {
  BOOL_TRUE: 0,
  BOOL_FALSE: 1,
  BYTE: 2,
  SHORT: 3,
  INT: 4,
  LONG: 5,
  BYTES: 6,
  STRING: 7,
  TIMESTAMP: 8,
  UUID: 9,
} as const;

let crc32Table: readonly number[] | null = null;

function crc32IeeeTable(): readonly number[] {
  if (crc32Table !== null) return crc32Table;
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  crc32Table = table;
  return table;
}

/** CRC-32/IEEE (the AWS EventStream checksum): one-shot over the chunks. */
export function crc32Ieee(...chunks: readonly Uint8Array[]): number {
  const table = crc32IeeeTable();
  let crc = 0xffffffff;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      crc = table[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type EventStreamDecodeError =
  | 'FRAME_TOO_SHORT'
  | 'INVALID_FRAME_LENGTH'
  | 'PRELUDE_CRC_MISMATCH'
  | 'MESSAGE_CRC_MISMATCH'
  | 'HEADER_MALFORMED';

export class EventStreamDecoderError extends Error {
  constructor(
    readonly code: EventStreamDecodeError,
    message: string,
  ) {
    super(message);
    this.name = 'EventStreamDecoderError';
  }
}

/** One decoded EventStream frame. */
export interface EventstreamFrame {
  /** All header string values, keyed by name (bools render as "true"/"false"). */
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Uint8Array;
}

/** The wire-relevant header names. */
export const EVENTSTREAM_MESSAGE_TYPE_HEADER = ':message-type';
export const EVENTSTREAM_EVENT_TYPE_HEADER = ':event-type';
export const EVENTSTREAM_EXCEPTION_TYPE_HEADER = ':exception-type';
export const EVENTSTREAM_CHUNK_EVENT = 'chunk';

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * Parses the header block per the wire spec. Returns the header map;
 * malformed/truncated records end the parse (the frames that matter to
 * Bedrock dispatch are well-formed).
 */
export function parseEventStreamHeaders(headers: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let pos = 0;
  while (pos < headers.length) {
    const nameLen = headers[pos];
    pos += 1;
    if (pos + nameLen > headers.length) break;
    const name = Buffer.from(headers.subarray(pos, pos + nameLen)).toString('utf8');
    pos += nameLen;
    if (pos >= headers.length) break;
    const valueType = headers[pos];
    pos += 1;
    let value: string | null = null;
    switch (valueType) {
      case EVENTSTREAM_HEADER_VALUE_TYPE.BOOL_TRUE:
        value = 'true';
        break;
      case EVENTSTREAM_HEADER_VALUE_TYPE.BOOL_FALSE:
        value = 'false';
        break;
      case EVENTSTREAM_HEADER_VALUE_TYPE.BYTE:
        if (pos + 1 > headers.length) return result;
        pos += 1;
        break;
      case EVENTSTREAM_HEADER_VALUE_TYPE.SHORT:
        if (pos + 2 > headers.length) return result;
        pos += 2;
        break;
      case EVENTSTREAM_HEADER_VALUE_TYPE.INT:
        if (pos + 4 > headers.length) return result;
        pos += 4;
        break;
      case EVENTSTREAM_HEADER_VALUE_TYPE.LONG:
      case EVENTSTREAM_HEADER_VALUE_TYPE.TIMESTAMP:
        if (pos + 8 > headers.length) return result;
        pos += 8;
        break;
      case EVENTSTREAM_HEADER_VALUE_TYPE.BYTES:
      case EVENTSTREAM_HEADER_VALUE_TYPE.STRING: {
        if (pos + 2 > headers.length) return result;
        const valueLen = readUint16(headers, pos);
        pos += 2;
        if (pos + valueLen > headers.length) return result;
        if (valueType === EVENTSTREAM_HEADER_VALUE_TYPE.STRING) {
          value = Buffer.from(headers.subarray(pos, pos + valueLen)).toString('utf8');
        }
        pos += valueLen;
        break;
      }
      case EVENTSTREAM_HEADER_VALUE_TYPE.UUID:
        if (pos + 16 > headers.length) return result;
        pos += 16;
        break;
      default:
        return result;
    }
    if (value !== null) result[name] = value;
  }
  return result;
}

/**
 * Decodes ONE complete frame from the head of `buffer`. Returns the frame
 * and the number of bytes consumed, or `null` when more bytes are needed.
 * Both CRCs are verified; any mismatch or malformed length fails closed.
 */
export function decodeEventStreamFrame(
  buffer: Uint8Array,
): { readonly frame: EventstreamFrame; readonly consumed: number } | null {
  if (buffer.length < EVENTSTREAM_PRELUDE_BYTES) return null;
  const totalLength = readUint32(buffer, 0);
  const headersLength = readUint32(buffer, 4);
  if (totalLength < EVENTSTREAM_MIN_FRAME_BYTES || totalLength > EVENTSTREAM_MAX_FRAME_BYTES) {
    throw new EventStreamDecoderError('INVALID_FRAME_LENGTH', `eventstream total_length=${totalLength} is invalid`);
  }
  if (buffer.length < totalLength) return null;
  if (headersLength > totalLength - EVENTSTREAM_PRELUDE_BYTES - 4) {
    throw new EventStreamDecoderError(
      'INVALID_FRAME_LENGTH',
      `eventstream headers_length=${headersLength} exceeds frame`,
    );
  }
  const prelude = buffer.subarray(0, 8);
  const preludeCrc = readUint32(buffer, 8);
  if (crc32Ieee(prelude) !== preludeCrc) {
    throw new EventStreamDecoderError('PRELUDE_CRC_MISMATCH', 'eventstream prelude CRC mismatch');
  }
  const frame = buffer.subarray(0, totalLength);
  const messageCrc = readUint32(frame, totalLength - 4);
  const covered = frame.subarray(0, totalLength - 4);
  if (crc32Ieee(covered) !== messageCrc) {
    throw new EventStreamDecoderError('MESSAGE_CRC_MISMATCH', 'eventstream message CRC mismatch');
  }
  const headers = parseEventStreamHeaders(
    frame.subarray(EVENTSTREAM_PRELUDE_BYTES, EVENTSTREAM_PRELUDE_BYTES + headersLength),
  );
  const payload = frame.subarray(EVENTSTREAM_PRELUDE_BYTES + headersLength, totalLength - 4);
  return { frame: { headers, payload: new Uint8Array(payload) }, consumed: totalLength };
}

/** The incremental decoder contract. */
export interface EventstreamDecoder {
  /**
   * Feeds raw bytes and returns every frame completed by this chunk, in
   * wire order. Partial frames are retained until the remainder arrives;
   * a decode error fails the stream (the buffer is dropped — fail closed).
   */
  feed(chunk: Uint8Array): readonly EventstreamFrame[];
}

/**
 * Creates an incremental EventStream decoder. This is the raw frame layer:
 * every complete frame (including `initial-response` and exception frames)
 * is returned with its headers and payload; Bedrock-specific interpretation
 * (chunk extraction, SSE translation) lives above it.
 */
export function createEventstreamDecoder(): EventstreamDecoder {
  let buffer: Uint8Array = new Uint8Array(0);
  return {
    feed(chunk: Uint8Array): readonly EventstreamFrame[] {
      const merged = buffer.length === 0 ? new Uint8Array(chunk) : Buffer.concat([buffer, chunk]);
      buffer = merged;
      const frames: EventstreamFrame[] = [];
      let offset = 0;
      while (true) {
        let decoded: ReturnType<typeof decodeEventStreamFrame>;
        try {
          decoded = decodeEventStreamFrame(buffer.subarray(offset));
        } catch (error) {
          buffer = new Uint8Array(0);
          throw error;
        }
        if (decoded === null) break;
        offset += decoded.consumed;
        frames.push(decoded.frame);
      }
      buffer = offset === 0 ? buffer : new Uint8Array(buffer.subarray(offset));
      return frames;
    },
  };
}

/**
 * Encodes one EventStream frame (test/round-trip helper; mirrors the wire
 * format exactly, including both CRCs). String headers only — everything
 * the Bedrock streams and the tests need.
 */
export function encodeEventStreamFrame(input: {
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly payload?: Uint8Array;
}): Uint8Array {
  const headerBytes: number[] = [];
  for (const [name, value] of input.headers ?? []) {
    const nameBytes = Buffer.from(name, 'utf8');
    const valueBytes = Buffer.from(value, 'utf8');
    headerBytes.push(nameBytes.length, ...nameBytes, EVENTSTREAM_HEADER_VALUE_TYPE.STRING);
    const valueLen = valueBytes.length;
    headerBytes.push((valueLen >> 8) & 0xff, valueLen & 0xff, ...valueBytes);
  }
  const headers = Uint8Array.from(headerBytes);
  const payload = input.payload ?? new Uint8Array(0);
  const headersLength = headers.length;
  const totalLength = EVENTSTREAM_PRELUDE_BYTES + headersLength + payload.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, totalLength);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32Ieee(frame.subarray(0, 8)));
  frame.set(headers, EVENTSTREAM_PRELUDE_BYTES);
  frame.set(payload, EVENTSTREAM_PRELUDE_BYTES + headersLength);
  view.setUint32(totalLength - 4, crc32Ieee(frame.subarray(0, totalLength - 4)));
  return frame;
}

// ---------------------------------------------------------------------------
// Bedrock chunk → Anthropic SSE translation (extraction of response-bridge.ts).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the Anthropic SSE event JSON from one Bedrock EventStream chunk
 * payload: the payload is `{"bytes":"<base64>"}` and the decoded bytes are
 * the event JSON. Returns null when the payload carries no parsable bytes.
 */
export function extractBedrockChunkData(payload: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(payload));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const encoded = parsed.bytes;
  if (typeof encoded !== 'string' || encoded === '') return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  try {
    const event: unknown = JSON.parse(decoded.toString('utf8'));
    return isRecord(event) ? event : null;
  } catch {
    return null;
  }
}

/** Formats one Anthropic SSE event as the wire text. */
export function formatAnthropicSseEvent(event: Record<string, unknown>): string {
  const data = JSON.stringify(event);
  const type = typeof event.type === 'string' ? event.type : '';
  return type === '' ? `data: ${data}\n\n` : `event: ${type}\ndata: ${data}\n\n`;
}

/**
 * Converts a Bedrock eventstream response body (binary Readable) into an
 * Anthropic SSE text Readable: `chunk` frames are unwrapped and re-emitted
 * as SSE events; other frames are consumed; exception/error frames destroy
 * the stream with the upstream error text so the dispatch surfaces it.
 */
export function decodeBedrockEventstreamStream(stream: Readable): Readable {
  const decoder = createEventstreamDecoder();
  return stream.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: string) => void): void {
        let frames: readonly EventstreamFrame[];
        try {
          frames = decoder.feed(chunk);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        for (const frame of frames) {
          const exceptionType = frame.headers[EVENTSTREAM_EXCEPTION_TYPE_HEADER] ?? '';
          if (exceptionType !== '') {
            callback(new Error(`bedrock exception: ${exceptionType}: ${Buffer.from(frame.payload).toString('utf8')}`));
            return;
          }
          const messageType = frame.headers[EVENTSTREAM_MESSAGE_TYPE_HEADER] ?? '';
          if (messageType === 'exception' || messageType === 'error') {
            callback(new Error(`bedrock error: ${Buffer.from(frame.payload).toString('utf8')}`));
            return;
          }
          if ((frame.headers[EVENTSTREAM_EVENT_TYPE_HEADER] ?? '') !== EVENTSTREAM_CHUNK_EVENT) continue;
          const event = extractBedrockChunkData(frame.payload);
          if (event !== null) this.push(formatAnthropicSseEvent(event));
        }
        callback();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Bedrock URL/body assembly (extraction of transform.ts's thin halves).

/**
 * The Bedrock InvokeModel invoke URL:
 * `https://bedrock-runtime.{region}.amazonaws.com/model/{model}/{invoke|
 * invoke-with-response-stream}` with `%3A`-encoded model ids. `baseUrl`
 * (when non-empty) overrides the origin — local test upstreams.
 */
export function buildBedrockInvokeUrl(input: {
  readonly region: string;
  readonly modelId: string;
  readonly stream: boolean;
  readonly baseUrl?: string;
}): { readonly url: string; readonly path: string; readonly host: string } {
  const region = input.region === '' ? BEDROCK_DEFAULT_REGION : input.region;
  const host =
    input.baseUrl === undefined || input.baseUrl === ''
      ? `bedrock-runtime.${region}.amazonaws.com`
      : new URL(input.baseUrl).host;
  const base = input.baseUrl === undefined || input.baseUrl === '' ? `https://${host}` : input.baseUrl;
  const path = `/model/${sigv4UriEncode(input.modelId)}/${input.stream ? 'invoke-with-response-stream' : 'invoke'}`;
  return { url: `${base.replace(/\/+$/, '')}${path}`, path, host };
}

/**
 * The minimal Bedrock InvokeModel body preparation (the wire-required half
 * of the SaaS prepareBedrockRequestBody): injects `anthropic_version` and
 * removes the Anthropic-direct fields that ride elsewhere (model → URL,
 * provider/metadata/stream → not supported). Deeper Claude-Code-compat
 * sanitization stays with the wiring phase. Copy-on-write; returns null
 * when nothing changes.
 */
export function prepareBedrockInvokeBody(body: Record<string, unknown>): Record<string, unknown> | null {
  let next: Record<string, unknown> | null = null;
  const edit = (): Record<string, unknown> => {
    if (next === null) next = { ...body };
    return next;
  };
  if (body.anthropic_version !== BEDROCK_ANTHROPIC_VERSION) edit().anthropic_version = BEDROCK_ANTHROPIC_VERSION;
  for (const field of ['provider', 'metadata', 'model', 'stream'] as const) {
    if (field in body) delete edit()[field];
  }
  return next;
}

// ---------------------------------------------------------------------------
// The transport profile the classic dispatch will consume.

function bedrockCredential(upstream: UpstreamProviderSettings): SigV4Credential {
  const accessKeyId = upstream.awsAccessKeyId ?? '';
  const secretAccessKey = upstream.awsSecretAccessKey ?? '';
  if (accessKeyId === '' || secretAccessKey === '') {
    throw new Error('bedrock transport profile requires upstream awsAccessKeyId and awsSecretAccessKey');
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(upstream.awsSessionToken != null && upstream.awsSessionToken !== ''
      ? { sessionToken: upstream.awsSessionToken }
      : {}),
  };
}

/** The Bedrock transport profile: SigV4 auth, invoke URLs, eventstream decode. */
export const bedrockTransportProfile: ProviderTransportProfile = {
  id: 'bedrock',
  ownsHeaders: true,
  buildUrl(input): string {
    const endpoint = input.endpoint === '' ? 'invoke' : input.endpoint;
    if (
      endpoint !== 'invoke' &&
      endpoint !== 'invoke-with-response-stream' &&
      endpoint !== 'messages' &&
      endpoint !== 'messages-stream'
    ) {
      throw new Error(`bedrock transport profile does not support endpoint "${endpoint}"`);
    }
    const stream =
      endpoint === 'invoke-with-response-stream' || endpoint === 'messages-stream' || (input.stream ?? false);
    const model = input.model ?? '';
    if (model === '') throw new Error('bedrock transport profile requires a model');
    const region = input.upstream?.awsRegion ?? '';
    return buildBedrockInvokeUrl({
      region: region === '' ? BEDROCK_DEFAULT_REGION : region,
      modelId: model,
      stream,
      ...(input.baseUrl.trim() === '' ? {} : { baseUrl: input.baseUrl.trim() }),
    }).url;
  },
  async buildAuth(
    upstream: UpstreamProviderSettings,
    request: ProviderAuthRequest,
  ): Promise<Readonly<Record<string, string>>> {
    const target = new URL(request.url);
    const credential = bedrockCredential(upstream);
    const region =
      upstream.awsRegion === undefined || upstream.awsRegion === null || upstream.awsRegion === ''
        ? BEDROCK_DEFAULT_REGION
        : upstream.awsRegion;
    const nowMs = request.nowMs ?? Date.now();
    const amzDate = sigv4AmzDate(nowMs);
    const payloadHash = sigv4PayloadHash(request.body);
    // The dispatch's accept/content-type variants (e.g. the eventstream
    // accept) must ride the SIGNED header set — overriding them after
    // signing would break verification. Defaults mirror signBedrockRequest.
    const headers: Record<string, string> = {
      accept:
        request.headers['accept'] !== undefined && request.headers['accept'] !== ''
          ? request.headers['accept']
          : 'application/json',
      'content-type':
        request.headers['content-type'] !== undefined && request.headers['content-type'] !== ''
          ? request.headers['content-type']
          : 'application/json',
      host: target.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (typeof credential.sessionToken === 'string' && credential.sessionToken !== '') {
      headers['x-amz-security-token'] = credential.sessionToken;
    }
    const query: Array<[string, string]> = [];
    for (const [key, value] of target.searchParams) query.push([key, value]);
    const signed = signSigV4(credential, {
      method: request.method,
      path: target.pathname,
      query,
      headers,
      payload: request.body,
      amzDate,
      dateStamp: amzDate.slice(0, 8),
      region,
      service: SIGV4_BEDROCK_SERVICE,
    });
    return { ...headers, authorization: signed.authorization };
  },
  transformRequestBody(
    body: Record<string, unknown>,
    _context?: { endpoint?: string; model?: string | null; stream?: boolean },
  ): Record<string, unknown> | null {
    return prepareBedrockInvokeBody(body);
  },
  decodeResponse(stream: Readable): Readable {
    return decodeBedrockEventstreamStream(stream);
  },
};
