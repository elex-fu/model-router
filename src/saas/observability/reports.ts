import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SaasDatabase } from '../db/types.js';
import type { AlertEmailSender } from './alerts.js';
import { getChannelStatusPage } from './channel-status.js';

/**
 * Batch 5 §5.6 (task #23): scheduled operator email reports —
 * daily_summary, weekly_summary, error_digest and account_health — over the
 * observability data the control plane already aggregates (the channel
 * status rollup and the migration-103 alert events).
 *
 * Design decisions, each pinned by a test:
 * - Cron scheduling is a self-written 5-field parser (robfig/cron
 *   semantics: star, plain values, a-b ranges, a-b/n and star/n steps,
 *   comma lists, `?` as star, dow 0-7 with 7 = Sunday, and the dom/dow OR
 *   rule when both fields are restricted) evaluated in UTC. Zero
 *   dependencies — same posture as the SMTP client and the update tar
 *   reader.
 * - last_run persistence: the control-plane PostgreSQL database (the
 *   migration-127 saas_obs_report_state row per report type), NOT the
 *   control-plane Redis — Redis is an optional provider on this plane while
 *   the database is the one store every managed deployment guarantees. The
 *   same decision shapes the BYOK update cache (SQLite there, PG here);
 *   each plane persists into the store it can rely on.
 * - Single leader per report type: the state row is taken with FOR UPDATE
 *   SKIP LOCKED (the migration-103 rule-lease pattern), so at most one
 *   replica claims a run.
 * - last_run is advanced BEFORE content generation: a broken SMTP config
 *   can fail every send for a period exactly once — never a per-minute
 *   retry storm.
 * - error_digest skips sending (but still claims last_run) when the window
 *   produced fewer than min_count alert events.
 * - Recipients come from MODEL_ROUTER_SAAS_OBS_REPORT_RECIPIENTS
 *   (comma-separated); an empty list falls back to the first platform
 *   superadmin's email.
 * - Email transport is the AlertEmailSender-shaped seam
 *   (identity/email-sender's SmtpEmailSender plugs in structurally); a
 *   custom template directory (MODEL_ROUTER_SAAS_OBS_REPORT_TEMPLATE_DIR,
 *   files `<type>.html` with {{key}} placeholders) falls back to the
 *   built-in template whenever reading or rendering fails.
 */

// ---------------------------------------------------------------------------
// Cron parsing and next-run (robfig/cron 5-field semantics, UTC)
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export class CronParseError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CronParseError';
  }
}

export interface ParsedCronSchedule {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dom: readonly number[];
  readonly month: readonly number[];
  readonly dow: readonly number[];
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7],
} as const;

function fieldNameToNames(field: string): readonly string[] | undefined {
  if (field === 'month') return MONTH_NAMES;
  if (field === 'dow') return DOW_NAMES;
  return undefined;
}

function parseNumber(token: string, field: string, names: readonly string[] | undefined): number | null {
  const lowered = token.toLowerCase();
  const nameIndex = names?.indexOf(lowered as (typeof names)[number]) ?? -1;
  if (nameIndex !== -1) return nameIndex + (field === 'month' ? 1 : 0);
  if (!/^\d+$/.test(token)) return null;
  const value = Number.parseInt(token, 10);
  return Number.isSafeInteger(value) ? value : null;
}

