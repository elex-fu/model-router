import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preprocessRequest } from '../../src/server/preprocess.js';

test('filters _-prefixed private params recursively', () => {
  const body = {
    model: 'claude-test',
    messages: [{ role: 'user', content: 'hi', _internal_id: 'xyz' }],
    _debug: true,
    nested: { _secret: 'key', visible: 'yes' },
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-test');
  assert.equal(out._debug, undefined);
  assert.equal(out.messages[0]._internal_id, undefined);
  assert.equal(out.nested._secret, undefined);
  assert.equal(out.nested.visible, 'yes');
});

test('converts orphan tool_result to text', () => {
  const body = {
    model: 'claude-test',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'orphan' }] },
    ],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-test');
  const userContent = out.messages[1].content;
  assert.equal(userContent.length, 1);
  assert.equal(userContent[0].type, 'text');
  assert.ok(userContent[0].text.includes('orphan'));
});

test('keeps valid tool_result untouched', () => {
  const body = {
    model: 'claude-test',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-test');
  assert.equal(out.messages[1].content[0].type, 'tool_result');
});

test('anthropic upstream: injects cache_control breakpoints', () => {
  const body = {
    model: 'claude-test',
    tools: [{ name: 't1' }, { name: 't2' }],
    system: [{ type: 'text', text: 'sys' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-test');
  assert.deepEqual(out.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.messages[1].content[0].cache_control, { type: 'ephemeral' });
});

test('anthropic upstream: converts string system to array before injecting cache_control', () => {
  const body = {
    model: 'claude-test',
    system: 'You are helpful',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-test');
  assert.ok(Array.isArray(out.system));
  assert.equal(out.system[0].type, 'text');
  assert.equal(out.system[0].text, 'You are helpful');
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
});

test('anthropic upstream: does not exceed 4 cache_control breakpoints', () => {
  const body = {
    model: 'claude-test',
    tools: [{ name: 't1', cache_control: { type: 'ephemeral' } }],
    system: [{ type: 'text', text: 's1', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-test');
  assert.equal(out.tools[0].cache_control.type, 'ephemeral');
  assert.equal(out.system[0].cache_control.type, 'ephemeral');
  // No new injections because budget = 0
  assert.equal(out.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(out.messages[0].content[1].cache_control.type, 'ephemeral');
});

test('anthropic upstream: injects enabled thinking for non-haiku non-opus/sonnet-4-6', () => {
  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-sonnet-4-5');
  assert.equal(out.thinking.type, 'enabled');
  assert.equal(out.thinking.budget_tokens, 8191);
  assert.equal(out.anthropic_beta, undefined);
});

test('anthropic upstream: injects adaptive thinking for sonnet-4-6', () => {
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-sonnet-4-6');
  assert.equal(out.thinking.type, 'adaptive');
  assert.equal(out.output_config.effort, 'max');
  assert.equal(out.anthropic_beta, undefined);
});

test('anthropic upstream: skips thinking for haiku', () => {
  const body = {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
  const out = preprocessRequest(body, 'anthropic', 'claude-haiku-4-5');
  assert.equal(out.thinking, undefined);
});

test('openai upstream: strips thinking and cache_control', () => {
  const body = {
    model: 'gpt-4',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'max' },
    anthropic_beta: ['interleaved-thinking-2025-05-14'],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
    tools: [{ name: 't1', cache_control: { type: 'ephemeral' } }],
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  };
  const out = preprocessRequest(body, 'openai', 'gpt-4');
  assert.equal(out.thinking, undefined);
  assert.equal(out.output_config, undefined);
  assert.equal(out.anthropic_beta, undefined);
  assert.equal(out.messages[0].content.length, 1);
  assert.equal(out.messages[0].content[0].type, 'text');
  assert.equal(out.messages[0].content[0].cache_control, undefined);
  assert.equal(out.tools[0].cache_control, undefined);
  assert.equal(out.system[0].cache_control, undefined);
});

test('does not mutate original body', () => {
  const body = { model: 'claude-test', _private: 'x', messages: [] };
  const original = JSON.stringify(body);
  preprocessRequest(body, 'anthropic', 'claude-test');
  assert.equal(JSON.stringify(body), original);
});
