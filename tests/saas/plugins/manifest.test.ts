/**
 * Batch-5 §5.1 plugin manifest tests: strict schema validation (exact key
 * set, capability allow-list, entrypoint/file coupling, sha256 file map) and
 * the from-scratch semver range matcher + host compatibility evaluation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluatePluginCompatibility,
  PluginManifestError,
  parsePluginManifest,
  semverRangeMatches,
} from '../../../src/saas/plugins/package/manifest.js';
import { PLUGIN_HOST_VERSION, type PluginManifest } from '../../../src/saas/plugins/types.js';

const CAPABILITY = 'claude.oauth.outbound_transport.v1';

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    id: 'acme.transport-bridge',
    name: 'Transport Bridge',
    version: 'v1.2.3',
    requires: { model_router: '>=0.1.0', plugin_protocol: 1, transport_api: 1 },
    capabilities: [{ id: CAPABILITY }],
    entrypoint: 'plugin.js',
    files: { 'plugin.js': 'a'.repeat(64), 'lib/mod.js': 'b'.repeat(64) },
    ...overrides,
  });
}

function expectManifestError(raw: string, code: string): void {
  assert.throws(
    () => parsePluginManifest(raw),
    (error: unknown): boolean => error instanceof PluginManifestError && error.code === code,
    `expected PluginManifestError with code "${code}"`,
  );
}

function compatibleManifest(overrides: Partial<PluginManifest['requires']> = {}): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'acme.transport-bridge',
    name: 'Transport Bridge',
    version: '1.2.3',
    description: '',
    author: '',
    requires: { modelRouter: '>=0.1.0', pluginProtocol: 1, transportApi: 1, ...overrides },
    capabilities: [{ id: CAPABILITY }],
    entrypoint: 'plugin.js',
    files: { 'plugin.js': 'a'.repeat(64) },
  };
}

test('parses a valid manifest and normalizes a v-prefixed version', () => {
  const manifest = parsePluginManifest(manifestJson());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'acme.transport-bridge');
  assert.equal(manifest.name, 'Transport Bridge');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.description, '');
  assert.equal(manifest.author, '');
  assert.deepEqual(manifest.requires, { modelRouter: '>=0.1.0', pluginProtocol: 1, transportApi: 1 });
  assert.deepEqual(manifest.capabilities, [{ id: CAPABILITY }]);
  assert.equal(manifest.entrypoint, 'plugin.js');
  assert.deepEqual(Object.keys(manifest.files), ['plugin.js', 'lib/mod.js']);
});

test('rejects unknown top-level keys', () => {
  expectManifestError(manifestJson({ surprise: true }), 'unknown_key');
});

test('rejects an invalid plugin id', () => {
  expectManifestError(manifestJson({ id: 'transportbridge' }), 'invalid_id');
  expectManifestError(manifestJson({ id: 'UPPER-case' }), 'invalid_id');
  expectManifestError(manifestJson({ id: 'x'.repeat(161) }), 'invalid_id');
});

test('rejects an invalid version', () => {
  expectManifestError(manifestJson({ version: '1.2' }), 'invalid_version');
  expectManifestError(manifestJson({ version: 'latest' }), 'invalid_version');
});

test('rejects an unsupported capability id', () => {
  expectManifestError(manifestJson({ capabilities: [{ id: 'admin.root.v1' }] }), 'unsupported_capability');
});

test('rejects duplicate capability ids', () => {
  expectManifestError(manifestJson({ capabilities: [{ id: CAPABILITY }, { id: CAPABILITY }] }), 'duplicate_capability');
});

test('rejects an entrypoint that is not declared in files', () => {
  expectManifestError(manifestJson({ entrypoint: 'main.js' }), 'invalid_entrypoint');
});

test('rejects an empty files record', () => {
  expectManifestError(manifestJson({ files: {} }), 'invalid_files');
});

test('rejects malformed file hashes', () => {
  expectManifestError(
    manifestJson({ files: { 'plugin.js': 'not-a-hash', 'lib/mod.js': 'b'.repeat(64) } }),
    'invalid_file_hash',
  );
});

test('rejects unsafe file paths', () => {
  expectManifestError(
    manifestJson({ files: { 'plugin.js': 'a'.repeat(64), '../escape.js': 'b'.repeat(64) } }),
    'invalid_file_path',
  );
  expectManifestError(
    manifestJson({ files: { 'plugin.js': 'a'.repeat(64), '': 'b'.repeat(64) } }),
    'invalid_file_path',
  );
});

test('rejects a missing required key', () => {
  const parsed = JSON.parse(manifestJson());
  delete parsed.name;
  expectManifestError(JSON.stringify(parsed), 'missing_key');
});

test('rejects an invalid requires block', () => {
  expectManifestError(
    manifestJson({ requires: { model_router: '>=0.1.0', plugin_protocol: 2, transport_api: 1 } }),
    'unsupported_plugin_protocol',
  );
  expectManifestError(
    manifestJson({ requires: { model_router: '>=0.1.0', plugin_protocol: 1, transport_api: 3 } }),
    'unsupported_transport_api',
  );
  expectManifestError(
    manifestJson({ requires: { model_router: '', plugin_protocol: 1, transport_api: 1 } }),
    'invalid_model_router_requirement',
  );
  expectManifestError(manifestJson({ requires: { model_router: '>=0.1.0', plugin_protocol: 1 } }), 'invalid_requires');
});

test('semverRangeMatches handles every operator', () => {
  assert.ok(semverRangeMatches('>=0.1.0', '0.1.0'));
  assert.ok(semverRangeMatches('>=0.1.0', '1.0.0'));
  assert.ok(!semverRangeMatches('<1.0.0', '1.0.0'));
  assert.ok(semverRangeMatches('<1.0.0', '0.9.9'));
  assert.ok(semverRangeMatches('0.1.0', '0.1.0'));
  assert.ok(!semverRangeMatches('0.1.0', '0.1.1'));
  assert.ok(semverRangeMatches('>0.1.0', '0.1.1'));
  assert.ok(!semverRangeMatches('>0.1.0', '0.1.0'));
  assert.ok(semverRangeMatches('<=0.1.0', '0.1.0'));
  assert.ok(!semverRangeMatches('<=0.1.0', '0.1.1'));
  assert.ok(semverRangeMatches('=0.1.0', '0.1.0'));
  // core-only comparison: prerelease tags never affect the verdict
  assert.ok(semverRangeMatches('>=0.1.0', '1.0.0-beta.1'));
  assert.ok(!semverRangeMatches('<1.0.0', '1.0.0-rc.1'));
});

test('semverRangeMatches ANDs space- and comma-separated tokens', () => {
  assert.ok(semverRangeMatches('>=0.1.0 <2.0.0', '1.5.0'));
  assert.ok(!semverRangeMatches('>=0.1.0 <2.0.0', '2.0.0'));
  assert.ok(!semverRangeMatches('>=0.1.0 <2.0.0', '0.0.9'));
  assert.ok(semverRangeMatches('>=0.1.0,<2.0.0', '1.5.0'));
  assert.ok(semverRangeMatches('>=0.1.0, <2.0.0', '1.5.0'));
  assert.ok(!semverRangeMatches('>=0.1.0, <2.0.0', '2.1.0'));
});

test('semverRangeMatches never matches an invalid range or version', () => {
  assert.ok(!semverRangeMatches('', '0.1.0'));
  assert.ok(!semverRangeMatches('   ', '0.1.0'));
  assert.ok(!semverRangeMatches('>=not-semver', '0.1.0'));
  assert.ok(!semverRangeMatches('>=0.1.0 <oops', '0.1.0'));
  assert.ok(!semverRangeMatches('>=0.1.0', 'not-semver'));
});

test('evaluatePluginCompatibility resolves compatible and every mismatch reason', () => {
  assert.deepEqual(evaluatePluginCompatibility(compatibleManifest()), { state: 'compatible', reason: null });
  assert.equal(
    evaluatePluginCompatibility(compatibleManifest({ pluginProtocol: 2 })).reason,
    'plugin_protocol_unsupported',
  );
  assert.equal(
    evaluatePluginCompatibility(compatibleManifest({ transportApi: 2 })).reason,
    'transport_api_unsupported',
  );
  assert.equal(
    evaluatePluginCompatibility(compatibleManifest({ modelRouter: '>=99.0.0' })).reason,
    'model_router_version_unsupported',
  );
  assert.equal(evaluatePluginCompatibility(compatibleManifest({ modelRouter: '<=0.1.0' })).state, 'compatible');
  assert.ok(semverRangeMatches('>=0.1.0', PLUGIN_HOST_VERSION));
});
