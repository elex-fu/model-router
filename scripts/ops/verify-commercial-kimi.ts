import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PlatformWalletLedgerService } from '../../src/saas/billing/service.js';
import { SaasCatalogService } from '../../src/saas/catalog/service.js';
import { resolveSaasDatabasePreparedStatements, SAAS_DATABASE_PREPARED_STATEMENTS_ENV } from '../../src/saas/db/database.js';
import { createSaasDatabase } from '../../src/saas/db/index.js';
import type { SaasDatabase } from '../../src/saas/db/types.js';
import {
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  parseDeploymentConfig,
} from '../../src/saas/deployment.js';
import {
  canonicalContractAttestationPayload,
  type CommercialMeteringDimension,
  type CustomerMeteringPolicyDefinition,
  type ProviderMeteringPolicyDefinition,
  SaasCommercialMeteringPolicyService,
} from '../../src/saas/gateway/commercial-metering-policy-service.js';
import { SaasProjectInferencePolicyService } from '../../src/saas/gateway/project-policy-service.js';
import {
  isPreparationFailureObservation,
  type PreparationFailureObservation,
} from '../../src/saas/gateway/preparation-failure-observer.js';
import { SaasRouteConfigService } from '../../src/saas/gateway/route-config-service.js';
import { SaasIdentityService } from '../../src/saas/identity/service.js';
import { PostgresSupplyProfileResolver } from '../../src/saas/keys/resolver.js';
import { KeyService } from '../../src/saas/keys/service.js';
import { SaasPricingService } from '../../src/saas/pricing/service.js';
import { createProviderCredentialSealingKms } from '../../src/saas/runtime/software-provider-credential-kms.js';
import { ProviderSupplyService } from '../../src/saas/supply/service.js';

// This helper provisions disposable test inventory. The real gateway and the
// onboarding worker are separate processes running dist/cli/index.js. The only
// local security substitute is the explicit pilot software KMS; this is never
// evidence of a production KMS or of production supplier resale permission.
export const KIMI_COMMERCIAL_REQUIRED = 'RUN_KIMI_COMMERCIAL_LIVE';
export const KIMI_COMMERCIAL_URLS = {
  migrator: 'MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL',
  controlPlane: 'MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL',
  gateway: 'MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL',
  worker: 'MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL',
} as const;
export const INITIAL_WALLET = 1_000_000n;
export const KIMI_COMMERCIAL_WINDOW_CAPACITY = Object.freeze({
  maxInputTokens: 131_072, maxOutputTokens: 512, matrixRequests: 8, tokensPerMinute: 2_000_000,
});
export const KIMI_COMMERCIAL_MATRIX_TOKEN_CEILING = KIMI_COMMERCIAL_WINDOW_CAPACITY.matrixRequests *
  (KIMI_COMMERCIAL_WINDOW_CAPACITY.maxInputTokens + KIMI_COMMERCIAL_WINDOW_CAPACITY.maxOutputTokens);
// One minute can retain every conservative reservation while the sequential
// live matrix completes; this arithmetic contract also covers the customer key.
assert.ok(KIMI_COMMERCIAL_MATRIX_TOKEN_CEILING <= KIMI_COMMERCIAL_WINDOW_CAPACITY.tokensPerMinute,
  'The full bounded Kimi matrix must fit one disposable fixture capacity window');
export type JsonObject = Record<string, unknown>;
export type ClientProtocol = 'openai' | 'anthropic';
export type KimiCommercialFixtureMode = 'live-built-cli' | 'source-diagnostic';
export const KIMI_NATIVE_USAGE_DIMENSIONS = ['input_total', 'input_uncached', 'cache_read', 'cache_write',
  'cache_write_5m', 'cache_write_1h', 'output_total', 'reasoning_output'] as const satisfies readonly CommercialMeteringDimension[];

export interface DurableKimiRequest {
  request_id: string;
  execution_state: string;
  financial_status: string;
  unknown_reason: string | null;
  dispatch_state: string;
  result_state: string;
  account_id: string;
  response_started: boolean;
  usage_source: string | null;
  input_total: string | null;
  output_total: string | null;
  usage_count: string;
  attempt_count: string;
  settlement_count: string;
  reservation_state: string | null;
  settlement_amount: string | null;
  ledger_amount: string | null;
  ledger_source: string | null;
  ledger_entries: string;
  ledger_credit: string;
  ledger_debit: string;
  snapshot_price_version: string | null;
  supplier_cost_version: string | null;
  canonical_request_id: string;
  held_leases: string;
}

export interface KimiCommercialFixture {
  readonly fixtureMode: KimiCommercialFixtureMode;
  readonly postgresPreparedStatements: 'off' | 'native';
  readonly database: SaasDatabase;
  readonly controlPlaneDatabase: SaasDatabase;
  readonly tenantId: string;
  readonly projectId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly publicModel: string;
  readonly customerKey: string;
  readonly gatewayOrigin: string;
  readonly tempDirectory: string;
  readonly prices: Readonly<Record<ClientProtocol, string>>;
  readonly supplierCosts: Readonly<Record<ClientProtocol, string>>;
  readonly workerEnvironment: NodeJS.ProcessEnv;
  readonly gatewayEnvironment: NodeJS.ProcessEnv;
  readonly started: ChildProcess[];
  close(): Promise<void>;
}

const SAFE_API_CODES = [
  'AUTHENTICATION_UNAVAILABLE', 'PREPARATION_UNAVAILABLE', 'REQUEST_BLOCKED', 'GATEWAY_UNAVAILABLE',
  'DISPATCH_FAILED', 'DISPATCH_OUTCOME_UNKNOWN', 'REQUEST_REJECTED', 'UNAUTHENTICATED',
  'PAYMENT_REQUIRED', 'RATE_LIMITED', 'CAPABILITY_UNSUPPORTED', 'CAPABILITY_NOT_ASSEMBLED',
  'INVALID_BODY', 'BODY_TOO_LARGE', 'INVALID_IDEMPOTENCY_KEY', 'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_REPLAY_UNAVAILABLE', 'UNSUPPORTED_MEDIA_TYPE', 'INVALID_PATH', 'METHOD_NOT_ALLOWED',
] as const;
const SAFE_PREPARATION_CODES = [
  'invalid_input', 'proxy_key_invalid', 'proxy_key_disabled', 'caller_denied', 'budget_exceeded',
  'entitlement_denied', 'quota_exceeded', 'rate_limited', 'hold_denied', 'route_denied', 'account_denied',
  'payload_invalid', 'payload_bounds_unavailable', 'capability_unavailable', 'capability_unsupported',
  'canonicalization_failed', 'signing_failed', 'attempt_persistence_failed', 'evidence_registration_failed',
  'binding_mismatch', 'idempotency_conflict', 'idempotency_replay', 'client_cancelled', 'dispatch_failed', 'storage_failure',
] as const;
const SAFE_PREPARATION_STAGES = ['caller', 'entitlement', 'authority', 'payload', 'admission', 'attempt', 'evidence', 'dispatch'] as const;
const SAFE_SQLSTATES = ['08006', '0A000', '22023', '22P02', '23502', '23503', '23505', '23514', '25P02',
  '28P01', '40001', '40P01', '42501', '42703', '42883', '42P01', '55000', '57014', '57P01', 'XX000'] as const;

function fixedValue(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}
function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^(?:(?:gateway|managed)_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

const RAW_USAGE_COUNTERS = ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens',
  'cache_read_input_tokens', 'cache_creation_input_tokens', 'cached_tokens', 'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens', 'reasoning_tokens'] as const;
const RAW_USAGE_DETAILS = {
  cache_creation: ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'],
  input_tokens_details: ['cached_tokens'], output_tokens_details: ['reasoning_tokens'],
  prompt_tokens_details: ['cached_tokens'], completion_tokens_details: ['reasoning_tokens'],
} as const;
/** Numeric usage only: no completion content, IDs, model strings or arbitrary provider fields. */
export function projectKimiNumericUsage(value: unknown): JsonObject {
  if (!record(value)) return {};
  const projected: JsonObject = {};
  const numeric = (counter: unknown): counter is number => typeof counter === 'number' && Number.isFinite(counter) && Math.abs(counter) <= Number.MAX_SAFE_INTEGER;
  for (const name of RAW_USAGE_COUNTERS) if (numeric(value[name])) projected[name] = value[name];
  for (const [name, fields] of Object.entries(RAW_USAGE_DETAILS)) {
    const detail = value[name];
    if (!record(detail)) continue;
    const selected: JsonObject = {};
    for (const field of fields) if (numeric(detail[field])) selected[field] = detail[field];
    if (Object.keys(selected).length > 0) projected[name] = selected;
  }
  return projected;
}

