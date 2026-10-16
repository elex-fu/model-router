import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anthropicToGeminiRequest,
  applyGeminiCodeAssistTransform,
  GeminiTransformError,
  isSafeGeminiModelId,
  normalizeGeminiModelId,
  normalizeGeminiToolsForAiStudio,
  unwrapGeminiResponse,
  wrapGeminiCodeAssistRequest,
} from '../../../../src/saas/gateway/gemini/transform.js';

test('model id normalization maps aliases and strips the models/ prefix', () => {
  assert.equal(normalizeGeminiModelId('gemini-3-pro'), 'gemini-3-pro-preview');
  assert.equal(normalizeGeminiModelId('gemini-3.1-pro'), 'gemini-3-pro-preview');
  assert.equal(normalizeGeminiModelId('gemini-2.5-pro-latest'), 'gemini-2.5-pro');
  assert.equal(normalizeGeminiModelId('models/gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(normalizeGeminiModelId('models/gemini-3-pro'), 'gemini-3-pro-preview');
  // Unknown and already-canonical ids pass through untouched.
  assert.equal(normalizeGeminiModelId('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(normalizeGeminiModelId('some-future-model'), 'some-future-model');
  assert.equal(normalizeGeminiModelId(''), '');
});

test('model id safety rejects path, query, empty and oversized ids', () => {
  for (const unsafe of ['../x', '?a=b', '', ' ', 'gemini pro', 'a/b', 'a'.repeat(129), 'models/gemini-2.5-pro']) {
    assert.equal(isSafeGeminiModelId(unsafe), false, JSON.stringify(unsafe));
  }
  assert.equal(isSafeGeminiModelId('gemini-2.5-pro'), true);
  assert.equal(isSafeGeminiModelId('a'.repeat(128)), true);
  assert.equal(isSafeGeminiModelId('models_gemini'), true);
});

test('the AI Studio tool-key normalization renames googleSearch and is copy-on-write', () => {
  const body = { model: 'gemini-2.5-pro', tools: [{ googleSearch: {} }, { codeExecution: {} }] };
  const normalized = normalizeGeminiToolsForAiStudio(body);
  assert.deepEqual(normalized.tools, [{ google_search: {} }, { codeExecution: {} }]);
  // The input body is never mutated.
  assert.deepEqual(body.tools, [{ googleSearch: {} }, { codeExecution: {} }]);
  // No camelCase key → the same object reference is returned.
  const unchanged = { model: 'm', tools: [{ google_search: {} }] };
  assert.equal(normalizeGeminiToolsForAiStudio(unchanged), unchanged);
  const noTools = { model: 'm' };
  assert.equal(normalizeGeminiToolsForAiStudio(noTools), noTools);
});

test('the Anthropic→Gemini conversion maps messages, system, tools and generationConfig', () => {
  const result = anthropicToGeminiRequest({
    model: 'models/gemini-3-pro',
    max_tokens: 512,
    temperature: 0.3,
    top_p: 0.9,
    stop_sequences: ['END', ''],
    system: 'Always answer in Portuguese.',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'and ' },
          { type: 'text', text: 'more' },
        ],
      },
    ],
    tools: [{ name: 'bash', description: 'run a command', input_schema: { type: 'object' }, type: 'custom' }],
  });
  assert.equal(result.model, 'gemini-3-pro-preview');
  const payload = result.payload;
  assert.deepEqual(payload.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'hi there' }] },
    { role: 'user', parts: [{ text: 'and ' }, { text: 'more' }] },
  ]);
  assert.deepEqual(payload.systemInstruction, { parts: [{ text: 'Always answer in Portuguese.' }] });
  assert.deepEqual(payload.tools, [
    {
      functionDeclarations: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
    },
  ]);
  assert.deepEqual(payload.generationConfig, {
    maxOutputTokens: 512,
    temperature: 0.3,
    topP: 0.9,
    stopSequences: ['END'],
  });
  // An empty conversation produces no contents key at all.
  const empty = anthropicToGeminiRequest({ model: 'gemini-2.5-pro', max_tokens: 8, messages: [] });
  assert.equal('contents' in empty.payload, false);
  assert.equal('systemInstruction' in empty.payload, false);
  assert.equal('tools' in empty.payload, false);
});

