import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexBoundCompilerVersion, codexTrustedProfileDigest, resolveCodexTrustedBoundProfile, resolveCodexBoundSendProfile, type CodexTrustedBoundProfile } from '../../../src/saas/runtime/codex-trusted-bound-profiles.js';
const profile: CodexTrustedBoundProfile = {
  scope: { endpoint: 'https://chatgpt.com/backend-api/codex/responses', productId: 'codex-chatgpt', model: 'model', operation: 'responses', transport: 'http', continuationMode: 'canonical-replay' },
  backendRevision: 'revision', evidenceVersion: 'proof-v1', evidenceReference: 'reviewed-contract-reference', validFromMs: 0, expiresAtMs: 1000,
  bounds: { inputTotalUpperBound: '100', inputUncachedUpperBound: '100', cacheReadUpperBound: '100', cacheWriteUpperBound: '100', cacheWrite5mUpperBound: '100', cacheWrite1hUpperBound: '100', outputTotalUpperBound: '20', reasoningOutputUpperBound: '20', feasibleInputBuckets: ['input'] },
};
test('reviewed Codex registry starts empty and cannot be unlocked with arbitrary profile JSON', () => {
  assert.equal(resolveCodexTrustedBoundProfile(profile.scope, 100), null);
  assert.equal(resolveCodexBoundSendProfile(codexBoundCompilerVersion('compiler-v1', profile), 'compiler-v1', profile.scope, 100), null);
});
test('Codex bound compiler version is bounded and commits complete profile content', () => {
  const signed = codexBoundCompilerVersion('compiler-v1', profile);
  assert.equal(signed.length, 47);
  for (const changed of [
    { ...profile, expiresAtMs: 2000 },
    { ...profile, backendRevision: 'other' },
    { ...profile, scope: { ...profile.scope, continuationMode: 'full' as const } },
    { ...profile, bounds: { ...profile.bounds, outputTotalUpperBound: '21' } },
  ]) assert.notEqual(codexTrustedProfileDigest(changed), codexTrustedProfileDigest(profile));
  assert.notEqual(codexBoundCompilerVersion('compiler-v2', profile), signed);
  const reordered = { ...profile, bounds: Object.fromEntries(Object.entries(profile.bounds).reverse()) } as CodexTrustedBoundProfile;
  assert.equal(codexTrustedProfileDigest(reordered), codexTrustedProfileDigest(profile));
});
