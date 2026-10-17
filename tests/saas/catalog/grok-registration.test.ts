import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROK_API_KEY_PRODUCT_ID,
  GROK_CREDENTIAL_TYPE_API_KEY,
  GROK_CREDENTIAL_TYPE_OAUTH,
  GROK_DEFAULT_API_KEY_RIGHTS_ID,
  GROK_DEFAULT_OAUTH_RIGHTS_ID,
  GROK_DISPLAY_NAME,
  GROK_ENDPOINT,
  GROK_OAUTH_PRODUCT_ID,
  GROK_PLACEHOLDER_MODELS,
  GROK_PLACEHOLDER_PRICING_VERSION,
  GROK_PROTOCOL,
  GROK_PROVIDER_ID,
  GROK_PURPOSE,
  GROK_REGION,
  GROK_SUPPLY_MODE,
  grokCapabilityInputs,
  grokPlaceholderSupplierCostInputs,
  grokPlatformRightsInputs,
  grokProviderProductInputs,
  grokPublicModelAliasInputs,
  registerGrokProviderCatalog,
} from '../../../src/saas/catalog/grok-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-17T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'grok-b3-catalog-v1',
  reference: `${GROK_PROVIDER_ID}-preset`,
  sha256: 'b'.repeat(64),
} as const;

