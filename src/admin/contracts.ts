export {
  adminRequestSchemas,
  type AdminRequestSchemaKey,
} from './contracts-schema.js';
import type { UsageSummary } from '../storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord, TrafficSource } from '../telemetry/types.js';

export interface AdminSuccess<T> {
  data: T;
  meta: { requestId: string; observedAt: string; restartRequiredFields?: string[]; nextCursor?: string | null; dataThrough?: string; partial?: boolean };
}
export interface AdminFailure { error: { code: string; message: string; details?: unknown; requestId: string } }
export interface RequestRowData extends RequestRecord {
  requestId: string; startedAt: string; keyId: string | null; requestedModel: string | null; actualModel: string | null;
  upstreamId: string | null; status: string; inputTokens: number; outputTokens: number; usageStatus: string;
}
export type RequestListData = RequestRowData[];
export type RequestDetailData = RequestRowData & { attempts: AttemptRecord[] };
export type RequestAttemptsData = AttemptRecord[];
export interface UsageSummaryData extends UsageSummary {
  attempts: number; cacheReadTokens: number | null; cacheWriteTokens: number | null; missingUsageRequests: number;
  costByCurrency: Record<string, number>; from: string; to: string; source: TrafficSource | 'all';
}
export interface OverviewData {
  usage: UsageSummary; logicalRequests: number; succeeded: number; failed: number; cancelled: number; inputTokens: number;
  outputTokens: number; missingUsageRequests: number; firstTokenP95Ms: number | null;
  firstTokenP95Status?: 'exact' | 'approximate' | 'unsupported_live_preaggregate';
  upstreamHealth: Array<{ id: string; name: string; status: string }>;
  recentErrors: Array<{ requestId: string; message: string }>;
}
export interface UsagePoint { startMs: number; logicalRequests: number; upstreamAttempts: number; completed: number; failed: number; cancelled: number; rejected: number; inputTokens: number; outputTokens: number; missingUsageAttempts: number }
export type UsageTimeseriesData = Array<{ time: string; requests: number; tokens: number; errors: number; inputTokens: number; outputTokens: number; upstreamAttempts: number; missingUsageAttempts: number }>;
export type UsageBreakdownData = Array<{ id: string; label: string; requests: number; inputTokens: number; outputTokens: number; upstreamAttempts: number; missingUsageAttempts: number; cost: null }>;
export type ModelDiscoveryData = Array<{ id: string; source: 'discovered' }>;
export interface AdminJobData { id: string; type: string; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; progress: number; result: unknown | null; error: string | null; createdAt: string; updatedAt: string; resourceId?: string }
export interface JobAcceptedData { jobId: string; state: 'queued' }
export interface UpstreamTestResult { ok: boolean; upstreamId: string; model: string; status: number; durationMs: number; usage: import('../telemetry/usage.js').NormalizedUsage; reportedModel: string | null; error: string | null }
export interface ConnectTemplateData { baseUrl: string; endpoint: string; protocol: 'openai' | 'anthropic' | 'responses'; model: string | null; publishedModels: string[]; headers: Record<string, string>; body: unknown | null; curl: string | null }
export interface KeyQuotaData { keyId: string; periodId: string | null; periodStartMs: number | null; resetAtMs: number | null; periodTimezone: string | null; activeTimezone: string; activeTimezoneVersionId: number | null; pendingTimezone: string | null; timezoneChangeEffectiveAtMs: number | null; limits: { rpm: number | null; dailyTokens: number | null; maxConcurrentRequests: number }; rpmUsed: number; reportedUsed: number; estimatedUsed: number; reserved: number; adjustmentTokens: number; activeRequests: number }
export interface QuotaAdjustmentData { id: string; keyId: string; periodId: string; deltaTokens: number; applied: boolean }
