import { createHash } from 'node:crypto';
import { parseMinorUnits } from '../../billing/money.js';
import type { CustomerPriceVersionRecord } from '../../pricing/types.js';
import type { FastReceiptInput } from './executor.js';
import {
  calculateFastReceiptCharge,
  type FastPriceSnapshot,
  fastJournalCanonicalJson,
  validatePriceSnapshot,
} from './receipt-evidence.js';

/** Only exact module-owned objects carry reusable work. No property/symbol is a trust marker. */
const preparedReceipts = new WeakMap<object, PreparedFastReceipt>();
const preparedPrices = new WeakMap<object, string>();
const capturedCustomerPrices = new WeakSet<object>();
export interface PreparedFastReceipt {
  readonly canonical: string;
  readonly receiptDigest: string;
  readonly values: readonly (string | number | null)[];
  /** Encoded evidence + cached strings + bounded envelope/tuple overhead, not a heap measurement. */
  readonly retainedBytes: number;
}
export function getPreparedFastReceipt(input: object): PreparedFastReceipt | undefined {
  return preparedReceipts.get(input);
}

/** Detach scalar evidence, rejecting accessors, hidden extensions, prototypes and cycles. */
function copyJsonFacts(value: unknown, ancestors = new Set<object>(), normalizeBigInt = false): unknown {
  if (scalar(value)) return normalizeBigInt && typeof value === 'bigint' ? value.toString() : value;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || ancestors.has(value))
    throw new Error('FAST_RECEIPT_INVALID');
  ancestors.add(value);
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
      throw new Error('FAST_RECEIPT_INVALID');
    const child = copyJsonFacts(descriptor.value, ancestors, normalizeBigInt);
    // The sole inherited setter on a fresh ordinary record must not mutate its
    // prototype. Other data keys can use ordinary fast property assignment.
    if (key === '__proto__')
      Object.defineProperty(copy, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else copy[key] = child;
  }
  ancestors.delete(value);
  return copy;
}

/** Capture before executor awaits, replacing (not following) its old JSON clone. */
export function captureFastReceiptCustomerPrice(input: CustomerPriceVersionRecord): CustomerPriceVersionRecord {
  if (capturedCustomerPrices.has(input)) return input;
  const customerPrice = copyJsonFacts(input, new Set(), true) as CustomerPriceVersionRecord;
  freeze(customerPrice);
  capturedCustomerPrices.add(customerPrice);
  return customerPrice;
}

/** The wrapper copies scalars, not the price subtree already owned by this module. */
export function prepareFastReceiptPrice(snapshot: FastPriceSnapshot): FastPriceSnapshot {
  if (preparedPrices.has(snapshot)) return snapshot;
  // Descriptor capture keeps the public API's getter/prototype/extension rejection;
  // only exact privately owned nested prices avoid the full defensive clone.
  const captured = captureFields(snapshot, SNAPSHOT_KEYS);
  const ownedCustomer = capturedCustomerPrices.has(captured.customerPrice as object);
  if (ownedCustomer) {
    if (typeof captured.maxInputTokens === 'bigint') captured.maxInputTokens = captured.maxInputTokens.toString();
    if (typeof captured.maxOutputTokens === 'bigint') captured.maxOutputTokens = captured.maxOutputTokens.toString();
  }
  const price = (ownedCustomer ? captured : copyJsonFacts(captured, new Set(), true)) as unknown as FastPriceSnapshot;
  validatePriceSnapshot(price);
  if (!validPriceShape(price)) throw new Error('FAST_RECEIPT_INVALID_PROOF');
  const canonical = fastJournalCanonicalJson(price);
  if (ownedCustomer) Object.freeze(price);
  else freeze(price);
  preparedPrices.set(price, canonical);
  return price;
}

/** Fixed schema: capture each own data field once; never retain caller accessors/aliases. */
function captureFields(input: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype)
    throw new Error('FAST_RECEIPT_INVALID');
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !keys.has(key) || !descriptor?.enumerable || !('value' in descriptor))
      throw new Error('FAST_RECEIPT_INVALID');
    copy[key] = descriptor.value;
  }
  return copy;
}

