/**
 * Content risk control — the gateway-side judgment chain (reference: sub2api
 * content_moderation.go, direct adaptation to this gateway's seams).
 *
 * Chain (per request, exactly once, at the post-auth/pre-preparation seam):
 *   mode off → allow; tenant scope → model scope → keyword match (zero API
 *   latency; keyword_only stops here) → pre-hash blocklist (previously
 *   flagged input hashes, zero API latency) → sampling (hash % rate) →
 *   OpenAI-compatible /v1/moderations with a multi-key pool and per-key
 *   freeze circuit breaker → 13-category threshold comparison.
 *
 * Fail-open is a hard requirement: any internal failure (config load, store,
 * moderation API, email) allows the request and is logged — moderation never
 * blocks a request except on an explicit policy hit.
 *
 * The runtime snapshot caches the normalized config plus the built
 * Aho-Corasick matcher for 1s (stale-while-revalidate); the matcher is only
 * rebuilt when the raw config digest changes.
 */

import { createHash } from 'node:crypto';
import { buildKeywordMatcher, type KeywordMatcher, matchKeyword } from './keyword-matcher.js';
import {
  extractModerationText,
  MAX_MODERATION_EXCERPT_RUNES,
  MAX_MODERATION_INPUT_RUNES,
  type ModerationProtocol,
  moderationInputHash,
  trimRunes,
} from './moderation-input.js';

export type RiskControlMode = 'off' | 'observe' | 'pre_block';
export type KeywordBlockingMode = 'keyword_only' | 'keyword_and_api' | 'api_only';
export type RiskControlModelFilterType = 'all' | 'include' | 'exclude';

