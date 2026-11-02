import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { PlatformAdminActor } from '../platform/access/index.js';
import { verifyGovernanceActor } from '../platform/governance/actor.js';
import {
  governanceConflict,
  governanceInvalid,
  governanceNotFound,
  governanceStorage,
  PlatformGovernanceError,
} from '../platform/governance/errors.js';
import { appendGovernanceAudit } from '../platform/governance/users.js';
import { mapUserLimitPolicy } from './postgres-user-limits.js';
import {
  normalizeUserLimitPatch,
  resolveUserLimitPolicy,
  type UserLimitPatch,
  type UserLimitPolicy,
} from './user-limits.js';

const LIMIT_WRITE_ROLES = ['superadmin', 'security', 'operations'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LimitRow extends Record<string, unknown> {
  version: unknown;
  requests_per_minute: unknown;
  max_concurrent_requests: unknown;
  daily_token_units: unknown;
  daily_charge_minor_units: unknown;
  charge_currency: unknown;
}

export interface UserLimitUpdateInput {
  /** Decimal policy version; zero creates a per-user row. */
  readonly expectedVersion: string;
  readonly limits: unknown;
}

export interface UserLimitAdminView {
  readonly version: string;
  readonly stored: UserLimitPolicy;
  readonly effective: UserLimitPolicy;
}

function userId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) governanceInvalid();
  return value.toLowerCase();
}

function expectedVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) governanceInvalid();
  try {
    const parsed = BigInt(value);
    if (parsed > 9_223_372_036_854_775_807n) governanceInvalid();
    return parsed;
  } catch {
    return governanceInvalid();
  }
}

function version(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') governanceStorage();
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) governanceStorage();
  return text;
}

function values(policy: UserLimitPolicy): readonly unknown[] {
  return [
    policy.requestsPerMinute?.toString(10) ?? null,
    policy.maxConcurrentRequests?.toString(10) ?? null,
    policy.dailyTokenUnits?.toString(10) ?? null,
    policy.dailyChargeMinorUnits?.toString(10) ?? null,
    policy.chargeCurrency,
  ];
}

function merged(current: UserLimitPolicy, patch: UserLimitPatch): UserLimitPolicy {
  return {
    requestsPerMinute: Object.hasOwn(patch, 'requestsPerMinute')
      ? (patch.requestsPerMinute ?? null)
      : current.requestsPerMinute,
    maxConcurrentRequests: Object.hasOwn(patch, 'maxConcurrentRequests')
      ? (patch.maxConcurrentRequests ?? null)
      : current.maxConcurrentRequests,
    dailyTokenUnits: Object.hasOwn(patch, 'dailyTokenUnits')
      ? (patch.dailyTokenUnits ?? null)
      : current.dailyTokenUnits,
    dailyChargeMinorUnits: Object.hasOwn(patch, 'dailyChargeMinorUnits')
      ? (patch.dailyChargeMinorUnits ?? null)
      : current.dailyChargeMinorUnits,
    chargeCurrency: Object.hasOwn(patch, 'chargeCurrency') ? (patch.chargeCurrency ?? null) : current.chargeCurrency,
  };
}

function normalizeUpdate(current: UserLimitPolicy, input: unknown): UserLimitPolicy {
  let patch: UserLimitPatch;
  try {
    patch = normalizeUserLimitPatch(input);
  } catch {
    governanceInvalid();
  }
  // Revalidate the complete stored pair, including partial charge updates.
  return normalizeUserLimitPatch(merged(current, patch)) as UserLimitPolicy;
}

async function defaults(tx: SqlExecutor): Promise<LimitRow> {
  const result = await tx.query<LimitRow>(
    `SELECT version::text, requests_per_minute::text, max_concurrent_requests::text,
            daily_token_units::text, daily_charge_minor_units::text, charge_currency
       FROM saas_user_limit_defaults WHERE id = 1 LIMIT 2`,
  );
  if (result.rows.length !== 1 || !result.rows[0]) governanceStorage();
  return result.rows[0];
}

async function override(tx: SqlExecutor, id: string): Promise<LimitRow | null> {
  const result = await tx.query<LimitRow>(
    `SELECT version::text, requests_per_minute::text, max_concurrent_requests::text,
            daily_token_units::text, daily_charge_minor_units::text, charge_currency
       FROM saas_user_limit_policies WHERE user_id = $1 LIMIT 2`,
    [id],
  );
  if (result.rows.length > 1) governanceStorage();
  return result.rows[0] ?? null;
}

function view(row: LimitRow, defaultPolicy: UserLimitPolicy): UserLimitAdminView {
  const stored = mapUserLimitPolicy(row);
  return { version: version(row.version), stored, effective: resolveUserLimitPolicy(defaultPolicy, stored) };
}

/**
 * Operator-owned platform defaults and per-user overrides. Writes are CAS
 * mutations in the same transaction as fresh actor verification and audit.
 * Null override fields inherit platform defaults; null defaults mean unlimited.
 */
export class UserLimitAdminService {
  constructor(private readonly database: Pick<SaasDatabase, 'query' | 'transaction'>) {}

  async getDefaults(actor: PlatformAdminActor): Promise<UserLimitAdminView> {
    return this.read(actor, null);
  }