function captureUsage(input: unknown): Record<string, string | null> {
  const usage = captureFields(input, USAGE_KEYS);
  for (const value of Object.values(usage)) {
    if (value !== null) {
      if (!decimal(value)) throw new Error('FAST_RECEIPT_INVALID');
      parseMinorUnits(value, { allowZero: true });
    }
  }
  return usage as Record<string, string | null>;
}

/** Complete provider responses only: callers supply facts, never a claimed charge, digest or trust bit. */
export function prepareFastReceipt(input: {
  readonly intentId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly httpStatus: number;
  readonly usage: Readonly<Record<string, string | null>>;
  readonly priceSnapshot: FastPriceSnapshot | null;
  readonly maxCostMinorUnits: string;
}): FastReceiptInput {
  const facts = {
    intentId: input.intentId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    httpStatus: input.httpStatus,
    usage: captureUsage(input.usage),
    maxCostMinorUnits: input.maxCostMinorUnits,
  };
  if (
    ![facts.intentId, facts.requestId, facts.tenantId].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 256,
    ) ||
    !Number.isInteger(facts.httpStatus) ||
    facts.httpStatus < 100 ||
    facts.httpStatus > 599
  )
    throw new Error('FAST_RECEIPT_INVALID');
  const maximum = parseMinorUnits(facts.maxCostMinorUnits, { allowZero: true });
  const succeeded = facts.httpStatus >= 200 && facts.httpStatus < 300;
  const rawPrice = input.priceSnapshot;
  const price = succeeded && rawPrice !== null ? prepareFastReceiptPrice(rawPrice) : null;
  const charge = price ? calculateFastReceiptCharge(price, facts.usage) : 0n;
  if (charge > maximum) throw new Error('Fast usage exceeds frozen price bound');
  // Preserve executor's historical insertion-ordered usage digest as well as journal's sorted v1 digest.
  const usageDigest = createHash('sha256')
    .update(
      JSON.stringify({
        status: facts.httpStatus,
        usage: facts.usage,
        charge: charge.toString(),
      }),
    )
    .digest('hex');
  const evidence = {
    intentId: facts.intentId,
    requestId: facts.requestId,
    tenantId: facts.tenantId,
    outcome: succeeded ? ('succeeded' as const) : ('failed' as const),
    chargeMinorUnits: charge.toString(),
    usage: facts.usage,
    usageDigest,
    httpStatus: facts.httpStatus,
  };
  const receipt: FastReceiptInput = freeze({
    ...evidence,
    ...(price ? { verification: { priceSnapshot: price } } : {}),
  });
  const evidenceJson = fastJournalCanonicalJson(evidence);
  const receiptDigest = createHash('sha256').update(evidenceJson).digest('hex');
  const usageJson = fastJournalCanonicalJson(receipt.usage);
  const verifiedPrice = price ? (preparedPrices.get(price) ?? null) : null;
  // "verification" sorts after every v1 field. Compose from already canonical
  // bytes rather than walking/freezing the owned price graph again.
  const canonical =
    verifiedPrice === null
      ? evidenceJson
      : `${evidenceJson.slice(0, -1)},"verification":{"priceSnapshot":${verifiedPrice}}}`;
  const values = Object.freeze([
    receipt.intentId,
    receipt.tenantId,
    receipt.requestId,
    receipt.outcome,
    receipt.chargeMinorUnits,
    usageJson,
    receipt.usageDigest,
    receiptDigest,
    receipt.httpStatus,
    verifiedPrice !== null ? 'pending_v2' : succeeded ? 'pending' : 'blocked',
    verifiedPrice,
  ]);
  // Scalar tuple entries alias the receipt graph; only these three strings add distinct retained payload.
  const retainedBytes =
    Buffer.byteLength(canonical) * 2 +
    Buffer.byteLength(usageJson) +
    Buffer.byteLength(verifiedPrice ?? '') +
    Buffer.byteLength(receiptDigest) +
    512;
  preparedReceipts.set(receipt, Object.freeze({ canonical, receiptDigest, values, retainedBytes }));
  return receipt;
}

