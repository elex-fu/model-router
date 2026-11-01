import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_CREDENTIAL_TYPE,
  CODEX_CREDENTIAL_TYPE_PAT,
  CODEX_DEFAULT_PAT_RIGHTS_ID,
  CODEX_DEFAULT_RIGHTS_ID,
  CODEX_DISPLAY_NAME,
  CODEX_ENDPOINT,
  CODEX_PLACEHOLDER_MODELS,
  CODEX_PLACEHOLDER_PRICING_VERSION,
  CODEX_PRODUCT_ID,
  CODEX_PROTOCOL,
  CODEX_PROVIDER_ID,
  CODEX_PURPOSE,
  CODEX_REGION,
  CODEX_SUPPLY_MODE,
  codexCapabilityInputs,
  codexPlaceholderSupplierCostInputs,
  codexPlatformPatRightsInput,
  codexPlatformRightsInput,
  codexProviderProductInput,
  registerCodexProviderCatalog,
} from '../../../src/saas/catalog/codex-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-30T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'codex-p1c-catalog-v1',
  reference: `${CODEX_PROVIDER_ID}-${CODEX_PRODUCT_ID}-preset`,
  sha256: 'c'.repeat(64),
} as const;

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    model: 'gpt-5.3-codex',
    endpoint: CODEX_ENDPOINT,
    credentialType: CODEX_CREDENTIAL_TYPE,
    supplyMode: CODEX_SUPPLY_MODE,
    region: CODEX_REGION,
    purpose: CODEX_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ service: SaasCatalogService }> {
  const service = new SaasCatalogService(new FakeCatalogDatabase(), { now: () => NOW });
  await registerCodexProviderCatalog(service, { sha256: EVIDENCE.sha256 });
  return { service };
}

test('identity constants declare the codex binding, now with both credential types', () => {
  assert.equal(CODEX_PROVIDER_ID, 'openai-codex');
  assert.equal(CODEX_PRODUCT_ID, 'codex-chatgpt');
  assert.equal(CODEX_CREDENTIAL_TYPE, 'oauth');
  assert.equal(CODEX_CREDENTIAL_TYPE_PAT, 'pat');
  assert.equal(CODEX_SUPPLY_MODE, 'platform');
  assert.equal(CODEX_REGION, 'global');
  assert.equal(CODEX_PURPOSE, 'inference');
  assert.equal(CODEX_PROTOCOL, 'responses');
  assert.equal(CODEX_ENDPOINT, 'codex-responses');
  assert.ok(CODEX_DISPLAY_NAME.length > 0);
  assert.deepEqual([...CODEX_PLACEHOLDER_MODELS], ['gpt-5.3-codex', 'gpt-5.3-codex-mini']);
  assert.equal(CODEX_PLACEHOLDER_PRICING_VERSION, 1);
});

