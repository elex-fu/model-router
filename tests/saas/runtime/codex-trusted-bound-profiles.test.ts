import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CodexTrustedBoundProfile,
  type CodexTrustedBoundScope,
  codexBoundCompilerVersion,
  codexTrustedBoundReadiness,
  codexTrustedProfileDigest,
  createCodexTrustedBoundProfileResolver,
  resolveCodexBoundSendProfile,
  resolveCodexTrustedBoundProfile,
} from '../../../src/saas/runtime/codex-trusted-bound-profiles.js';

const profile: CodexTrustedBoundProfile = {
  scope: {
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    productId: 'codex-chatgpt',
    model: 'model',
    operation: 'responses',
    transport: 'http',
    continuationMode: 'canonical-replay',
  },
  backendRevision: 'revision',
  evidenceVersion: 'proof-v1',
  evidenceReference: 'reviewed-contract-reference',
  validFromMs: 0,
  expiresAtMs: 1000,
  bounds: {
    inputTotalUpperBound: '100',
    inputUncachedUpperBound: '100',
    cacheReadUpperBound: '100',
    cacheWriteUpperBound: '100',
    cacheWrite5mUpperBound: '100',
    cacheWrite1hUpperBound: '100',
    outputTotalUpperBound: '20',
    reasoningOutputUpperBound: '20',
    feasibleInputBuckets: ['input'],
  },
};
test('reviewed Codex registry starts empty and cannot be unlocked with arbitrary profile JSON', () => {
  assert.equal(resolveCodexTrustedBoundProfile(profile.scope, 100), null);
  assert.equal(
    resolveCodexBoundSendProfile(codexBoundCompilerVersion('compiler-v1', profile), 'compiler-v1', profile.scope, 100),
    null,
  );
  assert.deepEqual(codexTrustedBoundReadiness(), {
    admittedProfileCount: 0,
    reason: 'No reviewed endpoint-specific Codex enforcement and metering contract is admitted',
  });
});
test('Codex bound compiler version is bounded and commits complete profile content', () => {
  const signed = codexBoundCompilerVersion('compiler-v1', profile);
  assert.equal(signed.length, 47);
  for (const changed of [
    { ...profile, expiresAtMs: 2000 },
    { ...profile, backendRevision: 'other' },
    { ...profile, scope: { ...profile.scope, continuationMode: 'full' as const } },
    { ...profile, bounds: { ...profile.bounds, outputTotalUpperBound: '21' } },
  ])
    assert.notEqual(codexTrustedProfileDigest(changed), codexTrustedProfileDigest(profile));
  assert.notEqual(codexBoundCompilerVersion('compiler-v2', profile), signed);
  const reordered = {
    ...profile,
    bounds: Object.fromEntries(Object.entries(profile.bounds).reverse()),
  } as CodexTrustedBoundProfile;
  assert.equal(codexTrustedProfileDigest(reordered), codexTrustedProfileDigest(profile));
});
const httpScope: CodexTrustedBoundScope = {
  ...profile.scope,
  continuationMode: 'full' as const,
  transport: 'http' as const,
};
const httpProfile: CodexTrustedBoundProfile = { ...profile, scope: httpScope };
test('injected resolver admits exact scope in-window and fails closed on every mismatch axis', () => {
  const resolver = createCodexTrustedBoundProfileResolver([httpProfile]);
  const admitted = resolver.resolve(httpScope, 100);
  assert.ok(admitted);
  assert.equal(admitted.digest, codexTrustedProfileDigest(httpProfile));
  assert.deepEqual(admitted.profile, httpProfile);
  // Out-of-window: fail closed on both boundaries.
  assert.equal(resolver.resolve(httpScope, httpProfile.validFromMs - 1), null);
  assert.equal(resolver.resolve(httpScope, httpProfile.expiresAtMs), null);
  // Scope mismatch on every single axis: fail closed.
  for (const mutated of [
    { ...httpScope, endpoint: 'https://chatgpt.com/backend-api/codex/responses/compact' },
    { ...httpScope, productId: 'codex-chatgpt-plus' },
    { ...httpScope, model: 'other-model' },
    { ...httpScope, operation: 'responses.compact' },
    { ...httpScope, transport: 'websocket' as const },
    { ...httpScope, continuationMode: 'canonical-replay' as const },
  ] satisfies CodexTrustedBoundScope[])
    assert.equal(resolver.resolve(mutated, 100), null);
  // Digest activeness follows the same validity window.
  assert.equal(resolver.isDigestActive(admitted.digest, 100), true);
  assert.equal(resolver.isDigestActive(admitted.digest, httpProfile.expiresAtMs), false);
  assert.equal(resolver.isDigestActive('0'.repeat(64), 100), false);
  // Readiness reports the injected registry truthfully.
  assert.deepEqual(resolver.readiness(), {
    admittedProfileCount: 1,
    reason: 'Reviewed Codex enforcement and metering contracts are admitted',
  });
});
test('injected resolver send-profile re-validates the signed compiler version against exact scope', () => {
  const resolver = createCodexTrustedBoundProfileResolver([httpProfile]);
  const version = codexBoundCompilerVersion('compiler-v1', httpProfile);
  const { continuationMode: _continuation, ...actual } = httpScope;
  assert.equal(resolver.sendProfile(version, 'compiler-v1', actual, 100), httpProfile);
  // Wrong compiler version, wrong signed version, and any scope mismatch all fail closed.
  assert.equal(resolver.sendProfile(version, 'compiler-v2', actual, 100), null);
  assert.equal(
    resolver.sendProfile('cb1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'compiler-v1', actual, 100),
    null,
  );
  assert.equal(
    resolver.sendProfile(version, 'compiler-v1', { ...actual, endpoint: `${actual.endpoint}/compact` }, 100),
    null,
  );
  assert.equal(resolver.sendProfile(version, 'compiler-v1', actual, httpProfile.expiresAtMs), null);
  // Empty injected registry keeps the production fail-closed contract.
  const empty = createCodexTrustedBoundProfileResolver([]);
  assert.equal(empty.sendProfile(version, 'compiler-v1', actual, 100), null);
  assert.deepEqual(empty.readiness(), {
    admittedProfileCount: 0,
    reason: 'No reviewed endpoint-specific Codex enforcement and metering contract is admitted',
  });
});
