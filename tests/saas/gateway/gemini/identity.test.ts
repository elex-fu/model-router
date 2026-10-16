import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEMINI_TIER_QUOTAS } from '../../../../src/saas/gateway/gemini/constants.js';
import {
  GeminiIdentityError,
  geminiAccountIdentityNamespace,
  geminiModelClass,
  geminiTierCooldownMs,
  normalizeGeminiTierId,
} from '../../../../src/saas/gateway/gemini/identity.js';

const UNKNOWN_COOLDOWN_MS = 90_000;

test('the namespace pins the code assist project and trims whitespace', () => {
  assert.equal(geminiAccountIdentityNamespace({ projectId: 'proj-1' }), 'gemini:project:proj-1');
  assert.equal(geminiAccountIdentityNamespace({ projectId: '  proj-1  ' }), 'gemini:project:proj-1');
  assert.equal(
    geminiAccountIdentityNamespace({ projectId: 'proj-1', tierId: 'gcp_standard', email: 'user@example.test' }),
    'gemini:project:proj-1',
  );
  // Empty coordinates throw: two accounts must never share a namespace.
  assert.throws(() => geminiAccountIdentityNamespace({ projectId: '' }), GeminiIdentityError);
  assert.throws(() => geminiAccountIdentityNamespace({ projectId: '   ' }), GeminiIdentityError);
  assert.throws(() => geminiAccountIdentityNamespace({ projectId: null as unknown as string }), GeminiIdentityError);
  assert.throws(
    () => geminiAccountIdentityNamespace(undefined as unknown as { projectId: string }),
    GeminiIdentityError,
  );
});

test('tier id normalization: canonical ids pass through, legacy spellings map, unknowns fail closed', () => {
  // Canonical ids are already keys of the quota table.
  for (const canonical of [
    'google_one_free',
    'google_ai_pro',
    'google_ai_ultra',
    'gcp_standard',
    'gcp_enterprise',
    'aistudio_free',
    'aistudio_paid',
    'google_one_unknown',
  ]) {
    assert.equal(normalizeGeminiTierId(canonical), canonical, canonical);
  }
  // Legacy/upstream spellings map onto the canonical ids.
  assert.equal(normalizeGeminiTierId('AI_PREMIUM'), 'google_ai_pro');
  assert.equal(normalizeGeminiTierId('GOOGLE_ONE_UNLIMITED'), 'google_ai_ultra');
  assert.equal(normalizeGeminiTierId('FREE'), 'google_one_free');
  assert.equal(normalizeGeminiTierId('GOOGLE_ONE_BASIC'), 'google_one_free');
  assert.equal(normalizeGeminiTierId('GOOGLE_ONE_STANDARD'), 'google_one_free');
  assert.equal(normalizeGeminiTierId('GOOGLE_ONE_UNKNOWN'), 'google_one_unknown');
  assert.equal(normalizeGeminiTierId('LEGACY'), 'gcp_standard');
  assert.equal(normalizeGeminiTierId('STANDARD'), 'gcp_standard');
  assert.equal(normalizeGeminiTierId('PRO'), 'gcp_standard');
  assert.equal(normalizeGeminiTierId('standard-tier'), 'gcp_standard');
  assert.equal(normalizeGeminiTierId('pro-tier'), 'gcp_standard');
  assert.equal(normalizeGeminiTierId('ENTERPRISE'), 'gcp_enterprise');
  assert.equal(normalizeGeminiTierId('ULTRA'), 'gcp_enterprise');
  assert.equal(normalizeGeminiTierId('ultra-tier'), 'gcp_enterprise');
  // Unknown spellings and absent values never guess a quota class.
  assert.equal(normalizeGeminiTierId('totally-made-up'), null);
  assert.equal(normalizeGeminiTierId(''), null);
  assert.equal(normalizeGeminiTierId('   '), null);
  assert.equal(normalizeGeminiTierId(null), null);
  assert.equal(normalizeGeminiTierId(undefined), null);
});

test('tier cooldowns come from the quota table; unknown tiers use the caller default', () => {
  assert.equal(geminiTierCooldownMs('gcp_standard', UNKNOWN_COOLDOWN_MS), GEMINI_TIER_QUOTAS.gcp_standard.cooldownMs);
  assert.equal(geminiTierCooldownMs('gcp_standard', UNKNOWN_COOLDOWN_MS), 5 * 60_000);
  assert.equal(geminiTierCooldownMs('google_ai_pro', UNKNOWN_COOLDOWN_MS), 5 * 60_000);
  assert.equal(geminiTierCooldownMs('google_one_free', UNKNOWN_COOLDOWN_MS), 30 * 60_000);
  assert.equal(geminiTierCooldownMs('aistudio_free', UNKNOWN_COOLDOWN_MS), 30 * 60_000);
  // Unknown tier → the injected default, not a table guess.
  assert.equal(geminiTierCooldownMs(null, UNKNOWN_COOLDOWN_MS), UNKNOWN_COOLDOWN_MS);
});

test('model class: flash/lite names count against the flash pool, everything else pro', () => {
  assert.equal(geminiModelClass('gemini-2.5-flash'), 'flash');
  assert.equal(geminiModelClass('gemini-2.0-flash-lite'), 'flash');
  assert.equal(geminiModelClass('gemini-flash-latest'), 'flash');
  assert.equal(geminiModelClass('gemma-3-lite'), 'flash');
  assert.equal(geminiModelClass('GEMINI-2.5-FLASH'), 'flash');
  assert.equal(geminiModelClass('gemini-2.5-pro'), 'pro');
  assert.equal(geminiModelClass('gemini-3-pro-preview'), 'pro');
  assert.equal(geminiModelClass('random-embedding-model'), 'pro');
});
