import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

import { recordQpsRequest } from './qps-feed.js';

/**
 * Phase 3 observability: process-wide Prometheus metrics for the SaaS gateway
 * (design: docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 1).
 *
 * The registry is a module singleton so every mount point (gateway listener,
 * control-plane listener) renders the same process state. Gauges that need a
 * database view (account pool, wallet holds) are never scraped inline;
 * operators refresh them through `refreshSaasRuntimeGauges` right before a
 * scrape so a dead database cannot wedge the /metrics response.
 */

export const SAAS_GATEWAY_REQUESTS_TOTAL = 'saas_gateway_requests_total';
export const SAAS_GATEWAY_ATTEMPT_DURATION_SECONDS = 'saas_gateway_attempt_duration_seconds';
export const SAAS_GATEWAY_INFLIGHT_REQUESTS = 'saas_gateway_inflight_requests';
export const SAAS_PROVIDER_ACCOUNT_POOL = 'saas_provider_account_pool';
export const SAAS_WALLET_ACTIVE_HOLDS = 'saas_wallet_active_holds';

/** Pool gauge states, aligned with the runtime-health and quota-snapshot stores. */
export const SAAS_PROVIDER_POOL_STATES = Object.freeze(['available', 'cooldown', 'quota-paused', 'error'] as const);

export type SaasProviderPoolState = (typeof SAAS_PROVIDER_POOL_STATES)[number];

export interface SaasProviderPoolCounts {
  readonly available: number;
  readonly cooldown: number;
  readonly 'quota-paused': number;
  readonly error: number;
}

let registry: Registry | undefined;
let requestsTotal: Counter<string> | undefined;
let attemptDuration: Histogram<string> | undefined;
let inflightRequests: Gauge<string> | undefined;
let providerAccountPool: Gauge<string> | undefined;
let walletActiveHolds: Gauge<string> | undefined;

function ensureRegistry(): Registry {
  if (registry !== undefined) return registry;
  registry = new Registry();
  requestsTotal = new Counter({
    name: SAAS_GATEWAY_REQUESTS_TOTAL,
    help: 'Gateway HTTP requests by endpoint path and final response status.',
    labelNames: ['endpoint', 'status'] as const,
    registers: [registry],
  });
  attemptDuration = new Histogram({
    name: SAAS_GATEWAY_ATTEMPT_DURATION_SECONDS,
    help: 'Gateway upstream attempt dispatch duration by route.',
    labelNames: ['route'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  });
  inflightRequests = new Gauge({
    name: SAAS_GATEWAY_INFLIGHT_REQUESTS,
    help: 'Gateway requests currently between admission and response close.',
    registers: [registry],
  });
  providerAccountPool = new Gauge({
    name: SAAS_PROVIDER_ACCOUNT_POOL,
    help: 'Provider accounts by provider and scheduling state.',
    labelNames: ['provider', 'state'] as const,
    registers: [registry],
  });
  walletActiveHolds = new Gauge({
    name: SAAS_WALLET_ACTIVE_HOLDS,
    help: 'Active wallet billing holds (reserved plus reconciliation pending).',
    registers: [registry],
  });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/** The shared SaaS metrics registry (created on first use). */
export function getSaasMetricsRegistry(): Registry {
  return ensureRegistry();
}

/** Prometheus text exposition of every registered metric. */
export async function renderSaasMetrics(): Promise<string> {
  return ensureRegistry().metrics();
}

export interface GatewayAttemptOutcome {
  /** Route authority id; empty-string attempts fall back to 'unrouted'. */
  readonly route: string;
  readonly ok: boolean;
  readonly durationMs: number;
}

/**
 * Records one upstream attempt outcome: latency histogram by route plus the
 * in-memory QPS feed. Called once per dispatched attempt.
 */
export function recordGatewayAttemptOutcome(outcome: GatewayAttemptOutcome): void {
  ensureRegistry();
  // Defensive by design: observability must never throw on the dispatch path,
  // including composition seams that omit the route authority id.
  const rawRoute = typeof outcome.route === 'string' ? outcome.route.trim() : '';
  const route = rawRoute.length > 0 ? rawRoute : 'unrouted';
  attemptDuration?.labels(route).observe(Math.max(outcome.durationMs, 0) / 1000);
  recordQpsRequest(route, outcome.ok);
}

/** Counts a finished gateway HTTP request by endpoint and final status code. */
export function recordGatewayRequestEnd(endpoint: string, status: number): void {
  ensureRegistry();
  const normalized =
    endpoint === '/v1/messages' ||
    endpoint === '/v1/chat/completions' ||
    endpoint === '/v1/responses' ||
    endpoint === '/v1/models'
      ? endpoint
      : 'other';
  requestsTotal?.labels(normalized, String(Number.isInteger(status) && status > 0 ? status : 0)).inc();
}

/**
 * Marks a gateway request as in-flight; the returned end callback must be
 * invoked exactly once when the response closes.
 */
export function beginGatewayInflightRequest(): () => void {
  ensureRegistry();
  inflightRequests?.inc();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inflightRequests?.dec();
  };
}

/** Overwrites the per-provider account pool gauge (refreshed before scrape). */
export function setSaasProviderPoolCounts(provider: string, counts: SaasProviderPoolCounts): void {
  ensureRegistry();
  for (const state of SAAS_PROVIDER_POOL_STATES) {
    providerAccountPool?.labels(provider, state).set(counts[state]);
  }
}

/** Drops every pool gauge series for providers absent from the latest refresh. */
export function resetSaasProviderPoolGauge(): void {
  ensureRegistry();
  providerAccountPool?.reset();
}

/** Overwrites the active wallet hold gauge (refreshed before scrape). */
export function setSaasWalletActiveHolds(count: number): void {
  ensureRegistry();
  walletActiveHolds?.set(Math.max(count, 0));
}
