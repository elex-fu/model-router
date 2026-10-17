/**
 * Batch-5 §5.1 plugin package verification tests: the full negative matrix
 * (zip structure, path safety, symlinks, reconciliation, budgets, signature
 * chain, lying headers) plus the extraction happy path and mode discipline.
 * Packages are built in-process with the stored-method writeZip seam.
 */

import assert from 'node:assert/strict';
import { createHash, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { isPluginSignatureFile, type PluginTrustedPublishers } from '../../../src/saas/plugins/package/signature.js';
import { PluginPackageError, verifyPluginPackage } from '../../../src/saas/plugins/package/verify.js';
import { readZipEntries, writeZip, ZipFormatError } from '../../../src/saas/plugins/package/zip.js';

const CAPABILITY = 'claude.oauth.outbound_transport.v1';
const PUBLISHER_KEY_ID = 'test-publisher';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const TRUSTED_PUBLISHERS: PluginTrustedPublishers = {
  [PUBLISHER_KEY_ID]: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'),
};

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ZipEntryOverride {
  externalAttributes?: number;
  uncompressedSizeOverride?: number;
}

interface ExtraZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly externalAttributes?: number;
  readonly uncompressedSizeOverride?: number;
}

interface BuildPackageOptions {
  manifestPatch?: Record<string, unknown>;
  omitSignature?: boolean;
  omitManifest?: boolean;
  signaturePatch?: Record<string, unknown>;
  extraEntries?: ExtraZipEntry[];
  omitEntries?: string[];
  entryOverrides?: Record<string, ZipEntryOverride>;
  /** name → alternate content whose digest is declared in the manifest. */
  tamper?: Record<string, string>;
}

interface BuiltPackage {
  data: Buffer;
  manifestRaw: Buffer;
  manifest: Record<string, unknown>;
}

function buildPackage(files: Record<string, string>, options: BuildPackageOptions = {}): BuiltPackage {
  const fileHashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    fileHashes[name] = sha256Hex(Buffer.from(options.tamper?.[name] ?? content, 'utf8'));
  }
  const manifest = {
    schema_version: 1,
    id: 'acme.transport-bridge',
    name: 'Transport Bridge',
    version: '1.0.0',
    description: 'test plugin',
    author: 'acme',
    requires: { model_router: '>=0.1.0', plugin_protocol: 1, transport_api: 1 },
    capabilities: [{ id: CAPABILITY }],
    entrypoint: 'plugin.js',
    files: fileHashes,
    ...options.manifestPatch,
  };
  const manifestRaw = Buffer.from(JSON.stringify(manifest), 'utf8');

  const entries: ExtraZipEntry[] = [];
  for (const [name, content] of Object.entries(files)) {
    if (options.omitEntries?.includes(name)) continue;
    entries.push({ name, data: Buffer.from(content, 'utf8'), ...options.entryOverrides?.[name] });
  }
  if (!options.omitManifest) entries.push({ name: 'manifest.json', data: manifestRaw });
  if (!options.omitSignature) {
    const signature = {
      algorithm: 'ed25519',
      key_id: PUBLISHER_KEY_ID,
      // signs EXACTLY the raw manifest bytes (the signature-chain root)
      signature: cryptoSign(null, manifestRaw, privateKey).toString('base64'),
      ...options.signaturePatch,
    };
    entries.push({ name: 'signature.json', data: Buffer.from(JSON.stringify(signature), 'utf8') });
  }
  for (const extra of options.extraEntries ?? []) entries.push(extra);
  return { data: writeZip(entries), manifestRaw, manifest };
}

interface VerifyOverrides {
  allowUnsigned?: boolean;
  trustedPublishers?: PluginTrustedPublishers;
  maxUploadBytes?: number;
  maxUncompressedBytes?: number;
}

function verify(data: Uint8Array, overrides: VerifyOverrides = {}) {
  return verifyPluginPackage({
    data,
    trustedPublishers: overrides.trustedPublishers ?? TRUSTED_PUBLISHERS,
    allowUnsigned: overrides.allowUnsigned ?? false,
    maxUploadBytes: overrides.maxUploadBytes,
    maxUncompressedBytes: overrides.maxUncompressedBytes,
  });
}

