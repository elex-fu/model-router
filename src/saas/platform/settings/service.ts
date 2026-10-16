import { randomUUID } from 'node:crypto';
import { TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY } from '../../billing/groups/multiplier.js';
import type { TopupAmountTier } from '../../billing/groups/types.js';
import type {
  ProviderCredentialSealingKms,
  ProviderCredentialUnsealingKms,
} from '../../credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { diffSettings } from '../../observability/settings-diff.js';
import {
  getPlatformSettingDefinition,
  PLATFORM_REGISTRATION_SECRET_SETTINGS_KEYS,
  PLATFORM_REGISTRATION_SETTINGS_KEYS,
  type PlatformSettingDefinition,
  parseStoredTopupAmountTierDiscounts,
} from './registry.js';
import {
  type PlatformSettingSealContextInput,
  sealPlatformSettingSecret,
  withUnsealedPlatformSettingSecret,
} from './seal.js';

/**
 * F1 platform settings store (task #34): the platform-owned mutable runtime
 * configuration service (migration 110's saas_platform_settings table).
 *
 * Contract:
 * - Closed key space: only registry-defined keys can be written; every plain
 *   value is validated by the key's strict parser before persistence, so the
 *   store can never hold a value the consumers' parsers would reject.
 * - Optimistic concurrency: mutations carry the caller's expected version and
 *   run as version-CAS UPDATE ... RETURNING inside one transaction (the
 *   authz_version pattern); a stale or missing row fails closed with
 *   VERSION_CONFLICT / NOT_FOUND instead of last-write-winning.
 * - Audit: every mutation appends an immutable saas_audit_events row plus a
 *   narrow saas_platform_settings_audit_details sibling (the 042 pattern)
 *   carrying the settings key, the version step and the key-level change
 *   summary — diffSettings output with secret-suffixed keys rendered
 *   [redacted] on both sides, so no secret material can land in the audit
 *   trail. An identical-value write is rejected (UNCHANGED) rather than
 *   producing an empty (CHECK-violating) summary.
 * - Sealed secrets: secret-suffixed keys are stored only as KMS sealed
 *   envelopes (sealProviderCredential output — the egress-proxy precedent);
 *   the plaintext exists only inside the unseal callback. Sealing needs the
 *   control plane's sealing KMS; unsealing needs an unsealing KMS (the
 *   gateway-class credential KMS — the only role allowed to hold one). G4
 *   consumption: withSettingSecret resolves a sealed key to its plaintext at
 *   the point of use for a designated, registry-allowlisted consumer label,
 *   fails closed with UNSEALING_UNAVAILABLE when the role holds no unsealing
 *   key provider, and appends an audited 'platform.settings.secret_unsealed'
 *   event (plus the narrow audit-details sibling) before the plaintext is
 *   handed over — never recording the plaintext itself.
 */

export type PlatformSettingsErrorCode =
  | 'INVALID_KEY'
  | 'INVALID_VALUE'
  | 'UNCHANGED'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'SEALING_UNAVAILABLE'
  | 'UNSEALING_UNAVAILABLE'
  | 'CONSUMER_NOT_ALLOWED'
  | 'UNSEAL_FAILED';

export class PlatformSettingsError extends Error {
  readonly code: PlatformSettingsErrorCode;

  constructor(code: PlatformSettingsErrorCode, message: string) {
    super(message);
    this.name = 'PlatformSettingsError';
    this.code = code;
  }
}

