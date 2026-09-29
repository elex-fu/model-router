import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import type { SecretSource } from '../config/v2-schema.js';
import { ControlError, type ControlService } from '../control/service.js';
import type { SQLiteQuotaLedger } from '../quota/ledger.js';
import { quotaPeriod } from '../quota/period.js';
import type { QuotaTimezoneVersions } from '../quota/timezone-versions.js';
import type { RequestFilter, SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord, TrafficSource } from '../telemetry/types.js';
import { AdminRollups, type DailyRollup } from './rollups.js';
import type { AdminRuntimeBridge } from './runtime.js';
import type { AdminAdapters } from './server.js';
import type { ReadTask } from './telemetry-read-worker.js';

interface SnapshotMetadata {
  watermark: { sequence: number; updatedAtMs: number };
  snapshotStartedAtMs: number;
  snapshotCompletedAtMs: number;
  legacyMetadataCount: number;
  legacyWritesTracked: boolean;
  coverageMode?: 'live-minute+detail-tails';
}
interface OverviewRead extends SnapshotMetadata {
  requests: Record<string, number | null>;
  attempts: Record<string, number | null>;
  firstTokenP95Ms: number | null;
  firstTokenP95Status?: 'exact' | 'approximate' | 'unsupported_live_preaggregate';
  recentErrors: Array<{ requestId: string; state: string; status: number | null }>;
}
interface SummaryRead extends SnapshotMetadata {
  requests: Record<string, number | null>;
  attempts: Record<string, number | null>;
  costs: Array<{ currency: string; micros: number }>;
}