test('product input pins the single provider/product identity', () => {
  const input = codexProviderProductInput();
  assert.deepEqual(input, {
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    displayName: CODEX_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover the placeholder model catalog exactly once each', () => {
  const inputs = codexCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, CODEX_PLACEHOLDER_MODELS.length);
  const models = inputs.map((input) => input.model);
  assert.deepEqual(models, [...CODEX_PLACEHOLDER_MODELS]);
  assert.equal(new Set(models).size, models.length, 'capability rows must not repeat a model');
  for (const input of inputs) {
    assert.equal(input.providerId, CODEX_PROVIDER_ID);
    assert.equal(input.productId, CODEX_PRODUCT_ID);
    assert.equal(input.endpoint, CODEX_ENDPOINT);
    assert.equal(input.protocol, 'responses');
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.equal(input.evidenceVersion, EVIDENCE.evidenceVersion);
    assert.equal(input.evidenceReference, EVIDENCE.reference);
    assert.equal(input.evidenceSha256, EVIDENCE.sha256);
  }
});

test('the OAuth rights triple keeps its P1c identity', () => {
  const input = codexPlatformRightsInput({
    rightsId: CODEX_DEFAULT_RIGHTS_ID,
    approvalReference: 'sub2api-parity-plan-phase-1',
    evidenceReference: `${CODEX_PROVIDER_ID}-${CODEX_PRODUCT_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(input.rightsId, CODEX_DEFAULT_RIGHTS_ID);
  assert.equal(input.providerId, CODEX_PROVIDER_ID);
  assert.equal(input.productId, CODEX_PRODUCT_ID);
  assert.equal(input.credentialType, CODEX_CREDENTIAL_TYPE);
  assert.equal(input.supplyMode, CODEX_SUPPLY_MODE);
  assert.equal(input.region, CODEX_REGION);
  assert.equal(input.purpose, CODEX_PURPOSE);
  assert.deepEqual(input.modelScope, [...CODEX_PLACEHOLDER_MODELS]);
  assert.deepEqual(input.endpointScope, [CODEX_ENDPOINT]);
  assert.equal(input.status, 'active');
});

test('the P2c PAT rights triple registers pat as a second binding, not a widening of oauth', () => {
  const input = codexPlatformPatRightsInput({
    rightsId: CODEX_DEFAULT_PAT_RIGHTS_ID,
    approvalReference: 'sub2api-parity-plan-phase-2c',
    evidenceReference: `${CODEX_PROVIDER_ID}-${CODEX_PRODUCT_ID}-pat-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(input.rightsId, CODEX_DEFAULT_PAT_RIGHTS_ID);
  assert.notEqual(input.rightsId, CODEX_DEFAULT_RIGHTS_ID, 'the PAT triple has its own rights identity');
  assert.equal(input.providerId, CODEX_PROVIDER_ID);
  assert.equal(input.productId, CODEX_PRODUCT_ID);
  assert.equal(input.credentialType, CODEX_CREDENTIAL_TYPE_PAT);
  assert.equal(input.supplyMode, CODEX_SUPPLY_MODE);
  assert.equal(input.region, CODEX_REGION);
  assert.equal(input.purpose, CODEX_PURPOSE);
  // Same dispatch surface: the PAT triple scopes the identical models and endpoint.
  assert.deepEqual(input.modelScope, [...CODEX_PLACEHOLDER_MODELS]);
  assert.deepEqual(input.endpointScope, [CODEX_ENDPOINT]);
  assert.equal(input.status, 'active');
});

test('registerCodexProviderCatalog makes both credential types eligible on the same surface', async () => {
  const { service } = await setup();
  for (const credentialType of [CODEX_CREDENTIAL_TYPE, CODEX_CREDENTIAL_TYPE_PAT]) {
    const allowed = await service.checkProviderEligibility(eligibilityRequest({ credentialType }));
    assert.equal(allowed.decision, 'allow', `credential type ${credentialType} must be eligible`);
    if (allowed.decision === 'allow') {
      assert.equal(allowed.endpoint, CODEX_ENDPOINT);
      assert.equal(allowed.capability.protocol, 'responses');
      assert.equal(allowed.capability.validationState, 'verified');
      assert.equal(allowed.rights.status, 'active');
      assert.equal(
        allowed.rights.rightsId,
        credentialType === CODEX_CREDENTIAL_TYPE_PAT ? CODEX_DEFAULT_PAT_RIGHTS_ID : CODEX_DEFAULT_RIGHTS_ID,
      );
    }
  }
});

test('an unknown model or an unregistered credential type is denied', async () => {
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

test('registerCodexProviderCatalog calls the registrations in order', async () => {
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
  await registerCodexProviderCatalog(catalog);
  assert.deepEqual(calls, ['product', 'capability', 'capability', 'rights', 'rights']);
});

test('placeholder supplier costs register explicit zero subscription rates under the responses protocol', () => {
  const audit = {
    actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entryPoint: 'test',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const inputs = codexPlaceholderSupplierCostInputs(audit, {
    publicModelIds: [{ publicModelId: 'openai/gpt-5.3-codex', publicModelVersion: 1 }],
  });
  assert.equal(inputs.length, 1);
  const input = inputs[0];
  assert.equal(input.protocol, 'responses');
  assert.equal(input.endpoint, CODEX_ENDPOINT);
  assert.deepEqual(input.rates, {
    input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    cache_read: { numeratorMinorUnits: 0, denominatorUnits: 1 },
    cache_write: { numeratorMinorUnits: 0, denominatorUnits: 1 },
  });
  assert.ok(input.idempotencyKey.startsWith('openai-codex-supplier-cost-v1-'));
  // No public models means no price rows.
  assert.equal(codexPlaceholderSupplierCostInputs(audit).length, 0);
});
