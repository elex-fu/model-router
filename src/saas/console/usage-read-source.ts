/**
 * Read-time compatibility only. Fast intents never acquire a legacy request,
 * attempt or usage-event graph. Public metadata comes from immutable authority,
 * not today's route/key/price configuration. $2 is the authorized tenant selector;
 * callers still apply their existing membership predicates to the result.
 */
export function consoleUsageSourceCtes(includeUsage = false): string {
  return `fast_observations AS (
    SELECT i.request_id AS id, i.id AS intent_id, i.tenant_id, i.project_id,
      i.authority_snapshot #>> '{modelResolution,requestedModel}' AS public_model,
      i.authority_snapshot #>> '{route,protocol}' AS protocol,
      CASE WHEN i.currency IS NULL THEN 'byok' ELSE 'platform' END AS supply_mode,
      i.created_at, i.send_deadline, r.outcome, r.http_status,
      r.created_at AS receipt_created_at, r.usage AS receipt_usage,
      r.charge_minor_units AS receipt_charge,
      x.id AS resolution_id, x.kind AS resolution_kind,
      x.created_at AS resolution_created_at, x.usage AS resolution_usage,
      j.state AS job_state, j.completed_at,
      COALESCE(j.state = 'completed' AND j.completed_at IS NOT NULL
        AND (x.id IS NOT NULL OR r.outcome = 'succeeded' OR
          (r.outcome = 'failed' AND r.charge_minor_units = 0 AND r.http_status IS NULL AND r.usage = '{}'::jsonb))
        AND COALESCE(x.charge_minor_units, r.charge_minor_units) <= i.max_cost_minor_units
        AND (
          (COALESCE(x.charge_minor_units, r.charge_minor_units) = 0 AND j.ledger_transaction_id IS NULL)
          OR (COALESCE(x.charge_minor_units, r.charge_minor_units) > 0 AND EXISTS (
            SELECT 1 FROM saas_ledger_transactions AS ledger
            WHERE ledger.id = j.ledger_transaction_id AND ledger.tenant_id = i.tenant_id
              AND ledger.currency = i.currency AND ledger.idempotency_namespace = 'fast-journal-v1'
              AND ledger.business_key = i.id::text AND ledger.source_type = 'billing_settlement'
              AND ledger.amount_minor_units = COALESCE(x.charge_minor_units, r.charge_minor_units)
              AND ledger.metadata_ref = 'fast-intent:' || i.id::text
              AND ledger.price_snapshot_ref = 'fast-price:' || i.id::text
              AND ledger.usage_evidence_ref = CASE WHEN x.id IS NOT NULL
                THEN 'fast-resolution:' || x.id::text || ':' || x.usage_digest
                ELSE 'fast-receipt:' || i.id::text || ':' || r.usage_digest END
          ))
        ), false) AS acknowledged
    FROM saas_fast_gateway_intents AS i
    LEFT JOIN saas_fast_gateway_receipts AS r
      ON r.intent_id = i.id AND r.tenant_id = i.tenant_id AND r.request_id = i.request_id
    LEFT JOIN saas_fast_billing_jobs AS j ON j.intent_id = i.id
    LEFT JOIN saas_fast_gateway_resolutions AS x
      ON x.intent_id = i.id AND x.tenant_id = i.tenant_id AND x.request_id = i.request_id
    WHERE i.tenant_id = $2
      AND EXISTS (
        SELECT 1 FROM saas_api_keys AS key
        WHERE key.tenant_id = i.tenant_id AND key.project_id = i.project_id AND key.id = i.proxy_key_id
      )
  ), fast_requests AS (
    SELECT f.id, f.intent_id, f.tenant_id, f.project_id, f.public_model, f.protocol, f.supply_mode,
      CASE WHEN f.acknowledged AND f.resolution_kind = 'non_execution' THEN 'failed'
        WHEN f.outcome IS NOT NULL THEN f.outcome
        WHEN f.resolution_id IS NOT NULL OR f.send_deadline <= CURRENT_TIMESTAMP THEN 'unknown'
        ELSE 'pending' END AS execution_state,
      CASE WHEN f.supply_mode = 'byok' THEN 'not_applicable'
        WHEN f.acknowledged THEN CASE
          WHEN f.resolution_kind = 'non_execution' OR
            (f.resolution_id IS NULL AND f.outcome = 'failed' AND f.receipt_charge = 0
             AND f.http_status IS NULL AND f.receipt_usage = '{}'::jsonb) THEN 'released'
          ELSE 'settled' END
        WHEN f.job_state IN ('blocked', 'completed') OR f.resolution_id IS NOT NULL
          OR f.outcome IN ('failed', 'unknown') OR (f.outcome IS NULL AND f.send_deadline <= CURRENT_TIMESTAMP)
          THEN 'reconciliation_pending'
        ELSE 'pending' END AS financial_status,
      CASE WHEN f.acknowledged AND f.resolution_kind = 'non_execution' THEN 'resolved'
        WHEN f.outcome = 'unknown' OR (f.outcome IS NULL AND
          (f.resolution_id IS NOT NULL OR f.send_deadline <= CURRENT_TIMESTAMP)) THEN 'pending'
        WHEN f.acknowledged AND f.resolution_id IS NOT NULL THEN 'resolved'
        ELSE 'none' END AS reconciliation_state,
      f.created_at,
      EXISTS (SELECT 1 FROM saas_requests AS duplicate
        WHERE duplicate.tenant_id = f.tenant_id AND duplicate.id = f.id) AS source_conflict,
      GREATEST(f.created_at, f.receipt_created_at, f.resolution_created_at, f.completed_at) AS updated_at
    FROM fast_observations AS f
  ), console_requests AS (
    SELECT r.id, NULL::uuid AS intent_id, r.tenant_id, r.project_id, r.public_model, r.protocol,
      r.supply_mode, r.execution_state, r.financial_status, r.reconciliation_state, r.created_at, r.updated_at, false AS source_conflict
    FROM saas_requests AS r
    WHERE r.tenant_id = $2 AND NOT EXISTS (
      SELECT 1 FROM saas_fast_gateway_intents AS existing
      WHERE existing.tenant_id = r.tenant_id AND existing.request_id = r.id
    )
    UNION ALL
    SELECT f.id, f.intent_id, f.tenant_id, f.project_id, f.public_model, f.protocol,
      f.supply_mode, f.execution_state, f.financial_status, f.reconciliation_state, f.created_at, f.updated_at, f.source_conflict
    FROM fast_requests AS f
  )${includeUsage ? usageCtes() : ''}`;
}

