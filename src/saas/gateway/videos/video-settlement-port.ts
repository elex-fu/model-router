import { multiplyMinorUnits } from '../../billing/groups/multiplier.js';
import { snapshotBillingGroupTerms } from '../../billing/groups/snapshot.js';
import type { UsageValues } from '../../metering/types.js';
import type {
  ConditionalSettlementPort,
  CustomerCharge,
  ServerOwnedCustomerRateCard,
  ServerOwnedCustomerRateCardInput,
  UnknownOutcomeMeteringReadPort,
  UnknownOutcomeReconciliationService,
} from '../../metering/unknown-outcome-reconciliation-service.js';
import { UnknownOutcomeReconciliationService as ReconciliationService } from '../../metering/unknown-outcome-reconciliation-service.js';
import { calculatePriceVersion } from '../../pricing/calculator.js';
import type { NormalSuccessPricingPort } from '../dispatch-usage-settlement.js';
import type { VideoBillingObservation } from './video-billing.js';

/**
 * Roadmap batch 4 §4.3 (task #17) — the deferred video settlement channel.
 *
 * Channel decision (written down per the task brief): the create request
 * ends its dispatch lifecycle as a **usage-missing unknown** (the async
 * create response carries no billable usage; the dispatch service retains
 * the hold for reconciliation by design), and the status/content poll
 * completes it through the **unknown-outcome reconciliation conditional
 * settlement path** — `UnknownOutcomeReconciliationService` +
 * `ConditionalSettlementPort.submit` — which atomically records the trusted
 * usage, applies the customer rate-card charge against the frozen
 * admission snapshot, and advances the request/attempt/hold state. This is
 * the only already-built channel that can charge a request whose dispatch
 * already closed: the §4.1 normal-success coordinator requires a
 * still-pending attempt, and migration 063's usage-correction table
 * requires an existing usage event to correct (a create has none).
 *
 * Idempotency: the reconciliation service derives its settlement
 * idempotency key from the create's tenant+request id, so repeated polls
 * replay instead of double-charging; the `video:<taskID>` stable prefix
 * rides along as the providerOperationId (the ledger's usage/reconciliation
 * evidence ref), marking the settlement with the video task identity
 * (sub2api StableGrokVideoBillingRequestID semantics, one key per task).
 */

/** The create-time frozen admission facts the deferred settlement re-prices against. */
export interface VideoSettlementFacts {
  readonly customerPriceVersion: string;
  readonly priceSnapshotRef: string;
  readonly currency: string;
}

export type SaasVideoSettlementOutcome =
  | { readonly status: 'settled' }
  | { readonly status: 'replayed' }
  | { readonly status: 'failed'; readonly reason: string };

export interface SaasVideoSettlementPort {
  settle(input: {
    readonly tenantId: string;
    readonly gatewayRequestId: string;
    readonly gatewayAttemptId: string;
    /** The stable `video:<taskID>` evidence ref (sub2api's billing key). */
    readonly billingRequestId: string;
    readonly observation: VideoBillingObservation;
    readonly facts: VideoSettlementFacts;
  }): Promise<SaasVideoSettlementOutcome>;
}

/**
 * The per-second rate card: per_unit tier rate × billed seconds × frozen
 * billing-group multiplier — the same pricing math as the §4.1
 * normal-success coordinator (DispatchUsageSettlementCoordinator.complete),
 * computed against the create-time snapshot rather than a mutable table.
 */
export class VideoPerSecondRateCard implements ServerOwnedCustomerRateCard {
  constructor(
    private readonly facts: VideoSettlementFacts,
    private readonly pricing: NormalSuccessPricingPort,
  ) {
    if (!facts || typeof facts !== 'object') throw new TypeError('video settlement facts are required');
    if (!pricing || typeof pricing.getCustomerPriceVersion !== 'function') {
      throw new TypeError('a pricing port is required');
    }
  }

