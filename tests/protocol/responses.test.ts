import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToResponsesRequest, responsesToAnthropicResponse } from '../../src/protocol/responses.js';

describe('responses protocol conversion', () => {
  describe('anthropicToResponsesRequest', () => {
    it('maps anthropic messages to responses input', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      });
      assert.equal(req.model, 'gpt-5');
      assert.equal(req.instructions, 'sys');
      assert.equal(req.input[0].content[0].text, 'hi');
    });

    it('skips system messages in input array', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'hello' },
        ],
      });
      assert.equal(req.input.length, 1);
      assert.equal(req.input[0].role, 'user');
      assert.equal(req.input[0].content[0].text, 'hello');
    });

    it('handles array content blocks', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'tool_result', content: { result: 42 } },
            ],
          },
        ],
      });
      assert.equal(req.input[0].content.length, 2);
      assert.equal(req.input[0].content[0].type, 'input_text');
      assert.equal(req.input[0].content[0].text, 'hello');
      assert.equal(req.input[0].content[1].type, 'input_text');
      assert.equal(req.input[0].content[1].text, '{"result":42}');
    });

    it('maps assistant role correctly', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [{ role: 'assistant', content: 'sure' }],
      });
      assert.equal(req.input[0].role, 'assistant');
    });

    it('handles system as array of blocks', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        system: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(req.instructions, 'line1\nline2');
    });

    it('maps tools to function definitions', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather info',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      });
      assert.equal(req.tools.length, 1);
      assert.equal(req.tools[0].type, 'function');
      assert.equal(req.tools[0].name, 'get_weather');
      assert.equal(req.tools[0].description, 'Get weather info');
      assert.deepEqual(req.tools[0].parameters, { type: 'object', properties: { city: { type: 'string' } } });
    });

    it('maps thinking to reasoning', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      });
      assert.deepEqual(req.reasoning, { effort: 'high' });
    });

    it('maps non-adaptive thinking to medium effort', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' },
      });
      assert.deepEqual(req.reasoning, { effort: 'medium' });
    });

    it('does not include instructions when system is empty', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(req.instructions, undefined);
    });

    it('passes through optional params', () => {
      const req = anthropicToResponsesRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 256,
        temperature: 0.7,
        top_p: 0.9,
        stream: true,
      });
      assert.equal(req.max_output_tokens, 256);
      assert.equal(req.temperature, 0.7);
      assert.equal(req.top_p, 0.9);
      assert.equal(req.stream, true);
    });
  });

  describe('responsesToAnthropicResponse', () => {
    it('maps message output to text block', () => {
      const res = responsesToAnthropicResponse({
        id: 'resp_123',
        model: 'gpt-5',
        output: [{ type: 'message', content: [{ text: 'hello' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      assert.equal(res.id, 'resp_123');
      assert.equal(res.type, 'message');
      assert.equal(res.role, 'assistant');
      assert.equal(res.model, 'gpt-5');
      assert.equal(res.content[0].type, 'text');
      assert.equal(res.content[0].text, 'hello');
      assert.equal(res.usage.input_tokens, 10);
      assert.equal(res.usage.output_tokens, 5);
      assert.equal(res.stop_reason, 'end_turn');
    });

    it('maps function_call to tool_use', () => {
      const res = responsesToAnthropicResponse({
        id: 'resp_456',
        model: 'gpt-5',
        output: [
          {
            type: 'function_call',
            call_id: 'call_789',
            name: 'get_weather',
            arguments: { city: 'NYC' },
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      });
      assert.equal(res.content[0].type, 'tool_use');
      assert.equal(res.content[0].id, 'call_789');
      assert.equal(res.content[0].name, 'get_weather');
      assert.deepEqual(res.content[0].input, { city: 'NYC' });
    });

    it('generates fallback tool id when call_id missing', () => {
      const before = Date.now();
      const res = responsesToAnthropicResponse({
        id: 'resp_789',
        model: 'gpt-5',
        output: [{ type: 'function_call', name: 'foo', arguments: {} }],
        usage: {},
      });
      const after = Date.now();
      assert.ok(res.content[0].id.startsWith('toolu_'));
      const ts = parseInt(res.content[0].id.replace('toolu_', ''), 10);
      assert.ok(ts >= before && ts <= after);
    });

    it('sets stop_reason to max_tokens when incomplete_details present', () => {
      const res = responsesToAnthropicResponse({
        id: 'resp_abc',
        model: 'gpt-5',
        output: [{ type: 'message', content: [{ text: 'cut off' }] }],
        usage: {},
        incomplete_details: { reason: 'max_output_tokens' },
      });
      assert.equal(res.stop_reason, 'max_tokens');
    });

    it('defaults usage to zero when missing', () => {
      const res = responsesToAnthropicResponse({
        id: 'resp_def',
        model: 'gpt-5',
        output: [{ type: 'message', content: [{ text: 'ok' }] }],
      });
      assert.equal(res.usage.input_tokens, 0);
      assert.equal(res.usage.output_tokens, 0);
    });
  });
});