export const MODERATION_CATEGORIES = Object.freeze([
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const);

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export const DEFAULT_MODERATION_THRESHOLDS: Readonly<Record<string, number>> = Object.freeze({
  harassment: 0.98,
  'harassment/threatening': 0.9,
  hate: 0.65,
  'hate/threatening': 0.65,
  illicit: 0.95,
  'illicit/violent': 0.95,
  'self-harm': 0.65,
  'self-harm/intent': 0.85,
  'self-harm/instructions': 0.65,
  sexual: 0.65,
  'sexual/minors': 0.65,
  violence: 0.95,
  'violence/graphic': 0.95,
});

export const RISK_CONTROL_MODES: ReadonlySet<string> = new Set(['off', 'observe', 'pre_block']);
export const KEYWORD_BLOCKING_MODES: ReadonlySet<string> = new Set(['keyword_only', 'keyword_and_api', 'api_only']);
export const MODEL_FILTER_TYPES: ReadonlySet<string> = new Set(['all', 'include', 'exclude']);

export const DEFAULT_MODERATION_BASE_URL = 'https://api.openai.com';
export const DEFAULT_MODERATION_MODEL = 'omni-moderation-latest';
export const DEFAULT_MODERATION_TIMEOUT_MS = 3000;
export const MAX_MODERATION_TIMEOUT_MS = 30000;
export const DEFAULT_MODERATION_BLOCK_STATUS = 403;
export const DEFAULT_MODERATION_BLOCK_MESSAGE = '内容审计命中风险规则，请调整输入后重试';
export const DEFAULT_MODERATION_BAN_THRESHOLD = 10;
export const DEFAULT_MODERATION_VIOLATION_WINDOW_HOURS = 720;
export const DEFAULT_MODERATION_RETRY_COUNT = 2;
export const MAX_MODERATION_RETRY_COUNT = 5;
export const DEFAULT_MODERATION_HIT_RETENTION_DAYS = 180;
export const DEFAULT_MODERATION_NON_HIT_RETENTION_DAYS = 3;
export const MAX_MODERATION_RETENTION_DAYS = 3650;
export const MAX_MODERATION_BLOCKED_KEYWORDS = 10000;
export const MAX_MODERATION_BLOCKED_KEYWORD_RUNES = 200;
export const MAX_MODERATION_MODEL_FILTER_MODELS = 1000;
export const MAX_MODERATION_MODEL_FILTER_RUNES = 200;
export const KEY_RATE_LIMIT_FREEZE_MS = 60_000;
export const KEY_AUTH_FREEZE_MS = 600_000;
export const KEY_HTTP_ERROR_FREEZE_MS = 10_000;
export const DEFAULT_RUNTIME_SNAPSHOT_TTL_MS = 1000;
export const MAX_OBSERVE_IN_FLIGHT = 256;

export interface RiskControlModelFilter {
  readonly type: RiskControlModelFilterType;
  readonly models: readonly string[];
}

export interface RiskControlConfig {
  readonly enabled: boolean;
  readonly mode: RiskControlMode;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeys: readonly string[];
  readonly timeoutMs: number;
  readonly sampleRate: number;
  readonly allTenants: boolean;
  readonly tenantIds: readonly string[];
  readonly recordNonHits: boolean;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly blockStatus: number;
  readonly blockMessage: string;
  readonly emailOnHit: boolean;
  readonly autoBanEnabled: boolean;
  readonly banThreshold: number;
  readonly violationWindowHours: number;
  readonly retryCount: number;
  readonly hitRetentionDays: number;
  readonly nonHitRetentionDays: number;
  readonly preHashCheckEnabled: boolean;
  readonly blockedKeywords: readonly string[];
  readonly keywordBlockingMode: KeywordBlockingMode;
  readonly modelFilter: RiskControlModelFilter;
}

export type ModerationAction = 'allow' | 'block' | 'hash_block' | 'keyword_block' | 'error';

export interface ContentModerationLogRow {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly apiKeyId: string;
  readonly apiKeyName: string;
  readonly model: string;
  readonly protocol: ModerationProtocol;
  readonly mode: RiskControlMode;
  readonly action: ModerationAction;
  readonly flagged: boolean;
  readonly highestCategory: string;
  readonly highestScore: number;
  readonly matchedKeyword: string;
  readonly categoryScores: Readonly<Record<string, number>>;
  readonly thresholdSnapshot: Readonly<Record<string, number>>;
  readonly inputExcerpt: string;
  readonly inputHash: string | null;
  readonly upstreamLatencyMs: number | null;
  readonly error: string;
  readonly violationCount: number;
  readonly autoBanned: boolean;
  readonly emailSent: boolean;
}

export interface ContentModerationCheckInput {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly apiKeyId: string;
  readonly apiKeyName: string;
  readonly protocol: ModerationProtocol;
  readonly model: string;
  readonly body: Record<string, unknown>;
}

export interface ContentModerationDecision {
  readonly allowed: boolean;
  readonly statusCode: number;
  readonly message: string;
  readonly action: ModerationAction;
  readonly flagged: boolean;
  readonly highestCategory: string;
  readonly highestScore: number;
}

const ALLOWED_DECISION: ContentModerationDecision = Object.freeze({
  allowed: true,
  statusCode: 0,
  message: '',
  action: 'allow',
  flagged: false,
  highestCategory: '',
  highestScore: 0,
});

export interface ModerationEmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Mutable working copy of a log row (side effects fill these fields in). */
export type MutableContentModerationLogRow = {
  -readonly [K in keyof ContentModerationLogRow]: ContentModerationLogRow[K];
};

/** Shape-compatible with identity's EmailSender and observability's AlertEmailSender. */
export interface ModerationEmailSender {
  send(input: ModerationEmailMessage): Promise<void>;
}

export interface ModerationUserContact {
  readonly email: string | null;
}

export interface ModerationDisableUserResult {
  /** True when this call flipped the account from active to disabled. */
  readonly newlyDisabled: boolean;
}

export interface ModerationAuditEvent {
  readonly tenantId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestId: string;
}

export type ModerationFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Persistence port. Every method may throw; the service treats store
 * failures as fail-open (allow + structured log) except where noted.
 */
export interface ContentModerationStore {
  /** Raw config JSON text, or null when no row exists (defaults apply). */
  readRawConfig(): Promise<string | null>;
  insertLog(row: ContentModerationLogRow): Promise<void>;
  /** Flagged hits inside the violation window, excluding hash_block rows. */
  countFlaggedByUserSince(userId: string, sinceIso: string): Promise<number>;
  hasFlaggedInputHash(inputHash: string): Promise<boolean>;
  recordFlaggedInputHash(inputHash: string): Promise<void>;
  /** Sets disabled_at; must refuse users holding platform roles. */
  disableUser(userId: string): Promise<ModerationDisableUserResult>;
  userContact(userId: string): Promise<ModerationUserContact | null>;
  /** Best-effort audit trail write for the auto-ban decision. */
  insertAuditEvent(event: ModerationAuditEvent): Promise<void>;
}

interface ModerationKeyHealth {
  masked: string;
  failureCount: number;
  successCount: number;
  lastError: string;
  frozenUntilMs: number;
  lastHttpStatus: number;
}

interface RuntimeSnapshot {
  readonly config: RiskControlConfig;
  readonly keywordMatcher: KeywordMatcher | null;
  readonly configDigest: string;
  readonly loadedAtMs: number;
}

export class RiskControlConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RiskControlConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function maskSecretTail(secret: string): string {
  if (secret.length <= 8) return '****';
  return `****${secret.slice(-4)}`;
}

function normalizeApiKeys(keys: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const trimmed = key.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeBlockedKeywords(keywords: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    if (typeof raw !== 'string') continue;
    const keyword = trimRunes(raw.trim(), MAX_MODERATION_BLOCKED_KEYWORD_RUNES);
    if (keyword === '') continue;
    const dedupeKey = keyword.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(keyword);
    if (out.length >= MAX_MODERATION_BLOCKED_KEYWORDS) break;
  }
  return out;
}

function normalizeModelNames(models: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const model = trimRunes(raw.trim(), MAX_MODERATION_MODEL_FILTER_RUNES);
    if (model === '') continue;
    const dedupeKey = model.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(model);
    if (out.length >= MAX_MODERATION_MODEL_FILTER_MODELS) break;
  }
  return out;
}

function mergeThresholds(override: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_MODERATION_THRESHOLDS };
  if (!override) return out;
  for (const category of MODERATION_CATEGORIES) {
    const value = override[category];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[category] = Math.min(1, Math.max(0, value));
    }
  }
  return out;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return fallback;
  return Math.min(max, rounded);
}

