import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import {
  registerVertexProviderCatalog,
  VERTEX_ANTHROPIC_MODELS,
  VERTEX_ANTHROPIC_PROTOCOL,
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_DEFAULT_RIGHTS_ID,
  VERTEX_DISPLAY_NAME,
  VERTEX_ENDPOINT,
  VERTEX_GEMINI_MODELS,
  VERTEX_GEMINI_PROTOCOL,
  VERTEX_PLACEHOLDER_MODELS,
  VERTEX_PLACEHOLDER_PRICING_VERSION,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
  VERTEX_PURPOSE,
  VERTEX_REGION,
  VERTEX_SUPPLY_MODE,
  vertexCapabilityInputs,
  vertexPlaceholderSupplierCostInputs,
  vertexPlatformRightsInput,
  vertexProtocolForModel,
  vertexProviderProductInput,
  vertexPublicModelAliasInputs,
} from '../../../src/saas/catalog/vertex-registration.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-16T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'vertex-b3-catalog-v1',
  reference: `${VERTEX_PROVIDER_ID}-${VERTEX_PRODUCT_ID}-preset`,
  sha256: 'a'.repeat(64),
} as const;

/** The GatewayProtocol spellings the production authority accepts. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: VERTEX_PROVIDER_ID,
    productId: VERTEX_PRODUCT_ID,
    model: 'claude-opus-4-5',
    endpoint: VERTEX_ENDPOINT,
    credentialType: VERTEX_CREDENTIAL_TYPE,
    supplyMode: VERTEX_SUPPLY_MODE,
    region: VERTEX_REGION,
    purpose: VERTEX_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ database: FakeCatalogDatabase; service: SaasCatalogService }> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await registerVertexProviderCatalog(service, { sha256: EVIDENCE.sha256 });
  return { database, service };
}

test('identity constants declare the service-account platform pool shape', () => {
  assert.equal(VERTEX_PROVIDER_ID, 'google-vertex');
  assert.equal(VERTEX_PRODUCT_ID, 'vertex-ai');
  assert.equal(VERTEX_CREDENTIAL_TYPE, 'service_account');
  assert.equal(VERTEX_SUPPLY_MODE, 'platform');
  assert.equal(VERTEX_REGION, 'global');
  assert.equal(VERTEX_PURPOSE, 'inference');
  assert.equal(VERTEX_ANTHROPIC_PROTOCOL, 'anthropic');
  assert.equal(VERTEX_GEMINI_PROTOCOL, 'gemini');
  assert.equal(VERTEX_ENDPOINT, 'vertex-raw-predict');
  assert.ok(VERTEX_DISPLAY_NAME.length > 0);
});

test('product input pins the provider/product identity', () => {
  assert.deepEqual(vertexProviderProductInput(), {
    providerId: VERTEX_PROVIDER_ID,
    productId: VERTEX_PRODUCT_ID,
    displayName: VERTEX_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover both protocol families under one endpoint scope', () => {
  const inputs = vertexCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, VERTEX_PLACEHOLDER_MODELS.length);
  const models = inputs.map((input) => input.model);
  assert.equal(new Set(models).size, models.length, 'capability rows must not repeat a model');
  for (const input of inputs) {
    assert.equal(input.providerId, VERTEX_PROVIDER_ID);
    assert.equal(input.productId, VERTEX_PRODUCT_ID);
    assert.equal(input.endpoint, VERTEX_ENDPOINT);
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.ok(GATEWAY_PROTOCOLS.has(input.protocol));
  }
  const byModel = new Map(inputs.map((input) => [input.model, input.protocol]));
  for (const model of VERTEX_ANTHROPIC_MODELS) {
    assert.equal(byModel.get(model), 'anthropic', `${model} rides the anthropic protocol`);
  }
  for (const model of VERTEX_GEMINI_MODELS) {
    assert.equal(byModel.get(model), 'gemini', `${model} rides the gemini protocol`);
  }
});

test('platform rights input binds the credential triple and the single endpoint scope', () => {
  const rights = vertexPlatformRightsInput({
    rightsId: 'vertex-rights-2',
    approvalReference: 'approval-1',
    evidenceReference: 'ref-1',
    sha256: 'b'.repeat(64),
    effectiveAt: NOW.toISOString(),
  });
  assert.deepEqual(rights, {
    rightsId: 'vertex-rights-2',
    providerId: VERTEX_PROVIDER_ID,
    productId: VERTEX_PRODUCT_ID,
    credentialType: VERTEX_CREDENTIAL_TYPE,
    supplyMode: VERTEX_SUPPLY_MODE,
    region: VERTEX_REGION,
    purpose: VERTEX_PURPOSE,
    modelScope: [...VERTEX_PLACEHOLDER_MODELS],
    endpointScope: [VERTEX_ENDPOINT],
    effectiveAt: NOW.toISOString(),
    status: 'active',
    approvalReference: 'approval-1',
    evidenceReference: 'ref-1',
    evidenceSha256: 'b'.repeat(64),
  });
  assert.equal(VERTEX_DEFAULT_RIGHTS_ID, 'vertex-ai-platform-service-account-v1');
});

test('registerVertexProviderCatalog calls the registrations in order, one capability per model', async () => {
  const calls: string[] = [];
  const catalog = {
    async registerProviderProduct() {
      calls.push('product');
    },
    async registerProviderCapability() {
      calls.push('capability');
    },
    async registerProviderRightsVersion() {
      calls.push('rights');
    },
  };
  await registerVertexProviderCatalog(catalog);
  assert.deepEqual(calls, [
    'product',
    ...Array.from({ length: VERTEX_PLACEHOLDER_MODELS.length }, () => 'capability'),
    'rights',
  ]);
});

test('both protocol families resolve and a wrong triple fails closed', async () => {
  const { service } = await setup();
  const anthropicFamily = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(anthropicFamily.decision, 'allow');
  const geminiFamily = await service.checkProviderEligibility(eligibilityRequest({ model: 'gemini-2.5-pro' }));
  assert.equal(geminiFamily.decision, 'allow');
  const unknownModel = await service.checkProviderEligibility(eligibilityRequest({ model: 'not-a-catalog-model' }));
  assert.equal(unknownModel.decision, 'deny');
  if (unknownModel.decision === 'deny') {
    assert.equal(unknownModel.reason, 'capability_missing');
  }
  const wrongCredentialType = await service.checkProviderEligibility(eligibilityRequest({ credentialType: 'oauth' }));
  assert.equal(wrongCredentialType.decision, 'deny');
  if (wrongCredentialType.decision === 'deny') {
    assert.equal(wrongCredentialType.reason, 'rights_scope_mismatch');
  }
  const wrongEndpoint = await service.checkProviderEligibility(
    eligibilityRequest({ endpoint: 'vertex-generate-content' }),
  );
  assert.equal(wrongEndpoint.decision, 'deny');
});

test('placeholder supplier costs register zero rates with the per-family protocol', () => {
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = vertexPlaceholderSupplierCostInputs(audit, {
    publicModelIds: [
      { publicModelId: 'claude-opus-4-5', publicModelVersion: 1 },
      { publicModelId: 'gemini-2.5-flash', publicModelVersion: 1 },
    ],
  });
  assert.equal(inputs.length, 2);
  assert.equal(VERTEX_PLACEHOLDER_PRICING_VERSION, 1);
  for (const input of inputs) {
    assert.equal(input.endpoint, VERTEX_ENDPOINT);
    assert.equal(input.rates.input.numeratorMinorUnits, 0);
    assert.equal(input.rates.output.numeratorMinorUnits, 0);
    assert.equal(
      input.protocol,
      input.publicModelId.startsWith('claude-') ? VERTEX_ANTHROPIC_PROTOCOL : VERTEX_GEMINI_PROTOCOL,
    );
  }
  assert.equal(vertexProtocolForModel('claude-sonnet-4-5'), 'anthropic');
  assert.equal(vertexProtocolForModel('gemini-2.5-pro'), 'gemini');
});

test('public model aliases use the vertex/ namespace over the single endpoint scope', () => {
  const inputs = vertexPublicModelAliasInputs();
  assert.equal(inputs.length, VERTEX_PLACEHOLDER_MODELS.length);
  for (const input of inputs) {
    assert.equal(input.alias, `vertex/${input.model}`);
    assert.equal(input.providerId, VERTEX_PROVIDER_ID);
    assert.equal(input.productId, VERTEX_PRODUCT_ID);
    assert.deepEqual(input.endpointScope, [VERTEX_ENDPOINT]);
    assert.equal(input.status, 'active');
  }
});