  async calculate(input: ServerOwnedCustomerRateCardInput): Promise<CustomerCharge> {
    const { request, attempt } = input;
    // The frozen facts must still identify this request's pricing authority.
    if (
      request.customerPriceVersion !== this.facts.customerPriceVersion ||
      attempt.customerPriceVersion !== this.facts.customerPriceVersion
    ) {
      throw new Error('video settlement facts do not match the request pricing authority');
    }
    const price = await this.pricing.getCustomerPriceVersion(this.facts.customerPriceVersion);
    const snapshot = await this.pricing.getCustomerPriceSnapshot(this.facts.priceSnapshotRef);
    if (
      price.id !== this.facts.customerPriceVersion ||
      price.kind !== 'customer' ||
      price.currency !== this.facts.currency ||
      snapshot.id !== this.facts.priceSnapshotRef ||
      snapshot.customerPriceVersion !== this.facts.customerPriceVersion
    ) {
      throw new Error('video settlement facts do not match the frozen admission snapshot');
    }
    const terms = snapshotBillingGroupTerms(snapshot);
    const effectivePrice =
      terms.modelPricingOverride === null ? price : { ...price, rates: terms.modelPricingOverride.rates };
    const calculation = calculatePriceVersion(
      effectivePrice,
      {
        inputTotal: null,
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: null,
        reasoningOutput: null,
        perUnitUnits: input.usage.units,
        sizeTier: input.usage.sizeTier,
      },
      { requireComplete: false, serviceTier: null },
    );
    if (!calculation.complete) throw new Error('video usage is insufficient for the selected price');
    return {
      amountMinorUnits: multiplyMinorUnits(
        calculation.amountMinorUnits,
        terms.rateMultiplier,
        price.roundingMode,
      ).toString(10),
      currency: this.facts.currency,
      // The conditional settlement port requires rateCardId to equal the
      // hold's price_snapshot_ref; the version rides as rateCardVersion.
      rateCardId: this.facts.priceSnapshotRef,
      rateCardVersion: this.facts.customerPriceVersion,
    };
  }
}

function videoUsageValues(observation: VideoBillingObservation): UsageValues {
  return {
    inputTotal: '0',
    inputUncached: '0',
    cacheRead: '0',
    cacheWrite: '0',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    outputTotal: '0',
    reasoningOutput: '0',
    billingMode: 'video',
    units: String(observation.units),
    sizeTier: observation.sizeTier,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'v1',
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
}

export interface ReconciliationVideoSettlementPortDependencies {
  readonly metering: UnknownOutcomeMeteringReadPort;
  readonly settlement: ConditionalSettlementPort;
  readonly pricing: NormalSuccessPricingPort;
}

/**
 * Binds one observed done status to the reconciliation channel. The
 * provider adapter echoes the attempt's own identity (the status poll
 * resolved through the bound account, so identity always matches) and
 * carries the observed usage; the service then reads the attempt/request
 * state, prices through the frozen rate card, and conditionally settles.
 */
export class ReconciliationVideoSettlementPort implements SaasVideoSettlementPort {
  private readonly dependencies: ReconciliationVideoSettlementPortDependencies;

  constructor(dependencies: ReconciliationVideoSettlementPortDependencies) {
    if (!dependencies?.metering || !dependencies.settlement || !dependencies.pricing) {
      throw new TypeError('the reconciliation video settlement port requires its dependencies');
    }
    this.dependencies = dependencies;
  }

  async settle(input: Parameters<SaasVideoSettlementPort['settle']>[0]): Promise<SaasVideoSettlementOutcome> {
    const usage = videoUsageValues(input.observation);
    const billingRequestId = input.billingRequestId;
    const service: UnknownOutcomeReconciliationService = new ReconciliationService({
      metering: this.dependencies.metering,
      // The observation IS the provider lookup: the status poll already
      // resolved the task through its bound account and produced the
      // trusted done+video.url fact this settlement consumes.
      provider: {
        lookupUnknownAttempt: async (lookup) => ({
          status: 'completed' as const,
          providerOperationId: billingRequestId,
          identity: { ...lookup },
          usage,
        }),
      },
      // The durable observation is the video task row's billing state; the
      // reconciliation observation sink is satisfied with a no-op recorder.
      observations: {
        recordProviderObservation: async () => undefined,
      },
      rateCard: new VideoPerSecondRateCard(input.facts, this.dependencies.pricing),
      settlement: this.dependencies.settlement,
    });
    const result = await service.reconcile({
      tenantId: input.tenantId,
      requestId: input.gatewayRequestId,
      attemptId: input.gatewayAttemptId,
    });
    if (result.kind === 'settled') {
      return result.status === 'replayed' ? { status: 'replayed' } : { status: 'settled' };
    }
    if (result.kind === 'skipped') {
      // The attempt already reached a terminal state through another path;
      // this channel must not double-bill it — idempotent no-op success.
      return { status: 'replayed' };
    }
    const reason =
      result.kind === 'blocked' ? `settlement_blocked:${result.reason}` : `settlement_retained:${result.reason}`;
    return { status: 'failed', reason };
  }
}
