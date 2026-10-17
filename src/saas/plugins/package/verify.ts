/**
 * Batch-5 §5.1 plugin package verification pipeline (task #24; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.1; sub2api reference:
 * backend/internal/service/plugin_package.go).
 *
 * One pass, in a fixed order: size gate → zip structure → entry ceiling and
 * name/path/symlink validation → manifest read (raw bytes hashed — the
 * signature-chain root) → signature verification (or unsigned policy) →
 * manifest parse → BIDIRECTIONAL file reconciliation (archive entries and
 * manifest.files must agree exactly; undeclared or missing files both
 * reject) → declared uncompressed budget → extraction.
 *
 * Extraction re-counts the ACTUAL inflated bytes against the budget (a
 * second limit pass) and verifies every declared hash before a single byte
 * is written, then lands files with restrictive modes (entrypoint 0o700,
 * everything else 0o600, parent directories 0o700, exclusive 'wx' creates).
 * Layer errors (zip/manifest/signature) are rethrown as PluginPackageError
 * with their original codes — one exception type, no information loss.
 */

import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { PluginManifest, PluginSignatureStatus } from '../types.js';
import { isSafePackagePath, PLUGIN_MANIFEST_FILENAME, PluginManifestError, parsePluginManifest } from './manifest.js';
import {
  isPluginSignatureFile,
  PLUGIN_SIGNATURE_FILENAME,
  PluginSignatureError,
  type PluginTrustedPublishers,
  verifyPluginSignature,
} from './signature.js';
import { readZipEntries, type ZipEntry, ZipFormatError } from './zip.js';

export type { PluginTrustedPublishers };

export const PLUGIN_ARCHIVE_MAX_FILES = 512;
export const PLUGIN_MANIFEST_READ_CAP = 2 * 1024 * 1024;
export const PLUGIN_SIGNATURE_READ_CAP = 64 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

const SYMLINK_MODE_MASK = 0o170000;
const SYMLINK_MODE = 0o120000;
const ENTRYPOINT_MODE = 0o700;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class PluginPackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

export interface VerifiedPluginPackage {
  readonly manifest: PluginManifest;
  readonly manifestSha256: string;
  readonly manifestRaw: Uint8Array;
  readonly signatureStatus: PluginSignatureStatus;
  readonly entrypoint: string;
  readonly entrypointSha256: string;
  readonly files: Readonly<Record<string, string>>;
  extractTo(dir: string): Promise<void>;
}

interface VerifyPluginPackageInput {
  readonly data: Uint8Array;
  readonly trustedPublishers: PluginTrustedPublishers;
  readonly allowUnsigned: boolean;
  readonly maxUploadBytes?: number;
  readonly maxUncompressedBytes?: number;
}

function packageErrorFrom(error: unknown): PluginPackageError {
  if (
    error instanceof ZipFormatError ||
    error instanceof PluginManifestError ||
    error instanceof PluginSignatureError
  ) {
    return new PluginPackageError(error.code, error.message);
  }
  throw error;
}