export interface PlatformSettingsActor {
  readonly actorUserId: string | null;
  readonly requestId?: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/** A settings row as exposed to consumers. Sealed rows never carry their value. */
export interface PlatformSettingRecord {
  readonly key: string;
  readonly secret: boolean;
  /** Inner value for plain keys; always undefined for sealed keys. */
  readonly value: unknown;
  readonly version: number;
  readonly updatedByUserId: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface PlatformSettingsServiceOptions {
  readonly database: SaasDatabase;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  /** KMS seam for sealing secret settings values (control plane holds this). */
  readonly sealingKms?: ProviderCredentialSealingKms;
  /** KMS seam for unsealing (worker/gateway-class runtimes; not the control plane). */
  readonly unsealingKms?: ProviderCredentialUnsealingKms;
  readonly kmsKeyId?: string;
  /** Deployment identity for the per-key seal context (AAD/encryption context). */
  readonly sealContext?: Readonly<{ deployment: string; environment: string }>;
}

interface SettingsRow {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly version?: unknown;
  readonly updated_by_user_id?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
}

const SETTINGS_LOCK_KEY = 'saas-platform-settings:mutations';
const MAX_SECRET_BYTES = 4096;
const MAX_AUDIT_SUMMARY_LINES = 64;
const CONSUMER_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(code: PlatformSettingsErrorCode, message: string): never {
  throw new PlatformSettingsError(code, message);
}

function requireDefinition(key: unknown): PlatformSettingDefinition {
  const definition = getPlatformSettingDefinition(typeof key === 'string' ? key : '');
  if (definition === undefined) fail('INVALID_KEY', 'The settings key is not registered');
  return definition;
}

function rowVersion(value: unknown): number {
  const version = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) fail('VERSION_CONFLICT', 'The settings row version is invalid');
  return version;
}

function rowText(value: unknown): string {
  return typeof value === 'string' ? value : new Date(0).toISOString();
}

function innerValue(envelope: unknown): unknown {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return undefined;
  return (envelope as { value?: unknown }).value;
}

function boundedAuditText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 512 ||
    [...trimmed].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    return null;
  }
  return trimmed;
}

function boundedAuditIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 45) return null;
  return value.trim();
}

export class PlatformSettingsService {
  private readonly idFactory: () => string;

  constructor(
    private readonly database: SaasDatabase,
    private readonly options: Omit<PlatformSettingsServiceOptions, 'database'> = {},
  ) {
    if (!this.database || typeof this.database.transaction !== 'function') {
      throw new TypeError('PlatformSettingsService requires a SaasDatabase');
    }
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /** Lists every stored setting, ordered by key. Sealed rows carry no value. */
  async list(): Promise<readonly PlatformSettingRecord[]> {
    const result = await this.database.query<SettingsRow>(
      `/* saas-platform-settings:list */
       SELECT key, value, version, updated_by_user_id, created_at, updated_at
         FROM saas_platform_settings
        ORDER BY key ASC
        LIMIT 1000`,
    );
    return result.rows.map((row) => this.recordFrom(row));
  }

  /** One setting by exact key, or undefined when the store has no row. */
  async get(key: string): Promise<PlatformSettingRecord | undefined> {
    const definition = requireDefinition(key);
    const result = await this.database.query<SettingsRow>(
      `/* saas-platform-settings:get */
       SELECT key, value, version, updated_by_user_id, created_at, updated_at
         FROM saas_platform_settings
        WHERE key = $1`,
      [definition.key],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.recordFrom(row);
  }

  /**
   * Plain values for a set of keys (sealed keys are skipped — their values are
   * envelopes, not consumable configuration). Used by the store-first
   * resolution paths.
   */
  async readPlainValues(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    const wanted = [...new Set(keys)].filter((key) => {
      const definition = getPlatformSettingDefinition(key);
      return definition !== undefined && definition.kind === 'plain';
    });
    if (wanted.length === 0) return {};
    const result = await this.database.query<SettingsRow>(
      `/* saas-platform-settings:read-plain */
       SELECT key, value FROM saas_platform_settings WHERE key = ANY($1::text[])`,
      [wanted],
    );
    const values: Record<string, unknown> = {};
    for (const row of result.rows) {
      if (typeof row.key !== 'string') continue;
      values[row.key] = innerValue(row.value);
    }
    return values;
  }

  /**
   * The registration admission overlay: settings-key → plain string value for
   * every non-secret registration key present in the store. Feeds
   * resolveRegistrationAdmissionSettings (store-first, env fallback).
   */
  async readRegistrationSettingsOverlay(): Promise<Readonly<Record<string, string>>> {
    const values = await this.readPlainValues(PLATFORM_REGISTRATION_SETTINGS_KEYS);
    const overlay: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && value !== '') overlay[key] = value;
    }
    return overlay;
  }

  /**
   * The R1 topup amount-tier discounts from the store. An absent key yields no
   * tiers (the exact pre-F1 default); a present value is re-parsed with the
   * same strict grammar (set() pre-validation makes parse failures impossible
   * for admin-written rows, so a failure here is a storage integrity problem
   * and propagates fail-closed).
   */
  async readTopupAmountTierDiscounts(): Promise<readonly TopupAmountTier[]> {
    const values = await this.readPlainValues([TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY]);
    const value = values[TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY];
    if (value === undefined) return [];
    return parseStoredTopupAmountTierDiscounts(value);
  }

