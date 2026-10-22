import { resolveModelPricingOverride } from '../../billing/groups/override.js';
import type { BillingGroupRecord, RationalMultiplier } from '../../billing/groups/types.js';
import type { CustomerPriceVersionRecord, PerUnitTier, RateSet, RationalRate } from '../../pricing/types.js';
import { PER_UNIT_TIERS } from '../../pricing/types.js';
import {
  createGatewayCapabilityAdvertisementPolicy,
  type GatewayCapabilityAdvertisementPolicy,
} from '../../runtime/gateway-capability-advertisement.js';
import type { GatewayCapabilityReadiness } from '../../runtime/gateway-capability-readiness.js';
import { ModelsDevOfficialPricingRegistry, type OfficialModelEntry } from './official-pricing.js';
import type { ModelPlazaSettings } from './settings.js';
import { capabilityKey } from './store.js';
import type {
  ModelPlazaAccess,
  ModelPlazaFacts,
  ModelPlazaFactsPort,
  ModelPlazaGroup,
  ModelPlazaModel,
  ModelPlazaOfficialPricing,
  ModelPlazaPriceIdentity,
  ModelPlazaPricing,
  ModelPlazaRate,
  ModelPlazaResponse,
  ModelPlazaSnapshot,
  ModelPlazaTarget,
} from './types.js';

/**
 * Plaza aggregation (the sub2api model_plaza_service port):
 *
 * - groups: active billing groups; a group appears only when it has at least
 *   one servable model; groups sort by rate multiplier ascending then name,
 *   models by name then platform (the sub2api ordering, deterministic);
 * - per group, model enumeration is first-seen-wins per (platform, model
 *   alias) over the deterministically ordered target list, and an unpriced
 *   entry is upgraded only when a later entry for the same key carries a
 *   price (the sub2api 无价条目可被有价升级 rule);
 * - display pricing = the resolved customer price version (same chain), with
 *   the group's per-model override replacing the rate set and the group rate
 *   multiplier scaling every rate exactly (rationals; never floats);
 * - composite groups expand every concrete platform in their pool (or all
 *   platforms when unrestricted) — the #18 showcase semantics; per-request
 *   three-level resolution remains the authority for what is callable.
 * - whitelist semantics: model scopes (what a key may CALL) never filter the
 *   plaza (what a visitor may SEE); exclusive groups (a plaza-settings flag)
 *   are invisible to callers whose tier does not authorize them.
 */

const MAX_MODELS_PER_GROUP = 512;
const MAX_PRICE_RESOLUTIONS = 512;
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** ISO-4217 currencies whose minor-unit exponent is not 2. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

function minorUnitFactor(currency: string): bigint | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 1n : 100n;
}

/** Exact rational → decimal string with up to `scale` decimals, half-up, trailing zeros trimmed. */
function decimalString(numerator: bigint, denominator: bigint, scale: number): string {
  if (denominator <= 0n) return '0';
  const factor = 10n ** BigInt(scale);
  const scaled = (numerator * factor * 2n + denominator) / (denominator * 2n);
  const sign = scaled < 0n ? '-' : '';
  const absolute = scaled < 0n ? -scaled : scaled;
  const base = absolute / factor;
  const fraction = absolute % factor;
  if (fraction === 0n || scale === 0) return `${sign}${base.toString(10)}`;
  const fractionText = fraction.toString(10).padStart(scale, '0').replace(/0+$/, '');
  return `${sign}${base.toString(10)}.${fractionText}`;
}

/**
 * Display rate = exact rate × group rate multiplier (rational scaling, the
 * same arithmetic shape as the admission guard's composed price). The
 * rational pair is authoritative; perMillionUnits / perUnitPrice are
 * display helpers for token / per-unit metrics respectively.
 */
function displayRate(
  rate: RationalRate | null,
  multiplier: RationalMultiplier,
  currency: string,
): ModelPlazaRate | null {
  if (rate === null) return null;
  const scaled: RationalRate = {
    numeratorMinorUnits: rate.numeratorMinorUnits * multiplier.numerator,
    denominatorUnits: rate.denominatorUnits * multiplier.denominator,
  };
  const minorFactor = minorUnitFactor(currency);
  return {
    numeratorMinorUnits: scaled.numeratorMinorUnits.toString(10),
    denominatorUnits: scaled.denominatorUnits.toString(10),
    perMillionUnits:
      minorFactor === null
        ? null
        : decimalString(scaled.numeratorMinorUnits * 1_000_000n, scaled.denominatorUnits * minorFactor, 6),
    perUnitPrice:
      minorFactor === null ? null : decimalString(scaled.numeratorMinorUnits, scaled.denominatorUnits * minorFactor, 6),
  };
}

