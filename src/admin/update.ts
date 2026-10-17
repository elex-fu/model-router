import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ControlError } from '../control/service.js';

/**
 * Batch 5 §5.3 online update (task #21; sub2api
 * backend/internal/service/update_service.go reference, 669 lines) ported to
 * the BYOK admin face.
 *
 * What survived the port verbatim in spirit:
 * - 20-minute check cache with cached-fallback on GitHub errors;
 * - 3-segment semver comparison (v-prefix and -suffix stripped);
 * - download URL allowlist (github.com / objects.githubusercontent.com and
 *   their subdomains, HTTPS only) as the SSRF fence;
 * - checksums.txt line-by-line SHA-256 verification;
 * - extraction restricted to the single target binary (path traversal
 *   rejected, size-capped reads);
 * - two-step atomic swap (rename exe→backup, rename new→exe, restore the
 *   backup when the second rename fails; the backup survives until the next
 *   successful update);
 * - rollback whitelist: the three most recent stable releases strictly older
 *   than the running version out of the last 15 fetched releases.
 *
 * Deliberate deviations, each with its reason:
 * - The "executable" is the deployment's target file: `MODEL_ROUTER_UPDATE_TARGET`
 *   (absolute path) or the resolved process entry (`process.argv[1]`). The
 *   temp directory is created next to the target so both renames stay on one
 *   filesystem and remain atomic (the sub2api rule).
 * - Release assets are tar.gz archives containing one `model-router`
 *   (`model-router.exe` on Windows) file, or a raw binary asset. Node has no
 *   stdlib tar reader, so this file ships a minimal ustar reader (~90 lines)
 *   rather than taking a dependency (the repo's zero-new-dependency posture;
 *   downloads ride the bundled undici `fetch`).
 * - Restart is not a self-restart: POST /admin/api/v1/system/restart answers,
 *   then exits(0) 500 ms later and relies on a supervisor (systemd
 *   `Restart=always`). Under `docker compose` the container is replaced, not
 *   restarted — the response body says so and the console must surface it.
 *
 * Cache decision (recorded per the task brief): the gateway deployment
 * contract has no Redis, and the control-plane Redis (MODEL_ROUTER_SAAS_
 * REDIS_URL) belongs to the managed control-plane workload, not the BYOK
 * admin face this service lives on. The BYOK admin is a single-process,
 * single-administrator listener whose only always-present durable store is
 * the control SQLite database, so the 20-minute check cache persists there
 * (SqliteUpdateCheckCache); an in-memory implementation covers tests and
 * callers without a store.
 */

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/** Parses `v?MAJOR.MINOR.PATCH(-suffix)?` into three integers (missing = 0). */
export function parseSemver(version: string): [number, number, number] {
  let value = String(version ?? '').trim();
  if (value.startsWith('v') || value.startsWith('V')) value = value.slice(1);
  const dash = value.indexOf('-');
  if (dash !== -1) value = value.slice(0, dash);
  const parts = value.split('.');
  const result: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < 3 && index < parts.length; index += 1) {
    const parsed = Number.parseInt(parts[index] ?? '', 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === (parts[index] ?? '').trim()) {
      result[index] = parsed;
    }
  }
  return result;
}

/** Returns <0 when `a` is older than `b`, 0 when equal, >0 when newer. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Download URL allowlist (SSRF fence)
// ---------------------------------------------------------------------------

export type UpdateUrlValidationError = 'INVALID_URL' | 'NOT_HTTPS' | 'UNTRUSTED_HOST' | 'URL_CREDENTIALS';

const ALLOWED_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com'] as const;

/**
 * Only HTTPS URLs on github.com / objects.githubusercontent.com (or their
 * subdomains) may be fetched; credentials in the URL are rejected. Every
 * other host — including `github.com.evil.example` and
 * `https://evil.example/github.com` — fails closed.
 */
export function validateUpdateDownloadUrl(rawUrl: string): UpdateUrlValidationError | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    return 'INVALID_URL';
  }
  if (parsed.protocol !== 'https:') return 'NOT_HTTPS';
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return 'UNTRUSTED_HOST';
  }
  if (parsed.username !== '' || parsed.password !== '') return 'URL_CREDENTIALS';
  return null;
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