function parseField(field: string, raw: string): number[] {
  const [minimum, maximum] = FIELD_RANGES[field as keyof typeof FIELD_RANGES];
  const names = fieldNameToNames(field);
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new CronParseError(field, `invalid step in "${raw}"`);
    }
    let low: number;
    let high: number;
    if (rangePart === '*' || rangePart === '?') {
      low = minimum;
      high = maximum;
    } else {
      const dash = rangePart.indexOf('-');
      if (dash === -1) {
        const value = parseNumber(rangePart, field, names);
        if (value === null) throw new CronParseError(field, `invalid value "${rangePart}"`);
        if (stepPart !== undefined && step > 1) {
          // robfig: "5/15" means "5,20,35,50" — a step anchored at 5.
          low = value;
          high = maximum;
        } else {
          low = value;
          high = value;
        }
      } else {
        const lowValue = parseNumber(rangePart.slice(0, dash), field, names);
        const highValue = parseNumber(rangePart.slice(dash + 1), field, names);
        if (lowValue === null || highValue === null) throw new CronParseError(field, `invalid range "${rangePart}"`);
        low = lowValue;
        high = highValue;
      }
    }
    if (low > high) throw new CronParseError(field, `inverted range in "${raw}"`);
    for (let value = low; value <= high; value += step) {
      // dow 7 is Sunday == 0.
      const normalized = field === 'dow' && value === 7 ? 0 : value;
      if (normalized < minimum || normalized > maximum) {
        throw new CronParseError(field, `value ${value} out of range in "${raw}"`);
      }
      values.add(normalized);
    }
  }
  if (values.size === 0) throw new CronParseError(field, `empty field "${raw}"`);
  return [...values].sort((left, right) => left - right);
}

export function parseCronExpression(expression: string): ParsedCronSchedule {
  const fields = String(expression ?? '')
    .trim()
    .split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError('expression', 'exactly five fields are required (minute hour dom month dow)');
  }
  const [minute, hour, dom, month, dow] = fields;
  return {
    minute: parseField('minute', minute as string),
    hour: parseField('hour', hour as string),
    dom: parseField('dom', dom as string),
    month: parseField('month', month as string),
    dow: parseField('dow', dow as string),
    domRestricted: !(dom as string).includes('*') && !(dom as string).includes('?'),
    dowRestricted: !(dow as string).includes('*') && !(dow as string).includes('?'),
  };
}

function utcParts(ms: number): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    dow: date.getUTCDay(),
  };
}

function dayMatches(schedule: ParsedCronSchedule, year: number, month: number, day: number, dow: number): boolean {
  if (!schedule.month.includes(month)) return false;
  const domMatch = schedule.dom.includes(day);
  const dowMatch = schedule.dow.includes(dow);
  // robfig semantics: when BOTH dom and dow are restricted, either matching
  // is enough; when only one is restricted, that one must match.
  if (schedule.domRestricted && schedule.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** 4 years of day scanning bounds even a Feb-29-only schedule twice over. */
const CRON_SEARCH_DAY_LIMIT = 1500;

/**
 * The next run strictly after `fromMs`, in UTC, or -1 when no occurrence
 * exists within the four-year search horizon.
 */
export function cronNextRun(schedule: ParsedCronSchedule, fromMs: number): number {
  const parts = utcParts(fromMs);
  let cursorDay = Date.UTC(parts.year, parts.month - 1, parts.day);
  for (let offset = 0; offset < CRON_SEARCH_DAY_LIMIT; offset += 1) {
    const dayParts = utcParts(cursorDay);
    if (!schedule.month.includes(dayParts.month)) {
      // Skip to the first day of the next month.
      cursorDay = Date.UTC(dayParts.month === 12 ? dayParts.year + 1 : dayParts.year, dayParts.month % 12, 1);
      continue;
    }
    if (dayMatches(schedule, dayParts.year, dayParts.month, dayParts.day, dayParts.dow)) {
      for (const hour of schedule.hour) {
        for (const minute of schedule.minute) {
          const candidate = Date.UTC(dayParts.year, dayParts.month - 1, dayParts.day, hour, minute);
          if (candidate > fromMs) return candidate;
        }
      }
    }
    cursorDay += 86_400_000;
  }
  return -1;
}

/** True when the schedule fired at least once in (lastRunMs, nowMs]. */
export function isCronDue(schedule: ParsedCronSchedule, lastRunMs: number | null, nowMs: number): boolean {
  if (lastRunMs === null) return true;
  const next = cronNextRun(schedule, lastRunMs);
  return next !== -1 && next <= nowMs;
}

// ---------------------------------------------------------------------------
// Report types, schedules and configuration
// ---------------------------------------------------------------------------

export const OBS_REPORT_TYPES = ['daily_summary', 'weekly_summary', 'error_digest', 'account_health'] as const;
export type ObsReportType = (typeof OBS_REPORT_TYPES)[number];

export const DEFAULT_OBS_REPORT_CRONS: Readonly<Record<ObsReportType, string>> = Object.freeze({
  daily_summary: '0 8 * * *',
  weekly_summary: '0 8 * * 1',
  error_digest: '*/30 * * * *',
  account_health: '0 9 * * *',
});

export const OBS_REPORT_CRON_ENV_PREFIX = 'MODEL_ROUTER_SAAS_OBS_REPORT_CRON_' as const;
export const OBS_REPORT_RECIPIENTS_ENV = 'MODEL_ROUTER_SAAS_OBS_REPORT_RECIPIENTS' as const;
export const OBS_REPORT_TEMPLATE_DIR_ENV = 'MODEL_ROUTER_SAAS_OBS_REPORT_TEMPLATE_DIR' as const;
export const ERROR_DIGEST_MIN_COUNT_ENV = 'MODEL_ROUTER_SAAS_OBS_ERROR_DIGEST_MIN_COUNT' as const;
export const DEFAULT_ERROR_DIGEST_MIN_COUNT = 1;

export function resolveReportCrons(env: NodeJS.ProcessEnv = process.env): Record<ObsReportType, ParsedCronSchedule> {
  const result = {} as Record<ObsReportType, ParsedCronSchedule>;
  for (const type of OBS_REPORT_TYPES) {
    const raw = env[`${OBS_REPORT_CRON_ENV_PREFIX}${type.toUpperCase()}`]?.trim();
    result[type] = parseCronExpression(raw !== undefined && raw.length > 0 ? raw : DEFAULT_OBS_REPORT_CRONS[type]);
  }
  return result;
}

export function resolveErrorDigestMinCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ERROR_DIGEST_MIN_COUNT_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_ERROR_DIGEST_MIN_COUNT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ERROR_DIGEST_MIN_COUNT;
}

export function parseReportRecipients(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.includes('@'));
}

