import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MINIMAX_ENDPOINT,
  MINIMAX_PRODUCT_ID,
  MINIMAX_PROVIDER_ID,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_CODING_PRODUCT_ID,
  ZHIPU_ENDPOINT,
  ZHIPU_PRODUCT_ID,
  ZHIPU_PROVIDER_ID,
} from '../../../../src/saas/gateway/cn-providers/catalog-identity.js';
import {
  CN_PROVIDER_TARGET_BINDINGS,
  cnProviderDefaultBase,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL_INTL,
  MINIMAX_CHAT_BASE_URL,
  MINIMAX_CHAT_BASE_URL_INTL,
  MINIMAX_MODELS_URL,
  MINIMAX_QUOTA_URL,
  MINIMAX_QUOTA_URL_INTL,
  ZHIPU_ANTHROPIC_BASE_URL,
  ZHIPU_ANTHROPIC_BASE_URL_INTL,
  ZHIPU_CODING_CHAT_BASE_URL,
  ZHIPU_CODING_CHAT_BASE_URL_INTL,
  ZHIPU_CODING_MODELS_URL,
  ZHIPU_PAYG_CHAT_BASE_URL,
  ZHIPU_PAYG_CHAT_BASE_URL_INTL,
  ZHIPU_PAYG_MODELS_URL,
  ZHIPU_QUOTA_URL,
  ZHIPU_QUOTA_URL_INTL,
} from '../../../../src/saas/gateway/cn-providers/constants.js';

