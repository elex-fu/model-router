import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasCatalogError } from '../../../src/saas/catalog/errors.js';
import {
  chunkOpenRouterRightsScope,
  OPENROUTER_CAPABILITY_PROTOCOL,
  OPENROUTER_CREDENTIAL_TYPE,
  OPENROUTER_DEFAULT_RIGHTS_ID,
  OPENROUTER_DISPLAY_NAME,
  OPENROUTER_ENDPOINT,
  OPENROUTER_PRODUCT_ID,
  OPENROUTER_PROVIDER_ID,
  OPENROUTER_PURPOSE,
  OPENROUTER_REGION,
  OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE,
  OPENROUTER_SEED_MODEL_IDS,
  OPENROUTER_SUPPLY_MODE,
  openRouterCapabilityInputs,
  openRouterPlatformRightsInput,
  openRouterProviderProductInput,
  openRouterPublicModelAliasInputs,
  openRouterRightsChunkId,
  registerOpenRouterProviderCatalog,
  registerOpenRouterPublicModelAliases,
} from '../../../src/saas/catalog/openrouter-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityRequest } from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-10-16T00:00:00.000Z');
const EVIDENCE = {
  evidenceVersion: 'openrouter-f6-catalog-v1',
  reference: `${OPENROUTER_PROVIDER_ID}-${OPENROUTER_PRODUCT_ID}-preset`,
  sha256: 'a'.repeat(64),
} as const;

/** The GatewayProtocol spellings the production authority accepts as client protocols. */
const GATEWAY_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);

function eligibilityRequest(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    model: OPENROUTER_SEED_MODEL_IDS[0] as string,
    endpoint: OPENROUTER_ENDPOINT,
    credentialType: OPENROUTER_CREDENTIAL_TYPE,
    supplyMode: OPENROUTER_SUPPLY_MODE,
    region: OPENROUTER_REGION,
    purpose: OPENROUTER_PURPOSE,
    ...overrides,
  };
}

async function setup(): Promise<{ database: FakeCatalogDatabase; service: SaasCatalogService }> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await registerOpenRouterProviderCatalog(service);
  return { database, service };
}

test('identity constants declare the metered API-key platform pool shape', () => {
  assert.equal(OPENROUTER_PROVIDER_ID, 'openrouter');
  assert.equal(OPENROUTER_PRODUCT_ID, 'openrouter-api');
  assert.equal(OPENROUTER_CREDENTIAL_TYPE, 'api-key');
  assert.equal(OPENROUTER_SUPPLY_MODE, 'platform');
  assert.equal(OPENROUTER_REGION, 'global');
  assert.equal(OPENROUTER_PURPOSE, 'inference');
  assert.equal(OPENROUTER_ENDPOINT, 'openrouter-api');
  assert.ok(OPENROUTER_DISPLAY_NAME.length > 0);
});

test('product input pins the provider/product identity', () => {
  assert.deepEqual(openRouterProviderProductInput(), {
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    displayName: OPENROUTER_DISPLAY_NAME,
    status: 'active',
  });
});

test('capability inputs cover the seed model catalog exactly once each, all under the openai native protocol', () => {
  const inputs = openRouterCapabilityInputs(EVIDENCE);
  assert.equal(inputs.length, OPENROUTER_SEED_MODEL_IDS.length);
  assert.deepEqual(
    inputs.map((input) => input.model),
    [...OPENROUTER_SEED_MODEL_IDS],
  );
  assert.equal(new Set(inputs.map((input) => input.model)).size, inputs.length);
  for (const input of inputs) {
    assert.equal(input.providerId, OPENROUTER_PROVIDER_ID);
    assert.equal(input.productId, OPENROUTER_PRODUCT_ID);
    assert.equal(input.endpoint, OPENROUTER_ENDPOINT);
    // Zero bridge: the single native protocol as a GatewayProtocol.
    assert.equal(input.protocol, 'openai');
    assert.ok(GATEWAY_PROTOCOLS.has(input.protocol));
    assert.notEqual(input.protocol, 'openai-compatible');
    assert.equal(input.supportLevel, 'supported');
    assert.equal(input.validationState, 'verified');
    assert.equal(input.discoverySource, 'preset');
    assert.equal(input.evidenceVersion, EVIDENCE.evidenceVersion);
    assert.equal(input.evidenceReference, EVIDENCE.reference);
    assert.equal(input.evidenceSha256, EVIDENCE.sha256);
  }
});

