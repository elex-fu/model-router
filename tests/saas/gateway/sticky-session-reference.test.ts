import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  deriveStickySessionReferences,
  sessionFromMetadataUserId,
  stickySchedulingContext,
} from '../../../src/saas/gateway/sticky-session-reference.js';

const DEVICE = 'a'.repeat(64);
const SESSION = '11111111-2222-3333-4444-555555555555';

function anthropicBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second question' }] },
    ],
    metadata: { user_id: `user_${DEVICE}_account__session_${SESSION}` },
    ...overrides,
  };
}

function openAiBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5.2',
    instructions: 'Follow the plan.',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first user turn' },
      { role: 'assistant', content: 'reply' },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'anthropic',
    headers: {},
    body: anthropicBody(),
    clientIp: '203.0.113.7',
    userAgent: 'claude-cli/2.1.80 (external, cli)',
    proxyKeyId: 'key_42',
    ...overrides,
  };
}

function sha256(domain: string, ...parts: readonly string[]): string {
  const hash = createHash('sha256').update(domain);
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('hex');
}

test('metadata.user_id parsing accepts both Claude Code formats and rejects noise', () => {
  assert.equal(sessionFromMetadataUserId(`user_${DEVICE}_account__session_${SESSION}`), SESSION);
  assert.equal(
    sessionFromMetadataUserId(JSON.stringify({ device_id: DEVICE, account_uuid: 'acct-uuid', session_id: SESSION })),
    SESSION,
  );
  // The JSON format requires both device_id and session_id.
  assert.equal(sessionFromMetadataUserId(JSON.stringify({ session_id: SESSION })), null);
  assert.equal(sessionFromMetadataUserId(JSON.stringify({ device_id: DEVICE })), null);
  assert.equal(sessionFromMetadataUserId(JSON.stringify({ device_id: DEVICE, session_id: '' })), null);
  assert.equal(sessionFromMetadataUserId('not-a-user-id'), null);
  assert.equal(sessionFromMetadataUserId('user_zzz_account__session_${SESSION}'), null);
  assert.equal(sessionFromMetadataUserId(42), null);
  assert.equal(sessionFromMetadataUserId(null), null);
  // A valid JSON payload that is not an object is rejected.
  assert.equal(sessionFromMetadataUserId('[1,2,3]'), null);
});

test('anthropic metadata.user_id is the highest-priority raw session reference', () => {
  const references = deriveStickySessionReferences(baseInput() as never);
  assert.equal(references.sessionId, SESSION);
  assert.equal(references.conversationId, null);
  // The raw UUID wins even when ephemeral content and fallback exist.
  const scheduling = stickySchedulingContext(baseInput() as never);
  assert.deepEqual(scheduling, { sessionId: SESSION });
});

test('anthropic legacy metadata.user_id with an account uuid parses identically', () => {
  const legacy = `user_${DEVICE}_account_8618880e-99a1-4f1c-8cb8-e6c90b8c1e0c_session_${SESSION}`;
  const references = deriveStickySessionReferences(
    baseInput({ body: anthropicBody({ metadata: { user_id: legacy } }) }) as never,
  );
  assert.equal(references.sessionId, SESSION);
});

test('a malformed metadata.user_id degrades to the ephemeral or content tiers', () => {
  const body = anthropicBody({ metadata: { user_id: 'garbage' } });
  const references = deriveStickySessionReferences(baseInput({ body }) as never);
  assert.equal(references.sessionId, null);
  assert.ok(references.contentHash, 'the content fallback still produces a reference');
});

test('anthropic ephemeral message content hashes the full text of the marked message', () => {
  const body = anthropicBody({
    metadata: {},
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'not cached' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'cached prefix' },
          { type: 'text', text: 'cached suffix', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  });
  const references = deriveStickySessionReferences(baseInput({ body }) as never);
  assert.equal(references.sessionId, null);
  assert.equal(references.promptCacheKey, sha256('model-router:sticky:ephemeral:v1', 'cached prefixcached suffix'));
  assert.deepEqual(stickySchedulingContext(baseInput({ body }) as never), {
    sessionId: sha256('model-router:sticky:ephemeral:v1', 'cached prefixcached suffix'),
  });
});

