import { PlatformApiError, type ReadRequestOptions, request } from './saas-platform-client';

export interface OpsMediaTaskRow {
  readonly kind: 'image' | 'video'; readonly taskId: string; readonly tenantId: string; readonly proxyKeyId: string;
  readonly status: string; readonly statusSource: 'image_lifecycle' | 'video_billing';
  readonly diagnostic: string; readonly requestId: string | null; readonly accountId: string | null;
  readonly financialStatus: string | null; readonly executionState: string | null;
  readonly recovery: { readonly leaseOwner: string | null; readonly leaseEpoch: number; readonly leaseUntil: string | null; readonly nextPollAt: string | null; readonly pollFailures: number; readonly canRequeue: boolean } | null;
  readonly latestRequeue: { readonly auditEventId: string; readonly queuedAt: string } | null;
  readonly createdAt: string; readonly completedAt: string | null; readonly expiresAt: string;
}
export interface OpsMediaTaskPage {
  readonly snapshotAt: string; readonly limit: number; readonly rows: readonly OpsMediaTaskRow[];
  readonly counts: { readonly total: number; readonly processing: number; readonly terminalUnsettled: number; readonly recoveryActive: number; readonly overdue: number };
}
export interface SchedulingHealthRow {
  readonly accountId: string; readonly displayName: string | null; readonly providerId: string;
  readonly accountStatus: string; readonly validationState: string; readonly validationErrorCode: string | null;
  readonly validationCredentialId: string | null;
  readonly windowState: 'admit' | 'sticky_only' | 'paused' | 'off';
  readonly windowFacts: { readonly usageMinorUnits: string; readonly limitMinorUnits: string; readonly reserveMinorUnits: string; readonly windowStart: string } | null;
  readonly thresholdPauseUntil: string | null; readonly thresholdPauseReason: string | null;
  readonly healthState: string | null; readonly healthLastOutcome: string | null; readonly healthCooldownUntil: string | null;
  readonly healthObservedAt: string | null; readonly quotaObservedAt: string | null; readonly quotaFreshness: 'fresh' | 'stale' | 'unobserved';
  readonly probe: { readonly lastResult: string | null; readonly lastRunAt: string | null; readonly nextDueAt: string | null; readonly requestedAt: string | null } | null;
}
export interface SchedulingHealthPage {
  readonly snapshotAt: string; readonly freshnessThresholdSeconds: number; readonly scanned: number; readonly limit: number;
  readonly rows: readonly SchedulingHealthRow[];
  readonly counts: { readonly total: number; readonly paused: number; readonly stickyOnly: number; readonly thresholdPaused: number; readonly unhealthy: number; readonly quotaStale: number };
}
export interface MediaRequeueReceipt {
  readonly status: 'queued' | 'replayed'; readonly auditEventId: string; readonly leaseEpoch: number; readonly queuedAt: string;
}
export interface OperationsDiagnosticsPage {
  readonly snapshotAt: string;
  readonly gatewayCapabilities?: GatewayCapabilityStatus;
  readonly sources: readonly { readonly name: string; readonly observedAt: string | null; readonly observationKind: 'completed_watermark' | 'schedule_claim'; readonly freshness: 'fresh' | 'stale' | 'unobserved' }[];
  readonly alerts: readonly { readonly id: string; readonly name: string; readonly metric: string; readonly triggeredAt: string; readonly resolvedAt: string | null }[];
  readonly financial: { readonly open: string; readonly operatorRequired: string; readonly oldestAt: string | null;
    readonly cases: readonly { readonly caseId: string; readonly tenantId: string; readonly requestId: string; readonly state: string; readonly scanAttempts: number; readonly lastErrorCode: string | null; readonly createdAt: string }[] };
  readonly validation: { readonly queued: string; readonly leased: string; readonly expiredLeases: string; readonly failed: string; readonly oldestQueuedAt: string | null; readonly lastCompletedAt: string | null };
}
export type GatewayCapabilityStatus = { readonly state: 'not-configured' | 'unavailable' } | {
  readonly state: 'available'; readonly observedAt: string;
  readonly readiness: { readonly configurationValid: boolean; readonly fatalReasonCodes: readonly string[];
    readonly capabilities: readonly { readonly capability: string; readonly label: string; readonly kind: string; readonly enabled: boolean; readonly assembled: boolean; readonly verified: boolean; readonly operational: boolean; readonly verificationLevel: 'unverified' | 'mock' | 'live'; readonly reasonCodes: readonly string[]; readonly productIds: readonly string[]; readonly endpointScopes: readonly string[]; readonly unavailableEndpointScopes: readonly string[]; readonly providerId?: string }[] };
};

