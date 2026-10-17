/**
 * Batch-3 AWS EventStream binary codec (port of sub2api's
 * backend/internal/service/bedrock_stream.go decoder; the format is the
 * `application/vnd.amazon.eventstream` wire spec). Bedrock
 * InvokeModelWithResponseStream answers with binary frames whose `chunk`
 * events carry `{"bytes":"<base64 Anthropic SSE JSON>"}`; the transport
 * decodes them into standard SSE.
 *
 * Frame layout:
 *
 *     [total_byte_length: 4 bytes BE][headers_byte_length: 4 bytes BE]
 *     [prelude_crc: 4 bytes BE]
 *     [headers: variable][payload: variable]
 *     [message_crc: 4 bytes BE]
 *
 * Both CRCs are CRC-32/IEEE. The prelude CRC covers the first 8 bytes; the
 * message CRC covers prelude + headers + payload. Headers are
 * `[name_len: 1][name][value_type: 1][value]` records; string values
 * (type 7) are `[value_len: 2 BE][utf-8 bytes]`.
 */

import {
  EVENTSTREAM_HEADER_VALUE_TYPE,
  EVENTSTREAM_MAX_FRAME_BYTES,
  EVENTSTREAM_MIN_FRAME_BYTES,
  EVENTSTREAM_PRELUDE_BYTES,
} from './constants.js';

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

/** CRC-32/IEEE (the AWS EventStream checksum): one-shot over the concatenated chunks. */
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
  | 'HEADER_MALFORMED'
  | 'UPSTREAM_EXCEPTION'
  | 'UPSTREAM_ERROR';

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
export interface EventStreamFrame {
  /** All header string values, keyed by name (bools render as "true"/"false"). */
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Uint8Array;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * Parses the header block per the wire spec. Returns the header map; throws
 * `HEADER_MALFORMED` on a truncated or unknown-typed record (the decoder
 * then fails the stream — same fail-closed posture as the reference).
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

/** The wire-relevant header names. */
export const EVENTSTREAM_MESSAGE_TYPE_HEADER = ':message-type';
export const EVENTSTREAM_EVENT_TYPE_HEADER = ':event-type';
export const EVENTSTREAM_EXCEPTION_TYPE_HEADER = ':exception-type';
export const EVENTSTREAM_CHUNK_EVENT = 'chunk';

/**
 * Decodes ONE complete frame from the head of `buffer`. Returns the frame
 * and the number of bytes consumed, or `null` when more bytes are needed.
 * Both CRCs are verified; any mismatch or malformed length fails closed.
 */
export function decodeEventStreamFrame(
  buffer: Uint8Array,
): { readonly frame: EventStreamFrame; readonly consumed: number } | null {
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

/** An incremental decoder fed raw upstream bytes; each chunk event yields one payload. */
export class BedrockEventStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  /**
   * Feeds bytes and returns every decoded `chunk`-event payload in order.
   * Non-chunk frames are consumed silently (e.g. initial-response); an
   * `:exception-type` header or an `:message-type` of `exception`/`error`
   * throws with the payload text so the transport surfaces the upstream
   * error (sub2api bedrock_stream.go Decode semantics).
   */
  feed(chunk: Uint8Array): readonly Uint8Array[] {
    const merged = this.buffer.length === 0 ? new Uint8Array(chunk) : Buffer.concat([this.buffer, chunk]);
    this.buffer = merged;
    const payloads: Uint8Array[] = [];
    let offset = 0;
    while (true) {
      let decoded: ReturnType<typeof decodeEventStreamFrame>;
      try {
        decoded = decodeEventStreamFrame(this.buffer.subarray(offset));
      } catch (error) {
        this.buffer = new Uint8Array(0);
        throw error;
      }
      if (decoded === null) break;
      const { frame } = decoded;
      offset += decoded.consumed;
      const eventType = frame.headers[EVENTSTREAM_EVENT_TYPE_HEADER] ?? '';
      if (eventType === EVENTSTREAM_CHUNK_EVENT) {
        payloads.push(frame.payload);
        continue;
      }
      const exceptionType = frame.headers[EVENTSTREAM_EXCEPTION_TYPE_HEADER] ?? '';
      if (exceptionType !== '') {
        this.buffer = new Uint8Array(0);
        throw new EventStreamDecoderError(
          'UPSTREAM_EXCEPTION',
          `bedrock exception: ${exceptionType}: ${Buffer.from(frame.payload).toString('utf8')}`,
        );
      }
      const messageType = frame.headers[EVENTSTREAM_MESSAGE_TYPE_HEADER] ?? '';
      if (messageType === 'exception' || messageType === 'error') {
        this.buffer = new Uint8Array(0);
        throw new EventStreamDecoderError(
          'UPSTREAM_ERROR',
          `bedrock error: ${Buffer.from(frame.payload).toString('utf8')}`,
        );
      }
      // Skip other event types (initial-response and friends).
    }
    this.buffer = offset === 0 ? this.buffer : new Uint8Array(this.buffer.subarray(offset));
    return payloads;
  }
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
  const payloadLength = payload.length;
  const totalLength = EVENTSTREAM_PRELUDE_BYTES + headersLength + payloadLength + 4;
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