const SNAPSHOT_KEYS = new Set(['schemaVersion', 'customerPrice', 'maxInputTokens', 'maxOutputTokens']);
const USAGE_KEYS = new Set([
  'inputTotal',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'outputTotal',
  'reasoningOutput',
]);
const PRICE_KEYS = new Set([
  'kind',
  'id',
  'version',
  'publicModelId',
  'publicModelVersion',
  'providerId',
  'productId',
  'protocol',
  'endpoint',
  'currency',
  'commercialPolicyVersion',
  'calculatorVersion',
  'roundingVersion',
  'roundingMode',
  'roundingBoundary',
  'rates',
  'tokenMultipliers',
  'effectiveAt',
  'expiresAt',
  'idempotencyKey',
  'definitionDigest',
  'createdAt',
]);
const RATE_KEYS = new Set([
  'input',
  'output',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'per_unit',
  'per_unit_tiers',
]);
function scalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    if (preparedPrices.has(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Whitelist the retained evidence. Never clone a request, candidate, credential or arbitrary extension. */
export function captureUntrustedFastReceipt(input: FastReceiptInput): { receipt: FastReceiptInput; canonical: string } {
  // Own data before validating: getters or later caller mutation cannot change the facts checked below.
  const proofInput = input.verification?.priceSnapshot;
  input = copyJsonFacts({
    intentId: input.intentId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    outcome: input.outcome,
    chargeMinorUnits: input.chargeMinorUnits,
    usage: input.usage,
    usageDigest: input.usageDigest,
    httpStatus: input.httpStatus,
    ...(proofInput ? { verification: { priceSnapshot: proofInput } } : {}),
  }) as FastReceiptInput;
  if (
    ![input.intentId, input.requestId, input.tenantId].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 256,
    ) ||
    !['succeeded', 'failed', 'unknown'].includes(input.outcome) ||
    !/^[a-f0-9]{64}$/.test(input.usageDigest) ||
    (input.chargeMinorUnits !== null && !decimal(input.chargeMinorUnits)) ||
    (input.httpStatus !== null &&
      (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) ||
    (input.outcome === 'unknown' && input.chargeMinorUnits !== null)
  )
    throw new Error('FAST_RECEIPT_INVALID');
  const usage: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input.usage)) {
    if (!USAGE_KEYS.has(key) || (value !== null && !decimal(value))) throw new Error('FAST_RECEIPT_INVALID');
    usage[key] = value;
  }
  const proof = input.verification?.priceSnapshot;
  if (proof) {
    if (
      !validPriceShape(proof) ||
      input.outcome !== 'succeeded' ||
      input.httpStatus === null ||
      input.httpStatus < 200 ||
      input.httpStatus >= 300 ||
      input.chargeMinorUnits === null ||
      calculateFastReceiptCharge(proof, usage) !== BigInt(input.chargeMinorUnits)
    )
      throw new Error('FAST_RECEIPT_INVALID_PROOF');
  }
  const canonical = fastJournalCanonicalJson({
    intentId: input.intentId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    outcome: input.outcome,
    chargeMinorUnits: input.chargeMinorUnits,
    usage,
    usageDigest: input.usageDigest,
    httpStatus: input.httpStatus,
    ...(proof ? { verification: { priceSnapshot: proof } } : {}),
  });
  // Admission must use the canonical snapshot, not re-read caller-owned getters.
  return { receipt: JSON.parse(canonical) as FastReceiptInput, canonical };
}

function validPriceShape(proof: FastPriceSnapshot): boolean {
  const price = proof.customerPrice;
  return !(
    Object.keys(proof).some(
      (key) => !['schemaVersion', 'customerPrice', 'maxInputTokens', 'maxOutputTokens'].includes(key),
    ) ||
    Object.entries(price).some(([key, value]) => !PRICE_KEYS.has(key) || (key !== 'rates' && !scalar(value))) ||
    price.tokenMultipliers !== null ||
    Object.entries(price.rates).some(
      ([key, rate]) =>
        !RATE_KEYS.has(key) ||
        (rate !== null &&
          (key === 'per_unit' ||
            key === 'per_unit_tiers' ||
            Object.entries(rate).some(
              ([k, v]) => !['numeratorMinorUnits', 'denominatorUnits'].includes(k) || !scalar(v),
            ))),
    )
  );
}
