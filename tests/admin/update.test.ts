import assert from 'node:assert/strict';
import { createHash as nodeCreateHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  compareSemver,
  extractBinaryFromTarGz,
  type FileSwapOps,
  type GitHubAsset,
  type GitHubRelease,
  InMemoryUpdateCheckCache,
  parseChecksumFile,
  parseSemver,
  resolveBuildType,
  resolveRuntimeVersion,
  scheduleProcessRestart,
  swapInNewBinary,
  UPDATE_CACHE_TTL_MS,
  UpdateError,
  type UpdateHttpClient,
  UpdateOperationGuard,
  UpdateService,
  updateHttpError,
  validateUpdateDownloadUrl,
  verifySha256Checksum,
} from '../../src/admin/update.js';
import { ControlError } from '../../src/control/service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0');
}

/** Minimal ustar member writer (enough for the reader under test). */
function tarMember(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${octal(0o644, 6)}\0`, 100, 8, 'utf8');
  header.write(`${octal(0, 6)}\0`, 108, 8, 'utf8');
  header.write(`${octal(0, 6)}\0`, 116, 8, 'utf8');
  header.write(`${octal(content.byteLength, 11)}\0`, 124, 12, 'utf8');
  header.write(`${octal(0, 11)}\0`, 136, 12, 'utf8');
  header.write('0', 156, 1, 'utf8'); // regular file
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  header.write(' '.repeat(8), 148, 8, 'utf8'); // checksum placeholder
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${octal(checksum, 6)}\0 `, 148, 8, 'utf8');
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function tarGz(entries: ReadonlyArray<[string, Buffer]>): Buffer {
  const archive = Buffer.concat([...entries.map(([name, content]) => tarMember(name, content)), Buffer.alloc(1024)]);
  return gzipSync(archive);
}

const ARCHIVE_NAME = 'model-router_darwin_arm64.tar.gz';
const CHECKSUM_URL = 'https://github.com/lex/model-router/releases/download/v0.2.0/checksums.txt';

function platformAsset(body: Buffer, url?: string): GitHubAsset {
  return {
    name: ARCHIVE_NAME,
    downloadUrl: url ?? `https://github.com/lex/model-router/releases/download/v0.2.0/${ARCHIVE_NAME}`,
    size: body.byteLength,
  };
}

function release(tag: string, assets: readonly GitHubAsset[], overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tagName: tag,
    name: tag,
    body: `release ${tag}`,
    publishedAt: '2026-10-01T00:00:00Z',
    htmlUrl: `https://github.com/lex/model-router/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets,
    ...overrides,
  };
}

function sha256(body: Buffer): string {
  return nodeCreateHash('sha256').update(body).digest('hex');
}

/** GitHub client stub with per-URL bodies and a call log. */
class FakeUpdateClient implements UpdateHttpClient {
  readonly downloads: string[] = [];
  latest: GitHubRelease | undefined;
  recent: GitHubRelease[] = [];
  failLatest: Error | undefined;
  readonly bodies = new Map<string, Buffer>();

  async fetchLatestRelease(): Promise<GitHubRelease> {
    if (this.failLatest) throw this.failLatest;
    if (!this.latest) throw new Error('no latest release configured');
    return this.latest;
  }

  async fetchRecentReleases(): Promise<GitHubRelease[]> {
    return this.recent;
  }

  async download(url: string): Promise<Buffer> {
    this.downloads.push(url);
    const body = this.bodies.get(url);
    if (body === undefined) throw new Error(`no body configured for ${url}`);
    return body;
  }

  async fetchChecksumFile(url: string): Promise<Buffer> {
    return this.download(url);
  }
}

function service(
  overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> & { client?: UpdateHttpClient } = {},
): UpdateService {
  const client = overrides.client ?? new FakeUpdateClient();
  return new UpdateService({
    currentVersion: '0.1.0',
    buildType: 'release',
    repo: 'lex/model-router',
    client,
    cache: new InMemoryUpdateCheckCache(),
    platform: 'darwin',
    arch: 'arm64',
    targetPath: '/nonexistent/model-router',
    ...overrides,
  });
}

/** One realistic release: platform archive + checksums.txt for version `to`. */
function wireRelease(client: FakeUpdateClient, to: string, binary: Buffer): GitHubRelease {
  const archiveBody = tarGz([['model-router', binary]]);
  const archiveUrl = `https://github.com/lex/model-router/releases/download/${to}/${ARCHIVE_NAME}`;
  client.bodies.set(archiveUrl, archiveBody);
  client.bodies.set(CHECKSUM_URL, Buffer.from(`${sha256(archiveBody)}  ${ARCHIVE_NAME}\n`));
  return release(to, [
    platformAsset(archiveBody, archiveUrl),
    { name: 'checksums.txt', downloadUrl: CHECKSUM_URL, size: 64 },
  ]);
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

test('parseSemver strips v-prefixes and -suffixes and tolerates short forms', () => {
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('1.2.3-rc.1'), [1, 2, 3]);
  assert.deepEqual(parseSemver('1.2'), [1, 2, 0]);
  assert.deepEqual(parseSemver('V10.20.30'), [10, 20, 30]);
  assert.deepEqual(parseSemver('not-a-version'), [0, 0, 0]);
  assert.deepEqual(parseSemver('1.2.x'), [1, 2, 0]);
});