test('the default endpoint table mirrors the sub2api constants verbatim', () => {
  assert.equal(ZHIPU_PAYG_CHAT_BASE_URL, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(ZHIPU_CODING_CHAT_BASE_URL, 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(ZHIPU_ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(MINIMAX_CHAT_BASE_URL, 'https://api.minimaxi.com/v1');
  assert.equal(MINIMAX_ANTHROPIC_BASE_URL, 'https://api.minimaxi.com/anthropic');
  // International mirrors (api.z.ai / api.minimax.io).
  assert.equal(ZHIPU_PAYG_CHAT_BASE_URL_INTL, 'https://api.z.ai/api/paas/v4');
  assert.equal(ZHIPU_CODING_CHAT_BASE_URL_INTL, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(ZHIPU_ANTHROPIC_BASE_URL_INTL, 'https://api.z.ai/api/anthropic');
  assert.equal(MINIMAX_CHAT_BASE_URL_INTL, 'https://api.minimax.io/v1');
  assert.equal(MINIMAX_ANTHROPIC_BASE_URL_INTL, 'https://api.minimax.io/anthropic');
});

test('cnProviderDefaultBase resolves provider × mode × protocol × region', () => {
  const cases: readonly {
    readonly name: string;
    readonly input: Parameters<typeof cnProviderDefaultBase>[0];
    readonly expected: string | null;
  }[] = [
    {
      name: 'zhipu payg chat',
      input: { providerId: ZHIPU_PROVIDER_ID, accountMode: 'payg', protocol: 'openai' },
      expected: ZHIPU_PAYG_CHAT_BASE_URL,
    },
    {
      name: 'zhipu coding chat',
      input: { providerId: ZHIPU_PROVIDER_ID, accountMode: 'coding', protocol: 'openai' },
      expected: ZHIPU_CODING_CHAT_BASE_URL,
    },
    {
      name: 'zhipu anthropic base is mode-independent',
      input: { providerId: ZHIPU_PROVIDER_ID, accountMode: 'coding', protocol: 'anthropic' },
      expected: ZHIPU_ANTHROPIC_BASE_URL,
    },
    {
      name: 'zhipu has no native responses: chat base fallback',
      input: { providerId: ZHIPU_PROVIDER_ID, accountMode: 'payg', protocol: 'responses' },
      expected: ZHIPU_PAYG_CHAT_BASE_URL,
    },
    {
      name: 'zhipu coding intl',
      input: { providerId: ZHIPU_PROVIDER_ID, accountMode: 'coding', protocol: 'openai', international: true },
      expected: ZHIPU_CODING_CHAT_BASE_URL_INTL,
    },
    {
      name: 'minimax chat is mode-independent',
      input: { providerId: MINIMAX_PROVIDER_ID, accountMode: 'coding', protocol: 'openai' },
      expected: MINIMAX_CHAT_BASE_URL,
    },
    {
      name: 'minimax responses shares the chat base',
      input: { providerId: MINIMAX_PROVIDER_ID, accountMode: 'payg', protocol: 'responses' },
      expected: MINIMAX_CHAT_BASE_URL,
    },
    {
      name: 'minimax anthropic',
      input: { providerId: MINIMAX_PROVIDER_ID, accountMode: 'payg', protocol: 'anthropic' },
      expected: MINIMAX_ANTHROPIC_BASE_URL,
    },
    {
      name: 'minimax intl',
      input: { providerId: MINIMAX_PROVIDER_ID, accountMode: 'payg', protocol: 'anthropic', international: true },
      expected: MINIMAX_ANTHROPIC_BASE_URL_INTL,
    },
    {
      name: 'unknown provider fails closed',
      input: { providerId: 'someone-else', accountMode: 'payg', protocol: 'openai' },
      expected: null,
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.equal(cnProviderDefaultBase(input), expected, name);
  }
});

test('adaptive api_base_urls overrides win over the default table', () => {
  assert.equal(
    cnProviderDefaultBase({
      providerId: ZHIPU_PROVIDER_ID,
      accountMode: 'coding',
      protocol: 'openai',
      overrides: { openai: ' https://proxy.example.test/v1 ' },
    }),
    'https://proxy.example.test/v1',
  );
  // An override for a different protocol never leaks.
  assert.equal(
    cnProviderDefaultBase({
      providerId: ZHIPU_PROVIDER_ID,
      accountMode: 'coding',
      protocol: 'anthropic',
      overrides: { openai: 'https://proxy.example.test/v1' },
    }),
    ZHIPU_ANTHROPIC_BASE_URL,
  );
});

test('the provider-target binding set covers every product × native protocol pair on domestic hosts', () => {
  const keys = CN_PROVIDER_TARGET_BINDINGS.map(
    (binding) => `${binding.upstreamId}:${binding.productId}:${binding.protocol}:${binding.operation}`,
  );
  assert.deepEqual(keys, [
    'zhipu:zhipu-glm:openai:chat.completions',
    'zhipu:zhipu-glm:anthropic:messages',
    'zhipu:zhipu-glm-coding:openai:chat.completions',
    'zhipu:zhipu-glm-coding:anthropic:messages',
    'minimax:minimax-m:openai:chat.completions',
    'minimax:minimax-m:anthropic:messages',
    'minimax:minimax-m:responses:responses',
  ]);
  for (const binding of CN_PROVIDER_TARGET_BINDINGS) {
    assert.equal(binding.method, 'POST');
    assert.equal(binding.allowedHosts.length, 1);
    assert.equal(binding.allowedPorts.length, 1);
    assert.equal(binding.allowedPorts[0], 443);
  }
  assert.equal(ZHIPU_ENDPOINT, 'zhipu-glm');
  assert.equal(ZHIPU_CODING_ENDPOINT, 'zhipu-glm-coding');
  assert.equal(MINIMAX_ENDPOINT, 'minimax-m');
  assert.equal(ZHIPU_PRODUCT_ID, 'zhipu-glm');
  assert.equal(ZHIPU_CODING_PRODUCT_ID, 'zhipu-glm-coding');
  assert.equal(MINIMAX_PRODUCT_ID, 'minimax-m');
});

test('credential-validation and quota probe endpoints derive from the table', () => {
  assert.equal(ZHIPU_PAYG_MODELS_URL, 'https://open.bigmodel.cn/api/paas/v4/models');
  assert.equal(ZHIPU_CODING_MODELS_URL, 'https://open.bigmodel.cn/api/coding/paas/v4/models');
  assert.equal(MINIMAX_MODELS_URL, 'https://api.minimaxi.com/v1/models');
  assert.equal(ZHIPU_QUOTA_URL, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(ZHIPU_QUOTA_URL_INTL, 'https://api.z.ai/api/monitor/usage/quota/limit');
  assert.equal(MINIMAX_QUOTA_URL, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains');
  assert.equal(MINIMAX_QUOTA_URL_INTL, 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains');
});
