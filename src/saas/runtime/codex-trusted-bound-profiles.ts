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
export function resolveCodexTrustedBoundProfile(scope: CodexTrustedBoundScope, nowMs = Date.now()): {
  readonly digest: string;
  readonly profile: CodexTrustedBoundProfile;
} | null {
  const profile = REVIEWED_PROFILES.find((candidate) =>
    Object.entries(scope).every(([key, value]) => candidate.scope[key as keyof CodexTrustedBoundScope] === value) &&
    candidate.validFromMs <= nowMs && nowMs < candidate.expiresAtMs,
  );
  return profile ? { profile, digest: codexTrustedProfileDigest(profile) } : null;
}
export function isCodexTrustedBoundDigestActive(digest: string, nowMs = Date.now()): boolean {
  return REVIEWED_PROFILES.some((profile) => profile.validFromMs <= nowMs && nowMs < profile.expiresAtMs && codexTrustedProfileDigest(profile) === digest);
}
export function codexTrustedBoundReadiness(): { readonly admittedProfileCount: number; readonly reason: string } {
  return { admittedProfileCount: REVIEWED_PROFILES.length, reason: 'No reviewed endpoint-specific Codex enforcement and metering contract is admitted' };
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
  return REVIEWED_PROFILES.find((profile) => profile.validFromMs <= nowMs && nowMs < profile.expiresAtMs &&
    Object.entries(actual).every(([key, value]) => profile.scope[key as keyof CodexTrustedBoundScope] === value) &&
    codexBoundCompilerVersion(compilerVersion, profile) === version) ?? null;
}
