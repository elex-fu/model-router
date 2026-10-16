import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_CREDENTIAL_TYPE,
  GEMINI_DEFAULT_RIGHTS_ID,
  GEMINI_DISPLAY_NAME,
  GEMINI_ENDPOINT,
  GEMINI_PLACEHOLDER_MODELS,
  GEMINI_PLACEHOLDER_PRICING_VERSION,
  GEMINI_PRODUCT_ID,
  GEMINI_PROTOCOL,
  GEMINI_PROVIDER_ID,
  GEMINI_PURPOSE,
  GEMINI_REGION,
  GEMINI_SUPPLY_MODE,
  geminiCapabilityInputs,
  geminiPlaceholderSupplierCostInputs,
  geminiPlatformRightsInput,
  geminiProviderProductInput,
  geminiPublicModelAliasInputs,
  registerGeminiProviderCatalog,
} from '../../../src/saas/catalog/gemini-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-15T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'gemini-f4-catalog-v1',
  reference: `${GEMINI_PROVIDER_ID}-${GEMINI_PRODUCT_ID}-preset`,
  sha256: 'a'.repeat(64),
} as const;

/** The GatewayProtocol spellings the production authority accepts as client protocols. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: GEMINI_PROVIDER_ID,
    productId: GEMINI_PRODUCT_ID,
    model: 'gemini-2.5-pro',
    endpoint: GEMINI_ENDPOINT,
    credentialType: GEMINI_CREDENTIAL_TYPE,
    supplyMode: GEMINI_SUPPLY_MODE,
    region: GEMINI_REGION,
    purpose: GEMINI_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ database: FakeCatalogDatabase; service: SaasCatalogService }> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  // The registration default sha256 ('g'.repeat(64)) is not hex, so the
  // catalog's evidence-hash validation rejects it; pass a valid digest.
  await registerGeminiProviderCatalog(service, { sha256: EVIDENCE.sha256 });
  return { database, service };
}

test('identity constants declare the OAuth platform subscription pool shape', () => {
  assert.equal(GEMINI_PROVIDER_ID, 'google-gemini');
  assert.equal(GEMINI_PRODUCT_ID, 'gemini-subscription');
  assert.equal(GEMINI_CREDENTIAL_TYPE, 'oauth');
  assert.equal(GEMINI_SUPPLY_MODE, 'platform');
  assert.equal(GEMINI_REGION, 'global');
  assert.equal(GEMINI_PURPOSE, 'inference');
  assert.equal(GEMINI_PROTOCOL, 'gemini');
  assert.equal(GEMINI_ENDPOINT, 'gemini-generate-content');
  assert.ok(GEMINI_DISPLAY_NAME.length > 0);
});

test('product input pins the provider/product identity', () => {
  assert.deepEqual(geminiProviderProductInput(), {
    providerId: GEMINI_PROVIDER_ID,
    productId: GEMINI_PRODUCT_ID,
    displayName: GEMINI_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover the placeholder model catalog exactly once each', () => {
  const inputs = geminiCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, GEMINI_PLACEHOLDER_MODELS.length);
  assert.equal(GEMINI_PLACEHOLDER_MODELS.length, 4);
  const models = inputs.map((input) => input.model);
  assert.deepEqual(models, [...GEMINI_PLACEHOLDER_MODELS]);
  assert.equal(new Set(models).size, models.length, 'capability rows must not repeat a model');
  for (const input of inputs) {
    assert.equal(input.providerId, GEMINI_PROVIDER_ID);
    assert.equal(input.productId, GEMINI_PRODUCT_ID);
    assert.equal(input.endpoint, GEMINI_ENDPOINT);
    assert.equal(input.protocol, 'gemini');
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
  const input = geminiPlatformRightsInput({
    rightsId: GEMINI_DEFAULT_RIGHTS_ID,
    approvalReference: 'token-resale-plan-phase-f4',
    evidenceReference: `${GEMINI_PROVIDER_ID}-${GEMINI_PRODUCT_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(input.rightsId, GEMINI_DEFAULT_RIGHTS_ID);
  assert.equal(input.providerId, GEMINI_PROVIDER_ID);
  assert.equal(input.productId, GEMINI_PRODUCT_ID);
  assert.equal(input.credentialType, GEMINI_CREDENTIAL_TYPE);
  assert.equal(input.supplyMode, GEMINI_SUPPLY_MODE);
  assert.equal(input.region, GEMINI_REGION);
  assert.equal(input.purpose, GEMINI_PURPOSE);
  assert.deepEqual(input.modelScope, [...GEMINI_PLACEHOLDER_MODELS]);
  assert.deepEqual(input.endpointScope, [GEMINI_ENDPOINT]);
  assert.equal(input.status, 'active');
  assert.equal(input.approvalReference, 'token-resale-plan-phase-f4');
});

test('registerGeminiProviderCatalog persists product, capabilities and active rights', async () => {
  const { service } = await setup();
  const allowed = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision === 'allow') {
    assert.equal(allowed.endpoint, GEMINI_ENDPOINT);
    assert.equal(allowed.capability.protocol, 'gemini');
    assert.equal(allowed.capability.validationState, 'verified');
    assert.equal(allowed.rights.rightsId, GEMINI_DEFAULT_RIGHTS_ID);
    assert.equal(allowed.rights.status, 'active');
  }
});

test('every placeholder model is eligible on the capability row', async () => {
  const { service } = await setup();
  for (const model of GEMINI_PLACEHOLDER_MODELS) {
    const result = await service.checkProviderEligibility(eligibilityRequest({ model }));
    assert.equal(result.decision, 'allow', `model ${model} must be eligible, got ${JSON.stringify(result)}`);
    if (result.decision === 'allow') {
      assert.equal(result.capability.protocol, 'gemini', `model ${model} capability protocol`);
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
  const wrongType = await service.checkProviderEligibility(eligibilityRequest({ credentialType: 'api-key' }));
  assert.equal(wrongType.decision, 'deny');
  if (wrongType.decision === 'deny') {
    assert.equal(wrongType.reason, 'rights_scope_mismatch');
  }
});

test('registerGeminiProviderCatalog calls the three registrations in order', async () => {
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
  await registerGeminiProviderCatalog(catalog);
  assert.deepEqual(calls, ['product', 'capability', 'capability', 'capability', 'capability', 'rights']);
});

test('placeholder supplier costs register explicit zero subscription rates under the gemini protocol', () => {
  assert.equal(GEMINI_PLACEHOLDER_PRICING_VERSION, 1);
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = geminiPlaceholderSupplierCostInputs(audit, {
    publicModelIds: [
      { publicModelId: 'gemini/gemini-2.5-pro', publicModelVersion: 1 },
      { publicModelId: 'gemini/gemini-2.5-flash', publicModelVersion: 1 },
    ],
  });
  assert.equal(inputs.length, 2);
  const idempotencyKeys = new Set<string>();
  for (const input of inputs) {
    assert.equal(input.protocol, 'gemini');
    assert.equal(input.endpoint, GEMINI_ENDPOINT);
    assert.equal(input.currency, 'USD');
    assert.deepEqual(input.rates, {
      input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_read: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_write: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    });
    assert.ok(input.idempotencyKey.startsWith('google-gemini-supplier-cost-v1-'));
    idempotencyKeys.add(input.idempotencyKey);
  }
  assert.equal(idempotencyKeys.size, inputs.length, 'idempotency keys must be unique per public model');
  // No public models means no price rows.
  assert.equal(geminiPlaceholderSupplierCostInputs(audit).length, 0);
});

test('public model alias inputs map namespaced gemini/ aliases onto provider models', () => {
  const inputs = geminiPublicModelAliasInputs([
    'gemini-2.5-pro',
    'models/gemini-2.5-flash',
    'gemini-3-pro',
    'gemini-2.5-pro',
    '',
  ]);
  assert.deepEqual(
    inputs.map((input) => input.alias),
    ['gemini/gemini-2.5-pro', 'gemini/gemini-2.5-flash', 'gemini/gemini-3-pro-preview'],
  );
  for (const input of inputs) {
    assert.equal(input.providerId, GEMINI_PROVIDER_ID);
    assert.equal(input.productId, GEMINI_PRODUCT_ID);
    assert.deepEqual(input.endpointScope, [GEMINI_ENDPOINT]);
    assert.equal(input.status, 'active');
    assert.ok(input.model.length > 0);
    assert.ok(input.alias.endsWith(input.model));
    assert.match(input.displayName, /^Gemini /);
  }
  // Default: one alias per placeholder model, deduplicated and normalized.
  const defaults = geminiPublicModelAliasInputs();
  assert.equal(defaults.length, GEMINI_PLACEHOLDER_MODELS.length);
  assert.deepEqual(
    defaults.map((input) => input.model),
    [...GEMINI_PLACEHOLDER_MODELS],
  );
  assert.deepEqual(
    defaults.map((input) => input.alias),
    GEMINI_PLACEHOLDER_MODELS.map((model) => `gemini/${model}`),
  );
});