/** Lenient runtime parse: unknown/invalid fields fall back to defaults. */
export function normalizeRiskControlConfig(raw: unknown): RiskControlConfig {
  const input = isRecord(raw) ? raw : {};
  const mode = RISK_CONTROL_MODES.has(String(input.mode)) ? (input.mode as RiskControlMode) : 'pre_block';
  const keywordMode = KEYWORD_BLOCKING_MODES.has(String(input.keyword_blocking_mode))
    ? (input.keyword_blocking_mode as KeywordBlockingMode)
    : 'keyword_and_api';
  const filterType = MODEL_FILTER_TYPES.has(String(input.model_filter_type))
    ? (input.model_filter_type as RiskControlModelFilterType)
    : 'all';
  const baseUrlRaw = typeof input.base_url === 'string' ? input.base_url.trim().replace(/\/+$/, '') : '';
  const model =
    typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : DEFAULT_MODERATION_MODEL;
  const blockMessage =
    typeof input.block_message === 'string' && input.block_message.trim() !== ''
      ? input.block_message.trim()
      : DEFAULT_MODERATION_BLOCK_MESSAGE;
  return {
    enabled: input.enabled === true,
    mode,
    baseUrl: baseUrlRaw !== '' ? baseUrlRaw : DEFAULT_MODERATION_BASE_URL,
    model,
    apiKeys: normalizeApiKeys(Array.isArray(input.api_keys) ? input.api_keys : []),
    timeoutMs: clampInteger(input.timeout_ms, DEFAULT_MODERATION_TIMEOUT_MS, 1, MAX_MODERATION_TIMEOUT_MS),
    sampleRate: clampInteger(input.sample_rate, 100, 0, 100),
    allTenants: input.all_tenants !== false,
    tenantIds: Array.isArray(input.tenant_ids)
      ? input.tenant_ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : [],
    recordNonHits: input.record_non_hits === true,
    thresholds: mergeThresholds(isRecord(input.thresholds) ? input.thresholds : undefined),
    blockStatus: clampInteger(input.block_status, DEFAULT_MODERATION_BLOCK_STATUS, 400, 599),
    blockMessage,
    emailOnHit: input.email_on_hit !== false,
    autoBanEnabled: input.auto_ban_enabled !== false,
    banThreshold: clampInteger(input.ban_threshold, DEFAULT_MODERATION_BAN_THRESHOLD, 1, 1_000_000),
    violationWindowHours: clampInteger(
      input.violation_window_hours,
      DEFAULT_MODERATION_VIOLATION_WINDOW_HOURS,
      1,
      1_000_000,
    ),
    retryCount: clampInteger(input.retry_count, DEFAULT_MODERATION_RETRY_COUNT, 0, MAX_MODERATION_RETRY_COUNT),
    hitRetentionDays: clampInteger(
      input.hit_retention_days,
      DEFAULT_MODERATION_HIT_RETENTION_DAYS,
      1,
      MAX_MODERATION_RETENTION_DAYS,
    ),
    nonHitRetentionDays: clampInteger(
      input.non_hit_retention_days,
      DEFAULT_MODERATION_NON_HIT_RETENTION_DAYS,
      1,
      DEFAULT_MODERATION_NON_HIT_RETENTION_DAYS,
    ),
    preHashCheckEnabled: input.pre_hash_check_enabled === true,
    blockedKeywords: normalizeBlockedKeywords(Array.isArray(input.blocked_keywords) ? input.blocked_keywords : []),
    keywordBlockingMode: keywordMode,
    modelFilter: {
      type: filterType,
      models: normalizeModelNames(Array.isArray(input.model_filter_models) ? input.model_filter_models : []),
    },
  };
}

const RISK_CONTROL_CONFIG_KEYS = new Set([
  'enabled',
  'mode',
  'base_url',
  'model',
  'api_keys',
  'timeout_ms',
  'sample_rate',
  'all_tenants',
  'tenant_ids',
  'record_non_hits',
  'thresholds',
  'block_status',
  'block_message',
  'email_on_hit',
  'auto_ban_enabled',
  'ban_threshold',
  'violation_window_hours',
  'retry_count',
  'hit_retention_days',
  'non_hit_retention_days',
  'pre_hash_check_enabled',
  'blocked_keywords',
  'keyword_blocking_mode',
  'model_filter_type',
  'model_filter_models',
]);

/**
 * Strict admin-input parse (PUT /risk-control/config): unknown keys, invalid
 * enums, malformed URLs or inconsistent filters are rejected. The persisted
 * JSON is the same snake_case shape `normalizeRiskControlConfig` reads.
 */
export function parseRiskControlConfigInput(raw: unknown): RiskControlConfig {
  if (!isRecord(raw)) {
    throw new RiskControlConfigError('INVALID_RISK_CONTROL_CONFIG', '配置必须是 JSON 对象');
  }
  for (const key of Object.keys(raw)) {
    if (!RISK_CONTROL_CONFIG_KEYS.has(key)) {
      throw new RiskControlConfigError('INVALID_RISK_CONTROL_CONFIG', `未知配置字段: ${key}`);
    }
  }
  if (raw.mode !== undefined && !RISK_CONTROL_MODES.has(String(raw.mode))) {
    throw new RiskControlConfigError('INVALID_RISK_CONTROL_MODE', '内容审计模式无效');
  }
  if (raw.keyword_blocking_mode !== undefined && !KEYWORD_BLOCKING_MODES.has(String(raw.keyword_blocking_mode))) {
    throw new RiskControlConfigError('INVALID_KEYWORD_BLOCKING_MODE', '关键词拦截模式无效');
  }
  if (raw.base_url !== undefined) {
    let url: URL;
    try {
      url = new URL(String(raw.base_url));
    } catch {
      throw new RiskControlConfigError('INVALID_RISK_CONTROL_BASE_URL', '审计 Base URL 无效');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RiskControlConfigError('INVALID_RISK_CONTROL_BASE_URL', '审计 Base URL 必须是 http(s)');
    }
  }
  if (raw.thresholds !== undefined) {
    if (!isRecord(raw.thresholds)) {
      throw new RiskControlConfigError('INVALID_RISK_CONTROL_THRESHOLDS', '阈值必须是对象');
    }
    for (const key of Object.keys(raw.thresholds)) {
      if (!(MODERATION_CATEGORIES as readonly string[]).includes(key)) {
        throw new RiskControlConfigError('INVALID_RISK_CONTROL_THRESHOLDS', `未知审计类别: ${key}`);
      }
    }
  }
  if (raw.model_filter_type !== undefined && !MODEL_FILTER_TYPES.has(String(raw.model_filter_type))) {
    throw new RiskControlConfigError('INVALID_RISK_CONTROL_MODEL_FILTER', '模型过滤类型无效');
  }
  const config = normalizeRiskControlConfig(raw);
  if (config.modelFilter.type !== 'all' && config.modelFilter.models.length === 0) {
    throw new RiskControlConfigError('INVALID_RISK_CONTROL_MODEL_FILTER', '指定或排除模型时至少需要配置 1 个模型');
  }
  return config;
}

