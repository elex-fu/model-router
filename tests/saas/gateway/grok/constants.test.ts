import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyGrokCliProxyHeaders,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_PROXY_HOST,
  GROK_CLI_STABLE_VERSION,
  GROK_CLI_TOKEN_AUTH_VALUE,
  GROK_CLIENT_IDENTIFIER,
  grokCliIdentityHeaders,
  grokCliUserAgent,
  isGrokOfficialHost,
  resolveGrokCliVersion,
} from '../../../../src/saas/gateway/grok/constants.js';

test('CLI identity header matrix: stamped only for the CLI proxy host', () => {
  const base = { authorization: 'Bearer t', 'content-type': 'application/json' };
  // cli-chat-proxy.grok.com → all four identity headers stamped.
  const stamped = applyGrokCliProxyHeaders(base, GROK_CLI_PROXY_HOST);
  assert.equal(stamped['x-xai-token-auth'], GROK_CLI_TOKEN_AUTH_VALUE);
  assert.equal(stamped['x-grok-client-version'], GROK_CLI_CLIENT_VERSION);
  assert.equal(stamped['x-grok-client-identifier'], GROK_CLIENT_IDENTIFIER);
  assert.equal(stamped['user-agent'], grokCliUserAgent(GROK_CLI_CLIENT_VERSION));
  assert.equal(stamped['user-agent'], `xai-grok-workspace/${GROK_CLI_CLIENT_VERSION}`);
  // Case-insensitive host match.
  assert.equal(
    applyGrokCliProxyHeaders(base, 'CLI-Chat-Proxy.Grok.COM')['x-xai-token-auth'],
    GROK_CLI_TOKEN_AUTH_VALUE,
  );
  // Official api.x.ai family → NO CLI headers (it rejects them on OAuth traffic).
  for (const host of ['api.x.ai', 'us-east-1.api.x.ai', 'eu-west-1.api.x.ai']) {
    const untouched = applyGrokCliProxyHeaders(base, host);
    assert.equal(untouched['x-xai-token-auth'], undefined, host);
    assert.equal(untouched['x-grok-client-version'], undefined, host);
    assert.equal(untouched['x-grok-client-identifier'], undefined, host);
    assert.ok(untouched['user-agent'] === undefined, host);
  }
  // Unknown hosts are also left untouched (the masquerade is proxy-specific).
  const foreign = applyGrokCliProxyHeaders(base, 'evil.example.com');
  assert.equal(foreign['x-xai-token-auth'], undefined);
});

test('grokCliIdentityHeaders returns the pinned quad; the version pins are the sub2api values', () => {
  const headers = grokCliIdentityHeaders();
  assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(headers['x-grok-client-version'], '0.2.120');
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
  assert.equal(headers['user-agent'], 'xai-grok-workspace/0.2.120');
  assert.equal(GROK_CLI_STABLE_VERSION, '0.2.93');
});

test('resolveGrokCliVersion honors operator overrides only at or above the stable floor', () => {
  const previous = process.env.MODEL_ROUTER_GROK_CLI_VERSION;
  try {
    process.env.MODEL_ROUTER_GROK_CLI_VERSION = '0.2.200';
    assert.equal(resolveGrokCliVersion(), '0.2.200');
    process.env.MODEL_ROUTER_GROK_CLI_VERSION = '0.1.0';
    assert.equal(resolveGrokCliVersion(), GROK_CLI_CLIENT_VERSION);
    process.env.MODEL_ROUTER_GROK_CLI_VERSION = 'not-semver';
    assert.equal(resolveGrokCliVersion(), GROK_CLI_CLIENT_VERSION);
    delete process.env.MODEL_ROUTER_GROK_CLI_VERSION;
    assert.equal(resolveGrokCliVersion(), GROK_CLI_CLIENT_VERSION);
  } finally {
    if (previous === undefined) {
      delete process.env.MODEL_ROUTER_GROK_CLI_VERSION;
    } else {
      process.env.MODEL_ROUTER_GROK_CLI_VERSION = previous;
    }
  }
});

test('official host family: api.x.ai, *.api.x.ai and the CLI proxy; nothing else', () => {
  assert.ok(isGrokOfficialHost('api.x.ai'));
  assert.ok(isGrokOfficialHost('API.X.AI'));
  assert.ok(isGrokOfficialHost('us-east-1.api.x.ai'));
  assert.ok(isGrokOfficialHost('cli-chat-proxy.grok.com'));
  assert.ok(!isGrokOfficialHost('evil.api.x.ai.evil.com'));
  assert.ok(!isGrokOfficialHost('x.ai'));
  assert.ok(!isGrokOfficialHost('auth.x.ai'));
  assert.ok(!isGrokOfficialHost('api.x.ai.evil.com'));
  assert.ok(!isGrokOfficialHost('grok.com'));
});