  /** Sets a plain (non-secret) settings value with optimistic version CAS. */
  async set(input: {
    readonly key: string;
    readonly value: unknown;
    readonly expectedVersion: number;
    readonly actor: PlatformSettingsActor;
  }): Promise<PlatformSettingRecord> {
    const definition = requireDefinition(input?.key);
    if (definition.kind === 'sealed') {
      fail('INVALID_VALUE', 'The settings key holds a sealed secret; use the secret write path');
    }
    let normalized: unknown;
    try {
      normalized = definition.parse(input?.value);
    } catch (error) {
      fail('INVALID_VALUE', error instanceof Error ? error.message : 'The settings value failed its strict parser');
    }
    return this.mutate(definition.key, { value: normalized }, input.expectedVersion, input.actor, false);
  }

  /**
   * Seals and stores a secret settings value (Turnstile secret, SMTP
   * password). Requires the sealing KMS; the plaintext never persists and
   * never appears in the audit trail.
   */
  async setSecret(input: {
    readonly key: string;
    readonly secret: string;
    readonly expectedVersion: number;
    readonly actor: PlatformSettingsActor;
  }): Promise<PlatformSettingRecord> {
    const definition = requireDefinition(input?.key);
    if (definition.kind !== 'sealed') {
      fail('INVALID_VALUE', 'The settings key does not hold a sealed secret');
    }
    if (
      typeof input?.secret !== 'string' ||
      input.secret.length === 0 ||
      Buffer.byteLength(input.secret, 'utf-8') > MAX_SECRET_BYTES
    ) {
      fail('INVALID_VALUE', 'The secret value is missing or too large');
    }
    if (!this.options.sealingKms || !this.options.kmsKeyId || !this.options.sealContext) {
      fail('SEALING_UNAVAILABLE', 'Sealing a secret settings value requires the provider credential sealing KMS');
    }
    const envelope = await sealPlatformSettingSecret(
      input.secret,
      this.sealContextFor(definition.key),
      this.options.sealingKms,
      this.options.kmsKeyId,
    );
    return this.mutate(definition.key, envelope, input.expectedVersion, input.actor, true);
  }

  /**
   * G4 sealed-secret consumption: unseals a secret settings value inside the
   * callback (the plaintext exists only there) for a designated consumer.
   *
   * Contract:
   * - Access control: `consumer` must be a bounded label allowlisted on the
   *   key's registry definition (CONSUMER_NOT_ALLOWED otherwise). The admin
   *   HTTP surface never calls this path — it keeps returning redacted
   *   metadata only.
   * - Fail-closed: without an unsealing KMS and seal context the read fails
   *   with UNSEALING_UNAVAILABLE; a corrupt envelope, a wrong key or a KMS
   *   failure surfaces as UNSEAL_FAILED. Ciphertext is never returned.
   * - Audit: a successful unseal appends 'platform.settings.secret_unsealed'
   *   to saas_audit_events (entry_point = consumer label, no actor, no
   *   request metadata) plus the audit-details sibling carrying the key, the
   *   version read and a fully redacted summary — inside the same
   *   transaction, before the plaintext reaches the consumer callback, so an
   *   audit failure denies the handoff. The plaintext is never recorded.
   */
  async withSettingSecret<T>(
    key: string,
    consumer: string,
    callback: (secret: string) => T | PromiseLike<T>,
  ): Promise<T> {
    const definition = requireDefinition(key);
    if (definition.kind !== 'sealed') fail('INVALID_VALUE', 'The settings key does not hold a sealed secret');
    const consumerLabel = this.requireConsumer(consumer, definition);
    if (!this.options.unsealingKms || !this.options.sealContext) {
      fail('UNSEALING_UNAVAILABLE', 'Unsealing a secret settings value requires an unsealing KMS');
    }
    if (typeof callback !== 'function') fail('INVALID_VALUE', 'The unseal callback is required');
    const kms = this.options.unsealingKms;
    return this.database.transaction(async (tx) => {
      const record = await tx.query<SettingsRow>(
        `/* saas-platform-settings:get-sealed */
         SELECT value, version FROM saas_platform_settings WHERE key = $1`,
        [definition.key],
      );
      const row = record.rows[0];
      if (row === undefined) fail('NOT_FOUND', 'The settings key has no stored value');
      const version = rowVersion(row.version);
      try {
        return await withUnsealedPlatformSettingSecret(
          row.value,
          this.sealContextFor(definition.key),
          kms,
          async (secret) => {
            await this.auditUnseal(tx, definition.key, version, consumerLabel);
            return await callback(secret);
          },
        );
      } catch (error) {
        if (error instanceof PlatformSettingsError) throw error;
        fail('UNSEAL_FAILED', 'The settings secret could not be unsealed');
      }
    });
  }