/** 实收口径 pricing for one (group, model): override > resolved rates, all × rate multiplier. */
function pricingFromVersion(version: CustomerPriceVersionRecord, group: BillingGroupRecord): ModelPlazaPricing {
  const override = resolveModelPricingOverride(group.modelPricing, version.publicModelId);
  const rates: RateSet = override === null ? version.rates : override.rates;
  const multiplier = group.rateMultiplier;
  const perUnitTiers: Record<string, ModelPlazaRate> = {};
  if (rates.per_unit_tiers !== null) {
    for (const tier of PER_UNIT_TIERS) {
      const rate = rates.per_unit_tiers[tier];
      if (rate === undefined) continue;
      const displayed = displayRate(rate, multiplier, version.currency);
      if (displayed !== null) perUnitTiers[tier as PerUnitTier] = displayed;
    }
  }
  const tokenMultipliers = version.tokenMultipliers;
  const longContext = tokenMultipliers?.longContext;
  return {
    currency: version.currency,
    rates: {
      input: displayRate(rates.input, multiplier, version.currency),
      cacheRead: displayRate(rates.cache_read, multiplier, version.currency),
      cacheWrite: displayRate(rates.cache_write, multiplier, version.currency),
      cacheWrite5m: displayRate(rates.cache_write_5m, multiplier, version.currency),
      cacheWrite1h: displayRate(rates.cache_write_1h, multiplier, version.currency),
      output: displayRate(rates.output, multiplier, version.currency),
    },
    perUnit: displayRate(rates.per_unit, multiplier, version.currency),
    perUnitTiers: Object.keys(perUnitTiers).length > 0 ? perUnitTiers : null,
    longContext:
      longContext === null || longContext === undefined
        ? null
        : {
            inputThreshold: longContext.inputThreshold.toString(10),
            thresholdInclusive: longContext.thresholdInclusive,
            inputMultiplier: {
              numerator: longContext.inputMultiplier.numerator.toString(10),
              denominator: longContext.inputMultiplier.denominator.toString(10),
            },
            outputMultiplier: {
              numerator: longContext.outputMultiplier.numerator.toString(10),
              denominator: longContext.outputMultiplier.denominator.toString(10),
            },
          },
    serviceTiers:
      tokenMultipliers === null ||
      tokenMultipliers === undefined ||
      Object.keys(tokenMultipliers.serviceTiers).length === 0
        ? null
        : Object.fromEntries(
            Object.entries(tokenMultipliers.serviceTiers).map(([tier, value]) => [
              tier,
              { numerator: value.numerator.toString(10), denominator: value.denominator.toString(10) },
            ]),
          ),
  };
}

function priceIdentityKey(identity: ModelPlazaPriceIdentity): string {
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

function nominalIdentityKey(parts: {
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: string;
  readonly endpoint: string;
}): string {
  return [
    parts.publicModelId,
    parts.publicModelVersion,
    parts.providerId,
    parts.productId,
    parts.protocol,
    parts.endpoint,
  ].join(' ');
}

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hours, minutes, secs].map((part) => part.toString(10).padStart(2, '0')).join(':');
}

