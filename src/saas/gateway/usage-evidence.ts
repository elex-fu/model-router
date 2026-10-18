import type { UsageBillingMode, UsageSizeTier } from '../../telemetry/usage.js';
import type { ServiceTierTrustCategory } from '../pricing/service-tier-trust.js';

/**
 * R3 §8.2: the bounded usage-evidence object, produced at the raw
 * upstream-response point. It records HOW the usage observation was made —
 * never credentials, never full user text — so every tier decision and
 * completeness fact is explainable after the fact.
 */

/** The observer that normalized the raw upstream response. */
export type UsageMeteringSource =
  | 'provider-json-usage-observer'
  | 'provider-sse-usage-observer'
  | 'codex-responses-watcher'
  | 'search-observer';

/** Version tags for the observation contracts (frozen with the rules). */
export const PROVIDER_JSON_USAGE_OBSERVER_VERSION = 'provider-json-usage-observer/v2';
export const PROVIDER_SSE_USAGE_OBSERVER_VERSION = 'provider-sse-usage-observer/v2';
export const CODEX_RESPONSES_WATCHER_VERSION = 'codex-responses-watcher/v2';

/**
 * Completeness of the raw observation. SSE completion and client disconnect
 * are distinct outcomes; "incomplete" is never silently converted into a
 * zero-usage report (the settlement coordinator's unknown path retains the
 * hold for reconciliation instead).
 */
export type UsageEvidenceCompleteness =
  | 'complete'
  | 'incomplete-client-disconnect'
  | 'incomplete-truncated'
  | 'incomplete-malformed'
  | 'incomplete-missing'
  | 'incomplete-oversized'
  | 'unknown';

export interface NormalizedUsageEvidence {
  /** Which observer normalized the raw response. */
  readonly meteringSource: UsageMeteringSource;
  readonly observerVersion: string;
  /** Service tier frozen from the FINAL outbound payload (post-transform). */
  readonly outboundServiceTier: string | null;
  /** The tier the response declared, plus whether reports conflicted. */
  readonly serviceTier: TransportServiceTierEvidence | null;
  /** Supply category the tier trust rules are evaluated against. */
  readonly accountKind: ServiceTierTrustCategory | null;
  /** Billing units of the observation (token media counters stay on the usage). */
  readonly billingMode: UsageBillingMode;
  readonly units: string | null;
  readonly sizeTier: UsageSizeTier | null;
  readonly model: string | null;
  readonly operation: string | null;
  readonly completeness: UsageEvidenceCompleteness;
  /** Observation time (ISO-8601, the moment the response stream settled). */
  readonly observedAt: string;
  /** Adapter/transport version that produced the outbound payload. */
  readonly adapterVersion: string | null;
}

/** Bounded, redaction-safe construction: every field is server-derived. */
export function createUsageEvidence(input: {
  readonly meteringSource: UsageMeteringSource;
  readonly observerVersion: string;
  readonly outboundServiceTier?: string | null;
  readonly serviceTier?: TransportServiceTierEvidence | null;
  readonly accountKind?: ServiceTierTrustCategory | null;
  readonly billingMode?: UsageBillingMode | null;
  readonly units?: string | null;
  readonly sizeTier?: UsageSizeTier | null;
  readonly model?: string | null;
  readonly operation?: string | null;
  readonly completeness: UsageEvidenceCompleteness;
  readonly observedAt?: string;
  readonly adapterVersion?: string | null;
}): NormalizedUsageEvidence {
  return {
    meteringSource: input.meteringSource,
    observerVersion: input.observerVersion,
    outboundServiceTier: input.outboundServiceTier ?? null,
    serviceTier: input.serviceTier ?? null,
    accountKind: input.accountKind ?? null,
    billingMode: input.billingMode ?? 'token',
    units: input.units ?? null,
    sizeTier: input.sizeTier ?? null,
    model: input.model ?? null,
    operation: input.operation ?? null,
    completeness: input.completeness,
    observedAt: input.observedAt ?? new Date().toISOString(),
    adapterVersion: input.adapterVersion ?? null,
  };
}