test('compareSemver orders three-segment versions', () => {
  assert.equal(compareSemver('0.1.9', '0.2.0'), -1);
  assert.equal(compareSemver('0.2.0', '0.1.9'), 1);
  assert.equal(compareSemver('v1.0.0', '1.0.0-rc1'), 0);
  assert.equal(compareSemver('1.0.10', '1.0.9'), 1);
  assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
});

// ---------------------------------------------------------------------------
// Download URL allowlist (SSRF fence)
// ---------------------------------------------------------------------------

test('validateUpdateDownloadUrl accepts only GitHub hosts over HTTPS', () => {
  assert.equal(validateUpdateDownloadUrl('https://github.com/lex/model-router/releases/download/v1/x.tar.gz'), null);
  assert.equal(validateUpdateDownloadUrl('https://objects.githubusercontent.com/some/path/asset.tgz'), null);
  assert.equal(validateUpdateDownloadUrl('https://sub.objects.githubusercontent.com/some/path/asset.tgz'), null);
});

test('validateUpdateDownloadUrl rejects the SSRF negative cases', () => {
  assert.equal(validateUpdateDownloadUrl('http://github.com/lex/model-router/x'), 'NOT_HTTPS');
  assert.equal(validateUpdateDownloadUrl('https://evil.example.com/asset.tgz'), 'UNTRUSTED_HOST');
  assert.equal(validateUpdateDownloadUrl('https://github.com.evil.example.com/asset.tgz'), 'UNTRUSTED_HOST');
  assert.equal(validateUpdateDownloadUrl('https://evil.example.com/github.com/asset'), 'UNTRUSTED_HOST');
  assert.equal(validateUpdateDownloadUrl('https://user:pass@github.com/asset'), 'URL_CREDENTIALS');
  assert.equal(validateUpdateDownloadUrl('https://github.com@evil.example.com/asset'), 'UNTRUSTED_HOST');
  assert.equal(validateUpdateDownloadUrl('file:///etc/passwd'), 'NOT_HTTPS');
  assert.equal(validateUpdateDownloadUrl('not a url'), 'INVALID_URL');
  assert.equal(validateUpdateDownloadUrl('https://githubcompany.com/asset'), 'UNTRUSTED_HOST');
});

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

test('parseChecksumFile reads sha256 lines and ignores junk', () => {
  const map = parseChecksumFile(
    `${'a'.repeat(64)}  model-router_darwin_arm64.tar.gz\n` +
      `${'b'.repeat(64)}   model-router_linux_amd64.tar.gz\r\n` +
      `garbage line\n` +
      `${'c'.repeat(63)}  short-hash.txt\n` +
      `\n`,
  );
  assert.equal(map.size, 2);
  assert.equal(map.get('model-router_darwin_arm64.tar.gz'), 'a'.repeat(64));
  assert.equal(map.get('model-router_linux_amd64.tar.gz'), 'b'.repeat(64));
});

