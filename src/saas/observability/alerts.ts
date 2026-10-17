import { randomUUID } from 'node:crypto';

import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { computeCustomerWebhookSignature } from '../webhooks/signatures.js';
import { type AlertSilenceRecord, isRuleSilenced } from './alert-silences.js';

/**
 * Phase 3 observability alerts (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 4).
 *
 * Rules live in the migration-103 tables. The evaluator is a single-leader
 * loop that reuses the repo's SKIP LOCKED row-lease pattern: each rule row is
 * locked for the evaluate-and-trigger transaction, so at most one replica
 * fires a given trigger. A rule fires only when the window value violates the
 * threshold AND the per-minute values have violated for sustained_minutes
 * consecutive minutes, and stays silent for cooldown_minutes afterwards.
 */

export const ALERT_METRIC_NAMES = Object.freeze([
  'channel_error_rate',
  'channel_request_count',
  'wallet_active_holds',
] as const);

export type AlertMetricName = (typeof ALERT_METRIC_NAMES)[number];
export type AlertOperator = 'gt' | 'lt';

const WINDOW_METRICS: ReadonlySet<AlertMetricName> = new Set(['channel_error_rate', 'channel_request_count']);

export interface ParsedAlertMetric {
  readonly name: AlertMetricName;
  readonly provider?: string;
}

/** Metrics are `name` or `name:provider=<provider_id>` for channel scoping. */
export function parseAlertMetric(metric: string): ParsedAlertMetric | null {
  const separator = metric.indexOf(':provider=');
  const name = separator === -1 ? metric : metric.slice(0, separator);
  if (!(ALERT_METRIC_NAMES as readonly string[]).includes(name)) return null;
  if (separator === -1) return { name: name as AlertMetricName };
  const provider = metric.slice(separator + ':provider='.length).trim();
  if (provider.length === 0 || provider.length > 200) return null;
  return { name: name as AlertMetricName, provider };
}

export function isWindowMetric(name: AlertMetricName): boolean {
  return WINDOW_METRICS.has(name);
}

export interface AlertRuleRecord {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly metric: string;
  readonly operator: AlertOperator;
  readonly threshold: number;
  readonly windowMinutes: number;
  readonly sustainedMinutes: number;
  readonly cooldownMinutes: number;
  readonly notifyEmail: string | null;
  readonly webhookUrl: string | null;
  readonly lastTriggeredAt: string | null;
  readonly createdAt: string;
}

export interface AlertRuleInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly metric: string;
  readonly operator: AlertOperator;
  readonly threshold: number;
  readonly windowMinutes: number;
  readonly sustainedMinutes: number;
  readonly cooldownMinutes: number;
  readonly notifyEmail?: string | null;
  readonly webhookUrl?: string | null;
}

export interface AlertRulePatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly metric?: string;
  readonly operator?: AlertOperator;
  readonly threshold?: number;
  readonly windowMinutes?: number;
  readonly sustainedMinutes?: number;
  readonly cooldownMinutes?: number;
  readonly notifyEmail?: string | null;
  readonly webhookUrl?: string | null;
}

export interface AlertEventRecord {
  readonly id: string;
  readonly ruleId: string;
  readonly triggeredAt: string;
  readonly resolvedAt: string | null;
  readonly payload: unknown;
}

export class ObservabilityAlertValidationError extends Error {
  constructor(
    readonly code:
      | 'ALERT_INVALID_NAME'
      | 'ALERT_INVALID_METRIC'
      | 'ALERT_INVALID_OPERATOR'
      | 'ALERT_INVALID_THRESHOLD'
      | 'ALERT_INVALID_WINDOW'
      | 'ALERT_INVALID_SUSTAINED'
      | 'ALERT_INVALID_COOLDOWN'
      | 'ALERT_INVALID_NOTIFY_EMAIL'
      | 'ALERT_INVALID_WEBHOOK_URL',
    message: string,
  ) {
    super(message);
    this.name = 'ObservabilityAlertValidationError';
  }
}