function invalid(): never { throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营数据响应无效'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : invalid(); }
function text(row: Record<string, unknown>, key: string): string { const v = row[key]; return typeof v === 'string' && v.length > 0 ? v : invalid(); }
function nullableText(row: Record<string, unknown>, key: string): string | null { return row[key] === null ? null : text(row, key); }
function count(row: Record<string, unknown>, key: string): number { const v = row[key]; return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : invalid(); }
function decimal(row: Record<string, unknown>, key: string): string { const v = text(row, key); return /^(0|[1-9][0-9]*)$/.test(v) ? v : invalid(); }
function bool(row: Record<string, unknown>, key: string): boolean { const v = row[key]; return typeof v === 'boolean' ? v : invalid(); }
function date(row: Record<string, unknown>, key: string): string { const v = text(row, key); return Number.isFinite(Date.parse(v)) ? v : invalid(); }
function nullableDate(row: Record<string, unknown>, key: string): string | null { return row[key] === null ? null : date(row, key); }
function choice<T extends string>(row: Record<string, unknown>, key: string, values: readonly T[]): T { const v = text(row, key); return values.includes(v as T) ? v as T : invalid(); }
function query(params: Record<string, string | number | boolean | undefined>): string { const search = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value)); return search.size ? `?${search}` : ''; }
function strings(value: unknown): string[] { return array(value).map(item => typeof item === 'string' ? item : invalid()); }
function parseGateway(value: unknown): GatewayCapabilityStatus {
  const status = record(value);
  if (status.state === 'not-configured' || status.state === 'unavailable') return { state: status.state };
  if (status.state !== 'available') return invalid();
  const readiness = record(status.readiness);
  return { state: 'available', observedAt: date(status, 'observedAt'), readiness: {
    configurationValid: bool(readiness, 'configurationValid'), fatalReasonCodes: strings(readiness.fatalReasonCodes),
    capabilities: array(readiness.capabilities).map(item => { const row = record(item); return {
      capability: text(row, 'capability'), label: text(row, 'label'), kind: choice(row, 'kind', ['provider-bundle', 'media', 'tls-fingerprint']),
      enabled: bool(row, 'enabled'), assembled: bool(row, 'assembled'), verified: bool(row, 'verified'), operational: bool(row, 'operational'),
      verificationLevel: choice(row, 'verificationLevel', ['unverified', 'mock', 'live']), reasonCodes: strings(row.reasonCodes),
      productIds: strings(row.productIds), endpointScopes: strings(row.endpointScopes), unavailableEndpointScopes: strings(row.unavailableEndpointScopes),
      ...(row.providerId === undefined ? {} : { providerId: text(row, 'providerId') }),
    }; }),
  } };
}

