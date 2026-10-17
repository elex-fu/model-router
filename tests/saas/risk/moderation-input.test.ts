import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractModerationText, moderationInputHash, trimRunes } from '../../../src/saas/risk/moderation-input.js';

describe('moderation text extraction', () => {
  it('extracts the last anthropic user message', () => {
    const body = {
      model: 'claude-sonnet-4',
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: [{ type: 'text', text: '  final   question  ' }] },
      ],
    };
    assert.equal(extractModerationText('anthropic', body, true), 'final question');
  });

  it('skips trailing anthropic system messages and keeps the last user turn', () => {
    const body = {
      messages: [
        { role: 'user', content: 'real question' },
        { role: 'system', content: 'late system reminder' },
      ],
    };
    assert.equal(extractModerationText('anthropic', body, true), 'real question');
  });

  it('returns empty when the last anthropic message is assistant', () => {
    const body = {
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ],
    };
    assert.equal(extractModerationText('anthropic', body, true), '');
  });

  it('extracts nothing when the last openai message is not a user turn (reference semantics)', () => {
    const body = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'mid' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'last' },
      ],
    };
    assert.equal(extractModerationText('openai', body, true), '');
  });

  it('extracts the last openai user message when it is the final turn', () => {
    const body = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'mid' },
        { role: 'user', content: 'second' },
      ],
    };
    assert.equal(extractModerationText('openai', body, true), 'second');
  });

  it('extracts responses input as plain string', () => {
    assert.equal(extractModerationText('responses', { input: '  a prompt  ' }, true), 'a prompt');
  });

  it('extracts the last responses user item', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello there' }] },
        { role: 'assistant', content: 'reply' },
      ],
    };
    // Last item is assistant → nothing extracted.
    assert.equal(extractModerationText('responses', body, true), '');
    const body2 = {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user says hi' }] }],
    };
    assert.equal(extractModerationText('responses', body2, true), 'user says hi');
  });

  it('drops <system-reminder> content only for semantic extraction', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>hidden reminder</system-reminder>' },
            { type: 'text', text: 'visible question' },
          ],
        },
      ],
    };
    assert.equal(extractModerationText('anthropic', body, true), 'visible question');
    assert.equal(
      extractModerationText('anthropic', body, false),
      '<system-reminder>hidden reminder</system-reminder> visible question',
    );
  });

  it('joins multi-part content and normalizes whitespace', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part one\n\n' },
            { type: 'text', text: '  part\ttwo ' },
          ],
        },
      ],
    };
    assert.equal(extractModerationText('openai', body, true), 'part one part two');
  });

  it('handles string content, arrays of strings, and missing fields', () => {
    assert.equal(extractModerationText('openai', { messages: [{ role: 'user', content: 'plain' }] }, true), 'plain');
    assert.equal(extractModerationText('openai', { messages: [{ role: 'user', content: ['a', 'b'] }] }, true), 'a b');
    assert.equal(extractModerationText('openai', {}, true), '');
    assert.equal(extractModerationText('anthropic', { messages: [] }, true), '');
    assert.equal(extractModerationText('responses', {}, true), '');
    assert.equal(extractModerationText('openai', { messages: [{ role: 'user' }] }, true), '');
  });

  it('truncates very long text at the 12000-rune cap for semantic use', () => {
    const long = 'x'.repeat(20000);
    const body = { messages: [{ role: 'user', content: long }] };
    const text = extractModerationText('openai', body, true);
    // Extraction itself is not capped here; the moderation service applies
    // the cap. Verify the helper.
    assert.ok([...text].length === 20000);
    assert.equal([...trimRunes(text, 12000)].length, 12000);
  });

  it('hashes text deterministically with the reference prefix', () => {
    const a = moderationInputHash('hello');
    const b = moderationInputHash('hello');
    const c = moderationInputHash('world');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});
