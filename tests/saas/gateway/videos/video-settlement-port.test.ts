import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalSuccessPricingPort } from '../../../../src/saas/gateway/dispatch-usage-settlement.js';
import {
  ReconciliationVideoSettlementPort,
  VideoPerSecondRateCard,
} from '../../../../src/saas/gateway/videos/video-settlement-port.js';
import type { AttemptRecord, RequestRecord } from '../../../../src/saas/metering/types.js';
import type {
  ConditionalSettlementInput,
  ConditionalSettlementResult,
} from '../../../../src/saas/metering/unknown-outcome-reconciliation-service.js';
import type { CustomerPriceSnapshotRecord, CustomerPriceVersionRecord } from '../../../../src/saas/pricing/types.js';

/**
 * Batch 4 §4.3 (task #17) — the deferred settlement channel: the
 * per-second rate card (per_unit tier rate × seconds × frozen group
 * multiplier) and the reconciliation adapter's usage mapping, evidence ref
 * (`video:<taskID>`), and outcome mapping.
 */

const FACTS = { customerPriceVersion: 'price-v1', priceSnapshotRef: 'snapshot-1', currency: 'USD' };

function priceVersion(overrides: Partial<CustomerPriceVersionRecord> = {}): CustomerPriceVersionRecord {
  return {
    id: 'price-v1',
    kind: 'customer',
    publicModelId: 'public-model',
    publicModelVersion: 1n,
    providerId: 'provider-a',
    productId: 'product-a',
    protocol: 'openai',
    endpoint: '/v1/videos/generations',
    currency: 'USD',
    roundingMode: 'half_up',
    roundingBoundary: 'total',
    rates: {
      // A per-unit price version still carries its (here zero) token rates —
      // the registry requires non-null input/output on every rate set, and
      // rate keys are the registry's snake_case price metrics.
      input: { numeratorMinorUnits: '0', denominatorUnits: '1' },
      output: { numeratorMinorUnits: '0', denominatorUnits: '1' },
      per_unit: null,
      per_unit_tiers: {
        '480p': { numeratorMinorUnits: '2', denominatorUnits: '1' },
        '720p': { numeratorMinorUnits: '4', denominatorUnits: '1' },
        '1080p': { numeratorMinorUnits: '8', denominatorUnits: '1' },
      },
    },
    tokenMultipliers: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as unknown as CustomerPriceVersionRecord;
}

function snapshot(): CustomerPriceSnapshotRecord {
  return {
    id: 'snapshot-1',
    customerPriceVersion: 'price-v1',
    rateMultiplier: { numerator: 3n, denominator: 2n },
    modelPricingOverride: null,
    createdAt: '2026-10-01T00:00:00.000Z',
  } as unknown as CustomerPriceSnapshotRecord;
}

function pricingPort(): NormalSuccessPricingPort {
  return {
    async getCustomerPriceVersion() {
      return priceVersion();
    },
    async getCustomerPriceSnapshot() {
      return snapshot();
    },
  };
}

const USAGE = {
  inputTotal: '0',
  inputUncached: '0',
  cacheRead: '0',
  cacheWrite: '0',
  cacheWrite5m: '0',
  cacheWrite1h: '0',
  outputTotal: '0',
  reasoningOutput: '0',
};

function request(): RequestRecord {
  return {
    id: 'gateway-request-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    customerPriceVersion: 'price-v1',
    customerMeteringPolicyId: 'cp-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'pp-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'att-1',
    supplyMode: 'platform',
    supplyProfileId: 'profile-1',
    supplyProfileVersion: '1',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'platform_pool',
    routeUpstreamId: 'upstream-1',
    protocol: 'openai',
    publicModel: 'public-model',
    financialStatus: 'reconciliation_pending',
    resultState: 'unknown',
    reconciliationState: 'pending',
    stateVersion: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as unknown as RequestRecord;
}

function attempt(): AttemptRecord {
  return {
    id: 'attempt-1',
    tenantId: 'tenant-1',
    requestId: 'gateway-request-1',
    customerPriceVersion: 'price-v1',
    customerMeteringPolicyId: 'cp-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'pp-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'att-1',
    supplyProfileId: 'profile-1',
    supplyProfileAuthzVersion: '1',
    dispatchProfileId: 'profile-1',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'platform_pool',
    upstreamId: 'upstream-1',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'platform',
    accountId: 'account-1',
    providerId: 'provider-a',
    productId: 'product-a',
    resolvedModel: 'resolved-model',
    protocol: 'openai',
    dispatchState: 'unknown',
    resultState: 'unknown',
    responseStarted: false,
    stateVersion: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as unknown as AttemptRecord;
}

test('4.3: the per-second rate card prices tier rate × seconds × frozen multiplier', async () => {
  const card = new VideoPerSecondRateCard(FACTS, pricingPort());
  // 8 seconds at the 720p tier rate (4 minor units/s) with the 3/2 group
  // multiplier: 8 × 4 = 32 → ceil(32 × 3/2) = 48.
  const charge = await card.calculate({
    request: request(),
    attempt: attempt(),
    usage: {
      ...USAGE,
      billingMode: 'video',
      units: '8',
      sizeTier: '720p',
      status: 'reported',
      source: 'upstream',
      semanticsVersion: 'v1',
      measurementKind: 'snapshot',
      billableBasis: 'exact',
    },
  });
  assert.equal(charge.amountMinorUnits, '48');
  assert.equal(charge.currency, 'USD');
  assert.equal(charge.rateCardId, 'snapshot-1');
  assert.equal(charge.rateCardVersion, 'price-v1');
});

test('4.3: the rate card fails closed when the pricing authority drifted', async () => {
  const card = new VideoPerSecondRateCard(FACTS, pricingPort());
  await assert.rejects(
    card.calculate({
      request: { ...request(), customerPriceVersion: 'price-v2' },
      attempt: attempt(),
      usage: { ...USAGE, billingMode: 'video', units: '8', sizeTier: '720p' } as never,
    }),
  );
});

test('4.3: the reconciliation adapter settles a done observation through the conditional channel', async () => {
  const submissions: ConditionalSettlementInput[] = [];
  const port = new ReconciliationVideoSettlementPort({
    metering: {
      async getAttempt() {
        return attempt();
      },
      async getRequest() {
        return request();
      },
      async listAttempts() {
        return [attempt()];
      },
    },
    settlement: {
      async submit(input) {
        submissions.push(input);
        return { status: 'settled', settlementId: input.idempotencyKey, idempotencyKey: input.idempotencyKey };
      },
    },
    pricing: pricingPort(),
  });
  const outcome = await port.settle({
    tenantId: 'tenant-1',
    gatewayRequestId: 'gateway-request-1',
    gatewayAttemptId: 'attempt-1',
    billingRequestId: 'video:req-video-1',
    facts: FACTS,
    observation: {
      model: 'grok-imagine-video-1.5',
      resolution: '720p',
      durationSeconds: 4,
      videoCount: 2,
      units: 8,
      sizeTier: '720p',
    },
  });
  assert.equal(outcome.status, 'settled');
  const submitted = submissions[0];
  assert.ok(submitted !== undefined);
  // The usage is the observed per-unit seconds at the snapshot tier.
  assert.equal(submitted.usage.billingMode, 'video');
  assert.equal(submitted.usage.units, '8');
  assert.equal(submitted.usage.sizeTier, '720p');
  // The stable video key rides as the durable evidence ref.
  assert.equal(submitted.providerOperationId, 'video:req-video-1');
  // The charge is the frozen rate card's: 48 minor units (see above).
  assert.equal(submitted.charge.amountMinorUnits, '48');
  assert.equal(submitted.charge.rateCardId, 'snapshot-1');
});

test('4.3: a settlement conflict maps to a failed outcome with a reason', async () => {
  const port = new ReconciliationVideoSettlementPort({
    metering: {
      async getAttempt() {
        return attempt();
      },
      async getRequest() {
        return request();
      },
      async listAttempts() {
        return [attempt()];
      },
    },
    settlement: {
      async submit(): Promise<ConditionalSettlementResult> {
        return { status: 'conflict' };
      },
    },
    pricing: pricingPort(),
  });
  const outcome = await port.settle({
    tenantId: 'tenant-1',
    gatewayRequestId: 'gateway-request-1',
    gatewayAttemptId: 'attempt-1',
    billingRequestId: 'video:req-video-1',
    facts: FACTS,
    observation: { model: 'm', resolution: '480p', durationSeconds: 8, videoCount: 1, units: 8, sizeTier: '480p' },
  });
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.match(outcome.reason, /settlement_blocked:settlement_conflict/);
  }
});

test('4.3: an attempt that already reached a terminal state maps to replayed (no double bill)', async () => {
  const port = new ReconciliationVideoSettlementPort({
    metering: {
      async getAttempt() {
        // Terminal attempt: dispatchState sent, resultState succeeded.
        return { ...attempt(), dispatchState: 'sent', resultState: 'succeeded' };
      },
      async getRequest() {
        return { ...request(), resultState: 'succeeded', reconciliationState: 'resolved', financialStatus: 'settled' };
      },
      async listAttempts() {
        return [{ ...attempt(), dispatchState: 'sent', resultState: 'succeeded' }];
      },
    },
    settlement: {
      async submit() {
        throw new Error('must not be called for a non-unknown attempt');
      },
    },
    pricing: pricingPort(),
  });
  const outcome = await port.settle({
    tenantId: 'tenant-1',
    gatewayRequestId: 'gateway-request-1',
    gatewayAttemptId: 'attempt-1',
    billingRequestId: 'video:req-video-1',
    facts: FACTS,
    observation: { model: 'm', resolution: '480p', durationSeconds: 8, videoCount: 1, units: 8, sizeTier: '480p' },
  });
  assert.equal(outcome.status, 'replayed');
});