// ---------------------------------------------------------------------------
// Report content
// ---------------------------------------------------------------------------

export interface ReportEmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface ObsReportWindow {
  readonly now: Date;
  readonly windowStart: Date;
}

interface AlertEventCounts {
  readonly triggered: number;
  readonly resolved: number;
  readonly open: number;
}

async function loadAlertEventCounts(database: SaasDatabase, sinceMs: number, nowMs: number): Promise<AlertEventCounts> {
  const result = await database.query<{
    readonly triggered: string;
    readonly resolved: string;
    readonly open: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE triggered_at >= $1)::text AS triggered,
       COUNT(*) FILTER (WHERE resolved_at >= $1)::text AS resolved,
       COUNT(*) FILTER (WHERE resolved_at IS NULL)::text AS open
     FROM saas_obs_alert_events
     WHERE triggered_at <= $2`,
    [new Date(sinceMs), new Date(nowMs)],
  );
  const row = result.rows[0];
  return {
    triggered: Number(row?.triggered ?? 0),
    resolved: Number(row?.resolved ?? 0),
    open: Number(row?.open ?? 0),
  };
}

async function loadWalletHoldCount(database: SaasDatabase): Promise<number> {
  const result = await database.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM saas_billing_reservations
     WHERE state IN ('reserved', 'reconciliation_pending')`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function loadEnabledRuleCount(database: SaasDatabase): Promise<number> {
  const result = await database.query<{ readonly count: string }>(
    'SELECT COUNT(*)::text AS count FROM saas_obs_alert_rules WHERE enabled',
  );
  return Number(result.rows[0]?.count ?? 0);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export interface ReportTemplateData {
  readonly type: ObsReportType;
  readonly windowStartIso: string;
  readonly nowIso: string;
  readonly rangeDays: number;
  readonly triggeredAlerts: number;
  readonly resolvedAlerts: number;
  readonly openAlerts: number;
  readonly enabledRules: number;
  readonly walletHolds: number;
  readonly channels: readonly {
    readonly providerId: string;
    readonly model: string;
    readonly requests: number;
    readonly errors: number;
    readonly availabilityPct: string;
  }[];
}

function reportSubject(type: ObsReportType, window: ObsReportWindow): string {
  const date = window.now.toISOString().slice(0, 10);
  switch (type) {
    case 'daily_summary':
      return `[model-router] daily summary — ${date}`;
    case 'weekly_summary':
      return `[model-router] weekly summary — week of ${window.windowStart.toISOString().slice(0, 10)}`;
    case 'error_digest':
      return `[model-router] error digest — ${window.now.toISOString()}`;
    case 'account_health':
      return `[model-router] account health — ${date}`;
  }
}

function builtInReportHtml(data: ReportTemplateData): string {
  const channelRows = data.channels
    .map(
      (channel) =>
        `<tr><td>${escapeHtml(channel.providerId)}</td><td>${escapeHtml(channel.model)}</td>` +
        `<td>${channel.requests}</td><td>${channel.errors}</td><td>${channel.availabilityPct}%</td></tr>`,
    )
    .join('\n');
  return `<html><body>
<h1>model-router ${escapeHtml(data.type)}</h1>
<p>Window: ${escapeHtml(data.windowStartIso)} → ${escapeHtml(data.nowIso)} (${data.rangeDays} day(s)).</p>
<ul>
<li>Alert events triggered: ${data.triggeredAlerts}</li>
<li>Alert events resolved: ${data.resolvedAlerts}</li>
<li>Open (firing) alerts: ${data.openAlerts}</li>
<li>Enabled alert rules: ${data.enabledRules}</li>
<li>Active wallet holds: ${data.walletHolds}</li>
</ul>
<h2>Channels</h2>
<table>
<tr><th>Provider</th><th>Model</th><th>Requests</th><th>Errors</th><th>Availability</th></tr>
${channelRows}
</table>
</body></html>`;
}

function builtInReportText(data: ReportTemplateData): string {
  const lines = [
    `model-router ${data.type}`,
    `Window: ${data.windowStartIso} -> ${data.nowIso} (${data.rangeDays} day(s))`,
    `Alert events triggered: ${data.triggeredAlerts}`,
    `Alert events resolved: ${data.resolvedAlerts}`,
    `Open (firing) alerts: ${data.openAlerts}`,
    `Enabled alert rules: ${data.enabledRules}`,
    `Active wallet holds: ${data.walletHolds}`,
    'Channels:',
  ];
  for (const channel of data.channels) {
    lines.push(
      `  ${channel.providerId} / ${channel.model}: ${channel.requests} requests, ${channel.errors} errors, ${channel.availabilityPct}% availability`,
    );
  }
  return lines.join('\n');
}

/** Renders `{{key}}` placeholders; unknown keys are removed. */
export function renderReportTemplate(source: string, data: Record<string, string | number>): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = data[key];
    return value === undefined ? '' : String(value);
  });
}