test('capability inputs follow a caller-supplied model list (the synced catalog)', () => {
  const inputs = openRouterCapabilityInputs(EVIDENCE, ['openai/gpt-4o', 'anthropic/claude-sonnet-4']);
  assert.deepEqual(
    inputs.map((input) => input.model),
    ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
  );
});

test('platform rights input covers the model list under one endpoint scope', () => {
  const input = openRouterPlatformRightsInput({
    rightsId: OPENROUTER_DEFAULT_RIGHTS_ID,
    approvalReference: 'token-resale-plan-phase-r8a',
    evidenceReference: `${OPENROUTER_PROVIDER_ID}-${OPENROUTER_PRODUCT_ID}-rights-preset`,
    sha256: EVIDENCE.sha256,
    effectiveAt: new Date(0).toISOString(),
  });
  assert.equal(input.providerId, OPENROUTER_PROVIDER_ID);
  assert.equal(input.productId, OPENROUTER_PRODUCT_ID);
  assert.equal(input.credentialType, OPENROUTER_CREDENTIAL_TYPE);
  assert.equal(input.supplyMode, OPENROUTER_SUPPLY_MODE);
  assert.equal(input.region, OPENROUTER_REGION);
  assert.equal(input.purpose, OPENROUTER_PURPOSE);
  assert.deepEqual(input.modelScope, [...OPENROUTER_SEED_MODEL_IDS]);
  assert.deepEqual(input.endpointScope, [OPENROUTER_ENDPOINT]);
  assert.equal(input.status, 'active');
});

test('rights scope chunks respect the 100-model catalog limit with chunk-stable ids', () => {
  assert.ok(OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE <= 100, 'catalog MAX_SCOPE_VALUES is 100');
  const models = Array.from({ length: 250 }, (_, index) => `vendor/model-${String(index).padStart(3, '0')}`);
  const chunks = chunkOpenRouterRightsScope(models);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.length, 100);
  assert.equal(chunks[2]?.length, 50);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE);
  }
  assert.deepEqual([...chunks.flat()], models);
  // Chunk 0 keeps the plain identity; later chunks carry the suffix.
  assert.equal(openRouterRightsChunkId(0), OPENROUTER_DEFAULT_RIGHTS_ID);
  assert.equal(openRouterRightsChunkId(1), `${OPENROUTER_DEFAULT_RIGHTS_ID}-c01`);
  assert.equal(openRouterRightsChunkId(12), `${OPENROUTER_DEFAULT_RIGHTS_ID}-c12`);
  assert.throws(() => openRouterRightsChunkId(-1), TypeError);
  assert.throws(() => openRouterRightsChunkId(1.5), TypeError);
});

test('registerOpenRouterProviderCatalog persists product, capabilities and active rights', async () => {
  const { service } = await setup();
  const allowed = await service.checkProviderEligibility(eligibilityRequest());
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision === 'allow') {
    assert.equal(allowed.endpoint, OPENROUTER_ENDPOINT);
    // Zero bridge: the capability protocol is the openai native, so an
    // openai-protocol client passes the authority's protocol equality check.
    assert.equal(allowed.capability.protocol, OPENROUTER_CAPABILITY_PROTOCOL);
    assert.equal(allowed.capability.validationState, 'verified');
    assert.equal(allowed.rights.rightsId, OPENROUTER_DEFAULT_RIGHTS_ID);
    assert.equal(allowed.rights.status, 'active');
  }
});