export type ChecksumError = 'CHECKSUM_NOT_FOUND' | 'CHECKSUM_MISMATCH';

/** Parses `sha256  filename` lines (any whitespace separator). */
export function parseChecksumFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 2) continue;
    const [hash, name] = fields as [string, string];
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    result.set(name, hash.toLowerCase());
  }
  return result;
}

/** Verifies a downloaded file's SHA-256 against a parsed checksums.txt map. */
export async function verifySha256Checksum(
  filePath: string,
  checksums: ReadonlyMap<string, string>,
  fileName: string,
): Promise<ChecksumError | null> {
  const expected = checksums.get(fileName);
  if (expected === undefined) return 'CHECKSUM_NOT_FOUND';
  const actual = createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
  return actual === expected ? null : 'CHECKSUM_MISMATCH';
}

// ---------------------------------------------------------------------------
// Minimal ustar tar reader (zero dependencies)
// ---------------------------------------------------------------------------

export type ExtractionError =
  | 'ARCHIVE_TOO_LARGE'
  | 'PATH_TRAVERSAL'
  | 'BINARY_NOT_IN_ARCHIVE'
  | 'BINARY_TOO_LARGE'
  | 'MALFORMED_ARCHIVE';

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_BINARY_BYTES = 500 * 1024 * 1024;

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header
    .toString('utf8', offset, offset + length)
    .replace(/\0.*$/, '')
    .trim();
  if (text.length === 0) return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function readString(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset);
  return header.toString('utf8', offset, end === -1 ? offset + length : end).trim();
}

/**
 * Extracts the single entry whose basename matches one of `entryNames` from a
 * gzipped ustar archive. Any member name containing `..` or an absolute path
 * fails the whole extraction (the sub2api Zip-Slip fence); reads are capped at
 * both the archive and the extracted binary size.
 */
