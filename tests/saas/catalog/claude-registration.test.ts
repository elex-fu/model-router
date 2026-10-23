import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CREDENTIAL_TYPE,
  CLAUDE_DEFAULT_RIGHTS_ID,
  CLAUDE_DISPLAY_NAME,
  CLAUDE_ENDPOINT,
  CLAUDE_PLACEHOLDER_MODELS,
  CLAUDE_PLACEHOLDER_PRICING_VERSION,
  CLAUDE_PRODUCT_ID,
  CLAUDE_PROTOCOL,
  CLAUDE_PROVIDER_ID,
  CLAUDE_PURPOSE,
  CLAUDE_REGION,
  CLAUDE_SUPPLY_MODE,
  claudeCapabilityInputs,
  claudePlaceholderSupplierCostInputs,
  claudePlatformRightsInputs,
  claudeProviderProductInputs,
  registerClaudeProviderCatalog,
} from '../../../src/saas/catalog/claude-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-23T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'claude-r5-catalog-v1',
  reference: `${CLAUDE_PROVIDER_ID}-${CLAUDE_PRODUCT_ID}-preset`,
  sha256: 'b'.repeat(64),
} as const;

/** The GatewayProtocol spellings the production authority accepts as client protocols. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: CLAUDE_PROVIDER_ID,
    productId: CLAUDE_PRODUCT_ID,
    model: 'claude-sonnet-4-5-20250929',
    endpoint: CLAUDE_ENDPOINT,
    credentialType: CLAUDE_CREDENTIAL_TYPE,
    supplyMode: CLAUDE_SUPPLY_MODE,
    region: CLAUDE_REGION,
    purpose: CLAUDE_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ service: SaasCatalogService }> {
  const service = new SaasCatalogService(new FakeCatalogDatabase(), { now: () => NOW });
  await registerClaudeProviderCatalog(service, { sha256: EVIDENCE.sha256 });
  return { service };
}

test('identity constants declare the single OAuth platform subscription pool shape', () => {
  assert.equal(CLAUDE_PROVIDER_ID, 'anthropic-claude');
  assert.equal(CLAUDE_PRODUCT_ID, 'claude-subscription');
  assert.equal(CLAUDE_CREDENTIAL_TYPE, 'oauth');
  assert.equal(CLAUDE_SUPPLY_MODE, 'platform');
  assert.equal(CLAUDE_REGION, 'global');
  assert.equal(CLAUDE_PURPOSE, 'inference');
  assert.equal(CLAUDE_PROTOCOL, 'anthropic');
  assert.equal(CLAUDE_ENDPOINT, 'claude-messages');
  assert.ok(CLAUDE_DISPLAY_NAME.length > 0);
  // The placeholder catalog is the dated model set the OAuth upstream accepts.
  assert.deepEqual(
    [...CLAUDE_PLACEHOLDER_MODELS],
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001'],
  );
  assert.equal(CLAUDE_PLACEHOLDER_PRICING_VERSION, 1);
});

test('product inputs pin the single provider/product identity', () => {
  const inputs = claudeProviderProductInputs();
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], {
    providerId: CLAUDE_PROVIDER_ID,
    productId: CLAUDE_PRODUCT_ID,
    displayName: CLAUDE_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover the placeholder model catalog exactly once each', () => {
  const inputs = claudeCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, CLAUDE_PLACEHOLDER_MODELS.length);
  const models = inputs.map((input) => input.model);
  assert.deepEqual(models, [...CLAUDE_PLACEHOLDER_MODELS]);
  assert.equal(new Set(models).size, models.length, 'capability rows must not repeat a model');
  for (const input of inputs) {
    assert.equal(input.providerId, CLAUDE_PROVIDER_ID);
    assert.equal(input.productId, CLAUDE_PRODUCT_ID);
    assert.equal(input.endpoint, CLAUDE_ENDPOINT);
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

test('platform rights inputs cover the whole placeholder catalog under one endpoint scope', () => {
  const inputs = claudePlatformRightsInputs({
    rightsId: CLAUDE_DEFAULT_RIGHTS_ID,
    approvalReference: 'token-resale-plan-phase-r5',
    evidenceReference: `${CLAUDE_PROVIDER_ID}-${CLAUDE_PRODUCT_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(inputs.length, 1);
  const input = inputs[0];
  assert.equal(input.rightsId, CLAUDE_DEFAULT_RIGHTS_ID);
  assert.equal(input.providerId, CLAUDE_PROVIDER_ID);
  assert.equal(input.productId, CLAUDE_PRODUCT_ID);
  assert.equal(input.credentialType, CLAUDE_CREDENTIAL_TYPE);
  assert.equal(input.supplyMode, CLAUDE_SUPPLY_MODE);
  assert.equal(input.region, CLAUDE_REGION);
  assert.equal(input.purpose, CLAUDE_PURPOSE);
  assert.deepEqual(input.modelScope, [...CLAUDE_PLACEHOLDER_MODELS]);
  assert.deepEqual(input.endpointScope, [CLAUDE_ENDPOINT]);
  assert.equal(input.status, 'active');
  assert.equal(input.approvalReference, 'token-resale-plan-phase-r5');
});

test('registerClaudeProviderCatalog persists product, capabilities and active rights', async () => {
  const { service } = await setup();
  const allowed = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision === 'allow') {
    assert.equal(allowed.endpoint, CLAUDE_ENDPOINT);
    assert.equal(allowed.capability.protocol, 'anthropic');
    assert.equal(allowed.capability.validationState, 'verified');
    assert.equal(allowed.rights.rightsId, CLAUDE_DEFAULT_RIGHTS_ID);
    assert.equal(allowed.rights.status, 'active');
  }
});

test('every placeholder model is eligible on the capability row', async () => {
  const { service } = await setup();
  for (const model of CLAUDE_PLACEHOLDER_MODELS) {
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
  const wrongType = await service.checkProviderEligibility(eligibilityRequest({ credentialType: 'api-key' }));
  assert.equal(wrongType.decision, 'deny');
  if (wrongType.decision === 'deny') {
    assert.equal(wrongType.reason, 'rights_scope_mismatch');
  }
});

test('registerClaudeProviderCatalog calls the registrations in order', async () => {
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
  await registerClaudeProviderCatalog(catalog);
  assert.deepEqual(calls, ['product', 'capability', 'capability', 'capability', 'rights']);
});

test('placeholder supplier costs register explicit zero subscription rates under the anthropic protocol', () => {
  assert.equal(CLAUDE_PLACEHOLDER_PRICING_VERSION, 1);
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = claudePlaceholderSupplierCostInputs(audit, {
    publicModelIds: [
      { publicModelId: 'claude/claude-sonnet-4-5', publicModelVersion: 1 },
      { publicModelId: 'claude/claude-haiku-4-5', publicModelVersion: 1 },
    ],
  });
  assert.equal(inputs.length, 2);
  const idempotencyKeys = new Set<string>();
  for (const input of inputs) {
    assert.equal(input.protocol, 'anthropic');
    assert.equal(input.endpoint, CLAUDE_ENDPOINT);
    assert.equal(input.currency, 'USD');
    assert.deepEqual(input.rates, {
      input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_read: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      cache_write: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    });
    assert.ok(input.idempotencyKey.startsWith('anthropic-claude-supplier-cost-v1-'));
    idempotencyKeys.add(input.idempotencyKey);
  }
  assert.equal(idempotencyKeys.size, inputs.length, 'idempotency keys must be unique per public model');
  // No public models means no price rows.
  assert.equal(claudePlaceholderSupplierCostInputs(audit).length, 0);
});
