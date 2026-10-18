import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COUNT_TOKENS_FEATURE_ESTIMATE,
  COUNT_TOKENS_FEATURE_NATIVE,
  matchGeminiNativeContentPath,
  matchSaasEndpointEntry,
  RESPONSES_COMPACT_FEATURE_NATIVE,
  SAAS_ENDPOINT_REGISTRY,
} from '../../../src/saas/gateway/endpoint-registry.js';

test('R2 §7.2: the registry declares exactly the five SaaS entries with the §4 declaration fields', () => {
  assert.deepEqual(
    SAAS_ENDPOINT_REGISTRY.map((entry) => `${entry.method} ${entry.path}`),
    [
      'POST /v1/messages/count_tokens',
      'POST /v1/responses/compact',
      'POST /v1beta/models/:model:generateContent',
      'POST /v1beta/models/:model:streamGenerateContent',
      'GET /v1beta/models',
    ],
  );
  for (const entry of SAAS_ENDPOINT_REGISTRY) {
    assert.ok(entry.id.length > 0);
    assert.ok(entry.operation.length > 0);
    assert.ok(entry.provenanceOperation.length > 0);
    assert.ok(entry.transformVersion.length > 0);
    assert.ok(entry.supportedFeatures.length > 0);
  }
  // The two auxiliary operations declare their §7.2 features explicitly.
  const countTokens = SAAS_ENDPOINT_REGISTRY[0];
  assert.ok(countTokens.supportedFeatures.includes(COUNT_TOKENS_FEATURE_NATIVE));
  assert.ok(countTokens.supportedFeatures.includes(COUNT_TOKENS_FEATURE_ESTIMATE));
  const compact = SAAS_ENDPOINT_REGISTRY[1];
  assert.deepEqual(compact.supportedFeatures, [RESPONSES_COMPACT_FEATURE_NATIVE]);
});

test('R2 §7.2: the Gemini native entries carry CHECK-legal provenance; the auxiliary entries stay family-canonical', () => {
  const byId = new Map(SAAS_ENDPOINT_REGISTRY.map((entry) => [entry.id, entry]));
  // (gemini, 'generateContent') is already accepted by the migration-029/104
  // provenance-shape CHECK on both the client and provider side.
  for (const id of ['gemini.generateContent', 'gemini.streamGenerateContent']) {
    const entry = byId.get(id);
    assert.ok(entry);
    assert.equal(entry.protocol, 'gemini');
    assert.equal(entry.operation, 'generateContent');
    assert.equal(entry.provenanceOperation, 'generateContent');
  }
  // count_tokens / responses.compact wait for the migration-131+ CHECK
  // widening; their attempts ride the family-canonical operation.
  assert.equal(byId.get('anthropic.count_tokens')?.provenanceOperation, 'messages');
  assert.equal(byId.get('responses.compact')?.provenanceOperation, 'responses');
});

test('R2 §7.2: matchGeminiNativeContentPath parses the public model from the path', () => {
  assert.deepEqual(matchGeminiNativeContentPath('/v1beta/models/gemini-2.5-pro:generateContent'), {
    model: 'gemini-2.5-pro',
    stream: false,
  });
  assert.deepEqual(matchGeminiNativeContentPath('/v1beta/models/gemini-2.5-flash:streamGenerateContent'), {
    model: 'gemini-2.5-flash',
    stream: true,
  });
  // The `models/` resource prefix form normalizes to the bare model id.
  assert.deepEqual(matchGeminiNativeContentPath('/v1beta/models/models/gemini-3-pro:generateContent'), {
    model: 'gemini-3-pro',
    stream: false,
  });
  // Unknown actions, malformed segments, and non-Gemini paths do not match.
  assert.equal(matchGeminiNativeContentPath('/v1beta/models/gemini-2.5-pro:countTokens'), null);
  assert.equal(matchGeminiNativeContentPath('/v1beta/models/:generateContent'), null);
  assert.equal(matchGeminiNativeContentPath('/v1beta/models/gemini-2.5-pro'), null);
  assert.equal(matchGeminiNativeContentPath('/v1beta/models/gemini-2.5-pro:generateContent/extra'), null);
  assert.equal(matchGeminiNativeContentPath('/v1/messages'), null);
  assert.equal(matchGeminiNativeContentPath('/v1beta/models'), null);
});

test('R2 §7.2: matchSaasEndpointEntry answers method routing with 405 semantics', () => {
  // Known paths, matching method.
  for (const [method, path] of [
    ['POST', '/v1/messages/count_tokens'],
    ['POST', '/v1/responses/compact'],
    ['GET', '/v1beta/models'],
  ] as const) {
    const match = matchSaasEndpointEntry(method, path);
    assert.ok(match.matched, `${method} ${path} must match the registry`);
    assert.ok(match.methodAllowed);
  }
  // Known paths, wrong method → matched but not allowed (405 territory).
  for (const [method, path] of [
    ['GET', '/v1/messages/count_tokens'],
    ['DELETE', '/v1/responses/compact'],
    ['POST', '/v1beta/models'],
  ] as const) {
    const match = matchSaasEndpointEntry(method, path);
    assert.ok(match.matched, `${method} ${path} must still match the registry`);
    assert.equal(match.methodAllowed, false);
  }
  // Gemini native content paths: POST allowed, other methods 405.
  const post = matchSaasEndpointEntry('POST', '/v1beta/models/gemini-2.5-pro:generateContent');
  assert.ok(post.matched && post.methodAllowed);
  assert.equal(post.entry.id, 'gemini.generateContent');
  const postStream = matchSaasEndpointEntry('POST', '/v1beta/models/gemini-2.5-pro:streamGenerateContent');
  assert.ok(postStream.matched && postStream.methodAllowed);
  assert.equal(postStream.entry.id, 'gemini.streamGenerateContent');
  const get = matchSaasEndpointEntry('GET', '/v1beta/models/gemini-2.5-pro:generateContent');
  assert.ok(get.matched);
  assert.equal(get.methodAllowed, false);
  // Unknown paths never match.
  assert.deepEqual(matchSaasEndpointEntry('POST', '/v1/messages'), { matched: false });
  assert.deepEqual(matchSaasEndpointEntry('GET', '/v1beta/models/other:unknownAction'), { matched: false });
  assert.deepEqual(matchSaasEndpointEntry('POST', '/v1beta/other'), { matched: false });
});
