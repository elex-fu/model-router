import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type UpstreamConfig } from '../../src/config/types.js';

test('DEFAULT_CONFIG.server.port is 15005', () => {
  assert.equal(DEFAULT_CONFIG.server.port, 15005);
});

test('UpstreamConfig accepts optional modelMap', () => {
  const upstream: UpstreamConfig = {
    name: 'kimi',
    provider: 'moonshot',
    protocol: 'anthropic',
    baseUrl: 'https://api.moonshot.cn',
    apiKey: 'sk-x',
    models: ['claude-sonnet-4-20250514'],
    enabled: true,
    modelMap: { 'claude-*': 'kimi-k2-turbo' },
  };
  assert.equal(upstream.modelMap?.['claude-*'], 'kimi-k2-turbo');
});

test('UpstreamConfig modelMap is optional', () => {
  const upstream: UpstreamConfig = {
    name: 'kimi',
    provider: 'moonshot',
    protocol: 'anthropic',
    baseUrl: 'https://api.moonshot.cn',
    apiKey: 'sk-x',
    models: [],
    enabled: true,
  };
  assert.equal(upstream.modelMap, undefined);
});