export function extractBinaryFromTarGz(
  archive: Buffer,
  entryNames: readonly string[],
  options: { maxArchiveBytes?: number; maxBinaryBytes?: number } = {},
): Buffer {
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxBinaryBytes = options.maxBinaryBytes ?? MAX_BINARY_BYTES;
  if (archive.byteLength > maxArchiveBytes)
    throw new UpdateError('ARCHIVE_TOO_LARGE', 'release archive exceeds the size cap');
  let inflated: Buffer;
  try {
    inflated = gunzipSync(archive);
  } catch {
    throw new UpdateError('MALFORMED_ARCHIVE', 'release archive is not valid gzip');
  }
  if (inflated.byteLength > maxArchiveBytes)
    throw new UpdateError('ARCHIVE_TOO_LARGE', 'inflated archive exceeds the size cap');
  const wanted = new Set(entryNames.map((name) => basename(name)));
  let offset = 0;
  while (offset + 512 <= inflated.byteLength) {
    const header = inflated.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    let name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    if (prefix.length > 0) name = `${prefix}/${name}`;
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new UpdateError('MALFORMED_ARCHIVE', 'unparseable tar entry size');
    const typeFlag = String.fromCharCode(header[156] ?? 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > inflated.byteLength) throw new UpdateError('MALFORMED_ARCHIVE', 'truncated tar entry');
    // SECURITY: reject traversal in ANY member, not just the extracted one —
    // a hostile archive must fail closed before any byte is trusted.
    if (name.includes('..') || name.startsWith('/')) {
      throw new UpdateError('PATH_TRAVERSAL', `path traversal entry in archive: ${name.slice(0, 120)}`);
    }
    if ((typeFlag === '0' || typeFlag === '\0') && wanted.has(basename(name))) {
      if (size > maxBinaryBytes) throw new UpdateError('BINARY_TOO_LARGE', 'extracted binary exceeds the size cap');
      return Buffer.from(inflated.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new UpdateError('BINARY_NOT_IN_ARCHIVE', `release archive does not contain ${entryNames.join(' or ')}`);
}

// ---------------------------------------------------------------------------
// Two-step atomic swap
// ---------------------------------------------------------------------------

export interface FileSwapOps {
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const nodeFileSwapOps: FileSwapOps = {
  rename: (from, to) => rename(from, to),
  remove: async (path) => {
    try {
      await rm(path, { force: true });
    } catch {
      // A missing stale backup is the expected case.
    }
  },
};

export interface FileSwapResult {
  readonly replaced: boolean;
  readonly backupPath: string;
}

/**
 * rename(target → backup) then rename(new → target). The second rename
 * failing restores the backup; a restore failure is reported distinctly so
 * the operator knows the directory now holds only the `.backup` file.
 */
export async function swapInNewBinary(input: {
  targetPath: string;
  newBinaryPath: string;
  ops?: FileSwapOps;
}): Promise<FileSwapResult> {
  const ops = input.ops ?? nodeFileSwapOps;
  const backupPath = `${input.targetPath}.backup`;
  await ops.remove(backupPath);
  try {
    await ops.rename(input.targetPath, backupPath);
  } catch (error) {
    throw new UpdateError('BACKUP_FAILED', `could not move the current binary aside: ${describe(error)}`);
  }
  try {
    await ops.rename(input.newBinaryPath, input.targetPath);
  } catch (replaceError) {
    try {
      await ops.rename(backupPath, input.targetPath);
    } catch (restoreError) {
      throw new UpdateError(
        'REPLACE_AND_RESTORE_FAILED',
        `replace failed (${describe(replaceError)}) and restoring the backup also failed (${describe(restoreError)}); ` +
          `the previous binary is preserved at ${backupPath}`,
      );
    }
    throw new UpdateError('REPLACE_FAILED_RESTORED', `replace failed, backup restored: ${describe(replaceError)}`);
  }
  return { replaced: true, backupPath };
}

// ---------------------------------------------------------------------------
// GitHub client (bundled undici fetch, zero new dependencies)
// ---------------------------------------------------------------------------

export interface GitHubAsset {
  readonly name: string;
  readonly downloadUrl: string;
  readonly size: number;
}

export interface GitHubRelease {
  readonly tagName: string;
  readonly name: string;
  readonly body: string;
  readonly publishedAt: string;
  readonly htmlUrl: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly GitHubAsset[];
}

interface GitHubApiRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface UpdateHttpClient {
  fetchLatestRelease(): Promise<GitHubRelease>;
  fetchRecentReleases(perPage: number): Promise<GitHubRelease[]>;
  download(url: string): Promise<Buffer>;
  fetchChecksumFile(url: string): Promise<Buffer>;
}

export const UPDATE_GITHUB_REPO_ENV = 'MODEL_ROUTER_UPDATE_GITHUB_REPO' as const;
export const UPDATE_GITHUB_TOKEN_ENV = 'MODEL_ROUTER_UPDATE_GITHUB_TOKEN' as const;
export const UPDATE_TARGET_ENV = 'MODEL_ROUTER_UPDATE_TARGET' as const;
export const UPDATE_VERSION_ENV = 'MODEL_ROUTER_VERSION' as const;
export const UPDATE_BUILD_TYPE_ENV = 'MODEL_ROUTER_BUILD_TYPE' as const;

function toAsset(asset: unknown): GitHubAsset | null {
  if (!asset || typeof asset !== 'object') return null;
  const record = asset as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.browser_download_url !== 'string') return null;
  return {
    name: record.name,
    downloadUrl: record.browser_download_url,
    size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0,
  };
}

function toRelease(value: unknown): GitHubRelease {
  const record = (value ?? {}) as GitHubApiRelease;
  const assets = Array.isArray(record.assets)
    ? record.assets.map(toAsset).filter((a): a is GitHubAsset => a !== null)
    : [];
  return {
    tagName: typeof record.tag_name === 'string' ? record.tag_name : '',
    name: typeof record.name === 'string' ? record.name : '',
    body: typeof record.body === 'string' ? record.body : '',
    publishedAt: typeof record.published_at === 'string' ? record.published_at : '',
    htmlUrl: typeof record.html_url === 'string' ? record.html_url : '',
    draft: record.draft === true,
    prerelease: record.prerelease === true,
    assets,
  };
}

export interface FetchUpdateHttpClientOptions {
  readonly repo: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxDownloadBytes?: number;
}

/** GitHub API + asset download client on the bundled undici `fetch`. */
export function createFetchUpdateHttpClient(options: FetchUpdateHttpClientOptions): UpdateHttpClient {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_ARCHIVE_BYTES;
  const apiHeaders: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'model-router-update/1',
  };
  if (options.token !== undefined && options.token.length > 0) {
    apiHeaders.authorization = `Bearer ${options.token}`;
  }
  const assertTrusted = (url: string, what: string): void => {
    const violation = validateUpdateDownloadUrl(url);
    if (violation !== null) {
      throw new UpdateError('INVALID_DOWNLOAD_URL', `${what} URL rejected (${violation}): ${url.slice(0, 200)}`);
    }
  };
  const fetchJson = async (url: string): Promise<unknown> => {
    const response = await fetchFn(url, { headers: apiHeaders });
    if (!response.ok) {
      throw new UpdateError('GITHUB_API_ERROR', `GitHub request failed with status ${response.status}`);
    }
    return (await response.json()) as unknown;
  };
  const fetchBytes = async (url: string): Promise<Buffer> => {
    assertTrusted(url, 'download');
    const response = await fetchFn(url, { headers: { 'user-agent': 'model-router-update/1' } });
    if (!response.ok) {
      throw new UpdateError('DOWNLOAD_FAILED', `download failed with status ${response.status}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader === undefined) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxDownloadBytes)
        throw new UpdateError('ARCHIVE_TOO_LARGE', 'download exceeds the size cap');
      return buffer;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > maxDownloadBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpdateError('ARCHIVE_TOO_LARGE', 'download exceeds the size cap');
      }
      chunks.push(Buffer.from(value ?? new Uint8Array()));
    }
    return Buffer.concat(chunks);
  };
  return {
    async fetchLatestRelease() {
      return toRelease(await fetchJson(`https://api.github.com/repos/${options.repo}/releases/latest`));
    },
    async fetchRecentReleases(perPage: number) {
      const payload = await fetchJson(`https://api.github.com/repos/${options.repo}/releases?per_page=${perPage}`);
      if (!Array.isArray(payload)) throw new UpdateError('GITHUB_API_ERROR', 'GitHub releases response was not a list');
      return payload.map(toRelease);
    },
    download: (url) => fetchBytes(url),
    fetchChecksumFile: (url) => fetchBytes(url),
  };
}

// ---------------------------------------------------------------------------
// Check cache
// ---------------------------------------------------------------------------

export interface CachedUpdateCheck {
  readonly latestVersion: string;
  readonly release: ReleaseInfo;
  readonly fetchedAtMs: number;
}

export interface UpdateCheckCache {
  get(): Promise<CachedUpdateCheck | null>;
  set(value: CachedUpdateCheck): Promise<void>;
}

export const UPDATE_CACHE_TTL_MS = 20 * 60 * 1000;

export class InMemoryUpdateCheckCache implements UpdateCheckCache {
  private value: CachedUpdateCheck | null = null;
  async get(): Promise<CachedUpdateCheck | null> {
    return this.value;
  }
  async set(value: CachedUpdateCheck): Promise<void> {
    this.value = value;
  }
}

interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...values: unknown[]): unknown; run(...values: unknown[]): unknown };
}

