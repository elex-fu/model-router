import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_MANIFEST_SOURCE_REF,
  DEFAULT_CODEX_MODEL_MANIFEST,
  projectCodexManifest,
  projectCodexManifestEntry,
} from '../../../../src/saas/gateway/codex/models-manifest.js';

/*
 * P1-4: Codex models manifest projection (source: openai/codex
 * rust-v0.146.0 models.json artifact). Pure module — no network, no PG.
 */

test('the default manifest projects every upstream slug with metadata', () => {
  assert.equal(DEFAULT_CODEX_MODEL_MANIFEST.length, 8);
  const slugs = DEFAULT_CODEX_MODEL_MANIFEST.map((entry) => entry.slug);
  assert.deepEqual(slugs, [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.2',
    'codex-auto-review',
  ]);
  for (const entry of DEFAULT_CODEX_MODEL_MANIFEST) {
    assert.ok(entry.contextWindow > 0, `${entry.slug} context window`);
    assert.ok(entry.supportedReasoningEfforts.includes('medium'), `${entry.slug} reasoning levels`);
    assert.deepEqual(entry.inputModalities, ['text', 'image']);
    assert.equal(entry.applyPatchToolType, 'freeform');
  }
  const sol = DEFAULT_CODEX_MODEL_MANIFEST.find((entry) => entry.slug === 'gpt-5.6-sol');
  assert.equal(sol?.defaultReasoningLevel, 'low');
  assert.equal(sol?.useResponsesLite, true);
  assert.equal(sol?.preferWebsockets, true);
});

test('projection skips malformed rows and unknown shapes without guessing', () => {
  assert.equal(projectCodexManifestEntry(null), null);
  assert.equal(projectCodexManifestEntry({}), null); // no slug
  assert.equal(projectCodexManifestEntry({ slug: '' }), null);
  assert.equal(projectCodexManifest('not-an-object').length, 0);
  assert.equal(projectCodexManifest({ models: 'nope' }).length, 0);
  const projected = projectCodexManifest({
    models: [{ slug: 'ok-model' }, { broken: true }, 'string-row', { slug: 'second' }],
  });
  assert.deepEqual(
    projected.map((entry) => entry.slug),
    ['ok-model', 'second'],
  );
});

test('projection defaults derived fields conservatively', () => {
  const entry = projectCodexManifestEntry({ slug: 'bare-model' });
  assert.ok(entry);
  assert.equal(entry.displayName, 'bare-model'); // slug as display fallback
  assert.equal(entry.description, '');
  assert.equal(entry.contextWindow, 0);
  assert.deepEqual(entry.supportedReasoningEfforts, []);
  assert.equal(entry.defaultReasoningLevel, null);
  assert.equal(entry.useResponsesLite, false);
});

test('the manifest source ref is pinned and stable', () => {
  assert.match(CODEX_MANIFEST_SOURCE_REF, /^rust-v\d+\.\d+\.\d+$/);
});