/** Exact metadata values confirmed by the isolated native Kimi control; all other strings are discarded. */
export function projectKimiKnownUsageMetadata(value: unknown) {
  const usage = record(value) ? value : {};
  const field = (name: string, allowed: readonly string[]) => {
    const present = Object.hasOwn(usage, name);
    const raw = usage[name];
    const selected = fixedValue(raw, allowed);
    return { present, type: !present ? 'missing' : raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
      value: selected, unknownEnum: typeof raw === 'string' && selected === null,
      stringLength: typeof raw === 'string' ? raw.length : null };
  };
  return { service_tier: field('service_tier', ['standard']), inference_geo: field('inference_geo', ['not_available']) };
}

/** Anthropic native input_tokens excludes the independently reported cache buckets. */
export function assertKimiNativeUsageMatchesDurable(row: DurableKimiRequest, observations: readonly JsonObject[]): void {
  const usage = Object.assign({}, ...observations) as JsonObject;
  const required = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
  for (const field of required) assert.ok(typeof usage[field] === 'number' && Number.isSafeInteger(usage[field]) && Number(usage[field]) >= 0,
    `Native Kimi raw usage must include the valid ${field} counter`);
  const input = BigInt(usage.input_tokens as number) + BigInt(usage.cache_read_input_tokens as number) + BigInt(usage.cache_creation_input_tokens as number);
  assert.equal(row.input_total, input.toString(), 'Normalized input total must include declared native cache tokens exactly once');
  assert.equal(row.output_total, BigInt(usage.output_tokens as number).toString(), 'Normalized output total must equal declared native output');
}

function safeDecimal(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(value) ? value : null;
}
export function projectDurableKimiSettlement(row: DurableKimiRequest | undefined) {
  if (!row) return { found: false };
  return { found: true, request_id: safeRequestId(row.request_id),
    execution_state: fixedValue(row.execution_state, ['pending', 'succeeded', 'failed', 'unknown']),
    financial_status: fixedValue(row.financial_status, ['not_applicable', 'pending', 'settled', 'released', 'reconciliation_pending']),
    unknown_reason: row.unknown_reason === null ? null : fixedValue(row.unknown_reason, ['usage_missing', 'usage_untrusted', 'settlement_failed', 'dispatch_uncertain', 'client_cancelled', 'lease_lost']) ?? 'unrecognized',
    dispatch_state: fixedValue(row.dispatch_state, ['not_sent', 'dispatching', 'sent', 'unknown']),
    result_state: fixedValue(row.result_state, ['pending', 'succeeded', 'failed', 'unknown']),
    response_started: row.response_started === true,
    usage_source: fixedValue(row.usage_source, ['upstream', 'local-estimate', 'legacy']),
    input_total: safeDecimal(row.input_total), output_total: safeDecimal(row.output_total),
    usage_count: safeDecimal(row.usage_count), attempt_count: safeDecimal(row.attempt_count),
    settlement_count: safeDecimal(row.settlement_count),
    reservation_state: fixedValue(row.reservation_state, ['reserved', 'settled', 'released', 'reconciliation_pending']),
    settlement_amount: safeDecimal(row.settlement_amount), ledger_amount: safeDecimal(row.ledger_amount),
    ledger_source: fixedValue(row.ledger_source, ['billing_settlement']), ledger_entries: safeDecimal(row.ledger_entries),
    ledger_credit: safeDecimal(row.ledger_credit), ledger_debit: safeDecimal(row.ledger_debit),
    canonical_request_id: safeRequestId(row.canonical_request_id), held_leases: safeDecimal(row.held_leases) };
}
interface KimiSettlementDiagnostic {
  requestId: string;
  /** rawUsage is a legacy field name; the capture point identifies its authority. */
  usageCapturePoint?: 'native-provider-passthrough' | 'client-after-protocol-bridge' | 'unclassified-client-response';
  rawUsage: JsonObject[];
  knownUsageMetadata?: ReturnType<typeof projectKimiKnownUsageMetadata>;
  envelope?: { nativeMessage: boolean; assistantRole: boolean; contentArray: boolean; nonemptyStopReason: boolean;
    errorAbsent: boolean; bodyBytes: number; eof: boolean; jsonContentType: boolean };
  usageShape?: { unknownNativeKeyCount: number; knownUnsupportedNativeKeys: string[]; presentKnownCounterKeys: string[];
    cacheReadCounterPresent: boolean; cacheCreationCounterPresent: boolean };
  states: ReturnType<typeof projectDurableKimiSettlement>[];
  failure?: { exception: string; code: string | null };
  postgres?: Awaited<ReturnType<typeof readOwnedPostgresFailureCodes>>;
  financial?: Record<string, string | null>;
}
const kimiSettlementDiagnostics = new WeakMap<KimiCommercialFixture, Map<string, KimiSettlementDiagnostic>>();
function settlementDiagnostic(fixture: KimiCommercialFixture, requestId: string): KimiSettlementDiagnostic {
  const diagnostics = kimiSettlementDiagnostics.get(fixture) ?? new Map<string, KimiSettlementDiagnostic>();
  const id = safeRequestId(requestId) ?? 'unrecognized-request-id';
  let diagnostic = diagnostics.get(id);
  if (!diagnostic) {
    diagnostic = { requestId: id, rawUsage: [], states: [] };
    if (diagnostics.size < 32) diagnostics.set(id, diagnostic);
  }
  kimiSettlementDiagnostics.set(fixture, diagnostics);
  return diagnostic;
}
export function readKimiSettlementDiagnostics(fixture: KimiCommercialFixture) {
  return [...(kimiSettlementDiagnostics.get(fixture)?.values() ?? [])];
}
export function captureKimiNumericUsage(fixture: KimiCommercialFixture, response: Response, body: unknown): void {
  const id = safeRequestId(response.headers.get('x-request-id'));
  if (!id || !record(body)) return;
  const usage = record(body.usage) ? body.usage : record(body.message) && record(body.message.usage) ? body.message.usage : undefined;
  if (!usage) return;
  const diagnostic = settlementDiagnostic(fixture, id);
  diagnostic.usageCapturePoint = body.type === 'message' || body.type === 'message_start' || body.type === 'message_delta'
    ? 'native-provider-passthrough'
    : Array.isArray(body.choices) || body.object === 'chat.completion' || body.object === 'chat.completion.chunk'
      ? 'client-after-protocol-bridge'
      : 'unclassified-client-response';
  const projected = projectKimiNumericUsage(usage);
  diagnostic.usageShape = { unknownNativeKeyCount: Object.keys(usage).filter((key) => !['input_tokens', 'output_tokens',
    'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'speed'].includes(key)).length,
    knownUnsupportedNativeKeys: [...RAW_USAGE_COUNTERS, ...Object.keys(RAW_USAGE_DETAILS), 'server_tool_use', 'service_tier', 'inference_geo']
      .filter((key) => !['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation'].includes(key) && Object.hasOwn(usage, key)),
    presentKnownCounterKeys: RAW_USAGE_COUNTERS.filter((key) => Object.hasOwn(usage, key)),
    cacheReadCounterPresent: Object.hasOwn(usage, 'cache_read_input_tokens'),
    cacheCreationCounterPresent: Object.hasOwn(usage, 'cache_creation_input_tokens') };
  diagnostic.knownUsageMetadata = projectKimiKnownUsageMetadata(usage);
  if (diagnostic.rawUsage.length < 16 && JSON.stringify(diagnostic.rawUsage.at(-1)) !== JSON.stringify(projected)) diagnostic.rawUsage.push(projected);
}
function captureKimiSettlementState(fixture: KimiCommercialFixture, requestId: string, row: DurableKimiRequest | undefined): void {
  const diagnostic = settlementDiagnostic(fixture, requestId);
  const projected = projectDurableKimiSettlement(row);
  if (JSON.stringify(diagnostic.states.at(-1)) === JSON.stringify(projected)) return;
  if (diagnostic.states.length === 8) diagnostic.states.splice(1, 1);
  diagnostic.states.push(projected);
}

/** Error messages, provider bodies, URLs, headers, credentials and arbitrary strings are discarded. */
export function projectKimiApiFailure(status: number, body: unknown, headerRequestId: string | null) {
  const error = record(body) && record(body.error) ? body.error : {};
  return {
    status,
    code: fixedValue(error.code, [...SAFE_API_CODES, ...SAFE_PREPARATION_CODES]),
    type: fixedValue(error.type, ['error', 'api_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'overloaded_error', 'server_error']),
    stage: fixedValue(error.stage, SAFE_PREPARATION_STAGES),
    reason: fixedValue(error.reason, SAFE_PREPARATION_CODES),
    requestId: safeRequestId(headerRequestId) ?? safeRequestId(error.requestId) ?? safeRequestId(error.request_id),
  };
}

export function projectPostgresSqlstates(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|\n)[^\r\n]*\b(?:ERROR|FATAL|PANIC):\s+([A-Z0-9]{5}):/g)]
    .map((match) => fixedValue(match[1], SAFE_SQLSTATES)).filter((value): value is string => value !== null))].sort();
}

