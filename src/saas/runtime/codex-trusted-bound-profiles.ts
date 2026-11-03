import { createHash } from 'node:crypto';
import type { PreparedRequestUsageEnvelope } from '../gateway/prepared-request-evidence-service.js';

export interface CodexTrustedBoundScope {
  readonly endpoint: string;
  readonly productId: string;
  readonly model: string;
  readonly operation: string;
  readonly transport: 'http' | 'websocket';
  readonly continuationMode: 'full' | 'canonical-replay' | 'remote-history' | 'compact';
}
export interface CodexTrustedBoundProfile {
  readonly scope: CodexTrustedBoundScope;
  readonly backendRevision: string;
  readonly evidenceVersion: string;
  readonly evidenceReference: string;
  readonly validFromMs: number;
  readonly expiresAtMs: number;
  readonly bounds: PreparedRequestUsageEnvelope;
}
/**
 * Code-reviewed evidence only. There is deliberately no JSON/config registration
 * path: a deployment operator's assertion cannot prove upstream enforcement.
 * No ChatGPT backend evidence has been admitted, so production starts empty.
 */
const REVIEWED_PROFILES: readonly CodexTrustedBoundProfile[] = Object.freeze([]);

/**
 * Seam over the reviewed-profile registry. Production callers use the frozen
 * empty default; proof suites and reviewed-admission composition inject a
 * resolver built from explicitly code-reviewed profiles. The seam never
 * weakens admission: every method still requires exact scope match and a
 * live validity window.
 */
export interface CodexTrustedBoundProfileResolver {
  /** Exact-scope admission within the profile's validity window. */
  readonly resolve: (
    scope: CodexTrustedBoundScope,
    nowMs?: number,
  ) => { readonly digest: string; readonly profile: CodexTrustedBoundProfile } | null;
  /** Send-time re-validation: the signed compiler version must match the exact scope. */
  readonly sendProfile: (
    version: string,
    compilerVersion: string,
    actual: Omit<CodexTrustedBoundScope, 'continuationMode'>,
    nowMs?: number,
  ) => CodexTrustedBoundProfile | null;
  /** Whether a digest is still admitted and unexpired. */
  readonly isDigestActive: (digest: string, nowMs?: number) => boolean;
  /** Operator-facing readiness summary. */
  readonly readiness: () => { readonly admittedProfileCount: number; readonly reason: string };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') { const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error('Invalid trusted bound profile'); return encoded; }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
export function codexTrustedProfileDigest(profile: CodexTrustedBoundProfile): string {
  const ordered = {
    endpoint: profile.scope.endpoint, productId: profile.scope.productId, model: profile.scope.model,
    operation: profile.scope.operation, transport: profile.scope.transport, continuationMode: profile.scope.continuationMode,
    backendRevision: profile.backendRevision, evidenceVersion: profile.evidenceVersion,
    evidenceReference: profile.evidenceReference, validFromMs: profile.validFromMs, expiresAtMs: profile.expiresAtMs,
    bounds: profile.bounds,
  };
  return createHash('sha256').update(canonical(ordered)).digest('hex');
}
export function createCodexTrustedBoundProfileResolver(
  profiles: readonly CodexTrustedBoundProfile[],
): CodexTrustedBoundProfileResolver {
  const admitted: readonly CodexTrustedBoundProfile[] = Object.freeze([...profiles]);
  return Object.freeze({
    resolve(scope: CodexTrustedBoundScope, nowMs = Date.now()) {
      const profile = admitted.find((candidate) =>
        Object.entries(scope).every(([key, value]) => candidate.scope[key as keyof CodexTrustedBoundScope] === value) &&
        candidate.validFromMs <= nowMs && nowMs < candidate.expiresAtMs,
      );
      return profile ? { profile, digest: codexTrustedProfileDigest(profile) } : null;
    },
    sendProfile(version: string, compilerVersion: string, actual: Omit<CodexTrustedBoundScope, 'continuationMode'>, nowMs = Date.now()) {
      return admitted.find((profile) => profile.validFromMs <= nowMs && nowMs < profile.expiresAtMs &&
        Object.entries(actual).every(([key, value]) => profile.scope[key as keyof CodexTrustedBoundScope] === value) &&
        codexBoundCompilerVersion(compilerVersion, profile) === version) ?? null;
    },
    isDigestActive(digest: string, nowMs = Date.now()) {
      return admitted.some((profile) => profile.validFromMs <= nowMs && nowMs < profile.expiresAtMs && codexTrustedProfileDigest(profile) === digest);
    },
    readiness() {
      return admitted.length === 0
        ? { admittedProfileCount: 0, reason: 'No reviewed endpoint-specific Codex enforcement and metering contract is admitted' }
        : { admittedProfileCount: admitted.length, reason: 'Reviewed Codex enforcement and metering contracts are admitted' };
    },
  });
}
const DEFAULT_RESOLVER: CodexTrustedBoundProfileResolver = createCodexTrustedBoundProfileResolver(REVIEWED_PROFILES);
export function resolveCodexTrustedBoundProfile(scope: CodexTrustedBoundScope, nowMs = Date.now()): {
  readonly digest: string;
  readonly profile: CodexTrustedBoundProfile;
} | null {
  return DEFAULT_RESOLVER.resolve(scope, nowMs);
}
export function isCodexTrustedBoundDigestActive(digest: string, nowMs = Date.now()): boolean {
  return DEFAULT_RESOLVER.isDigestActive(digest, nowMs);
}
export function codexTrustedBoundReadiness(): { readonly admittedProfileCount: number; readonly reason: string } {
  return DEFAULT_RESOLVER.readiness();
}

/** Compact signed compiler version stays within metering's 64-byte version contract. */
export function codexBoundCompilerVersion(compilerVersion: string, profile: CodexTrustedBoundProfile): string {
  return `cb1:${createHash('sha256').update(JSON.stringify({ compilerVersion, trustedBoundEvidenceDigest: codexTrustedProfileDigest(profile) })).digest('base64url')}`;
}
export function resolveCodexBoundCompilerVersion(version: string, compilerVersion: string, scope: CodexTrustedBoundScope, nowMs = Date.now()): CodexTrustedBoundProfile | null {
  const resolved = resolveCodexTrustedBoundProfile(scope, nowMs);
  return resolved && codexBoundCompilerVersion(compilerVersion, resolved.profile) === version ? resolved.profile : null;
}

/** The signed version commits continuation mode; actual transport must match all other scope fields. */
export function resolveCodexBoundSendProfile(version: string, compilerVersion: string, actual: Omit<CodexTrustedBoundScope, 'continuationMode'>, nowMs = Date.now()): CodexTrustedBoundProfile | null {
  return DEFAULT_RESOLVER.sendProfile(version, compilerVersion, actual, nowMs);
}
