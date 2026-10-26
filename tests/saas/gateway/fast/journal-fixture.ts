import { randomUUID } from 'node:crypto';
import type {
  FastIntent,
  FastReceiptInput,
  FastReserveIntentInput,
} from '../../../../src/saas/gateway/fast/journal.js';
import { fastJournalDigest } from '../../../../src/saas/gateway/fast/journal.js';
import { calculateConservativePriceHold, INPUT_BILLING_BUCKETS } from '../../../../src/saas/gateway/hold-calculator.js';
import { normalizeRates } from '../../../../src/saas/pricing/calculator.js';
import type { CustomerPriceVersionRecord } from '../../../../src/saas/pricing/types.js';

export function priceFixture(inputBound = '80', outputBound = '0', numerator = '1') {
  const rate = { numeratorMinorUnits: numerator, denominatorUnits: '1' };
  const customerPrice: CustomerPriceVersionRecord = {
    kind: 'customer',
    id: randomUUID(),
    version: 1,
    publicModelId: 'journal-text',
    publicModelVersion: 1,
    providerId: 'journal-provider',
    productId: 'journal-product',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    currency: 'USD',
    commercialPolicyVersion: 'journal-v1',
    calculatorVersion: 'commercial-token-v1',
    roundingVersion: 'v1',
    roundingMode: 'ceil',
    roundingBoundary: 'total',
    tokenMultipliers: null,
    rates: normalizeRates({
      input: rate,
      output: rate,
      cache_read: rate,
      cache_write: rate,
      cache_write_5m: rate,
      cache_write_1h: rate,
    }),
    effectiveAt: new Date(0).toISOString(),
    expiresAt: null,
    idempotencyKey: randomUUID(),
    definitionDigest: 'a'.repeat(64),
    createdAt: new Date(0).toISOString(),
  };
  return { schemaVersion: 1 as const, customerPrice, maxInputTokens: inputBound, maxOutputTokens: outputBound };
}
export function intentFixture(tenantId: string, owner: string, snapshot = priceFixture()): FastReserveIntentInput {
  return {
    requestId: randomUUID(),
    attemptId: randomUUID(),
    tenantId,
    projectId: randomUUID(),
    proxyKeyId: randomUUID(),
    requestFingerprint: 'a'.repeat(64),
    payloadSha256: 'b'.repeat(64),
    accountId: `fixture-account-${randomUUID()}`,
    currency: 'USD',
    maxCostMinorUnits: calculateConservativePriceHold(snapshot.customerPrice, {
      inputUpperBound: snapshot.maxInputTokens,
      outputUpperBound: snapshot.maxOutputTokens,
      feasibleInputBuckets: INPUT_BILLING_BUCKETS,
    }).calculation.amountMinorUnits.toString(),
    priceSnapshot: snapshot,
    authoritySnapshot: { schemaVersion: 1, fixture: true },
    allocationOwner: owner,
    sendDeadlineMs: Date.now() + 60_000,
  };
}
export function receiptFixture(intent: FastIntent, charge = '20'): FastReceiptInput {
  const usage = {
    inputTotal: charge,
    inputUncached: charge,
    outputTotal: '0',
    cacheRead: '0',
    cacheWrite: '0',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    reasoningOutput: '0',
  };
  return {
    intentId: intent.id,
    tenantId: intent.tenantId,
    requestId: intent.requestId,
    outcome: 'succeeded',
    chargeMinorUnits: charge,
    usage,
    usageDigest: fastJournalDigest(usage),
    httpStatus: 200,
  };
}
