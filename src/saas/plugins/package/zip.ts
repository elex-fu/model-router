/**
 * Batch-5 §5.1 plugin package zip reader/writer (task #24; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.1; sub2api reference:
 * backend/internal/service/plugin_package.go).
 *
 * Minimal, strictly-validated ZIP subset — exactly what plugin archives need
 * and nothing more:
 *
 *   - EOCD discovery: the exact-end 22-byte record first, then a scan back
 *     over up to 64KiB of trailing archive comment for signature 0x06054b50
 *     (the comment length must account for every trailing byte).
 *   - Central directory only (no ZIP64): entry count and sizes are 16/32-bit
 *     and must reconcile exactly with the EOCD and the directory extent.
 *   - `data()` resolves the compressed bytes from the LOCAL header's own
 *     name/extra lengths — the classic zip trick that defeats archives whose
 *     central directory lies about the local layout. Stored (method 0) data
 *     is bounded by compressedSize; deflate (method 8) must inflate to
 *     exactly uncompressedSize.
 *
 * Every structural deviation (bad signature, out-of-range offset, EOCD /
 * central-directory count mismatch, oversize entry) raises ZipFormatError
 * with a stable snake_case code so verify.ts can rethrow without information
 * loss. writeZip is the stored-method counterpart used by tests (its
 * externalAttributes / uncompressedSizeOverride parameters are deliberate
 * test seams for the symlink and lying-header negative matrix).
 */

import * as zlib from 'node:zlib';

/** Hard archive ceiling shared by the reader and every verify.ts limit. */
export const MAX_ENTRIES = 512;
export const MAX_ENTRY_NAME_BYTES = 1024;
export const MAX_UNCOMPRESSED_BYTES_PER_ENTRY = 256 * 1024 * 1024;

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const EOCD_MIN_BYTES = 22;
const EOCD_MAX_SCAN_BYTES = EOCD_MIN_BYTES + 0xffff; // 22 + maximum comment
const CENTRAL_DIRECTORY_HEADER_BYTES = 46;
const LOCAL_FILE_HEADER_BYTES = 30;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export class ZipFormatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
  readonly externalAttributes: number;
  readonly isDirectory: boolean;
  /** Compression method: 0 = stored, 8 = deflate. */
  readonly method: number;
  /** Inflated bytes, resolved lazily from the local header. */
  data(): Buffer;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function fail(code: string, message: string): never {
  throw new ZipFormatError(code, message);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.length < EOCD_MIN_BYTES) {
    fail('no_eocd', 'archive is too small to contain an end-of-central-directory record');
  }
  const lastPossibleOffset = bytes.length - EOCD_MIN_BYTES;
  const firstPossibleOffset = Math.max(0, bytes.length - EOCD_MAX_SCAN_BYTES);
  for (let offset = lastPossibleOffset; offset >= firstPossibleOffset; offset--) {
    if (readUint32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    // A candidate only counts when its comment length explains every byte
    // after the record — otherwise it is data that merely looks like a
    // signature (or trailing garbage appended to the archive).
    const commentLength = readUint16(bytes, offset + 20);
    if (offset + EOCD_MIN_BYTES + commentLength === bytes.length) return offset;
  }
  fail('no_eocd', 'end-of-central-directory record not found');
}

export function readZipEntries(buffer: Uint8Array): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entriesOnDisk = readUint16(buffer, eocdOffset + 8);
  const entryCount = readUint16(buffer, eocdOffset + 10);
  const centralDirectorySize = readUint32(buffer, eocdOffset + 12);
  const centralDirectoryOffset = readUint32(buffer, eocdOffset + 16);
  if (entriesOnDisk !== entryCount) {
    fail('count_mismatch', 'EOCD disk/total entry counts disagree');
  }
  if (entryCount === 0) {
    fail('empty_archive', 'archive contains no entries');
  }
  if (entryCount > MAX_ENTRIES) {
    fail('too_many_entries', `archive declares ${entryCount} entries (max ${MAX_ENTRIES})`);
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset > eocdOffset || centralDirectoryEnd > eocdOffset) {
    fail('bad_central_directory', 'central directory extends past the end-of-central-directory record');
  }

  const nameDecoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let position = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (position + CENTRAL_DIRECTORY_HEADER_BYTES > centralDirectoryEnd) {
      fail('bad_central_directory', 'central directory is truncated');
    }
    if (readUint32(buffer, position) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      fail('bad_central_directory', 'central directory entry has a bad signature');
    }
    const method = readUint16(buffer, position + 10);
    const crc32 = readUint32(buffer, position + 16);
    const compressedSize = readUint32(buffer, position + 20);
    const uncompressedSize = readUint32(buffer, position + 24);
    const nameLength = readUint16(buffer, position + 28);
    const extraLength = readUint16(buffer, position + 30);
    const commentLength = readUint16(buffer, position + 32);
    const externalAttributes = readUint32(buffer, position + 38);
    const localHeaderOffset = readUint32(buffer, position + 42);
    const recordEnd = position + CENTRAL_DIRECTORY_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (recordEnd > centralDirectoryEnd) {
      fail('bad_central_directory', 'central directory entry overflows the directory extent');
    }
    if (nameLength === 0) {
      fail('empty_entry_name', 'central directory entry has an empty name');
    }
    if (nameLength > MAX_ENTRY_NAME_BYTES) {
      fail('entry_name_too_long', `entry name exceeds ${MAX_ENTRY_NAME_BYTES} bytes`);
    }
    if (uncompressedSize > MAX_UNCOMPRESSED_BYTES_PER_ENTRY) {
      fail('entry_too_large', 'entry declares an uncompressed size above the per-entry cap');
    }
    if (localHeaderOffset + LOCAL_FILE_HEADER_BYTES > buffer.length) {
      fail('bad_offset', 'entry local header offset is outside the archive');
    }
    const name = nameDecoder.decode(
      buffer.subarray(
        position + CENTRAL_DIRECTORY_HEADER_BYTES,
        position + CENTRAL_DIRECTORY_HEADER_BYTES + nameLength,
      ),
    );
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      externalAttributes,
      isDirectory: name.endsWith('/'),
      method,
      data: () => readEntryData(buffer, localHeaderOffset, method, compressedSize, uncompressedSize),
    });
    position = recordEnd;
  }
  if (position !== centralDirectoryEnd) {
    fail('bad_central_directory', 'central directory size does not match its entries');
  }
  return entries;
}

