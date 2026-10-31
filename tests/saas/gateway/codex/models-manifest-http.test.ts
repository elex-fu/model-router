import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  codexModelsManifestEtag,
  isCodexModelsManifestRequest,
  matchesCodexModelsManifestEtag,
  renderCodexModelsManifestResponse,
} from '../../../../src/saas/gateway/codex/models-manifest-http.js';
import { DEFAULT_CODEX_MODEL_MANIFEST } from '../../../../src/saas/gateway/codex/models-manifest.js';

/*
 * P1-4b: the ChatGPT Codex manifest serving shape for
 * `GET /v1/models?client_version=...`. Pure module — no network, no PG.
 */

test('isCodexModelsManifestRequest detects a present, non-empty client_version parameter', () => {
  assert.equal(isCodexModelsManifestRequest('client_version=0.146.0'), true);
  assert.equal(isCodexModelsManifestRequest('?client_version=0.146.0'), true);
  assert.equal(isCodexModelsManifestRequest(new URLSearchParams('client_version=anything')), true);
  assert.equal(isCodexModelsManifestRequest(new URLSearchParams('client_version=0')), true); // value not validated
  assert.equal(isCodexModelsManifestRequest('client_version='), false); // empty value
  assert.equal(isCodexModelsManifestRequest('other=client_version'), false);
  assert.equal(isCodexModelsManifestRequest(''), false);
  assert.equal(isCodexModelsManifestRequest(new URLSearchParams('')), false);
});

test('rendering maps every manifest field into the upstream snake_case shape', () => {
  const rendered = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, null);
  assert.ok(rendered);
  const parsed = JSON.parse(rendered.body) as { models: Array<Record<string, unknown>> };
  assert.equal(parsed.models.length, 8);

  const sol = parsed.models[0];
  assert.equal(sol.slug, 'gpt-5.6-sol');
  assert.equal(sol.display_name, 'GPT-5.6-Sol');
  assert.equal(sol.description, 'Latest frontier agentic coding model.');
  assert.equal(sol.context_window, 272000);
  assert.equal(sol.max_context_window, 272000);
  assert.deepEqual(sol.input_modalities, ['text', 'image']);
  assert.equal(sol.default_reasoning_level, 'low');
  assert.deepEqual(sol.supported_reasoning_levels, [
    { effort: 'low' },
    { effort: 'medium' },
    { effort: 'high' },
  ]);
  assert.equal(sol.apply_patch_tool_type, 'freeform');
  assert.equal(sol.web_search_tool_type, 'text_and_image');
  assert.equal(sol.tool_mode, 'code_mode_only');
  assert.equal(sol.use_responses_lite, true);
  assert.equal(sol.supports_parallel_tool_calls, true);
  assert.equal(sol.prefer_websockets, true);
  assert.equal(sol.supports_image_detail_original, true);

  // Every entry carries the full field set.
  const expectedFields = [
    'slug',
    'display_name',
    'description',
    'context_window',
    'max_context_window',
    'input_modalities',
    'default_reasoning_level',
    'supported_reasoning_levels',
    'apply_patch_tool_type',
    'web_search_tool_type',
    'tool_mode',
    'use_responses_lite',
    'supports_parallel_tool_calls',
    'prefer_websockets',
    'supports_image_detail_original',
  ].sort();
  for (const entry of parsed.models) {
    assert.deepEqual(Object.keys(entry).sort(), expectedFields, String(entry.slug));
    assert.ok(Array.isArray(entry.supported_reasoning_levels));
    for (const level of entry.supported_reasoning_levels as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(level).sort(), ['effort']);
    }
  }
});

test('usableSlugs intersects with the manifest and preserves manifest order', () => {
  // Deliberately out of manifest order and containing a non-manifest slug.
  const rendered = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, [
    'codex-auto-review',
    'not-in-manifest',
    'gpt-5.5',
    'gpt-5.6-sol',
  ]);
  assert.ok(rendered);
  const parsed = JSON.parse(rendered.body) as { models: Array<{ slug: string }> };
  assert.deepEqual(parsed.models.map((entry) => entry.slug), ['gpt-5.6-sol', 'gpt-5.5', 'codex-auto-review']);
});

test('an empty intersection returns null so the caller falls back to the plain list', () => {
  assert.equal(renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, ['not-a-codex-model']), null);
  assert.equal(renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, []), null);
  assert.equal(renderCodexModelsManifestResponse([], null), null);
  assert.equal(renderCodexModelsManifestResponse([], ['gpt-5.5']), null);
});

test('null usableSlugs advertises the full default manifest', () => {
  const rendered = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, null);
  assert.ok(rendered);
  const parsed = JSON.parse(rendered.body) as { models: Array<{ slug: string }> };
  assert.equal(parsed.models.length, 8);
  assert.deepEqual(
    parsed.models.map((entry) => entry.slug),
    DEFAULT_CODEX_MODEL_MANIFEST.map((entry) => entry.slug),
  );
});

test('the ETag is a quoted sha1 of the body and is stable per input', () => {
  const first = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, null);
  const second = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, null);
  assert.ok(first && second);
  assert.equal(first.etag, second.etag);
  assert.equal(first.body, second.body);
  assert.equal(first.etag, `"${createHash('sha1').update(first.body).digest('hex')}"`);
  assert.match(first.etag, /^"[0-9a-f]{40}"$/);
  assert.equal(codexModelsManifestEtag(DEFAULT_CODEX_MODEL_MANIFEST, null), first.etag);
  assert.equal(codexModelsManifestEtag(DEFAULT_CODEX_MODEL_MANIFEST, ['not-in-manifest']), null); // empty intersection

  // Different input → different etag (subset vs. full list).
  const subset = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, ['gpt-5.5']);
  assert.ok(subset);
  assert.notEqual(subset.etag, first.etag);
  assert.notEqual(subset.body, first.body);
  assert.equal(codexModelsManifestEtag(DEFAULT_CODEX_MODEL_MANIFEST, ['gpt-5.5']), subset.etag);
});

test('If-None-Match matches exact, weak, and list forms; mismatch and absence do not', () => {
  const rendered = renderCodexModelsManifestResponse(DEFAULT_CODEX_MODEL_MANIFEST, null);
  assert.ok(rendered);
  const { etag } = rendered;

  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': etag }, etag), true);
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': `W/${etag}` }, etag), true);
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': `"other", ${etag}` }, etag), true);
  assert.equal(matchesCodexModelsManifestEtag({ 'If-None-Match': `  ${etag}  ` }, etag), true); // mixed case + trim
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': [etag, `"stale"`] }, etag), true); // array header
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': `"${'0'.repeat(40)}"` }, etag), false);
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': `W/"${'0'.repeat(40)}"` }, etag), false);
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': '*' }, etag), false); // * is not an exact/weak match
  assert.equal(matchesCodexModelsManifestEtag({}, etag), false);
  assert.equal(matchesCodexModelsManifestEtag({ 'if-none-match': undefined }, etag), false);
});