test('anthropic ephemeral system parts hash when no message carries a marker', () => {
  const body = anthropicBody({
    metadata: {},
    system: [
      { type: 'text', text: 'plain system' },
      { type: 'text', text: 'cached system', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: 'no markers' }],
  });
  const references = deriveStickySessionReferences(baseInput({ body }) as never);
  assert.equal(references.promptCacheKey, sha256('model-router:sticky:ephemeral:v1', 'cached system'));
});

test('anthropic content fallback mixes client context with system and all message text', () => {
  const body = anthropicBody({ metadata: {} });
  const references = deriveStickySessionReferences(baseInput({ body }) as never);
  const discriminators = sha256(
    'model-router:sticky:context:v1',
    '203.0.113.7',
    'claude-cli/2.1.80 (external, cli)',
    'key_42',
  );
  assert.equal(
    references.contentHash,
    sha256(
      'model-router:sticky:content:v1',
      discriminators,
      'You are helpful.\0first questionfirst answersecond question',
    ),
  );
  // Same content from a different caller (key, IP, or UA) never collides.
  const otherCaller = deriveStickySessionReferences(baseInput({ body, proxyKeyId: 'key_43' }) as never);
  assert.notEqual(otherCaller.contentHash, references.contentHash);
  // Same caller and content is deterministic.
  const again = deriveStickySessionReferences(baseInput({ body }) as never);
  assert.equal(again.contentHash, references.contentHash);
});

test('anthropic bodies without any text produce no reference at all', () => {
  const body = { model: 'claude-sonnet-4-5', metadata: {} };
  assert.equal(stickySchedulingContext(baseInput({ body }) as never), undefined);
  assert.equal(deriveStickySessionReferences(baseInput({ body }) as never).contentHash, null);
});

test('openai session-id and conversation_id headers rank above the body prompt_cache_key', () => {
  const body = openAiBody({ prompt_cache_key: 'pc-key-1' });
  const sessionHeader = deriveStickySessionReferences(
    baseInput({ protocol: 'openai', body, headers: { 'session-id': 'sess-h1' } }) as never,
  );
  assert.equal(sessionHeader.sessionId, 'sess-h1');
  assert.equal(sessionHeader.conversationId, null);
  assert.equal(sessionHeader.promptCacheKey, 'pc-key-1');
  assert.deepEqual(
    stickySchedulingContext(baseInput({ protocol: 'openai', body, headers: { 'session-id': 'sess-h1' } }) as never),
    {
      sessionId: 'sess-h1',
    },
  );

  const conversationHeader = deriveStickySessionReferences(
    baseInput({ protocol: 'openai', body, headers: { conversation_id: 'conv-h1' } }) as never,
  );
  assert.equal(conversationHeader.sessionId, null);
  assert.equal(conversationHeader.conversationId, 'conv-h1');
  assert.deepEqual(
    stickySchedulingContext(baseInput({ protocol: 'openai', body, headers: { conversation_id: 'conv-h1' } }) as never),
    { sessionId: 'conv-h1' },
  );

  // Body-only: conversation_id (body) still outranks prompt_cache_key.
  const bodyConversation = openAiBody({ prompt_cache_key: 'pc-key-1', conversation_id: 'conv-b1' });
  assert.deepEqual(stickySchedulingContext(baseInput({ protocol: 'openai', body: bodyConversation }) as never), {
    sessionId: 'conv-b1',
  });
  // And prompt_cache_key beats the content fallback.
  assert.deepEqual(stickySchedulingContext(baseInput({ protocol: 'openai', body }) as never), {
    sessionId: 'pc-key-1',
  });
});