/** The GatewayProtocol spellings the production authority accepts as client protocols. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: GROK_PROVIDER_ID,
    productId: GROK_OAUTH_PRODUCT_ID,
    model: 'grok-4.6',
    endpoint: GROK_ENDPOINT,
    credentialType: GROK_CREDENTIAL_TYPE_OAUTH,
    supplyMode: GROK_SUPPLY_MODE,
    region: GROK_REGION,
    purpose: GROK_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ service: SaasCatalogService }> {
  const service = new SaasCatalogService(new FakeCatalogDatabase(), { now: () => NOW });
  await registerGrokProviderCatalog(service, { sha256: EVIDENCE.sha256 });
  return { service };
}

test('identity constants declare the two-product OAuth + api-key pool shape', () => {
  assert.equal(GROK_PROVIDER_ID, 'xai-grok');
  assert.equal(GROK_OAUTH_PRODUCT_ID, 'grok-subscription');
  assert.equal(GROK_API_KEY_PRODUCT_ID, 'grok-api');
  assert.equal(GROK_CREDENTIAL_TYPE_OAUTH, 'oauth');
  assert.equal(GROK_CREDENTIAL_TYPE_API_KEY, 'api-key');
  assert.equal(GROK_SUPPLY_MODE, 'platform');
  assert.equal(GROK_REGION, 'global');
  assert.equal(GROK_PURPOSE, 'inference');
  assert.equal(GROK_PROTOCOL, 'responses');
  assert.equal(GROK_ENDPOINT, 'grok-responses');
  assert.ok(GROK_DISPLAY_NAME.length > 0);
  // The capability boundary: no media family rides the placeholder catalog.
  assert.ok(GROK_PLACEHOLDER_MODELS.every((model) => !model.includes('imagine')));
  assert.equal(GROK_PLACEHOLDER_PRICING_VERSION, 1);
});

test('product inputs pin both provider/product identities', () => {
  const inputs = grokProviderProductInputs();
  assert.equal(inputs.length, 2);
  assert.deepEqual(
    inputs.map((input) => input.productId).sort(),
    [GROK_API_KEY_PRODUCT_ID, GROK_OAUTH_PRODUCT_ID].sort(),
  );
  for (const input of inputs) {
    assert.equal(input.providerId, GROK_PROVIDER_ID);
    assert.equal(input.status, 'active');
  }
});

test('capability inputs cover the placeholder catalog for BOTH products', () => {
  const inputs = grokCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, GROK_PLACEHOLDER_MODELS.length * 2);
  for (const input of inputs) {
    assert.equal(input.providerId, GROK_PROVIDER_ID);
    assert.equal(input.endpoint, GROK_ENDPOINT);
    assert.equal(input.protocol, 'responses');
    assert.ok(
      GATEWAY_PROTOCOLS.has(input.protocol),
      `capability protocol ${input.protocol} for ${input.model} must be a GatewayProtocol`,
    );
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.equal(input.evidenceVersion, EVIDENCE.evidenceVersion);
    assert.equal(input.evidenceSha256, EVIDENCE.sha256);
  }
  // Each product gets every model exactly once.
  for (const productId of [GROK_OAUTH_PRODUCT_ID, GROK_API_KEY_PRODUCT_ID]) {
    const models = inputs.filter((input) => input.productId === productId).map((input) => input.model);
    assert.deepEqual(models, [...GROK_PLACEHOLDER_MODELS]);
  }
});

test('platform rights inputs cover both credential-type bindings under one endpoint scope', () => {
  const inputs = grokPlatformRightsInputs({
    approvalReference: 'capability-parity-batch-3',
    evidenceReference: `${GROK_PROVIDER_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal(input.providerId, GROK_PROVIDER_ID);
    assert.equal(input.supplyMode, GROK_SUPPLY_MODE);
    assert.equal(input.region, GROK_REGION);
    assert.equal(input.purpose, GROK_PURPOSE);
    assert.deepEqual(input.modelScope, [...GROK_PLACEHOLDER_MODELS]);
    assert.deepEqual(input.endpointScope, [GROK_ENDPOINT]);
    assert.equal(input.status, 'active');
  }
  const oauth = inputs.find((input) => input.rightsId === GROK_DEFAULT_OAUTH_RIGHTS_ID);
  assert.equal(oauth?.productId, GROK_OAUTH_PRODUCT_ID);
  assert.equal(oauth?.credentialType, GROK_CREDENTIAL_TYPE_OAUTH);
  const apiKey = inputs.find((input) => input.rightsId === GROK_DEFAULT_API_KEY_RIGHTS_ID);
  assert.equal(apiKey?.productId, GROK_API_KEY_PRODUCT_ID);
  assert.equal(apiKey?.credentialType, GROK_CREDENTIAL_TYPE_API_KEY);
});

test('registerGrokProviderCatalog persists both products and grants eligibility on each', async () => {
  const { service } = await setup();
  const oauth = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(oauth.decision, 'allow');
  if (oauth.decision === 'allow') {
    assert.equal(oauth.endpoint, GROK_ENDPOINT);
    assert.equal(oauth.capability.protocol, 'responses');
    assert.equal(oauth.capability.validationState, 'verified');
    assert.equal(oauth.rights.rightsId, GROK_DEFAULT_OAUTH_RIGHTS_ID);
    assert.equal(oauth.rights.status, 'active');
  }
  const apiKey = await service.checkProviderEligibility(
    eligibilityRequest({ productId: GROK_API_KEY_PRODUCT_ID, credentialType: GROK_CREDENTIAL_TYPE_API_KEY }),
  );
  assert.equal(apiKey.decision, 'allow');
  if (apiKey.decision === 'allow') {
    assert.equal(apiKey.rights.rightsId, GROK_DEFAULT_API_KEY_RIGHTS_ID);
  }
});

test('an unknown model or a mismatched credential type is denied', async () => {
  const { service } = await setup();
  const denied = await service.checkProviderEligibility(eligibilityRequest({ model: 'grok-imagine-video' }));
  assert.equal(denied.decision, 'deny');
  const wrongType = await service.checkProviderEligibility(
    eligibilityRequest({ productId: GROK_OAUTH_PRODUCT_ID, credentialType: GROK_CREDENTIAL_TYPE_API_KEY }),
  );
  assert.equal(wrongType.decision, 'deny');
});

test('public aliases namespace every placeholder model under grok/', () => {
  const aliases = grokPublicModelAliasInputs();
  assert.equal(aliases.length, GROK_PLACEHOLDER_MODELS.length);
  for (const alias of aliases) {
    assert.equal(alias.providerId, GROK_PROVIDER_ID);
    assert.equal(alias.productId, GROK_OAUTH_PRODUCT_ID);
    assert.deepEqual(alias.endpointScope, [GROK_ENDPOINT]);
    assert.ok(alias.alias.startsWith('grok/'));
  }
});

test('placeholder supplier costs register zero-rate token pricing under the responses scope', () => {
  const inputs = grokPlaceholderSupplierCostInputs({ actorUserId: 'ops-1' } as never, {
    publicModelIds: [{ publicModelId: 'grok/grok-4.6', publicModelVersion: 1 }],
  });
  assert.equal(inputs.length, 1);
  const input = inputs[0];
  assert.equal(input.protocol, 'responses');
  assert.equal(input.endpoint, GROK_ENDPOINT);
  assert.equal(input.rates.input.numeratorMinorUnits, 0);
  assert.equal(input.rates.output.numeratorMinorUnits, 0);
});
