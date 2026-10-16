import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_AI_STUDIO_BASE_URL,
  GEMINI_CLI_BASE_URL,
  GEMINI_CLI_HOST,
  GEMINI_CREDENTIAL_TYPE,
  GEMINI_DISPLAY_NAME,
  GEMINI_ENDPOINT,
  GEMINI_PLACEHOLDER_MODELS,
  GEMINI_PRODUCT_ID,
  GEMINI_PROTOCOL,
  GEMINI_PROVIDER_ID,
  GEMINI_PURPOSE,
  GEMINI_REGION,
  GEMINI_SUPPLY_MODE,
} from '../../../../src/saas/gateway/gemini/catalog-identity.js';
import { normalizeGeminiModelId } from '../../../../src/saas/gateway/gemini/transform.js';

test('the Gemini subscription catalog identity is pinned', () => {
  assert.equal(GEMINI_PROVIDER_ID, 'google-gemini');
  assert.equal(GEMINI_PRODUCT_ID, 'gemini-subscription');
  assert.equal(GEMINI_CREDENTIAL_TYPE, 'oauth');
  assert.equal(GEMINI_SUPPLY_MODE, 'platform');
  assert.equal(GEMINI_REGION, 'global');
  assert.equal(GEMINI_PURPOSE, 'inference');
  assert.equal(GEMINI_PROTOCOL, 'gemini');
  assert.equal(GEMINI_ENDPOINT, 'gemini-generate-content');
  assert.equal(GEMINI_DISPLAY_NAME, 'Google Gemini (Gemini CLI subscription)');
});

test('the pinned upstream bases are the only production dial targets', () => {
  assert.equal(GEMINI_CLI_BASE_URL, 'https://cloudcode-pa.googleapis.com');
  assert.equal(GEMINI_AI_STUDIO_BASE_URL, 'https://generativelanguage.googleapis.com');
  assert.equal(GEMINI_CLI_HOST, 'cloudcode-pa.googleapis.com');
  // Both bases are https so the transport's protocol pin accepts them.
  for (const base of [GEMINI_CLI_BASE_URL, GEMINI_AI_STUDIO_BASE_URL]) {
    assert.equal(new URL(base).protocol, 'https:');
  }
});

test('the placeholder model set covers the catalog ids the transform normalizes onto', () => {
  assert.deepEqual(GEMINI_PLACEHOLDER_MODELS, [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-3-pro-preview',
    'gemini-3-flash',
  ]);
  // The alias families the transform maps land inside the placeholder set.
  for (const alias of ['gemini-2.5-pro-latest', 'gemini-3-pro', 'gemini-3.1-pro']) {
    assert.equal(GEMINI_PLACEHOLDER_MODELS.includes(normalizeGeminiModelId(alias)), true, alias);
  }
});