const tokenColumns = [
  ['input_total', 'inputTotal'],
  ['input_uncached', 'inputUncached'],
  ['cache_read', 'cacheRead'],
  ['cache_write', 'cacheWrite'],
  ['cache_write_5m', 'cacheWrite5m'],
  ['cache_write_1h', 'cacheWrite1h'],
  ['output_total', 'outputTotal'],
  ['reasoning_output', 'reasoningOutput'],
] as const;

function usageCtes(): string {
  // Receipt JSON is not a customer payload. Select only bounded decimal counts;
  // malformed/unverified values are missing, not an opportunity to leak JSON.
  const counts = tokenColumns
    .map(
      ([column, key]) => `CASE WHEN (f.usage ->> '${key}') ~ '^[0-9]{1,19}$'
      THEN (f.usage ->> '${key}')::numeric ELSE NULL END AS ${column}`,
    )
    .join(',\n      ');
  return `, fast_usage_facts AS (
    SELECT f.id AS request_id, f.tenant_id,
      CASE WHEN f.acknowledged AND f.resolution_id IS NOT NULL
        THEN 'fast-resolution:' || f.resolution_id::text ELSE 'fast-receipt:' || f.intent_id::text END AS id,
      CASE WHEN f.acknowledged AND f.resolution_id IS NOT NULL
        THEN f.resolution_usage ELSE f.receipt_usage END AS usage,
      CASE WHEN f.acknowledged AND f.resolution_id IS NOT NULL
        THEN f.resolution_created_at ELSE f.receipt_created_at END AS created_at,
      f.supply_mode, f.acknowledged,
      (f.acknowledged AND (f.resolution_kind = 'non_execution' OR
        (f.resolution_id IS NULL AND f.outcome = 'failed' AND f.receipt_charge = 0
         AND f.http_status IS NULL AND f.receipt_usage = '{}'::jsonb))) AS not_billable
    FROM fast_observations AS f
    WHERE f.receipt_created_at IS NOT NULL OR (f.acknowledged AND f.resolution_id IS NOT NULL)
  ), fast_usage_counts AS (
    SELECT f.id, f.request_id, f.tenant_id, f.supply_mode, f.created_at, f.acknowledged, f.not_billable,
      ${counts}
    FROM fast_usage_facts AS f
  ), console_usage_events AS (
    SELECT e.id::text AS id, e.request_id, e.tenant_id, e.supply_mode,
      ${tokenColumns.map(([column]) => `e.${column}`).join(', ')},
      e.status, e.source, e.measurement_kind, e.billable_basis, e.created_at
    FROM saas_usage_events AS e
    WHERE e.tenant_id = $2 AND NOT EXISTS (
      SELECT 1 FROM saas_fast_gateway_intents AS existing
      WHERE existing.tenant_id = e.tenant_id AND existing.request_id = e.request_id
    )
    UNION ALL
    SELECT f.id, f.request_id, f.tenant_id, f.supply_mode,
      ${tokenColumns.map(([column]) => `f.${column}`).join(', ')},
      CASE WHEN f.input_total IS NOT NULL AND f.output_total IS NOT NULL THEN 'reported'
        WHEN ${tokenColumns.map(([column]) => `f.${column} IS NOT NULL`).join(' OR ')} THEN 'partial'
        ELSE 'missing' END AS status,
      'upstream' AS source, 'snapshot' AS measurement_kind,
      CASE WHEN f.not_billable THEN 'not_billable'
        WHEN f.acknowledged AND f.input_total IS NOT NULL AND f.output_total IS NOT NULL THEN 'exact'
        ELSE 'unknown' END AS billable_basis,
      f.created_at
    FROM fast_usage_counts AS f
  )`;
}
