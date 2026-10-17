import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveVertexLocation,
  VERTEX_DEFAULT_LOCATION,
  VERTEX_SUPPORTED_BETA_TOKENS,
} from '../../../../src/saas/gateway/vertex/constants.js';
import {
  applyVertexAnthropicTransform,
  buildVertexAnthropicHeaders,
  buildVertexAnthropicRequestBody,
  buildVertexAnthropicUrl,
  buildVertexGeminiUrl,
  filterVertexBetaTokens,
  normalizeVertexAnthropicModelId,
  parseVertexBetaTokens,
  sanitizeVertexBodyForBetaTokens,
  VertexTransformError,
  vertexApiHost,
  vertexBetaTokensContain,
} from '../../../../src/saas/gateway/vertex/transform.js';

test('the Vertex URL matrix mirrors sub2api buildVertexAnthropicURL / buildVertexGeminiURL', () => {
  // Anthropic regional rawPredict.
  assert.equal(
    buildVertexAnthropicUrl({
      projectId: 'proj-1',
      location: 'us-central1',
      model: 'claude-opus-4-5',
      stream: false,
    }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-opus-4-5:rawPredict',
  );
  // Anthropic global streamRawPredict has no regional host prefix.
  assert.equal(
    buildVertexAnthropicUrl({
      projectId: 'proj-1',
      location: 'global',
      model: 'claude-sonnet-4-5',
      stream: true,
    }),
    'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict',
  );
  // An already-dated @ model id keeps its literal @ (never %40).
  assert.equal(
    buildVertexAnthropicUrl({
      projectId: 'my project',
      location: 'europe-west1',
      model: 'claude-x@20260101',
      stream: false,
    }),
    'https://europe-west1-aiplatform.googleapis.com/v1/projects/my%20project/locations/europe-west1/publishers/anthropic/models/claude-x@20260101:rawPredict',
  );
  // Gemini regional generateContent / streamGenerateContent?alt=sse.
  assert.equal(
    buildVertexGeminiUrl({
      projectId: 'proj-1',
      location: 'us-central1',
      model: 'gemini-2.5-pro',
      stream: false,
    }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
  );
  assert.equal(
    buildVertexGeminiUrl({
      projectId: 'proj-1',
      location: 'global',
      model: 'gemini-2.5-flash',
      stream: true,
    }),
    'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
  );
  // Malformed inputs fail closed.
  for (const malformed of [
    () => buildVertexAnthropicUrl({ projectId: '', location: 'us-central1', model: 'm', stream: false }),
    () => buildVertexAnthropicUrl({ projectId: 'p', location: 'bad_location!', model: 'm', stream: false }),
    () => buildVertexAnthropicUrl({ projectId: 'p', location: 'us-central1', model: '', stream: false }),
    () => buildVertexGeminiUrl({ projectId: 'p', location: 'UPPER', model: 'm', stream: false }),
  ]) {
    assert.throws(malformed, VertexTransformError);
  }
});

test('vertexApiHost applies the regional prefix except for global', () => {
  assert.equal(vertexApiHost('us-central1'), 'us-central1-aiplatform.googleapis.com');
  assert.equal(vertexApiHost('global'), 'aiplatform.googleapis.com');
  assert.equal(vertexApiHost('europe-west3', 'example.test'), 'europe-west3-example.test');
  assert.equal(vertexApiHost('global', 'example.test'), 'example.test');
});

test('model id normalization rewrites the dated CLI spelling onto the Vertex @ spelling', () => {
  assert.equal(normalizeVertexAnthropicModelId('claude-opus-4-5-20260101'), 'claude-opus-4-5@20260101');
  assert.equal(normalizeVertexAnthropicModelId('claude-x-20251231'), 'claude-x@20251231');
  assert.equal(normalizeVertexAnthropicModelId('claude-x@20260101'), 'claude-x@20260101');
  assert.equal(normalizeVertexAnthropicModelId('claude-opus-4-5'), 'claude-opus-4-5');
  assert.equal(normalizeVertexAnthropicModelId('  claude-opus-4-5  '), 'claude-opus-4-5');
  // A trailing date-like segment that is not exactly 8 digits stays put.
  assert.equal(normalizeVertexAnthropicModelId('model-1234567890'), 'model-1234567890');
});

test('the beta whitelist strips every token Vertex would answer with HTTP 400', () => {
  assert.deepEqual(
    filterVertexBetaTokens(
      'context-1m-2025-08-07,advisor-tool-2026-03-01,prompt-caching-scope-2026-01-05,redact-thinking-2026-02-12,thinking-token-count-2026-05-13',
    ),
    'context-1m-2025-08-07',
  );
  // Dedup + order preservation + whitespace tolerance.
  assert.equal(
    filterVertexBetaTokens(
      ' interleaved-thinking-2025-05-14 , context-1m-2025-08-07, interleaved-thinking-2025-05-14 ',
    ),
    'interleaved-thinking-2025-05-14,context-1m-2025-08-07',
  );
  // All four whitelisted tokens survive together.
  assert.equal(filterVertexBetaTokens(VERTEX_SUPPORTED_BETA_TOKENS.join(',')), VERTEX_SUPPORTED_BETA_TOKENS.join(','));
  // Client-identity betas never ride the service-account path.
  assert.equal(filterVertexBetaTokens('claude-code-20250219,oauth-2025-04-20'), '');
  // Unknown-only or empty input produces no header value.
  assert.equal(filterVertexBetaTokens('totally-unknown-beta'), '');
  assert.equal(filterVertexBetaTokens(''), '');
  assert.equal(filterVertexBetaTokens(null), '');
  assert.deepEqual(parseVertexBetaTokens('a,, b ,a'), ['a', 'b']);
  assert.equal(vertexBetaTokensContain('context-1m-2025-08-07,other', 'context-1m-2025-08-07'), true);
  assert.equal(vertexBetaTokensContain('context-1m-2025-08-07', 'context-1m'), false);
});

test('the body sanitize strips beta-gated fields the final header does not authorize', () => {
  const body = {
    model: 'claude-opus-4-5',
    max_tokens: 16,
    messages: [],
    context_management: { edits: [] },
    thinking: { type: 'enabled', budget_tokens: 1024, block_binding: { kind: 'tools' } },
    fallbacks: [{ model: 'claude-haiku-4-5' }],
    fallback_credit_token: 'tok',
  };
  // No context-management beta: the field strips (task contract).
  const stripped = sanitizeVertexBodyForBetaTokens(body, '');
  assert.equal(stripped.changed, true);
  assert.equal('context_management' in stripped.body, false);
  assert.equal('fallbacks' in stripped.body, false);
  assert.equal('fallback_credit_token' in stripped.body, false);
  assert.equal((stripped.body.thinking as Record<string, unknown>).block_binding, undefined);
  assert.equal((stripped.body.thinking as Record<string, unknown>).budget_tokens, 1024);
  // The input object is never mutated.
  assert.equal('context_management' in body, true);
  assert.equal('fallbacks' in body, true);
  // With the context-management beta present the field survives; the never-
  // whitelisted fields still strip.
  const kept = sanitizeVertexBodyForBetaTokens(body, 'context-management-2025-06-27');
  assert.deepEqual(kept.body.context_management, { edits: [] });
  assert.equal('fallbacks' in kept.body, false);
  // An unrelated beta value keeps nothing extra.
  const none = sanitizeVertexBodyForBetaTokens({ max_tokens: 8 }, 'context-1m-2025-08-07');
  assert.equal(none.changed, false);
  assert.deepEqual(none.body, { max_tokens: 8 });
});

test('the Anthropic body transform deletes model and injects the vertex anthropic_version', () => {
  const body = buildVertexAnthropicRequestBody({
    model: 'claude-opus-4-5',
    anthropic_version: 'client-sent-value',
    max_tokens: 16,
    messages: [],
  });
  assert.equal('model' in body, false);
  assert.equal(body.anthropic_version, 'vertex-2023-10-16');
  assert.equal(body.max_tokens, 16);
});

test('applyVertexAnthropicTransform composes sanitize + body rewrite against the filtered beta', () => {
  const result = applyVertexAnthropicTransform(
    { model: 'claude-opus-4-5', context_management: { clear_tool_uses: true }, messages: [] },
    { anthropicBetaHeader: 'advisor-tool-2026-03-01,context-1m-2025-08-07' },
  );
  // The client beta filters to context-1m only, so context_management strips.
  assert.equal(result.anthropicBeta, 'context-1m-2025-08-07');
  assert.equal('context_management' in result.body, false);
  assert.equal(result.body.anthropic_version, 'vertex-2023-10-16');
  assert.throws(() => applyVertexAnthropicTransform('not-an-object', {}), VertexTransformError);
});

test('buildVertexAnthropicHeaders forwards only the allowlist and swaps in the filtered beta', () => {
  const headers = buildVertexAnthropicHeaders({
    clientHeaders: {
      'user-agent': 'claude-cli/2.0',
      'x-stainless-lang': 'js',
      'x-claude-code-session-id': 'sess-1',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'advisor-tool-2026-03-01',
      authorization: 'Bearer client-token',
      'x-api-key': 'client-key',
      'x-goog-api-key': 'client-google-key',
      cookie: 'session=1',
      'x-evil-header': 'nope',
      'accept-encoding': 'gzip',
    },
    accessToken: 'vertex-access-token',
    anthropicBeta: 'context-1m-2025-08-07',
    stream: true,
  });
  assert.equal(headers.authorization, 'Bearer vertex-access-token');
  assert.equal(headers['anthropic-beta'], 'context-1m-2025-08-07');
  assert.equal(headers['anthropic-version'], undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['x-goog-api-key'], undefined);
  assert.equal(headers['x-evil-header'], undefined);
  assert.equal(headers['user-agent'], 'claude-cli/2.0');
  assert.equal(headers['x-stainless-lang'], 'js');
  assert.equal(headers['x-claude-code-session-id'], 'sess-1');
  assert.equal(headers['accept-encoding'], 'gzip');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.accept, 'text/event-stream');
  // An empty filtered beta omits the header entirely.
  const noBeta = buildVertexAnthropicHeaders({
    clientHeaders: {},
    accessToken: 't',
    anthropicBeta: '',
    stream: false,
  });
  assert.equal('anthropic-beta' in noBeta, false);
  assert.equal(noBeta.accept, 'application/json');
});

test('location resolution precedence: model map → account → us-central1', () => {
  assert.deepEqual(
    resolveVertexLocation(
      { projectId: 'p', location: 'europe-west1', vertexModelLocations: { 'gemini-2.5-pro': 'asia-east1' } },
      'gemini-2.5-pro',
    ),
    { location: 'asia-east1', source: 'model' },
  );
  assert.deepEqual(resolveVertexLocation({ projectId: 'p', location: 'europe-west1' }, 'any-model'), {
    location: 'europe-west1',
    source: 'account',
  });
  assert.deepEqual(resolveVertexLocation({ projectId: 'p' }, 'any-model'), {
    location: VERTEX_DEFAULT_LOCATION,
    source: 'default',
  });
  assert.deepEqual(resolveVertexLocation(null, 'any-model'), {
    location: 'us-central1',
    source: 'default',
  });
  // A malformed per-model override fails closed.
  assert.equal(resolveVertexLocation({ projectId: 'p', vertexModelLocations: { m: 'bad host' } }, 'm'), null);
  // A malformed account location also fails closed (never silently defaulted).
  assert.equal(resolveVertexLocation({ projectId: 'p', location: 'BAD' }, 'm'), null);
});
