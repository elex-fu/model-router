import { randomUUID } from 'node:crypto';

import type { SqlExecutor } from '../db/types.js';

/**
 * Batch 5 §5.6 (task #23; sub2api alert_silence.go reference): operator
 * silence rows over the migration-103 alert rules. The evaluator
 * (runAlertEvaluatorCycle) loads the active silences once per cycle and
 * skips a silenced rule entirely — silenced rules neither trigger nor
 * auto-resolve.
 *
 * Matching semantics (kept deliberately narrow and documented):
 * - rule_id IS NULL matches every rule; otherwise the silence matches only
 *   that rule.
 * - platform matches when the rule's metric carries a `:provider=<id>`
 *   scope and the scope equals the silence platform (a silence scoped to a
 *   platform only quiets that platform's channel rules).
 * - group_id / region are stored scope dimensions no current alert metric
 *   carries; they always match today and are reserved for the billing-group
 *   and region alert metrics the roadmap adds later.
 * - A silence is active while now < until; expired rows are ignored by the
 *   evaluator and pruned opportunistically on list.
 */
export interface AlertSilenceRecord {
  readonly id: string;
  readonly ruleId: string | null;
  readonly platform: string | null;
  readonly groupId: string | null;
  readonly region: string | null;
  readonly until: string;
  readonly reason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface AlertSilenceInput {
  readonly ruleId?: string | null;
  readonly platform?: string | null;
  readonly groupId?: string | null;
  readonly region?: string | null;
  readonly until: string;
  readonly reason?: string | null;
  readonly createdBy: string;
}

export class ObservabilitySilenceValidationError extends Error {
  constructor(
    readonly code:
      | 'SILENCE_EMPTY_SCOPE'
      | 'SILENCE_INVALID_RULE'
      | 'SILENCE_INVALID_PLATFORM'
      | 'SILENCE_INVALID_GROUP'
      | 'SILENCE_INVALID_REGION'
      | 'SILENCE_INVALID_UNTIL'
      | 'SILENCE_UNTIL_IN_PAST'
      | 'SILENCE_INVALID_REASON'
      | 'SILENCE_INVALID_CREATED_BY',
    message: string,
  ) {
    super(message);
    this.name = 'ObservabilitySilenceValidationError';
  }
}

interface AlertSilenceRow {
  readonly id: string;
  readonly rule_id: string | null;
  readonly platform: string | null;
  readonly group_id: string | null;
  readonly region: string | null;
  readonly until: Date | string;
  readonly reason: string | null;
  readonly created_by: string;
  readonly created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: AlertSilenceRow): AlertSilenceRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    platform: row.platform,
    groupId: row.group_id,
    region: row.region,
    until: toIso(row.until),
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

function validateSilenceShape(input: AlertSilenceInput): void {
  const scope = [input.ruleId, input.platform, input.groupId, input.region].some(
    (value) => value !== null && value !== undefined,
  );
  if (!scope) {
    throw new ObservabilitySilenceValidationError(
      'SILENCE_EMPTY_SCOPE',
      'at least one of rule_id, platform, group_id or region is required',
    );
  }
  if (
    input.ruleId !== undefined &&
    input.ruleId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.ruleId)
  ) {
    throw new ObservabilitySilenceValidationError('SILENCE_INVALID_RULE', 'rule_id must be a rule UUID');
  }
  for (const [key, value, code] of [
    ['platform', input.platform, 'SILENCE_INVALID_PLATFORM'],
    ['groupId', input.groupId, 'SILENCE_INVALID_GROUP'],
    ['region', input.region, 'SILENCE_INVALID_REGION'],
  ] as const) {
    if (value !== undefined && value !== null && (value.trim().length === 0 || value.length > 100)) {
      throw new ObservabilitySilenceValidationError(code, `${key} must be 1-100 characters when set`);
    }
  }
  const until = Date.parse(input.until);
  if (input.until === undefined || Number.isNaN(until)) {
    throw new ObservabilitySilenceValidationError('SILENCE_INVALID_UNTIL', 'until must be an ISO-8601 timestamp');
  }
  if (until <= Date.now()) {
    throw new ObservabilitySilenceValidationError('SILENCE_UNTIL_IN_PAST', 'until must be in the future');
  }
  if (input.reason !== undefined && input.reason !== null && input.reason.trim().length === 0) {
    throw new ObservabilitySilenceValidationError('SILENCE_INVALID_REASON', 'reason must be non-empty when set');
  }
  if (input.createdBy === undefined || input.createdBy.trim().length === 0 || input.createdBy.length > 200) {
    throw new ObservabilitySilenceValidationError('SILENCE_INVALID_CREATED_BY', 'created_by must be 1-200 characters');
  }
}

/** CRUD over the migration-127 silence table. */
export class ObservabilityAlertSilenceService {
  constructor(private readonly database: SqlExecutor) {}

  async listSilences(options: { includeExpired?: boolean } = {}): Promise<AlertSilenceRecord[]> {
    const result = await this.database.query<AlertSilenceRow>(
      options.includeExpired
        ? 'SELECT * FROM saas_obs_alert_silences ORDER BY created_at DESC, id'
        : 'SELECT * FROM saas_obs_alert_silences WHERE until > now() ORDER BY created_at DESC, id',
    );
    return result.rows.map(toRecord);
  }

  async createSilence(input: AlertSilenceInput): Promise<AlertSilenceRecord> {
    validateSilenceShape(input);
    if (input.ruleId !== undefined && input.ruleId !== null) {
      const rule = await this.database.query('SELECT 1 FROM saas_obs_alert_rules WHERE id = $1', [input.ruleId]);
      if ((rule.rowCount ?? 0) === 0) {
        throw new ObservabilitySilenceValidationError(
          'SILENCE_INVALID_RULE',
          'rule_id does not reference an alert rule',
        );
      }
    }
    const result = await this.database.query<AlertSilenceRow>(
      `INSERT INTO saas_obs_alert_silences
         (id, rule_id, platform, group_id, region, until, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        randomUUID(),
        input.ruleId ?? null,
        input.platform ?? null,
        input.groupId ?? null,
        input.region ?? null,
        input.until,
        input.reason ?? null,
        input.createdBy,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('alert silence insert returned no row');
    return toRecord(row);
  }

  async deleteSilence(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM saas_obs_alert_silences WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Prunes expired rows; returns the number removed. */
  async pruneExpired(): Promise<number> {
    const result = await this.database.query('DELETE FROM saas_obs_alert_silences WHERE until <= now()');
    return result.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Pure matching
// ---------------------------------------------------------------------------

/**
 * True when any active silence (until > nowMs) matches the rule under the
 * semantics documented on the module. `ruleProvider` is the rule's
 * `:provider=` metric scope when present (the caller has already parsed the
 * metric — this module deliberately does not import the evaluator's module
 * to keep the import graph acyclic).
 */
export function isRuleSilenced(
  ruleId: string,
  ruleProvider: string | undefined,
  silences: readonly Pick<AlertSilenceRecord, 'ruleId' | 'platform' | 'groupId' | 'region' | 'until'>[],
  nowMs: number,
): boolean {
  return silences.some((silence) => {
    const untilMs = Date.parse(silence.until);
    if (Number.isNaN(untilMs) || untilMs <= nowMs) return false;
    if (silence.ruleId !== null && silence.ruleId !== ruleId) return false;
    // A platform-scoped silence only quiets that platform's channel rules.
    if (silence.platform !== null && ruleProvider !== silence.platform) return false;
    // group_id / region: reserved scope dimensions, always matching today.
    return true;
  });
}