/**
 * Canonical, digest-stable serialization for the settlement proof. Fields are
 * emitted in a fixed order with null sentinels so the same evidence always
 * digests identically. (Deliberately no user text: nothing here can carry
 * request or response content.)
 */
export function usageEvidenceDigestMaterial(evidence: NormalizedUsageEvidence): string {
  const tier = evidence.serviceTier;
  const tierMaterial =
    evidence.outboundServiceTier === null && tier === null
      ? 'null'
      : [
          `outbound=${evidence.outboundServiceTier ?? 'null'}`,
          tier === null
            ? 'terms=null'
            : `terms=${tier.requested ?? 'null'}/${tier.observed ?? 'null'}/conflict=${tier.observedConflict === true}`,
        ].join('&');
  return [
    `source=${evidence.meteringSource}`,
    `observer=${evidence.observerVersion}`,
    `tier=${tierMaterial}`,
    `account=${evidence.accountKind ?? 'null'}`,
    `mode=${evidence.billingMode}`,
    `units=${evidence.units ?? 'null'}`,
    `sizeTier=${evidence.sizeTier ?? 'null'}`,
    `model=${evidence.model ?? 'null'}`,
    `operation=${evidence.operation ?? 'null'}`,
    `completeness=${evidence.completeness}`,
    `observedAt=${evidence.observedAt}`,
    `adapter=${evidence.adapterVersion ?? 'null'}`,
  ].join('|');
}

/** Service-tier terms a transport reports into the dispatch settlement input. */
export interface TransportServiceTierEvidence {
  /** Tier frozen from the FINAL outbound payload (after every transform). */
  readonly requested: string | null;
  /** Tier declared by the upstream response; null when it declared none. */
  readonly observed: string | null;
  /** Multiple response reports disagreed (§8.3: never billed on). */
  readonly observedConflict?: boolean;
}

/**
 * Maps a usage observer's outcome onto the evidence completeness. SSE
 * completion and client disconnect are distinct outcomes, and neither is
 * ever a zero-usage fact.
 */
export function usageEvidenceCompleteness(input: {
  readonly state: 'reported' | 'unknown';
  readonly reason?: string;
}): UsageEvidenceCompleteness {
  if (input.state === 'reported') return 'complete';
  switch (input.reason) {
    case 'cancelled':
      return 'incomplete-client-disconnect';
    case 'truncated':
      return 'incomplete-truncated';
    case 'malformed_body':
    case 'malformed_event':
    case 'invalid_usage':
    case 'conflicting_usage':
      return 'incomplete-malformed';
    case 'no_usage':
      return 'incomplete-missing';
    case 'oversized_body':
    case 'oversized_event':
      return 'incomplete-oversized';
    default:
      return 'unknown';
  }
}

const SERVICE_TIER_NEEDLE = new TextEncoder().encode('"service_tier"');
const MAX_TIER_TEXT_BYTES = 32;

/**
 * R3 §8.2: freezes the tier ACTUALLY SENT upstream. The signed payload bytes
 * are the post-transform truth — after model rewrites, admin payload rules,
 * and category transforms (the Codex and Bedrock transforms strip
 * `service_tier`, so those dispatches correctly freeze null). A cheap byte
 * scan avoids re-parsing payloads that carry no tier at all.
 */
export function outboundServiceTierFromPayload(payloadBytes: Uint8Array): string | null {
  if (payloadBytes.byteLength === 0) return null;
  outer: for (let start = 0; start + SERVICE_TIER_NEEDLE.byteLength <= payloadBytes.byteLength; start += 1) {
    for (let index = 0; index < SERVICE_TIER_NEEDLE.byteLength; index += 1) {
      if (payloadBytes[start + index] !== SERVICE_TIER_NEEDLE[index]) continue outer;
    }
    // The needle appears somewhere; only now pay for the full parse of the
    // (already size-validated) signed payload and read the top-level field.
    try {
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
      const value = (body as Record<string, unknown>).service_tier;
      if (typeof value !== 'string') return null;
      const trimmed = value.trim().toLowerCase();
      if (trimmed === '' || trimmed.length > MAX_TIER_TEXT_BYTES) return null;
      return trimmed;
    } catch {
      return null;
    }
  }
  return null;
}