/** Serializes a normalized config back to the persisted snake_case JSON shape. */
export function serializeRiskControlConfig(config: RiskControlConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    mode: config.mode,
    base_url: config.baseUrl,
    model: config.model,
    api_keys: config.apiKeys,
    timeout_ms: config.timeoutMs,
    sample_rate: config.sampleRate,
    all_tenants: config.allTenants,
    tenant_ids: config.tenantIds,
    record_non_hits: config.recordNonHits,
    thresholds: config.thresholds,
    block_status: config.blockStatus,
    block_message: config.blockMessage,
    email_on_hit: config.emailOnHit,
    auto_ban_enabled: config.autoBanEnabled,
    ban_threshold: config.banThreshold,
    violation_window_hours: config.violationWindowHours,
    retry_count: config.retryCount,
    hit_retention_days: config.hitRetentionDays,
    non_hit_retention_days: config.nonHitRetentionDays,
    pre_hash_check_enabled: config.preHashCheckEnabled,
    blocked_keywords: config.blockedKeywords,
    keyword_blocking_mode: config.keywordBlockingMode,
    model_filter_type: config.modelFilter.type,
    model_filter_models: config.modelFilter.models,
  });
}

export function defaultRiskControlConfig(): RiskControlConfig {
  return normalizeRiskControlConfig({});
}

export interface ScoreEvaluation {
  readonly flagged: boolean;
  readonly highestCategory: string;
  readonly highestScore: number;
}

/** Threshold comparison over the 13 categories (category order breaks ties). */
export function evaluateModerationScores(
  scores: Readonly<Record<string, number>>,
  thresholds: Readonly<Record<string, number>>,
): ScoreEvaluation {
  let flagged = false;
  let highestCategory = '';
  let highestScore = 0;
  for (const category of MODERATION_CATEGORIES) {
    const score = scores[category] ?? 0;
    if (score > highestScore || highestCategory === '') {
      highestScore = score;
      highestCategory = category;
    }
    if (score >= (thresholds[category] ?? 1)) {
      flagged = true;
    }
  }
  const extras = Object.keys(scores)
    .filter((key) => !(MODERATION_CATEGORIES as readonly string[]).includes(key))
    .sort();
  for (const category of extras) {
    const score = scores[category] ?? 0;
    if (score > highestScore || highestCategory === '') {
      highestScore = score;
      highestCategory = category;
    }
  }
  return { flagged, highestCategory, highestScore };
}

export function shouldSample(inputHash: string, sampleRate: number): boolean {
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;
  const value = Number.parseInt(inputHash.slice(0, 4), 16);
  if (!Number.isFinite(value)) return true;
  return value % 100 < sampleRate;
}

export function includesModel(config: RiskControlConfig, model: string): boolean {
  const models = config.modelFilter.models;
  const contains = models.some((candidate) => candidate.toLowerCase() === model.trim().toLowerCase());
  switch (config.modelFilter.type) {
    case 'include':
      return contains;
    case 'exclude':
      return !contains;
    default:
      return true;
  }
}

export function includesTenant(config: RiskControlConfig, tenantId: string): boolean {
  if (config.allTenants) return true;
  return config.tenantIds.includes(tenantId);
}

/** Per-key freeze duration for the moderation API pool (circuit breaker). */
export function freezeDurationForHttpStatus(httpStatus: number): number {
  if (httpStatus === 0 || httpStatus === 400) return 0;
  if (httpStatus === 401 || httpStatus === 403) return KEY_AUTH_FREEZE_MS;
  if (httpStatus === 429 || httpStatus === 529) return KEY_RATE_LIMIT_FREEZE_MS;
  return KEY_HTTP_ERROR_FREEZE_MS;
}

interface ModerationApiResult {
  readonly categoryScores: Record<string, number>;
}