function fail(code: string, message: string): never {
  throw new PluginPackageError(code, message);
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function readEntryData(entry: ZipEntry): Buffer {
  try {
    return entry.data();
  } catch (error) {
    throw packageErrorFrom(error);
  }
}

const manifestUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeManifestText(raw: Uint8Array): string {
  try {
    return manifestUtf8Decoder.decode(raw);
  } catch {
    return fail('invalid_json', 'manifest.json is not valid UTF-8');
  }
}

export async function verifyPluginPackage(input: VerifyPluginPackageInput): Promise<VerifiedPluginPackage> {
  const maxUploadBytes = input.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxUncompressedBytes = input.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;

  if (input.data.length === 0) fail('empty_package', 'plugin package is empty');
  if (input.data.length > maxUploadBytes) {
    fail('package_too_large', `plugin package exceeds the ${maxUploadBytes}-byte upload cap`);
  }

  let entries: ZipEntry[];
  try {
    entries = readZipEntries(input.data);
  } catch (error) {
    throw packageErrorFrom(error);
  }
  if (entries.length > PLUGIN_ARCHIVE_MAX_FILES) {
    fail('too_many_files', `plugin archive contains more than ${PLUGIN_ARCHIVE_MAX_FILES} entries`);
  }

  const entriesByName = new Map<string, ZipEntry>();
  for (const entry of entries) {
    if (entriesByName.has(entry.name)) {
      fail('duplicate_entry', `duplicate archive entry "${entry.name}"`);
    }
    entriesByName.set(entry.name, entry);
    // Directory entries are skipped by the reconciliation set below but are
    // still path-validated (minus their trailing slash).
    const entryPath = entry.isDirectory ? entry.name.slice(0, -1) : entry.name;
    if (!isSafePackagePath(entryPath)) {
      fail('unsafe_entry_path', `archive entry "${entry.name}" is not a safe relative package path`);
    }
    if ((entry.externalAttributes & SYMLINK_MODE_MASK) === SYMLINK_MODE) {
      fail('symlink_entry', `archive entry "${entry.name}" is a symlink`);
    }
  }

  const manifestEntry = entriesByName.get(PLUGIN_MANIFEST_FILENAME);
  if (manifestEntry === undefined || manifestEntry.isDirectory) {
    fail('missing_manifest', 'plugin package must contain a root manifest.json file');
  }
  if (manifestEntry.uncompressedSize > PLUGIN_MANIFEST_READ_CAP) {
    fail('manifest_too_large', 'manifest.json exceeds the read cap');
  }
  const manifestRaw = readEntryData(manifestEntry);
  if (manifestRaw.length > PLUGIN_MANIFEST_READ_CAP) {
    fail('manifest_too_large', 'manifest.json exceeds the read cap');
  }
  const manifestSha256 = sha256Hex(manifestRaw);

  let signatureStatus: PluginSignatureStatus;
  const signatureEntry = entriesByName.get(PLUGIN_SIGNATURE_FILENAME);
  if (signatureEntry !== undefined) {
    if (signatureEntry.isDirectory) {
      fail('invalid_signature_file', 'signature.json must be a regular file');
    }
    if (signatureEntry.uncompressedSize > PLUGIN_SIGNATURE_READ_CAP) {
      fail('signature_too_large', 'signature.json exceeds the read cap');
    }
    const signatureRaw = readEntryData(signatureEntry);
    if (signatureRaw.length > PLUGIN_SIGNATURE_READ_CAP) {
      fail('signature_too_large', 'signature.json exceeds the read cap');
    }
    try {
      verifyPluginSignature({
        manifestRaw,
        signatureRaw,
        trustedPublishers: input.trustedPublishers,
      });
      signatureStatus = 'trusted';
    } catch (error) {
      throw packageErrorFrom(error);
    }
  } else if (input.allowUnsigned) {
    signatureStatus = 'unsigned';
  } else {
    fail('unsigned_plugin_rejected', 'plugin package is unsigned and unsigned installs are not allowed');
  }

  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(decodeManifestText(manifestRaw));
  } catch (error) {
    throw packageErrorFrom(error);
  }

  // BIDIRECTIONAL reconciliation: the archive (minus manifest.json /
  // signature.json and directory entries) and manifest.files must be the
  // same set — extra archive bytes are undeclared, missing ones are lies.
  const archiveFiles = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name === PLUGIN_MANIFEST_FILENAME || isPluginSignatureFile(entry.name)) continue;
    archiveFiles.add(entry.name);
  }
  for (const name of archiveFiles) {
    if (!(name in manifest.files)) fail('undeclared_file', `archive file "${name}" is not declared in the manifest`);
  }
  for (const name of Object.keys(manifest.files)) {
    if (!archiveFiles.has(name)) fail('missing_declared_file', `declared file "${name}" is missing from the archive`);
  }

  // First uncompressed budget pass over the DECLARED sizes of the plugin
  // file set. manifest.json / signature.json are excluded — they carry their
  // own read caps — so this pass measures exactly what the extraction pass
  // below counts against the same budget.
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name === PLUGIN_MANIFEST_FILENAME || isPluginSignatureFile(entry.name)) continue;
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > maxUncompressedBytes) {
      fail('uncompressed_size_exceeded', 'archive uncompressed size exceeds the budget');
    }
  }

  // The entrypoint bytes are read eagerly so the verdict carries the real
  // entrypoint digest (and a tampered entrypoint fails closed before any
  // extraction is attempted).
  const entrypointEntry = entriesByName.get(manifest.entrypoint);
  if (entrypointEntry === undefined) {
    fail('missing_declared_file', `declared file "${manifest.entrypoint}" is missing from the archive`);
  }
  const entrypointSha256 = sha256Hex(readEntryData(entrypointEntry));
  if (entrypointSha256 !== manifest.files[manifest.entrypoint]) {
    fail('file_hash_mismatch', `entrypoint "${manifest.entrypoint}" does not match its declared hash`);
  }

  const extractTo = async (dir: string): Promise<void> => {
    // Second budget pass over the ACTUAL inflated bytes, plus full hash
    // verification, BEFORE any filesystem write.
    const planned: Array<{ name: string; data: Buffer; mode: number }> = [];
    let actualTotal = 0;
    for (const name of Object.keys(manifest.files)) {
      const entry = entriesByName.get(name);
      if (entry === undefined) {
        fail('missing_declared_file', `declared file "${name}" is missing from the archive`);
      }
      const data = readEntryData(entry);
      actualTotal += data.length;
      if (actualTotal > maxUncompressedBytes) {
        fail('uncompressed_size_exceeded', 'actual inflated size exceeds the budget');
      }
      const digest = sha256Hex(data);
      if (digest !== manifest.files[name]) {
        fail('file_hash_mismatch', `file "${name}" does not match its declared hash`);
      }
      planned.push({ name, data, mode: name === manifest.entrypoint ? ENTRYPOINT_MODE : FILE_MODE });
    }
    for (const item of planned) {
      const target = path.join(dir, item.name);
      await mkdir(path.dirname(target), { recursive: true, mode: DIRECTORY_MODE });
      const handle = await open(target, 'wx', item.mode);
      try {
        await handle.writeFile(item.data);
      } finally {
        await handle.close();
      }
    }
  };

  return {
    manifest,
    manifestSha256,
    manifestRaw,
    signatureStatus,
    entrypoint: manifest.entrypoint,
    entrypointSha256,
    files: manifest.files,
    extractTo,
  };
}