function parseMedia(value: unknown): OpsMediaTaskPage {
  const page = record(value); const counts = record(page.counts);
  return { snapshotAt: date(page, 'snapshotAt'), limit: count(page, 'limit'),
    rows: array(page.rows).map(item => { const row = record(item); const recovery = row.recovery === null ? null : record(row.recovery); const audit = row.latestRequeue === null ? null : record(row.latestRequeue);
      return { kind: choice(row, 'kind', ['image', 'video']), taskId: text(row, 'taskId'), tenantId: text(row, 'tenantId'), proxyKeyId: text(row, 'proxyKeyId'),
        status: text(row, 'status'), statusSource: choice(row, 'statusSource', ['image_lifecycle', 'video_billing']), diagnostic: choice(row, 'diagnostic', ['image_processing', 'image_stuck', 'image_failed', 'complete', 'poll_leased', 'poll_overdue', 'poll_waiting', 'billing_skipped']),
        requestId: nullableText(row, 'requestId'), accountId: nullableText(row, 'accountId'), financialStatus: nullableText(row, 'financialStatus'), executionState: nullableText(row, 'executionState'),
        recovery: recovery === null ? null : { leaseOwner: nullableText(recovery, 'leaseOwner'), leaseEpoch: count(recovery, 'leaseEpoch'), leaseUntil: nullableDate(recovery, 'leaseUntil'), nextPollAt: nullableDate(recovery, 'nextPollAt'), pollFailures: count(recovery, 'pollFailures'), canRequeue: bool(recovery, 'canRequeue') },
        latestRequeue: audit === null ? null : { auditEventId: text(audit, 'auditEventId'), queuedAt: date(audit, 'queuedAt') }, createdAt: date(row, 'createdAt'), completedAt: nullableDate(row, 'completedAt'), expiresAt: date(row, 'expiresAt') };
    }), counts: { total: count(counts, 'total'), processing: count(counts, 'processing'), terminalUnsettled: count(counts, 'terminalUnsettled'), recoveryActive: count(counts, 'recoveryActive'), overdue: count(counts, 'overdue') } };
}
function parseScheduling(value: unknown): SchedulingHealthPage {
  const page = record(value); const counts = record(page.counts);
  return { snapshotAt: date(page, 'snapshotAt'), freshnessThresholdSeconds: count(page, 'freshnessThresholdSeconds'), scanned: count(page, 'scanned'), limit: count(page, 'limit'),
    rows: array(page.rows).map(item => { const row = record(item); const fact = row.windowFacts === null ? null : record(row.windowFacts); const probe = row.probe === null ? null : record(row.probe);
      return { accountId: text(row, 'accountId'), displayName: nullableText(row, 'displayName'), providerId: text(row, 'providerId'), accountStatus: text(row, 'accountStatus'), validationState: text(row, 'validationState'), validationErrorCode: nullableText(row, 'validationErrorCode'), validationCredentialId: nullableText(row, 'validationCredentialId'),
        windowState: choice(row, 'windowState', ['admit', 'sticky_only', 'paused', 'off']),
        windowFacts: fact === null ? null : { usageMinorUnits: decimal(fact, 'usageMinorUnits'), limitMinorUnits: decimal(fact, 'limitMinorUnits'), reserveMinorUnits: decimal(fact, 'reserveMinorUnits'), windowStart: date(fact, 'windowStart') },
        thresholdPauseUntil: nullableDate(row, 'thresholdPauseUntil'), thresholdPauseReason: nullableText(row, 'thresholdPauseReason'), healthState: nullableText(row, 'healthState'), healthLastOutcome: nullableText(row, 'healthLastOutcome'), healthCooldownUntil: nullableDate(row, 'healthCooldownUntil'), healthObservedAt: nullableDate(row, 'healthObservedAt'), quotaObservedAt: nullableDate(row, 'quotaObservedAt'), quotaFreshness: choice(row, 'quotaFreshness', ['fresh', 'stale', 'unobserved']),
        probe: probe === null ? null : { lastResult: nullableText(probe, 'lastResult'), lastRunAt: nullableDate(probe, 'lastRunAt'), nextDueAt: nullableDate(probe, 'nextDueAt'), requestedAt: nullableDate(probe, 'requestedAt') } };
    }), counts: { total: count(counts, 'total'), paused: count(counts, 'paused'), stickyOnly: count(counts, 'stickyOnly'), thresholdPaused: count(counts, 'thresholdPaused'), unhealthy: count(counts, 'unhealthy'), quotaStale: count(counts, 'quotaStale') } };
}
function parseDiagnostics(value: unknown): OperationsDiagnosticsPage {
  const page = record(value); const financial = record(page.financial); const validation = record(page.validation);
  return { snapshotAt: date(page, 'snapshotAt'), ...(page.gatewayCapabilities === undefined ? {} : { gatewayCapabilities: parseGateway(page.gatewayCapabilities) }), sources: array(page.sources).map(item => { const row = record(item); return { name: text(row, 'name'), observedAt: nullableDate(row, 'observedAt'), observationKind: choice(row, 'observationKind', ['completed_watermark', 'schedule_claim']), freshness: choice(row, 'freshness', ['fresh', 'stale', 'unobserved']) }; }),
    alerts: array(page.alerts).map(item => { const row = record(item); return { id: text(row, 'id'), name: text(row, 'name'), metric: text(row, 'metric'), triggeredAt: date(row, 'triggeredAt'), resolvedAt: nullableDate(row, 'resolvedAt') }; }),
    financial: { open: decimal(financial, 'open'), operatorRequired: decimal(financial, 'operatorRequired'), oldestAt: nullableDate(financial, 'oldestAt'), cases: array(financial.cases).map(item => { const row = record(item); return { caseId: text(row, 'caseId'), tenantId: text(row, 'tenantId'), requestId: text(row, 'requestId'), state: choice(row, 'state', ['open', 'operator_required']), scanAttempts: count(row, 'scanAttempts'), lastErrorCode: nullableText(row, 'lastErrorCode'), createdAt: date(row, 'createdAt') }; }) },
    validation: { queued: decimal(validation, 'queued'), leased: decimal(validation, 'leased'), expiredLeases: decimal(validation, 'expiredLeases'), failed: decimal(validation, 'failed'), oldestQueuedAt: nullableDate(validation, 'oldestQueuedAt'), lastCompletedAt: nullableDate(validation, 'lastCompletedAt') } };
}
export const platformOpsClient = {
  listOpsMediaTasks(params: { kind?: 'image' | 'video'; limit?: number; includeTerminal?: boolean } = {}, options: ReadRequestOptions = {}): Promise<OpsMediaTaskPage> { return request<unknown>(`/ops/media-tasks${query(params)}`, options).then(parseMedia); },
  listOpsSchedulingHealth(params: { limit?: number; onlyConstrained?: boolean } = {}, options: ReadRequestOptions = {}): Promise<SchedulingHealthPage> { return request<unknown>(`/ops/scheduling-health${query(params)}`, options).then(parseScheduling); },
  diagnostics(options: ReadRequestOptions = {}): Promise<OperationsDiagnosticsPage> { return request<unknown>('/ops/diagnostics', options).then(parseDiagnostics); },
  requeueVideo(input: { taskId: string; tenantId: string; expectedLeaseEpoch: number; reason: string; idempotencyKey: string }): Promise<MediaRequeueReceipt> {
    if (!input.taskId || input.taskId.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(input.taskId) || !input.reason.trim() || input.reason.length > 1000 || !Number.isSafeInteger(input.expectedLeaseEpoch) || input.expectedLeaseEpoch < 0) throw new PlatformApiError(400, 'INVALID_INPUT', '请填写有效的重排原因');
    return request<unknown>(`/ops/media-tasks/video/${encodeURIComponent(input.taskId)}/requeue`, { method: 'POST', idempotencyKey: input.idempotencyKey, body: { tenantId: input.tenantId, expectedLeaseEpoch: input.expectedLeaseEpoch, reason: input.reason.trim() } }).then(value => { const row = record(value); return { status: choice(row, 'status', ['queued', 'replayed']), auditEventId: text(row, 'auditEventId'), leaseEpoch: count(row, 'leaseEpoch'), queuedAt: date(row, 'queuedAt') }; });
  },
};