async function loadCustomTemplate(dir: string | undefined, type: ObsReportType): Promise<string | null> {
  if (dir === undefined || dir.length === 0) return null;
  try {
    return await readFile(join(dir, `${type}.html`), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Builds one report from the observability queries that already exist (the
 * channel status rollup, alert event counts, wallet holds, enabled rules).
 * A readable custom template wins; any template failure falls back to the
 * built-in HTML.
 */
export async function buildObsReportEmail(
  database: SaasDatabase,
  type: ObsReportType,
  window: ObsReportWindow,
  options: { templateDir?: string } = {},
): Promise<ReportEmailContent> {
  const rangeDays = type === 'weekly_summary' ? 7 : 1;
  const sinceMs = Math.min(window.windowStart.getTime(), window.now.getTime() - 60_000);
  const [status, events, walletHolds, enabledRules] = await Promise.all([
    getChannelStatusPage(database, { days: rangeDays }),
    loadAlertEventCounts(database, sinceMs, window.now.getTime()),
    loadWalletHoldCount(database),
    loadEnabledRuleCount(database),
  ]);
  const data: ReportTemplateData = {
    type,
    windowStartIso: window.windowStart.toISOString(),
    nowIso: window.now.toISOString(),
    rangeDays,
    triggeredAlerts: events.triggered,
    resolvedAlerts: events.resolved,
    openAlerts: events.open,
    enabledRules,
    walletHolds,
    channels: status.channels.slice(0, 50).map((channel) => ({
      providerId: channel.providerId,
      model: channel.model,
      requests: channel.requests,
      errors: channel.errors,
      availabilityPct: (channel.availability * 100).toFixed(2),
    })),
  };
  const placeholders: Record<string, string | number> = {
    type: data.type,
    windowStartIso: data.windowStartIso,
    nowIso: data.nowIso,
    rangeDays: data.rangeDays,
    triggeredAlerts: data.triggeredAlerts,
    resolvedAlerts: data.resolvedAlerts,
    openAlerts: data.openAlerts,
    enabledRules: data.enabledRules,
    walletHolds: data.walletHolds,
  };
  const custom = await loadCustomTemplate(options.templateDir, type);
  let html: string;
  try {
    html = custom !== null ? renderReportTemplate(custom, placeholders) : builtInReportHtml(data);
  } catch {
    html = builtInReportHtml(data);
  }
  if (custom !== null && html.trim().length === 0) {
    html = builtInReportHtml(data);
  }
  return { subject: reportSubject(type, window), html, text: builtInReportText(data) };
}

// ---------------------------------------------------------------------------
// Scheduler cycle
// ---------------------------------------------------------------------------

export interface ReportSchedulerOptions {
  readonly emailSender: AlertEmailSender;
  readonly crons?: Partial<Record<ObsReportType, string>>;
  readonly recipients?: () => Promise<string[]>;
  readonly templateDir?: string;
  readonly errorDigestMinCount?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, type?: ObsReportType) => void;
  readonly onSent?: (type: ObsReportType, recipients: readonly string[]) => void;
  readonly buildReport?: (
    database: SaasDatabase,
    type: ObsReportType,
    window: ObsReportWindow,
    options: { templateDir?: string },
  ) => Promise<ReportEmailContent>;
}

interface ReportStateRow {
  readonly last_run_at: Date | string;
}

/** Loads the first platform superadmin's email (the recipient fallback). */
export async function loadFirstAdminRecipient(database: SaasDatabase): Promise<string | null> {
  const result = await database.query<{ readonly email: string }>(
    `SELECT u.email
     FROM saas_users u
     JOIN saas_platform_role_assignments r ON r.user_id = u.id
     WHERE r.role = 'superadmin' AND u.disabled_at IS NULL
     ORDER BY r.granted_at, u.created_at, u.id
     LIMIT 1`,
  );
  return result.rows[0]?.email ?? null;
}

interface ReportClaim {
  readonly type: ObsReportType;
  readonly claimed: boolean;
  readonly previousRunMs: number | null;
}

async function claimReportRun(
  database: SaasDatabase,
  type: ObsReportType,
  schedule: ParsedCronSchedule,
  nowMs: number,
): Promise<ReportClaim> {
  return database.transaction(async (tx) => {
    // Bootstrap the row; a brand-new deployment starts counting from now so
    // the first report fires on the next schedule occurrence.
    await tx.query(
      'INSERT INTO saas_obs_report_state (report_type, last_run_at) VALUES ($1, $2) ON CONFLICT (report_type) DO NOTHING',
      [type, new Date(nowMs)],
    );
    // The single-leader lease: another replica holding this row is skipped.
    const state = await tx.query<ReportStateRow>(
      'SELECT last_run_at FROM saas_obs_report_state WHERE report_type = $1 FOR UPDATE SKIP LOCKED',
      [type],
    );
    const row = state.rows[0];
    if (!row) return { type, claimed: false, previousRunMs: null };
    const previousRunMs =
      row.last_run_at instanceof Date ? row.last_run_at.getTime() : new Date(row.last_run_at).getTime();
    if (!isCronDue(schedule, previousRunMs, nowMs)) {
      return { type, claimed: false, previousRunMs };
    }
    // LAST_RUN FIRST: the claim is durable before any content is generated,
    // so a failing send can never retry every cycle.
    await tx.query('UPDATE saas_obs_report_state SET last_run_at = $2, updated_at = now() WHERE report_type = $1', [
      type,
      new Date(nowMs),
    ]);
    return { type, claimed: true, previousRunMs };
  });
}

/**
 * Runs one scheduler pass over all four report types; exposed for tests.
 * Returns the report types whose runs were claimed (sent or deliberately
 * skipped).
 */
export async function runReportSchedulerCycle(
  database: SaasDatabase,
  options: ReportSchedulerOptions,
): Promise<ObsReportType[]> {
  const now = options.now ?? (() => new Date());
  const schedules = resolveReportCrons();
  for (const [type, override] of Object.entries(options.crons ?? {})) {
    if (typeof override === 'string' && override.length > 0) {
      schedules[type as ObsReportType] = parseCronExpression(override);
    }
  }
  const minCount = options.errorDigestMinCount ?? resolveErrorDigestMinCount();
  const claimed: ObsReportType[] = [];
  for (const type of OBS_REPORT_TYPES) {
    const nowMs = now().getTime();
    let claim: ReportClaim;
    try {
      claim = await claimReportRun(database, type, schedules[type], nowMs);
    } catch (error) {
      options.onError?.(error, type);
      continue;
    }
    if (!claim.claimed) continue;
    claimed.push(type);
    try {
      const window: ObsReportWindow = {
        now: new Date(nowMs),
        windowStart: new Date(claim.previousRunMs ?? nowMs - 24 * 3600 * 1000),
      };
      // error_digest gate: below min_count triggered events the run is
      // claimed (last_run advanced) but nothing is sent or generated.
      if (type === 'error_digest') {
        const triggered = await loadAlertEventCounts(database, window.windowStart.getTime(), nowMs);
        if (triggered.triggered < minCount) continue;
      }
      const content = await (options.buildReport ?? buildObsReportEmail)(database, type, window, {
        templateDir: options.templateDir,
      });
      const recipients =
        options.recipients !== undefined
          ? await options.recipients()
          : parseReportRecipients(process.env[OBS_REPORT_RECIPIENTS_ENV]);
      const resolvedRecipients = recipients.length > 0 ? recipients : await fallbackRecipients(database);
      if (resolvedRecipients.length === 0) {
        options.onError?.(new Error('no report recipients configured'), type);
        continue;
      }
      for (const recipient of resolvedRecipients) {
        await options.emailSender.send({ to: recipient, subject: content.subject, body: content.html });
      }
      options.onSent?.(type, resolvedRecipients);
    } catch (error) {
      // The run is already claimed; a failed generation or send waits for
      // the next scheduled occurrence by design.
      options.onError?.(error, type);
    }
  }
  return claimed;
}

async function fallbackRecipients(database: SaasDatabase): Promise<string[]> {
  const admin = await loadFirstAdminRecipient(database);
  return admin === null ? [] : [admin];
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface ReportSchedulerWorkerOptions extends ReportSchedulerOptions {
  readonly intervalMs?: number;
}

export interface ReportSchedulerWorkerHandle {
  close(): Promise<void>;
}

/** Starts the single-leader report scheduler loop (minute granularity). */
export function startReportSchedulerWorker(
  database: SaasDatabase,
  options: ReportSchedulerWorkerOptions,
): ReportSchedulerWorkerHandle {
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
    await delayWithClose(intervalMs);
    while (!closed) {
      try {
        await runReportSchedulerCycle(database, options);
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          // An observer cannot terminate scheduling.
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