test('openai stable-field content fallback covers model, instructions, system prefix and first user turn', () => {
  const body = openAiBody({
    tools: [{ function: { name: 'lookup' } }, { name: 'direct_tool' }],
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'developer', content: 'dev prompt' },
      { role: 'user', content: 'first user turn' },
      { role: 'user', content: 'second user turn' },
    ],
  });
  const references = deriveStickySessionReferences(baseInput({ protocol: 'openai', body }) as never);
  const discriminators = sha256(
    'model-router:sticky:context:v1',
    '203.0.113.7',
    'claude-cli/2.1.80 (external, cli)',
    'key_42',
  );
  const seed = [
    'gpt-5.2',
    'Follow the plan.',
    'lookup',
    'direct_tool',
    'system prompt',
    'dev prompt',
    'first user turn',
  ].join('\0');
  assert.equal(references.contentHash, sha256('model-router:sticky:content:v1', discriminators, seed));
  // A later conversation turn (new assistant/user messages appended) keeps
  // the same seed fields, so the session stays pinned to one account.
  const later = openAiBody({
    tools: [{ function: { name: 'lookup' } }, { name: 'direct_tool' }],
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'developer', content: 'dev prompt' },
      { role: 'user', content: 'first user turn' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up turn' },
    ],
  });
  const laterReferences = deriveStickySessionReferences(baseInput({ protocol: 'openai', body: later }) as never);
  assert.equal(laterReferences.contentHash, references.contentHash);
});

test('responses-protocol input items seed the content fallback', () => {
  const body = {
    model: 'gpt-5.2',
    instructions: 'Follow the plan.',
    input: [
      { role: 'user', content: 'first user turn' },
      { role: 'assistant', content: 'reply' },
    ],
  };
  const references = deriveStickySessionReferences(baseInput({ protocol: 'responses', body }) as never);
  const discriminators = sha256(
    'model-router:sticky:context:v1',
    '203.0.113.7',
    'claude-cli/2.1.80 (external, cli)',
    'key_42',
  );
  assert.equal(
    references.contentHash,
    sha256('model-router:sticky:content:v1', discriminators, 'gpt-5.2\0Follow the plan.\0first user turn'),
  );
});

test('stateless operations never derive content-fallback references', () => {
  const body = { model: 'text-embedding-3-large', input: 'embed me' };
  assert.equal(stickySchedulingContext(baseInput({ protocol: 'openai', body, stateless: true }) as never), undefined);
  // But an explicit session signal still sticks (sub2api /v1/images precedent).
  assert.deepEqual(
    stickySchedulingContext(
      baseInput({ protocol: 'openai', body, stateless: true, headers: { 'session-id': 'sess-h1' } }) as never,
    ),
    { sessionId: 'sess-h1' },
  );
});

test('oversized and empty references are dropped, not truncated', () => {
  const long = 'x'.repeat(513);
  const openAiHeaders = (sessionId: unknown): Record<string, unknown> => ({
    protocol: 'openai',
    body: { model: 'gpt-5.2' },
    headers: { 'session-id': sessionId },
  });
  assert.equal(deriveStickySessionReferences(baseInput(openAiHeaders(long)) as never).sessionId, null);
  assert.equal(deriveStickySessionReferences(baseInput(openAiHeaders('  ')) as never).sessionId, null);
  // Headers are read as arrays too (Node keeps repeated headers).
  assert.equal(deriveStickySessionReferences(baseInput(openAiHeaders(['sess-h1'])) as never).sessionId, 'sess-h1');
});

test('header values are trimmed and user agents are bounded but raw', () => {
  assert.equal(
    deriveStickySessionReferences(
      baseInput({
        protocol: 'openai',
        body: { model: 'gpt-5.2' },
        headers: { 'session-id': ' sess-h1 ' },
      }) as never,
    ).sessionId,
    'sess-h1',
  );
  const body = anthropicBody({ metadata: {} });
  const longAgent = deriveStickySessionReferences(baseInput({ body, userAgent: 'x'.repeat(2049) }) as never);
  // A too-long agent is treated as absent for the discriminator, not fatal.
  assert.ok(longAgent.contentHash);
  assert.notEqual(longAgent.contentHash, deriveStickySessionReferences(baseInput({ body }) as never).contentHash);
});
