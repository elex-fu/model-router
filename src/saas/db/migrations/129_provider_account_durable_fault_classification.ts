import type { SaasMigration } from './001_initial_schema.js';

/**
 * K2 (R9 run-3 all-4-faulted fail-away): the account-attributable runtime
 * health outcomes. Migration 040 deliberately excluded non-retryable 4xx
 * from the runtime-health vocabulary ("caller validation and non-retryable
 * 4xx outcomes are not runtime evidence"), which was correct for
 * request-attributable 4xx but wrong for the account-attributable ones: a
 * provider 401/403/429 response, or a mid-stream abort of a response the
 * provider had already committed with 200 and ≥1 delivered chunk, is a
 * scheduling fact about the ACCOUNT. With no durable evidence, the
 * scheduler's P17 fail-open fallback (which ignores the in-process hint by
 * design when every candidate is cooled) kept dispatching to faulted
 * accounts for the whole fault window — the R9 chaos all-4-faulted windows
 * measured 31/8/16/42 dispatches against a ≤5 target.
 *
 * This migration extends the two 040 CHECK constraints so the runtime
 * health rows can carry three new gateway outcomes (the probe vocabulary is
 * untouched — probes never classify account access):
 * - gateway_account_access_failure — 401/403 from the provider;
 * - gateway_rate_limited_failure   — 429 from the provider;
 * - gateway_stream_abort_failure   — the upstream body died mid-delivery
 *   after the response had started.
 *
 * Same-table constraint rewrite only (the 088/111 precedent): no data
 * change, no new columns, no new privileges. The store's write SQL gives
 * these outcomes their own SHORT cooldown curves (5/10/15 s for access and
 * stream aborts, a count-only first write then 2/4/8/15 s for rate limits)
 * so a chaos-scale fault window cools the account without walling it past
 * the window; post-window recovery is cooldown expiry → 'degraded' →
 * schedulable, and the first success write resets the row to healthy.
 *
 * Numbered 129: originally authored as 112 on main against the 111 registry
 * head; renumbered to 129 during the capability-parity merge because 112-128
 * are taken by the parallel workstream's migrations (the applied registry
 * head is 128, so this durable fault vocabulary extension appends at 129).
 */
const providerAccountDurableFaultClassificationSql = `
ALTER TABLE saas_provider_account_runtime_health
  DROP CONSTRAINT saas_provider_account_runtime_health_last_outcome_check;
ALTER TABLE saas_provider_account_runtime_health
  ADD CONSTRAINT saas_provider_account_runtime_health_last_outcome_check CHECK (last_outcome IN (
    'gateway_success', 'gateway_network_failure', 'gateway_provider_5xx_failure',
    'gateway_protocol_failure', 'gateway_account_access_failure', 'gateway_rate_limited_failure',
    'gateway_stream_abort_failure', 'probe_success', 'probe_network_failure',
    'probe_provider_5xx_failure', 'probe_protocol_failure'
  ));
ALTER TABLE saas_provider_account_runtime_health
  DROP CONSTRAINT saas_provider_account_runtime_health_outcome_shape;
ALTER TABLE saas_provider_account_runtime_health
  ADD CONSTRAINT saas_provider_account_runtime_health_outcome_shape CHECK (
    (state = 'healthy' AND failure_count = 0
      AND last_outcome IN ('gateway_success', 'probe_success'))
    OR (state = 'cooldown' AND failure_count BETWEEN 1 AND 8
      AND last_outcome IN (
        'gateway_network_failure', 'gateway_provider_5xx_failure', 'gateway_protocol_failure',
        'gateway_account_access_failure', 'gateway_rate_limited_failure', 'gateway_stream_abort_failure',
        'probe_network_failure', 'probe_provider_5xx_failure', 'probe_protocol_failure'
      ))
    OR state IN ('degraded', 'unhealthy')
  );
`;

export const PROVIDER_ACCOUNT_DURABLE_FAULT_CLASSIFICATION_SAAS_MIGRATION: SaasMigration = {
  version: 129,
  name: 'provider_account_durable_fault_classification',
  sql: providerAccountDurableFaultClassificationSql,
};
