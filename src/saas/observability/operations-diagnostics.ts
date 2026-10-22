import type { SaasDatabase } from '../db/types.js';
import type { GatewayCapabilityStatus } from '../runtime/gateway-capability-status.js';

export interface OperationsDiagnosticsPage {
  readonly snapshotAt: string;
  readonly gatewayCapabilities?: GatewayCapabilityStatus;
  readonly sources: readonly {
    readonly name: string;
    readonly observedAt: string | null;
    readonly observationKind: 'completed_watermark' | 'schedule_claim';
    readonly freshness: 'fresh' | 'stale' | 'unobserved';
  }[];
  readonly alerts: readonly {
    readonly id: string;
    readonly name: string;
    readonly metric: string;
    readonly triggeredAt: string;
    readonly resolvedAt: string | null;
  }[];
  readonly financial: {
    readonly open: string;
    readonly operatorRequired: string;
    readonly oldestAt: string | null;
    readonly cases: readonly {
      readonly caseId: string;
      readonly tenantId: string;
      readonly requestId: string;
      readonly state: string;
      readonly scanAttempts: number;
      readonly lastErrorCode: string | null;
      readonly createdAt: string;
    }[];
  };
  readonly validation: {
    readonly queued: string;
    readonly leased: string;
    readonly expiredLeases: string;
    readonly failed: string;
    readonly oldestQueuedAt: string | null;
    readonly lastCompletedAt: string | null;
  };
}

function iso(value: Date | string): string;
function iso(value: Date | string | null): string | null;
function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Bounded operational facts; timestamps describe their source, never an inferred live worker heartbeat. */
export async function getOperationsDiagnosticsPage(database: SaasDatabase): Promise<OperationsDiagnosticsPage> {
  const [watermarks, reports, alerts, financial, cases, validation] = await Promise.all([
    database.query<{ watermark_key: string; last_bucket_at: Date | string }>(
      'SELECT watermark_key, last_bucket_at FROM saas_obs_channel_metrics_watermark',
    ),
    database.query<{ report_type: string; last_run_at: Date | string }>(
      'SELECT report_type, last_run_at FROM saas_obs_report_state',
    ),
    database.query<{
      id: string;
      name: string;
      metric: string;
      triggered_at: Date | string;
      resolved_at: Date | string | null;
    }>(
      `SELECT event.id, rule.name, rule.metric, event.triggered_at, event.resolved_at
         FROM saas_obs_alert_events event JOIN saas_obs_alert_rules rule ON rule.id = event.rule_id
        ORDER BY event.triggered_at DESC LIMIT 20`,
    ),
    database.query<{ open: string; operator_required: string; oldest_at: Date | string | null }>(
      `SELECT count(*) FILTER (WHERE case_state = 'open')::text AS open,
              count(*) FILTER (WHERE case_state = 'operator_required')::text AS operator_required,
              min(created_at) FILTER (WHERE case_state IN ('open', 'operator_required')) AS oldest_at
         FROM saas_unknown_outcome_reconciliation_cases`,
    ),
    database.query<{
      id: string;
      tenant_id: string;
      request_id: string;
      case_state: string;
      scan_attempt_count: number;
      last_error_code: string | null;
      created_at: Date | string;
    }>(
      `SELECT id, tenant_id, request_id, case_state, scan_attempt_count, last_error_code, created_at
         FROM saas_unknown_outcome_reconciliation_cases WHERE case_state IN ('open', 'operator_required')
        ORDER BY (case_state = 'operator_required') DESC, created_at LIMIT 25`,
    ),
    database.query<{
      queued: string;
      leased: string;
      expired_leases: string;
      failed: string;
      oldest_queued_at: Date | string | null;
      last_completed_at: Date | string | null;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::text AS queued,
              count(*) FILTER (WHERE status = 'leased')::text AS leased,
              count(*) FILTER (WHERE status = 'leased' AND lease_until <= clock_timestamp())::text AS expired_leases,
              count(*) FILTER (WHERE status = 'failed')::text AS failed,
              min(created_at) FILTER (WHERE status = 'queued') AS oldest_queued_at,
              max(completed_at) AS last_completed_at
         FROM saas_platform_provider_credential_validation_jobs`,
    ),
  ]);
  const now = Date.now();
  const watermarkMap = new Map(watermarks.rows.map((row) => [row.watermark_key, iso(row.last_bucket_at)]));
  const sources: OperationsDiagnosticsPage['sources'][number][] = ['channel_metrics_1m', 'channel_metrics_hourly'].map(
    (name) => {
      const observedAt = watermarkMap.get(name) ?? null;
      const thresholdMs = name === 'channel_metrics_hourly' ? 2 * 3600_000 : 5 * 60_000;
      return {
        name,
        observedAt,
        observationKind: 'completed_watermark',
        freshness: observedAt === null ? 'unobserved' : now - Date.parse(observedAt) > thresholdMs ? 'stale' : 'fresh',
      };
    },
  );
  const reportMap = new Map(reports.rows.map((row) => [row.report_type, iso(row.last_run_at)]));
  for (const name of ['daily_summary', 'weekly_summary', 'error_digest', 'account_health']) {
    const observedAt = reportMap.get(name) ?? null;
    const thresholdMs =
      name === 'weekly_summary'
        ? 8 * 86400_000
        : name === 'daily_summary' || name === 'account_health'
          ? 2 * 86400_000
          : 2 * 3600_000;
    sources.push({
      name,
      observedAt,
      observationKind: 'schedule_claim',
      freshness: observedAt === null ? 'unobserved' : now - Date.parse(observedAt) > thresholdMs ? 'stale' : 'fresh',
    });
  }
  const f = financial.rows[0];
  const v = validation.rows[0];
  return {
    snapshotAt: new Date(now).toISOString(),
    sources,
    alerts: alerts.rows.map((row) => ({
      id: row.id,
      name: row.name,
      metric: row.metric,
      triggeredAt: iso(row.triggered_at),
      resolvedAt: iso(row.resolved_at),
    })),
    financial: {
      open: f?.open ?? '0',
      operatorRequired: f?.operator_required ?? '0',
      oldestAt: iso(f?.oldest_at ?? null),
      cases: cases.rows.map((row) => ({
        caseId: row.id,
        tenantId: row.tenant_id,
        requestId: row.request_id,
        state: row.case_state,
        scanAttempts: row.scan_attempt_count,
        lastErrorCode: row.last_error_code,
        createdAt: iso(row.created_at),
      })),
    },
    validation: {
      queued: v?.queued ?? '0',
      leased: v?.leased ?? '0',
      expiredLeases: v?.expired_leases ?? '0',
      failed: v?.failed ?? '0',
      oldestQueuedAt: iso(v?.oldest_queued_at ?? null),
      lastCompletedAt: iso(v?.last_completed_at ?? null),
    },
  };
}
