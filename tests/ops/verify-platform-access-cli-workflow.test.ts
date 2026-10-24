import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CliWorkflowObserverState,
  CliWorkflowRootHeadObserver,
  createCliWorkflowSseObserver,
  describeCliWorkflowRequest,
  describeCliWorkflowTransport,
  retainCliWorkflowFailure,
  validateCliWorkflowRequest,
} from '../../scripts/ops/verify-platform-access-cli-workflow.js';

// Pure fixture contracts only: no CLI child, listener, provider or database.
const publicModel = 'published-anthropic-model';
const readFiles = ['/private/tmp/cli-fixture/first.txt', '/private/tmp/cli-fixture/second.txt'] as const;
const answer = 'fixture-answer-473';
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;
const tools = [{ name: 'Read', input_schema: {
  type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
} }];
const toolUse = (round: number) => ({ type: 'tool_use', id: `read-${round}`, name: 'Read', input: { file_path: readFiles[round - 1] } });
function body(round = 0): Record<string, unknown> {
  const messages: unknown[] = [{ role: 'user', content: 'Read the fixture instructions.' }];
  for (let index = 0; index < round; index += 1) {
    messages.push({ role: 'assistant', content: [toolUse(index + 1)] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${index + 1}`,
      content: index === 0 ? 'Read second.txt next.' : answer }] });
  }
  return { model: publicModel, max_tokens: 512, stream: true, thinking: { type: 'disabled' }, tools, messages };
}
const request = (value: unknown = body(), path = '/v1/messages') => ({ method: 'POST', path, body: value });
const observer = () => new CliWorkflowObserverState({ publicModel, readFiles, answer });
const thought = (index: number) => `PRIVATE_THOUGHT_${index}`;
const signature = (index: number) => `PRIVATE_SIGNATURE_${index}`;
const thinkingBlock = (index: number) => ({ type: 'thinking', thinking: thought(index), signature: signature(index) });
function observationBody(round = 0): Record<string, unknown> {
  const value = body(round);
  delete value.thinking;
  const messages = value.messages as { role: string; content: unknown }[];
  let index = 0;
  for (const message of messages) {
    if (message.role === 'assistant') message.content = [thinkingBlock(index++), ...(message.content as unknown[])];
  }
  return value;
}
const observation = () => new CliWorkflowObserverState({ publicModel, readFiles, answer, scene: 'omitted-observation' });

function response(state: CliWorkflowObserverState, index: number, usage: Record<string, unknown> = {
  input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
}, requestId: string = ids[index]!, terminalUsage: Record<string, unknown> = { output_tokens: 4 }, withThinking = false) {
  state.noteRequestId(index, requestId);
  state.observeUpstreamEvent(index, { type: 'message_start', message: {
    id: `msg-${index}`, type: 'message', role: 'assistant', content: [],
    usage,
  } });
  const contentIndex = withThinking ? 1 : 0;
  if (withThinking) {
    state.observeUpstreamEvent(index, { type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: thought(index).slice(0, 5) } });
    state.observeUpstreamEvent(index, { type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: thought(index).slice(5) } });
    for (const value of [signature(index).slice(0, 5), signature(index).slice(5)]) {
      state.observeUpstreamEvent(index, { type: 'content_block_delta', index: 0,
        delta: { type: 'signature_delta', signature: value } });
    }
    state.observeUpstreamEvent(index, { type: 'content_block_stop', index: 0 });
  }
  if (index < 2) {
    state.observeUpstreamEvent(index, { type: 'content_block_start', index: contentIndex,
      content_block: { type: 'tool_use', id: `read-${index + 1}`, name: 'Read', input: {} } });
    const json = JSON.stringify({ file_path: readFiles[index] });
    for (const partial_json of [json.slice(0, 8), json.slice(8)]) {
      state.observeUpstreamEvent(index, { type: 'content_block_delta', index: contentIndex,
        delta: { type: 'input_json_delta', partial_json } });
    }
  } else {
    state.observeUpstreamEvent(index, { type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' } });
    state.observeUpstreamEvent(index, { type: 'content_block_delta', index: contentIndex,
      delta: { type: 'text_delta', text: answer } });
  }
  state.observeUpstreamEvent(index, { type: 'content_block_stop', index: contentIndex });
  state.observeUpstreamEvent(index, { type: 'message_delta', delta: { stop_reason: index < 2 ? 'tool_use' : 'end_turn' },
    usage: terminalUsage });
  state.observeUpstreamEvent(index, { type: 'message_stop' });
}

test('capture validation is pure and preserves the original request body', () => {
  const original = body();
  const raw = JSON.stringify(original);
  const before = structuredClone(original);
  const facts = validateCliWorkflowRequest({ ...request(original, '/v1/messages?beta=true'), publicModel });
  assert.deepEqual(facts, { maxTokens: 512, thinking: 'disabled', stream: true, toolCount: 1 });
  assert.deepEqual(original, before);
  assert.equal(JSON.stringify(original), raw);
  assert.deepEqual(validateCliWorkflowRequest({ ...request({ ...body(), thinking: undefined }), publicModel }), {
    maxTokens: 512, thinking: 'omitted', stream: true, toolCount: 1,
  });
});

test('request validation rejects unsupported endpoints, methods and unsafe generation fields', () => {
  for (const input of [
    { ...request(), method: 'GET' }, request(body(), '/v1/chat/completions'),
    request(body(), '/v1/messages?unexpected=true'), request(body(), '/v1/messages?beta=true&extra=1'),
    ...[0, -1, 1.5, 513, '128', null].map(max_tokens => request({ ...body(), max_tokens })),
    request({ ...body(), model: 'another-model' }), request({ ...body(), stream: false }),
    request({ ...body(), thinking: { type: 'enabled', budget_tokens: 128 } }),
    request({ ...body(), tools: [{ name: 'Bash', input_schema: tools[0]!.input_schema }] }),
    request({ ...body(), tools: [{ name: 'Read', input_schema: { type: 'object', properties: {}, required: [] } }] }),
  ]) assert.throws(() => validateCliWorkflowRequest({ ...input, publicModel }));
  assert.equal(validateCliWorkflowRequest({ ...request({ ...body(), max_tokens: 1 }), publicModel }).maxTokens, 1);
});

test('failed message attempts consume the fixed budget and the fourth attempt is rejected', () => {
  const state = observer();
  for (let count = 1; count <= 3; count += 1) {
    assert.throws(() => state.observeRequest(request(body(), '/unknown')));
    assert.equal(state.attemptCount, count);
  }
  assert.throws(() => state.observeRequest(request()));
  assert.equal(state.attemptCount, 4);
  assert.throws(() => state.finish());
});

test('three native message rounds require linked Read results and export only IDs and numeric usage', () => {
  const state = observer();
  for (let index = 0; index < 3; index += 1) {
    const original = body(index);
    const before = structuredClone(original);
    state.observeRequest(request(original));
    assert.deepEqual(original, before);
    response(state, index);
  }
  assert.equal(state.attemptCount, 3);
  assert.deepEqual(state.finish(), { requests: ids.map(requestId => ({ requestId, usage: {
    input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  } })) });
  const evidence = JSON.stringify(state.finish());
  for (const sensitive of [answer, ...readFiles, 'Read the fixture instructions.', 'second.txt', 'read-1']) {
    assert.equal(evidence.includes(sensitive), false);
  }
  assert.throws(() => state.observeRequest(request(body(2))));
});

test('tool result linkage rejects unrelated IDs and missing required file or answer evidence', () => {
  for (const mutation of ['wrong-id', 'missing-file', 'missing-answer'] as const) {
    const state = observer();
    state.observeRequest(request()); response(state, 0);
    if (mutation === 'missing-answer') { state.observeRequest(request(body(1))); response(state, 1); }
    const round = mutation === 'missing-answer' ? 2 : 1;
    const changed = body(round);
    const messages = changed.messages as { role: string; content: unknown }[];
    const result = (messages.at(-1)!.content as Record<string, unknown>[])[0]!;
    if (mutation === 'wrong-id') result.tool_use_id = 'unrelated-tool-id';
    else result.content = 'unrelated fixture text';
    assert.throws(() => state.observeRequest(request(changed)), mutation);
    assert.throws(() => state.finish());
  }
});

test('missing terminal usage and duplicate or invalid canonical IDs cannot produce complete evidence', () => {
  const incomplete = observer();
  incomplete.observeRequest(request());
  incomplete.noteRequestId(0, ids[0]);
  assert.throws(() => incomplete.finish());
  assert.throws(() => incomplete.noteRequestId(0, 'not-a-uuid'));
  const duplicate = observer();
  duplicate.observeRequest(request()); response(duplicate, 0);
  duplicate.observeRequest(request(body(1)));
  assert.throws(() => duplicate.noteRequestId(1, ids[0]));
});

test('native usage must supply every safe nonnegative integer without synthesizing missing cache fields', () => {
  for (const usage of [
    { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 },
    { input_tokens: -1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { input_tokens: 1.5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ]) {
    const state = observer();
    assert.throws(() => {
      for (let index = 0; index < 3; index += 1) {
        state.observeRequest(request(body(index)));
        response(state, index, index === 0 ? usage : undefined);
      }
      state.finish();
    });
  }
  const missingTerminalOutput = observer();
  assert.throws(() => {
    for (let index = 0; index < 3; index += 1) {
      missingTerminalOutput.observeRequest(request(body(index)));
      response(missingTerminalOutput, index, undefined, ids[index]!, index === 0 ? {} : { output_tokens: 4 });
    }
    missingTerminalOutput.finish();
  }, 'message_start output_tokens=0 cannot replace missing native terminal output_tokens');
});

test('safe gateway request ID prefixes retain three distinct canonical identities', () => {
  const state = observer();
  const prefixed = [ids[0], `gateway_${ids[1]}`, `managed_${ids[2]}`];
  for (let index = 0; index < 3; index += 1) {
    state.observeRequest(request(body(index)));
    response(state, index, undefined, prefixed[index]!);
  }
  assert.deepEqual(state.finish().requests.map(value => value.requestId), prefixed);
});

test('missing, duplicate or reordered tool results cannot complete the two-Read chain', () => {
  for (const mutation of ['missing', 'duplicate', 'reordered'] as const) {
    const state = observer();
    state.observeRequest(request()); response(state, 0);
    state.observeRequest(request(body(1))); response(state, 1);
    const changed = body(2);
    const messages = changed.messages as { role: string; content: unknown }[];
    if (mutation === 'missing') messages.splice(2, 1);
    if (mutation === 'duplicate') messages.splice(3, 0, structuredClone(messages[2]!));
    if (mutation === 'reordered') [messages[2], messages[4]] = [messages[4]!, messages[2]!];
    assert.throws(() => {
      state.observeRequest(request(changed));
      response(state, 2);
      state.finish();
    }, mutation);
  }
});

const SSE_BLOCK_LIMIT = 4 * 1024 * 1024;
function sizedSseBlock(size: number): string {
  const event = { type: 'message_delta', usage: { output_tokens: 7 }, padding: '' };
  const base = `data: ${JSON.stringify(event)}`;
  return `data: ${JSON.stringify({ ...event, padding: 'x'.repeat(size - Buffer.byteLength(base, 'utf8')) })}`;
}

test('SSE accepts an exact 4 MiB event with complete or byte-fragmented LF and CRLF separators', () => {
  const block = sizedSseBlock(SSE_BLOCK_LIMIT);
  assert.equal(Buffer.byteLength(block, 'utf8'), SSE_BLOCK_LIMIT);
  for (const separator of ['\n\n', '\r\n\r\n']) {
    for (const fragmented of [false, true]) {
      const events: unknown[] = [];
      const parser = createCliWorkflowSseObserver(event => events.push(event));
      if (fragmented) {
        parser.push(Buffer.from(block));
        assert.equal(events.length, 0);
        for (const byte of Buffer.from(separator)) parser.push(Buffer.from([byte]));
      } else parser.push(Buffer.from(block + separator));
      parser.end();
      assert.equal(events.length, 1);
      assert.equal((events[0] as { usage: { output_tokens: number } }).usage.output_tokens, 7);
    }
  }
});

test('a complete oversized SSE event is rejected before its apparent usage reaches the callback', () => {
  let callbacks = 0;
  const parser = createCliWorkflowSseObserver(() => { callbacks += 1; });
  const oversized = sizedSseBlock(SSE_BLOCK_LIMIT + 1);
  assert.equal(Buffer.byteLength(oversized, 'utf8'), SSE_BLOCK_LIMIT + 1);
  assert.throws(() => parser.push(Buffer.from(oversized + '\n\n')));
  assert.equal(callbacks, 0);
});

test('SSE byte limits include multibyte UTF-8 decoded across chunks rather than JavaScript length', () => {
  const block = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 }, padding: '😀'.repeat(SSE_BLOCK_LIMIT / 4) })}`;
  assert.ok(block.length < SSE_BLOCK_LIMIT);
  assert.ok(Buffer.byteLength(block, 'utf8') > SSE_BLOCK_LIMIT);
  for (const fragmented of [false, true]) {
    let callbacks = 0;
    const parser = createCliWorkflowSseObserver(() => { callbacks += 1; });
    const bytes = Buffer.from(block + '\n\n');
    assert.throws(() => {
      if (fragmented) {
        const split = bytes.indexOf(Buffer.from('😀')) + 1;
        parser.push(bytes.subarray(0, split)); // Split inside a four-byte code point.
        parser.push(bytes.subarray(split));
      } else parser.push(bytes);
    });
    assert.equal(callbacks, 0);
  }
});

test('SSE bounds each event separately and preserves multiple legal events in one larger chunk', () => {
  const events: unknown[] = [];
  const parser = createCliWorkflowSseObserver(event => events.push(event));
  const blocks = [sizedSseBlock(SSE_BLOCK_LIMIT), 'data: {"sequence":2}', 'data: {"sequence":3}'];
  parser.push(Buffer.from(blocks.join('\n\n') + '\n\n'));
  parser.end();
  assert.equal(events.length, 3);
  assert.deepEqual(events.slice(1), [{ sequence: 2 }, { sequence: 3 }]);
});

test('oversized unfinished SSE blocks reject on push and incomplete separator bytes remain bounded at EOF', () => {
  let callbacks = 0;
  const oversized = createCliWorkflowSseObserver(() => { callbacks += 1; });
  assert.throws(() => oversized.push(Buffer.from(sizedSseBlock(SSE_BLOCK_LIMIT + 1))));
  assert.equal(callbacks, 0);
  for (const prefix of ['\n', '\r', '\r\n', '\r\n\r']) {
    const parser = createCliWorkflowSseObserver(() => { callbacks += 1; });
    parser.push(Buffer.from(sizedSseBlock(SSE_BLOCK_LIMIT)));
    parser.push(Buffer.from(prefix));
    assert.throws(() => parser.end());
    assert.equal(callbacks, 0);
  }
});

test('request diagnostics expose only bounded shape categories rather than unknown values', () => {
  const sentinel = 'PRIVATE_FIXTURE_MUST_NOT_APPEAR';
  const unknownBody = {
    model: sentinel, stream: sentinel, max_tokens: 1_000_001,
    thinking: { type: sentinel, [sentinel]: sentinel },
    tools: Array.from({ length: 10 }, () => ({ name: sentinel, input_schema: { [sentinel]: sentinel } })),
    messages: [{ role: 'user', content: sentinel }],
    authorization: sentinel, [sentinel]: sentinel,
  };
  assert.deepEqual(describeCliWorkflowRequest(unknownBody, publicModel), {
    modelMatches: false, stream: 'other', maxTokens: 'above-diagnostic-range',
    thinkingType: 'other', thinkingExtraFields: true,
    toolsCount: 10, toolNames: Array(8).fill('other'), messagesCount: 1,
    readSchemaFilePathString: false, readSchemaRequiresFilePath: false,
  });
  assert.equal(JSON.stringify(describeCliWorkflowRequest(unknownBody, publicModel)).includes(sentinel), false);
  assert.equal(describeCliWorkflowRequest(null, publicModel), undefined);
  assert.equal(describeCliWorkflowRequest([], publicModel), undefined);
  assert.deepEqual(describeCliWorkflowRequest({}, publicModel), {
    modelMatches: false, stream: 'missing', maxTokens: 'missing', thinkingType: 'missing',
    thinkingExtraFields: false, toolsCount: 'missing', toolNames: [], messagesCount: 'missing',
    readSchemaFilePathString: false, readSchemaRequiresFilePath: false,
  });
  const malformed = describeCliWorkflowRequest({ max_tokens: '512', tools: {}, messages: {} }, publicModel)!;
  assert.equal(malformed.maxTokens, 'invalid');
  assert.equal(malformed.toolsCount, 'invalid');
  assert.equal(malformed.messagesCount, 'invalid');
});

test('typed contract failures retain fixed stage and code without payload or stack leakage', () => {
  let rejected: unknown;
  try { validateCliWorkflowRequest({ ...request({ ...body(), max_tokens: 513 }), publicModel }); }
  catch (error) { rejected = error; }
  assert.ok(rejected instanceof Error);
  const safe = retainCliWorkflowFailure(undefined, rejected, {
    mode: 'capture', stage: 'request-contract', attemptCount: 1,
    ...request({ ...body(), max_tokens: 513 }), publicModel,
  });
  const prefix = 'CLI workflow rejected ';
  assert.ok(safe.message.startsWith(prefix));
  const dto = JSON.parse(safe.message.slice(prefix.length));
  assert.deepEqual(dto, {
    kind: 'cli-workflow-diagnostic-v1', mode: 'capture', stage: 'request-contract',
    code: 'MAX_TOKENS_INVALID', attemptCount: 1, method: 'POST', pathCategory: 'messages',
    metadata: { method: 'POST', pathCategory: 'messages', contentType: 'missing', contentEncoding: 'missing', bodySize: 'unread' },
    requestShape: describeCliWorkflowRequest({ ...body(), max_tokens: 513 }, publicModel),
  });
  assert.equal(safe.stack, safe.message);
  assert.equal(Object.hasOwn(safe, 'cause'), false);
  for (const value of [answer, ...readFiles, 'Read the fixture instructions.']) {
    assert.equal(safe.message.includes(value), false);
  }
});

test('unknown errors are redacted and later abort or cleanup cannot replace the first failure', () => {
  const sentinel = 'PRIVATE_ERROR_AND_PATH_SENTINEL';
  const external = Object.assign(new Error(sentinel), { code: 'AUTH_MISMATCH', cause: sentinel });
  const input = {
    mode: 'real' as const, stage: 'forward' as const, attemptCount: 999,
    method: sentinel, path: `/${sentinel}?token=${sentinel}`, body: sentinel, publicModel,
  };
  const first = retainCliWorkflowFailure(undefined, external, input);
  assert.deepEqual(JSON.parse(first.message.slice('CLI workflow rejected '.length)), {
    kind: 'cli-workflow-diagnostic-v1', mode: 'real', stage: 'forward',
    code: 'UNEXPECTED_FAILURE', attemptCount: 4, method: 'other', pathCategory: 'other',
    metadata: { method: 'other', pathCategory: 'other', contentType: 'missing', contentEncoding: 'missing', bodySize: 'unread' },
  });
  assert.equal(first.stack, first.message);
  assert.equal(first.message.includes(sentinel), false);
  assert.equal(Object.hasOwn(first, 'cause'), false);
  const retained = retainCliWorkflowFailure(first, new Error(`later abort ${sentinel}`), {
    ...input, stage: 'capture-stop', attemptCount: 0,
  });
  assert.equal(retained, first);
  assert.equal(retained.message, first.message);
  assert.equal(retainCliWorkflowFailure(first, { code: sentinel }, input), first);
});

test('transport metadata classifies only fixed method, path, MIME, encoding and actual byte-size buckets', () => {
  const sentinel = 'PRIVATE_HEADER_QUERY_SENTINEL';
  assert.deepEqual(describeCliWorkflowTransport({
    method: 'PUT', path: `/v1/messages?private=${sentinel}`,
    contentType: ' Application/JSON; charset=utf-8', contentEncoding: ' GZIP ', bodyBytes: 0,
  }), { method: 'PUT', pathCategory: 'messages', contentType: 'json', contentEncoding: 'gzip', bodySize: 'empty' });
  const unknown = describeCliWorkflowTransport({ method: sentinel, path: `/${sentinel}?key=${sentinel}`,
    contentType: [sentinel], contentEncoding: `gzip, ${sentinel}`, bodyBytes: 5 });
  assert.deepEqual(unknown, { method: 'other', pathCategory: 'other', contentType: 'other', contentEncoding: 'other', bodySize: 'le_1k' });
  assert.equal(JSON.stringify(unknown).includes(sentinel), false);
  for (const [bodyBytes, bodySize] of [
    [undefined, 'unread'], [0, 'empty'], [1, 'le_1k'], [1024, 'le_1k'],
    [1025, 'le_64k'], [65536, 'le_64k'], [65537, 'le_1m'], [1048576, 'le_1m'],
    [1048577, 'le_4m'], [4194304, 'le_4m'], [4194305, 'over_limit'],
    [-1, 'unread'], [1.5, 'unread'], [Number.NaN, 'unread'],
  ] as const) {
    assert.equal(describeCliWorkflowTransport({ method: 'POST', path: '/', bodyBytes }).bodySize, bodySize);
  }
  assert.equal(describeCliWorkflowTransport({ method: 'HEAD', path: '/?private=ignored' }).pathCategory, 'root');
  assert.equal(describeCliWorkflowTransport({ method: 'OPTIONS', path: '/v1/messages/count_tokens?beta=true' }).pathCategory, 'count_tokens');
  for (const encoding of ['identity', 'gzip', 'br', 'deflate', 'zstd'] as const) {
    assert.equal(describeCliWorkflowTransport({ method: 'PATCH', path: '/', contentEncoding: encoding }).contentEncoding, encoding);
  }
  assert.equal(describeCliWorkflowTransport({ method: 'DELETE', path: '/', contentEncoding: ['gzip'] }).contentEncoding, 'other');
});

test('undecodable or empty request bodies still retain safe transport metadata without raw JSON or headers', () => {
  const sentinel = 'PRIVATE_MALFORMED_JSON_SENTINEL';
  for (const raw of ['', `{${sentinel}`]) {
    const safe = retainCliWorkflowFailure(undefined, new SyntaxError(raw), {
      mode: 'capture', stage: 'json-decode', attemptCount: 1, method: 'POST',
      path: `/v1/messages?private=${sentinel}`, body: undefined, publicModel,
      contentType: 'application/json', contentEncoding: 'identity', bodyBytes: Buffer.byteLength(raw),
    });
    const dto = JSON.parse(safe.message.slice('CLI workflow rejected '.length));
    assert.deepEqual(dto, {
      kind: 'cli-workflow-diagnostic-v1', mode: 'capture', stage: 'json-decode',
      code: 'UNEXPECTED_FAILURE', attemptCount: 1, method: 'POST', pathCategory: 'other',
      metadata: { method: 'POST', pathCategory: 'messages', contentType: 'json', contentEncoding: 'identity', bodySize: raw === '' ? 'empty' : 'le_1k' },
    });
    assert.equal(safe.message.includes(sentinel), false);
    assert.equal(safe.stack, safe.message);
    assert.equal(Object.hasOwn(dto, 'requestShape'), false);
  }
  assert.throws(() => validateCliWorkflowRequest({ ...request(body(), '/v1/messages?private=ignored'), publicModel }),
    'transport path classification does not relax exact endpoint admission');
});

test('root HEAD auxiliary requests allow one empty request per phase without consuming generation budget', () => {
  const aux = new CliWorkflowRootHeadObserver();
  const state = observer();
  assert.equal(aux.observe({ method: 'HEAD', path: '/', phase: 'version' }), true);
  aux.observeBodyChunk(new Uint8Array());
  assert.equal(aux.observe({ method: 'HEAD', path: '/', phase: 'workflow', contentLength: '0' }), true);
  assert.deepEqual(aux.facts(), { rootHeadCount: 2, rootHeadByPhase: { version: 1, workflow: 1 } });
  assert.equal(state.attemptCount, 0);
  for (let index = 0; index < 3; index += 1) {
    state.observeRequest(request(body(index))); response(state, index);
  }
  assert.equal(state.finish().requests.length, 3);
  assert.equal(state.attemptCount, 3);
  assert.throws(() => state.observeRequest(request(body(2))));
});

test('HEAD auxiliary matching stays exact and rejected body attempts cannot reset the phase limit', () => {
  const aux = new CliWorkflowRootHeadObserver();
  for (const input of [
    { method: 'GET', path: '/' }, { method: 'HEAD', path: '/?x=1' },
    { method: 'HEAD', path: '/v1/messages' },
  ]) assert.equal(aux.observe({ ...input, phase: 'version' }), false);
  assert.deepEqual(aux.facts(), { rootHeadCount: 0, rootHeadByPhase: { version: 0, workflow: 0 } });
  for (const headers of [
    { contentLength: '00' }, { contentLength: '1' }, { contentLength: 0 },
    { transferEncoding: 'chunked' }, { transferEncoding: '' },
  ]) {
    const rejected = new CliWorkflowRootHeadObserver();
    assert.throws(() => rejected.observe({ method: 'HEAD', path: '/', phase: 'version', ...headers }));
    assert.deepEqual(rejected.facts(), { rootHeadCount: 1, rootHeadByPhase: { version: 1, workflow: 0 } });
    assert.throws(() => rejected.observe({ method: 'HEAD', path: '/', phase: 'version' }));
    assert.throws(() => rejected.facts());
  }
  assert.throws(() => aux.observeBodyChunk(Buffer.from('nonempty')));
});

test('auxiliary failure diagnostics retain only fixed phase and code without request bytes', () => {
  const sentinel = 'PRIVATE_AUX_BODY_SENTINEL';
  const aux = new CliWorkflowRootHeadObserver();
  let failure: unknown;
  try { aux.observeBodyChunk(Buffer.from(sentinel)); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  const safe = retainCliWorkflowFailure(undefined, failure, {
    mode: 'capture', stage: 'auxiliary-contract', cliPhase: 'version', attemptCount: 0,
    method: 'HEAD', path: '/', body: undefined, publicModel, bodyBytes: Buffer.byteLength(sentinel),
  });
  assert.deepEqual(JSON.parse(safe.message.slice('CLI workflow rejected '.length)), {
    kind: 'cli-workflow-diagnostic-v1', mode: 'capture', stage: 'auxiliary-contract',
    code: 'ROOT_HEAD_BODY', attemptCount: 0, method: 'HEAD', pathCategory: 'other', cliPhase: 'version',
    metadata: { method: 'HEAD', pathCategory: 'root', contentType: 'missing', contentEncoding: 'missing', bodySize: 'le_1k' },
  });
  assert.equal(safe.message.includes(sentinel), false);
  assert.equal(safe.stack, safe.message);
});

test('omitted observation requires omitted thinking and round-trips native thinking and signatures privately', () => {
  const state = observation();
  for (let index = 0; index < 3; index += 1) {
    const original = observationBody(index);
    const before = structuredClone(original);
    assert.equal(state.observeRequest(request(original)).thinking, 'omitted');
    assert.deepEqual(original, before);
    response(state, index, undefined, ids[index]!, undefined, true);
  }
  const evidence = JSON.stringify(state.finish());
  assert.deepEqual(state.finish().requests.map(value => value.requestId), [...ids]);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(evidence.includes(thought(index)), false);
    assert.equal(evidence.includes(signature(index)), false);
  }
  assert.throws(() => state.observeRequest(request(observationBody(2))));
  assert.equal(state.attemptCount, 4);
  for (const thinking of [{ type: 'disabled' }, { type: 'enabled', budget_tokens: 128 }, { type: 'adaptive' }]) {
    assert.throws(() => observation().observeRequest(request({ ...observationBody(), thinking })));
  }
});

test('observation history rejects changed, reordered or opaque thinking without leaking it', () => {
  for (const mutation of ['thought', 'signature', 'missing-signature', 'reordered', 'opaque'] as const) {
    const state = observation();
    state.observeRequest(request(observationBody())); response(state, 0, undefined, ids[0], undefined, true);
    const next = observationBody(1);
    const messages = next.messages as { role: string; content: unknown }[];
    const blocks = messages[1]!.content as Record<string, unknown>[];
    if (mutation === 'thought') blocks[0]!.thinking = 'PRIVATE_CHANGED_THOUGHT';
    if (mutation === 'signature') blocks[0]!.signature = 'PRIVATE_CHANGED_SIGNATURE';
    if (mutation === 'missing-signature') delete blocks[0]!.signature;
    if (mutation === 'reordered') blocks.reverse();
    if (mutation === 'opaque') blocks[0] = { type: 'redacted_thinking', data: 'PRIVATE_OPAQUE' };
    let rejected: unknown;
    try { state.observeRequest(request(next)); } catch (error) { rejected = error; }
    assert.ok(rejected instanceof Error, mutation);
    const safe = retainCliWorkflowFailure(undefined, rejected, {
      mode: 'real', stage: 'request-contract', attemptCount: state.attemptCount,
      ...request(next), publicModel,
    });
    for (const value of [thought(0), signature(0), 'PRIVATE_CHANGED_THOUGHT', 'PRIVATE_CHANGED_SIGNATURE', 'PRIVATE_OPAQUE']) {
      assert.equal(safe.message.includes(value), false);
    }
    assert.throws(() => state.finish());
  }
});

test('observation accepts the observed CLI omission of replayed thinking blocks', () => {
  // Claude Code 2.1.216 with MAX_THINKING_TOKENS=0 does not replay provider
  // thinking blocks in assistant history (A1o live run04). The replayable
  // text/tool_use sequence must still round-trip exactly.
  const state = observation();
  state.observeRequest(request(observationBody())); response(state, 0, undefined, ids[0], undefined, true);
  const next = observationBody(1);
  const messages = next.messages as { role: string; content: unknown }[];
  messages[1]!.content = (messages[1]!.content as Record<string, unknown>[]).filter(block => block.type !== 'thinking');
  state.observeRequest(request(next));
  assert.throws(() => state.finish());
});

test('disabled scene keeps rejecting native thinking and observation refuses opaque blocks or late thought deltas', () => {
  const disabled = observer();
  disabled.observeRequest(request());
  assert.throws(() => response(disabled, 0, undefined, ids[0], undefined, true));
  for (const type of ['redacted_thinking', 'opaque', 'unknown']) {
    const state = observation(); state.observeRequest(request(observationBody()));
    state.observeUpstreamEvent(0, { type: 'message_start', message: { role: 'assistant', usage: {} } });
    assert.throws(() => state.observeUpstreamEvent(0, { type: 'content_block_start', index: 0,
      content_block: { type, data: 'PRIVATE_OPAQUE' } }));
  }
  const state = observation(); state.observeRequest(request(observationBody()));
  state.observeUpstreamEvent(0, { type: 'message_start', message: { role: 'assistant', usage: {} } });
  state.observeUpstreamEvent(0, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  state.observeUpstreamEvent(0, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: signature(0) } });
  assert.throws(() => state.observeUpstreamEvent(0, { type: 'content_block_delta', index: 0,
    delta: { type: 'thinking_delta', thinking: thought(0) } }));
});

test('observation rejects incomplete native usage or output above 512 at the terminal event', () => {
  for (const missing of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const state = observation(); state.observeRequest(request(observationBody()));
    const usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    delete usage[missing];
    assert.throws(() => response(state, 0, usage, ids[0], missing === 'output_tokens' ? {} : { output_tokens: 4 }, true), missing);
    assert.equal(state.attemptCount, 1);
    assert.throws(() => state.finish());
  }
  const state = observation(); state.observeRequest(request(observationBody()));
  assert.throws(() => response(state, 0, undefined, ids[0], { output_tokens: 513 }, true));
  assert.equal(state.attemptCount, 1);
  assert.throws(() => state.finish());
});

test('observation bounds retained thinking across otherwise individually valid events', () => {
  const state = observation(); state.observeRequest(request(observationBody()));
  state.observeUpstreamEvent(0, { type: 'message_start', message: { role: 'assistant', usage: {} } });
  state.observeUpstreamEvent(0, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  const delta = { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x'.repeat(2 * 1024 * 1024) } };
  state.observeUpstreamEvent(0, delta);
  assert.throws(() => state.observeUpstreamEvent(0, delta));
  assert.throws(() => state.finish());
});

// ---------------------------------------------------------------------------
// Enabled-observation scene: the positive-thinking-budget counterpart.
// ---------------------------------------------------------------------------
const enabledBody = (round = 0): Record<string, unknown> => {
  const value = body(round);
  value.max_tokens = 1536;
  // Observed CLI shape (capture 2026-10-24): adaptive thinking.
  value.thinking = { type: 'adaptive' };
  return value;
};
const enabledObservationBody = (round = 0): Record<string, unknown> => {
  const value = enabledBody(round);
  const messages = value.messages as { role: string; content: unknown }[];
  let index = 0;
  for (const message of messages) {
    if (message.role === 'assistant') message.content = [thinkingBlock(index++), ...(message.content as unknown[])];
  }
  return value;
};
const enabled = () => new CliWorkflowObserverState({ publicModel, readFiles, answer, scene: 'enabled-observation' });

test('enabled-observation request contract requires thinking enabled with a bounded budget', () => {
  const facts = validateCliWorkflowRequest({ ...request(enabledBody()), publicModel, scene: 'enabled-observation' });
  assert.equal(facts.thinking, 'adaptive');
  assert.equal(facts.maxTokens, 1536);
  // A bounded optional max_thinking_tokens stays within the observed contract.
  const bounded = enabledBody();
  bounded.thinking = { type: 'adaptive', max_thinking_tokens: 1024 };
  assert.equal(validateCliWorkflowRequest({ ...request(bounded), publicModel, scene: 'enabled-observation' }).thinking, 'adaptive');
  for (const mutation of ['missing', 'disabled', 'enabled-budget', 'zero-budget', 'oversized-budget', 'extra-key', 'string-budget'] as const) {
    const value = enabledBody();
    if (mutation === 'missing') delete value.thinking;
    if (mutation === 'disabled') value.thinking = { type: 'disabled' };
    if (mutation === 'enabled-budget') value.thinking = { type: 'enabled', budget_tokens: 1024 };
    if (mutation === 'zero-budget') value.thinking = { type: 'adaptive', max_thinking_tokens: 0 };
    if (mutation === 'oversized-budget') value.thinking = { type: 'adaptive', max_thinking_tokens: 1025 };
    if (mutation === 'extra-key') value.thinking = { type: 'adaptive', other: 1 };
    if (mutation === 'string-budget') value.thinking = { type: 'adaptive', max_thinking_tokens: '1024' };
    let rejected: unknown;
    try { validateCliWorkflowRequest({ ...request(value), publicModel, scene: 'enabled-observation' }); }
    catch (error) { rejected = error; }
    assert.ok(rejected instanceof Error, mutation);
  }
  const oversized = enabledBody();
  oversized.max_tokens = 1537;
  assert.throws(() => validateCliWorkflowRequest({ ...request(oversized), publicModel, scene: 'enabled-observation' }));
});

test('enabled-observation output bound rises to the scene contract and still fails closed above it', () => {
  const state = enabled();
  state.observeRequest(request(enabledBody()));
  response(state, 0, { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ids[0], { output_tokens: 1536 });
  assert.equal(state.attemptCount, 1);
  const exceeded = enabled();
  exceeded.observeRequest(request(enabledBody()));
  assert.throws(() => response(exceeded, 0,
    { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ids[0], { output_tokens: 1537 }));
});

test('enabled-observation requires replay of the observed thinking sequence byte-exact', () => {
  const replayed = enabled();
  replayed.observeRequest(request(enabledBody()));
  response(replayed, 0, undefined, ids[0], undefined, true);
  // The replaying client must send the thinking block back (unlike the
  // omitted scene, omission is not an accepted fact here).
  replayed.observeRequest(request(enabledObservationBody(1)));
  assert.throws(() => replayed.finish());

  const omitted = enabled();
  omitted.observeRequest(request(enabledBody()));
  response(omitted, 0, undefined, ids[0], undefined, true);
  const next = enabledObservationBody(1);
  const messages = next.messages as { role: string; content: unknown }[];
  messages[1]!.content = (messages[1]!.content as Record<string, unknown>[]).filter(block => block.type !== 'thinking');
  let rejected: unknown;
  try { omitted.observeRequest(request(next)); } catch (error) { rejected = error; }
  assert.ok(rejected instanceof Error);

  const mutated = enabled();
  mutated.observeRequest(request(enabledBody()));
  response(mutated, 0, undefined, ids[0], undefined, true);
  const tampered = enabledObservationBody(1);
  const tamperedMessages = tampered.messages as { role: string; content: unknown }[];
  (tamperedMessages[1]!.content as Record<string, unknown>[])[0] = { type: 'thinking', thinking: 'PRIVATE_CHANGED', signature: signature(0) };
  let rejectedMutation: unknown;
  try { mutated.observeRequest(request(tampered)); } catch (error) { rejectedMutation = error; }
  assert.ok(rejectedMutation instanceof Error);
});
