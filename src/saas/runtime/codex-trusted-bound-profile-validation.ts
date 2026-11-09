import { CODEX_NATIVE_WS_ENDPOINT } from '../gateway/codex/native-ws-connector.js';
import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import { validatePreparedRequestUsageEnvelope } from '../gateway/usage-envelope-validation.js';
import type { CodexTrustedBoundProfile, CodexTrustedBoundScope } from './codex-trusted-bound-profiles.js';

export const DEFAULT_CODEX_BOUND_APPROVAL_EXPIRY_MARGIN_MS = 300_000;
export const MAX_CODEX_BOUND_PROFILE_VALIDITY_MS = 24 * 60 * 60 * 1000;

export type CodexTrustedBoundProfileValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly path: string; readonly reason: string };

function invalid(path: string, reason: string): CodexTrustedBoundProfileValidationResult {
  return { ok: false, path, reason };
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  );
}

function supportedScope(scope: CodexTrustedBoundScope): boolean {
  if (scope.productId !== 'codex-chatgpt') return false;
  if (scope.operation === 'responses') {
    if (scope.transport === 'http') {
      return scope.endpoint === CODEX_RESPONSES_ENDPOINT && scope.continuationMode === 'full';
    }
    return (
      scope.transport === 'websocket' &&
      scope.endpoint === CODEX_NATIVE_WS_ENDPOINT &&
      ['full', 'canonical-replay', 'remote-history'].includes(scope.continuationMode)
    );
  }
  return (
    scope.operation === 'responses.compact' &&
    scope.transport === 'http' &&
    scope.endpoint === `${CODEX_RESPONSES_ENDPOINT}/compact` &&
    scope.continuationMode === 'compact'
  );
}

/** Static profile semantics plus the optional approval-time validity policy. */
export function validateCodexTrustedBoundProfile(
  profile: CodexTrustedBoundProfile,
  admission?: { readonly nowMs: number; readonly expiryMarginMs: number },
): CodexTrustedBoundProfileValidationResult {
  if (profile === null || typeof profile !== 'object' || profile.scope === null || typeof profile.scope !== 'object') {
    return invalid('profile', 'profile and scope must be objects');
  }
  const scope = profile.scope;
  if (
    !boundedText(scope.endpoint, 512) ||
    !boundedText(scope.productId, 256) ||
    !boundedText(scope.model, 256) ||
    !boundedText(scope.operation, 128) ||
    !supportedScope(scope)
  ) {
    return invalid('scope', 'scope is not a supported Codex endpoint/operation/transport/continuation combination');
  }
  if (
    !boundedText(profile.backendRevision, 256) ||
    !boundedText(profile.evidenceVersion, 128) ||
    !boundedText(profile.evidenceReference, 512)
  ) {
    return invalid('evidence', 'backend revision and evidence identity must be bounded non-empty text');
  }
  if (
    !Number.isSafeInteger(profile.validFromMs) ||
    !Number.isSafeInteger(profile.expiresAtMs) ||
    profile.validFromMs < 0 ||
    profile.validFromMs >= profile.expiresAtMs
  ) {
    return invalid('validity', 'validity timestamps must be ordered non-negative safe integers');
  }
  if (profile.expiresAtMs - profile.validFromMs > MAX_CODEX_BOUND_PROFILE_VALIDITY_MS) {
    return invalid('validity', 'profile validity exceeds the operational maximum');
  }
  if (admission) {
    if (
      !Number.isSafeInteger(admission.nowMs) ||
      !Number.isSafeInteger(admission.expiryMarginMs) ||
      admission.nowMs < 0 ||
      admission.expiryMarginMs < 0
    ) {
      return invalid('validity', 'approval clock and expiry margin are invalid');
    }
    if (admission.nowMs + admission.expiryMarginMs >= profile.expiresAtMs) {
      return invalid('validity', 'profile does not retain the request-timeout expiry margin');
    }
  }
  const usage = validatePreparedRequestUsageEnvelope(profile.bounds);
  if (!usage.ok) return invalid(`bounds.${usage.path}`, usage.reason);
  return { ok: true };
}