function readDetail<T extends SnapshotMetadata>(task: ReadTask): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const sourceMode = __filename.endsWith('.ts');
    const entry = join(__dirname, sourceMode ? 'telemetry-read-worker.ts' : 'telemetry-read-worker.js');
    const worker = new Worker(entry, { workerData: task, execArgv: sourceMode ? ['--require', 'tsx/cjs'] : [] });
    let message: { kind: 'result'; value: T } | { kind: 'error'; message: string } | undefined;
    let failure: Error | undefined;
    worker.on('message', (value) => {
      if (value?.kind === 'perf' && process.env.MODEL_ROUTER_PERF === '1') {
        process.stderr.write(`${JSON.stringify({ kind: 'telemetry-read-perf', ...value.value, workerLifecycleMs: performance.now() - started })}\n`);
        return;
      }
      message = value;
    });
    worker.once('error', (error) => {
      failure = error;
    });
    worker.once('exit', (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Telemetry read worker exited with code ${code}`));
      else if (message?.kind === 'error') reject(new Error(message.message));
      else if (message?.kind === 'result') resolve(message.value);
      else reject(new Error('Telemetry read worker exited without a result'));
    });
  });
}

export function detailFreshness(store: SQLiteTelemetryStore, read: SnapshotMetadata, fromMs: number, toMs: number) {
  const current = store.writeWatermark;
  const stale = current.sequence !== read.watermark.sequence;
  return {
    coverage: read.coverageMode ?? 'exact-detail-snapshot',
    coveredFromMs: fromMs,
    coveredToMs: toMs,
    snapshotSequence: read.watermark.sequence,
    currentSequence: current.sequence,
    snapshotStartedAtMs: read.snapshotStartedAtMs,
    snapshotCompletedAtMs: read.snapshotCompletedAtMs,
    dataUpdatedAtMs: read.watermark.updatedAtMs,
    stale,
    status: stale
      ? ('stale' as const)
      : read.legacyWritesTracked
        ? ('current' as const)
        : ('unverified-legacy' as const),
    legacyMetadataCount: read.legacyMetadataCount,
    legacyWritesTracked: read.legacyWritesTracked,
  };
}

const sources = new Set(['production', 'playground', 'health']);
const states = new Set([
  'received',
  'rejected',
  'admitted',
  'routing',
  'connecting',
  'streaming',
  'nonstream',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function time(value: unknown, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new ControlError(400, 'INVALID_TIME', 'Use ISO8601 time with timezone offset');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ControlError(400, 'INVALID_TIME', 'Invalid timestamp');
  return parsed;
}
function range(input: Record<string, unknown>) {
  const toMs = time(input.to, Date.now());
  const fromMs = time(input.from, toMs - 86_400_000);
  if (fromMs >= toMs || toMs - fromMs > 400 * 86_400_000)
    throw new ControlError(400, 'INVALID_RANGE', 'Time range must be positive and at most 400 days');
  return { fromMs, toMs };
}
function source(value: unknown): TrafficSource | 'all' {
  if (value === undefined || value === 'proxy') return 'production';
  if (value === 'all') return 'all';
  if (typeof value !== 'string' || !sources.has(value))
    throw new ControlError(400, 'INVALID_SOURCE', 'Unknown traffic source');
  return value as TrafficSource;
}
function rejectUnsupported(input: Record<string, unknown>, fields: string[]): void {
  const unsupported = fields.filter((field) => input[field] !== undefined);
  if (unsupported.length)
    throw new ControlError(422, 'FILTER_UNAVAILABLE', 'Filter is not available with this telemetry store', {
      fields: unsupported,
    });
}
function archivedInput(input: Record<string, unknown>): void {
  rejectUnsupported(input, ['keyId', 'upstreamId', 'model', 'protocol', 'currency', 'groupBy']);
}
function archivedTotals(rows: DailyRollup[]) {
  const total = {
    logicalRequests: 0,
    legacyLogRows: 0,
    upstreamAttempts: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
    inProgress: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingUsageAttempts: 0,
    unpricedAttempts: 0,
    dataThrough: null as number | null,
    costByCurrencyMicros: {} as Record<string, number>,
  };
  for (const row of rows) {
    for (const field of [
      'logicalRequests',
      'legacyLogRows',
      'upstreamAttempts',
      'completed',
      'failed',
      'cancelled',
      'rejected',
      'inProgress',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'missingUsageAttempts',
      'unpricedAttempts',
    ] as const)
      total[field] += row[field];
    if (row.dataThrough !== null) total.dataThrough = Math.max(total.dataThrough ?? 0, row.dataThrough);
    for (const [currency, micros] of Object.entries(row.costByCurrencyMicros))
      total.costByCurrencyMicros[currency] = (total.costByCurrencyMicros[currency] ?? 0) + micros;
  }
  return total;
}
const displayCosts = (costs: Record<string, number>) =>
  Object.fromEntries(Object.entries(costs).map(([currency, micros]) => [currency, micros / 1_000_000]));
function usageFilters(
  input: Record<string, unknown>,
  fromMs: number,
  toMs: number,
  selected: TrafficSource | 'all',
  upstreamFilterMode: 'final' | 'attempt' = 'final',
) {
  if (input.currency !== undefined)
    throw new ControlError(422, 'FILTER_UNAVAILABLE', 'Currency filtering requires pricing aggregates');
  const requests = ['started_at_ms>=?', 'started_at_ms<?'];
  const attempts = ['a.started_at_ms>=?', 'a.started_at_ms<?'];
  const requestArgs: Array<string | number> = [fromMs, toMs];
  const attemptArgs: Array<string | number> = [fromMs, toMs];
  const dimensions: { source: string; keyId?: string; upstreamId?: string; model?: string; protocol?: string } = {
    source: selected,
  };
  if (selected !== 'all') {
    requests.push('source=?');
    requestArgs.push(selected);
    attempts.push('r.source=?');
    attemptArgs.push(selected);
  }
  for (const [field, requestColumn, attemptColumn] of [
    ['keyId', 'proxy_key_id', 'r.proxy_key_id'],
    ['upstreamId', 'final_upstream_id', 'a.upstream_id'],
    ['model', 'request_model', 'r.request_model'],
    ['protocol', 'client_protocol', 'r.client_protocol'],
  ] as const) {
    const value = input[field];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 200)
      throw new ControlError(400, 'INVALID_FILTER', `Invalid ${field}`);
    if (field === 'upstreamId' && upstreamFilterMode === 'attempt') {
      requests.push(
        `EXISTS (SELECT 1 FROM attempts filter_attempt WHERE filter_attempt.request_id=r.id AND filter_attempt.upstream_id=?)`,
      );
      requestArgs.push(value);
    } else {
      requests.push(`${requestColumn}=?`);
      requestArgs.push(value);
    }
    if (field === 'upstreamId' && upstreamFilterMode === 'final') {
      attempts.push('r.final_upstream_id=?');
      attemptArgs.push(value);
    } else {
      attempts.push(`${attemptColumn}=?`);
      attemptArgs.push(value);
    }
    dimensions[field] = value;
  }
  return {
    requestWhere: requests.join(' AND '),
    attemptWhere: attempts.join(' AND '),
    requestArgs,
    attemptArgs,
    dimensions,
  };
}
function selectedUpstreamFilterMode(input: Record<string, unknown>): 'final' | 'attempt' {
  const value = input.upstreamFilterMode ?? 'final';
  if (value !== 'final' && value !== 'attempt')
    throw new ControlError(400, 'INVALID_FILTER', 'upstreamFilterMode must be final or attempt');
  return value;
}
interface AggregateRow {
  bucket?: number;
  value?: string | null;
  logicalRequests?: number;
  legacyLogRows?: number;
  upstreamAttempts?: number;
  completed?: number;
  failed?: number;
  cancelled?: number;
  rejected?: number;
  inputTokens?: number;
  outputTokens?: number;
  missingUsageAttempts?: number;
}
const tokenSums = `COUNT(*) AS upstreamAttempts,
  COALESCE(SUM(json_extract(a.usage_json,'$.inputTotal')),0) AS inputTokens,
  COALESCE(SUM(json_extract(a.usage_json,'$.outputTotal')),0) AS outputTokens,
  SUM(CASE WHEN a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
    OR json_extract(a.usage_json,'$.outputTotal') IS NULL THEN 1 ELSE 0 END) AS missingUsageAttempts`;
function combine(requests: AggregateRow[], attempts: AggregateRow[], key: 'bucket' | 'value') {
  const rows = new Map<string, AggregateRow>();
  for (const row of [...requests, ...attempts]) {
    const value = String(row[key] ?? '');
    const previous = rows.get(value);
    rows.set(value, {
      ...previous,
      ...Object.fromEntries(Object.entries(row).filter(([, item]) => item !== undefined)),
      logicalRequests: (previous?.logicalRequests ?? 0) + (row.logicalRequests ?? 0),
      legacyLogRows: (previous?.legacyLogRows ?? 0) + (row.legacyLogRows ?? 0),
      upstreamAttempts: (previous?.upstreamAttempts ?? 0) + (row.upstreamAttempts ?? 0),
    });
  }
  return [...rows.values()].map((row) => ({
    ...row,
    logicalRequests: row.logicalRequests ?? 0,
    legacyLogRows: row.legacyLogRows ?? 0,
    upstreamAttempts: row.upstreamAttempts ?? 0,
    completed: row.completed ?? 0,
    failed: row.failed ?? 0,
    cancelled: row.cancelled ?? 0,
    rejected: row.rejected ?? 0,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    missingUsageAttempts: row.missingUsageAttempts ?? 0,
  }));
}
function cursor(value: unknown): RequestFilter['cursor'] {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string' || value.length > 512) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('startedAtMs' in parsed) ||
      !('id' in parsed) ||
      !Number.isSafeInteger(parsed.startedAtMs) ||
      typeof parsed.id !== 'string'
    )
      throw new Error();
    return { startedAtMs: parsed.startedAtMs as number, id: parsed.id };
  } catch {
    throw new ControlError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
  }
}
const encodeCursor = (value: RequestFilter['cursor'] | null) =>
  value ? Buffer.from(JSON.stringify(value)).toString('base64url') : null;
function redactDiagnostic(
  value: string | null,
  secrets: ReadonlySet<string>,
  resolutionFailed: boolean,
): string | null {
  if (value === null) return null;
  if (resolutionFailed) return '[diagnostic redacted: credential resolution unavailable]';
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}
function requestView(
  request: RequestRecord,
  attempts: AttemptRecord[],
  secrets: ReadonlySet<string>,
  resolutionFailed: boolean,
) {
  const safeAttempts = attempts.map((attempt) => ({
    ...attempt,
    retryReason: redactDiagnostic(attempt.retryReason, secrets, resolutionFailed),
  }));
  const final = safeAttempts.at(-1);
  const missing =
    attempts.length === 0 || attempts.some((attempt) => !attempt.usage || attempt.usage.status === 'missing');
  const inputTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage?.inputTotal ?? 0), 0);
  const outputTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage?.outputTotal ?? 0), 0);
  return {
    ...request,
    requestId: request.id,
    startedAt: new Date(request.startedAtMs).toISOString(),
    keyId: request.proxyKeyId,
    requestedModel: request.requestModel,
    actualModel: final?.resolvedModel ?? null,
    upstreamId: request.finalUpstreamId,
    status: request.state === 'completed' ? 'succeeded' : request.state,
    inputTokens,
    outputTokens,
    usageStatus: missing ? 'missing' : 'reported',
    error:
      request.state === 'failed' ? { code: 'UPSTREAM_ERROR', message: final?.retryReason ?? 'Request failed' } : null,
  };
}
function attemptView(attempt: AttemptRecord, secrets: ReadonlySet<string>, resolutionFailed: boolean) {
  const retryReason = redactDiagnostic(attempt.retryReason, secrets, resolutionFailed);
  return {
    ...attempt,
    retryReason,
    model: attempt.resolvedModel,
    startedAt: new Date(attempt.startedAtMs).toISOString(),
    durationMs: attempt.endedAtMs === null ? null : attempt.endedAtMs - attempt.startedAtMs,
    httpStatus: attempt.status,
    status: attempt.outcome,
    error: attempt.outcome === 'failed' ? { code: 'UPSTREAM_ERROR', message: retryReason ?? 'Attempt failed' } : null,
  };
}

/** Concrete response adapters for the V2 request/attempt and quota stores. */
export function telemetryAdapters(
  store: SQLiteTelemetryStore,
  control: ControlService,
  ledger?: SQLiteQuotaLedger,
  runtime?: AdminRuntimeBridge,
  quotaTimezoneVersions?: QuotaTimezoneVersions,
): AdminAdapters {
  const rollups = new AdminRollups(store.connection);
  const hasLegacy = Boolean(
    store.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_request_metadata'").get(),
  );
  const configuredSecrets = async (): Promise<{ values: Set<string>; failed: boolean }> => {
    try {
      const config = await control.raw();
      const sources: SecretSource[] = [];
      for (const upstream of config.upstreams) {
        sources.push(...upstream.credentials.map((credential) => credential.secret));
        if (upstream.auth.clientSecret) sources.push(upstream.auth.clientSecret);
      }
      const values = new Set<string>();
      for (const source of sources) {
        const value =
          source.type === 'inline'
            ? source.value
            : source.type === 'env'
              ? process.env[source.name]
              : control.store.secrets.get(source.id);
        if (typeof value !== 'string' || value.length === 0) return { values: new Set(), failed: true };
        values.add(value);
      }
      return { values, failed: false };
    } catch {
      return { values: new Set(), failed: true };
    }
  };
  const legacy = hasLegacy ? 'EXISTS (SELECT 1 FROM legacy_request_metadata m WHERE m.request_id=r.id)' : '0';
  return {
    overview: async (input) => {
      const { fromMs, toMs } = range(input);
      if (rollups.classify(fromMs, toMs) === 'archived')
        throw new ControlError(422, 'ARCHIVED_OVERVIEW_UNAVAILABLE', 'Overview requires request detail');
      const selectedSource = source(input.source);
      const read = await readDetail<OverviewRead>({
        kind: 'overview',
        dbPath: store.connection.name,
        fromMs,
        toMs,
        selected: selectedSource,
      });
      const assemblyStarted = performance.now();
      if (rollups.classify(fromMs, toMs) !== 'detail')
        throw new ControlError(409, 'ARCHIVE_CHANGED', 'Archive boundary changed during overview query');
      const observed = detailFreshness(store, read, fromMs, toMs);
      const requests = read.requests;
      const attempts = read.attempts;
      const admittedEnded = requests.admittedEnded ?? 0;
      const admittedCompleted = requests.admittedCompleted ?? 0;
      const unknownAdmissionEnded = requests.unknownAdmissionEnded ?? 0;
      const productionSuccessRate = {
        scope: 'production' as const,
        definition: 'completed / ended admitted production logical requests' as const,
        status:
          unknownAdmissionEnded > 0
            ? ('partial_unknown_admission' as const)
            : admittedEnded === 0
              ? ('no_admitted_ended' as const)
              : ('exact' as const),
        value: unknownAdmissionEnded > 0 || admittedEnded === 0 ? null : admittedCompleted / admittedEnded,
        completed: admittedCompleted,
        endedAdmitted: admittedEnded,
        excludedPreAdmissionRejected: requests.preAdmissionRejected ?? 0,
        unknownAdmissionEnded,
        excludedLegacyLogRows: requests.legacyLogRows ?? 0,
        measurement: read.coverageMode
          ? ('covered_live_minute_plus_detail_tails' as const)
          : ('exact_detail_snapshot' as const),
      };
      const usage = {
        logicalRequests: requests.logicalRequests ?? 0,
        legacyLogRows: requests.legacyLogRows ?? 0,
        completed: requests.completed ?? 0,
        failed: requests.failed ?? 0,
        cancelled: requests.cancelled ?? 0,
        rejected: requests.rejected ?? 0,
        inProgress: requests.inProgress ?? 0,
        upstreamAttempts: attempts.upstreamAttempts ?? 0,
        inputTokens: attempts.inputTokens ?? 0,
        outputTokens: attempts.outputTokens ?? 0,
        missingUsageAttempts: attempts.missingUsageAttempts ?? 0,
        dataThrough: requests.dataThrough,
        partial: Boolean(
          (requests.inProgress ?? 0) ||
            (requests.legacyLogRows ?? 0) ||
            (attempts.missingUsageAttempts ?? 0) ||
            observed.status !== 'current',
        ),
        coverage: read.coverageMode ? 'native-live-minute+detail-tails' : 'native-detail',
        observedAt: read.snapshotCompletedAtMs,
        freshness: observed,
      };
      const config = await control.raw();
      const upstreamHealth = await Promise.all(
        config.upstreams.map(async (item) => {
          const status = await runtime?.getUpstreamStatus?.(item.id);
          return {
            id: item.id,
            name: item.name,
            status: typeof status?.healthStatus === 'string' ? status.healthStatus : 'unknown',
          };
        }),
      );
      const response = {
        logicalRequests: usage.logicalRequests,
        legacyLogRows: usage.legacyLogRows,
        succeeded: usage.completed,
        failed: usage.failed,
        cancelled: usage.cancelled,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        missingUsageRequests: usage.missingUsageAttempts,
        productionSuccessRate,
        firstTokenP95Ms: read.firstTokenP95Ms,
        firstTokenP95Status: read.firstTokenP95Status ?? 'exact',
        upstreamHealth,
        recentErrors: read.recentErrors.map((item) => ({
          requestId: item.requestId,
          message: item.status ? `HTTP ${item.status}` : item.state,
        })),
        usage,
        freshness: observed,
      };
      if (process.env.MODEL_ROUTER_PERF === '1') process.stderr.write(`${JSON.stringify({ kind: 'telemetry-response-perf', endpoint: 'overview', responseAssemblyMs: performance.now() - assemblyStarted, sequence: read.watermark.sequence })}\n`);
      return response;
    },
    usageSummary: async (input) => {
      const { fromMs, toMs } = range(input);
      const selected = source(input.source);
      if (rollups.classify(fromMs, toMs) === 'archived') {
        archivedInput(input);
        const total = archivedTotals(rollups.read(fromMs, toMs, selected));
        return {
          ...total,
          attempts: total.upstreamAttempts,
          missingUsageRequests: null,
          costByCurrency: displayCosts(total.costByCurrencyMicros),
          costByCurrencyMicros: undefined,
          partial: Boolean(
            total.inProgress || total.missingUsageAttempts || total.unpricedAttempts || total.legacyLogRows,
          ),
          observedAt: Date.now(),
          grain: 'utc-day',
          coverage: 'archived',
          freshness: {
            coverage: 'verified-archive',
            coveredFromMs: fromMs,
            coveredToMs: toMs,
            dataThroughMs: total.dataThrough,
            stale: false,
          },
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          source: selected,
        };
      }
      const filters = usageFilters(input, fromMs, toMs, selected);
      const read = await readDetail<SummaryRead>({ kind: 'usageSummary', dbPath: store.connection.name, filters });
      const assemblyStarted = performance.now();
      if (rollups.classify(fromMs, toMs) !== 'detail')
        throw new ControlError(409, 'ARCHIVE_CHANGED', 'Archive boundary changed during usage query');
      const observed = detailFreshness(store, read, fromMs, toMs);
      const { requests, attempts, costs } = read;
      const response = {
        logicalRequests: requests.logicalRequests ?? 0,
        legacyLogRows: requests.legacyLogRows ?? 0,
        legacyMeasurement: 'legacy_log_rows',
        upstreamAttempts: attempts.upstreamAttempts ?? 0,
        attempts: attempts.upstreamAttempts ?? 0,
        completed: requests.completed ?? 0,
        failed: requests.failed ?? 0,
        cancelled: requests.cancelled ?? 0,
        rejected: requests.rejected ?? 0,
        inProgress: requests.inProgress ?? 0,
        inputTokens: attempts.inputTokens ?? 0,
        outputTokens: attempts.outputTokens ?? 0,
        cacheReadTokens: attempts.cacheReadTokens,
        cacheWriteTokens: attempts.cacheWriteTokens,
        missingUsageAttempts: attempts.missingUsageAttempts ?? 0,
        missingUsageRequests: attempts.missingUsageRequests ?? 0,
        unpricedAttempts: attempts.unpricedAttempts ?? 0,
        costByCurrency: Object.fromEntries(costs.map((row) => [row.currency, row.micros / 1_000_000])),
        dataThrough: requests.dataThrough,
        partial: Boolean(
          observed.status !== 'current' ||
            (requests.inProgress ?? 0) ||
            (requests.legacyLogRows ?? 0) ||
            (attempts.missingUsageAttempts ?? 0) ||
            (attempts.unpricedAttempts ?? 0),
        ),
        observedAt: read.snapshotCompletedAtMs,
        grain: 'detail',
        coverage: read.coverageMode ? 'native-live-minute+detail-tails' : 'native-detail',
        freshness: observed,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        source: selected,
      };
      if (process.env.MODEL_ROUTER_PERF === '1') process.stderr.write(`${JSON.stringify({ kind: 'telemetry-response-perf', endpoint: 'usage-summary', responseAssemblyMs: performance.now() - assemblyStarted, sequence: read.watermark.sequence })}\n`);
      return response;
    },
    usageTimeseries: async (input) => {
      rejectUnsupported(input, ['currency', 'groupBy']);
      const { fromMs, toMs } = range(input);
      const selectedSource = source(input.source);
      if (rollups.classify(fromMs, toMs) === 'archived') {
        archivedInput(input);
        if (input.grain !== undefined && input.grain !== 'day')
          throw new ControlError(422, 'ARCHIVE_GRAIN_UNAVAILABLE', 'Archived timeseries supports UTC day only');
        const days = new Map<number, DailyRollup[]>();
        for (const row of rollups.read(fromMs, toMs, selectedSource))
          days.set(row.day, [...(days.get(row.day) ?? []), row]);
        const items = [...days.entries()]
          .sort(([a], [b]) => a - b)
          .map(([day, rows]) => {
            const total = archivedTotals(rows);
            return {
              time: new Date(day).toISOString(),
              requests: total.logicalRequests,
              legacyLogRows: total.legacyLogRows,
              legacyMeasurement: 'legacy_log_rows',
              tokens: total.inputTokens + total.outputTokens,
              errors: total.failed,
              inputTokens: total.inputTokens,
              outputTokens: total.outputTokens,
              upstreamAttempts: total.upstreamAttempts,
              missingUsageAttempts: total.missingUsageAttempts,
              unpricedAttempts: total.unpricedAttempts,
              costByCurrency: displayCosts(total.costByCurrencyMicros),
              partial: Boolean(total.missingUsageAttempts || total.unpricedAttempts || total.legacyLogRows),
              grain: 'utc-day',
              coverage: 'archived',
            };
          });
        return {
          items,
          grain: 'utc-day',
          coverage: 'archived',
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
        };
      }
      const filters = usageFilters(input, fromMs, toMs, selectedSource);
      const grain = input.grain === undefined ? (toMs - fromMs <= 7 * 86_400_000 ? 'hour' : 'day') : input.grain;
      if (grain !== 'hour' && grain !== 'day')
        throw new ControlError(400, 'INVALID_GRAIN', 'grain must be hour or day');
      const width = grain === 'hour' ? 3_600_000 : 86_400_000;
      if (Math.ceil((toMs - fromMs) / width) > 2000)
        throw new ControlError(422, 'TOO_MANY_BUCKETS', 'Select a coarser grain');
      const requests = store.connection
        .prepare(`SELECT CAST(started_at_ms / ? AS INTEGER) AS bucket,
        SUM(NOT (${legacy})) AS logicalRequests,SUM(${legacy}) AS legacyLogRows,
        SUM(NOT (${legacy}) AND state='completed') AS completed,
        SUM(NOT (${legacy}) AND state='failed') AS failed,
        SUM(NOT (${legacy}) AND state='cancelled') AS cancelled,
        SUM(NOT (${legacy}) AND state='rejected') AS rejected
        FROM requests r WHERE ${filters.requestWhere} GROUP BY bucket`)
        .all(width, ...filters.requestArgs) as AggregateRow[];
      const attempts = store.connection
        .prepare(`SELECT CAST(a.started_at_ms / ? AS INTEGER) AS bucket, ${tokenSums}
        FROM attempts a JOIN requests r ON r.id=a.request_id
        WHERE ${filters.attemptWhere} AND NOT (${legacy}) GROUP BY bucket`)
        .all(width, ...filters.attemptArgs) as AggregateRow[];
      const items = combine(requests, attempts, 'bucket')
        .map((row) => ({
          time: new Date(Number(row.bucket) * width).toISOString(),
          requests: row.logicalRequests,
          legacyLogRows: row.legacyLogRows,
          legacyMeasurement: 'legacy_log_rows',
          tokens: row.inputTokens + row.outputTokens,
          errors: row.failed,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          upstreamAttempts: row.upstreamAttempts,
          missingUsageAttempts: row.missingUsageAttempts,
          partial: row.legacyLogRows > 0 || row.missingUsageAttempts > 0,
        }))
        .sort((a, b) => a.time.localeCompare(b.time));
      return {
        items,
        grain,
        coverage: 'native-detail',
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      };
    },
    usageBreakdown: async (input) => {
      rejectUnsupported(input, ['currency', 'grain']);
      const { fromMs, toMs } = range(input);
      if (rollups.classify(fromMs, toMs) === 'archived')
        throw new ControlError(422, 'ARCHIVED_BREAKDOWN_UNAVAILABLE', 'Archived rollups have no dimension breakdown');
      const selectedSource = source(input.source);
      const upstreamFilterMode = selectedUpstreamFilterMode(input);
      const filters = usageFilters(input, fromMs, toMs, selectedSource, upstreamFilterMode);
      const groupBy = input.groupBy === 'upstream' ? 'upstreamId' : (input.groupBy ?? 'upstreamId');
      const columns: Record<string, [string, string]> = {
        keyId: ['proxy_key_id', 'r.proxy_key_id'],
        upstreamId: ['final_upstream_id', 'a.upstream_id'],
        model: ['request_model', 'r.request_model'],
        protocol: ['client_protocol', 'r.client_protocol'],
        source: ['source', 'r.source'],
      };
      if (typeof groupBy !== 'string' || !columns[groupBy])
        throw new ControlError(400, 'INVALID_GROUP_BY', 'groupBy must be keyId, upstreamId, model, protocol or source');
      const [requestColumn, attemptColumn] = columns[groupBy];
      const requests = store.connection
        .prepare(`SELECT ${requestColumn} AS value, SUM(NOT (${legacy})) AS logicalRequests,
        SUM(${legacy}) AS legacyLogRows,
        SUM(NOT (${legacy}) AND state='completed') AS completed,
        SUM(NOT (${legacy}) AND state='failed') AS failed
        FROM requests r WHERE ${filters.requestWhere} GROUP BY ${requestColumn}`)
        .all(...filters.requestArgs) as AggregateRow[];
      const attempts = store.connection
        .prepare(`SELECT ${attemptColumn} AS value, ${tokenSums}
        FROM attempts a JOIN requests r ON r.id=a.request_id
        WHERE ${filters.attemptWhere} AND NOT (${legacy}) GROUP BY ${attemptColumn}`)
        .all(...filters.attemptArgs) as AggregateRow[];
      const costs = store.connection
        .prepare(`SELECT ${attemptColumn} AS value,a.currency,
          COALESCE(SUM(a.cost_micros),0) AS micros,
          SUM(CASE WHEN a.cost_micros IS NULL OR a.currency IS NULL THEN 1 ELSE 0 END) AS unpriced
          FROM attempts a JOIN requests r ON r.id=a.request_id
          WHERE ${filters.attemptWhere} AND NOT (${legacy}) GROUP BY ${attemptColumn},a.currency`)
        .all(...filters.attemptArgs) as Array<{
        value: string | null;
        currency: string | null;
        micros: number;
        unpriced: number;
      }>;
      const costMap = new Map<string, { byCurrency: Record<string, number>; unpriced: number }>();
      for (const row of costs) {
        const id = String(row.value ?? '');
        const value = costMap.get(id) ?? { byCurrency: {}, unpriced: 0 };
        if (row.currency)
          value.byCurrency[row.currency] = (value.byCurrency[row.currency] ?? 0) + row.micros / 1_000_000;
        value.unpriced += row.unpriced;
        costMap.set(id, value);
      }
      const config = await control.raw();
      const requestRowsById = new Map(requests.map((row) => [String(row.value ?? ''), row]));
      const attemptRowsById = new Map(attempts.map((row) => [String(row.value ?? ''), row]));
      const ids = new Set([...requestRowsById.keys(), ...attemptRowsById.keys(), ...costMap.keys()]);
      return [...ids]
        .map((id) => {
          const requestMetrics = requestRowsById.get(id) ?? {};
          const attemptMetrics = attemptRowsById.get(id) ?? {};
          return {
            value: id,
            logicalRequests: requestMetrics.logicalRequests ?? 0,
            legacyLogRows: requestMetrics.legacyLogRows ?? 0,
            completed: requestMetrics.completed ?? 0,
            failed: requestMetrics.failed ?? 0,
            upstreamAttempts: attemptMetrics.upstreamAttempts ?? 0,
            inputTokens: attemptMetrics.inputTokens ?? 0,
            outputTokens: attemptMetrics.outputTokens ?? 0,
            missingUsageAttempts: attemptMetrics.missingUsageAttempts ?? 0,
          };
        })
        .sort((a, b) => b.logicalRequests - a.logicalRequests)
        .slice(0, 100)
        .map((row) => {
          const id = row.value ?? '';
          const prices = costMap.get(id) ?? { byCurrency: {}, unpriced: 0 };
          const currencies = Object.keys(prices.byCurrency);
          const rawLabel =
            groupBy === 'upstreamId'
              ? (config.upstreams.find((item) => item.id === id)?.name ?? id)
              : groupBy === 'keyId'
                ? (config.proxyKeys.find((item) => item.id === id)?.name ?? id)
                : groupBy === 'source'
                  ? (({ production: '生产代理', playground: '测试台', health: '健康检查' } as Record<string, string>)[
                      id
                    ] ?? '未知来源')
                  : id;
          const label =
            rawLabel ||
            (
              {
                keyId: '未关联 Key',
                upstreamId: '未关联上游',
                model: '未知模型',
                protocol: '未知协议',
                source: '未知来源',
              } as Record<string, string>
            )[groupBy];
          return {
            id,
            label,
            metricsSemantics: {
              requests: groupBy === 'upstreamId' ? 'final_upstream_id' : 'request_dimension',
              attempts: groupBy === 'upstreamId' ? 'attempts.upstream_id' : 'attempt_dimension',
              upstreamFilterMode,
            },
            requests: row.logicalRequests,
            requestMetrics: {
              logicalRequests: row.logicalRequests,
              completed: row.completed,
              failed: row.failed,
              legacyLogRows: row.legacyLogRows,
            },
            attemptMetrics: {
              upstreamAttempts: row.upstreamAttempts,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              missingUsageAttempts: row.missingUsageAttempts,
              costByCurrency: prices.byCurrency,
              unpricedAttempts: prices.unpriced,
            },
            legacyLogRows: row.legacyLogRows,
            legacyMeasurement: 'legacy_log_rows',
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            upstreamAttempts: row.upstreamAttempts,
            missingUsageAttempts: row.missingUsageAttempts,
            cost: prices.unpriced === 0 && currencies.length === 1 ? prices.byCurrency[currencies[0]] : null,
            currency: prices.unpriced === 0 && currencies.length === 1 ? currencies[0] : null,
            costByCurrency: prices.byCurrency,
            unpricedAttempts: prices.unpriced,
            partial:
              prices.unpriced > 0 || currencies.length > 1 || row.missingUsageAttempts > 0 || row.legacyLogRows > 0,
          };
        });
    },
    requests: async (input) => {
      const { fromMs, toMs } = range(input);
      if (rollups.classify(fromMs, toMs) === 'archived')
        throw new ControlError(422, 'ARCHIVED_REQUESTS_UNAVAILABLE', 'Archived request detail has been purged');
      const state = input.state ?? input.status;
      if (state !== undefined && (typeof state !== 'string' || !states.has(state)))
        if (state !== 'succeeded') throw new ControlError(400, 'INVALID_STATE', 'Unknown request state');
      const limit = input.limit === undefined ? 50 : Number(input.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new ControlError(400, 'INVALID_LIMIT', 'limit must be 1–200');
      const clauses = ['started_at_ms>=?', 'started_at_ms<?'];
      const args: Array<string | number> = [fromMs, toMs];
      const selectedSource = source(input.source);
      if (selectedSource !== 'all') {
        clauses.push('source=?');
        args.push(selectedSource);
      }
      for (const [field, column] of [
        ['keyId', 'proxy_key_id'],
        ['upstreamId', 'final_upstream_id'],
        ['model', 'request_model'],
        ['protocol', 'client_protocol'],
      ] as const) {
        const value = input[field];
        if (value !== undefined) {
          if (typeof value !== 'string' || value.length > 200)
            throw new ControlError(400, 'INVALID_FILTER', `Invalid ${field}`);
          clauses.push(`${column}=?`);
          args.push(value);
        }
      }
      if (state !== undefined) {
        clauses.push('state=?');
        args.push(state === 'succeeded' ? 'completed' : (state as string));
      }
      const selectedCursor = cursor(input.cursor);
      if (selectedCursor) {
        clauses.push('(started_at_ms<? OR (started_at_ms=? AND id<?))');
        args.push(selectedCursor.startedAtMs, selectedCursor.startedAtMs, selectedCursor.id);
      }
      const ids = store.connection
        .prepare(`SELECT id,started_at_ms AS startedAtMs FROM requests
        WHERE ${clauses.join(' AND ')} ORDER BY started_at_ms DESC,id DESC LIMIT ?`)
        .all(...args, limit + 1) as Array<{ id: string; startedAtMs: number }>;
      const selected = ids.slice(0, limit);
      const secretState = await configuredSecrets();
      const items = await Promise.all(
        selected.map(async ({ id }) => {
          const detail = await store.getRequest(id);
          return detail ? requestView(detail.request, detail.attempts, secretState.values, secretState.failed) : null;
        }),
      );
      const last = selected.at(-1);
      return {
        items: items.filter((item) => item !== null),
        nextCursor: ids.length > limit && last ? encodeCursor({ startedAtMs: last.startedAtMs, id: last.id }) : null,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      };
    },
    requestDetail: async (input) => {
      const detail = await store.getRequest(String(input.requestId));
      if (!detail) throw new ControlError(404, 'NOT_FOUND', 'Request not found');
      const secretState = await configuredSecrets();
      return {
        ...requestView(detail.request, detail.attempts, secretState.values, secretState.failed),
        attempts: detail.attempts.map((attempt) => attemptView(attempt, secretState.values, secretState.failed)),
      };
    },
    requestAttempts: async (input) => {
      const detail = await store.getRequest(String(input.requestId));
      if (!detail) throw new ControlError(404, 'NOT_FOUND', 'Request not found');
      const secretState = await configuredSecrets();
      return detail.attempts.map((attempt) => attemptView(attempt, secretState.values, secretState.failed));
    },
    keyQuota: async (input) => {
      if (!ledger) throw new ControlError(503, 'FEATURE_UNAVAILABLE', 'Quota ledger not connected');
      const keyId = String(input.keyId);
      const config = await control.raw();
      const key = config.proxyKeys.find((item) => item.id === keyId);
      if (!key) throw new ControlError(404, 'NOT_FOUND', 'Key not found');
      const now = Date.now();
      const period = store.connection
        .prepare(`SELECT p.period_id AS periodId,p.start_ms AS startMs,p.end_ms AS endMs,v.timezone AS timezone
        FROM quota_periods p LEFT JOIN quota_timezone_versions v ON v.version_id=p.timezone_version_id
        WHERE p.proxy_key_id=? AND p.start_ms<=? AND p.end_ms>? ORDER BY p.start_ms DESC LIMIT 1`)
        .get(keyId, now, now) as
        | { periodId: string; startMs: number; endMs: number; timezone: string | null }
        | undefined;
      // Read persisted metadata only; viewing quota state must never activate a due version.
      const versions = quotaTimezoneVersions?.list() ?? [];
      const activeTimezone = versions.find((version) => version.state === 'active');
      const pendingTimezone = versions.find((version) => version.state === 'scheduled');
      const forecastTimezone = activeTimezone?.timezone ?? config.quota.timezone;
      const forecast = period ? null : quotaPeriod(now, forecastTimezone, activeTimezone?.versionId);
      const forecastStartMs = forecast
        ? Math.max(forecast.startMs, activeTimezone?.effectiveFromMs ?? forecast.startMs)
        : null;
      const balance = period
        ? await ledger.balance(keyId, period.periodId)
        : { reportedUsed: 0, estimatedUsed: 0, reserved: 0, adjustmentTokens: 0, activeRequests: 0 };
      const rpmUsed = (
        store.connection
          .prepare(`SELECT COUNT(*) AS n FROM quota_admissions WHERE proxy_key_id=? AND admitted_at_ms>?`)
          .get(keyId, Date.now() - 60_000) as { n: number }
      ).n;
      return {
        keyId,
        periodId: period?.periodId ?? null,
        // In the no-ledger-row case these are a forecast only: no quota period is
        // inserted and periodId deliberately remains null, keeping adjustments disabled.
        periodStartMs: period?.startMs ?? forecastStartMs,
        resetAtMs: period?.endMs ?? forecast?.endMs ?? null,
        periodTimezone: period?.timezone ?? (forecast ? forecastTimezone : null),
        activeTimezone: forecastTimezone,
        activeTimezoneVersionId: activeTimezone?.versionId ?? null,
        pendingTimezone: pendingTimezone?.timezone ?? null,
        timezoneChangeEffectiveAtMs: pendingTimezone?.effectiveFromMs ?? null,
        limits: {
          rpm: key.rpm ?? null,
          dailyTokens: key.dailyTokens ?? null,
          maxConcurrentRequests: key.maxConcurrentRequests ?? config.quota.defaultMaxConcurrentRequests,
        },
        rpmUsed,
        ...balance,
      };
    },
    quotaAdjustment: async (input) => {
      if (!ledger) throw new ControlError(503, 'FEATURE_UNAVAILABLE', 'Quota ledger not connected');
      const keyId = String(input.keyId);
      const config = await control.raw();
      if (!config.proxyKeys.some((item) => item.id === keyId))
        throw new ControlError(404, 'NOT_FOUND', 'Key not found');
      const id = input.idempotencyKey;
      const currentPeriod =
        input.periodId === undefined
          ? (store.connection
              .prepare(`SELECT period_id FROM quota_periods
        WHERE proxy_key_id=? AND start_ms<=? AND end_ms>? ORDER BY start_ms DESC LIMIT 1`)
              .get(keyId, Date.now(), Date.now()) as { period_id: string } | undefined)
          : undefined;
      const periodId = input.periodId ?? currentPeriod?.period_id;
      const amount = input.deltaTokens ?? input.amount;
      const reason = input.reason;
      if (
        typeof id !== 'string' ||
        !id ||
        typeof periodId !== 'string' ||
        !periodId ||
        typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        typeof reason !== 'string' ||
        !reason.trim()
      )
        throw new ControlError(
          400,
          'INVALID_ADJUSTMENT',
          'idempotencyKey, periodId, integer deltaTokens and reason are required',
        );
      const existing = store.connection
        .prepare('SELECT proxy_key_id,period_id,delta_tokens,reason FROM quota_adjustments WHERE id=?')
        .get(id) as { proxy_key_id: string; period_id: string; delta_tokens: number; reason: string } | undefined;
      if (
        existing &&
        (existing.proxy_key_id !== keyId ||
          existing.period_id !== periodId ||
          existing.delta_tokens !== amount ||
          existing.reason !== reason)
      )
        throw new ControlError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key has different parameters');
      const period = store.connection
        .prepare('SELECT 1 FROM quota_periods WHERE proxy_key_id=? AND period_id=?')
        .get(keyId, periodId);
      if (!period) throw new ControlError(404, 'PERIOD_NOT_FOUND', 'Quota period not found');
      if (!existing) await ledger.adjust(id, keyId, periodId, amount, reason);
      control.store.audit(String(input.actor), 'quota.adjust', { id, keyId, periodId, deltaTokens: amount, reason });
      return { id, keyId, periodId, deltaTokens: amount, applied: !existing };
    },
  };
}
