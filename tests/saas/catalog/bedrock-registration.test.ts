import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BEDROCK_CREDENTIAL_TYPE,
  BEDROCK_DEFAULT_RIGHTS_ID,
  BEDROCK_DISPLAY_NAME,
  BEDROCK_ENDPOINT,
  BEDROCK_PLACEHOLDER_MODELS,
  BEDROCK_PLACEHOLDER_PRICING_VERSION,
  BEDROCK_PRODUCT_ID,
  BEDROCK_PROTOCOL,
  BEDROCK_PROVIDER_ID,
  BEDROCK_PURPOSE,
  BEDROCK_REGION,
  BEDROCK_SUPPLY_MODE,
  bedrockCapabilityInputs,
  bedrockPlaceholderSupplierCostInputs,
  bedrockPlatformRightsInput,
  bedrockProviderProductInput,
  bedrockPublicModelAliasInputs,
  registerBedrockProviderCatalog,
} from '../../../src/saas/catalog/bedrock-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-17T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'bedrock-batch3-catalog-v1',
  reference: `${BEDROCK_PROVIDER_ID}-${BEDROCK_PRODUCT_ID}-preset`,
  sha256: 'a'.repeat(64),
} as const;

/** The GatewayProtocol spellings the production authority accepts as client protocols. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: BEDROCK_PROVIDER_ID,
    productId: BEDROCK_PRODUCT_ID,
    model: BEDROCK_PLACEHOLDER_MODELS[0],
    endpoint: BEDROCK_ENDPOINT,
    credentialType: BEDROCK_CREDENTIAL_TYPE,
    supplyMode: BEDROCK_SUPPLY_MODE,
    region: BEDROCK_REGION,
    purpose: BEDROCK_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ database: FakeCatalogDatabase; service: SaasCatalogService }> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await registerBedrockProviderCatalog(service, { sha256: EVIDENCE.sha256 });
  return { database, service };
}

test('identity constants declare the SigV4 platform pool shape', () => {
  assert.equal(BEDROCK_PROVIDER_ID, 'aws-bedrock');
  assert.equal(BEDROCK_PRODUCT_ID, 'bedrock-claude');
  assert.equal(BEDROCK_CREDENTIAL_TYPE, 'aws-sigv4');
  assert.equal(BEDROCK_SUPPLY_MODE, 'platform');
  assert.equal(BEDROCK_REGION, 'global');
  assert.equal(BEDROCK_PURPOSE, 'inference');
  assert.equal(BEDROCK_PROTOCOL, 'anthropic');
  assert.equal(BEDROCK_ENDPOINT, 'bedrock-invoke');
  assert.ok(BEDROCK_DISPLAY_NAME.length > 0);
});

test('product input pins the provider/product identity', () => {
  assert.deepEqual(bedrockProviderProductInput(), {
    providerId: BEDROCK_PROVIDER_ID,
    productId: BEDROCK_PRODUCT_ID,
    displayName: BEDROCK_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover the placeholder model catalog exactly once each', () => {
  const inputs = bedrockCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, BEDROCK_PLACEHOLDER_MODELS.length);
  const models = inputs.map((input) => input.model);
  assert.deepEqual(models, [...BEDROCK_PLACEHOLDER_MODELS]);
  assert.equal(new Set(models).size, models.length, 'capability rows must not repeat a model');
  for (const input of inputs) {
    assert.equal(input.providerId, BEDROCK_PROVIDER_ID);
    assert.equal(input.productId, BEDROCK_PRODUCT_ID);
    assert.equal(input.endpoint, BEDROCK_ENDPOINT);
    assert.equal(input.protocol, 'anthropic');
    assert.ok(
      GATEWAY_PROTOCOLS.has(input.protocol),
      `capability protocol ${input.protocol} for ${input.model} must be a GatewayProtocol`,
    );
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.equal(input.evidenceVersion, EVIDENCE.evidenceVersion);
    assert.equal(input.evidenceReference, EVIDENCE.reference);
    assert.equal(input.evidenceSha256, EVIDENCE.sha256);
  }
});

test('platform rights input covers the whole placeholder catalog under one endpoint scope', () => {
  const input = bedrockPlatformRightsInput({
    rightsId: BEDROCK_DEFAULT_RIGHTS_ID,
    approvalReference: 'capability-parity-batch-3',
    evidenceReference: `${BEDROCK_PROVIDER_ID}-${BEDROCK_PRODUCT_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(input.rightsId, BEDROCK_DEFAULT_RIGHTS_ID);
  assert.equal(input.credentialType, BEDROCK_CREDENTIAL_TYPE);
  assert.equal(input.supplyMode, BEDROCK_SUPPLY_MODE);
  assert.equal(input.region, BEDROCK_REGION);
  assert.equal(input.purpose, BEDROCK_PURPOSE);
  assert.deepEqual(input.modelScope, [...BEDROCK_PLACEHOLDER_MODELS]);
  assert.deepEqual(input.endpointScope, [BEDROCK_ENDPOINT]);
  assert.equal(input.status, 'active');
  assert.equal(input.approvalReference, 'capability-parity-batch-3');
});

test('registerBedrockProviderCatalog persists product, capabilities and active rights', async () => {
  const { service } = await setup();
  const allowed = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision === 'allow') {
    assert.equal(allowed.endpoint, BEDROCK_ENDPOINT);
    assert.equal(allowed.capability.protocol, 'anthropic');
    assert.equal(allowed.capability.validationState, 'verified');
    assert.equal(allowed.rights.rightsId, BEDROCK_DEFAULT_RIGHTS_ID);
    assert.equal(allowed.rights.status, 'active');
  }
});

test('every placeholder model is eligible on the capability row', async () => {
  const { service } = await setup();
  for (const model of BEDROCK_PLACEHOLDER_MODELS) {
    const result = await service.checkProviderEligibility(eligibilityRequest({ model }));
    assert.equal(result.decision, 'allow', `model ${model} must be eligible, got ${JSON.stringify(result)}`);
    if (result.decision === 'allow') {
      assert.equal(result.capability.protocol, 'anthropic', `model ${model} capability protocol`);
      assert.equal(result.capability.validationState, 'verified');
    }
  }
});

test('an unknown model or a wrong credential type is denied', async () => {
  const { service } = await setup();
  const denied = await service.checkProviderEligibility(eligibilityRequest({ model: 'not-a-catalog-model' }));
  assert.equal(denied.decision, 'deny');
  if (denied.decision === 'deny') {
    assert.equal(denied.reason, 'capability_missing');
  }
  const wrongType = await service.checkProviderEligibility(eligibilityRequest({ credentialType: 'oauth' }));
  assert.equal(wrongType.decision, 'deny');
  if (wrongType.decision === 'deny') {
    assert.equal(wrongType.reason, 'rights_scope_mismatch');
  }
});

test('registerBedrockProviderCatalog calls the registrations in order', async () => {
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
  await registerBedrockProviderCatalog(catalog);
  assert.deepEqual(calls, [
    'product',
    ...Array.from({ length: BEDROCK_PLACEHOLDER_MODELS.length }, () => 'capability'),
    'rights',
  ]);
});

test('placeholder supplier costs register explicit zero rates under the anthropic protocol', () => {
  assert.equal(BEDROCK_PLACEHOLDER_PRICING_VERSION, 1);
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = bedrockPlaceholderSupplierCostInputs(audit, {
    publicModelIds: [{ publicModelId: 'bedrock/us.anthropic.claude-sonnet-4-5-v1:0', publicModelVersion: 1 }],
  });
  assert.equal(inputs.length, 1);
  const input = inputs[0];
  assert.equal(input.protocol, 'anthropic');
  assert.equal(input.endpoint, BEDROCK_ENDPOINT);
  assert.deepEqual(input.rates, {
    input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    cache_read: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    cache_write: { numeratorMinorUnits: 0, denominatorUnits: 1 },
  });
});

test('public model aliases namespace every catalog model under bedrock/', () => {
  const inputs = bedrockPublicModelAliasInputs();
  assert.equal(inputs.length, BEDROCK_PLACEHOLDER_MODELS.length);
  for (const input of inputs) {
    assert.ok(input.alias.startsWith('bedrock/'));
    assert.equal(input.providerId, BEDROCK_PROVIDER_ID);
    assert.equal(input.productId, BEDROCK_PRODUCT_ID);
    assert.deepEqual(input.endpointScope, [BEDROCK_ENDPOINT]);
    assert.equal(input.status, 'active');
    // The alias target is the bare catalog id (normalizeBedrockModelAlias
    // strips the prefix at dispatch).
    assert.ok(BEDROCK_PLACEHOLDER_MODELS.includes(input.model));
  }
});