  async getUserLimits(actor: PlatformAdminActor, targetUserId: unknown): Promise<UserLimitAdminView> {
    return this.read(actor, userId(targetUserId));
  }

  private async read(actor: PlatformAdminActor, targetUserId: string | null): Promise<UserLimitAdminView> {
    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, actor, LIMIT_WRITE_ROLES);
        const defaultRow = await defaults(tx);
        const defaultPolicy = mapUserLimitPolicy(defaultRow);
        if (targetUserId === null) return view(defaultRow, defaultPolicy);
        const row = await override(tx, targetUserId);
        if (!row) {
          return {
            version: '0',
            stored: {
              requestsPerMinute: null,
              maxConcurrentRequests: null,
              dailyTokenUnits: null,
              dailyChargeMinorUnits: null,
              chargeCurrency: null,
            },
            effective: defaultPolicy,
          };
        }
        return view(row, defaultPolicy);
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  async updateDefaults(actor: PlatformAdminActor, input: UserLimitUpdateInput): Promise<UserLimitAdminView> {
    return this.update(actor, null, input);
  }

  async updateUserLimits(
    actor: PlatformAdminActor,
    targetUserId: unknown,
    input: UserLimitUpdateInput,
  ): Promise<UserLimitAdminView> {
    return this.update(actor, userId(targetUserId), input);
  }

  private async update(
    actor: PlatformAdminActor,
    targetUserId: string | null,
    input: UserLimitUpdateInput,
  ): Promise<UserLimitAdminView> {
    if (!input || typeof input !== 'object') governanceInvalid();
    const expected = expectedVersion(input.expectedVersion);
    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, actor, LIMIT_WRITE_ROLES);
        const defaultRow = await defaults(tx);
        const defaultPolicy = mapUserLimitPolicy(defaultRow);
        const currentRow = targetUserId === null ? defaultRow : await override(tx, targetUserId);
        if (targetUserId !== null) {
          const target = await tx.query('SELECT id FROM saas_users WHERE id = $1 AND anonymized_at IS NULL LIMIT 1', [
            targetUserId,
          ]);
          if (target.rows.length === 0) governanceNotFound();
          if (target.rows.length !== 1) governanceStorage();
        }
        if ((currentRow ? BigInt(version(currentRow.version)) : 0n) !== expected) governanceConflict();
        if (targetUserId !== null && expected === 0n && currentRow !== null) governanceConflict();
        const next = normalizeUpdate(
          currentRow
            ? mapUserLimitPolicy(currentRow)
            : {
                requestsPerMinute: null,
                maxConcurrentRequests: null,
                dailyTokenUnits: null,
                dailyChargeMinorUnits: null,
                chargeCurrency: null,
              },
          input.limits,
        );
        const now = new Date().toISOString();
        let row: LimitRow | undefined;
        if (targetUserId === null) {
          const result = await tx.query<LimitRow>(
            `UPDATE saas_user_limit_defaults
                SET requests_per_minute = $2, max_concurrent_requests = $3, daily_token_units = $4,
                    daily_charge_minor_units = $5, charge_currency = $6,
                    updated_by_user_id = $7, version = version + 1, updated_at = $8
              WHERE id = 1 AND version = $1
              RETURNING version::text, requests_per_minute::text, max_concurrent_requests::text,
                        daily_token_units::text, daily_charge_minor_units::text, charge_currency`,
            [expected.toString(10), ...values(next), actor.userId, now],
          );
          row = result.rows[0];
        } else if (expected === 0n) {
          const result = await tx.query<LimitRow>(
            `INSERT INTO saas_user_limit_policies
               (user_id, requests_per_minute, max_concurrent_requests, daily_token_units,
                daily_charge_minor_units, charge_currency, updated_by_user_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
             ON CONFLICT (user_id) DO NOTHING
             RETURNING version::text, requests_per_minute::text, max_concurrent_requests::text,
                       daily_token_units::text, daily_charge_minor_units::text, charge_currency`,
            [targetUserId, ...values(next), actor.userId, now],
          );
          row = result.rows[0];
        } else {
          const result = await tx.query<LimitRow>(
            `UPDATE saas_user_limit_policies
                SET requests_per_minute = $3, max_concurrent_requests = $4, daily_token_units = $5,
                    daily_charge_minor_units = $6, charge_currency = $7,
                    updated_by_user_id = $8, version = version + 1, updated_at = $9
              WHERE user_id = $1 AND version = $2
              RETURNING version::text, requests_per_minute::text, max_concurrent_requests::text,
                        daily_token_units::text, daily_charge_minor_units::text, charge_currency`,
            [targetUserId, expected.toString(10), ...values(next), actor.userId, now],
          );
          row = result.rows[0];
        }
        if (!row) governanceConflict();
        const nextDefaults = targetUserId === null ? mapUserLimitPolicy(row) : defaultPolicy;
        await appendGovernanceAudit(tx, {
          action: targetUserId === null ? 'platform_user_limits.default_updated' : 'platform_user_limits.updated',
          targetType: 'user_limit_policy',
          targetId: targetUserId ?? 'default',
          actorUserId: actor.userId,
          occurredAt: now,
        });
        return view(row, nextDefaults);
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }
}
