import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubDeviceFlow, OpenAIDeviceFlow } from '../../src/server/oauth-device.js';

describe('GitHubDeviceFlow', () => {
  it('stores clientId and domain', () => {
    const flow = new GitHubDeviceFlow('Iv1.xxx');
    assert.equal(flow['clientId'], 'Iv1.xxx');
    assert.equal(flow['domain'], 'github.com');
  });
});

describe('OpenAIDeviceFlow', () => {
  it('uses default Codex client id', () => {
    const flow = new OpenAIDeviceFlow();
    assert.equal(flow['clientId'], 'app_EMoamEEZ73f0CkXaXp7hrann');
  });

  it('allows custom client id', () => {
    const flow = new OpenAIDeviceFlow('custom-id');
    assert.equal(flow['clientId'], 'custom-id');
  });
});