test('verifySha256Checksum verifies a real file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'asset.bin');
  await writeFile(filePath, Buffer.from('hello update'));
  const good = new Map([['asset.bin', sha256(Buffer.from('hello update'))]]);
  const bad = new Map([['asset.bin', '0'.repeat(64)]]);
  const missing = new Map([['other.bin', '0'.repeat(64)]]);
  assert.equal(await verifySha256Checksum(filePath, good, 'asset.bin'), null);
  assert.equal(await verifySha256Checksum(filePath, bad, 'asset.bin'), 'CHECKSUM_MISMATCH');
  assert.equal(await verifySha256Checksum(filePath, missing, 'asset.bin'), 'CHECKSUM_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Tar extraction
// ---------------------------------------------------------------------------

test('extractBinaryFromTarGz extracts only the target entry and rejects traversal', () => {
  const binary = Buffer.from('#!/bin/sh\n# new binary\n', 'utf8');
  const archive = tarGz([
    ['README.md', Buffer.from('readme')],
    ['model-router', binary],
    ['nested/model-router.exe', Buffer.from('windows')],
  ]);
  assert.deepEqual(extractBinaryFromTarGz(archive, ['model-router', 'model-router.exe']), binary);

  const hostile = tarGz([
    ['../escape.sh', Buffer.from('nope')],
    ['model-router', binary],
  ]);
  assert.throws(
    () => extractBinaryFromTarGz(hostile, ['model-router']),
    (error: unknown) => error instanceof UpdateError && error.code === 'PATH_TRAVERSAL',
  );

  const absolute = tarGz([
    ['/etc/passwd', Buffer.from('nope')],
    ['model-router', binary],
  ]);
  assert.throws(
    () => extractBinaryFromTarGz(absolute, ['model-router']),
    (error: unknown) => error instanceof UpdateError && error.code === 'PATH_TRAVERSAL',
  );

  const empty = tarGz([['README.md', Buffer.from('readme')]]);
  assert.throws(
    () => extractBinaryFromTarGz(empty, ['model-router']),
    (error: unknown) => error instanceof UpdateError && error.code === 'BINARY_NOT_IN_ARCHIVE',
  );

  assert.throws(
    () => extractBinaryFromTarGz(Buffer.from('not gzip at all'), ['model-router']),
    (error: unknown) => error instanceof UpdateError && error.code === 'MALFORMED_ARCHIVE',
  );
});

test('extractBinaryFromTarGz enforces the size caps', () => {
  const binary = Buffer.alloc(1024, 0x41);
  const archive = tarGz([['model-router', binary]]);
  assert.throws(
    () => extractBinaryFromTarGz(archive, ['model-router'], { maxBinaryBytes: 512 }),
    (error: unknown) => error instanceof UpdateError && error.code === 'BINARY_TOO_LARGE',
  );
  assert.throws(
    () => extractBinaryFromTarGz(archive, ['model-router'], { maxArchiveBytes: 8 }),
    (error: unknown) => error instanceof UpdateError && error.code === 'ARCHIVE_TOO_LARGE',
  );
});

// ---------------------------------------------------------------------------
// Two-step atomic swap
// ---------------------------------------------------------------------------

test('swapInNewBinary reports the backup path on success', async () => {
  const renames: Array<[string, string]> = [];
  const ops: FileSwapOps = {
    rename: async (from, to) => {
      renames.push([from, to]);
    },
    remove: async () => undefined,
  };
  const result = await swapInNewBinary({ targetPath: '/opt/model-router', newBinaryPath: '/tmp/new', ops });
  assert.equal(result.backupPath, '/opt/model-router.backup');
  assert.deepEqual(renames, [
    ['/opt/model-router', '/opt/model-router.backup'],
    ['/tmp/new', '/opt/model-router'],
  ]);
});

test('swapInNewBinary restores the backup when the second rename fails', async () => {
  const renames: Array<[string, string]> = [];
  const ops: FileSwapOps = {
    rename: async (from, to) => {
      renames.push([from, to]);
      // Only the new→target rename fails; the backup restore must succeed.
      if (from === '/tmp/new') throw new Error('disk full');
    },
    remove: async () => undefined,
  };
  await assert.rejects(
    swapInNewBinary({ targetPath: '/opt/model-router', newBinaryPath: '/tmp/new', ops }),
    (error: unknown) => error instanceof UpdateError && error.code === 'REPLACE_FAILED_RESTORED',
  );
  assert.deepEqual(renames, [
    ['/opt/model-router', '/opt/model-router.backup'],
    ['/tmp/new', '/opt/model-router'],
    ['/opt/model-router.backup', '/opt/model-router'],
  ]);
});

test('swapInNewBinary surfaces a distinct failure when the restore also fails', async () => {
  const ops: FileSwapOps = {
    rename: async (_from, to) => {
      if (to === '/opt/model-router') throw new Error('disk full');
    },
    remove: async () => undefined,
  };
  await assert.rejects(
    swapInNewBinary({ targetPath: '/opt/model-router', newBinaryPath: '/tmp/new', ops }),
    (error: unknown) => error instanceof UpdateError && error.code === 'REPLACE_AND_RESTORE_FAILED',
  );
});

test('swapInNewBinary fails before touching anything when the backup rename fails', async () => {
  const ops: FileSwapOps = {
    rename: async (from) => {
      if (from === '/opt/model-router') throw new Error('permission denied');
    },
    remove: async () => undefined,
  };
  await assert.rejects(
    swapInNewBinary({ targetPath: '/opt/model-router', newBinaryPath: '/tmp/new', ops }),
    (error: unknown) => error instanceof UpdateError && error.code === 'BACKUP_FAILED',
  );
});

test('swapInNewBinary succeeds against the real filesystem', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-swap-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  const staged = join(dir, 'staged');
  await writeFile(target, 'old');
  await writeFile(staged, 'new');
  const result = await swapInNewBinary({ targetPath: target, newBinaryPath: staged });
  assert.equal(result.backupPath, `${target}.backup`);
  assert.equal((await readFile(target)).toString(), 'new');
  assert.equal((await readFile(result.backupPath)).toString(), 'old');
});

// ---------------------------------------------------------------------------
// Check cache behavior
// ---------------------------------------------------------------------------

test('checkUpdate serves the 20-minute cache and bypasses it on force', async () => {
  const client = new FakeUpdateClient();
  client.latest = release('v0.3.0', []);
  let nowMs = 1_000_000;
  const cache = new InMemoryUpdateCheckCache();
  const svc = service({ client, cache, now: () => nowMs });

  const first = await svc.checkUpdate();
  assert.equal(first.cached, false);
  assert.equal(first.hasUpdate, true);
  assert.equal(first.latestVersion, '0.3.0');

  // Fresh cache: served without touching GitHub.
  client.latest = release('v0.9.9', []);
  const cached = await svc.checkUpdate();
  assert.equal(cached.cached, true);
  assert.equal(cached.latestVersion, '0.3.0');

  // Expired cache: refetched.
  nowMs += UPDATE_CACHE_TTL_MS + 1;
  const refreshed = await svc.checkUpdate();
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.latestVersion, '0.9.9');

  // Force bypasses even a fresh cache.
  client.latest = release('v1.0.0', []);
  const forced = await svc.checkUpdate(true);
  assert.equal(forced.cached, false);
  assert.equal(forced.latestVersion, '1.0.0');
});

