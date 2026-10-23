import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickBridge, type Protocol } from '../../src/protocol/bridge.js';

describe('pickBridge extended protocols', () => {
  it('returns pass-through for gemini->gemini', () => {
    const b = pickBridge('gemini', 'gemini');
    assert.equal(b.clientProto, 'gemini');
  });
  it('returns pass-through for responses->responses', () => {
    const b = pickBridge('responses', 'responses');
    assert.equal(b.clientProto, 'responses');
  });
  it('registers the four direct Gemini pairs', () => {
    for (const [client, upstream] of [['gemini', 'openai'], ['openai', 'gemini'], ['gemini', 'responses'], ['responses', 'gemini']] as const) {
      const bridge = pickBridge(client, upstream);
      assert.equal(bridge.clientProto, client);
      assert.equal(bridge.upstreamProto, upstream);
    }
  });
  it('rejects unknown protocols', () => {
    assert.throws(() => pickBridge('unknown' as Protocol, 'openai'), /Unsupported bridge/);
  });
  it('registered Gemini bridges still reject unsupported opaque reasoning', () => {
    const bridge = pickBridge('gemini', 'openai');
    assert.throws(() => bridge.transformRequest({ contents: [{ role: 'model', parts: [{ thoughtSignature: 'opaque' }] }] }), /Unsupported bridge feature/);
  });
});