async function readOwnedPostgresFailureCodes() {
  const path = process.env.KIMI_COMMERCIAL_POSTGRES_LOG;
  const evidence = process.env.KIMI_COMMERCIAL_EVIDENCE_DIR;
  // The runner supplies a sibling log in its uniquely owned evidence folder.
  // Never inspect a developer's PostgreSQL service or an arbitrary env path.
  if (!path || !evidence || resolve(path) !== resolve(evidence, '..', 'postgres.log') ||
      !/^model-router-commercial-postgres-[A-Za-z0-9]+$/.test(resolve(evidence, '..').split('/').at(-1) ?? '')) {
    return { available: false, truncated: false, sqlstates: [] as string[] };
  }
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      const length = Math.min(stat.size, 262_144);
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, stat.size - length);
      return { available: true, truncated: stat.size > length, sqlstates: projectPostgresSqlstates(buffer.subarray(0, result.bytesRead).toString('utf8')) };
    } finally { await file.close(); }
  } catch { return { available: false, truncated: false, sqlstates: [] as string[] }; }
}

async function readBoundedResponseBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0, truncated: false, readFailed: false };
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let readFailed = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Bounded gateway response read timed out')), 5_000);
    timer.unref();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) { finished = true; break; }
      const remaining = limit - bytes;
      chunks.push(Buffer.from(next.value.subarray(0, remaining)));
      bytes += Math.min(next.value.byteLength, remaining);
      if (next.value.byteLength > remaining) { truncated = true; break; }
    }
  } catch { readFailed = true; }
  finally {
    if (timer) clearTimeout(timer);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated, readFailed };
}

export async function readDurableKimiFailureState(fixture: KimiCommercialFixture, requestId: string | null) {
  if (!requestId) return { available: true, found: false, querySqlstate: null, requests: [] };
  try {
    const result = await fixture.database.query<JsonObject>(`SELECT r.id::text AS request_id,
      r.execution_state,r.financial_status,r.reconciliation_state,
      a.ordinal,a.dispatch_state,a.result_state,a.response_started,a.result_http_status,
      (a.unknown_reason IS NOT NULL) AS has_unknown_reason,
      (a.prepared_evidence_id IS NOT NULL) AS has_prepared_evidence,
      (SELECT count(*)::text FROM saas_attempts WHERE tenant_id=r.tenant_id AND request_id=r.id) AS attempt_count,
      (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id=r.tenant_id AND request_id=r.id) AS usage_count
      FROM saas_requests r LEFT JOIN saas_attempts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id
      WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.id::text=$3 ORDER BY a.ordinal LIMIT 4`,
      [fixture.tenantId, fixture.projectId, requestId]);
    return { available: true, found: result.rows.length > 0, querySqlstate: null, requests: result.rows.map((row) => ({
      requestId: safeRequestId(row.request_id),
      executionState: fixedValue(row.execution_state, ['pending', 'succeeded', 'failed', 'unknown']),
      financialStatus: fixedValue(row.financial_status, ['not_applicable', 'pending', 'settled', 'released', 'reconciliation_pending']),
      reconciliationState: fixedValue(row.reconciliation_state, ['none', 'pending', 'resolved']),
      ordinal: typeof row.ordinal === 'number' && Number.isSafeInteger(row.ordinal) ? row.ordinal : null,
      dispatchState: fixedValue(row.dispatch_state, ['not_sent', 'dispatching', 'sent', 'unknown']),
      resultState: fixedValue(row.result_state, ['pending', 'succeeded', 'failed', 'unknown']),
      responseStarted: typeof row.response_started === 'boolean' ? row.response_started : null,
      httpStatus: typeof row.result_http_status === 'number' && row.result_http_status >= 100 && row.result_http_status <= 599 ? row.result_http_status : null,
      hasUnknownReason: row.has_unknown_reason === true,
      hasPreparedEvidence: row.has_prepared_evidence === true,
      attempts: typeof row.attempt_count === 'string' && /^\d{1,8}$/.test(row.attempt_count) ? row.attempt_count : null,
      usageEvents: typeof row.usage_count === 'string' && /^\d{1,8}$/.test(row.usage_count) ? row.usage_count : null,
    })) };
  } catch (error) {
    return { available: false, found: false, querySqlstate: fixedValue(record(error) ? error.code : null, SAFE_SQLSTATES), requests: [] };
  }
}

type KimiHttpFailureDiagnostic = {
  api: ReturnType<typeof projectKimiApiFailure>;
  response: { bytes: number; truncated: boolean; readFailed: boolean; jsonParsed: boolean };
  durable: Awaited<ReturnType<typeof readDurableKimiFailureState>>;
  postgres: Awaited<ReturnType<typeof readOwnedPostgresFailureCodes>>;
  preparationFailures: Awaited<ReturnType<typeof readKimiPreparationFailureMetrics>>;
};
const kimiHttpFailures = new WeakMap<KimiCommercialFixture, KimiHttpFailureDiagnostic[]>();
export function readKimiHttpFailureDiagnostics(fixture: KimiCommercialFixture) {
  return kimiHttpFailures.get(fixture) ?? [];
}

export function projectKimiPreparationFailureMetrics(text: string): Array<PreparationFailureObservation & { count: number }> {
  const samples: Array<PreparationFailureObservation & { count: number }> = [];
  for (const line of text.split('\n')) {
    if (samples.length === 64) break;
    const match = /^saas_gateway_preparation_failures_total\{([^}]*)\} (\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(line);
    if (!match) continue;
    const labels = [...(match[1] ?? '').matchAll(/(outcome|stage|code)="([a-z_]+)"/g)];
    if (labels.length !== 3 || labels.map((label) => label[0]).join(',') !== match[1]) continue;
    const entries = new Map(labels.map((label) => [label[1], label[2]]));
    if (entries.size !== 3) continue;
    const observation = { outcome: entries.get('outcome'), stage: entries.get('stage'), code: entries.get('code') };
    const count = Number(match[2]);
    if (!isPreparationFailureObservation(observation) || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) continue;
    samples.push({ outcome: observation.outcome, stage: observation.stage, code: observation.code, count });
  }
  return samples;
}

async function readKimiPreparationFailureMetrics(fixture: KimiCommercialFixture) {
  try {
    const response = await fetch(`${fixture.gatewayOrigin}/metrics`, { signal: AbortSignal.timeout(2_000) });
    const observed = await readBoundedResponseBody(response, 524_288);
    return { available: response.status === 200 && !observed.readFailed && !observed.truncated,
      truncated: observed.truncated, samples: response.status === 200 ? projectKimiPreparationFailureMetrics(observed.text) : [] };
  } catch { return { available: false, truncated: false, samples: [] as Array<PreparationFailureObservation & { count: number }> }; }
}

async function retainKimiHttpFailure(fixture: KimiCommercialFixture, response: Response, observed: Awaited<ReturnType<typeof readBoundedResponseBody>>, body: unknown, jsonParsed: boolean): Promise<never> {
  const api = projectKimiApiFailure(response.status, body, response.headers.get('x-request-id'));
  const [durable, postgres, preparationFailures] = await Promise.all([readDurableKimiFailureState(fixture, api.requestId), readOwnedPostgresFailureCodes(), readKimiPreparationFailureMetrics(fixture)]);
  const diagnostic: KimiHttpFailureDiagnostic = { api, response: { bytes: observed.bytes, truncated: observed.truncated, readFailed: observed.readFailed, jsonParsed }, durable, postgres, preparationFailures };
  const history = kimiHttpFailures.get(fixture) ?? [];
  if (history.length < 8) history.push(diagnostic);
  kimiHttpFailures.set(fixture, history);
  throw new Error(`Built commercial gateway HTTP failure: ${JSON.stringify(diagnostic)}`);
}

/** Read the bounded envelope before status assertions so first failures remain diagnosable. */
export async function readKimiJsonResponse(fixture: KimiCommercialFixture, response: Response): Promise<JsonObject> {
  const observed = await readBoundedResponseBody(response, response.status === 200 ? 1_048_576 : 8_192);
  let body: unknown;
  let parsed = false;
  if (!observed.truncated && !observed.readFailed) {
    try { body = JSON.parse(observed.text); parsed = true; } catch { /* Raw response content is never emitted. */ }
  }
  if (response.status !== 200) return retainKimiHttpFailure(fixture, response, observed, body, parsed);
  assert.ok(parsed && record(body), 'Expected a bounded JSON completion object');
  captureKimiNumericUsage(fixture, response, body);
  const id = safeRequestId(response.headers.get('x-request-id'));
  if (id) settlementDiagnostic(fixture, id).envelope = {
    nativeMessage: body.type === 'message', assistantRole: body.role === 'assistant', contentArray: Array.isArray(body.content),
    nonemptyStopReason: typeof body.stop_reason === 'string' && body.stop_reason.length > 0,
    errorAbsent: body.error == null, bodyBytes: observed.bytes, eof: !observed.readFailed && !observed.truncated,
    jsonContentType: /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''),
  };
  return body;
}