test('checkUpdate falls back to cached data when GitHub fails', async () => {
  const client = new FakeUpdateClient();
  client.latest = release('v0.3.0', []);
  const svc = service({ client });
  await svc.checkUpdate(true);
  client.failLatest = new Error('github down');
  const fallback = await svc.checkUpdate(true);
  assert.equal(fallback.cached, true);
  assert.equal(fallback.latestVersion, '0.3.0');
  assert.match(fallback.warning ?? '', /github down/);

  // With no cache at all, the failure degrades to a warning, not an error.
  const fresh = service({ client });
  const degraded = await fresh.checkUpdate(true);
  assert.equal(degraded.hasUpdate, false);
  assert.match(degraded.warning ?? '', /github down/);
});

test('checkUpdate reports the unconfigured-repository warning', async () => {
  const svc = service({ repo: undefined });
  const info = await svc.checkUpdate();
  assert.equal(info.hasUpdate, false);
  assert.match(info.warning ?? '', /MODEL_ROUTER_UPDATE_GITHUB_REPO/);
});

// ---------------------------------------------------------------------------
// performUpdate end-to-end (real temp directory, real archive)
// ---------------------------------------------------------------------------

test('performUpdate downloads, verifies, extracts and atomically swaps', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = wireRelease(client, 'v0.2.0', Buffer.from('new-binary-v0.2.0'));
  const svc = service({ client, targetPath: target });

  const result = await svc.performUpdate();
  assert.equal(result.fromVersion, '0.1.0');
  assert.equal(result.toVersion, '0.2.0');
  assert.equal(result.backupPath, `${target}.backup`);
  assert.equal((await readFile(target)).toString(), 'new-binary-v0.2.0');
  assert.equal((await readFile(`${target}.backup`)).toString(), 'old-binary');
  assert.equal(client.downloads.length, 2);
  // The temp directory next to the target is cleaned up.
  const entries = await readdir(dir);
  assert.equal(entries.filter((name) => name.startsWith('.model-router-update-')).length, 0);
});

