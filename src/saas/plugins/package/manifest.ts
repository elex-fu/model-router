/**
 * Batch-5 §5.1 plugin manifest schema (task #24; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.1; sub2api reference:
 * backend/internal/service/plugin_manifest.go).
 *
 * A manifest is a strict, exactly-keyed JSON object: unknown keys, missing
 * keys, and out-of-range values are all rejected with stable snake_case
 * codes (fail-closed — never "ignore what we do not understand"). Capability
 * ids must come from PLUGIN_CAPABILITY_IDS; requires.plugin_protocol /
 * transport_api must match the shipped wire versions; requires.model_router
 * is an AND-semantics semver range evaluated against PLUGIN_HOST_VERSION by
 * evaluatePluginCompatibility. The semver parser and range matcher are
 * implemented from scratch (core-only comparison; prerelease tags are
 * deliberately ignored for host compatibility decisions).
 */

import {
  PLUGIN_CAPABILITY_IDS,
  PLUGIN_HOST_VERSION,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_TRANSPORT_API_VERSION,
  type PluginCapabilityId,
  type PluginManifest,
} from '../types.js';

export const PLUGIN_MANIFEST_FILENAME = 'manifest.json';
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 512;

const MAX_ID_LENGTH = 160;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_AUTHOR_LENGTH = 160;
const MAX_PATH_LENGTH = 512;

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RANGE_TOKEN_PATTERN = /^(>=|<=|>|<|=)?(.+)$/;

const MANIFEST_KEYS = [
  'schema_version',
  'id',
  'name',
  'version',
  'description',
  'author',
  'requires',
  'capabilities',
  'entrypoint',
  'files',
] as const;
const REQUIRED_MANIFEST_KEYS = [
  'schema_version',
  'id',
  'name',
  'version',
  'requires',
  'capabilities',
  'entrypoint',
  'files',
] as const;
const REQUIRES_KEYS = ['model_router', 'plugin_protocol', 'transport_api'] as const;

export class PluginManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

function fail(code: string, message: string): never {
  throw new PluginManifestError(code, message);
}

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

/** Parse `v?MAJOR.MINOR.PATCH` with optional -prerelease / +build (from scratch). */
export function parseSemver(input: string): ParsedSemver | null {
  if (typeof input !== 'string') return null;
  const match = SEMVER_PATTERN.exec(input);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Core-only (prerelease-insensitive) comparison: -1, 0, or 1. */
function compareCore(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function splitRangeTokens(range: string): string[] | null {
  const tokens = range.split(/[\s,]+/).filter((token) => token.length > 0);
  return tokens.length > 0 ? tokens : null;
}

function isValidSemverRange(range: string): boolean {
  const tokens = splitRangeTokens(range);
  if (tokens === null) return false;
  for (const token of tokens) {
    const match = RANGE_TOKEN_PATTERN.exec(token);
    if (match === null) return false;
    if (parseSemver(match[2]) === null) return false;
  }
  return true;
}

/**
 * AND-semantics range match: every space- and/or comma-separated token
 * (`>=X`, `<=X`, `>X`, `<X`, `=X`, bare `X`) must match the version's core.
 * Empty or malformed ranges never match.
 */
export function semverRangeMatches(range: string, version: string): boolean {
  const parsedVersion = parseSemver(version);
  if (parsedVersion === null) return false;
  const tokens = splitRangeTokens(range);
  if (tokens === null) return false;
  for (const token of tokens) {
    const match = RANGE_TOKEN_PATTERN.exec(token);
    if (match === null) return false;
    const operator = match[1] ?? '=';
    const target = parseSemver(match[2]);
    if (target === null) return false;
    const comparison = compareCore(parsedVersion, target);
    const satisfied =
      operator === '>='
        ? comparison >= 0
        : operator === '<='
          ? comparison <= 0
          : operator === '>'
            ? comparison > 0
            : operator === '<'
              ? comparison < 0
              : comparison === 0;
    if (!satisfied) return false;
  }
  return true;
}

/** Safe relative package path: no absolute, traversal, backslash, NUL, or empty segments. */
export function isSafePackagePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/')) return false;
  if (path === '.' || path === '..') return false;
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
  }
  return true;
}

