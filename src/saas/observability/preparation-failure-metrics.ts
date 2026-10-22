import { Counter, type Registry } from 'prom-client';
import {
  isPreparationFailureObservation,
  type PreparationFailureObserver,
} from '../gateway/preparation-failure-observer.js';
import { getSaasMetricsRegistry } from './metrics.js';

export const SAAS_GATEWAY_PREPARATION_FAILURES_TOTAL = 'saas_gateway_preparation_failures_total';
const observers = new WeakMap<Registry, PreparationFailureObserver>();

/** Closed labels identify a failed internal stage without exposing request or provider data. */
export function createPreparationFailureMetricsObserver(
  registry: Registry = getSaasMetricsRegistry(),
): PreparationFailureObserver {
  const existing = observers.get(registry);
  if (existing) return existing;
  const failures = new Counter<'outcome' | 'stage' | 'code'>({
    name: SAAS_GATEWAY_PREPARATION_FAILURES_TOTAL,
    help: 'Gateway preparation failures by fixed internal outcome, stage and failure code.',
    labelNames: ['outcome', 'stage', 'code'],
    registers: [registry],
  });
  const observe: PreparationFailureObserver = (observation) => {
    if (!isPreparationFailureObservation(observation)) return;
    failures.labels(observation.outcome, observation.stage, observation.code).inc();
  };
  observers.set(registry, observe);
  return observe;
}