async function expectPackageError(data: Uint8Array, code: string, overrides: VerifyOverrides = {}): Promise<void> {
  await assert.rejects(
    verify(data, overrides),
    (error: unknown): boolean => error instanceof PluginPackageError && error.code === code,
    `expected PluginPackageError with code "${code}"`,
  );
}

function defaultFiles(): Record<string, string> {
  return {
    'plugin.js': "export function start() {\n  return 'ok';\n}\n",
    'lib/mod.js': 'export const answer = 42;\n',
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mr-plugin-package-'));
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

test('writeZip round-trips stored entries through readZipEntries', () => {
  const data = writeZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'lib/', data: Buffer.alloc(0) },
  ]);
  const entries = readZipEntries(data);
  assert.equal(entries.length, 2);
  const [file, directory] = entries;
  assert.equal(file.name, 'a.txt');
  assert.equal(file.method, 0);
  assert.equal(file.compressedSize, 5);
  assert.equal(file.uncompressedSize, 5);
  assert.equal(file.crc32, zlib.crc32(Buffer.from('hello')));
  assert.equal(file.isDirectory, false);
  assert.equal(file.externalAttributes, 0o100644);
  assert.equal(file.data().toString('utf8'), 'hello');
  assert.equal(directory.name, 'lib/');
  assert.equal(directory.isDirectory, true);
});

test('readZipEntries locates the EOCD behind a zip comment and rejects trailing garbage', () => {
  const base = writeZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
  const eocdOffset = base.length - 22;
  const comment = Buffer.from('trailing zip comment', 'utf8');
  const withComment = Buffer.concat([base, comment]);
  withComment.writeUInt16LE(comment.length, eocdOffset + 20);
  const entries = readZipEntries(withComment);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data().toString('utf8'), 'hello');

  const garbage = Buffer.concat([base, Buffer.from('junk')]);
  assert.throws(() => readZipEntries(garbage), ZipFormatError);
});

test('verifyPluginPackage rethrows zip-layer errors with their codes', async () => {
  const pkg = buildPackage(defaultFiles());
  await expectPackageError(pkg.data.subarray(0, 40), 'no_eocd');
});

test('rejects empty and oversized package bodies', async () => {
  const pkg = buildPackage(defaultFiles());
  await expectPackageError(Buffer.alloc(0), 'empty_package', { allowUnsigned: true });
  await expectPackageError(pkg.data, 'package_too_large', { maxUploadBytes: pkg.data.length - 1 });
});

test('rejects a package without manifest.json', async () => {
  const pkg = buildPackage(defaultFiles(), { omitManifest: true, omitSignature: true });
  await expectPackageError(pkg.data, 'missing_manifest');
});

test('rejects duplicate entry names', async () => {
  const pkg = buildPackage(defaultFiles(), {
    extraEntries: [{ name: 'plugin.js', data: Buffer.from('duplicate') }],
  });
  await expectPackageError(pkg.data, 'duplicate_entry');
});

test('rejects archives with more than 512 entries', async () => {
  const files: Record<string, string> = { 'plugin.js': 'x' };
  for (let i = 0; i < 512; i++) files[`f${i}.js`] = 'x';
  const pkg = buildPackage(files, { omitSignature: true });
  await expectPackageError(pkg.data, 'too_many_entries');
});

test('rejects unsafe entry names', async () => {
  const unsafeNames = ['../evil.js', '/etc/passwd', 'a\\b.js', 'bad\0name.js', 'dir//x.js', './x.js', '../'];
  for (const name of unsafeNames) {
    const pkg = buildPackage(defaultFiles(), { extraEntries: [{ name, data: Buffer.from('x') }] });
    await expectPackageError(pkg.data, 'unsafe_entry_path');
  }
});

test('rejects symlink entries', async () => {
  const pkg = buildPackage(defaultFiles(), {
    entryOverrides: { 'lib/mod.js': { externalAttributes: 0o120777 } },
  });
  await expectPackageError(pkg.data, 'symlink_entry');
});

test('rejects an oversized manifest', async () => {
  const pkg = buildPackage(defaultFiles(), {
    manifestPatch: { description: 'x'.repeat(2 * 1024 * 1024 + 64) },
  });
  await expectPackageError(pkg.data, 'manifest_too_large');
});