function validateRuleShape(input: {
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  sustainedMinutes: number;
  cooldownMinutes: number;
  notifyEmail?: string | null;
  webhookUrl?: string | null;
}): void {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_NAME', 'rule name must be 1-200 characters');
  }
  if (parseAlertMetric(input.metric) === null) {
    throw new ObservabilityAlertValidationError(
      'ALERT_INVALID_METRIC',
      `metric must be one of ${ALERT_METRIC_NAMES.join(', ')} with optional :provider=<id> scope`,
    );
  }
  if (input.operator !== 'gt' && input.operator !== 'lt') {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_OPERATOR', "operator must be 'gt' or 'lt'");
  }
  if (!Number.isFinite(input.threshold)) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_THRESHOLD', 'threshold must be a finite number');
  }
  if (!Number.isInteger(input.windowMinutes) || input.windowMinutes < 1 || input.windowMinutes > 10_080) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_WINDOW', 'window_minutes must be 1-10080');
  }
  if (!Number.isInteger(input.sustainedMinutes) || input.sustainedMinutes < 1) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_SUSTAINED', 'sustained_minutes must be >= 1');
  }
  if (input.sustainedMinutes > input.windowMinutes) {
    throw new ObservabilityAlertValidationError(
      'ALERT_INVALID_SUSTAINED',
      'sustained_minutes must not exceed window_minutes',
    );
  }
  if (!Number.isInteger(input.cooldownMinutes) || input.cooldownMinutes < 1) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_COOLDOWN', 'cooldown_minutes must be >= 1');
  }
  if (
    input.notifyEmail !== undefined &&
    input.notifyEmail !== null &&
    (input.notifyEmail.trim().length === 0 || input.notifyEmail.length > 320 || !input.notifyEmail.includes('@'))
  ) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_NOTIFY_EMAIL', 'notify_email must be a valid email');
  }
  if (input.webhookUrl !== undefined && input.webhookUrl !== null && !/^https:\/\/[^\s]+$/.test(input.webhookUrl)) {
    throw new ObservabilityAlertValidationError('ALERT_INVALID_WEBHOOK_URL', 'webhook_url must be an https URL');
  }
}

interface AlertRuleRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly metric: string;
  readonly operator: string;
  readonly threshold: number;
  readonly window_minutes: number;
  readonly sustained_minutes: number;
  readonly cooldown_minutes: number;
  readonly notify_email: string | null;
  readonly webhook_url: string | null;
  readonly last_triggered_at: Date | string | null;
  readonly created_at: Date | string;
}

function toRuleRecord(row: AlertRuleRow): AlertRuleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    metric: row.metric,
    operator: row.operator === 'lt' ? 'lt' : 'gt',
    threshold: Number(row.threshold),
    windowMinutes: row.window_minutes,
    sustainedMinutes: row.sustained_minutes,
    cooldownMinutes: row.cooldown_minutes,
    notifyEmail: row.notify_email,
    webhookUrl: row.webhook_url,
    lastTriggeredAt:
      row.last_triggered_at instanceof Date
        ? row.last_triggered_at.toISOString()
        : row.last_triggered_at === null
          ? null
          : new Date(row.last_triggered_at).toISOString(),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

/** Rule CRUD over the migration-103 tables. */
export class ObservabilityAlertService {
  constructor(private readonly database: SqlExecutor) {}

  async listRules(): Promise<AlertRuleRecord[]> {
    const result = await this.database.query<AlertRuleRow>(
      'SELECT * FROM saas_obs_alert_rules ORDER BY created_at, id',
    );
    return result.rows.map(toRuleRecord);
  }

