import { Histogram, type Registry } from 'prom-client';
import {
  PREPARED_EVIDENCE_DISPATCH_STAGES,
  type PreparedEvidenceDispatchObserver,
} from '../gateway/prepared-evidence-dispatch-observer.js';
import { getSaasMetricsRegistry } from './metrics.js';

export const SAAS_GATEWAY_DISPATCH_STAGE_DURATION_SECONDS = 'saas_gateway_dispatch_stage_duration_seconds';
const STAGES = new Set<string>(PREPARED_EVIDENCE_DISPATCH_STAGES);
const observers = new WeakMap<Registry, PreparedEvidenceDispatchObserver>();

/** Fixed stages only; transport body delivery and subsequent settlement are separate. */
export function createPreparedEvidenceDispatchMetricsObserver(
  registry: Registry = getSaasMetricsRegistry(),
): PreparedEvidenceDispatchObserver {
  const existing = observers.get(registry);
  if (existing) return existing;
  const stages = new Histogram<'stage' | 'outcome'>({
    name: SAAS_GATEWAY_DISPATCH_STAGE_DURATION_SECONDS,
    help: 'Selected gateway dispatch wait durations by fixed stage; body delivery and subsequent settlement are separate.',
    labelNames: ['stage', 'outcome'],
    buckets: [
      0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10, 60,
    ],
    registers: [registry],
  });
  const observe: PreparedEvidenceDispatchObserver = (observation) => {
    if (
      !observation ||
      !STAGES.has(observation.stage) ||
      (observation.outcome !== 'ok' && observation.outcome !== 'error') ||
      !Number.isFinite(observation.durationMs) ||
      observation.durationMs < 0
    )
      return;
    stages.labels(observation.stage, observation.outcome).observe(observation.durationMs / 1000);
  };
  observers.set(registry, observe);
  return observe;
}
