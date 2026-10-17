import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CN_PROVIDER_CAPABILITY_PROTOCOLS,
  MINIMAX_DEFAULT_RIGHTS_ID,
  MINIMAX_ENDPOINT,
  MINIMAX_FALLBACK_MODEL_IDS,
  MINIMAX_PRODUCT_ID,
  MINIMAX_PROVIDER_ID,
  ZHIPU_CODING_DEFAULT_RIGHTS_ID,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_CODING_PRODUCT_ID,
  ZHIPU_DEFAULT_RIGHTS_ID,
  ZHIPU_ENDPOINT,
  ZHIPU_FALLBACK_MODEL_IDS,
  ZHIPU_PRODUCT_ID,
  ZHIPU_PROVIDER_ID,
  cnProviderProductInputs,
  cnProvidersPublicModelAliasInputs,
  minimaxCapabilityInputs,
  registerCnProvidersCatalog,
  zhipuCapabilityInputs,
  zhipuCodingCapabilityInputs,
  zhipuCodingPlatformRightsInput,
  zhipuPlatformRightsInput,
  minimaxPlatformRightsInput,
} from '../../../src/saas/catalog/cn-providers-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import { FakeCatalogDatabase } from './fake-database.js';

const EVIDENCE = {
  evidenceVersion: 'cn-providers-batch3-catalog-v1',
  reference: 'cn-providers-batch3-preset',
  sha256: 'a'.repeat(64),
} as const;

test('the three products carry the identity contract', () => {
  const products = cnProviderProductInputs();
  assert.deepEqual(
    products.map((product) => [product.providerId, product.productId, product.status]),
    [
      [ZHIPU_PROVIDER_ID, ZHIPU_PRODUCT_ID, 'active'],
      [ZHIPU_PROVIDER_ID, ZHIPU_CODING_PRODUCT_ID, 'active'],
      [MINIMAX_PROVIDER_ID, MINIMAX_PRODUCT_ID, 'active'],
    ],
  );
  assert.equal(ZHIPU_ENDPOINT, 'zhipu-glm');
  assert.equal(ZHIPU_CODING_ENDPOINT, 'zhipu-glm-coding');
  assert.equal(MINIMAX_ENDPOINT, 'minimax-m');
});

test('capabilities register every model under BOTH native protocols per product', () => {
  assert.deepEqual(CN_PROVIDER_CAPABILITY_PROTOCOLS, ['openai', 'anthropic']);

  const zhipu = zhipuCapabilityInputs(EVIDENCE);
  assert.equal(zhipu.length, ZHIPU_FALLBACK_MODEL_IDS.length * 2);
  for (const capability of zhipu) {
    assert.equal(capability.providerId, ZHIPU_PROVIDER_ID);
    assert.equal(capability.productId, ZHIPU_PRODUCT_ID);
    assert.equal(capability.endpoint, ZHIPU_ENDPOINT);
    assert.ok(CN_PROVIDER_CAPABILITY_PROTOCOLS.includes(capability.protocol as 'openai'));
  }

  const coding = zhipuCodingCapabilityInputs(EVIDENCE);
  assert.equal(coding.length, zhipu.length);
  for (const capability of coding) {
    assert.equal(capability.productId, ZHIPU_CODING_PRODUCT_ID);
    assert.equal(capability.endpoint, ZHIPU_CODING_ENDPOINT);
  }

  const minimax = minimaxCapabilityInputs(EVIDENCE);
  assert.equal(minimax.length, MINIMAX_FALLBACK_MODEL_IDS.length * 2);
  for (const capability of minimax) {
    assert.equal(capability.providerId, MINIMAX_PROVIDER_ID);
    assert.equal(capability.productId, MINIMAX_PRODUCT_ID);
    assert.equal(capability.endpoint, MINIMAX_ENDPOINT);
  }
  // The MiniMax M-series ids keep their upstream spelling (the API is
  // case-sensitive; the thinking-table prefix match lowercases internally).
  assert.ok(MINIMAX_FALLBACK_MODEL_IDS.includes('MiniMax-M2'));
});

test('rights inputs bind the api-key credential type under each endpoint scope', () => {
  const zhipu = zhipuPlatformRightsInput({
    rightsId: 'test-zhipu',
    approvalReference: 'test',
    evidenceReference: 'test',
    sha256: 'a'.repeat(64),
    effectiveAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(zhipu.providerId, ZHIPU_PROVIDER_ID);
  assert.equal(zhipu.credentialType, 'api-key');
  assert.deepEqual(zhipu.endpointScope, [ZHIPU_ENDPOINT]);
  assert.deepEqual(zhipu.modelScope, [...ZHIPU_FALLBACK_MODEL_IDS]);

  const coding = zhipuCodingPlatformRightsInput({
    rightsId: 'test-zhipu-coding',
    approvalReference: 'test',
    evidenceReference: 'test',
    sha256: 'a'.repeat(64),
    effectiveAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(coding.productId, ZHIPU_CODING_PRODUCT_ID);
  assert.deepEqual(coding.endpointScope, [ZHIPU_CODING_ENDPOINT]);

  const minimax = minimaxPlatformRightsInput({
    rightsId: 'test-minimax',
    approvalReference: 'test',
    evidenceReference: 'test',
    sha256: 'a'.repeat(64),
    effectiveAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(minimax.providerId, MINIMAX_PROVIDER_ID);
  assert.deepEqual(minimax.endpointScope, [MINIMAX_ENDPOINT]);

  assert.equal(ZHIPU_DEFAULT_RIGHTS_ID, 'zhipu-glm-platform-api-key-v1');
  assert.equal(ZHIPU_CODING_DEFAULT_RIGHTS_ID, 'zhipu-glm-coding-platform-api-key-v1');
  assert.equal(MINIMAX_DEFAULT_RIGHTS_ID, 'minimax-m-platform-api-key-v1');
});

test('registerCnProvidersCatalog is a one-call applier (capabilities/rights version-idempotent)', async () => {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database);
  await registerCnProvidersCatalog(service);
  const expected =
    ZHIPU_FALLBACK_MODEL_IDS.length * 2 + ZHIPU_FALLBACK_MODEL_IDS.length * 2 + MINIMAX_FALLBACK_MODEL_IDS.length * 2;
  assert.equal(database.state.capabilities.length, expected);
  assert.equal(database.state.products.length, 3);
  // The three rights versions registered under their default ids.
  assert.deepEqual(
    database.state.rights.map((row) => (row as { rights_id: string }).rights_id).sort(),
    [MINIMAX_DEFAULT_RIGHTS_ID, ZHIPU_CODING_DEFAULT_RIGHTS_ID, ZHIPU_DEFAULT_RIGHTS_ID].sort(),
  );
});

test('public model aliases namespace per product', () => {
  const aliases = cnProvidersPublicModelAliasInputs({
    zhipuModels: ['glm-5.3'],
    minimaxModels: ['MiniMax-M2'],
  });
  assert.deepEqual(
    aliases.map((alias) => [alias.alias, alias.providerId, alias.productId, alias.endpointScope]),
    [
      ['zhipu/glm-5.3', ZHIPU_PROVIDER_ID, ZHIPU_PRODUCT_ID, [ZHIPU_ENDPOINT]],
      ['zhipu-coding/glm-5.3', ZHIPU_PROVIDER_ID, ZHIPU_CODING_PRODUCT_ID, [ZHIPU_CODING_ENDPOINT]],
      ['minimax/MiniMax-M2', MINIMAX_PROVIDER_ID, MINIMAX_PRODUCT_ID, [MINIMAX_ENDPOINT]],
    ],
  );
});
