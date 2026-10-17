import { createHash, createHmac } from 'node:crypto';
import type { NormalizedUsageExact, UsageValues } from './types.js';

export type HmacSecret = string | Uint8Array;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestClientKey(value: string, hmacSecret?: HmacSecret): string {
  return hmacSecret === undefined
    ? sha256Hex(value)
    : createHmac('sha256', hmacSecret).update(value, 'utf8').digest('hex');
}

/** Accept a caller-provided digest without hashing it twice; otherwise hash the supplied fingerprint material. */
export function normalizeFingerprint(value: string, version = 'v1'): string {
  const normalized = value.trim();
  if (normalized === '') throw new TypeError('requestFingerprint must be non-empty');
  const canonicalVersion = version.trim();
  if (canonicalVersion === '') throw new TypeError('requestFingerprintVersion must be non-empty');
  return SHA256_HEX.test(normalized) ? normalized.toLowerCase() : sha256Hex(`${canonicalVersion}\0${normalized}`);
}

export function canonicalUsage(usage: NormalizedUsageExact): string {
  const base = [
    usage.inputTotal,
    usage.inputUncached,
    usage.cacheRead,
    usage.cacheWrite,
    usage.cacheWrite5m,
    usage.cacheWrite1h,
    usage.outputTotal,
    usage.reasoningOutput,
    usage.status,
    usage.source,
    usage.semanticsVersion,
    usage.measurementKind,
    usage.billableBasis,
  ];
  /*
   * §4.1 (task #15) anti-drift policy, mirroring the #14 per_unit rate
   * policy: the media fields are digest-optional. A token-only usage object
   * (billingMode 'token', units null, sizeTier null) serializes to exactly
   * the pre-4.1 canonical form, so every stored event digest and replay
   * comparison stays byte-identical. Any media fact (non-token mode, unit
   * count, or tier) appends the three fields as one trailing group.
   */
  const billingMode = usage.billingMode ?? 'token';
  const units = usage.units ?? null;
  const sizeTier = usage.sizeTier ?? null;
  const isMedia = billingMode !== 'token' || units !== null || sizeTier !== null;
  if (!isMedia) return JSON.stringify(base);
  return JSON.stringify([...base, billingMode, units, sizeTier]);
}

export function usageEventDigest(
  identity: { tenantId: string; requestId: string; attemptId: string; supplyMode: string },
  usage: NormalizedUsageExact,
): string {
  return sha256Hex(
    JSON.stringify([
      identity.tenantId,
      identity.requestId,
      identity.attemptId,
      identity.supplyMode,
      canonicalUsage(usage),
    ]),
  );
}

export function settlementDigest(input: {
  tenantId: string;
  usageEventId: string;
  kind: string;
  usageEventDigest: string;
}): string {
  return sha256Hex(JSON.stringify([input.tenantId, input.usageEventId, input.kind, input.usageEventDigest]));
}

/** Versioned normal-success proof. The opaque reference is bound, never rehashed or normalized. */
export function normalSuccessSettlementDigest(input: {
  tenantId: string;
  usageEventId: string;
  kind: 'usage_recorded';
  usageEventDigest: string;
  settlementKeyDigest: string;
  usageEvidenceRef: string;
}): string {
  if (!/^[0-9a-f]{64}$/.test(input.usageEvidenceRef)) {
    throw new TypeError('normal-success evidence reference must be an opaque lowercase SHA-256 reference');
  }
  return sha256Hex(
    JSON.stringify([
      'model-router.normal-success-settlement.v1',
      input.tenantId,
      input.usageEventId,
      input.kind,
      input.usageEventDigest,
      input.settlementKeyDigest,
      input.usageEvidenceRef,
    ]),
  );
}

/**
 * Versioned append-only usage-correction proof (contract C-1.2). The signed
 * amount delta is bound as canonical integer text; every correcting field is
 * covered so the unique digest doubles as the idempotency key.
 */
export function usageCorrectionDigest(input: {
  tenantId: string;
  correctedUsageEventId: string;
  correctedSettlementId: string | null;
  reasonCode: string;
  correctionUsage: NormalizedUsageExact;
  amountDeltaMinorUnits: string;
  currency: string;
  operatorIdentity: string;
  evidenceRef: string | null;
}): string {
  return sha256Hex(
    JSON.stringify([
      'model-router.usage-correction.v1',
      input.tenantId,
      input.correctedUsageEventId,
      input.correctedSettlementId,
      input.reasonCode,
      canonicalUsage(input.correctionUsage),
      input.amountDeltaMinorUnits,
      input.currency,
      input.operatorIdentity,
      input.evidenceRef,
    ]),
  );
}

export function canonicalUsageValues(usage: UsageValues): string {
  const base = [
    usage.inputTotal,
    usage.inputUncached,
    usage.cacheRead,
    usage.cacheWrite,
    usage.cacheWrite5m,
    usage.cacheWrite1h,
    usage.outputTotal,
    usage.reasoningOutput,
    usage.status,
    usage.source,
    usage.semanticsVersion,
    usage.measurementKind,
    usage.billableBasis,
  ];
  // §4.1: the same digest-optional media policy as canonicalUsage — a
  // token-only usage object serializes to its exact pre-4.1 form.
  const billingMode = usage.billingMode ?? 'token';
  const units = usage.units ?? null;
  const sizeTier = usage.sizeTier ?? null;
  if (billingMode === 'token' && units === null && sizeTier === null) return JSON.stringify(base);
  return JSON.stringify([...base, billingMode, units, sizeTier]);
}