test('rejects undeclared archive files', async () => {
  const pkg = buildPackage(defaultFiles(), {
    extraEntries: [{ name: 'stowaway.js', data: Buffer.from('x') }],
  });
  await expectPackageError(pkg.data, 'undeclared_file');
});

test('rejects missing declared files', async () => {
  const pkg = buildPackage(defaultFiles(), { omitEntries: ['lib/mod.js'] });
  await expectPackageError(pkg.data, 'missing_declared_file');
});

test('preserves manifest-layer error codes', async () => {
  const pkg = buildPackage(defaultFiles(), { manifestPatch: { capabilities: [{ id: 'admin.root.v1' }] } });
  await expectPackageError(pkg.data, 'unsupported_capability');
});

test('verifies a signed happy-path package as trusted', async () => {
  const files = defaultFiles();
  const pkg = buildPackage(files);
  const verified = await verify(pkg.data);
  assert.equal(verified.signatureStatus, 'trusted');
  assert.equal(verified.manifest.id, 'acme.transport-bridge');
  assert.equal(verified.manifestSha256, sha256Hex(pkg.manifestRaw));
  assert.deepEqual(verified.manifestRaw, pkg.manifestRaw);
  assert.equal(verified.entrypoint, 'plugin.js');
  assert.equal(verified.entrypointSha256, sha256Hex(Buffer.from(files['plugin.js'], 'utf8')));
  assert.deepEqual(verified.files, pkg.manifest.files);
});

test('rejects a tampered entrypoint at verification time', async () => {
  const pkg = buildPackage(defaultFiles(), { tamper: { 'plugin.js': 'evil payload' } });
  await expectPackageError(pkg.data, 'file_hash_mismatch');
});

test('rejects a tampered declared file at extraction time', async () => {
  const pkg = buildPackage(defaultFiles(), { tamper: { 'lib/mod.js': 'evil payload' } });
  const verified = await verify(pkg.data);
  const dir = await tempDir();
  try {
    await assert.rejects(
      verified.extractTo(dir),
      (error: unknown): boolean => error instanceof PluginPackageError && error.code === 'file_hash_mismatch',
    );
  } finally {
    await cleanup(dir);
  }
});

test('rejects signatures from unknown publishers', async () => {
  const pkg = buildPackage(defaultFiles(), { signaturePatch: { key_id: 'stranger' } });
  await expectPackageError(pkg.data, 'untrusted_publisher');
});

test('rejects corrupted signature bytes', async () => {
  const pkg = buildPackage(defaultFiles(), {
    signaturePatch: { signature: Buffer.alloc(64, 7).toString('base64') },
  });
  await expectPackageError(pkg.data, 'invalid_signature');
});

test('rejects unsupported signature algorithms', async () => {
  const pkg = buildPackage(defaultFiles(), { signaturePatch: { algorithm: 'rsa-sha256' } });
  await expectPackageError(pkg.data, 'unsupported_algorithm');
});

test('rejects unsigned packages when unsigned installs are not allowed', async () => {
  const pkg = buildPackage(defaultFiles(), { omitSignature: true });
  await expectPackageError(pkg.data, 'unsigned_plugin_rejected');
});

test('accepts unsigned packages when unsigned installs are allowed', async () => {
  const pkg = buildPackage(defaultFiles(), { omitSignature: true });
  const verified = await verify(pkg.data, { allowUnsigned: true });
  assert.equal(verified.signatureStatus, 'unsigned');
  assert.equal(verified.entrypoint, 'plugin.js');
});

test('rejects a signature file above the read cap', async () => {
  const pkg = buildPackage(defaultFiles(), {
    omitSignature: true,
    extraEntries: [
      {
        name: 'signature.json',
        data: Buffer.from(`{"algorithm":"ed25519","key_id":"k","signature":"${'A'.repeat(70_000)}"}`),
      },
    ],
  });
  await expectPackageError(pkg.data, 'signature_too_large');
});

test('enforces the declared uncompressed-size budget', async () => {
  const pkg = buildPackage(defaultFiles());
  await expectPackageError(pkg.data, 'uncompressed_size_exceeded', { maxUncompressedBytes: 16 });
});