  /**
   * The G4 registration secrets overlay: settings-key → plaintext for every
   * sealed registration key present in the store. Absent keys are omitted (env
   * fallback — the exact pre-F1 posture); present keys fail closed through
   * withSettingSecret (UNSEALING_UNAVAILABLE when the role holds no unsealing
   * key provider, UNSEAL_FAILED on a wrong key or corrupt envelope), so a
   * store-carried secret can never silently degrade to the environment.
   */
  async readRegistrationSecretsOverlay(consumer: string): Promise<Readonly<Record<string, string>>> {
    const overlay: Record<string, string> = {};
    for (const key of PLATFORM_REGISTRATION_SECRET_SETTINGS_KEYS) {
      try {
        const secret = await this.withSettingSecret(key, consumer, (value) => value);
        if (secret !== '') overlay[key] = secret;
      } catch (error) {
        if (error instanceof PlatformSettingsError && error.code === 'NOT_FOUND') continue;
        throw error;
      }
    }
    return overlay;
  }

  private requireConsumer(consumer: unknown, definition: PlatformSettingDefinition): string {
    if (typeof consumer !== 'string' || !CONSUMER_LABEL_PATTERN.test(consumer)) {
      fail('CONSUMER_NOT_ALLOWED', 'The settings secret consumer is not recognized');
    }
    if (!(definition.consumers ?? []).includes(consumer)) {
      fail('CONSUMER_NOT_ALLOWED', 'The consumer is not permitted to unseal this settings secret');
    }
    return consumer;
  }

  private async auditUnseal(tx: SqlExecutor, key: string, version: number, consumer: string): Promise<void> {
    const auditEventId = this.idFactory();
    const auditEvent = await tx.query(
      `INSERT INTO saas_audit_events
        (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, source_ip, user_agent, entry_point, request_id)
       VALUES ($1, NULL, NULL, 'platform.settings.secret_unsealed', 'platform_settings', $2, clock_timestamp(), NULL, NULL, $3, NULL)
       RETURNING id`,
      [auditEventId, key, consumer],
    );
    if (auditEvent.rowCount !== 1) fail('UNSEAL_FAILED', 'The settings unseal audit event could not be persisted');
    const details = await tx.query(
      `INSERT INTO saas_platform_settings_audit_details
         (audit_event_id, settings_key, before_version, after_version, change_summary)
       VALUES ($1, $2, NULL, $3, $4::jsonb)
       RETURNING audit_event_id`,
      [auditEventId, key, version, JSON.stringify([`[redacted] unsealed by ${consumer}`])],
    );
    if (details.rowCount !== 1) fail('UNSEAL_FAILED', 'The settings unseal audit detail could not be persisted');
  }

  private sealContextFor(key: string): PlatformSettingSealContextInput {
    const base = this.options.sealContext;
    if (!base || typeof base.deployment !== 'string' || typeof base.environment !== 'string') {
      fail('SEALING_UNAVAILABLE', 'Sealing requires the deployment seal context');
    }
    return { settingsKey: key, deployment: base.deployment, environment: base.environment };
  }

  private recordFrom(row: SettingsRow): PlatformSettingRecord {
    const key = typeof row.key === 'string' ? row.key : '';
    const definition = requireDefinition(key);
    return {
      key,
      secret: definition.kind === 'sealed',
      value: definition.kind === 'sealed' ? undefined : innerValue(row.value),
      version: rowVersion(row.version),
      updatedByUserId: typeof row.updated_by_user_id === 'string' ? row.updated_by_user_id : null,
      createdAt: rowText(row.created_at),
      updatedAt: rowText(row.updated_at),
    };
  }

