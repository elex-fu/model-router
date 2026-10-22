import { performance } from 'node:perf_hooks';

export const PREPARED_EVIDENCE_DISPATCH_STAGES = [
  'preflight',
  'attempt-read',
  'lease-acquire',
  'claim',
  'attempt-transition',
  'transport-send',
  'transport-profile-resolve',
  'transport-provider-dns',
  'transport-proxy-prepare',
  'transport-fixed-headers',
  'transport-credential-prepare',
  'transport-connector-create',
  'transport-fetch-headers',
  'response-delivery',
  'settlement',
  'runtime-health',
  'lease-release',
] as const;

export type PreparedEvidenceDispatchStage = (typeof PREPARED_EVIDENCE_DISPATCH_STAGES)[number];

export interface PreparedEvidenceDispatchObservation {
  readonly stage: PreparedEvidenceDispatchStage;
  readonly durationMs: number;
  readonly outcome: 'ok' | 'error';
}

export type PreparedEvidenceDispatchObserver = (observation: PreparedEvidenceDispatchObservation) => void;

const ignoreDispatchObservation = () => {};

/** A phase may cross a callback boundary; only its first completion is observed. */
export function beginPreparedEvidenceDispatchStage(
  stage: PreparedEvidenceDispatchStage,
  observer: PreparedEvidenceDispatchObserver | undefined,
): (outcome: PreparedEvidenceDispatchObservation['outcome']) => void {
  if (!observer) return ignoreDispatchObservation;
  const started = performance.now();
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    try {
      observer({ stage, durationMs: performance.now() - started, outcome });
    } catch {
      // Diagnostics cannot alter dispatch, authority, or settlement decisions.
    }
  };
}

export async function observePreparedEvidenceDispatchStage<T>(
  stage: PreparedEvidenceDispatchStage,
  observer: PreparedEvidenceDispatchObserver | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!observer) return work();
  const finish = beginPreparedEvidenceDispatchStage(stage, observer);
  let outcome: 'ok' | 'error' = 'error';
  try {
    const result = await work();
    outcome = 'ok';
    return result;
  } finally {
    finish(outcome);
  }
}