test('performUpdate refuses when already up to date', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = release('v0.1.0', []);
  const svc = service({ client, targetPath: target });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'ALREADY_UP_TO_DATE',
  );
});

test('performUpdate rejects an untrusted asset URL (SSRF fence at the service level)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  const evilBody = tarGz([['model-router', Buffer.from('evil')]]);
  client.latest = release('v0.2.0', [platformAsset(evilBody, 'https://evil.example.com/asset.tgz')]);
  const svc = service({ client, targetPath: target });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'INVALID_DOWNLOAD_URL',
  );
  assert.equal((await readFile(target)).toString(), 'old-binary');
});

test('performUpdate fails closed on a checksum mismatch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = wireRelease(client, 'v0.2.0', Buffer.from('new-binary'));
  client.bodies.set(CHECKSUM_URL, Buffer.from(`${'0'.repeat(64)}  ${ARCHIVE_NAME}\n`));
  const svc = service({ client, targetPath: target });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'CHECKSUM_MISMATCH',
  );
  assert.equal((await readFile(target)).toString(), 'old-binary');
});

test('performUpdate fails closed when checksums.txt omits the asset', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = wireRelease(client, 'v0.2.0', Buffer.from('new-binary'));
  client.bodies.set(CHECKSUM_URL, Buffer.from(`${'0'.repeat(64)}  other-asset.tar.gz\n`));
  const svc = service({ client, targetPath: target });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'CHECKSUM_NOT_FOUND',
  );
});

test('performUpdate rejects a traversal archive and leaves the target intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-traversal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = wireRelease(client, 'v0.2.0', Buffer.from('legit'));
  // Swap the archive body for a hostile one (with a matching checksum) so
  // the run reaches extraction and the traversal fence fires there.
  const hostileBody = tarGz([
    ['../evil.sh', Buffer.from('nope')],
    ['model-router', Buffer.from('new')],
  ]);
  const hostileUrl = [...client.bodies.keys()].find((url) => url.endsWith(ARCHIVE_NAME));
  assert.ok(hostileUrl);
  client.bodies.set(hostileUrl, hostileBody);
  client.bodies.set(CHECKSUM_URL, Buffer.from(`${sha256(hostileBody)}  ${ARCHIVE_NAME}\n`));
  const svc = service({ client, targetPath: target });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'EXTRACTION_FAILED',
  );
  assert.equal((await readFile(target)).toString(), 'old-binary');
});

test('a source build never matches release assets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = wireRelease(client, 'v0.2.0', Buffer.from('new-binary'));
  const svc = service({ client, targetPath: target, buildType: 'source' });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'NO_COMPATIBLE_ASSET',
  );
});

