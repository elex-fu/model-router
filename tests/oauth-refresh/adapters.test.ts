import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  DEFAULT_OAUTH_REFRESH_USER_AGENT,
  GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  geminiOAuthRefreshAdapter,
  normalizeProviderKey,
  type OAuthRefreshAdapter,
  resolveAdapter,
  resolvePassthroughAdapter,
} from '../../src/oauth-refresh/adapters.js';
import { GEMINI_OAUTH_CLIENT_SECRET_ENV } from '../../src/saas/platform/gemini-oauth/oauth.js';

describe('resolveAdapter registry', () => {
  it('resolves the classic key and both SaaS codex triples to the SAME adapter instance', () => {
    const classic = resolveAdapter('codex_oauth');
    const chatgpt = resolveAdapter('openai-codex/codex-chatgpt/oauth');
    const cli = resolveAdapter('openai/codex-cli/oauth');
    assert.ok(classic !== null);
    assert.ok(chatgpt !== null);
    assert.ok(cli !== null);
    assert.equal(classic, chatgpt);
    assert.equal(classic, cli);

    assert.equal(classic.tokenEndpoint, 'https://auth.openai.com/oauth/token');
    assert.equal(classic.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(classic.refreshScope, 'openid profile email');
    assert.equal(classic.userAgent, 'codex_cli_rs/0.146.0 (Mac OS X 15.0; arm64) Terminal');
    assert.deepEqual(classic.passthroughFields, CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS);
  });

  it('resolves both claude bindings from the platform constants', () => {
    const subscription = resolveAdapter('anthropic-claude/claude-subscription/oauth');
    assert.ok(subscription !== null);
    assert.equal(subscription.tokenEndpoint, 'https://platform.claude.com/v1/oauth/token');
    assert.equal(subscription.clientId, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    assert.equal(subscription.refreshScope, null);
    assert.equal(subscription.userAgent, 'axios/1.13.6');
    assert.deepEqual(subscription.passthroughFields, CLAUDE_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS);

    const legacy = resolveAdapter('anthropic/claude-code/oauth');
    assert.ok(legacy !== null);
    assert.equal(legacy.tokenEndpoint, 'https://console.anthropic.com/v1/oauth/token');
    assert.equal(legacy.clientId, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    assert.equal(legacy.refreshScope, null);
    assert.equal(legacy.userAgent, 'model-router');
    assert.deepEqual(legacy.passthroughFields, []);
  });

  it('resolves the grok binding from the platform constants', () => {
    const grok = resolveAdapter('xai-grok/grok-subscription/oauth');
    assert.ok(grok !== null);
    assert.equal(grok.tokenEndpoint, 'https://auth.x.ai/oauth2/token');
    assert.equal(grok.clientId, 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.equal(grok.refreshScope, null);
    assert.equal(grok.userAgent, 'xai-grok-workspace/0.2.120');
    assert.deepEqual(grok.passthroughFields, GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS);
  });

  it('resolves the gemini binding only when the client secret is configured', () => {
    // Fail-closed: without the environment secret there is no adapter, so
    // gemini credentials are excluded by the due scan rather than refreshed
    // against a grant missing its secret.
    const unconfigured = process.env[GEMINI_OAUTH_CLIENT_SECRET_ENV] === undefined;
    if (unconfigured) {
      assert.equal(resolveAdapter('google-gemini/gemini-subscription/oauth'), null);
    }
    const gemini = geminiOAuthRefreshAdapter('test-installed-app-secret');
    assert.ok(gemini !== null);
    assert.equal(gemini.tokenEndpoint, 'https://oauth2.googleapis.com/token');
    assert.equal(gemini.clientId, '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    assert.equal(gemini.refreshScope, null);
    assert.equal(gemini.clientSecret, 'test-installed-app-secret');
    assert.equal(gemini.userAgent, 'model-router');
    assert.deepEqual(gemini.passthroughFields, ['project_id', 'tier_id', 'client_id', 'email']);
    assert.equal(geminiOAuthRefreshAdapter(null), null);
  });

  it('normalizes keys and returns null for unknown providers', () => {
    assert.equal(normalizeProviderKey('codex_oauth'), 'openai-codex/codex-chatgpt/oauth');
    assert.equal(normalizeProviderKey('openai/codex-cli/oauth'), 'openai-codex/codex-chatgpt/oauth');
    assert.equal(normalizeProviderKey('openai-codex/codex-chatgpt/oauth'), 'openai-codex/codex-chatgpt/oauth');
    assert.equal(normalizeProviderKey('github_copilot'), null);
    assert.equal(normalizeProviderKey('not-a-provider'), null);
    assert.equal(resolveAdapter('not-a-provider'), null);
    assert.equal(resolveAdapter(''), null);
  });
});

describe('resolvePassthroughAdapter', () => {
  it('builds an adapter from account-carried binding fields', () => {
    const binding = resolvePassthroughAdapter({
      provider: 'github_copilot',
      clientId: 'cli-x',
      tokenEndpoint: 'https://github.example.test/token',
      refreshScope: 'repo read:user',
      userAgent: 'gh-cli/1.0',
    });
    assert.ok(binding !== null);
    assert.equal(binding.tokenEndpoint, 'https://github.example.test/token');
    assert.equal(binding.clientId, 'cli-x');
    assert.equal(binding.refreshScope, 'repo read:user');
    assert.equal(binding.userAgent, 'gh-cli/1.0');
    assert.deepEqual(binding.passthroughFields, []);
  });

  it('defaults github_copilot to the GitHub token endpoint and other providers to no endpoint', () => {
    const github = resolvePassthroughAdapter({ provider: 'github_copilot', clientId: 'cli-x' });
    assert.ok(github !== null);
    assert.equal(github.tokenEndpoint, 'https://github.com/login/oauth/access_token');
    assert.equal(github.userAgent, DEFAULT_OAUTH_REFRESH_USER_AGENT);
    assert.equal(github.refreshScope, null);

    assert.equal(resolvePassthroughAdapter({ provider: 'other_provider', clientId: 'cli-x' }), null);
  });

  it('requires a non-empty clientId', () => {
    assert.equal(resolvePassthroughAdapter({ provider: 'github_copilot' }), null);
    assert.equal(resolvePassthroughAdapter({ provider: 'github_copilot', clientId: '' }), null);
    assert.equal(resolvePassthroughAdapter({ provider: 'github_copilot', clientId: 42 }), null);
  });

  it('rejects non-https and non-canonical token endpoints', () => {
    const build = (tokenEndpoint: string): OAuthRefreshAdapter | null =>
      resolvePassthroughAdapter({ provider: 'github_copilot', clientId: 'cli-x', tokenEndpoint });
    assert.equal(build('http://github.example.test/token'), null);
    assert.equal(build('https://user:pass@github.example.test/token'), null);
    assert.equal(build('https://github.example.test/token?client_id=x'), null);
    assert.equal(build('https://github.example.test/token#frag'), null);
    // The stricter canonical check also rejects explicit ports and
    // non-canonical spellings the classic httpsUrl tolerated.
    assert.equal(build('https://github.example.test:8443/token'), null);
    assert.equal(build('https://github.example.test'), null);
  });

  it('treats an empty refreshScope as null (no scope parameter)', () => {
    const binding = resolvePassthroughAdapter({
      provider: 'github_copilot',
      clientId: 'cli-x',
      refreshScope: '',
      userAgent: '',
    });
    assert.ok(binding !== null);
    assert.equal(binding.refreshScope, null);
    assert.equal(binding.userAgent, DEFAULT_OAUTH_REFRESH_USER_AGENT);
  });
});