/** On successful SSE leave the stream unread; inspect only unexpected HTTP failures. */
export async function assertKimiHttpStatus(fixture: KimiCommercialFixture, response: Response, expected = 200): Promise<void> {
  if (response.status === expected) return;
  const observed = await readBoundedResponseBody(response, 8_192);
  let body: unknown;
  let parsed = false;
  if (!observed.truncated && !observed.readFailed) {
    try { body = JSON.parse(observed.text); parsed = true; } catch { /* Projection only. */ }
  }
  await retainKimiHttpFailure(fixture, response, observed, body, parsed);
}

const SAFE_STARTUP_MESSAGES = [
  'Managed SaaS credential-validation worker PostgreSQL ping failed',
  'Managed SaaS credential-validation worker schema readiness failed',
  'Managed SaaS credential-validation worker database privileges are unsafe',
  'Managed SaaS credential-validation worker KMS is unavailable',
  'Managed SaaS credential-validation worker KMS readiness failed',
  'Credential-validation worker KMS configuration is unavailable',
  'Credential-validation worker targets module configuration is unavailable',
  'Credential-validation worker targets metadata is unavailable',
  'Credential-validation worker cannot receive gateway or payment capabilities',
  'Managed SaaS gateway runtime setup failed',
  'Managed SaaS gateway runtime readiness failed',
  'Managed SaaS gateway credential KMS readiness failed',
  'Managed SaaS gateway scheduler and provider lease concurrency limits do not match',
  'Software provider credential KMS configuration is invalid',
  'Validation worker KMS configuration is invalid',
  'Validation worker KMS module could not be loaded',
  'Validation worker KMS module export is invalid',
  'Validation worker KMS initialization failed',
  'Validation worker KMS adapter is invalid',
  'Validation worker KMS is not ready',
] as const;
const SAFE_STARTUP_CODES = [
  'SAAS_VALIDATION_WORKER_SCHEMA_NOT_READY', 'SAAS_VALIDATION_WORKER_PRIVILEGES_UNSAFE',
  'CONFIGURATION_INVALID', 'MODULE_LOAD_FAILED', 'MODULE_EXPORT_INVALID', 'FACTORY_FAILED',
  'PROVIDER_INVALID', 'READINESS_FAILED', 'MODULE_CONTRACT_INVALID', 'INVALID_CONFIGURATION',
  'INVALID_PROVIDER_MODULE', 'MISSING_REQUIRED_SETTING', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND',
  'ERR_REQUIRE_ESM', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', '42501', '42703', '42P01', '28P01',
] as const;
const SAFE_EXCEPTION_CLASSES = [
  'GatewayRuntimeModuleError', 'ProviderLoaderError', 'ValidationWorkerProviderCredentialKmsError',
  'SoftwareProviderCredentialKmsError', 'SaasCredentialValidationWorkerSchemaReadinessError',
  'SaasCredentialValidationWorkerPrivilegeError', 'DeploymentConfigError', 'TypeError', 'RangeError', 'Error',
] as const;
interface CliStartupCapture { readonly role: string; bytes: number; truncated: boolean; text: string; }
const cliStartupCaptures = new WeakMap<ChildProcess, CliStartupCapture>();

/** Whitelist projection: no raw line, URL, environment value or provider body survives. */
export function projectCliStartupDiagnostic(text: string) {
  return {
    messages: SAFE_STARTUP_MESSAGES.filter((value) => text.includes(value)),
    codes: SAFE_STARTUP_CODES.filter((value) => new RegExp(`(?:^|[^A-Z0-9_])${value}(?:$|[^A-Z0-9_])`).test(text)),
    exceptions: SAFE_EXCEPTION_CLASSES.filter((value) => text.includes(`${value}:`)),
    settings: [MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
      'MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL', 'SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE',
      'MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE', 'MODEL_ROUTER_SAAS_DEPLOYMENT_ID', 'MODEL_ROUTER_SAAS_ENVIRONMENT_ID']
      .filter((value) => text.includes(value)),
  };
}
export function readCliStartupDiagnostics(fixture: KimiCommercialFixture) {
  return fixture.started.map((child) => {
    const capture = cliStartupCaptures.get(child);
    return { role: capture?.role ?? 'unknown', exitCode: child.exitCode, signal: child.signalCode,
      observedBytes: capture?.bytes ?? 0, truncated: capture?.truncated ?? false,
      ...projectCliStartupDiagnostic(capture?.text ?? '') };
  });
}
function assertCliRunning(fixture: KimiCommercialFixture, child: ChildProcess, stage: string): void {
  if (child.exitCode === null && child.signalCode === null) return;
  const diagnostic = readCliStartupDiagnostics(fixture).find((value) => value.role === cliStartupCaptures.get(child)?.role);
  throw new Error(`${stage}: ${JSON.stringify(diagnostic)}`);
}

export function assertDisposableRoleUrl(value: string | undefined, role: string): string {
  assert.ok(typeof value === 'string' && value.length > 0, `Disposable PostgreSQL URL for ${role} is required`);
  const url = new URL(value);
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:', 'Expected PostgreSQL URL');
  assert.equal(decodeURIComponent(url.username), role);
  assert.ok(/^\/model_router_test_[a-z0-9_]+$/.test(url.pathname), 'Only a runner-owned disposable test database is accepted');
  assert.ok(url.hostname === '127.0.0.1' || url.hostname === 'localhost', 'Disposable PostgreSQL must be local');
  return value;
}

/** Only the explicit source diagnostic may use the isolated runner's exact CI target. */
export function assertSourceDiagnosticRoleUrl(value: string | undefined, role: string): string {
  assert.ok(typeof value === 'string' && value.length > 0, 'A source diagnostic PostgreSQL role URL is required');
  assert.ok(['model_router_saas_migrator', 'model_router_saas_control_plane', 'model_router_saas_gateway',
    'model_router_saas_validation_worker'].includes(role), 'Only the four restricted diagnostic role identities are accepted');
  const ci = `postgresql://${role}@postgres:5432/model_router_saas_ci`;
  if (value === ci) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Source diagnostic PostgreSQL URL is invalid'); }
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:', 'Expected source diagnostic PostgreSQL URL');
  assert.equal(decodeURIComponent(url.username), role);
  assert.ok(url.password === '', 'Source diagnostic role URLs cannot contain a password');
  assert.ok(!value.includes('?') && !value.includes('#'), 'Source diagnostic role URLs must be queryless and fragmentless');
  assert.ok(url.hostname === '127.0.0.1' || url.hostname === 'localhost', 'Source diagnostics require a local disposable database or the exact isolated CI target');
  const port = Number(url.port);
  assert.ok(url.port !== '' && Number.isSafeInteger(port) && port > 0 && ![5432, 6432, 53782].includes(port),
    'Local source diagnostics require an explicit nondefault PostgreSQL port');
  assert.ok(/^\/model_router_test_[a-z0-9_]+$/.test(url.pathname), 'Source diagnostics require a runner-owned disposable database');
  return value;
}

export function kimiCommercialFixturePolicy(mode: KimiCommercialFixtureMode = 'live-built-cli') {
  assert.ok(mode === 'live-built-cli' || mode === 'source-diagnostic', 'Kimi commercial fixture mode is invalid');
  return { minimumPostgresVersion: mode === 'source-diagnostic' ? 150_000 : 180_000,
    kmsModule: resolve(mode === 'source-diagnostic'
      ? 'src/saas/runtime/software-provider-credential-kms.ts' : 'dist/saas/runtime/software-provider-credential-kms.js') };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

export function kimiCommercialCliEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const postgresPreparedStatements = resolveSaasDatabasePreparedStatements({}, env);
  // Provider plaintext and unrelated local deployment credentials never enter
  // either CLI process. Both workloads must decrypt their persisted envelope.
  const environment: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
    NODE_ENV: 'test',
    MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
    MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'kimi-commercial-local-test',
    MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
    [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: postgresPreparedStatements,
  };
  return { postgresPreparedStatements, environment };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  force.unref();
  try { await closed; } finally { clearTimeout(force); }
}