/**
 * Persists the 20-minute check cache in the admin process's control SQLite
 * database (table `admin_update_cache`). See the module header for why this
 * plane uses SQLite rather than the control-plane Redis/PG.
 */
export class SqliteUpdateCheckCache implements UpdateCheckCache {
  constructor(private readonly db: SqliteLike) {
    db.exec(`CREATE TABLE IF NOT EXISTS admin_update_cache (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      payload TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL
    )`);
  }

  async get(): Promise<CachedUpdateCheck | null> {
    const row = this.db.prepare('SELECT payload, fetched_at_ms FROM admin_update_cache WHERE singleton = 1').get() as
      | { payload: string; fetched_at_ms: number }
      | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload) as CachedUpdateCheck;
      if (typeof parsed?.latestVersion !== 'string' || typeof parsed?.fetchedAtMs !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async set(value: CachedUpdateCheck): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO admin_update_cache (singleton, payload, fetched_at_ms) VALUES (1, ?, ?) ' +
          'ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms',
      )
      .run(JSON.stringify(value), value.fetchedAtMs);
  }
}

// ---------------------------------------------------------------------------
// Update service
// ---------------------------------------------------------------------------

export type UpdateErrorCode =
  | 'ALREADY_UP_TO_DATE'
  | 'ROLLBACK_VERSION_NOT_ALLOWED'
  | 'UPDATE_NOT_CONFIGURED'
  | 'NO_COMPATIBLE_ASSET'
  | 'INVALID_DOWNLOAD_URL'
  | 'DOWNLOAD_FAILED'
  | 'GITHUB_API_ERROR'
  | 'CHECKSUM_MISMATCH'
  | 'CHECKSUM_NOT_FOUND'
  | 'EXTRACTION_FAILED'
  | 'ARCHIVE_TOO_LARGE'
  | 'BINARY_TOO_LARGE'
  | 'PATH_TRAVERSAL'
  | 'BINARY_NOT_IN_ARCHIVE'
  | 'MALFORMED_ARCHIVE'
  | 'BACKUP_FAILED'
  | 'REPLACE_FAILED_RESTORED'
  | 'REPLACE_AND_RESTORE_FAILED'
  | 'SWAP_FAILED';

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}