  private async mutate(
    key: string,
    storedValue: unknown,
    expectedVersion: number,
    actor: PlatformSettingsActor,
    redacted: boolean,
  ): Promise<PlatformSettingRecord> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      fail('INVALID_VALUE', 'The expected version must be a non-negative integer');
    }
    const normalizedActor = {
      actorUserId: typeof actor?.actorUserId === 'string' && actor.actorUserId.length > 0 ? actor.actorUserId : null,
      requestId: typeof actor?.requestId === 'string' && actor.requestId.length > 0 ? actor.requestId : null,
      sourceIp: boundedAuditIp(actor?.sourceIp),
      userAgent: boundedAuditText(actor?.userAgent),
    };
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [SETTINGS_LOCK_KEY]);
      const current = await tx.query<SettingsRow>(
        `SELECT key, value, version FROM saas_platform_settings WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const existing = current.rows[0];
      let beforeVersion: number | null = null;
      let changeSummary: string[];

      if (existing === undefined) {
        if (expectedVersion !== 0) fail('NOT_FOUND', 'The settings key has no stored value');
        beforeVersion = null;
        changeSummary = redacted
          ? ['[redacted] → [redacted]']
          : diffSettings(undefined, storedValue).slice(0, MAX_AUDIT_SUMMARY_LINES);
      } else {
        beforeVersion = rowVersion(existing.version);
        if (expectedVersion !== beforeVersion) {
          fail('VERSION_CONFLICT', 'The settings row was modified concurrently');
        }
        if (redacted) {
          changeSummary = ['[redacted] → [redacted]'];
        } else {
          if (JSON.stringify(innerValue(existing.value)) === JSON.stringify(innerValue(storedValue))) {
            fail('UNCHANGED', 'The settings value is unchanged');
          }
          changeSummary = diffSettings(existing.value, storedValue).slice(0, MAX_AUDIT_SUMMARY_LINES);
        }
      }
      if (changeSummary.length === 0) fail('UNCHANGED', 'The settings value is unchanged');

      let after: SettingsRow;
      if (existing === undefined) {
        const inserted = await tx.query<SettingsRow>(
          `INSERT INTO saas_platform_settings (key, value, version, updated_by_user_id)
           VALUES ($1, $2::jsonb, 1, $3)
           ON CONFLICT (key) DO NOTHING
           RETURNING key, value, version, updated_by_user_id, created_at, updated_at`,
          [key, JSON.stringify(storedValue), normalizedActor.actorUserId],
        );
        if (inserted.rows[0] === undefined) {
          fail('VERSION_CONFLICT', 'The settings row was modified concurrently');
        }
        after = inserted.rows[0];
      } else {
        const updated = await tx.query<SettingsRow>(
          `UPDATE saas_platform_settings
              SET value = $2::jsonb,
                  version = version + 1,
                  updated_by_user_id = $3,
                  updated_at = now()
            WHERE key = $1 AND version = $4
            RETURNING key, value, version, updated_by_user_id, created_at, updated_at`,
          [key, JSON.stringify(storedValue), normalizedActor.actorUserId, expectedVersion],
        );
        if (updated.rows[0] === undefined) {
          fail('VERSION_CONFLICT', 'The settings row was modified concurrently');
        }
        after = updated.rows[0];
      }
      const afterVersion = rowVersion(after.version);

      const auditEventId = this.idFactory();
      const auditEvent = await tx.query(
        `INSERT INTO saas_audit_events
        (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, source_ip, user_agent, entry_point, request_id)
        VALUES ($1, NULL, $2, 'platform.settings.updated', 'platform_settings', $3, clock_timestamp(), $4::inet, $5, 'platform_admin', $6)
        RETURNING id`,
        [
          auditEventId,
          normalizedActor.actorUserId,
          key,
          normalizedActor.sourceIp,
          normalizedActor.userAgent,
          normalizedActor.requestId,
        ],
      );
      if (auditEvent.rowCount !== 1) fail('VERSION_CONFLICT', 'The settings audit event could not be persisted');
      const details = await tx.query(
        `INSERT INTO saas_platform_settings_audit_details
           (audit_event_id, settings_key, before_version, after_version, change_summary)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING audit_event_id`,
        [auditEventId, key, beforeVersion, afterVersion, JSON.stringify(changeSummary)],
      );
      if (details.rowCount !== 1) fail('VERSION_CONFLICT', 'The settings audit detail could not be persisted');

      return {
        key,
        secret: redacted,
        value: redacted ? undefined : innerValue(after.value),
        version: afterVersion,
        updatedByUserId: normalizedActor.actorUserId,
        createdAt: rowText(after.created_at),
        updatedAt: rowText(after.updated_at),
      };
    });
  }
}