function readEntryData(
  buffer: Uint8Array,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (readUint32(buffer, localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    fail('bad_local_header', 'local file header has a bad signature');
  }
  // The compressed data starts after the LOCAL header's own name+extra
  // lengths — never the central-directory lengths (the known zip trick).
  const localNameLength = readUint16(buffer, localHeaderOffset + 26);
  const localExtraLength = readUint16(buffer, localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + LOCAL_FILE_HEADER_BYTES + localNameLength + localExtraLength;
  if (dataOffset > buffer.length) {
    fail('bad_offset', 'local file header name/extra lengths push the data offset outside the archive');
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    fail('unsupported_compression', `unsupported compression method ${method}`);
  }
  if (method === METHOD_STORED) {
    if (compressedSize > MAX_UNCOMPRESSED_BYTES_PER_ENTRY) {
      fail('entry_too_large', 'stored entry exceeds the per-entry cap');
    }
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > buffer.length) {
      fail('bad_offset', 'stored entry data extends outside the archive');
    }
    const raw = Buffer.from(buffer.subarray(dataOffset, dataEnd));
    if (raw.length !== compressedSize) {
      fail('data_size_mismatch', 'stored entry data length disagrees with its compressed size');
    }
    return raw;
  }
  const dataEnd = dataOffset + compressedSize;
  if (dataEnd > buffer.length) {
    fail('bad_offset', 'deflate entry data extends outside the archive');
  }
  const inflated = zlib.inflateRawSync(buffer.subarray(dataOffset, dataEnd));
  if (inflated.length !== uncompressedSize) {
    fail('decompressed_size_mismatch', 'inflated entry size disagrees with its declared uncompressed size');
  }
  return inflated;
}

export interface ZipWriterFile {
  readonly name: string;
  readonly data: Uint8Array;
  /** Test seam: entry external attributes (symlink bits for the negative matrix). */
  readonly externalAttributes?: number;
  /** Test seam: write a lying uncompressed size into the headers. */
  readonly uncompressedSizeOverride?: number;
}

const nativeCrc32: ((data: Uint8Array) => number) | undefined = zlib.crc32;

function computeCrc32(data: Uint8Array): number {
  // zlib.crc32 ships with Node 22.2+/24; keep a table fallback for older runtimes.
  if (typeof nativeCrc32 === 'function') return nativeCrc32(data) >>> 0;
  return tableCrc32(data);
}

let crc32Table: number[] | undefined;

function tableCrc32(data: Uint8Array): number {
  let table = crc32Table;
  if (table === undefined) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32Table = table;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Stored-method zip writer. Every entry is written uncompressed (method 0)
 * with a fully consistent local/central header pair, so archives round-trip
 * through readZipEntries. `externalAttributes` and `uncompressedSizeOverride`
 * are test seams for the negative matrix (symlink-bit entries, lying
 * headers); production callers leave them unset.
 */
export function writeZip(files: readonly ZipWriterFile[]): Buffer {
  if (files.length > 0xffff) {
    fail('too_many_entries', 'zip writer cannot emit more than 65535 entries');
  }
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    if (name.length === 0) fail('empty_entry_name', 'zip writer refuses empty entry names');
    if (name.length > MAX_ENTRY_NAME_BYTES) {
      fail('entry_name_too_long', `entry name exceeds ${MAX_ENTRY_NAME_BYTES} bytes`);
    }
    if (file.data.length > 0xffffffff) fail('entry_too_large', 'entry data exceeds the 32-bit size field');
    const uncompressedSize = file.uncompressedSizeOverride ?? file.data.length;
    if (uncompressedSize > 0xffffffff) fail('entry_too_large', 'uncompressed size exceeds the 32-bit size field');
    const externalAttributes = file.externalAttributes ?? (file.name.endsWith('/') ? 0o040755 : 0o100644);
    const crc = computeCrc32(file.data);

    const local = Buffer.alloc(LOCAL_FILE_HEADER_BYTES + name.length);
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    name.copy(local, LOCAL_FILE_HEADER_BYTES);
    const payload = Buffer.from(file.data);
    localChunks.push(local, payload);

    const central = Buffer.alloc(CENTRAL_DIRECTORY_HEADER_BYTES + name.length);
    central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix, 2.0
    central.writeUInt16LE(20, 6); // version needed: 2.0
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(METHOD_STORED, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date: 1980-01-01
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, CENTRAL_DIRECTORY_HEADER_BYTES);
    centralChunks.push(central);

    offset += local.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(EOCD_MIN_BYTES);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}