  async createRule(input: AlertRuleInput): Promise<AlertRuleRecord> {
    validateRuleShape(input);
    const id = randomUUID();
    const result = await this.database.query<AlertRuleRow>(
      `INSERT INTO saas_obs_alert_rules
         (id, name, enabled, metric, operator, threshold, window_minutes, sustained_minutes,
          cooldown_minutes, notify_email, webhook_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        input.name.trim(),
        input.enabled ?? true,
        input.metric,
        input.operator,
        input.threshold,
        input.windowMinutes,
        input.sustainedMinutes,
        input.cooldownMinutes,
        input.notifyEmail ?? null,
        input.webhookUrl ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('alert rule insert returned no row');
    return toRuleRecord(row);
  }

  async updateRule(id: string, patch: AlertRulePatch): Promise<AlertRuleRecord | null> {
    const existing = await this.database.query<AlertRuleRow>('SELECT * FROM saas_obs_alert_rules WHERE id = $1', [id]);
    const current = existing.rows[0];
    if (!current) return null;
    const merged = {
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled,
      metric: patch.metric ?? current.metric,
      operator: patch.operator ?? current.operator,
      threshold: patch.threshold ?? Number(current.threshold),
      windowMinutes: patch.windowMinutes ?? current.window_minutes,
      sustainedMinutes: patch.sustainedMinutes ?? current.sustained_minutes,
      cooldownMinutes: patch.cooldownMinutes ?? current.cooldown_minutes,
      notifyEmail: patch.notifyEmail === undefined ? current.notify_email : patch.notifyEmail,
      webhookUrl: patch.webhookUrl === undefined ? current.webhook_url : patch.webhookUrl,
    };
    validateRuleShape(merged);
    const result = await this.database.query<AlertRuleRow>(
      `UPDATE saas_obs_alert_rules
       SET name = $2, enabled = $3, metric = $4, operator = $5, threshold = $6, window_minutes = $7,
           sustained_minutes = $8, cooldown_minutes = $9, notify_email = $10, webhook_url = $11
       WHERE id = $1
       RETURNING *`,
      [
        id,
        merged.name.trim(),
        merged.enabled,
        merged.metric,
        merged.operator,
        merged.threshold,
        merged.windowMinutes,
        merged.sustainedMinutes,
        merged.cooldownMinutes,
        merged.notifyEmail,
        merged.webhookUrl,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return toRuleRecord(row);
  }

  async deleteRule(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM saas_obs_alert_rules WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listEvents(limit = 50): Promise<AlertEventRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const result = await this.database.query<{
      readonly id: string;
      readonly rule_id: string;
      readonly triggered_at: Date | string;
      readonly resolved_at: Date | string | null;
      readonly payload: unknown;
    }>(
      `SELECT id, rule_id, triggered_at, resolved_at, payload
       FROM saas_obs_alert_events
       ORDER BY triggered_at DESC, id
       LIMIT $1`,
      [bounded],
    );
    return result.rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      triggeredAt:
        row.triggered_at instanceof Date ? row.triggered_at.toISOString() : new Date(row.triggered_at).toISOString(),
      resolvedAt:
        row.resolved_at === null
          ? null
          : row.resolved_at instanceof Date
            ? row.resolved_at.toISOString()
            : new Date(row.resolved_at).toISOString(),
      payload: row.payload,
    }));
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export interface AlertMinuteSample {
  readonly minuteStartMs: number;
  readonly value: number;
}

export interface AlertRuleEvaluationShape {
  readonly operator: AlertOperator;
  readonly threshold: number;
  readonly sustainedMinutes: number;
  readonly cooldownMinutes: number;
  readonly lastTriggeredAtMs: number | null;
}

export interface AlertEvaluationResult {
  readonly windowValue: number;
  readonly violates: boolean;
  readonly sustained: boolean;
  readonly cooledDown: boolean;
  readonly shouldTrigger: boolean;
}

function violates(value: number, operator: AlertOperator, threshold: number): boolean {
  return operator === 'gt' ? value > threshold : value < threshold;
}

function trailingConsecutiveViolations(
  samples: readonly AlertMinuteSample[],
  operator: AlertOperator,
  threshold: number,
): number {
  let consecutive = 0;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (!sample || !violates(sample.value, operator, threshold)) break;
    const previous = samples[index - 1];
    if (previous && sample.minuteStartMs - previous.minuteStartMs !== 60_000) break;
    consecutive += 1;
  }
  return consecutive;
}

/**
 * Pure evaluator: window aggregation, sustained-consecutive-violation and
 * cooldown gating. Window metrics need per-minute samples; point-in-time
 * metrics (wallet holds) pass a single sample and ignore sustained_minutes.
 */
export function evaluateAlertRule(input: {
  rule: AlertRuleEvaluationShape;
  samples: readonly AlertMinuteSample[];
  nowMs: number;
  pointInTime?: boolean;
}): AlertEvaluationResult {
  const { rule } = input;
  const samples = input.samples;
  const windowValue =
    samples.length === 0
      ? 0
      : samples.reduce((sum, sample) => sum + sample.value, 0) / (input.pointInTime ? 1 : samples.length);
  const violatesWindow = samples.length > 0 && violates(windowValue, rule.operator, rule.threshold);
  const sustained = input.pointInTime
    ? violatesWindow
    : violatesWindow && trailingConsecutiveViolations(samples, rule.operator, rule.threshold) >= rule.sustainedMinutes;
  const cooledDown =
    rule.lastTriggeredAtMs === null || input.nowMs - rule.lastTriggeredAtMs >= rule.cooldownMinutes * 60_000;
  return {
    windowValue,
    violates: violatesWindow,
    sustained,
    cooledDown,
    shouldTrigger: violatesWindow && sustained && cooledDown,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface AlertEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Email transport abstraction; SMTP can be wired behind it later. */
export interface AlertEmailSender {
  send(input: AlertEmailInput): Promise<void>;
}

/** Default implementation: structured console logging. */
export class ConsoleLogAlertEmailSender implements AlertEmailSender {
  async send(input: AlertEmailInput): Promise<void> {
    console.log(`model-router obs alert email → ${input.to} :: ${input.subject}\n${input.body}`);
  }
}

export interface AlertWebhookDeliveryOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Optional HMAC signing key; deliveries are unsigned when omitted. */
  readonly signingKey?: Uint8Array;
  readonly signingKeyVersion?: number;
}

export interface AlertNotificationPayload {
  readonly type: 'obs.alert.triggered';
  readonly ruleId: string;
  readonly ruleName: string;
  readonly metric: string;
  readonly operator: AlertOperator;
  readonly threshold: number;
  readonly windowMinutes: number;
  readonly sustainedMinutes: number;
  readonly value: number;
  readonly triggeredAt: string;
}

/**
 * Posts the alert payload to the rule's webhook with the same HMAC-SHA256
 * v1 header contract as customer webhook deliveries when a key is configured.
 */
export async function deliverAlertWebhook(
  url: string,
  payload: AlertNotificationPayload,
  options: AlertWebhookDeliveryOptions = {},
): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'model-router-observability/1',
  };
  const eventId = randomUUID();
  if (options.signingKey !== undefined) {
    const timestampSeconds = Math.floor(Date.now() / 1000);
    headers['x-model-router-signature'] = computeCustomerWebhookSignature(
      { version: options.signingKeyVersion ?? 1, secret: options.signingKey },
      timestampSeconds,
      eventId,
      body,
    );
    headers['x-model-router-event-id'] = eventId;
    headers['x-model-router-timestamp'] = String(timestampSeconds);
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const response = await fetchFn(url, { method: 'POST', headers, body: new Uint8Array(body) });
  if (!response.ok) {
    throw new Error(`alert webhook delivery failed with status ${response.status}`);
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface AlertEvaluatorWorkerOptions {
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly onTriggered?: (rule: AlertRuleRecord, evaluation: AlertEvaluationResult) => void;
  readonly emailSender?: AlertEmailSender;
  readonly webhookDelivery?: AlertWebhookDeliveryOptions;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export interface AlertEvaluatorWorkerHandle {
  close(): Promise<void>;
}

interface ChannelMinuteRow {
  readonly bucket_at: Date | string;
  readonly requests: number;
  readonly errors: number;
}

interface AlertSilenceScopeRow {
  readonly rule_id: string | null;
  readonly platform: string | null;
  readonly group_id: string | null;
  readonly region: string | null;
  readonly until: Date | string;
}

function silenceScopeToRecord(
  row: AlertSilenceScopeRow,
): Pick<AlertSilenceRecord, 'ruleId' | 'platform' | 'groupId' | 'region' | 'until'> {
  return {
    ruleId: row.rule_id,
    platform: row.platform,
    groupId: row.group_id,
    region: row.region,
    until: row.until instanceof Date ? row.until.toISOString() : new Date(row.until).toISOString(),
  };
}

async function loadChannelSamples(
  database: SaasDatabase,
  metric: ParsedAlertMetric,
  windowMinutes: number,
): Promise<AlertMinuteSample[]> {
  const result = await database.query<ChannelMinuteRow>(
    `SELECT bucket_at, SUM(requests)::int AS requests, SUM(errors)::int AS errors
     FROM saas_obs_channel_metrics_1m
     WHERE bucket_at > now() - ($1::int * interval '1 minute')
       AND ($2::text IS NULL OR provider_id = $2)
     GROUP BY bucket_at
     ORDER BY bucket_at ASC`,
    [windowMinutes, metric.provider ?? null],
  );
  return result.rows.map((row) => {
    const minuteStart = row.bucket_at instanceof Date ? row.bucket_at.getTime() : new Date(row.bucket_at).getTime();
    const requests = Number(row.requests);
    const errors = Number(row.errors);
    const value = metric.name === 'channel_error_rate' ? errors / Math.max(requests, 1) : requests;
    return { minuteStartMs: minuteStart, value };
  });
}

async function loadWalletHoldCount(database: SaasDatabase): Promise<number> {
  const result = await database.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM saas_billing_reservations
     WHERE state IN ('reserved', 'reconciliation_pending')`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Runs one evaluator pass over every enabled rule; exposed for tests. */
export async function runAlertEvaluatorCycle(
  database: SaasDatabase,
  options: AlertEvaluatorWorkerOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const emailSender = options.emailSender ?? new ConsoleLogAlertEmailSender();
  const rules = await database.query<AlertRuleRow>(
    'SELECT * FROM saas_obs_alert_rules WHERE enabled ORDER BY created_at, id',
  );
  // Batch 5 §5.6: operator silences (migration 127). A silenced rule is
  // skipped entirely this cycle — it neither triggers nor auto-resolves.
  const silences = await database
    .query<AlertSilenceScopeRow>(
      'SELECT rule_id, platform, group_id, region, until FROM saas_obs_alert_silences WHERE until > now()',
    )
    .then((result) => result.rows.map(silenceScopeToRecord))
    .catch(() => []);
  let triggered = 0;
  for (const row of rules.rows) {
    const rule = toRuleRecord(row);
    const parsed = parseAlertMetric(rule.metric);
    if (!parsed) continue;
    if (isRuleSilenced(rule.id, parsed.provider, silences, now().getTime())) continue;
    // The rule-row lease: another replica evaluating this rule skips it.
    const triggeredEntry = await database.transaction(async (tx) => {
      const locked = await tx.query<AlertRuleRow>(
        'SELECT * FROM saas_obs_alert_rules WHERE id = $1 AND enabled FOR UPDATE SKIP LOCKED',
        [rule.id],
      );
      if (locked.rows.length === 0) return null;
      const samples: AlertMinuteSample[] =
        parsed.name === 'wallet_active_holds'
          ? [{ minuteStartMs: now().getTime(), value: await loadWalletHoldCount(database) }]
          : await loadChannelSamples(database, parsed, rule.windowMinutes);
      const evaluation = evaluateAlertRule({
        rule: {
          operator: rule.operator,
          threshold: rule.threshold,
          sustainedMinutes: rule.sustainedMinutes,
          cooldownMinutes: rule.cooldownMinutes,
          lastTriggeredAtMs: rule.lastTriggeredAt === null ? null : new Date(rule.lastTriggeredAt).getTime(),
        },
        samples,
        nowMs: now().getTime(),
        pointInTime: parsed.name === 'wallet_active_holds',
      });
      // Batch 5 §5.6 auto-resolve: a cycle that does not violate the window
      // closes the rule's open (firing) events. Resolution rides the same
      // rule-row lease as triggering, so at most one replica writes it.
      let resolvedCount = 0;
      if (!evaluation.violates) {
        const resolved = await tx.query(
          'UPDATE saas_obs_alert_events SET resolved_at = $2 WHERE rule_id = $1 AND resolved_at IS NULL',
          [rule.id, now().toISOString()],
        );
        resolvedCount = resolved.rowCount ?? 0;
      }
      if (!evaluation.shouldTrigger) {
        return resolvedCount > 0 ? { rule, evaluation, payload: null, resolvedCount } : null;
      }
      const eventId = randomUUID();
      const triggeredAt = now().toISOString();
      const payload: AlertNotificationPayload = {
        type: 'obs.alert.triggered',
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        windowMinutes: rule.windowMinutes,
        sustainedMinutes: rule.sustainedMinutes,
        value: evaluation.windowValue,
        triggeredAt,
      };
      await tx.query(
        `INSERT INTO saas_obs_alert_events (id, rule_id, triggered_at, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [eventId, rule.id, triggeredAt, JSON.stringify(payload)],
      );
      await tx.query('UPDATE saas_obs_alert_rules SET last_triggered_at = $2 WHERE id = $1', [rule.id, triggeredAt]);
      return { rule, evaluation, payload, resolvedCount };
    });
    if (!triggeredEntry) continue;
    if (triggeredEntry.payload !== null) triggered += 1;
    options.onTriggered?.(triggeredEntry.rule, triggeredEntry.evaluation);
    if (triggeredEntry.payload === null) continue;
    // Notifications are outside the trigger transaction: a failed notify must
    // never roll back the durable event or reset the cooldown.
    if (triggeredEntry.rule.notifyEmail) {
      try {
        await emailSender.send({
          to: triggeredEntry.rule.notifyEmail,
          subject: `[model-router] alert triggered: ${triggeredEntry.rule.name}`,
          body: JSON.stringify(triggeredEntry.payload, null, 2),
        });
      } catch (error) {
        options.onError?.(error);
      }
    }
    if (triggeredEntry.rule.webhookUrl) {
      try {
        await deliverAlertWebhook(triggeredEntry.rule.webhookUrl, triggeredEntry.payload, {
          fetch: options.fetch,
          ...options.webhookDelivery,
        });
      } catch (error) {
        options.onError?.(error);
      }
    }
  }
  return triggered;
}

/** Starts the single-leader alert evaluator loop. */
export function startAlertEvaluatorWorker(
  database: SaasDatabase,
  options: AlertEvaluatorWorkerOptions = {},
): AlertEvaluatorWorkerHandle {
  const intervalMs = Math.min(Math.max(options.intervalMs ?? 60_000, 1_000), 600_000);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = async (): Promise<void> => {
    // First evaluation waits one interval; rules are durable and cooldown
    // gated, so a startup delay never changes alert semantics.
    await delayWithClose(intervalMs);
    while (!closed) {
      try {
        await runAlertEvaluatorCycle(database, options);
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          // An observer cannot terminate evaluation.
        }
      }
      if (closed) break;
      await delayWithClose(intervalMs);
    }
  };
  const done = loop();
  return {
    async close() {
      if (closed) return done;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await done;
    },
  };
}