export const MAX_ROLLBACK_VERSIONS = 3;
export const ROLLBACK_FETCH_PAGE_SIZE = 15;

export interface ReleaseInfo {
  readonly name: string;
  readonly body: string;
  readonly publishedAt: string;
  readonly htmlUrl: string;
  readonly assets: readonly GitHubAsset[];
}

export interface UpdateInfo {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly hasUpdate: boolean;
  readonly releaseInfo: ReleaseInfo | null;
  readonly cached: boolean;
  readonly warning: string | null;
  readonly buildType: 'source' | 'release';
}

export interface RollbackVersion {
  readonly version: string;
  readonly publishedAt: string;
  readonly htmlUrl: string;
}

export interface UpdateServiceOptions {
  readonly currentVersion: string;
  readonly buildType: 'source' | 'release';
  readonly repo: string | undefined;
  readonly client: UpdateHttpClient;
  readonly cache: UpdateCheckCache;
  readonly platform?: string;
  readonly arch?: string;
  readonly targetPath?: string;
  readonly binaryNames?: readonly string[];
  readonly fileOps?: FileSwapOps;
  readonly now?: () => number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface UpdateResult {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly backupPath: string;
}

function trimVersionTag(version: string): string {
  const value = String(version ?? '').trim();
  return value.startsWith('v') || value.startsWith('V') ? value.slice(1) : value;
}

export class UpdateService {
  private readonly platform: string;
  private readonly arch: string;
  private readonly targetPath: string | undefined;
  private readonly binaryNames: readonly string[];
  private readonly fileOps: FileSwapOps;
  private readonly now: () => number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.targetPath = options.targetPath;
    this.binaryNames = options.binaryNames ?? (this.platform === 'win32' ? ['model-router.exe'] : ['model-router']);
    this.fileOps = options.fileOps ?? nodeFileSwapOps;
    this.now = options.now ?? (() => Date.now());
  }

  versionInfo(): { version: string; buildType: 'source' | 'release'; platform: string; arch: string } {
    return {
      version: this.options.currentVersion,
      buildType: this.options.buildType,
      platform: this.platform,
      arch: this.arch,
    };
  }

  async checkUpdate(force = false): Promise<UpdateInfo> {
    const base = {
      currentVersion: this.options.currentVersion,
      buildType: this.options.buildType,
    };
    if (this.options.repo === undefined) {
      return {
        ...base,
        latestVersion: this.options.currentVersion,
        hasUpdate: false,
        releaseInfo: null,
        cached: false,
        warning: `update repository not configured; set ${UPDATE_GITHUB_REPO_ENV}`,
      };
    }
    if (!force) {
      const cached = await this.options.cache.get();
      if (cached !== null && this.now() - cached.fetchedAtMs <= UPDATE_CACHE_TTL_MS) {
        return this.infoFrom(base, cached.latestVersion, cached.release, true, null);
      }
    }
    try {
      const release = await this.options.client.fetchLatestRelease();
      const latest = trimVersionTag(release.tagName);
      const info = this.infoFrom(base, latest, toReleaseInfo(release), false, null);
      await this.options.cache.set({
        latestVersion: latest,
        release: info.releaseInfo ?? { name: '', body: '', publishedAt: '', htmlUrl: '', assets: [] },
        fetchedAtMs: this.now(),
      });
      return info;
    } catch (error) {
      const cached = await this.options.cache.get();
      if (cached !== null) {
        return this.infoFrom(base, cached.latestVersion, cached.release, true, `using cached data: ${describe(error)}`);
      }
      return {
        ...base,
        latestVersion: this.options.currentVersion,
        hasUpdate: false,
        releaseInfo: null,
        cached: false,
        warning: describe(error),
      };
    }
  }

