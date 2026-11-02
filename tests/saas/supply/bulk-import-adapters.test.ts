import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeCredentialSink } from '../../../src/saas/platform/claude-oauth/http.js';
import type { CodexCredentialSink } from '../../../src/saas/platform/codex-oauth/http.js';
import type { GeminiCredentialSink } from '../../../src/saas/platform/gemini-oauth/http.js';
import type { GrokCredentialSink } from '../../../src/saas/platform/grok-oauth/http.js';
import { GROK_OAUTH_CLIENT_ID } from '../../../src/saas/platform/grok-oauth/oauth.js';
import {
  type BulkImportProviderSinks,
  createBulkImportCredentialSinks,
} from '../../../src/saas/supply/bulk-import-adapters.js';
import type { BulkImportMaterial, BulkImportSinkInput } from '../../../src/saas/supply/bulk-import-service.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION = '22222222-2222-4222-8222-222222222222';

function material(label: string): string {
  return ['test', 'fixture', label].join('-');
}

function input(envelope: BulkImportMaterial): BulkImportSinkInput {
  return {
    envelope,
    actorUserId: ACTOR,
    sourceIp: '127.0.0.1',
    userAgent: 'bulk-import-test',
    displayName: 'not forwarded to legacy sinks',
    egressProxyId: null,
  };
}

function harness() {
  const calls = {
    codex: [] as Parameters<CodexCredentialSink['accept']>[0][],
    claude: [] as Parameters<ClaudeCredentialSink['accept']>[0][],
    gemini: [] as Parameters<GeminiCredentialSink['accept']>[0][],
    grok: [] as Parameters<GrokCredentialSink['accept']>[0][],
  };
  const sinks: BulkImportProviderSinks = {
    codex: {
      accept: async (value) => {
        calls.codex.push(value);
        return { accountRef: 'codex-account' };
      },
    },
    claude: {
      accept: async (value) => {
        calls.claude.push(value);
        return { accountRef: 'claude-account' };
      },
    },
    gemini: {
      accept: async (value) => {
        calls.gemini.push(value);
        return { accountRef: 'gemini-account' };
      },
    },
    grok: {
      accept: async (value) => {
        calls.grok.push(value);
        return { accountRef: 'grok-account' };
      },
    },
  };
  return { calls, adapters: createBulkImportCredentialSinks(sinks) };
}

test('Codex, Claude, Gemini and Grok adapters produce typed envelopes and required import sources', async () => {
  const { calls, adapters } = harness();
  assert.deepEqual(
    await adapters.codex.accept(
      input({
        tokens: {
          access_token: material('codex-access'),
          refresh_token: material('codex-refresh'),
          account_id: material('codex-account'),
        },
      }),
    ),
    { accountRef: 'codex-account' },
  );
  assert.deepEqual(
    await adapters.claude.accept(
      input({
        claudeAiOauth: {
          accessToken: material('claude-access'),
          refreshToken: material('claude-refresh'),
          organizationUuid: ORGANIZATION,
        },
      }),
    ),
    { accountRef: 'claude-account' },
  );
  assert.deepEqual(
    await adapters.gemini.accept(
      input({
        access_token: material('gemini-access'),
        refresh_token: material('gemini-refresh'),
        project_id: 'fixture-project',
        expiry_date: 1_800_000_000_000,
      }),
    ),
    { accountRef: 'gemini-account' },
  );
  assert.deepEqual(
    await adapters.grok.accept(
      input({
        access_token: material('grok-access'),
        refresh_token: material('grok-refresh'),
        user_id: 'fixture-user',
        expires_at: '2027-01-02T03:04:05.000Z',
      }),
    ),
    { accountRef: 'grok-account' },
  );

  assert.equal(calls.codex[0]?.source, 'auth-json-import');
  assert.equal(calls.claude[0]?.source, 'credentials-json-import');
  assert.equal(calls.gemini[0]?.source, 'credentials-json-import');
  assert.equal(calls.grok[0]?.source, 'credentials-json-import');
  assert.equal(calls.codex[0]?.envelope.chatgptAccountId, material('codex-account'));
  assert.equal(calls.claude[0]?.envelope.organizationUuid, ORGANIZATION);
  assert.equal(calls.gemini[0]?.envelope.projectId, 'fixture-project');
  assert.equal(calls.grok[0]?.envelope.userId, 'fixture-user');
  assert.equal(calls.grok[0]?.envelope.clientId, GROK_OAUTH_CLIENT_ID);
  assert.equal(calls.grok[0]?.envelope.expiresAt, '2027-01-02T03:04:05.000Z');
  for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
    assert.equal(calls[provider][0]?.actorUserId, ACTOR);
    assert.equal(calls[provider][0]?.sourceIp, '127.0.0.1');
    assert.equal(calls[provider][0]?.userAgent, 'bulk-import-test');
    assert.equal('capabilities' in adapters[provider], false);
  }
});

test('all provider adapters reject malformed material before invoking a sink', async () => {
  const { calls, adapters } = harness();
  const malformed = {
    codex: { tokens: { access_token: material('incomplete') } },
    claude: { claudeAiOauth: { accessToken: material('incomplete') } },
    gemini: { access_token: material('access'), refresh_token: material('refresh') },
    grok: { access_token: material('access'), refresh_token: material('refresh') },
  };
  for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
    await assert.rejects(adapters[provider].accept(input(malformed[provider])));
    assert.equal(calls[provider].length, 0);
  }
});

test('Grok conversion is strict about conflicting aliases, expiry and optional field types', async () => {
  const { calls, adapters } = harness();
  const base = {
    access_token: material('grok-access'),
    refresh_token: material('grok-refresh'),
    user_id: 'fixture-user',
  };
  await assert.rejects(adapters.grok.accept(input({ ...base, accessToken: material('different') })), {
    code: 'CREDENTIALS_JSON_INVALID',
  });
  await assert.rejects(adapters.grok.accept(input({ ...base, expires_at: 'not-a-time' })), {
    code: 'CREDENTIALS_JSON_INVALID',
  });
  await assert.rejects(adapters.grok.accept(input({ ...base, email: 42 })), {
    code: 'CREDENTIALS_JSON_INVALID',
  });
  assert.equal(calls.grok.length, 0);
});
