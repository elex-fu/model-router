/**
 * PostgreSQL implementation of the content moderation store (gateway role)
 * and the risk-control admin store (control-plane role).
 *
 * The gateway lane only ever touches: the single-row config read, log INSERTs,
 * the flagged-hash blocklist, violation counting, and the auto-ban UPDATE on
 * saas_users.disabled_at (the same column the governance service uses). The
 * control-plane lane additionally owns config upserts, log listing, retention
 * cleanup and hash deletion — see the grants in runtime-privileges.ts.
 */

import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import {
  type ContentModerationLogRow,
  type ContentModerationStore,
  type ModerationAuditEvent,
  type ModerationDisableUserResult,
  type ModerationUserContact,
  normalizeRiskControlConfig,
  parseRiskControlConfigInput,
  type RiskControlConfig,
  serializeRiskControlConfig,
} from './moderation.js';

export interface ContentModerationLogRecord extends ContentModerationLogRow {
  readonly id: string;
  readonly createdAt: string;
}

export interface ContentModerationLogFilter {
  readonly action?: string;
  readonly tenantId?: string;
  readonly model?: string;
  readonly flaggedOnly?: boolean;
  readonly fromIso?: string;
  readonly toIso?: string;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ContentModerationLogPage {
  readonly items: ContentModerationLogRecord[];
  readonly total: number;
}

export interface RiskControlCleanupResult {
  readonly deletedHit: number;
  readonly deletedNonHit: number;
  readonly deletedHashes: number;
}

const LOG_COLUMNS = `id, request_id, tenant_id, user_id, api_key_id, api_key_name, model, protocol, mode,
  action, flagged, highest_category, highest_score, matched_keyword, category_scores, threshold_snapshot,
  input_excerpt, input_hash, upstream_latency_ms, error, violation_count, auto_banned, email_sent,
  created_at`;

interface LogRow extends Record<string, unknown> {
  id: string | number;
  request_id: string;
  tenant_id: string;
  user_id: string | null;
  api_key_id: string;
  api_key_name: string;
  model: string;
  protocol: string;
  mode: string;
  action: string;
  flagged: boolean;
  highest_category: string;
  highest_score: number | string;
  matched_keyword: string;
  category_scores: unknown;
  threshold_snapshot: unknown;
  input_excerpt: string;
  input_hash: string | null;
  upstream_latency_ms: number | null;
  error: string;
  violation_count: number;
  auto_banned: boolean;
  email_sent: boolean;
  created_at: Date | string;
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function mapLogRow(row: LogRow): ContentModerationLogRecord {
  return {
    id: String(row.id),
    requestId: row.request_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    model: row.model,
    protocol: row.protocol as ContentModerationLogRow['protocol'],
    mode: row.mode as ContentModerationLogRow['mode'],
    action: row.action as ContentModerationLogRow['action'],
    flagged: row.flagged === true,
    highestCategory: row.highest_category,
    highestScore: number(row.highest_score),
    matchedKeyword: row.matched_keyword,
    categoryScores: (row.category_scores as Record<string, number>) ?? {},
    thresholdSnapshot: (row.threshold_snapshot as Record<string, number>) ?? {},
    inputExcerpt: row.input_excerpt,
    inputHash: row.input_hash,
    upstreamLatencyMs: row.upstream_latency_ms,
    error: row.error,
    violationCount: number(row.violation_count),
    autoBanned: row.auto_banned === true,
    emailSent: row.email_sent === true,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * Gateway-role store: config read, log insert, hash blocklist, violation
 * count and auto-ban. All statements run on the shared pool executor — no
 * transactions (moderation is outside the preparation transaction by design).
 */
export class PostgresContentModerationStore implements ContentModerationStore {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  readRawConfig(): Promise<string | null> {
    return this.executor
      .query<{ config: unknown }>('SELECT config FROM saas_risk_control_config WHERE id = 1', [])
      .then((result) => {
        const row = result.rows[0];
        if (row === undefined) return null;
        // jsonb comes back as a parsed object via pg; re-serialize so the
        // service computes a stable digest over canonical text.
        return typeof row.config === 'string' ? row.config : JSON.stringify(row.config);
      });
  }

  async insertLog(row: ContentModerationLogRow): Promise<void> {
    await this.executor.query(
      `INSERT INTO saas_content_moderation_logs (
         request_id, tenant_id, user_id, api_key_id, api_key_name, model, protocol, mode,
         action, flagged, highest_category, highest_score, matched_keyword, category_scores,
         threshold_snapshot, input_excerpt, input_hash, upstream_latency_ms, error,
         violation_count, auto_banned, email_sent, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb,
                 $16, $17, $18, $19, $20, $21, $22, now())`,
      [
        row.requestId,
        row.tenantId,
        row.userId,
        row.apiKeyId,
        row.apiKeyName,
        row.model,
        row.protocol,
        row.mode,
        row.action,
        row.flagged,
        row.highestCategory,
        row.highestScore,
        row.matchedKeyword,
        JSON.stringify(row.categoryScores),
        JSON.stringify(row.thresholdSnapshot),
        row.inputExcerpt,
        row.inputHash,
        row.upstreamLatencyMs,
        row.error,
        row.violationCount,
        row.autoBanned,
        row.emailSent,
      ],
    );
  }

  async countFlaggedByUserSince(userId: string, sinceIso: string): Promise<number> {
    const result = await this.executor.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM saas_content_moderation_logs
        WHERE user_id = $1 AND flagged AND action <> 'hash_block' AND created_at >= $2`,
      [userId, sinceIso],
    );
    return number(result.rows[0]?.count);
  }

  async hasFlaggedInputHash(inputHash: string): Promise<boolean> {
    const result = await this.executor.query(
      'SELECT 1 FROM saas_content_moderation_flagged_hashes WHERE input_hash = $1',
      [inputHash],
    );
    return result.rows.length > 0;
  }

  async recordFlaggedInputHash(inputHash: string): Promise<void> {
    await this.executor.query(
      `INSERT INTO saas_content_moderation_flagged_hashes (input_hash, created_at)
       VALUES ($1, now()) ON CONFLICT (input_hash) DO NOTHING`,
      [inputHash],
    );
  }

  /**
   * Auto-ban: flips disabled_at on the caller's principal user. Users holding
   * any platform role assignment are never auto-banned by risk control (the
   * governance surface owns those accounts).
   */
  async disableUser(userId: string): Promise<ModerationDisableUserResult> {
    const result = await this.executor.query(
      `UPDATE saas_users
          SET disabled_at = now(), updated_at = now()
        WHERE id = $1
          AND disabled_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM saas_platform_role_assignments WHERE user_id = $1
          )`,
      [userId],
    );
    return { newlyDisabled: result.rowCount === 1 };
  }

  async userContact(userId: string): Promise<ModerationUserContact | null> {
    const result = await this.executor.query<{ email: string | null }>('SELECT email FROM saas_users WHERE id = $1', [
      userId,
    ]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return { email: row.email };
  }

  async insertAuditEvent(event: ModerationAuditEvent): Promise<void> {
    await this.executor.query(
      `INSERT INTO saas_audit_events (id, tenant_id, actor_user_id, action, target_type, target_id,
                                      occurred_at, entry_point, request_id)
       VALUES ($1, $2, NULL, $3, $4, $5, clock_timestamp(), 'gateway-content-moderation', $6)`,
      [randomUUID(), event.tenantId, event.action, event.targetType, event.targetId, event.requestId],
    );
  }
}

/** Control-plane store: config upsert, log listing, retention, hash lifecycle. */
export class PostgresRiskControlAdminStore {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  /** Current normalized config plus whether a row exists yet. */
  async loadConfig(): Promise<{ config: RiskControlConfig; exists: boolean }> {
    const result = await this.executor.query<{ config: unknown }>(
      'SELECT config FROM saas_risk_control_config WHERE id = 1',
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { config: normalizeRiskControlConfig({}), exists: false };
    }
    return { config: normalizeRiskControlConfig(row.config), exists: true };
  }

  /** Validates the admin payload strictly and persists it atomically (upsert). */
  async saveConfig(raw: unknown): Promise<RiskControlConfig> {
    const config = parseRiskControlConfigInput(raw);
    await this.executor.query(
      `INSERT INTO saas_risk_control_config (id, config, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [serializeRiskControlConfig(config)],
    );
    return config;
  }

  async listLogs(filter: ContentModerationLogFilter): Promise<ContentModerationLogPage> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (filter.action !== undefined && filter.action !== '') {
      conditions.push(`action = ${bind(filter.action)}`);
    }
    if (filter.tenantId !== undefined && filter.tenantId !== '') {
      conditions.push(`tenant_id = ${bind(filter.tenantId)}`);
    }
    if (filter.model !== undefined && filter.model !== '') {
      conditions.push(`model = ${bind(filter.model)}`);
    }
    if (filter.flaggedOnly === true) {
      conditions.push('flagged');
    }
    if (filter.fromIso !== undefined && filter.fromIso !== '') {
      conditions.push(`created_at >= ${bind(filter.fromIso)}`);
    }
    if (filter.toIso !== undefined && filter.toIso !== '') {
      conditions.push(`created_at <= ${bind(filter.toIso)}`);
    }
    if (filter.search !== undefined && filter.search.trim() !== '') {
      const term = `%${filter.search.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const bound = bind(term);
      conditions.push(`(request_id ILIKE ${bound} OR api_key_name ILIKE ${bound} OR input_excerpt ILIKE ${bound})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(filter.limit), 10) || 20));
    const offset = Math.max(0, Number.parseInt(String(filter.offset), 10) || 0);
    const total = await this.executor.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM saas_content_moderation_logs ${where}`,
      values,
    );
    const rows = await this.executor.query<LogRow>(
      `SELECT ${LOG_COLUMNS} FROM saas_content_moderation_logs ${where}
        ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    return {
      items: rows.rows.map(mapLogRow),
      total: number(total.rows[0]?.count),
    };
  }