function compareRational(left: RationalMultiplier, right: RationalMultiplier): number {
  const leftScaled = left.numerator * right.denominator;
  const rightScaled = right.numerator * left.denominator;
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface AggregateEntry {
  readonly alias: string;
  readonly displayName: string;
  readonly platform: string;
  /** The upstream model id for the official-reference lookup. */
  readonly resolvedModel: string;
  identity: ModelPlazaPriceIdentity | null;
  resolved: CustomerPriceVersionRecord | null;
}

export interface SaasModelPlazaServiceOptions {
  readonly facts: ModelPlazaFactsPort;
  /** Production always supplies this authority; omitted only for standalone legacy projections. */
  readonly capabilityReadiness?: () => Promise<GatewayCapabilityReadiness>;
  /** Official reference registry; defaults to the models.dev registry. */
  readonly officialPricing?: ModelsDevOfficialPricingRegistry;
  readonly now?: () => Date;
}

export class SaasModelPlazaService {
  private readonly facts: ModelPlazaFactsPort;
  private readonly capabilityReadiness: SaasModelPlazaServiceOptions['capabilityReadiness'];
  private readonly officialPricing: ModelsDevOfficialPricingRegistry;
  private readonly now: () => Date;

  constructor(options: SaasModelPlazaServiceOptions) {
    if (!options.facts || typeof options.facts.withSnapshot !== 'function') {
      throw new TypeError('SaasModelPlazaService requires a facts port');
    }
    this.facts = options.facts;
    this.capabilityReadiness = options.capabilityReadiness;
    this.officialPricing = options.officialPricing ?? new ModelsDevOfficialPricingRegistry();
    this.now = options.now ?? (() => new Date());
  }

  async list(input: {
    readonly access: ModelPlazaAccess;
    readonly settings: ModelPlazaSettings;
  }): Promise<ModelPlazaResponse> {
    const at = this.now();
    const canAdvertise = this.capabilityReadiness
      ? createGatewayCapabilityAdvertisementPolicy(await this.capabilityReadiness())
      : undefined;
    const aggregated = await this.facts.withSnapshot(at, async (snapshot) => {
      // Composite remapped identities must be filtered before resolving prices.
      // Nominal targets are filtered in aggregation while retaining their alias
      // metadata for an independently sellable composite target platform.
      const facts = canAdvertise
        ? {
            ...snapshot.facts,
            priceIdentities: snapshot.facts.priceIdentities.filter(canAdvertise),
          }
        : snapshot.facts;
      const authorized = await authorizedGroupIds(snapshot, input.access);

      // Resolve prices for the bounded set of effective identities. When a
      // target has several currencies, the lexicographically first effective
      // currency is the display currency (the store pre-sorts identities).
      const prices = new Map<string, CustomerPriceVersionRecord>();
      let resolves = 0;
      for (const identity of facts.priceIdentities) {
        if (resolves >= MAX_PRICE_RESOLUTIONS) break;
        const key = priceIdentityKey(identity);
        if (prices.has(key)) continue;
        resolves += 1;
        const version = await snapshot.resolvePrice(identity);
        if (version !== null) prices.set(key, version);
      }

      const groups: Array<{ readonly record: BillingGroupRecord; readonly entries: readonly AggregateEntry[] }> = [];
      for (const group of facts.groups) {
        if (!visible(group, input.settings, authorized)) continue;
        const entries = aggregateGroup(group, facts, prices, canAdvertise);
        if (entries.length === 0) continue;
        groups.push({ record: group, entries });
      }
      groups.sort((left, right) => {
        const byMultiplier = compareRational(left.record.rateMultiplier, right.record.rateMultiplier);
        return byMultiplier !== 0 ? byMultiplier : compareStrings(left.record.displayName, right.record.displayName);
      });
      return groups;
    });

    // Official reference pricing attaches AFTER the snapshot transaction: the
    // registry is external, best-effort display data and must never hold the
    // database snapshot open.
    const groups: ModelPlazaGroup[] = [];
    for (const { record, entries } of aggregated) {
      const models: ModelPlazaModel[] = [];
      for (const entry of entries) {
        const official = await this.officialPricing.lookup(entry.platform, entry.resolvedModel);
        models.push({
          model: entry.alias,
          displayName: entry.displayName,
          platform: entry.platform,
          contextWindow: official?.contextWindow ?? null,
          pricing:
            entry.resolved === null || entry.identity === null ? null : pricingFromVersion(entry.resolved, record),
          officialPricing: toOfficialPricing(official),
        });
      }
      models.sort(
        (left, right) => compareStrings(left.model, right.model) || compareStrings(left.platform, right.platform),
      );
      groups.push({
        id: record.id,
        name: record.displayName,
        composite: record.composite,
        rateMultiplier: {
          numerator: record.rateMultiplier.numerator.toString(10),
          denominator: record.rateMultiplier.denominator.toString(10),
        },
        peak:
          record.peakEnabled && record.peak !== null
            ? {
                start: clock(record.peak.startSecondsUtc),
                end: clock(record.peak.endSecondsUtc),
                multiplier: {
                  numerator: record.peak.multiplier.numerator.toString(10),
                  denominator: record.peak.multiplier.denominator.toString(10),
                },
              }
            : null,
        models,
      });
    }
    return { description: input.settings.description, groups };
  }
}

function aggregateGroup(
  group: BillingGroupRecord,
  facts: ModelPlazaFacts,
  prices: ReadonlyMap<string, CustomerPriceVersionRecord>,
  canAdvertise?: GatewayCapabilityAdvertisementPolicy,
): readonly AggregateEntry[] {
  const unrestricted = facts.unrestrictedGroupIds.has(group.id);
  const groupCapabilities = unrestricted
    ? facts.globalCapabilities
    : (facts.groupCapabilities.get(group.id) ?? EMPTY_SET);
  const groupPlatforms = unrestricted ? facts.globalPlatforms : (facts.groupPlatforms.get(group.id) ?? EMPTY_SET);

  // Deterministic target order (the sub2api channel-name sort analog):
  // alias, provider, product, endpoint, protocol.
  const targets = [...facts.targets].sort(
    (left, right) =>
      compareStrings(left.alias, right.alias) ||
      compareStrings(left.providerId, right.providerId) ||
      compareStrings(left.productId, right.productId) ||
      compareStrings(left.endpoint, right.endpoint) ||
      compareStrings(left.protocol, right.protocol),
  );

  // Alias/display metadata by public model id (for composite-remapped
  // identities, whose price rows carry only the id).
  const aliasByModel = new Map<
    string,
    { readonly alias: string; readonly displayName: string; readonly resolvedModel: string }
  >();
  for (const target of targets) {
    if (!aliasByModel.has(target.publicModelId)) {
      aliasByModel.set(target.publicModelId, {
        alias: target.alias,
        displayName: target.displayName,
        resolvedModel: target.model,
      });
    }
  }

  const entries = new Map<string, AggregateEntry>();
  const push = (candidate: AggregateEntry): void => {
    const key = `${candidate.platform}\u0000${candidate.alias}`;
    const existing = entries.get(key);
    if (existing !== undefined) {
      // First-seen wins; an unpriced entry is upgraded only by a priced one.
      if (existing.resolved === null && candidate.resolved !== null) {
        existing.resolved = candidate.resolved;
        existing.identity = candidate.identity;
      }
      return;
    }
    if (entries.size >= MAX_MODELS_PER_GROUP) return;
    entries.set(key, candidate);
  };

  for (const target of targets) {
    if (canAdvertise && !canAdvertise(target)) continue;
    const servable = group.composite
      ? groupPlatforms.has(target.providerId)
      : groupCapabilities.has(capabilityKey(target.providerId, target.productId, target.model, target.endpoint));
    if (!servable) continue;
    const identity = firstIdentityForTarget(facts.priceIdentities, target);
    push({
      alias: target.alias,
      displayName: target.displayName,
      platform: target.providerId,
      resolvedModel: target.model,
      identity,
      resolved: identity === null ? null : (prices.get(priceIdentityKey(identity)) ?? null),
    });
  }

  // Composite groups additionally surface price identities bound to a
  // RESOLVED target platform other than every nominal provider of that
  // public model — the post-#18-swap pricing the admission guard composes.
  if (group.composite) {
    const nominalProviders = new Map<string, Set<string>>();
    for (const target of targets) {
      let providers = nominalProviders.get(target.publicModelId);
      if (providers === undefined) {
        providers = new Set<string>();
        nominalProviders.set(target.publicModelId, providers);
      }
      providers.add(target.providerId);
    }
    const seenNominalKeys = new Set(targets.map((target) => nominalIdentityKey(target)));
    for (const identity of facts.priceIdentities) {
      if (!groupPlatforms.has(identity.providerId)) continue;
      if (seenNominalKeys.has(nominalIdentityKey(identity))) continue;
      const providers = nominalProviders.get(identity.publicModelId);
      if (providers?.has(identity.providerId)) continue;
      const version = prices.get(priceIdentityKey(identity));
      if (version === undefined) continue;
      const meta = aliasByModel.get(identity.publicModelId);
      push({
        alias: meta?.alias ?? identity.publicModelId,
        displayName: meta?.displayName ?? identity.publicModelId,
        platform: identity.providerId,
        resolvedModel: meta?.resolvedModel ?? identity.publicModelId,
        identity,
        resolved: version,
      });
    }
  }

  return [...entries.values()];
}

/** The display identity for a nominal target: the first (sorted) effective currency. */
function firstIdentityForTarget(
  identities: readonly ModelPlazaPriceIdentity[],
  target: ModelPlazaTarget,
): ModelPlazaPriceIdentity | null {
  const key = nominalIdentityKey(target);
  for (const identity of identities) {
    if (nominalIdentityKey(identity) === key) return identity;
  }
  return null;
}

async function authorizedGroupIds(
  snapshot: ModelPlazaSnapshot,
  access: ModelPlazaAccess,
): Promise<ReadonlySet<string>> {
  if (access.tier === 'proxy_key') {
    const groupId =
      access.proxyKeyCaller === null ? null : await snapshot.resolveKeyBillingGroup(access.proxyKeyCaller);
    return groupId === null ? EMPTY_SET : new Set([groupId]);
  }
  if (access.tier === 'session' && access.sessionUserId !== null) {
    return new Set(await snapshot.resolveSessionUserGroups(access.sessionUserId));
  }
  return EMPTY_SET;
}

function visible(group: BillingGroupRecord, settings: ModelPlazaSettings, authorized: ReadonlySet<string>): boolean {
  if (!settings.exclusiveGroupIds.has(group.id)) return true;
  return authorized.has(group.id);
}

function toOfficialPricing(entry: OfficialModelEntry | null): ModelPlazaOfficialPricing | null {
  if (entry === null) return null;
  if (
    entry.input === null &&
    entry.output === null &&
    entry.cacheRead === null &&
    entry.cacheWrite === null &&
    entry.contextWindow === null
  ) {
    return null;
  }
  return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
}
