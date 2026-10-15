import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DEFAULT_RIGHTS_ID,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_FALLBACK_MODEL_IDS,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROTOCOL,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PURPOSE,
  OPENCODE_GO_REGION,
  OPENCODE_GO_SUPPLY_MODE,
  OPENCODE_GO_TEST_MODEL,
  opencodeGoCapabilityInputs,
  opencodeGoPlaceholderSupplierCostInputs,
  opencodeGoPlatformRightsInput,
  opencodeGoProviderProductInput,
  registerOpencodeGoProviderCatalog,
} from '../../../src/saas/catalog/opencode-go-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-15T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'opencode-go-r5b-catalog-v1',
  reference: `${OPENCODE_GO_PROVIDER_ID}-${OPENCODE_GO_PRODUCT_ID}-preset`,
  sha256: 'a'.repeat(64),
} as const;

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    model: OPENCODE_GO_TEST_MODEL,
    endpoint: OPENCODE_GO_ENDPOINT,
    credentialType: OPENCODE_GO_CREDENTIAL_TYPE,
    supplyMode: OPENCODE_GO_SUPPLY_MODE,
    region: OPENCODE_GO_REGION,
    purpose: OPENCODE_GO_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ database: FakeCatalogDatabase; service: SaasCatalogService }> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await registerOpencodeGoProviderCatalog(service);
  return { database, service };
}

test('identity constants declare the API-key platform pool shape', () => {
  assert.equal(OPENCODE_GO_PROVIDER_ID, 'opencode-go');
  assert.equal(OPENCODE_GO_PRODUCT_ID, 'opencode-go-zen');
  assert.equal(OPENCODE_GO_CREDENTIAL_TYPE, 'api-key');
  assert.equal(OPENCODE_GO_SUPPLY_MODE, 'platform');
  assert.equal(OPENCODE_GO_REGION, 'global');
  assert.equal(OPENCODE_GO_PURPOSE, 'inference');
  assert.equal(OPENCODE_GO_ENDPOINT, 'opencode-go-zen');
  assert.equal(OPENCODE_GO_PROTOCOL, 'openai-compatible');
  assert.ok(OPENCODE_GO_DISPLAY_NAME.length > 0);
});

test('product input pins the provider/product identity', () => {
  assert.deepEqual(opencodeGoProviderProductInput(), {
    providerId: OPENCODE_GO_PROVIDER_ID,
    productId: OPENCODE_GO_PRODUCT_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover the fallback model catalog exactly once each', () => {
  const inputs = opencodeGoCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, OPENCODE_GO_FALLBACK_MODEL_IDS.length);
  const models = inputs.map((input) => input.model);
  assert.deepEqual(models, [...OPENCODE_GO_FALLBACK_MODEL_IDS]);
  assert.equal(new Set(models).size, models.length, 'capability rows must not repeat a model');
  for (const input of inputs) {
    assert.equal(input.providerId, OPENCODE_GO_PROVIDER_ID);
    assert.equal(input.productId, OPENCODE_GO_PRODUCT_ID);
    assert.equal(input.endpoint, OPENCODE_GO_ENDPOINT);
    assert.equal(input.protocol, OPENCODE_GO_PROTOCOL);
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.equal(input.evidenceVersion, EVIDENCE.evidenceVersion);
    assert.equal(input.evidenceReference, EVIDENCE.reference);
    assert.equal(input.evidenceSha256, EVIDENCE.sha256);
  }
});

test('platform rights input covers the whole fallback catalog under one endpoint scope', () => {
  const input = opencodeGoPlatformRightsInput({
    rightsId: OPENCODE_GO_DEFAULT_RIGHTS_ID,
    approvalReference: 'token-resale-plan-phase-r5b',
    evidenceReference: `${OPENCODE_GO_PROVIDER_ID}-${OPENCODE_GO_PRODUCT_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(input.providerId, OPENCODE_GO_PROVIDER_ID);
  assert.equal(input.productId, OPENCODE_GO_PRODUCT_ID);
  assert.equal(input.credentialType, OPENCODE_GO_CREDENTIAL_TYPE);
  assert.equal(input.supplyMode, OPENCODE_GO_SUPPLY_MODE);
  assert.equal(input.region, OPENCODE_GO_REGION);
  assert.equal(input.purpose, OPENCODE_GO_PURPOSE);
  assert.deepEqual(input.modelScope, [...OPENCODE_GO_FALLBACK_MODEL_IDS]);
  assert.deepEqual(input.endpointScope, [OPENCODE_GO_ENDPOINT]);
  assert.equal(input.status, 'active');
  assert.equal(input.approvalReference, 'token-resale-plan-phase-r5b');
});

test('registerOpencodeGoProviderCatalog persists product, capabilities and active rights', async () => {
  const { service } = await setup();
  const allowed = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision === 'allow') {
    assert.equal(allowed.endpoint, OPENCODE_GO_ENDPOINT);
    assert.equal(allowed.capability.protocol, OPENCODE_GO_PROTOCOL);
    assert.equal(allowed.capability.validationState, 'verified');
    assert.equal(allowed.rights.rightsId, OPENCODE_GO_DEFAULT_RIGHTS_ID);
    assert.equal(allowed.rights.status, 'active');
  }
});

test('every fallback model is eligible after registration', async () => {
  const { service } = await setup();
  for (const model of OPENCODE_GO_FALLBACK_MODEL_IDS) {
    const result = await service.checkProviderEligibility(eligibilityRequest({ model }));
    assert.equal(result.decision, 'allow', `model ${model} must be eligible, got ${JSON.stringify(result)}`);
  }
});

test('an unknown model is denied with capability_missing', async () => {
  const { service } = await setup();
  const denied = await service.checkProviderEligibility(eligibilityRequest({ model: 'not-a-catalog-model' }));
  assert.equal(denied.decision, 'deny');
  if (denied.decision === 'deny') {
    assert.equal(denied.reason, 'capability_missing');
  }
});

test('a wrong credential type is denied with rights scope mismatch semantics', async () => {
  const { service } = await setup();
  const denied = await service.checkProviderEligibility(eligibilityRequest({ credentialType: 'oauth' }));
  assert.equal(denied.decision, 'deny');
  if (denied.decision === 'deny') {
    assert.equal(denied.reason, 'rights_scope_mismatch');
  }
});

test('placeholder supplier costs register explicit zero subscription rates', () => {
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = opencodeGoPlaceholderSupplierCostInputs(audit, {
    publicModelIds: [
      { publicModelId: 'opencode-go/glm-5.3', publicModelVersion: 1 },
      { publicModelId: 'opencode-go/kimi-k3', publicModelVersion: 1 },
    ],
  });
  assert.equal(inputs.length, 2);
  const idempotencyKeys = new Set<string>();
  for (const input of inputs) {
    assert.equal(input.protocol, OPENCODE_GO_PROTOCOL);
    assert.equal(input.endpoint, OPENCODE_GO_ENDPOINT);
    assert.equal(input.currency, 'USD');
    assert.deepEqual(input.rates, {
      input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_read: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_write: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    });
    idempotencyKeys.add(input.idempotencyKey);
  }
  assert.equal(idempotencyKeys.size, inputs.length, 'idempotency keys must be unique per public model');
});
