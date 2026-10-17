import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BillingGroupRecord } from '../../../src/saas/billing/groups/types.js';
import { SaasModelPlazaService } from '../../../src/saas/gateway/model-plaza/service.js';
import {
  MODEL_PLAZA_SETTINGS_DEFAULTS,
  type ModelPlazaSettings,
  resolveModelPlazaSettings,
} from '../../../src/saas/gateway/model-plaza/settings.js';
import { capabilityKey } from '../../../src/saas/gateway/model-plaza/store.js';
import type {
  ModelPlazaAccess,
  ModelPlazaFacts,
  ModelPlazaFactsPort,
  ModelPlazaPriceIdentity,
  ModelPlazaSnapshot,
  ModelPlazaTarget,
} from '../../../src/saas/gateway/model-plaza/types.js';
import type { CustomerPriceVersionRecord, RateSet } from '../../../src/saas/pricing/types.js';

const NEUTRAL = { numerator: 1n, denominator: 1n };

function present<T>(value: T | null | undefined, message?: string): T {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

function group(overrides: Partial<BillingGroupRecord> & { id: string }): BillingGroupRecord {
  return {
    displayName: overrides.id,
    rateMultiplier: NEUTRAL,
    topupMultiplier: NEUTRAL,
    peakEnabled: false,
    peak: null,
    modelPricing: new Map(),
    rpmLimit: null,
    dailyLimitMinorUnits: null,
    weeklyLimitMinorUnits: null,
    monthlyLimitMinorUnits: null,
    profitMinMargin: null,
    profitSafetyBuffer: null,
    claudeCodeOnly: false,
    fallbackGroupId: null,
    supportedModelScopes: null,
    composite: false,
    status: 'active',
    ...overrides,
  };
}

function rates(overrides: Partial<RateSet> = {}): RateSet {
  // USD rates in minor units (cents): $3/1M input, $0.30/1M cache read,
  // $3.75/1M cache write, $15/1M output.
  return {
    input: { numeratorMinorUnits: 300n, denominatorUnits: 1_000_000n },
    cache_read: { numeratorMinorUnits: 30n, denominatorUnits: 1_000_000n },
    cache_write: { numeratorMinorUnits: 375n, denominatorUnits: 1_000_000n },
    cache_write_5m: null,
    cache_write_1h: null,
    output: { numeratorMinorUnits: 1_500n, denominatorUnits: 1_000_000n },
    per_unit: null,
    per_unit_tiers: null,
    ...overrides,
  };
}

function priceVersion(identity: ModelPlazaPriceIdentity, rateSet: RateSet): CustomerPriceVersionRecord {
  return {
    id: `price-${identity.publicModelId}-${identity.providerId}-${identity.currency}`,
    version: 1,
    publicModelId: identity.publicModelId,
    publicModelVersion: identity.publicModelVersion,
    providerId: identity.providerId,
    productId: identity.productId,
    protocol: identity.protocol,
    endpoint: identity.endpoint,
    currency: identity.currency,
    commercialPolicyVersion: 'plaza-test-v1',
    calculatorVersion: 'commercial-token-v1',
    roundingVersion: 'plaza-test-v1',
    roundingMode: 'half_up',
    roundingBoundary: 'total',
    rates: rateSet,
    tokenMultipliers: null,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    idempotencyKey: `plaza-${identity.publicModelId}`,
    definitionDigest: '0'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'customer',
  };
}

function target(overrides: Partial<ModelPlazaTarget> & { publicModelId: string; alias: string }): ModelPlazaTarget {
  return {
    publicModelVersion: 1,
    displayName: overrides.alias,
    providerId: 'claude',
    productId: 'claude-code',
    model: overrides.alias,
    endpoint: 'claude-messages',
    protocol: 'anthropic',
    ...overrides,
  };
}

function identityFor(target: ModelPlazaTarget, currency = 'USD'): ModelPlazaPriceIdentity {
  return {
    publicModelId: target.publicModelId,
    publicModelVersion: target.publicModelVersion,
    providerId: target.providerId,
    productId: target.productId,
    protocol: target.protocol,
    endpoint: target.endpoint,
    currency,
  };
}

interface FakeFactsOptions {
  readonly groups: readonly BillingGroupRecord[];
  readonly targets: readonly ModelPlazaTarget[];
  readonly priceIdentities?: readonly ModelPlazaPriceIdentity[];
  /** Overrides which price versions resolve; absent = build from priceIdentities with `rates()`. */
  readonly versions?: ReadonlyMap<string, CustomerPriceVersionRecord>;
  readonly groupCapabilities?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly groupPlatforms?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unrestrictedGroupIds?: ReadonlySet<string>;
  readonly globalCapabilities?: ReadonlySet<string>;
  readonly globalPlatforms?: ReadonlySet<string>;
  readonly keyGroup?: string | null;
  readonly sessionGroups?: readonly string[];
}

function fakeFacts(options: FakeFactsOptions): ModelPlazaFactsPort {
  const globalCapabilities =
    options.globalCapabilities ??
    new Set(
      options.targets.map((entry) => capabilityKey(entry.providerId, entry.productId, entry.model, entry.endpoint)),
    );
  const globalPlatforms = options.globalPlatforms ?? new Set(options.targets.map((entry) => entry.providerId));
  const priceIdentities = options.priceIdentities ?? options.targets.map((entry) => identityFor(entry));
  const versions =
    options.versions ??
    new Map(priceIdentities.map((identity) => [identityKey(identity), priceVersion(identity, rates())]));
  const facts: ModelPlazaFacts = {
    groups: options.groups,
    groupCapabilities: options.groupCapabilities ?? new Map(),
    groupPlatforms: options.groupPlatforms ?? new Map(),
    unrestrictedGroupIds: options.unrestrictedGroupIds ?? new Set(options.groups.map((entry) => entry.id)),
    globalCapabilities,
    globalPlatforms,
    targets: options.targets,
    priceIdentities,
  };
  return {
    withSnapshot<T>(at: Date, work: (snapshot: ModelPlazaSnapshot) => Promise<T>): Promise<T> {
      const snapshot: ModelPlazaSnapshot = {
        facts,
        resolvePrice: async (identity) => versions.get(identityKey(identity)) ?? null,
        resolveKeyBillingGroup: async () => options.keyGroup ?? null,
        resolveSessionUserGroups: async () => options.sessionGroups ?? [],
      };
      void at;
      return work(snapshot);
    },
  };
}

function identityKey(identity: ModelPlazaPriceIdentity): string {
  return [
    identity.publicModelId,
    identity.publicModelVersion,
    identity.providerId,
    identity.productId,
    identity.protocol,
    identity.endpoint,
    identity.currency,
  ].join(' ');
}

function access(tier: ModelPlazaAccess['tier'], overrides: Partial<ModelPlazaAccess> = {}): ModelPlazaAccess {
  return { tier, proxyKeyCaller: null, sessionUserId: null, ...overrides };
}

function anonymousSettings(overrides: Partial<ModelPlazaSettings> = {}): ModelPlazaSettings {
  return { ...MODEL_PLAZA_SETTINGS_DEFAULTS, enabled: true, ...overrides };
}

const noOfficialPricing = () => Promise.resolve(null);

test('same-name models are first-seen-wins per (platform, alias); an unpriced entry is upgraded by a priced one', async () => {
  // Two targets, same alias and platform, different products; the FIRST
  // (deterministic product order) wins even though the second carries a
  // price, but an initially-UNPRICED first entry adopts the later price.
  const first = target({ publicModelId: 'model-a', alias: 'claude-x', productId: 'claude-code' });
  const second = target({ publicModelId: 'model-b', alias: 'claude-x', productId: 'claude-pro' });
  const facts = fakeFacts({
    groups: [group({ id: 'default' })],
    targets: [first, second],
    versions: new Map([
      [identityKey(identityFor(second)), priceVersion(identityFor(second), rates())],
      // first has no price version
    ]),
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  assert.equal(response.groups.length, 1);
  const models = present(response.groups[0]).models;
  assert.equal(models.length, 1, 'same (platform, alias) collapses to one entry');
  assert.equal(present(models[0]).model, 'claude-x');
  assert.equal(present(models[0]).platform, 'claude');
  assert.ok(present(models[0]).pricing, 'the unpriced first entry was upgraded by the priced second one');
});

test('display pricing is the exact charged amount: resolved rates × group rate multiplier', async () => {
  const targetEntry = target({ publicModelId: 'model-a', alias: 'claude-x' });
  const facts = fakeFacts({
    groups: [
      group({ id: 'vip', rateMultiplier: { numerator: 2n, denominator: 1n } }),
      group({ id: 'default', rateMultiplier: NEUTRAL }),
    ],
    targets: [targetEntry],
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  // Groups sort by multiplier ascending: default (1/1) before vip (2/1).
  assert.deepEqual(
    response.groups.map((entry) => entry.id),
    ['default', 'vip'],
  );
  const defaultPricing = present(present(present(response.groups[0]).models[0]).pricing);
  const vipPricing = present(present(present(response.groups[1]).models[0]).pricing);
  // $3/1M input → exact rational 300/1000000 minor units per token; vip ×2.
  assert.equal(present(defaultPricing.rates.input).numeratorMinorUnits, '300');
  assert.equal(present(defaultPricing.rates.input).denominatorUnits, '1000000');
  assert.equal(present(defaultPricing.rates.input).perMillionUnits, '3');
  assert.equal(present(vipPricing.rates.input).numeratorMinorUnits, '600');
  assert.equal(present(vipPricing.rates.input).perMillionUnits, '6');
  assert.equal(present(defaultPricing.rates.output).perMillionUnits, '15');
  assert.equal(present(vipPricing.rates.output).perMillionUnits, '30');
});

test('the group per-model override replaces the resolved rate set (highest priority)', async () => {
  const targetEntry = target({ publicModelId: 'model-a', alias: 'claude-x' });
  const facts = fakeFacts({
    groups: [
      group({
        id: 'vip',
        modelPricing: new Map([
          [
            'model-a',
            {
              input: { numeratorMinorUnits: 100n, denominatorUnits: 100n },
              cache_read: null,
              cache_write: null,
              cache_write_5m: null,
              cache_write_1h: null,
              output: { numeratorMinorUnits: 1n, denominatorUnits: 100n },
            },
          ],
        ]),
      }),
    ],
    targets: [targetEntry],
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  const pricing = present(present(present(response.groups[0]).models[0]).pricing);
  assert.equal(present(pricing.rates.input).numeratorMinorUnits, '100');
  assert.equal(present(pricing.rates.input).denominatorUnits, '100');
  assert.equal(present(pricing.rates.input).perMillionUnits, '10000');
  assert.equal(pricing.rates.cacheRead, null, 'override replaces the whole rate set');
  assert.equal(present(pricing.rates.output).perMillionUnits, '100');
});

test('per_unit flat rates and tier ladders surface for media models (§4.1 multimodal pricing)', async () => {
  const imageTarget = target({
    publicModelId: 'model-img',
    alias: 'grok-imagine-image',
    providerId: 'grok',
    productId: 'grok-api',
    endpoint: 'openai-images',
    protocol: 'openai',
  });
  const identity = identityFor(imageTarget);
  const mediaRates = rates({
    input: { numeratorMinorUnits: 0n, denominatorUnits: 1n },
    output: { numeratorMinorUnits: 0n, denominatorUnits: 1n },
    per_unit: { numeratorMinorUnits: 134n, denominatorUnits: 1n }, // $1.34 per image
    per_unit_tiers: {
      '1k': { numeratorMinorUnits: 80n, denominatorUnits: 1n },
      '4k': { numeratorMinorUnits: 220n, denominatorUnits: 1n },
    },
  });
  const facts = fakeFacts({
    groups: [group({ id: 'default' })],
    targets: [imageTarget],
    versions: new Map([[identityKey(identity), priceVersion(identity, mediaRates)]]),
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  const pricing = present(present(present(response.groups[0]).models[0]).pricing);
  assert.equal(present(pricing.perUnit).perUnitPrice, '1.34');
  assert.equal(present(present(pricing.perUnitTiers)['1k']).perUnitPrice, '0.8');
  assert.equal(present(present(pricing.perUnitTiers)['4k']).perUnitPrice, '2.2');
});

test('composite groups expand every pool platform; non-composite groups gate on pool capabilities', async () => {
  const claudeTarget = target({
    publicModelId: 'model-c',
    alias: 'claude-x',
    providerId: 'claude',
    productId: 'claude-code',
    model: 'claude-x',
    endpoint: 'claude-messages',
  });
  const vertexTarget = target({
    publicModelId: 'model-v',
    alias: 'vertex-claude-x',
    providerId: 'vertex',
    productId: 'vertex-claude',
    model: 'claude-x',
    endpoint: 'vertex-raw-predict',
  });
  const geminiTarget = target({
    publicModelId: 'model-g',
    alias: 'gemini-3',
    providerId: 'gemini',
    productId: 'gemini-cli',
    model: 'gemini-3',
    endpoint: 'gemini-generate-content',
  });
  const poolCapabilities = new Set([
    capabilityKey('claude', 'claude-code', 'claude-x', 'claude-messages'),
    capabilityKey('vertex', 'vertex-claude', 'claude-x', 'vertex-raw-predict'),
  ]);
  const poolPlatforms = new Set(['claude', 'vertex']);
  const facts = fakeFacts({
    groups: [group({ id: 'composite-vip', composite: true }), group({ id: 'plain', composite: false })],
    targets: [claudeTarget, vertexTarget, geminiTarget],
    unrestrictedGroupIds: new Set([]),
    groupCapabilities: new Map([
      ['composite-vip', poolCapabilities],
      ['plain', poolCapabilities],
    ]),
    groupPlatforms: new Map([
      ['composite-vip', poolPlatforms],
      ['plain', poolPlatforms],
    ]),
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  const byId = new Map(response.groups.map((entry) => [entry.id, entry]));
  // Composite: every platform in the pool expands (claude + vertex), the
  // pooled-out gemini platform is absent.
  assert.deepEqual(
    present(byId.get('composite-vip'))
      .models.map((model) => model.platform)
      .sort(),
    ['claude', 'vertex'],
  );
  // Non-composite: same capability-gated enumeration through the pool.
  assert.deepEqual(
    present(byId.get('plain'))
      .models.map((model) => model.platform)
      .sort(),
    ['claude', 'vertex'],
  );
});

test('a composite group also surfaces remapped target-platform price identities', async () => {
  const nominal = target({
    publicModelId: 'model-c',
    alias: 'claude-x',
    providerId: 'claude',
    productId: 'claude-code',
    model: 'claude-x',
    endpoint: 'claude-messages',
  });
  // A price identity bound to a RESOLVED composite target platform (vertex)
  // with a different product — what the admission guard composes after the
  // #18 platform swap.
  const remapped: ModelPlazaPriceIdentity = {
    publicModelId: 'model-c',
    publicModelVersion: 1,
    providerId: 'vertex',
    productId: 'vertex-claude',
    protocol: 'anthropic',
    endpoint: 'vertex-raw-predict',
    currency: 'USD',
  };
  const facts = fakeFacts({
    groups: [group({ id: 'composite-vip', composite: true })],
    targets: [nominal],
    priceIdentities: [identityFor(nominal), remapped],
    groupCapabilities: new Map([
      ['composite-vip', new Set([capabilityKey('claude', 'claude-code', 'claude-x', 'claude-messages')])],
    ]),
    groupPlatforms: new Map([['composite-vip', new Set(['claude', 'vertex'])]]),
    unrestrictedGroupIds: new Set([]),
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  const models = present(response.groups[0]).models;
  assert.deepEqual(
    models.map((model) => model.platform).sort(),
    ['claude', 'vertex'],
    'the remapped vertex identity appears as a vertex-platform entry of the same alias',
  );
  assert.equal(
    models.every((model) => model.model === 'claude-x'),
    true,
  );
});

test('visibility: exclusive groups hide from anonymous callers and appear for authorized tiers', async () => {
  const targetEntry = target({ publicModelId: 'model-a', alias: 'claude-x' });
  const facts = fakeFacts({
    groups: [group({ id: 'public' }), group({ id: 'vip' }), group({ id: 'enterprise' })],
    targets: [targetEntry],
    keyGroup: 'vip',
    sessionGroups: ['enterprise'],
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const settings = anonymousSettings({ exclusiveGroupIds: new Set(['vip', 'enterprise']) });

  const anonymous = await service.list({ access: access('anonymous'), settings });
  assert.deepEqual(
    anonymous.groups.map((entry) => entry.id),
    ['public'],
  );

  const session = await service.list({
    access: access('session', { sessionUserId: 'user-1' }),
    settings,
  });
  assert.deepEqual(session.groups.map((entry) => entry.id).sort(), ['enterprise', 'public']);

  const proxyKey = await service.list({
    access: access('proxy_key', {
      proxyKeyCaller: { tenantId: 't-1', projectId: 'p-1', keyId: 'k-1' },
    }),
    settings,
  });
  assert.deepEqual(
    proxyKey.groups.map((entry) => entry.id).sort(),
    ['public', 'vip'],
    'the proxy key tier sees the public groups plus its effective billing group',
  );
});

test('groups without servable models are omitted; models sort by name then platform', async () => {
  const targetEntry = target({ publicModelId: 'model-a', alias: 'zeta' });
  const facts = fakeFacts({
    groups: [group({ id: 'empty' }), group({ id: 'default' })],
    targets: [targetEntry],
    // Only the 'default' group is unrestricted (sees global capabilities);
    // 'empty' has an explicit empty pool.
    unrestrictedGroupIds: new Set(['default']),
    groupCapabilities: new Map([['empty', new Set<string>()]]),
    groupPlatforms: new Map([['empty', new Set<string>()]]),
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const response = await service.list({ access: access('anonymous'), settings: anonymousSettings() });
  assert.deepEqual(
    response.groups.map((entry) => entry.id),
    ['default'],
  );
  assert.equal(present(present(response.groups[0]).models[0]).model, 'zeta');
});

test('model scopes never filter the plaza (whitelist semantics) and the description echoes the settings', async () => {
  const targetEntry = target({ publicModelId: 'model-a', alias: 'claude-x' });
  const facts = fakeFacts({
    groups: [group({ id: 'scoped', supportedModelScopes: ['only-this-model'] })],
    targets: [targetEntry],
  });
  const service = new SaasModelPlazaService({ facts, officialPricing: { lookup: noOfficialPricing } as never });
  const settings = resolveModelPlazaSettings({ 'saas.plaza.enabled': true, 'saas.plaza.description': 'Showcase' }, {});
  const response = await service.list({ access: access('anonymous'), settings });
  assert.equal(response.description, 'Showcase');
  assert.equal(present(response.groups[0]).models.length, 1, 'scopes gate calls, never plaza visibility');
});