interface ContentModerationServiceOptions {
  readonly store: ContentModerationStore;
  readonly emailSender?: ModerationEmailSender;
  readonly siteName?: string;
  readonly fetchImpl?: ModerationFetch;
  readonly nowMs?: () => number;
  readonly runtimeCacheTtlMs?: number;
  readonly observeInFlightLimit?: number;
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ scope: 'saas.risk-control', event, ...fields }));
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export class SaasContentModerationService {
  private readonly store: ContentModerationStore;
  private readonly emailSender: ModerationEmailSender | undefined;
  private readonly siteName: string;
  private readonly fetchImpl: ModerationFetch;
  private readonly nowMs: () => number;
  private readonly runtimeCacheTtlMs: number;
  private readonly observeInFlightLimit: number;
  private snapshot: RuntimeSnapshot | null = null;
  private refreshing = false;
  private refreshRetryAtMs = 0;
  private readonly keyHealth = new Map<string, ModerationKeyHealth>();
  private apiKeyCursor = 0;
  private observeInFlight = 0;
  private observeDropped = 0;

  constructor(options: ContentModerationServiceOptions) {
    this.store = options.store;
    this.emailSender = options.emailSender;
    this.siteName = options.siteName ?? 'Model Router';
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.nowMs = options.nowMs ?? Date.now;
    this.runtimeCacheTtlMs = options.runtimeCacheTtlMs ?? DEFAULT_RUNTIME_SNAPSHOT_TTL_MS;
    this.observeInFlightLimit = options.observeInFlightLimit ?? MAX_OBSERVE_IN_FLIGHT;
  }

  /** The judgment chain. Never throws: every failure path allows the request. */
  async check(input: ContentModerationCheckInput): Promise<ContentModerationDecision> {
    try {
      return await this.checkInner(input);
    } catch (error) {
      logEvent('moderation_check_failed', {
        requestId: input.requestId,
        tenantId: input.tenantId,
        model: input.model,
        error: messageOf(error),
      });
      return ALLOWED_DECISION;
    }
  }

  private async checkInner(input: ContentModerationCheckInput): Promise<ContentModerationDecision> {
    const snapshot = await this.loadRuntimeSnapshot();
    if (snapshot === null) return ALLOWED_DECISION;
    const config = snapshot.config;
    if (!config.enabled || config.mode === 'off') return ALLOWED_DECISION;
    if (!includesTenant(config, input.tenantId)) return ALLOWED_DECISION;
    if (!includesModel(config, input.model)) return ALLOWED_DECISION;

    if (config.mode === 'pre_block') {
      if (config.keywordBlockingMode !== 'api_only' && config.blockedKeywords.length > 0) {
        const keywordText = extractModerationText(input.protocol, input.body, false);
        const matched = matchKeyword(snapshot.keywordMatcher, keywordText);
        if (matched.hit) {
          const row = this.buildLog(
            input,
            config,
            'keyword_block',
            true,
            'keyword',
            1,
            { keyword: 1 },
            keywordText,
            null,
            '',
          );
          row.matchedKeyword = matched.keyword;
          await this.persistSideEffects(row, { recordHash: false, applySideEffects: true });
          return this.blockDecision(config, 'keyword_block', 'keyword', 1, '');
        }
      }
      if (config.keywordBlockingMode === 'keyword_only') return ALLOWED_DECISION;
    }

    const text = trimRunes(extractModerationText(input.protocol, input.body, true), MAX_MODERATION_INPUT_RUNES);
    if (text === '') return ALLOWED_DECISION;
    const inputHash = moderationInputHash(text);

    if (config.preHashCheckEnabled) {
      let matched = false;
      try {
        matched = await this.store.hasFlaggedInputHash(inputHash);
      } catch (error) {
        logEvent('hash_check_failed', {
          requestId: input.requestId,
          tenantId: input.tenantId,
          error: messageOf(error),
        });
      }
      if (matched) {
        const row = this.buildLog(input, config, 'hash_block', true, 'hash', 1, { hash: 1 }, text, null, '');
        await this.persistSideEffects(row, { recordHash: false, applySideEffects: false });
        const message =
          config.blockMessage !== '' ? `${config.blockMessage}（hash: ${inputHash}）` : `hash: ${inputHash}`;
        return this.blockDecision(config, 'hash_block', 'hash', 1, message);
      }
    }

    if (!shouldSample(inputHash, config.sampleRate)) return ALLOWED_DECISION;

    if (config.apiKeys.length === 0) {
      logEvent('skip_no_audit_api_keys', { requestId: input.requestId, tenantId: input.tenantId, mode: config.mode });
      return ALLOWED_DECISION;
    }

    if (config.mode === 'observe') {
      this.dispatchObserveCheck(input, config, text, inputHash);
      return ALLOWED_DECISION;
    }

    return await this.checkSync(input, config, text, inputHash);
  }

  private dispatchObserveCheck(
    input: ContentModerationCheckInput,
    config: RiskControlConfig,
    text: string,
    inputHash: string,
  ): void {
    if (this.observeInFlight >= this.observeInFlightLimit) {
      this.observeDropped += 1;
      logEvent('observe_check_dropped', { requestId: input.requestId, dropped: this.observeDropped });
      return;
    }
    this.observeInFlight += 1;
    void this.checkSync(input, config, text, inputHash)
      .catch(() => undefined)
      .finally(() => {
        this.observeInFlight -= 1;
      });
  }

  private async checkSync(
    input: ContentModerationCheckInput,
    config: RiskControlConfig,
    text: string,
    inputHash: string,
  ): Promise<ContentModerationDecision> {
    const startMs = this.nowMs();
    let result: ModerationApiResult | null = null;
    let failure = '';
    try {
      result = await this.callModeration(config, text);
    } catch (error) {
      failure = messageOf(error);
      logEvent('audit_api_failed', {
        requestId: input.requestId,
        tenantId: input.tenantId,
        mode: config.mode,
        error: failure,
      });
    }
    const latencyMs = Math.max(0, this.nowMs() - startMs);
    if (result === null) {
      if (config.recordNonHits) {
        const row = this.buildLog(input, config, 'error', false, '', 0, {}, text, latencyMs, trimRunes(failure, 500));
        await this.persistSideEffects(row, { recordHash: false, applySideEffects: false });
      }
      return ALLOWED_DECISION;
    }

    const evaluation = evaluateModerationScores(result.categoryScores, config.thresholds);
    const blocked = config.mode === 'pre_block' && evaluation.flagged;
    const action: ModerationAction = blocked ? 'block' : 'allow';
    if (evaluation.flagged || config.recordNonHits) {
      const row = this.buildLog(
        input,
        config,
        action,
        evaluation.flagged,
        evaluation.highestCategory,
        evaluation.highestScore,
        result.categoryScores,
        text,
        latencyMs,
        '',
      );
      await this.persistSideEffects(row, {
        recordHash: evaluation.flagged,
        applySideEffects: evaluation.flagged,
        inputHash,
      });
    }
    if (blocked) {
      return this.blockDecision(config, 'block', evaluation.highestCategory, evaluation.highestScore, '');
    }
    return {
      allowed: true,
      statusCode: 0,
      message: '',
      action: 'allow',
      flagged: evaluation.flagged,
      highestCategory: evaluation.highestCategory,
      highestScore: evaluation.highestScore,
    };
  }

  private blockDecision(
    config: RiskControlConfig,
    action: ModerationAction,
    highestCategory: string,
    highestScore: number,
    messageOverride: string,
  ): ContentModerationDecision {
    return {
      allowed: false,
      statusCode: config.blockStatus,
      message: messageOverride !== '' ? messageOverride : config.blockMessage,
      action,
      flagged: true,
      highestCategory,
      highestScore,
    };
  }

  private buildLog(
    input: ContentModerationCheckInput,
    config: RiskControlConfig,
    action: ModerationAction,
    flagged: boolean,
    highestCategory: string,
    highestScore: number,
    scores: Readonly<Record<string, number>>,
    text: string,
    latencyMs: number | null,
    errorText: string,
  ): MutableContentModerationLogRow {
    return {
      requestId: input.requestId,
      tenantId: input.tenantId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      apiKeyName: input.apiKeyName,
      model: input.model,
      protocol: input.protocol,
      mode: config.mode,
      action,
      flagged,
      highestCategory,
      highestScore,
      matchedKeyword: '',
      categoryScores: { ...scores },
      thresholdSnapshot: { ...config.thresholds },
      inputExcerpt: trimRunes(text, MAX_MODERATION_EXCERPT_RUNES),
      inputHash: null,
      upstreamLatencyMs: latencyMs,
      error: errorText,
      violationCount: 0,
      autoBanned: false,
      emailSent: false,
    };
  }

  /**
   * Persist a decision: record the flagged hash, apply account side effects
   * (violation counting, auto-ban, email), then insert the log row. Each
   * stage fails soft — a moderation hit must never be lost because a side
   * effect failed, and a side-effect failure must never crash the chain.
   */
  private async persistSideEffects(
    row: MutableContentModerationLogRow,
    options: { recordHash: boolean; applySideEffects: boolean; inputHash?: string },
  ): Promise<void> {
    if (options.recordHash && options.inputHash !== undefined) {
      try {
        await this.store.recordFlaggedInputHash(options.inputHash);
      } catch (error) {
        logEvent('record_hash_failed', { requestId: row.requestId, error: messageOf(error) });
      }
    }
    if (options.applySideEffects && row.flagged) {
      await this.applyAccountSideEffects(row);
    }
    try {
      await this.store.insertLog(row);
    } catch (error) {
      logEvent('create_log_failed', { requestId: row.requestId, action: row.action, error: messageOf(error) });
    }
  }

  private async applyAccountSideEffects(row: MutableContentModerationLogRow): Promise<void> {
    if (!row.flagged || row.userId === null) return;
    const config = this.snapshot?.config;
    if (config === null || config === undefined) return;
    let count = 1;
    if (config.violationWindowHours > 0) {
      const since = new Date(this.nowMs() - config.violationWindowHours * 3_600_000);
      try {
        const previous = await this.store.countFlaggedByUserSince(row.userId, since.toISOString());
        count = previous + 1;
      } catch (error) {
        logEvent('violation_count_failed', { requestId: row.requestId, error: messageOf(error) });
      }
    }
    row.violationCount = count;
    let autoBanJustApplied = false;
    if (config.autoBanEnabled && count >= config.banThreshold) {
      try {
        const result = await this.store.disableUser(row.userId);
        if (result.newlyDisabled) {
          autoBanJustApplied = true;
          row.autoBanned = true;
          logEvent('user_auto_banned', {
            requestId: row.requestId,
            userId: row.userId,
            tenantId: row.tenantId,
            violationCount: count,
            banThreshold: config.banThreshold,
          });
          try {
            await this.store.insertAuditEvent({
              tenantId: row.tenantId,
              action: 'saas.risk_control.user_auto_banned',
              targetType: 'user',
              targetId: row.userId,
              requestId: row.requestId,
            });
          } catch (error) {
            logEvent('ban_audit_failed', { requestId: row.requestId, error: messageOf(error) });
          }
        } else {
          row.autoBanned = true;
        }
      } catch (error) {
        logEvent('ban_update_user_failed', { requestId: row.requestId, userId: row.userId, error: messageOf(error) });
      }
    }
    await this.sendNotificationEmails(row, autoBanJustApplied);
  }

  private async sendNotificationEmails(
    row: MutableContentModerationLogRow,
    autoBanJustApplied: boolean,
  ): Promise<void> {
    const config = this.snapshot?.config;
    if (config === undefined) return;
    if (!this.emailSender) return;
    if (!config.emailOnHit && !autoBanJustApplied) return;
    let email: string | null = null;
    try {
      const contact = await this.store.userContact(row.userId ?? '');
      email = contact?.email ?? null;
    } catch (error) {
      logEvent('user_contact_lookup_failed', { requestId: row.requestId, error: messageOf(error) });
    }
    if (email === null || email.trim() === '') return;
    let sent = false;
    if (config.emailOnHit) {
      try {
        await this.emailSender.send({
          to: email,
          subject: `[${this.siteName}] 账户风控提醒 / Risk Control Notice`,
          body: buildViolationEmailBody(this.siteName, row, config, row.tenantId),
        });
        sent = true;
      } catch (error) {
        logEvent('email_failed', { requestId: row.requestId, error: messageOf(error) });
      }
    }
    if (autoBanJustApplied) {
      try {
        await this.emailSender.send({
          to: email,
          subject: `[${this.siteName}] 账户已被禁用 / Account Disabled`,
          body: buildAccountDisabledEmailBody(this.siteName, row, config, row.tenantId),
        });
        sent = true;
      } catch (error) {
        logEvent('ban_email_failed', { requestId: row.requestId, error: messageOf(error) });
      }
    }
    row.emailSent = sent;
  }

  /**
   * Runtime snapshot with stale-while-revalidate: within the TTL the cached
   * snapshot is served; past it the stale snapshot is served while a single
   * background refresh runs; the Aho-Corasick matcher is rebuilt only when
   * the raw config digest changes. Returns null (fail-open) when no
   * snapshot exists yet and the first load fails.
   */
  private async loadRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
    const now = this.nowMs();
    const cached = this.snapshot;
    if (cached !== null && now - cached.loadedAtMs < this.runtimeCacheTtlMs) {
      return cached;
    }
    if (cached !== null) {
      this.triggerBackgroundRefresh(now);
      return cached;
    }
    try {
      return await this.refreshSnapshot();
    } catch (error) {
      logEvent('config_load_failed', { error: messageOf(error) });
      return null;
    }
  }

  private triggerBackgroundRefresh(now: number): void {
    if (this.refreshing || now < this.refreshRetryAtMs) return;
    this.refreshing = true;
    void this.refreshSnapshot()
      .catch((error: unknown) => {
        this.refreshRetryAtMs = this.nowMs() + this.runtimeCacheTtlMs;
        logEvent('runtime_snapshot_refresh_failed', { error: messageOf(error) });
      })
      .finally(() => {
        this.refreshing = false;
      });
  }

  private async refreshSnapshot(): Promise<RuntimeSnapshot> {
    const raw = await this.store.readRawConfig();
    const rawText = raw ?? '';
    const configDigest = sha256Hex(rawText);
    const cached = this.snapshot;
    if (cached !== null && cached.configDigest === configDigest) {
      const snapshot: RuntimeSnapshot = {
        config: cached.config,
        keywordMatcher: cached.keywordMatcher,
        configDigest,
        loadedAtMs: this.nowMs(),
      };
      this.snapshot = snapshot;
      return snapshot;
    }
    let parsed: unknown;
    if (rawText.trim() === '') {
      parsed = {};
    } else {
      parsed = JSON.parse(rawText);
    }
    const config = normalizeRiskControlConfig(parsed);
    const snapshot: RuntimeSnapshot = {
      config,
      keywordMatcher: buildKeywordMatcher(config.blockedKeywords),
      configDigest,
      loadedAtMs: this.nowMs(),
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  /** Visible for tests: the in-process key health table snapshot. */
  keyHealthStatuses(): ReadonlyArray<{
    masked: string;
    failureCount: number;
    successCount: number;
    lastError: string;
    frozenForMs: number;
    lastHttpStatus: number;
  }> {
    const now = this.nowMs();
    return [...this.keyHealth.values()].map((state) => ({
      masked: state.masked,
      failureCount: state.failureCount,
      successCount: state.successCount,
      lastError: state.lastError,
      frozenForMs: Math.max(0, state.frozenUntilMs - now),
      lastHttpStatus: state.lastHttpStatus,
    }));
  }

  private nextUsableApiKey(config: RiskControlConfig): string | null {
    const keys = config.apiKeys;
    if (keys.length === 0) return null;
    const now = this.nowMs();
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const index = this.apiKeyCursor % keys.length;
      this.apiKeyCursor += 1;
      const key = keys[index];
      if (key === undefined) continue;
      const health = this.keyHealth.get(this.keyHash(key));
      if (health === undefined || health.frozenUntilMs <= now) {
        return key;
      }
    }
    return null;
  }

  private keyHash(key: string): string {
    return sha256Hex(key);
  }

  private markKeySuccess(key: string, httpStatus: number): void {
    const state = this.ensureKeyHealth(this.keyHash(key), key);
    state.failureCount = 0;
    state.successCount += 1;
    state.lastError = '';
    state.frozenUntilMs = 0;
    state.lastHttpStatus = httpStatus;
  }

  private markKeyError(key: string, errorText: string, httpStatus: number): void {
    const state = this.ensureKeyHealth(this.keyHash(key), key);
    const freezeMs = freezeDurationForHttpStatus(httpStatus);
    if (freezeMs > 0) {
      state.failureCount += 1;
      state.frozenUntilMs = this.nowMs() + freezeMs;
    }
    state.lastError = trimRunes(errorText, 180);
    state.lastHttpStatus = httpStatus;
  }

  private ensureKeyHealth(hash: string, key: string): ModerationKeyHealth {
    let state = this.keyHealth.get(hash);
    if (state === undefined) {
      state = {
        masked: maskSecretTail(key),
        failureCount: 0,
        successCount: 0,
        lastError: '',
        frozenUntilMs: 0,
        lastHttpStatus: 0,
      };
      this.keyHealth.set(hash, state);
    }
    return state;
  }

  /**
   * Moderation API call with retry across the key pool. Keys are selected
   * round-robin skipping frozen ones; HTTP 400 (bad request shape) is not
   * retried on another key.
   */
  private async callModeration(config: RiskControlConfig, text: string): Promise<ModerationApiResult> {
    const attempts = Math.max(1, Math.min(config.retryCount + 1, MAX_MODERATION_RETRY_COUNT + 1));
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const key = this.nextUsableApiKey(config);
      if (key === null) {
        lastError = new Error('no moderation api key available');
        break;
      }
      try {
        const result = await this.callModerationOnce(config, key, text);
        this.markKeySuccess(key, 200);
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const httpStatus = (err as Error & { httpStatus?: number }).httpStatus ?? 0;
        this.markKeyError(key, err.message, httpStatus);
        lastError = err;
        if (httpStatus === 400) break;
        if (attempt === attempts - 1) break;
        await delay(100 * (attempt + 1));
      }
    }
    throw lastError ?? new Error('moderation api failed');
  }

  private async callModerationOnce(
    config: RiskControlConfig,
    apiKey: string,
    text: string,
  ): Promise<ModerationApiResult> {
    const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/v1/moderations`;
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: config.model, input: text }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw withStatus(error instanceof Error ? error : new Error(String(error)), 0);
    }
    if (response.status < 200 || response.status >= 300) {
      let excerpt = '';
      try {
        excerpt = trimRunes((await response.text()).trim(), 512);
      } catch {
        excerpt = '';
      }
      throw withStatus(new Error(`moderation api status ${response.status}: ${excerpt}`), response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw withStatus(error instanceof Error ? error : new Error(String(error)), 0);
    }
    const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
    const first = results.length > 0 && isRecord(results[0]) ? results[0] : null;
    if (first === null) {
      throw withStatus(new Error('moderation api returned empty results'), 0);
    }
    const scores: Record<string, number> = {};
    if (isRecord(first.category_scores)) {
      for (const [category, value] of Object.entries(first.category_scores)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          scores[category] = value;
        }
      }
    }
    return { categoryScores: scores };
  }
}

function withStatus(error: Error, httpStatus: number): Error {
  (error as Error & { httpStatus?: number }).httpStatus = httpStatus;
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatTimestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

function emailRecipientName(row: ContentModerationLogRow, tenantId: string): string {
  if (row.userId !== null && row.userId !== '') return `UID ${row.userId}`;
  return tenantId;
}

function buildEmailShell(
  siteName: string,
  heading: string,
  notice: string,
  detailTitle: string,
  rows: string,
  statusBlock: string,
  footer: string,
): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f6fb;color:#222;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="max-width:680px;margin:0 auto;padding:32px 20px;">
    <div style="height:8px;background:#ef4444;border-radius:14px 14px 0 0;"></div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:40px 48px;box-shadow:0 8px 28px rgba(15,23,42,.08);">
      <div style="letter-spacing:4px;color:#999;font-size:14px;text-transform:uppercase;">Risk Control / 风控提醒</div>
      <h1 style="margin:20px 0 28px;font-size:30px;line-height:1.25;">${escapeHtml(heading)}</h1>
      <p style="font-size:17px;line-height:1.9;margin:0 0 24px;">${escapeHtml(notice)}</p>
      <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:12px;padding:22px 28px;margin:28px 0;">
        <h2 style="margin:0 0 18px;color:#b91c1c;font-size:18px;">${escapeHtml(detailTitle)}</h2>
        <table style="width:100%;border-collapse:collapse;font-size:16px;">${rows}</table>
      </div>
      ${statusBlock}
      ${footer}
      <p style="font-size:14px;line-height:1.8;color:#777;margin-top:28px;">此邮件由 ${escapeHtml(siteName)} 自动发送，请勿回复。</p>
    </div>
  </div>
</body></html>`;
}