test('performUpdate reports NO_COMPATIBLE_ASSET when no platform archive exists', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-perform-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'old-binary', { mode: 0o755 });
  const client = new FakeUpdateClient();
  client.latest = release('v0.2.0', [
    { name: 'model-router_linux_amd64.tar.gz', downloadUrl: 'https://github.com/x/y/z', size: 1 },
  ]);
  const svc = service({ client, targetPath: target });
  await assert.rejects(
    svc.performUpdate(),
    (error: unknown) => error instanceof UpdateError && error.code === 'NO_COMPATIBLE_ASSET',
  );
});

// ---------------------------------------------------------------------------
// Rollback whitelist
// ---------------------------------------------------------------------------

function rollbackClient(): FakeUpdateClient {
  const client = new FakeUpdateClient();
  client.recent = [
    release('v0.5.0', []), // newer
    release('v0.4.2', []), // newer
    release('v0.4.1', [], { prerelease: true }), // prerelease: skipped
    release('v0.4.0', []), // candidate 1
    release('v0.4.0-rc1', []), // same semver as 0.4.0: deduped
    release('v0.3.9', [], { draft: true }), // draft: skipped
    release('v0.3.8', []), // candidate 2
    release('v0.3.8', [], { name: 'dupe' }), // duplicate version
    release('v0.3.7', []), // candidate 3
    release('v0.3.6', []), // candidate 4 — cut off by the max-3 window
    release('v0.3.5', []),
    release('v0.3.4', []),
    release('v0.3.3', []),
    release('v0.3.2', []),
    release('v0.3.1', []),
  ];
  return client;
}

test('listRollbackVersions returns the three newest stable versions strictly older than current', async () => {
  const client = rollbackClient();
  const svc = service({ client, currentVersion: '0.4.2' });
  const versions = await svc.listRollbackVersions();
  assert.deepEqual(
    versions.map((entry) => entry.version),
    ['0.4.0', '0.3.8', '0.3.7'],
  );
  assert.equal(versions[0]?.htmlUrl, 'https://github.com/lex/model-router/releases/tag/v0.4.0');
});

