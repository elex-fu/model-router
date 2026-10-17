import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VERTEX_ANTHROPIC_MODELS,
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_ENDPOINT,
  VERTEX_GEMINI_MODELS,
  VERTEX_PLACEHOLDER_MODELS,
  vertexAccountIdentityNamespace,
} from '../../../../src/saas/gateway/vertex/catalog-identity.js';

test('the catalog identity constants pin the single-source-of-truth triple', () => {
  assert.equal(VERTEX_ENDPOINT, 'vertex-raw-predict');
  assert.equal(VERTEX_CREDENTIAL_TYPE, 'service_account');
  // The placeholder catalog splits across the two provider protocols but
  // shares one endpoint scope.
  assert.deepEqual([...VERTEX_ANTHROPIC_MODELS, ...VERTEX_GEMINI_MODELS], VERTEX_PLACEHOLDER_MODELS);
  assert.equal(new Set(VERTEX_PLACEHOLDER_MODELS).size, VERTEX_PLACEHOLDER_MODELS.length);
  for (const model of VERTEX_ANTHROPIC_MODELS) {
    assert.match(model, /^claude-/);
  }
  for (const model of VERTEX_GEMINI_MODELS) {
    assert.match(model, /^gemini-/);
  }
});

test('the identity namespace is per-project and fails closed on empty coordinates', () => {
  assert.equal(vertexAccountIdentityNamespace({ projectId: 'proj-1' }), 'vertex:project:proj-1');
  assert.equal(vertexAccountIdentityNamespace({ projectId: ' proj-1 ' }), 'vertex:project:proj-1');
  assert.throws(() => vertexAccountIdentityNamespace({ projectId: '' }));
  assert.throws(() => vertexAccountIdentityNamespace({ projectId: '   ' }));
  assert.throws(() => vertexAccountIdentityNamespace(null as never));
});
