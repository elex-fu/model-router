import type {
  RequestPreparationFailureCode,
  RequestPreparationInput,
  RequestPreparationResult,
  RequestPreparationStage,
} from './request-preparation-service.js';

export const PREPARATION_FAILURE_OUTCOMES = ['rejected', 'blocked'] as const;
export const PREPARATION_FAILURE_STAGES = [
  'caller',
  'entitlement',
  'authority',
  'payload',
  'admission',
  'attempt',
  'evidence',
  'dispatch',
] as const satisfies readonly RequestPreparationStage[];
export const PREPARATION_FAILURE_CODES = [
  'invalid_input',
  'proxy_key_invalid',
  'proxy_key_disabled',
  'caller_denied',
  'budget_exceeded',
  'entitlement_denied',
  'quota_exceeded',
  'rate_limited',
  'hold_denied',
  'route_denied',
  'account_denied',
  'payload_invalid',
  'payload_bounds_unavailable',
  'capability_unavailable',
  'capability_unsupported',
  'canonicalization_failed',
  'signing_failed',
  'attempt_persistence_failed',
  'evidence_registration_failed',
  'binding_mismatch',
  'idempotency_conflict',
  'idempotency_replay',
  'client_cancelled',
  'dispatch_failed',
  'storage_failure',
] as const satisfies readonly RequestPreparationFailureCode[];

/** No request, model, reason, SQL, or provider material can enter this observation. */
export interface PreparationFailureObservation {
  readonly outcome: (typeof PREPARATION_FAILURE_OUTCOMES)[number];
  readonly stage: RequestPreparationStage;
  readonly code: RequestPreparationFailureCode;
}

export type PreparationFailureObserver = (observation: PreparationFailureObservation) => void;

export function isPreparationFailureObservation(value: unknown): value is PreparationFailureObservation {
  if (!value || typeof value !== 'object') return false;
  const observation = value as Record<string, unknown>;
  return (
    PREPARATION_FAILURE_OUTCOMES.includes(observation.outcome as PreparationFailureObservation['outcome']) &&
    PREPARATION_FAILURE_STAGES.includes(observation.stage as RequestPreparationStage) &&
    PREPARATION_FAILURE_CODES.includes(observation.code as RequestPreparationFailureCode)
  );
}

export interface PreparationFailureObservablePort {
  prepare(input: RequestPreparationInput): Promise<RequestPreparationResult>;
}

/** One shared wrapper serves HTTP and WebSocket rounds; telemetry cannot alter the result. */
export function withPreparationFailureObserver(
  preparation: PreparationFailureObservablePort,
  observer?: PreparationFailureObserver,
): PreparationFailureObservablePort {
  if (!observer) return preparation;
  return {
    async prepare(input) {
      const result = await preparation.prepare(input);
      if (isPreparationFailureObservation(result)) {
        try {
          observer(Object.freeze({ outcome: result.outcome, stage: result.stage, code: result.code }));
        } catch {
          // Observer failures never affect preparation or dispatch authority.
        }
      }
      return result;
    },
  };
}
