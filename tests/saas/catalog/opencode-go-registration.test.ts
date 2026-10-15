import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DEFAULT_RIGHTS_ID,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_FALLBACK_MODEL_IDS,
  OPENCODE_GO_PLACEHOLDER_PRICING_PROTOCOL,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PURPOSE,
  OPENCODE_GO_REGION,
  OPENCODE_GO_SUPPLY_MODE,
  OPENCODE_GO_TEST_MODEL,
  opencodeGoCapabilityInputs,
  opencodeGoCapabilityProtocolForModel,
  opencodeGoPlaceholderSupplierCostInputs,
  opencodeGoPlatformRightsInput,
  opencodeGoProviderProductInput,
  opencodeGoPublicModelAliasInputs,
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

/** The GatewayProtocol spellings the production authority accepts as client protocols. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

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
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.equal(input.evidenceVersion, EVIDENCE.evidenceVersion);
    assert.equal(input.evidenceReference, EVIDENCE.reference);
    assert.equal(input.evidenceSha256, EVIDENCE.sha256);
  }
});

test('R5b-4 capability protocols are rule-resolved GatewayProtocols the authority can match', () => {
  // The exact alignment the production authority adapter checks:
  // `eligibility.capability.protocol !== input.protocol` where input.protocol
  // is the client protocol (a GatewayProtocol). Every registered capability
  // protocol must therefore be a GatewayProtocol equal to the model's
  // rule-resolved native protocol.
  const inputs = opencodeGoCapabilityInputs(EVIDENCE);
  for (const input of inputs) {
    assert.ok(
      GATEWAY_PROTOCOLS.has(input.protocol),
      `capability protocol ${input.protocol} for ${input.model} must be a GatewayProtocol`,
    );
    assert.equal(input.protocol, opencodeGoCapabilityProtocolForModel(input.model));
  }
  // Spot-check the three native protocols across the default rule table.
  assert.equal(opencodeGoCapabilityProtocolForModel('glm-5.3'), 'openai');
  assert.equal(opencodeGoCapabilityProtocolForModel('grok-4.7'), 'responses');
  assert.equal(opencodeGoCapabilityProtocolForModel('minimax-m3'), 'anthropic');
  // The supply-validation vocabulary must never leak onto a catalog row.
  for (const input of inputs) {
    assert.notEqual(input.protocol, 'openai-compatible');
    assert.notEqual(input.protocol, 'anthropic-compatible');
  }
});

test('capability protocols follow a configured rule table', () => {
  const rules = [{ pattern: 'glm-*', protocol: 'anthropic' }] as const;
  const inputs = opencodeGoCapabilityInputs(EVIDENCE, rules);
  const glm = inputs.find((input) => input.model === 'glm-5.3');
  assert.equal(glm?.protocol, 'anthropic');
  // Unmatched models keep the Chat Completions fallback under the same table.
  const kimi = inputs.find((input) => input.model === 'kimi-k3');
  assert.equal(kimi?.protocol, 'openai');
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
    // glm-5.3 routes to Chat Completions under the default rule table, so an
    // openai-protocol client passes the authority's protocol equality check.
    assert.equal(allowed.capability.protocol, 'openai');
    assert.equal(allowed.capability.validationState, 'verified');
    assert.equal(allowed.rights.rightsId, OPENCODE_GO_DEFAULT_RIGHTS_ID);
    assert.equal(allowed.rights.status, 'active');
  }
});

test('every fallback model is eligible with its rule-resolved protocol on the capability row', async () => {
  const { service } = await setup();
  for (const model of OPENCODE_GO_FALLBACK_MODEL_IDS) {
    const result = await service.checkProviderEligibility(eligibilityRequest({ model }));
    assert.equal(result.decision, 'allow', `model ${model} must be eligible, got ${JSON.stringify(result)}`);
    if (result.decision === 'allow') {
      assert.equal(
        result.capability.protocol,
        opencodeGoCapabilityProtocolForModel(model),
        `model ${model} capability protocol must equal its routed protocol`,
      );
    }
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
    assert.equal(input.protocol, OPENCODE_GO_PLACEHOLDER_PRICING_PROTOCOL);
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

test('placeholder supplier costs carry the backing model capability protocol when supplied', () => {
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = opencodeGoPlaceholderSupplierCostInputs(audit, {
    publicModelIds: [
      // grok-4.7 is Responses-routed: its price row must resolve under the
      // 'responses' capability protocol the pricing join keys on.
      { publicModelId: 'opencode-go/grok-4.7', publicModelVersion: 1, protocol: 'responses' as const },
      { publicModelId: 'opencode-go/minimax-m3', publicModelVersion: 1, protocol: 'anthropic' as const },
    ],
  });
  assert.equal(inputs[0]?.protocol, 'responses');
  assert.equal(inputs[1]?.protocol, 'anthropic');
});

test('public model alias inputs map namespaced aliases onto provider models', () => {
  const inputs = opencodeGoPublicModelAliasInputs(['glm-5.3', 'GROK-4.7', 'opencode-go/kimi-k3', '']);
  assert.deepEqual(
    inputs.map((input) => input.alias),
    ['opencode-go/glm-5.3', 'opencode-go/grok-4.7', 'opencode-go/kimi-k3'],
  );
  for (const input of inputs) {
    assert.equal(input.providerId, OPENCODE_GO_PROVIDER_ID);
    assert.equal(input.productId, OPENCODE_GO_PRODUCT_ID);
    assert.deepEqual(input.endpointScope, [OPENCODE_GO_ENDPOINT]);
    assert.equal(input.status, 'active');
    // The alias prefix is exactly what normalizeOpenCodeGoModelId strips, so
    // modelMap resolution and rule matching agree on the provider model id.
    assert.ok(input.model.length > 0);
    assert.ok(input.alias.endsWith(input.model));
  }
  // Default: one alias per built-in fallback model, deduplicated and normalized.
  const fallbackInputs = opencodeGoPublicModelAliasInputs();
  assert.equal(fallbackInputs.length, OPENCODE_GO_FALLBACK_MODEL_IDS.length);
  assert.deepEqual(
    fallbackInputs.map((input) => input.model),
    [...OPENCODE_GO_FALLBACK_MODEL_IDS],
  );
});