test('rollbackToVersion accepts only whitelisted versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'model-router');
  await writeFile(target, 'running-0.4.2', { mode: 0o755 });
  const client = rollbackClient();
  for (const entry of client.recent) {
    const version = entry.tagName.replace(/^v/, '');
    const body = tarGz([['model-router', Buffer.from(`binary-${version}`)]]);
    const url = `https://github.com/lex/model-router/releases/download/${entry.tagName}/${ARCHIVE_NAME}`;
    const checksumUrl = `https://github.com/lex/model-router/releases/download/${entry.tagName}/checksums.txt`;
    client.bodies.set(url, body);
    client.bodies.set(checksumUrl, Buffer.from(`${sha256(body)}  ${ARCHIVE_NAME}\n`));
    entry.assets = [platformAsset(body, url), { name: 'checksums.txt', downloadUrl: checksumUrl, size: 64 }];
  }
  const svc = service({ client, currentVersion: '0.4.2', targetPath: target });

  const result = await svc.rollbackToVersion('v0.3.8');
  assert.equal(result.toVersion, '0.3.8');
  assert.equal((await readFile(target)).toString(), 'binary-0.3.8');
  assert.equal((await readFile(`${target}.backup`)).toString(), 'running-0.4.2');

  // Current, newer, cut-off, mangled and empty versions are all refused.
  for (const rejected of ['0.4.2', '0.5.0', '0.3.6', '0.3.8-rc1', '99.0.0', '']) {
    await assert.rejects(
      svc.rollbackToVersion(rejected),
      (error: unknown) => error instanceof UpdateError && error.code === 'ROLLBACK_VERSION_NOT_ALLOWED',
      `expected ${JSON.stringify(rejected)} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Idempotency guard
// ---------------------------------------------------------------------------

test('UpdateOperationGuard requires a key, refuses concurrency and replays results', async () => {
  const guard = new UpdateOperationGuard();
  await assert.rejects(
    guard.run(undefined, async () => 1),
    (error: unknown) => error instanceof ControlError && error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
  await assert.rejects(
    guard.run('   ', async () => 1),
    (error: unknown) => error instanceof ControlError && error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const first = guard.run('key-1', async () => {
    await gate;
    return { value: 41 };
  });
  await assert.rejects(
    guard.run('key-1', async () => ({ value: 42 })),
    (error: unknown) => error instanceof ControlError && error.code === 'OPERATION_IN_PROGRESS',
  );
  release?.();
  assert.deepEqual(await first, { result: { value: 41 }, replayed: false });

  const replay = await guard.run('key-1', async () => ({ value: 43 }));
  assert.deepEqual(replay, { result: { value: 41 }, replayed: true });

  const other = await guard.run('key-2', async () => ({ value: 2 }));
  assert.deepEqual(other, { result: { value: 2 }, replayed: false });
});

test('UpdateOperationGuard keeps keys independent', async () => {
  const guard = new UpdateOperationGuard();
  const a = await guard.run('a', async () => 'A');
  const b = await guard.run('b', async () => 'B');
  assert.deepEqual(a, { result: 'A', replayed: false });
  assert.deepEqual(b, { result: 'B', replayed: false });
  assert.deepEqual(await guard.run('a', async () => 'C'), { result: 'A', replayed: true });
});

// ---------------------------------------------------------------------------
// Restart scheduling
// ---------------------------------------------------------------------------

test('scheduleProcessRestart exits once after the delay and collapses repeats', async () => {
  const scheduled: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalExit = process.exit;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((handler: () => void) => {
    scheduled.push(handler);
    return { unref: () => undefined } as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setTimeout;
  (process as unknown as { exit: unknown }).exit = ((code: number) => {
    throw new Error(`test exit ${code}`);
  }) as typeof process.exit;
  try {
    const first = scheduleProcessRestart({ delayMs: 500 });
    assert.equal(first.delayMs, 500);
    // A second schedule while one is pending is a no-op.
    const second = scheduleProcessRestart({ delayMs: 500 });
    assert.equal(second.delayMs, 0);
    assert.equal(scheduled.length, 1);
    // The scheduled handler runs the exit; the module resets so a later
    // schedule is possible again.
    assert.throws(() => scheduled[0]?.(), /test exit 0/);
    const third = scheduleProcessRestart({ delayMs: 500 });
    assert.equal(third.delayMs, 500);
    assert.equal(scheduled.length, 2);
    assert.throws(() => scheduled[1]?.(), /test exit 0/);
  } finally {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = originalSetTimeout;
    (process as unknown as { exit: unknown }).exit = originalExit;
  }
});

// ---------------------------------------------------------------------------
// Runtime identity resolution and error mapping
// ---------------------------------------------------------------------------

test('resolveRuntimeVersion prefers the env override and falls back to package.json', () => {
  assert.equal(
    resolveRuntimeVersion({ MODEL_ROUTER_VERSION: '9.9.9' } as NodeJS.ProcessEnv, () => '1.2.3'),
    '9.9.9',
  );
  assert.equal(
    resolveRuntimeVersion({} as NodeJS.ProcessEnv, () => '1.2.3'),
    '1.2.3',
  );
  assert.equal(
    resolveRuntimeVersion({} as NodeJS.ProcessEnv, () => undefined),
    '0.0.0',
  );
  assert.equal(resolveBuildType({} as NodeJS.ProcessEnv), 'source');
  assert.equal(resolveBuildType({ MODEL_ROUTER_BUILD_TYPE: 'release' } as NodeJS.ProcessEnv), 'release');
  assert.equal(resolveBuildType({ MODEL_ROUTER_BUILD_TYPE: 'weird' } as NodeJS.ProcessEnv), 'source');
});

test('updateHttpError maps update failures onto admin ControlErrors', () => {
  const mapped = updateHttpError(new UpdateError('ROLLBACK_VERSION_NOT_ALLOWED', 'nope')) as ControlError;
  assert.ok(mapped instanceof ControlError);
  assert.equal(mapped.status, 400);
  assert.equal(mapped.code, 'ROLLBACK_VERSION_NOT_ALLOWED');
  const upstream = updateHttpError(new UpdateError('ALREADY_UP_TO_DATE', 'nope')) as ControlError;
  assert.equal(upstream.status, 409);
  const passthrough = new Error('untouched');
  assert.equal(updateHttpError(passthrough), passthrough);
});