  async countFlaggedHashes(): Promise<number> {
    const result = await this.executor.query<{ count: number | string }>(
      'SELECT count(*) AS count FROM saas_content_moderation_flagged_hashes',
    );
    return number(result.rows[0]?.count);
  }

  async deleteFlaggedHash(inputHash: string): Promise<boolean> {
    const result = await this.executor.query(
      'DELETE FROM saas_content_moderation_flagged_hashes WHERE input_hash = $1',
      [inputHash],
    );
    return result.rowCount === 1;
  }

  async clearFlaggedHashes(): Promise<number> {
    const result = await this.executor.query('DELETE FROM saas_content_moderation_flagged_hashes');
    return result.rowCount ?? 0;
  }

  /**
   * Retention cleanup: flagged rows older than hitBefore and unflagged rows
   * older than nonHitBefore are deleted, plus blocklist hashes older than
   * hitBefore (the blocklist only ever holds flagged inputs).
   */
  async cleanupExpired(hitBeforeIso: string, nonHitBeforeIso: string): Promise<RiskControlCleanupResult> {
    const hit = await this.executor.query(
      'DELETE FROM saas_content_moderation_logs WHERE flagged AND created_at < $1',
      [hitBeforeIso],
    );
    const nonHit = await this.executor.query(
      'DELETE FROM saas_content_moderation_logs WHERE NOT flagged AND created_at < $1',
      [nonHitBeforeIso],
    );
    const hashes = await this.executor.query(
      'DELETE FROM saas_content_moderation_flagged_hashes WHERE created_at < $1',
      [hitBeforeIso],
    );
    return {
      deletedHit: hit.rowCount ?? 0,
      deletedNonHit: nonHit.rowCount ?? 0,
      deletedHashes: hashes.rowCount ?? 0,
    };
  }

  /** Unban: clears disabled_at (the governance path audits this separately). */
  async enableUser(userId: string): Promise<boolean> {
    const result = await this.executor.query(
      'UPDATE saas_users SET disabled_at = NULL, updated_at = now() WHERE id = $1 AND disabled_at IS NOT NULL',
      [userId],
    );
    return result.rowCount === 1;
  }

  /** Whether the target user holds any platform role (unban guard for the admin surface). */
  async userHoldsPlatformRole(userId: string): Promise<boolean> {
    const result = await this.executor.query(
      'SELECT 1 FROM saas_platform_role_assignments WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    return result.rows.length > 0;
  }
}