test('max_tokens defaults to the CLI-scale 65536 when the client omits it', () => {
  const omitted = anthropicToGeminiRequest({ model: 'gemini-2.5-pro', messages: [] });
  assert.equal(omitted.payload.generationConfig.maxOutputTokens, 65_536);
  // Non-positive / non-finite values fall back to the default too.
  for (const bad of [0, -5, Number.NaN, 'many']) {
    const result = anthropicToGeminiRequest({ model: 'gemini-2.5-pro', messages: [], max_tokens: bad });
    assert.equal(result.payload.generationConfig.maxOutputTokens, 65_536, String(bad));
  }
  // The caller can override the default.
  const overridden = anthropicToGeminiRequest(
    { model: 'gemini-2.5-pro', messages: [] },
    { defaultMaxOutputTokens: 1024 },
  );
  assert.equal(overridden.payload.generationConfig.maxOutputTokens, 1024);
});

test('non-object bodies and unsafe model ids fail closed with typed errors', () => {
  for (const bad of [null, undefined, 'text', 42, []]) {
    assert.throws(
      () => anthropicToGeminiRequest(bad),
      (error: unknown) => {
        assert.ok(error instanceof GeminiTransformError);
        assert.equal(error.code, 'MALFORMED_BODY');
        return true;
      },
    );
  }
  for (const badModel of ['../x', '?a=b', '', 'a/b']) {
    assert.throws(
      () => anthropicToGeminiRequest({ model: badModel, messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiTransformError);
        assert.equal(error.code, 'MALFORMED_MODEL');
        return true;
      },
    );
  }
  assert.throws(() => anthropicToGeminiRequest({ messages: [] }), GeminiTransformError);
});

test('the Code Assist wrap carries {model, project, request} and trims the project', () => {
  const request = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
  const wrapped = wrapGeminiCodeAssistRequest(request, 'gemini-2.5-pro', '  proj-1  ');
  assert.deepEqual(wrapped, { model: 'gemini-2.5-pro', project: 'proj-1', request });
  // Empty or oversized projects and unsafe models throw.
  for (const badProject of ['', '   ', 'a'.repeat(129)]) {
    assert.throws(
      () => wrapGeminiCodeAssistRequest(request, 'gemini-2.5-pro', badProject),
      (error: unknown) => {
        assert.ok(error instanceof GeminiTransformError);
        assert.equal(error.code, 'MALFORMED_BODY');
        return true;
      },
    );
  }
  assert.throws(
    () => wrapGeminiCodeAssistRequest(request, '../x', 'proj-1'),
    (error: unknown) => {
      assert.ok(error instanceof GeminiTransformError);
      assert.equal(error.code, 'MALFORMED_MODEL');
      return true;
    },
  );
});

test('the Code Assist response envelope unwraps and passes through', () => {
  const inner = { candidates: [{ content: { parts: [{ text: '42' }] } }] };
  assert.deepEqual(unwrapGeminiResponse({ response: inner }), inner);
  const bare = { candidates: [], modelVersion: 'v1' };
  assert.equal(unwrapGeminiResponse(bare), bare);
});

test('the full Code Assist transform normalizes the model and wraps without mutating the input', () => {
  const input = {
    model: 'gemini-3-pro',
    tools: [{ googleSearch: {} }],
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  };
  const { body, model } = applyGeminiCodeAssistTransform(input, { projectId: 'proj-1' });
  assert.equal(model, 'gemini-3-pro-preview');
  assert.equal(body.model, 'gemini-3-pro-preview');
  assert.equal(body.project, 'proj-1');
  assert.deepEqual(body.request, {
    model: 'gemini-3-pro-preview',
    tools: [{ google_search: {} }],
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  // Pure: the caller's object still carries the raw alias and camelCase key.
  assert.equal(input.model, 'gemini-3-pro');
  assert.deepEqual(input.tools, [{ googleSearch: {} }]);
  // Non-object input fails closed.
  for (const bad of [null, 'text', 42, []]) {
    assert.throws(() => applyGeminiCodeAssistTransform(bad, { projectId: 'p' }), GeminiTransformError);
  }
  // A missing/unsafe model id fails closed with MALFORMED_MODEL.
  assert.throws(
    () => applyGeminiCodeAssistTransform({ contents: [] }, { projectId: 'p' }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiTransformError);
      assert.equal(error.code, 'MALFORMED_MODEL');
      return true;
    },
  );
});