export function startBuiltCli(fixture: KimiCommercialFixture, role: 'gateway' | 'credential-validation-worker'): ChildProcess {
  assert.notEqual(fixture.fixtureMode, 'source-diagnostic', 'Source diagnostic fixtures cannot launch built CLI acceptance workloads');
  const environment = role === 'gateway' ? fixture.gatewayEnvironment : fixture.workerEnvironment;
  assert.equal(environment.KIMI_CODE_API_KEY, undefined, 'CLI must use persisted encrypted credentials');
  const child = spawn(process.execPath, [resolve('dist/cli/index.js'), 'start', '--role', role], {
    cwd: resolve('.'), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture: CliStartupCapture = { role, bytes: 0, truncated: false, text: '' };
  cliStartupCaptures.set(child, capture);
  const record = (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const remaining = Math.max(0, 16_384 - Buffer.byteLength(capture.text));
    capture.bytes += bytes.byteLength;
    if (bytes.byteLength > remaining) capture.truncated = true;
    if (remaining > 0) capture.text += bytes.subarray(0, remaining).toString('utf8');
  };
  // Bounded in-memory capture only. Errors and saved evidence receive the
  // fixed whitelist projection above, never the arbitrary child output.
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  fixture.started.push(child);
  return child;
}

export async function waitUntil<T>(label: string, action: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await action();
    if (result !== undefined) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label} did not reach its required durable state within ${timeoutMs} ms`);
}

export async function waitGatewayReady(fixture: KimiCommercialFixture, child: ChildProcess): Promise<void> {
  await waitUntil('Built CLI gateway readiness', async () => {
    assertCliRunning(fixture, child, 'Built CLI gateway exited before readiness');
    try {
      const response = await fetch(`${fixture.gatewayOrigin}/readyz`, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      return response.status === 200 ? true : undefined;
    } catch { return undefined; }
  });
}

export interface CredentialOnboardingSnapshot {
  readonly account_status: string;
  readonly account_validation: string;
  readonly credential_status: string;
  readonly credential_validation: string;
  readonly job_status: string;
  readonly attempt_count: number;
  readonly last_error_code: string | null;
  readonly lease_until: string | null;
  readonly available_at: string | null;
  readonly lease_generation: string | null;
}
const onboardingHistory = new WeakMap<KimiCommercialFixture, CredentialOnboardingSnapshot[]>();
export function readCredentialOnboardingDiagnostics(fixture: KimiCommercialFixture) {
  return [...(onboardingHistory.get(fixture) ?? [])];
}
export async function readCredentialOnboardingSnapshot(fixture: KimiCommercialFixture): Promise<CredentialOnboardingSnapshot> {
  const result = await fixture.database.query<{
    account_status: string; account_validation: string; credential_status: string | null;
    credential_validation: string | null; job_status: string | null; attempt_count: number | null;
    last_error_code: string | null; lease_until: Date | string | null; available_at: Date | string | null;
    lease_generation: string | number | null;
  }>(`SELECT a.status AS account_status, a.validation_state AS account_validation,
                 c.status AS credential_status, c.validation_state AS credential_validation,
                 j.status AS job_status, j.attempt_count, j.last_error_code,
                 j.lease_until, j.available_at, j.lease_generation
            FROM saas_platform_provider_accounts a
            LEFT JOIN saas_platform_provider_credentials c ON c.account_id = a.id AND c.id = $2
            LEFT JOIN saas_platform_provider_credential_validation_jobs j
              ON j.account_id = a.id AND j.credential_id = c.id AND j.credential_version = c.current_version
           WHERE a.id = $1`, [fixture.accountId, fixture.credentialId]);
  assert.ok(result.rows.length <= 1, 'Import must have at most one current-version platform validation job');
  const row = result.rows[0];
  const state = (value: string | null | undefined) => typeof value === 'string' && /^[a-z][a-z_]{0,63}$/.test(value) ? value : 'missing';
  const timestamp = (value: Date | string | null | undefined) => value == null ? null : new Date(value).toISOString();
  const attemptCount = row?.attempt_count;
  const snapshot: CredentialOnboardingSnapshot = {
    account_status: state(row?.account_status), account_validation: state(row?.account_validation),
    credential_status: state(row?.credential_status), credential_validation: state(row?.credential_validation),
    job_status: state(row?.job_status), attempt_count: typeof attemptCount === 'number' && Number.isSafeInteger(attemptCount) && attemptCount >= 0 ? attemptCount : 0,
    last_error_code: row?.last_error_code == null ? null : state(row.last_error_code),
    lease_until: timestamp(row?.lease_until), available_at: timestamp(row?.available_at),
    lease_generation: row?.lease_generation == null ? null : /^\d{1,20}$/.test(String(row.lease_generation)) ? String(row.lease_generation) : 'invalid',
  };
  const history = onboardingHistory.get(fixture) ?? [];
  if (JSON.stringify(history.at(-1)) !== JSON.stringify(snapshot)) {
    // Keep the first transition and the latest nineteen, never a raw job row.
    if (history.length === 20) history.splice(1, 1);
    history.push(snapshot);
    onboardingHistory.set(fixture, history);
  }
  return snapshot;
}
export async function waitCredentialVerified(fixture: KimiCommercialFixture, child: ChildProcess,
  onStateChange?: (snapshot: CredentialOnboardingSnapshot) => void) {
  let previous = '';
  try {
    return await waitUntil('Automatic Kimi credential onboarding', async () => {
      assertCliRunning(fixture, child, 'Built CLI validation worker exited before verification');
      const row = await readCredentialOnboardingSnapshot(fixture);
      const serialized = JSON.stringify(row);
      if (serialized !== previous) { onStateChange?.(row); previous = serialized; }
      assert.notEqual(row.job_status, 'missing', `Import did not create a validation job: ${serialized}`);
      assert.notEqual(row.job_status, 'failed', `Automatic onboarding failed: ${serialized}`);
      assert.notEqual(row.job_status, 'cancelled', `Automatic onboarding authority was cancelled: ${serialized}`);
      assert.ok(row.attempt_count <= 1, `First bounded onboarding attempt did not complete: ${serialized}`);
      assert.ok(!(row.job_status === 'queued' && row.attempt_count > 0), `Automatic onboarding entered a retry: ${serialized}`);
      if (row.job_status !== 'verified') return undefined;
      assert.equal(row.account_status, 'active');
      assert.equal(row.account_validation, 'verified');
      assert.equal(row.credential_status, 'active');
      assert.equal(row.credential_validation, 'verified');
      assert.equal(row.attempt_count, 1, 'Acceptance must succeed on the first bounded real probe');
      return row;
    }, 75_000);
  } catch (error) {
    const code: unknown = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    const summary = { states: readCredentialOnboardingDiagnostics(fixture), cli: readCliStartupDiagnostics(fixture),
      failureCode: typeof code === 'string' && ['ERR_ASSERTION', ...SAFE_STARTUP_CODES].includes(code) ? code : 'unrecognized' };
    const reason = error instanceof Error && error.message.startsWith('Automatic Kimi credential onboarding did not reach')
      ? 'Automatic Kimi credential onboarding timed out' : 'Automatic Kimi credential onboarding failed';
    throw new Error(`${reason}: ${JSON.stringify(summary)}`);
  }
}

export async function provisionKimiCommercialFixture(credential: string,
  options: { readonly mode?: KimiCommercialFixtureMode } = {}): Promise<KimiCommercialFixture> {
  // Resolve the non-secret database mode before creating any fixture resource.
  const { postgresPreparedStatements, environment: baseEnvironment } = kimiCommercialCliEnvironment();
  const fixtureMode = options.mode ?? 'live-built-cli';
  const fixturePolicy = kimiCommercialFixturePolicy(fixtureMode);
  const assertRoleUrl = fixtureMode === 'source-diagnostic' ? assertSourceDiagnosticRoleUrl : assertDisposableRoleUrl;
  const controlUrl = assertRoleUrl(process.env[KIMI_COMMERCIAL_URLS.controlPlane], 'model_router_saas_control_plane');
  const gatewayUrl = assertRoleUrl(process.env[KIMI_COMMERCIAL_URLS.gateway], 'model_router_saas_gateway');
  const workerUrl = assertRoleUrl(process.env[KIMI_COMMERCIAL_URLS.worker], 'model_router_saas_validation_worker');
  const migratorUrl = assertRoleUrl(process.env[KIMI_COMMERCIAL_URLS.migrator], 'model_router_saas_migrator');
  assert.equal(new URL(controlUrl).pathname, new URL(gatewayUrl).pathname);
  assert.equal(new URL(controlUrl).pathname, new URL(workerUrl).pathname);
  assert.equal(new URL(controlUrl).pathname, new URL(migratorUrl).pathname);
  if (fixtureMode === 'source-diagnostic') {
    const target = (value: string) => {
      const url = new URL(value);
      return `${url.hostname}:${url.port}${url.pathname}`;
    };
    assert.ok([gatewayUrl, workerUrl, migratorUrl].every((value) => target(value) === target(controlUrl)),
      'Every source diagnostic role must share the same isolated PostgreSQL target');
  }
  // Test inventory includes supply-profile and entitlement grants that are
  // deliberately unavailable to the restricted control-plane identity. Only
  // this disposable fixture seeds them as migrator; the CLI worker/gateway
  // keep their original restricted roles throughout the acceptance run.
  const database = createSaasDatabase({ connectionString: migratorUrl, max: 2, preparedStatements: postgresPreparedStatements });
  const controlPlaneDatabase = createSaasDatabase({ connectionString: controlUrl, max: 2, preparedStatements: postgresPreparedStatements });
  const started: ChildProcess[] = [];
  const tempDirectory = await mkdtemp(join(tmpdir(), 'model-router-kimi-commercial-'));
  const close = async () => {
    await Promise.allSettled(started.map(stopChild));
    await Promise.all([database.close(), controlPlaneDatabase.close()]);
    await rm(tempDirectory, { recursive: true, force: true });
  };
  try {
    await database.verifySchema();
    const supplyRole = await controlPlaneDatabase.query<{ current_user: string }>('SELECT current_user');
    assert.equal(supplyRole.rows[0]?.current_user, 'model_router_saas_control_plane',
      'The real supply lifecycle must use the restricted control-plane identity');
    const version = await database.query<{ server_version_num: string }>('SHOW server_version_num');
    assert.ok(Number(version.rows[0]?.server_version_num) >= fixturePolicy.minimumPostgresVersion,
      fixtureMode === 'source-diagnostic' ? 'Source diagnostic requires PostgreSQL 15 or newer' : 'Kimi commercial acceptance requires PostgreSQL 18 or newer');
    const label = randomUUID().replaceAll('-', '').slice(0, 12);
    const publicModel = `kimi-commercial-${label}`;
    const publicModelId = `kimi-commercial-model-${label}`;
    const poolId = `kimi-commercial-pool-${label}`;
    const accountId = `kimi-commercial-account-${label}`;
    const credentialId = `kimi-commercial-credential-${label}`;
    const profileId = `kimi-commercial-profile-${label}`;
    const model = process.env.KIMI_CODE_LIVE_MODEL ?? 'kimi-for-coding';
    assert.equal(model, 'kimi-for-coding', 'This acceptance uses the fixed Kimi for Coding model contract');
    const endpoint = 'messages';
    const now = new Date();
    const effectiveAt = new Date(now.getTime() - 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    const identity = new SaasIdentityService(database);
    const bootstrap = await identity.issueBootstrapToken();
    const administrator = await identity.bootstrapPlatformAdmin({
      token: bootstrap.token, email: `kimi-commercial-${label}@example.test`,
      displayName: 'Disposable Kimi commercial acceptance', password: `${randomUUID()}-Local-Password!`,
    });
    const tenant = await identity.createTenant(administrator.id, { name: 'Disposable Kimi commercial acceptance', slug: `kimi-commercial-${label}` });
    const project = await identity.createProject(administrator.id, tenant.id, { name: 'Kimi commercial acceptance', slug: `kimi-commercial-project-${label}` });
    const context = await identity.resolveTenantContext({ userId: administrator.id, tenantId: tenant.id, projectId: project.id });
    const audit = { actorUserId: administrator.id, requestId: randomUUID(), entryPoint: 'disposable-kimi-commercial-live-test' };
    const policy = await new SaasProjectInferencePolicyService(database).enable({ tenantId: tenant.id, projectId: project.id, expectedVersion: 1, audit });
    await database.query(`INSERT INTO saas_supply_profiles
      (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
      VALUES ($1,$2,'platform','active',$3,1,$4,$4,$4)`, [tenant.id, profileId, [publicModel], now.toISOString()]);
    await database.query(`INSERT INTO saas_project_entitlements
      (id,tenant_id,project_id,supply_profile_id,supply_mode,status,model_scopes,authz_version,
       created_at,updated_at,last_audited_at,effective_at,expires_at,source_type)
      VALUES ($1,$2,$3,$4,'platform','active',$5,1,$6,$6,$6,$7,$8,'admin_grant')`,
    [randomUUID(), tenant.id, project.id, profileId, [publicModel], now.toISOString(), effectiveAt, expiresAt]);
    const catalog = new SaasCatalogService(database);
    await catalog.registerProviderProduct({ providerId: 'kimi', productId: 'kimi-code', displayName: 'Kimi for Coding local acceptance' });
    await catalog.registerPublicModelAlias({ publicModelId, alias: publicModel, displayName: 'Kimi live acceptance model', providerId: 'kimi', productId: 'kimi-code', model, endpointScope: [endpoint] });
    const capability = await catalog.registerProviderCapability({
      providerId: 'kimi', productId: 'kimi-code', model, endpoint, protocol: 'anthropic', supportLevel: 'supported',
      validationState: 'verified', evidenceVersion: 'kimi-commercial-live-contract-v1', discoverySource: 'manual',
      evidenceReference: `local-test-provider-contract-${label}`, evidenceSha256: 'a'.repeat(64),
    });
    const rights = await catalog.registerProviderRightsVersion({
      rightsId: `kimi-commercial-rights-${label}`, providerId: 'kimi', productId: 'kimi-code', credentialType: 'api-key',
      supplyMode: 'platform', region: 'local-test', purpose: 'inference', modelScope: [model], endpointScope: [endpoint],
      effectiveAt, approvalReference: `local-test-only-no-production-resale-claim-${label}`, status: 'active',
      evidenceReference: `local-test-rights-${label}`, evidenceSha256: 'b'.repeat(64), audit,
    });
    const kmsEnvironment = {
      ...baseEnvironment, MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: randomBytes(32).toString('hex'),
      MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'local-test-kms',
    };
    const sealingKms = await createProviderCredentialSealingKms({ env: kmsEnvironment });
    // Real onboarding/pool lifecycle uses the control-plane role. Migrator is
    // limited to disposable foundation/pricing/capacity/funding and observers.
    const supply = new ProviderSupplyService(controlPlaneDatabase, { deployment: 'kimi-commercial-local-test', environment: 'test', kmsKeyId: 'local-test-kms', sealingKms });
    const account = await supply.createPlatformProviderAccount({ id: accountId, displayName: 'Kimi local acceptance',
      providerId: 'kimi', productId: 'kimi-code', credentialType: 'api-key', region: 'local-test', purpose: 'inference',
      rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model, endpoint, version: capability.version }], audit });
    assert.equal(account.status, 'pending');
    const secret = Buffer.from(credential, 'utf8');
    try {
      const imported = await supply.createPlatformProviderCredential({ accountId, id: credentialId, secret, audit });
      assert.equal(imported.credential.status, 'pending');
      assert.equal(imported.credential.validationState, 'unverified');
    } finally { secret.fill(0); await sealingKms.close(); }
    const pool = await supply.createPlatformProviderPool({ id: poolId, displayName: 'Kimi local acceptance pool',
      providerId: 'kimi', productId: 'kimi-code', credentialType: 'api-key', region: 'local-test', purpose: 'inference',
      rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model, endpoint, version: capability.version }],
      status: 'active', validationState: 'verified' });
    // Membership/grants are appended after the worker activates the account.
    const pricing = new SaasPricingService(database);
    const signing = generateKeyPairSync('ed25519');
    const verifierKeyId = `kimi-commercial-local-verifier-${label}`;
    const testVectorDigest = 'c'.repeat(64);
    const commercial = new SaasCommercialMeteringPolicyService(database, {
      trustedVerifierPublicKeys: new Map([[verifierKeyId, signing.publicKey]]),
      trustedTestVectorDigests: new Map([['kimi-commercial-local-suite-v1', testVectorDigest]]),
    });
    const routes = new SaasRouteConfigService(database);
    const prices = {} as Record<ClientProtocol, string>;
    const supplierCosts = {} as Record<ClientProtocol, string>;
    for (const protocol of ['openai', 'anthropic'] as const) {
      const commercialPolicyVersion = `kimi-commercial-${protocol}-${label}`;
      const rate = (value: number) => ({ numeratorMinorUnits: value, denominatorUnits: 1 });
      const rateFields = (input: number, output: number) => ({ input: rate(input), cache_read: rate(input), cache_write: rate(input), cache_write_5m: rate(input), cache_write_1h: rate(input), output: rate(output) });
      const priceCommon = { publicModelId, publicModelVersion: 1, providerId: 'kimi', productId: 'kimi-code', protocol,
        endpoint, currency: 'USD', commercialPolicyVersion, calculatorVersion: 'local-test-calculator-v1',
        roundingVersion: 'local-test-rounding-v1', roundingMode: 'half_up' as const, roundingBoundary: 'total' as const, effectiveAt };
      const customerPrice = await pricing.appendCustomerPriceVersion({ ...priceCommon, rates: rateFields(2, 3), idempotencyKey: `customer-${protocol}-${label}` });
      const supplierCost = await pricing.appendSupplierCostVersion({ ...priceCommon, resolvedModel: model, rates: rateFields(1, 1), idempotencyKey: `supplier-${protocol}-${label}` });
      prices[protocol] = customerPrice.id;
      supplierCosts[protocol] = supplierCost.id;
      const customerDefinition: CustomerMeteringPolicyDefinition = { publicModelId, publicModelVersion: 1, protocol,
        endpoint, supplyMode: 'platform', targetMode: 'platform_pool', customerPriceVersion: customerPrice.id,
        usageDimensions: KIMI_NATIVE_USAGE_DIMENSIONS, tokenSource: 'upstream', roundingVersion: 'local-test-rounding-v1',
        roundingMode: 'half_up', roundingBoundary: 'total', commercialPolicyVersion };
      const providerDefinition: ProviderMeteringPolicyDefinition = { ...customerDefinition, providerId: 'kimi', productId: 'kimi-code', resolvedModel: model, supplierCostVersion: supplierCost.id };
      const customerPolicyId = `kimi-customer-${protocol}-${label}`;
      const providerPolicyId = `kimi-provider-${protocol}-${label}`;
      await commercial.createCustomerPolicy({ tenantId: tenant.id, projectId: project.id, policyId: customerPolicyId, definition: customerDefinition, audit });
      await commercial.createProviderPolicy({ tenantId: tenant.id, projectId: project.id, policyId: providerPolicyId, definition: providerDefinition, audit });
      const customerPolicy = await commercial.publishCustomerPolicy({ tenantId: tenant.id, projectId: project.id, policyId: customerPolicyId, expectedVersion: 1, definition: customerDefinition, audit });
      const providerPolicy = await commercial.publishProviderPolicy({ tenantId: tenant.id, projectId: project.id, policyId: providerPolicyId, expectedVersion: 1, definition: providerDefinition, audit });
      const contract = { contractDigest: 'd'.repeat(64), suiteVersion: 'kimi-commercial-local-suite-v1', testVectorDigest,
        providerPolicyId, providerPolicyVersion: providerPolicy.version, publicModelId, publicModelVersion: '1', protocol,
        endpoint, supplyMode: 'platform' as const, targetMode: 'platform_pool' as const,
        usageDimensions: customerDefinition.usageDimensions, tokenSource: customerDefinition.tokenSource,
        roundingVersion: customerDefinition.roundingVersion, roundingMode: customerDefinition.roundingMode, roundingBoundary: 'total' as const };
      const attestationId = `kimi-attestation-${protocol}-${label}`;
      await commercial.attestProviderContract({ tenantId: tenant.id, projectId: project.id, id: attestationId, ...contract,
        publicModelVersion: 1, verifierKeyId, signatureBase64: sign(null, Buffer.from(canonicalContractAttestationPayload(contract)), signing.privateKey).toString('base64'), audit });
      const routeId = `kimi-route-${protocol}-${label}`;
      const definition = { publicModelId, publicModelVersion: 1, protocol, supplyMode: 'platform' as const, targetMode: 'platform_pool' as const, upstreamId: poolId, endpoint };
      await routes.create({ tenantId: tenant.id, projectId: project.id, routeId, definition, audit });
      const route = await routes.publish({ tenantId: tenant.id, projectId: project.id, routeId, expectedVersion: 1, definition, audit });
      await commercial.bindRoute({ tenantId: tenant.id, projectId: project.id, routeId, routeVersion: route.version,
        customerPolicyId, customerPolicyVersion: customerPolicy.version, providerPolicyId, providerPolicyVersion: providerPolicy.version,
        contractAttestationId: attestationId, audit });
    }
    await database.query(`UPDATE saas_tenants SET requests_per_minute=200,tokens_per_minute=$2,max_concurrent_requests=2 WHERE id=$1`,
      [tenant.id, KIMI_COMMERCIAL_WINDOW_CAPACITY.tokensPerMinute]);
    const capacityVersion = (BigInt(policy.version) + 1n).toString();
    await database.transaction(async (executor) => {
      await executor.query(`INSERT INTO saas_project_inference_policy_versions
        (tenant_id,project_id,version,status,changed_by_user_id,created_at,requests_per_minute,tokens_per_minute,max_concurrent_requests)
        SELECT tenant_id,project_id,$3,status,$4,clock_timestamp(),120,$6,2 FROM saas_project_inference_policy_versions
        WHERE tenant_id=$1 AND project_id=$2 AND version=$5`, [tenant.id, project.id, capacityVersion, administrator.id, policy.version,
        KIMI_COMMERCIAL_WINDOW_CAPACITY.tokensPerMinute]);
      await executor.query('UPDATE saas_projects SET inference_policy_version=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND inference_policy_version=$4', [tenant.id, project.id, capacityVersion, policy.version]);
      await new PlatformWalletLedgerService().postVerifiedFunding(executor, { tenantId: tenant.id, currency: 'USD', amountMinorUnits: INITIAL_WALLET.toString(), sourceOrderRef: `local-test-funding-${label}`, idempotencyKey: `local-test-funding-${label}`, metadataRef: `local-test-no-psp-payment-${label}` });
    });
    const privateKeyFile = join(tempDirectory, 'signing.pem');
    const publicKeyFile = join(tempDirectory, 'public.pem');
    const affinityKeyFile = join(tempDirectory, 'affinity.key');
    const idempotencyKeyFile = join(tempDirectory, 'idempotency.key');
    const configFile = join(tempDirectory, 'gateway.json');
    await writeFile(privateKeyFile, signing.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(publicKeyFile, signing.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
    await writeFile(affinityKeyFile, randomBytes(32), { mode: 0o600 });
    await writeFile(idempotencyKeyFile, randomBytes(32), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ apiVersion: 2, extensions: { providerBundles: [{ bundle: 'kimi', enabled: true }] },
      signing: { verifierKeyId, privateKeyFile, trustedPublicKeys: [{ keyId: verifierKeyId, publicKeyFile, status: 'active' }] },
      affinity: { activeKeyVersion: 'local-test-v1', keys: [{ version: 'local-test-v1', keyFile: affinityKeyFile }] },
      // A signed thinking-history envelope can exceed 13 KiB on turn two;
      // this is a real bounded history ceiling, not a reduced estimator.
      idempotencyKeyFile, limits: { timeoutMs: 60_000, maxConcurrency: 2, leaseTtlMs: 90_000, maxBodyBytes: 1024 * 1024,
        maxInputTokens: KIMI_COMMERCIAL_WINDOW_CAPACITY.maxInputTokens, maxOutputTokens: KIMI_COMMERCIAL_WINDOW_CAPACITY.maxOutputTokens } }), { mode: 0o600 });
    const kmsModule = fixturePolicy.kmsModule;
    const gatewayPort = await freePort();
    const workerEnvironment = { ...kmsEnvironment, MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'credential-validation-worker',
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: workerUrl,
      [MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: kmsModule };
    assert.equal(parseDeploymentConfig(workerEnvironment).mode, 'managed-saas', 'Worker CLI environment must satisfy the production deployment parser');
    const gatewayEnvironment = { ...kmsEnvironment, MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: gatewayUrl, MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: 'builtin',
      MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG: configFile, SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: kmsModule,
      MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1', MODEL_ROUTER_SAAS_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: `http://127.0.0.1:${gatewayPort}` };
    // Deferred normal service operations run only after automatic activation.
    let customerKey: string | undefined;
    const fixture: KimiCommercialFixture = { fixtureMode, postgresPreparedStatements, database, controlPlaneDatabase, tenantId: tenant.id, projectId: project.id, accountId, credentialId,
      publicModel, get customerKey() {
        assert.ok(customerKey, 'The customer key is issued only after verified supply membership and grant');
        return customerKey;
      }, gatewayOrigin: `http://127.0.0.1:${gatewayPort}`, tempDirectory,
      prices, supplierCosts, workerEnvironment, gatewayEnvironment, started, close };
    pendingMembership.set(fixture, async () => {
      const activated = await supply.getProviderAccount(accountId);
      await supply.addPlatformPoolMember({ poolId: pool.id, accountId, expectedAccountAuthzVersion: activated.authzVersion });
      await supply.grantPlatformPoolToProfile({ poolId: pool.id, tenantId: tenant.id, supplyProfileId: profileId,
        evidenceReference: `local-test-grant-${label}`, evidenceSha256: 'e'.repeat(64) });
      const key = await new KeyService(controlPlaneDatabase, { resolver: new PostgresSupplyProfileResolver(controlPlaneDatabase) }).create(context,
        { name: 'Kimi commercial acceptance', modelScopes: [publicModel], supplyMode: 'platform' });
      await database.query('UPDATE saas_api_keys SET requests_per_minute=100,tokens_per_minute=$3,max_concurrent_requests=2,authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2',
        [tenant.id, key.id, KIMI_COMMERCIAL_WINDOW_CAPACITY.tokensPerMinute]);
      customerKey = key.secret;
    });
    return fixture;
  } catch (error) { await close(); throw error; }
}

const pendingMembership = new WeakMap<KimiCommercialFixture, () => Promise<void>>();
export async function bindVerifiedKimiSupply(fixture: KimiCommercialFixture): Promise<void> {
  const bind = pendingMembership.get(fixture);
  assert.ok(bind, 'Verified supply binding must execute once');
  await bind();
  pendingMembership.delete(fixture);
}

export async function postKimi(fixture: KimiCommercialFixture, protocol: ClientProtocol, body: JsonObject,
  idempotencyKey: string, signal = AbortSignal.timeout(65_000)): Promise<Response> {
  return fetch(`${fixture.gatewayOrigin}${protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'}`, {
    method: 'POST', signal, headers: { authorization: `Bearer ${fixture.customerKey}`, 'content-type': 'application/json',
      'anthropic-version': '2023-06-01', 'idempotency-key': idempotencyKey }, body: JSON.stringify(body),
  });
}

export async function readDurableKimiRequest(fixture: KimiCommercialFixture, requestId: string): Promise<DurableKimiRequest | undefined> {
  const result = await fixture.database.query<DurableKimiRequest>(`SELECT r.id::text AS request_id,r.execution_state,r.financial_status,
    a.unknown_reason,a.dispatch_state,a.result_state,a.platform_account_id AS account_id,a.response_started,
    u.source AS usage_source,u.input_total::text AS input_total,u.output_total::text AS output_total,
    (SELECT count(*)::text FROM saas_attempts WHERE tenant_id=r.tenant_id AND request_id=r.id) AS attempt_count,
    (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id=r.tenant_id AND request_id=r.id) AS usage_count,
    (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id=r.tenant_id AND request_id=r.id AND kind='usage_recorded') AS settlement_count,
    b.state AS reservation_state,b.settlement_amount_minor_units::text AS settlement_amount,
    l.amount_minor_units::text AS ledger_amount,l.source_type AS ledger_source,
    (SELECT count(*)::text FROM saas_ledger_entries WHERE transaction_id=l.id) AS ledger_entries,
    (SELECT COALESCE(sum(amount_minor_units) FILTER(WHERE direction='credit'),0)::text FROM saas_ledger_entries WHERE transaction_id=l.id) AS ledger_credit,
    (SELECT COALESCE(sum(amount_minor_units) FILTER(WHERE direction='debit'),0)::text FROM saas_ledger_entries WHERE transaction_id=l.id) AS ledger_debit,
    s.customer_price_version AS snapshot_price_version,a.supplier_cost_version,i.request_id::text AS canonical_request_id,
    (SELECT count(*)::text FROM saas_provider_account_leases WHERE tenant_id=r.tenant_id AND attempt_id=a.id::text AND status='held') AS held_leases
    FROM saas_requests r JOIN saas_attempts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id
    JOIN saas_gateway_request_idempotency_keys i ON i.tenant_id=r.tenant_id AND i.request_id=r.id
    LEFT JOIN saas_usage_events u ON u.tenant_id=r.tenant_id AND u.request_id=r.id AND u.attempt_id=a.id
    LEFT JOIN saas_billing_reservations b ON b.tenant_id=r.tenant_id AND b.request_id=r.id::text
    LEFT JOIN saas_request_customer_price_snapshots s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
    LEFT JOIN saas_ledger_transactions l ON l.tenant_id=r.tenant_id AND l.id=b.ledger_transaction_id
    WHERE r.tenant_id=$1 AND r.id=$2 AND r.project_id=$3`, [fixture.tenantId, requestId, fixture.projectId]);
  assert.ok(result.rows.length <= 1, 'One live request must have exactly one attempt and at most one usage event');
  return result.rows[0];
}

/** Pure observation of one request; successful settlement can precede lease cleanup. */
export function classifyKimiSettlementObservation(
  fixture: Pick<KimiCommercialFixture, 'accountId' | 'prices' | 'supplierCosts'>,
  requestId: string,
  protocol: ClientProtocol,
  row: DurableKimiRequest | undefined,
  nativeUsage: readonly JsonObject[] = [],
): DurableKimiRequest | undefined {
    if (!row) return undefined;
    assert.notEqual(row.execution_state, 'unknown');
    assert.notEqual(row.result_state, 'unknown');
    assert.equal(row.unknown_reason, null);
    if (row.execution_state === 'pending' || row.result_state === 'pending' || row.reservation_state === 'reserved') return undefined;
    assert.equal(row.execution_state, 'succeeded');
    assert.equal(row.financial_status, 'settled');
    assert.equal(row.result_state, 'succeeded');
    assert.equal(row.account_id, fixture.accountId);
    assert.equal(row.attempt_count, '1');
    assert.equal(row.usage_count, '1');
    assert.equal(row.settlement_count, '1');
    assert.equal(row.usage_source, 'upstream');
    assert.equal(row.reservation_state, 'settled');
    assert.equal(row.snapshot_price_version, fixture.prices[protocol]);
    assert.equal(row.supplier_cost_version, fixture.supplierCosts[protocol]);
    assert.ok(row.input_total !== null && row.output_total !== null);
    if (protocol === 'anthropic') assertKimiNativeUsageMatchesDurable(row, nativeUsage);
    const expected = BigInt(row.input_total) * 2n + BigInt(row.output_total) * 3n;
    assert.ok(expected > 0n);
    assert.equal(row.settlement_amount, expected.toString());
    assert.equal(row.ledger_amount, expected.toString());
    assert.equal(row.ledger_credit, expected.toString());
    assert.equal(row.ledger_debit, expected.toString());
    assert.equal(row.ledger_source, 'billing_settlement');
    assert.equal(row.ledger_entries, '2');
    assert.equal(row.canonical_request_id, requestId);
    // Dispatch commits settlement before its finally block releases the lease.
    // Only a valid positive PostgreSQL count may wait after all financial checks.
    if (typeof row.held_leases === 'string' && /^[1-9][0-9]{0,18}$/.test(row.held_leases) &&
        BigInt(row.held_leases) <= 9_223_372_036_854_775_807n) return undefined;
    assert.equal(row.held_leases, '0');
    return row;
}

export async function waitKimiSettled(fixture: KimiCommercialFixture, requestId: string, protocol: ClientProtocol) {
  try { return await waitUntil('Real Kimi usage settlement', async () => {
    const row = await readDurableKimiRequest(fixture, requestId);
    captureKimiSettlementState(fixture, requestId, row);
    return classifyKimiSettlementObservation(fixture, requestId, protocol, row,
      settlementDiagnostic(fixture, requestId).rawUsage);
  }); } catch (error) {
    const diagnostic = settlementDiagnostic(fixture, requestId);
    diagnostic.failure = { exception: error instanceof assert.AssertionError ? 'AssertionError' : error instanceof Error ? 'Error' : 'unrecognized',
      code: fixedValue(record(error) ? error.code : null, ['ERR_ASSERTION', ...SAFE_SQLSTATES]) };
    try { captureKimiSettlementState(fixture, requestId, await readDurableKimiRequest(fixture, requestId)); } catch { /* Earlier safe state remains available. */ }
    diagnostic.postgres = await readOwnedPostgresFailureCodes();
    try {
      const financial = await kimiFinancialSnapshot(fixture);
      diagnostic.financial = Object.fromEntries(Object.entries(financial).map(([name, value]) => [name, safeDecimal(value)]));
    } catch { /* Do not replace the terminal diagnostic with an observer error. */ }
    throw new Error(`Kimi commercial settlement failed: ${JSON.stringify(diagnostic)}`);
  }
}

export async function kimiFinancialSnapshot(fixture: KimiCommercialFixture) {
  const result = await fixture.database.query<{ wallet: string; requests: string; attempts: string; usage: string;
    settlements: string; ledger_transactions: string; ledger_entries: string; hold: string; snapshots: string; leases: string }>(`SELECT
    (SELECT COALESCE(sum(posted_balance_minor_units),0)::text FROM saas_wallets WHERE tenant_id=$1) AS wallet,
    (SELECT count(*)::text FROM saas_requests WHERE tenant_id=$1) AS requests,
    (SELECT count(*)::text FROM saas_attempts WHERE tenant_id=$1) AS attempts,
    (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id=$1) AS usage,
    (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id=$1) AS settlements,
    (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1) AS ledger_transactions,
    (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id=$1) AS ledger_entries,
    (SELECT COALESCE(sum(amount_minor_units),0)::text FROM saas_billing_reservations WHERE tenant_id=$1 AND state IN ('reserved','reconciliation_pending')) AS hold,
    (SELECT count(*)::text FROM saas_request_customer_price_snapshots WHERE tenant_id=$1) AS snapshots,
    (SELECT count(*)::text FROM saas_provider_account_leases WHERE tenant_id=$1) AS leases`, [fixture.tenantId]);
  assert.ok(result.rows[0]);
  return result.rows[0];
}
