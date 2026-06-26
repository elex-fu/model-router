import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickBridge } from '../../src/protocol/bridge.js';

describe('pickBridge extended protocols', () => {
  it('returns pass-through for gemini->gemini', () => {
    const b = pickBridge('gemini', 'gemini');
    assert.equal(b.clientProto, 'gemini');
  });
  it('returns pass-through for responses->responses', () => {
    const b = pickBridge('responses', 'responses');
    assert.equal(b.clientProto, 'responses');
  });
  it('throws for unsupported cross-protocol', () => {
    assert.throws(() => pickBridge('gemini', 'openai'), /Unsupported bridge/);
  });
});