  async performUpdate(): Promise<UpdateResult> {
    const info = await this.checkUpdate(true);
    if (!info.hasUpdate || info.releaseInfo === null) {
      throw new UpdateError('ALREADY_UP_TO_DATE', 'no update available; the current version is the latest');
    }
    const backupPath = await this.applyReleaseAssets(info.releaseInfo.assets);
    return { fromVersion: this.options.currentVersion, toVersion: info.latestVersion, backupPath };
  }

  async listRollbackVersions(): Promise<RollbackVersion[]> {
    const candidates = await this.fetchRollbackCandidates();
    return candidates.map((release) => ({
      version: trimVersionTag(release.tagName),
      publishedAt: release.publishedAt,
      htmlUrl: release.htmlUrl,
    }));
  }

  async rollbackToVersion(version: string): Promise<UpdateResult> {
    const target = trimVersionTag(String(version ?? ''));
    if (target.length === 0) {
      throw new UpdateError('ROLLBACK_VERSION_NOT_ALLOWED', 'a rollback version is required');
    }
    const candidates = await this.fetchRollbackCandidates();
    const match = candidates.find((release) => trimVersionTag(release.tagName) === target);
    if (match === undefined) {
      throw new UpdateError(
        'ROLLBACK_VERSION_NOT_ALLOWED',
        'version is not in the allowed rollback list (the three most recent stable releases older than the current version)',
      );
    }
    const backupPath = await this.applyReleaseAssets(match.assets);
    return { fromVersion: this.options.currentVersion, toVersion: target, backupPath };
  }

  private infoFrom(
    base: Pick<UpdateInfo, 'currentVersion' | 'buildType'>,
    latest: string,
    release: ReleaseInfo | null,
    cached: boolean,
    warning: string | null,
  ): UpdateInfo {
    return {
      ...base,
      latestVersion: latest,
      hasUpdate: compareSemver(base.currentVersion, latest) < 0,
      releaseInfo: release,
      cached,
      warning,
    };
  }