function detailRow(label: string, value: string, last = false): string {
  const border = last ? '' : 'border-bottom:1px solid #fee2e2;';
  return `<tr><td style="padding:12px 0;color:#888;${border}">${escapeHtml(label)}</td><td style="padding:12px 0;${border}">${escapeHtml(value)}</td></tr>`;
}

function buildViolationEmailBody(
  siteName: string,
  row: ContentModerationLogRow,
  config: RiskControlConfig,
  tenantId: string,
): string {
  const rows = [
    detailRow('触发时间', formatTimestamp(Date.now())),
    detailRow('触发来源', '内容审核'),
    detailRow('所属租户', tenantId),
    detailRow('命中类别', `${row.highestCategory} / ${row.highestScore.toFixed(3)}`),
    detailRow('累计触发次数', `${row.violationCount} 次（阈值 ${config.banThreshold}）`, true),
  ].join('');
  return buildEmailShell(
    siteName,
    '账户触发内容审计规则',
    `尊敬的用户 ${emailRecipientName(row, tenantId)}，您的 API 请求在内容审计中触发平台风控策略。详情如下。`,
    '触发详情',
    rows,
    '',
    '',
  );
}

function buildAccountDisabledEmailBody(
  siteName: string,
  row: ContentModerationLogRow,
  config: RiskControlConfig,
  tenantId: string,
): string {
  const rows = [
    detailRow('封禁时间', formatTimestamp(Date.now())),
    detailRow('触发来源', '内容审核'),
    detailRow('所属租户', tenantId),
    detailRow('命中类别', `${row.highestCategory} / ${row.highestScore.toFixed(3)}`),
    detailRow('累计触发次数', `${row.violationCount} 次（阈值 ${config.banThreshold}）`, true),
  ].join('');
  const statusBlock =
    '<div style="margin-top:24px;padding:18px 20px;border-radius:10px;background:#ff3b30;color:#fff;font-size:18px;font-weight:700;text-align:center;line-height:1.6;">账户当前处于封禁状态，所有 API 请求将被拒绝</div>';
  const footer =
    '<p style="font-size:15px;line-height:1.8;color:#666;margin-top:24px;">如需申诉或恢复账号，请联系平台管理员处理。</p>';
  return buildEmailShell(
    siteName,
    '账户已被自动禁用',
    `尊敬的用户 ${emailRecipientName(row, tenantId)}，您的账户在计数周期内多次触发平台风控策略，系统已自动禁用该账户。详情如下。`,
    '封禁详情',
    rows,
    statusBlock,
    footer,
  );
}
