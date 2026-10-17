import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ClaudeDatelineHit,
  normalizeClaudeDatelineBody,
  normalizeDatelineText,
} from '../../../../src/saas/gateway/claude/dateline.js';

function parseBody(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

describe('normalizeDatelineText (sub2api anthropicfp port)', () => {
  it('returns canonical ASCII/hyphen input by reference with no hits', () => {
    const input = "Today's date is 2026-07-01.";
    const result = normalizeDatelineText(input);
    assert.equal(result.text, input);
    assert.equal(result.hits.length, 0);
    assert.ok(result.text === input);
  });

  it('normalizes the slash separator with an ASCII apostrophe', () => {
    const result = normalizeDatelineText("Today's date is 2026/07/01.");
    assert.equal(result.text, "Today's date is 2026-07-01.");
    assert.deepEqual<ClaudeDatelineHit[]>([...result.hits], [{ apostropheVariant: 'ascii', dateSeparator: '/' }]);
  });

  it('normalizes the U+2019 apostrophe', () => {
    const result = normalizeDatelineText('Today’s date is 2026-07-01.');
    assert.equal(result.text, "Today's date is 2026-07-01.");
    assert.deepEqual<ClaudeDatelineHit[]>([...result.hits], [{ apostropheVariant: 'u2019', dateSeparator: '-' }]);
  });

  it('normalizes the U+02BC apostrophe with the slash separator', () => {
    const result = normalizeDatelineText('Todayʼs date is 2026/07/01.');
    assert.equal(result.text, "Today's date is 2026-07-01.");
    assert.deepEqual<ClaudeDatelineHit[]>([...result.hits], [{ apostropheVariant: 'u02bc', dateSeparator: '/' }]);
  });

  it('normalizes the U+02B9 apostrophe', () => {
    const result = normalizeDatelineText('Todayʹs date is 2026/07/01.');
    assert.equal(result.text, "Today's date is 2026-07-01.");
    assert.deepEqual<ClaudeDatelineHit[]>([...result.hits], [{ apostropheVariant: 'u02b9', dateSeparator: '/' }]);
  });

  it('never matches mixed separators (backreference agreement)', () => {
    const input = "Today's date is 2026-07/01.";
    const result = normalizeDatelineText(input);
    assert.equal(result.text, input);
    assert.equal(result.hits.length, 0);
  });

  it('leaves lookalike prose untouched', () => {
    const cases = [
      'Today is a great day.',
      'His date is 2026-07-01.',
      "Yesterday's date was 2026-06-30.",
      "'s date is 2026-07-01.",
      'The date is 2026/13/45.',
    ];
    for (const input of cases) {
      const result = normalizeDatelineText(input);
      assert.equal(result.text, input);
      assert.equal(result.hits.length, 0);
    }
  });

  it('is idempotent', () => {
    const first = normalizeDatelineText('Today’s date is 2026/07/01.');
    const second = normalizeDatelineText(first.text);
    assert.equal(second.text, first.text);
    assert.equal(second.hits.length, 0);
  });

  it('normalizes multiple occurrences in one text', () => {
    const input = 'First line.\nToday’s date is 2026/07/01.\nMore text.\nTodayʼs date is 2026-07-01.\nEnd.';
    const result = normalizeDatelineText(input);
    assert.equal((result.text.match(/Today's date is/g) ?? []).length, 2);
    assert.ok(!result.text.includes('’') && !result.text.includes('ʼ') && !result.text.includes('2026/07/01'));
    assert.equal(result.hits.length, 2);
  });
});

describe('normalizeClaudeDatelineBody (request-body scope)', () => {
  it('rewrites the top-level system string', () => {
    const body = parseBody('{"system":"You are helpful.\\nToday’s date is 2026/07/01.\\nBe brief.","messages":[]}');
    const out = normalizeClaudeDatelineBody(body);
    const system = out.system;
    assert.ok(typeof system === 'string');
    assert.ok(system.includes("Today's date is 2026-07-01."));
    assert.ok(!system.includes('2026/07/01'));
    // Copy-on-write: the input object is never mutated.
    assert.equal((body.system as string).includes('2026/07/01'), true, 'the original body must stay untouched');
  });

  it('rewrites text-typed system blocks', () => {
    const body = parseBody(
      '{"system":[{"type":"text","text":"You are helpful."},{"type":"text","text":"Todayʼs date is 2026/07/01."}],"messages":[]}',
    );
    const out = normalizeClaudeDatelineBody(body);
    const blocks = out.system;
    assert.ok(Array.isArray(blocks));
    assert.equal((blocks as Array<{ text: string }>)[1]?.text, "Today's date is 2026-07-01.");
  });

  it('rewrites a messages content string inside a system-reminder block only', () => {
    const body = parseBody(
      '{"messages":[{"role":"user","content":"<system-reminder>\\n# currentDate\\nToday’s date is 2026/07/01.\\n</system-reminder>\\nHello, please help."}]}',
    );
    const out = normalizeClaudeDatelineBody(body);
    const messages = out.messages;
    assert.ok(Array.isArray(messages));
    const content = (messages as Array<{ content: string }>)[0]?.content;
    assert.ok(content?.includes("Today's date is 2026-07-01."));
    assert.ok(content?.includes('Hello, please help.'));
    assert.ok(!content?.includes('2026/07/01'));
  });

  it('rewrites text blocks inside system-reminder blocks in message content arrays', () => {
    const body = parseBody(
      '{"messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nToday’s date is 2026/07/01.\\n</system-reminder>"},{"type":"text","text":"do X"}]}]}',
    );
    const out = normalizeClaudeDatelineBody(body);
    const messages = out.messages;
    assert.ok(Array.isArray(messages));
    const blocks = (messages as Array<{ content: Array<{ text: string }> }>)[0]?.content;
    assert.equal(blocks?.[0]?.text, "<system-reminder>\nToday's date is 2026-07-01.\n</system-reminder>");
    assert.equal(blocks?.[1]?.text, 'do X');
  });

  it('never touches out-of-scope text (user prose, tool_use.input, tool_result.content)', () => {
    const json =
      '{"messages":[' +
      '{"role":"user","content":"Today’s date is 2026/07/01. Please help."},' +
      '{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"y","input":{"note":"Today’s date is 2026/07/01."}}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"log: Today’s date is 2026/07/01."}]}' +
      ']}';
    const body = parseBody(json);
    const out = normalizeClaudeDatelineBody(body);
    assert.equal(out, body, 'unchanged body must be returned by reference');
    assert.equal(JSON.stringify(out), json);
  });

  it('is idempotent at the body level', () => {
    const body = parseBody(
      '{"messages":[{"role":"user","content":"<system-reminder>\\nToday’s date is 2026/07/01.\\n</system-reminder>"}]}',
    );
    const first = normalizeClaudeDatelineBody(body);
    assert.notEqual(first, body);
    const second = normalizeClaudeDatelineBody(first);
    assert.equal(second, first);
  });

  it('normalizes multiple system-reminder blocks in one text', () => {
    const body = parseBody(
      '{"messages":[{"role":"user","content":"<system-reminder>\\nToday’s date is 2026/07/01.\\n</system-reminder>\\nsome prose\\n<system-reminder>\\nAlso Todayʼs date is 2026/07/01.\\n</system-reminder>"}]}',
    );
    const out = normalizeClaudeDatelineBody(body);
    const messages = out.messages;
    assert.ok(Array.isArray(messages));
    const content = (messages as Array<{ content: string }>)[0]?.content ?? '';
    assert.ok(!content.includes('2026/07/01'));
    assert.equal((content.match(/Today's date is/g) ?? []).length, 2);
  });

  it('returns non-object-shaped lookalikes unchanged', () => {
    const body = parseBody('{"messages":[{"role":"user","content":"hello"}],"system":"just a system prompt"}');
    const out = normalizeClaudeDatelineBody(body);
    assert.equal(out, body);
  });

  it('keeps a body with no dateline byte-identical', () => {
    const body = parseBody(
      '{"system":[{"type":"text","text":"a"}],"messages":[{"role":"user","content":[{"type":"text","text":"b"}]}]}',
    );
    const out = normalizeClaudeDatelineBody(body);
    assert.equal(out, body);
  });
});