  private async fetchRollbackCandidates(): Promise<GitHubRelease[]> {
    if (this.options.repo === undefined) {
      throw new UpdateError('UPDATE_NOT_CONFIGURED', `update repository not configured; set ${UPDATE_GITHUB_REPO_ENV}`);
    }
    const releases = await this.options.client.fetchRecentReleases(ROLLBACK_FETCH_PAGE_SIZE);
    // Dedupe on the normalized 3-segment version so `v0.4.0` and `v0.4.0-rc1`
    // collapse to one candidate (the strict-older filter already uses the
    // same normalization).
    const seen = new Set<string>();
    const candidates: GitHubRelease[] = [];
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const version = trimVersionTag(release.tagName);
      if (version.length === 0) continue;
      const key = parseSemver(version).join('.');
      if (seen.has(key)) continue;
      // Only strictly older stable versions (also excludes the current one).
      if (compareSemver(version, this.options.currentVersion) >= 0) continue;
      seen.add(key);
      candidates.push(release);
    }
    candidates.sort((left, right) => compareSemver(trimVersionTag(right.tagName), trimVersionTag(left.tagName)));
    return candidates.slice(0, MAX_ROLLBACK_VERSIONS);
  }

  /**
   * Shared by performUpdate (latest) and rollbackToVersion (a whitelisted
   * older release): pick the platform archive + checksums.txt, verify both
   * URLs against the allowlist, download into a temp directory next to the
   * target (same filesystem ⇒ atomic renames), verify the SHA-256, extract
   * only the target binary, and run the two-step swap.
   */
  private async applyReleaseAssets(assets: readonly GitHubAsset[]): Promise<string> {
    if (this.options.buildType !== 'release') {
      throw new UpdateError(
        'NO_COMPATIBLE_ASSET',
        'this deployment is a source build; release assets are only matched for release builds',
      );
    }
    if (this.targetPath === undefined) {
      throw new UpdateError('UPDATE_NOT_CONFIGURED', 'no update target path could be resolved');
    }
    const archiveNeedle = `${this.platform}_${this.arch}`;
    let archiveUrl: string | undefined;
    let checksumUrl: string | undefined;
    let archiveName = '';
    for (const asset of assets) {
      if (asset.name.includes(archiveNeedle) && !asset.name.endsWith('.txt') && !asset.name.endsWith('.json')) {
        archiveUrl = asset.downloadUrl;
        archiveName = asset.name;
      }
      if (asset.name === 'checksums.txt') checksumUrl = asset.downloadUrl;
    }
    if (archiveUrl === undefined) {
      throw new UpdateError(
        'NO_COMPATIBLE_ASSET',
        `no compatible release asset found for ${this.platform}/${this.arch}`,
      );
    }
    const archiveViolation = validateUpdateDownloadUrl(archiveUrl);
    if (archiveViolation !== null)
      throw new UpdateError('INVALID_DOWNLOAD_URL', `archive URL rejected (${archiveViolation})`);
    if (checksumUrl !== undefined) {
      const checksumViolation = validateUpdateDownloadUrl(checksumUrl);
      if (checksumViolation !== null)
        throw new UpdateError('INVALID_DOWNLOAD_URL', `checksum URL rejected (${checksumViolation})`);
    }

    const targetDir = dirname(this.targetPath);
    const tempDir = resolve(targetDir, `.model-router-update-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    try {
      const archivePath = resolve(tempDir, archiveName || 'release-archive');
      await writeFile(archivePath, await this.options.client.download(archiveUrl));
      if (checksumUrl !== undefined) {
        const checksums = parseChecksumFile(
          (await this.options.client.fetchChecksumFile(checksumUrl)).toString('utf8'),
        );
        const violation = await verifySha256Checksum(archivePath, checksums, basename(archivePath));
        if (violation !== null) throw new UpdateError(violation, `checksum verification failed (${violation})`);
      }
      const downloaded = await readFile(archivePath);
      let binary: Buffer;
      try {
        binary = /\.(tar\.gz|tgz|tar)$/.test(archiveName)
          ? extractBinaryFromTarGz(downloaded, this.binaryNames)
          : downloaded;
      } catch (error) {
        if (error instanceof UpdateError) {
          throw new UpdateError('EXTRACTION_FAILED', `${error.code}: ${error.message}`);
        }
        throw new UpdateError('EXTRACTION_FAILED', describe(error));
      }
      if (binary.byteLength === 0 || binary.byteLength > MAX_BINARY_BYTES) {
        throw new UpdateError('BINARY_TOO_LARGE', 'extracted binary is empty or exceeds the size cap');
      }
      const newBinaryPath = resolve(tempDir, 'model-router.new');
      await writeFile(newBinaryPath, binary, { mode: 0o755 });
      try {
        const swap = await swapInNewBinary({ targetPath: this.targetPath, newBinaryPath, ops: this.fileOps });
        return swap.backupPath;
      } catch (error) {
        if (error instanceof UpdateError) throw error;
        throw new UpdateError('SWAP_FAILED', describe(error));
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function toReleaseInfo(release: GitHubRelease): ReleaseInfo {
  return {
    name: release.name,
    body: release.body,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl,
    assets: release.assets,
  };
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UPDATE_ERROR_STATUS: Partial<Record<UpdateErrorCode, number>> = {
  ALREADY_UP_TO_DATE: 409,
  ROLLBACK_VERSION_NOT_ALLOWED: 400,
  UPDATE_NOT_CONFIGURED: 503,
  NO_COMPATIBLE_ASSET: 409,
  INVALID_DOWNLOAD_URL: 502,
  DOWNLOAD_FAILED: 502,
  GITHUB_API_ERROR: 502,
};

/** Maps update failures onto the admin face's ControlError envelope. */
export function updateHttpError(error: unknown): unknown {
  if (error instanceof UpdateError) {
    return new ControlError(UPDATE_ERROR_STATUS[error.code] ?? 500, error.code, error.message);
  }
  return error;
}

// ---------------------------------------------------------------------------
// Idempotent operation guard (Idempotency-Key + in-flight lock)
// ---------------------------------------------------------------------------

const MAX_GUARD_MEMO = 32;

export interface GuardedOperationOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}

/**
 * Single-process Idempotency-Key guard for the mutating update endpoints,
 * following the quota-adjustments precedent (IDEMPOTENCY_CONFLICT on a key
 * reuse with different parameters; here any reuse replays the recorded
 * outcome): a key currently in flight is refused with 409, a completed key
 * replays its stored result. The memo is bounded; the admin face is
 * single-administrator so replay horizon beyond the process lifetime is not
 * a contract.
 */
export class UpdateOperationGuard {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly memo = new Map<string, unknown>();

  async run<T>(key: string | undefined, operation: () => Promise<T>): Promise<GuardedOperationOutcome<T>> {
    if (typeof key !== 'string' || key.trim().length === 0 || key.length > 200) {
      throw new ControlError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'An Idempotency-Key header (1-200 characters) is required',
      );
    }
    const normalized = key.trim();
    if (this.memo.has(normalized)) {
      return { result: this.memo.get(normalized) as T, replayed: true };
    }
    if (this.inFlight.has(normalized)) {
      throw new ControlError(409, 'OPERATION_IN_PROGRESS', 'An operation with this Idempotency-Key is already running');
    }
    const promise = (async () => {
      try {
        const result = await operation();
        if (this.memo.size >= MAX_GUARD_MEMO) {
          const oldest = this.memo.keys().next().value;
          if (oldest !== undefined) this.memo.delete(oldest);
        }
        this.memo.set(normalized, result);
        return result;
      } finally {
        this.inFlight.delete(normalized);
      }
    })();
    this.inFlight.set(normalized, promise);
    return { result: (await promise) as T, replayed: false };
  }
}

// ---------------------------------------------------------------------------
// Restart + runtime identity resolution
// ---------------------------------------------------------------------------

export const RESTART_DELAY_MS = 500;

export interface RestartSchedule {
  readonly delayMs: number;
  readonly scheduledAt: string;
}

let restartTimer: NodeJS.Timeout | undefined;

/**
 * Schedules `exit(0)` after `delayMs` (default 500 ms — enough for the HTTP
 * response and the audit row to flush). Not a self-restart: recovery is the
 * supervisor's job (systemd `Restart=always`). Under `docker compose` the
 * container is recreated, so anything not on a volume is lost — the restart
 * endpoint's response spells this out.
 */
export function scheduleProcessRestart(
  options: { delayMs?: number; exit?: (code: number) => never } = {},
): RestartSchedule {
  if (restartTimer !== undefined) return { delayMs: 0, scheduledAt: new Date().toISOString() };
  const delayMs = options.delayMs ?? RESTART_DELAY_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    exit(0);
  }, delayMs);
  return { delayMs, scheduledAt: new Date().toISOString() };
}

export function restartAlreadyScheduled(): boolean {
  return restartTimer !== undefined;
}

/** Version: env override, then package.json, then 0.0.0. */
export function resolveRuntimeVersion(
  env: NodeJS.ProcessEnv = process.env,
  readPackageVersion: () => string | undefined = readPackageJsonVersion,
): string {
  const fromEnv = env[UPDATE_VERSION_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readPackageVersion() ?? '0.0.0';
}

function readPackageJsonVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

export function resolveBuildType(env: NodeJS.ProcessEnv = process.env): 'source' | 'release' {
  const value = env[UPDATE_BUILD_TYPE_ENV]?.trim().toLowerCase();
  return value === 'release' ? 'release' : 'source';
}

/**
 * The swap target: an explicit absolute `MODEL_ROUTER_UPDATE_TARGET`, or the
 * resolved process entry (`process.argv[1]`) — for release builds that is
 * the single-file executable, for source builds the entry script.
 */
export function resolveUpdateTargetPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[UPDATE_TARGET_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return undefined;
  try {
    return realpathSync(entry);
  } catch {
    return resolve(entry);
  }
}