test('every seed model is eligible after the one-call registration', async () => {
  const { service } = await setup();
  for (const model of OPENROUTER_SEED_MODEL_IDS) {
    const result = await service.checkProviderEligibility(eligibilityRequest({ model }));
    assert.equal(result.decision, 'allow', `model ${model} must be eligible, got ${JSON.stringify(result)}`);
    if (result.decision === 'allow') {
      assert.equal(result.capability.protocol, 'openai');
    }
  }
});

test('a synced-catalog registration beyond one chunk shards rights scopes deterministically', async () => {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  const models = Array.from({ length: 130 }, (_, index) => `vendor/model-${String(index).padStart(3, '0')}`);
  await registerOpenRouterProviderCatalog(service, { models });
  const first = models[0] as string;
  const last = models[129] as string;
  assert.equal((await service.checkProviderEligibility(eligibilityRequest({ model: first }))).decision, 'allow');
  assert.equal((await service.checkProviderEligibility(eligibilityRequest({ model: last }))).decision, 'allow');
  const rightsIds = new Set(database.state.rights.map((row) => row.rights_id));
  assert.deepEqual([...rightsIds].sort(), [OPENROUTER_DEFAULT_RIGHTS_ID, `${OPENROUTER_DEFAULT_RIGHTS_ID}-c01`]);
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

test('public model alias inputs map namespaced aliases onto provider models', () => {
  const inputs = openRouterPublicModelAliasInputs(['openai/gpt-4o', 'openrouter/anthropic/claude-sonnet-4', '']);
  assert.deepEqual(
    inputs.map((input) => input.alias),
    ['openrouter/openai/gpt-4o', 'openrouter/anthropic/claude-sonnet-4'],
  );
  for (const input of inputs) {
    assert.equal(input.providerId, OPENROUTER_PROVIDER_ID);
    assert.equal(input.productId, OPENROUTER_PRODUCT_ID);
    assert.deepEqual(input.endpointScope, [OPENROUTER_ENDPOINT]);
    assert.equal(input.status, 'active');
    // The alias prefix is exactly what normalizeOpenRouterModelId strips, so
    // modelMap resolution and the upstream request agree on the provider
    // model id.
    assert.ok(input.alias.endsWith(input.model));
  }
  // Default: one alias per built-in seed model, deduplicated and normalized.
  const seedInputs = openRouterPublicModelAliasInputs();
  assert.equal(seedInputs.length, OPENROUTER_SEED_MODEL_IDS.length);
  assert.deepEqual(
    seedInputs.map((input) => input.model),
    [...OPENROUTER_SEED_MODEL_IDS],
  );
});

test('registerOpenRouterPublicModelAliases persists one alias row per model', async () => {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await registerOpenRouterProviderCatalog(service);
  await registerOpenRouterPublicModelAliases(service);
  assert.deepEqual(
    database.state.publicModels.map((row) => row.alias).sort(),
    [...OPENROUTER_SEED_MODEL_IDS].map((model) => `openrouter/${model}`).sort(),
  );
  assert.deepEqual(
    database.state.publicModelVersions
      .map((row) => ({ model: row.model, version: row.version, status: row.status }))
      .sort((left, right) => left.model.localeCompare(right.model)),
    [...OPENROUTER_SEED_MODEL_IDS]
      .map((model) => ({ model, version: 1, status: 'active' }))
      .sort((left, right) => left.model.localeCompare(right.model)),
  );
  // Alias identity is unique: replaying the same registration conflicts on
  // the alias unique key (saas_public_models_alias_key) and surfaces the
  // semantic PUBLIC_MODEL_ALIAS_EXISTS code — the constraint-keyed conflict
  // mapping survives the shared query wrapper (which preserves the driver
  // error as the wrapped error's cause).
  await assert.rejects(registerOpenRouterPublicModelAliases(service), (error: unknown) => {
    assert.ok(error instanceof SaasCatalogError);
    assert.equal(error.code, 'PUBLIC_MODEL_ALIAS_EXISTS');
    return true;
  });
});
