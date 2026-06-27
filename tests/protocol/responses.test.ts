import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { responsesStreamToAnthropicStream } from '../../src/protocol/responses.js';
import { CodexChatHistoryStore } from '../../src/protocol/codex-history.js';

describe('responses protocol conversion', () => {
  describe('responsesStreamToAnthropicStream', () => {
    it('returns empty for non-data lines', () => {
      assert.deepEqual(responsesStreamToAnthropicStream('event: foo'), []);
    });

    it('returns empty for [DONE]', () => {
      assert.deepEqual(responsesStreamToAnthropicStream('data: [DONE]'), []);
    });

    it('maps response.output_text.delta to text_delta', () => {
      const events = responsesStreamToAnthropicStream('data: {"type":"response.output_text.delta","delta":"hello"}');
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'content_block_delta');
      assert.equal(events[0].index, 0);
      assert.equal(events[0].delta.type, 'text_delta');
      assert.equal(events[0].delta.text, 'hello');
    });

    it('maps response.function_call_arguments.delta to input_json_delta', () => {
      const events = responsesStreamToAnthropicStream('data: {"type":"response.function_call_arguments.delta","delta":"{\\"a\\":1}"}');
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'content_block_delta');
      assert.equal(events[0].index, 1);
      assert.equal(events[0].delta.type, 'input_json_delta');
      assert.equal(events[0].delta.partial_json, '{"a":1}');
    });

    it('ignores unknown event types', () => {
      assert.deepEqual(responsesStreamToAnthropicStream('data: {"type":"response.created"}'), []);
    });
  });

  describe('CodexChatHistoryStore', () => {
    it('stores and retrieves previous_response_id', () => {
      const store = new CodexChatHistoryStore();
      store.setPreviousResponseId('sess1', 'resp_123');
      assert.equal(store.getPreviousResponseId('sess1'), 'resp_123');
    });

    it('returns undefined for unknown session', () => {
      const store = new CodexChatHistoryStore();
      assert.equal(store.getPreviousResponseId('unknown'), undefined);
    });

    it('overwrites previous value for same session', () => {
      const store = new CodexChatHistoryStore();
      store.setPreviousResponseId('sess1', 'resp_123');
      store.setPreviousResponseId('sess1', 'resp_456');
      assert.equal(store.getPreviousResponseId('sess1'), 'resp_456');
    });
  });
});