test('catches lying uncompressed-size headers at extraction', async () => {
  const files = { 'plugin.js': 'export const start = 1;\n', 'lib/big.js': 'x'.repeat(300) };
  const pkg = buildPackage(files, {
    entryOverrides: { 'lib/big.js': { uncompressedSizeOverride: 10 } },
  });
  // Declared sizes fit the budget, so verification passes...
  const verified = await verify(pkg.data, { maxUncompressedBytes: 256 });
  const dir = await tempDir();
  try {
    // ...but the ACTUAL inflated bytes are counted at extraction.
    await assert.rejects(
      verified.extractTo(dir),
      (error: unknown): boolean => error instanceof PluginPackageError && error.code === 'uncompressed_size_exceeded',
    );
  } finally {
    await cleanup(dir);
  }
});

test('extractTo writes files with restrictive modes', async () => {
  const files = defaultFiles();
  const pkg = buildPackage(files);
  const verified = await verify(pkg.data);
  const dir = await tempDir();
  try {
    await verified.extractTo(dir);
    assert.equal((await stat(join(dir, 'plugin.js'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'lib/mod.js'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'lib'))).mode & 0o777, 0o700);
    assert.equal(await readFile(join(dir, 'plugin.js'), 'utf8'), files['plugin.js']);
    assert.equal(await readFile(join(dir, 'lib/mod.js'), 'utf8'), files['lib/mod.js']);
  } finally {
    await cleanup(dir);
  }
});

test('extractTo into two fresh directories produces identical files', async () => {
  const files = { 'plugin.js': 'a', 'lib/mod.js': 'b', 'lib/deep/x.js': 'c' };
  const pkg = buildPackage(files);
  const verified = await verify(pkg.data);
  const dir1 = await tempDir();
  const dir2 = await tempDir();
  try {
    await verified.extractTo(dir1);
    await verified.extractTo(dir2);
    for (const name of Object.keys(files)) {
      const left = await readFile(join(dir1, name));
      const right = await readFile(join(dir2, name));
      assert.equal(sha256Hex(left), sha256Hex(right));
      assert.equal(left.toString('utf8'), files[name]);
    }
  } finally {
    await cleanup(dir1, dir2);
  }
});

test('extractTo creates nested parent directories', async () => {
  const files = { 'plugin.js': 'a', 'a/b/c/deep.js': 'deep' };
  const pkg = buildPackage(files);
  const verified = await verify(pkg.data);
  const dir = await tempDir();
  try {
    await verified.extractTo(dir);
    assert.ok((await stat(join(dir, 'a/b/c/deep.js'))).isFile());
    assert.equal(await readFile(join(dir, 'a/b/c/deep.js'), 'utf8'), 'deep');
  } finally {
    await cleanup(dir);
  }
});

test('extractTo refuses to overwrite existing files', async () => {
  const pkg = buildPackage(defaultFiles());
  const verified = await verify(pkg.data);
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'plugin.js'), 'preexisting');
    await assert.rejects(
      verified.extractTo(dir),
      (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EEXIST',
    );
  } finally {
    await cleanup(dir);
  }
});

test('tolerates directory entries alongside declared files', async () => {
  const pkg = buildPackage(defaultFiles(), {
    extraEntries: [{ name: 'lib/', data: Buffer.alloc(0) }],
  });
  const verified = await verify(pkg.data);
  const dir = await tempDir();
  try {
    await verified.extractTo(dir);
    assert.equal(await readFile(join(dir, 'lib/mod.js'), 'utf8'), defaultFiles()['lib/mod.js']);
  } finally {
    await cleanup(dir);
  }
});

test('isPluginSignatureFile recognizes only the root signature name', () => {
  assert.ok(isPluginSignatureFile('signature.json'));
  assert.ok(!isPluginSignatureFile('lib/signature.json'));
  assert.ok(!isPluginSignatureFile('manifest.json'));
  assert.ok(!isPluginSignatureFile('Signature.json'));
});

test('rejects a signature object with the wrong shape', async () => {
  const pkg = buildPackage(defaultFiles(), {
    omitSignature: true,
    extraEntries: [{ name: 'signature.json', data: Buffer.from('{"algorithm":"ed25519","key_id":"k"}') }],
  });
  await expectPackageError(pkg.data, 'invalid_signature_file');
});