export function parsePluginManifest(raw: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('invalid_json', 'manifest.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('invalid_json', 'manifest must be a single JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(MANIFEST_KEYS as readonly string[]).includes(key)) {
      fail('unknown_key', `unknown manifest key "${key}"`);
    }
  }
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!(key in record)) fail('missing_key', `missing manifest key "${key}"`);
  }

  if (record.schema_version !== 1) fail('invalid_schema_version', 'schema_version must be 1');

  const id = record.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || !PLUGIN_ID_PATTERN.test(id)) {
    fail('invalid_id', 'id must be 1-160 chars of lowercase segments joined by ".", "_" or "-"');
  }

  const name = record.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    fail('invalid_name', 'name must be a non-empty string of at most 160 characters');
  }

  const version = record.version;
  if (typeof version !== 'string' || parseSemver(version) === null) {
    fail('invalid_version', 'version must be a valid semver string (optional leading "v")');
  }

  let description = '';
  if (record.description !== undefined) {
    if (typeof record.description !== 'string' || record.description.length > MAX_DESCRIPTION_LENGTH) {
      fail('invalid_description', 'description must be a string of at most 2000 characters');
    }
    description = record.description;
  }

  let author = '';
  if (record.author !== undefined) {
    if (typeof record.author !== 'string' || record.author.length > MAX_AUTHOR_LENGTH) {
      fail('invalid_author', 'author must be a string of at most 160 characters');
    }
    author = record.author;
  }

  const requires = record.requires;
  if (typeof requires !== 'object' || requires === null || Array.isArray(requires)) {
    fail('invalid_requires', 'requires must be an object');
  }
  const requiresRecord = requires as Record<string, unknown>;
  const requiresKeys = Object.keys(requiresRecord);
  if (requiresKeys.length !== REQUIRES_KEYS.length || !REQUIRES_KEYS.every((key) => key in requiresRecord)) {
    fail('invalid_requires', 'requires must have exactly the keys model_router, plugin_protocol, transport_api');
  }
  if (requiresRecord.plugin_protocol !== PLUGIN_PROTOCOL_VERSION) {
    fail('unsupported_plugin_protocol', `requires.plugin_protocol must be ${PLUGIN_PROTOCOL_VERSION}`);
  }
  if (requiresRecord.transport_api !== PLUGIN_TRANSPORT_API_VERSION) {
    fail('unsupported_transport_api', `requires.transport_api must be ${PLUGIN_TRANSPORT_API_VERSION}`);
  }
  const modelRouter = requiresRecord.model_router;
  if (typeof modelRouter !== 'string' || !isValidSemverRange(modelRouter)) {
    fail('invalid_model_router_requirement', 'requires.model_router must be a non-empty semver range string');
  }

  const capabilities = record.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    fail('invalid_capabilities', 'capabilities must be a non-empty array');
  }
  const capabilityIds: PluginCapabilityId[] = [];
  for (const capability of capabilities) {
    if (typeof capability !== 'object' || capability === null || Array.isArray(capability)) {
      fail('invalid_capabilities', 'each capability must be an object with exactly the key "id"');
    }
    const capabilityKeys = Object.keys(capability);
    if (capabilityKeys.length !== 1 || capabilityKeys[0] !== 'id') {
      fail('invalid_capabilities', 'each capability must be an object with exactly the key "id"');
    }
    const capabilityId = (capability as { id: unknown }).id;
    if (typeof capabilityId !== 'string' || !(PLUGIN_CAPABILITY_IDS as readonly string[]).includes(capabilityId)) {
      fail('unsupported_capability', `capability "${String(capabilityId)}" is not supported`);
    }
    if (capabilityIds.includes(capabilityId as PluginCapabilityId)) {
      fail('duplicate_capability', `capability "${capabilityId}" is declared more than once`);
    }
    capabilityIds.push(capabilityId as PluginCapabilityId);
  }

  const files = record.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    fail('invalid_files', 'files must be an object mapping paths to sha256 hex digests');
  }
  const filesRecord = files as Record<string, unknown>;
  const fileNames = Object.keys(filesRecord);
  if (fileNames.length === 0) fail('invalid_files', 'files must declare at least one file');
  if (fileNames.length > MAX_MANIFEST_FILES) {
    fail('too_many_files', `files must declare at most ${MAX_MANIFEST_FILES} entries`);
  }
  for (const fileName of fileNames) {
    const hash = filesRecord[fileName];
    if (typeof hash !== 'string' || !SHA256_HEX_PATTERN.test(hash)) {
      fail('invalid_file_hash', `files["${fileName}"] must be a lowercase sha256 hex digest`);
    }
    if (!isSafePackagePath(fileName)) {
      fail('invalid_file_path', `files key "${fileName}" is not a safe relative package path`);
    }
  }

  const entrypoint = record.entrypoint;
  if (typeof entrypoint !== 'string' || !isSafePackagePath(entrypoint)) {
    fail('invalid_entrypoint', 'entrypoint must be a safe relative package path');
  }
  if (!(entrypoint in filesRecord)) {
    fail('invalid_entrypoint', 'entrypoint must be one of the declared files');
  }

  return {
    schemaVersion: 1,
    id,
    name,
    version: version.replace(/^v/, ''),
    description,
    author,
    requires: {
      modelRouter,
      pluginProtocol: PLUGIN_PROTOCOL_VERSION,
      transportApi: PLUGIN_TRANSPORT_API_VERSION,
    },
    capabilities: capabilityIds.map((capabilityId) => ({ id: capabilityId })),
    entrypoint,
    files: Object.fromEntries(fileNames.map((fileName) => [fileName, filesRecord[fileName] as string])),
  };
}

/** Host-side compatibility verdict with a stable reason code (never a free-text guess). */
export function evaluatePluginCompatibility(manifest: PluginManifest): {
  state: 'compatible' | 'incompatible';
  reason: string | null;
} {
  if (manifest.requires.pluginProtocol !== PLUGIN_PROTOCOL_VERSION) {
    return { state: 'incompatible', reason: 'plugin_protocol_unsupported' };
  }
  if (manifest.requires.transportApi !== PLUGIN_TRANSPORT_API_VERSION) {
    return { state: 'incompatible', reason: 'transport_api_unsupported' };
  }
  if (!semverRangeMatches(manifest.requires.modelRouter, PLUGIN_HOST_VERSION)) {
    return { state: 'incompatible', reason: 'model_router_version_unsupported' };
  }
  return { state: 'compatible', reason: null };
}
