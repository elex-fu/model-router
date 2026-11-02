import { createHmac, randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { ClientAddressResolution } from '../gateway/client-address.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const DEFAULT_WINDOW_SECONDS = 300;
const DEFAULT_ADDRESS_THRESHOLD = 3;
const DEFAULT_ABRUPT_CALL_THRESHOLD = 20;
const DEFAULT_DETECTION_LIMIT = 500;

export interface UserRiskObservationInput {
  readonly userId: string;
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly publicModel: string;
  readonly protocol: string;
  readonly clientAddress: ClientAddressResolution | null | undefined;
}

export interface UserRiskObservationRecorder {
  record(executor: SqlExecutor, input: UserRiskObservationInput): Promise<void>;
}

function addressDigest(secret: Uint8Array, address: string): string {
  return createHmac('sha256', secret).update('model-router/user-risk/address/v1\0').update(address).digest('hex');
}

function requiredText(value: unknown, maximumLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.trim() !== value) {
    throw new TypeError('Invalid user risk observation');
  }
  return value;
}

/**
 * Request-path evidence capture only. Detection and enforcement never run here.
 * A resolved address is reduced to a deployment-keyed digest; unresolved or
 * absent evidence stays NULL and can still contribute to call-pattern counts.
 */
export class PostgresUserRiskObservationRecorder implements UserRiskObservationRecorder {
  private readonly secret: Uint8Array;

  constructor(secret: Uint8Array) {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
      throw new TypeError('User risk address hashing requires at least 32 bytes of key material');
    }
    this.secret = new Uint8Array(secret);
  }

  async record(executor: SqlExecutor, input: UserRiskObservationInput): Promise<void> {
    const userId = requiredText(input.userId);
    const tenantId = requiredText(input.tenantId);
    const apiKeyId = requiredText(input.apiKeyId);
    const publicModel = requiredText(input.publicModel);
    const protocol = requiredText(input.protocol, 64);
    const digest =
      input.clientAddress?.status === 'resolved' ? addressDigest(this.secret, input.clientAddress.address) : null;
    if (digest !== null && !HEX_64.test(digest)) throw new TypeError('Invalid address digest');
    await executor.query(
      `INSERT INTO saas_user_risk_observations
         (user_id, tenant_id, api_key_id, client_address_digest, public_model, protocol, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
      [userId, tenantId, apiKeyId, digest, publicModel, protocol],
    );
  }
}

interface DetectionRow extends Record<string, unknown> {
  id: unknown;
  user_id: unknown;
  tenant_id: unknown;
  api_key_id: unknown;
  kind: unknown;
}

export interface UserAnomalyBatchResult {
  readonly detected: number;
  readonly rateLimited: number;
  readonly keysSuspended: number;
  readonly accountsSuspended: number;
  /** Present only when another replica held the batch fence this cycle. */
  readonly skipped?: true;
}

export interface UserAnomalyDetectorOptions {
  readonly now?: () => Date;
  readonly windowSeconds?: number;
  readonly rapidAddressThreshold?: number;
  readonly abruptCallThreshold?: number;
  readonly detectionLimit?: number;
  readonly rateLimitedRequestsPerMinute?: bigint;
}

function boundedInteger(value: number, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid detector option');
  return value || fallback;
}

async function audit(
  tx: SqlExecutor,
  event: {
    readonly tenantId: string | null;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly requestId?: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id,
        occurred_at, entry_point, request_id)
     VALUES ($1, $2, NULL, $3, $4, $5, clock_timestamp(), 'user-anomaly-detection', $6)`,
    [randomUUID(), event.tenantId, event.action, event.targetType, event.targetId, event.requestId ?? null],
  );
}

async function setMarker(
  tx: SqlExecutor,
  userId: string,
  stage: 'rate_limited' | 'key_suspended' | 'account_suspended',
  rpm: bigint | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO saas_user_risk_markers (user_id, stage, requests_per_minute, revision, updated_at)
     VALUES ($1, $2, $3, 1, clock_timestamp())
     ON CONFLICT (user_id) DO UPDATE SET
       stage = EXCLUDED.stage,
       requests_per_minute = EXCLUDED.requests_per_minute,
       revision = saas_user_risk_markers.revision + 1,
       updated_at = clock_timestamp()
     WHERE CASE saas_user_risk_markers.stage
       WHEN 'rate_limited' THEN 1 WHEN 'key_suspended' THEN 2 WHEN 'account_suspended' THEN 3 END
       < CASE EXCLUDED.stage
       WHEN 'rate_limited' THEN 1 WHEN 'key_suspended' THEN 2 WHEN 'account_suspended' THEN 3 END`,
    [userId, stage, rpm?.toString(10) ?? null],
  );
}

/**
 * Bounded, asynchronous detector. The admission hot path performs only the O(1)
 * marker/status reads already present in authority SQL; all window aggregation,
 * detection writes and staged enforcement happen in this caller-driven batch.
 *
 * window_start is anchored to a fixed epoch bucket of the window size, never to
 * the batch run time: consecutive runs inside one observation window must hit
 * the same (api_key_id, kind, window_start) conflict key, or each scheduled run
 * would re-insert the same anomaly and escalate the lifetime-count ladder.
 */
export class PostgresUserAnomalyDetector {
  private readonly now: () => Date;
  private readonly windowSeconds: number;
  private readonly rapidAddressThreshold: number;
  private readonly abruptCallThreshold: number;
  private readonly detectionLimit: number;
  private readonly rateLimitedRpm: bigint;

  constructor(
    private readonly database: Pick<SaasDatabase, 'query' | 'transaction'>,
    options: UserAnomalyDetectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.windowSeconds = boundedInteger(options.windowSeconds ?? DEFAULT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS, 86400);
    this.rapidAddressThreshold = boundedInteger(
      options.rapidAddressThreshold ?? DEFAULT_ADDRESS_THRESHOLD,
      DEFAULT_ADDRESS_THRESHOLD,
      1000,
    );
    this.abruptCallThreshold = boundedInteger(
      options.abruptCallThreshold ?? DEFAULT_ABRUPT_CALL_THRESHOLD,
      DEFAULT_ABRUPT_CALL_THRESHOLD,
      1_000_000,
    );
    this.detectionLimit = boundedInteger(
      options.detectionLimit ?? DEFAULT_DETECTION_LIMIT,
      DEFAULT_DETECTION_LIMIT,
      10_000,
    );
    this.rateLimitedRpm = options.rateLimitedRequestsPerMinute ?? 10n;
    if (this.rateLimitedRpm < 0n) throw new TypeError('Invalid rate-limit marker');
  }

  async runBatch(): Promise<UserAnomalyBatchResult> {
    const now = this.now().toISOString();
    return this.database.transaction(async (tx) => {
      // Multi-replica fence: ON CONFLICT already makes duplicate detection
      // impossible, but the per-user lifetime-count escalation reads count(*)
      // after the insert — the xact lock keeps two replicas from racing the
      // ladder while both pay the aggregate. A session-level lock is never
      // used: pooled executors must not leak advisory locks across requests.
      const fence = await tx.query<{ locked: unknown }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('model-router:user-risk-anomaly-batch', 0)) AS locked",
      );
      if (fence.rows[0]?.locked !== true) {
        return { detected: 0, rateLimited: 0, keysSuspended: 0, accountsSuspended: 0, skipped: true };
      }
      const inserted = await tx.query<DetectionRow>(
        `WITH recent AS (
           SELECT user_id, tenant_id, api_key_id,
                  count(*) AS calls,
                  count(DISTINCT client_address_digest) AS addresses,
                  count(DISTINCT public_model) AS models,
                  count(DISTINCT protocol) AS protocols
             FROM saas_user_risk_observations
            WHERE occurred_at >= $1::timestamptz - make_interval(secs => $2)
              AND occurred_at < $1::timestamptz
            GROUP BY user_id, tenant_id, api_key_id
         ), baseline AS (
           SELECT api_key_id,
                  count(*) AS calls,
                  count(DISTINCT public_model) AS models,
                  count(DISTINCT protocol) AS protocols
             FROM saas_user_risk_observations
            WHERE occurred_at >= $1::timestamptz - 2 * make_interval(secs => $2)
              AND occurred_at < $1::timestamptz - make_interval(secs => $2)
            GROUP BY api_key_id
         ), candidates AS (
           SELECT r.user_id, r.tenant_id, r.api_key_id, 'rapid_address_switching'::text AS kind,
                  jsonb_build_object('calls', r.calls, 'distinctAddresses', r.addresses) AS facts
             FROM recent r
            WHERE r.addresses >= $3
           UNION ALL
           SELECT r.user_id, r.tenant_id, r.api_key_id, 'abrupt_call_pattern'::text AS kind,
                  jsonb_build_object('recentCalls', r.calls, 'baselineCalls', b.calls,
                    'recentModels', r.models, 'baselineModels', b.models,
                    'recentProtocols', r.protocols, 'baselineProtocols', b.protocols) AS facts
             FROM recent r
             JOIN baseline b ON b.api_key_id = r.api_key_id
            WHERE r.calls >= $4 AND b.calls > 0 AND r.calls >= 2 * b.calls
              AND (r.models > b.models OR r.protocols > b.protocols)
         ), bounded AS (
           SELECT user_id, tenant_id, api_key_id, kind, facts FROM candidates
            ORDER BY user_id, api_key_id, kind LIMIT $5
         ), inserted AS (
           INSERT INTO saas_user_anomaly_detections
             (user_id, tenant_id, api_key_id, kind, window_start, observed_at, facts)
           SELECT user_id, tenant_id, api_key_id, kind,
                  to_timestamp(floor(extract(epoch FROM $1::timestamptz) / $2) * $2),
                  clock_timestamp(), facts
             FROM bounded
           ON CONFLICT (api_key_id, kind, window_start) DO NOTHING
           RETURNING id, user_id, tenant_id, api_key_id, kind
         )
         SELECT id, user_id::text, tenant_id::text, api_key_id::text, kind FROM inserted
          ORDER BY id`,
        [now, this.windowSeconds, this.rapidAddressThreshold, this.abruptCallThreshold, this.detectionLimit],
      );

      let rateLimited = 0;
      let keysSuspended = 0;
      let accountsSuspended = 0;
      const enforcedUsers = new Set<string>();
      for (const row of inserted.rows) {
        if (
          typeof row.user_id !== 'string' ||
          typeof row.tenant_id !== 'string' ||
          typeof row.api_key_id !== 'string' ||
          (row.kind !== 'rapid_address_switching' && row.kind !== 'abrupt_call_pattern')
        ) {
          throw new TypeError('Malformed anomaly detection row');
        }
        await audit(tx, {
          tenantId: row.tenant_id,
          action: 'user_anomaly.detected',
          targetType: 'api_key',
          targetId: row.api_key_id,
          requestId: String(row.id),
        });
        if (enforcedUsers.has(row.user_id)) continue;
        enforcedUsers.add(row.user_id);

        // Same exclusive member authorization fence as governance/admission.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:user:' || $1::uuid::text, 0))", [
          row.user_id,
        ]);
        const count = await tx.query<{ count: unknown }>(
          'SELECT count(*)::text AS count FROM saas_user_anomaly_detections WHERE user_id = $1',
          [row.user_id],
        );
        const detections = BigInt(String(count.rows[0]?.count));
        if (detections === 1n) {
          await setMarker(tx, row.user_id, 'rate_limited', this.rateLimitedRpm);
          await audit(tx, {
            tenantId: null,
            action: 'user_risk.rate_limited',
            targetType: 'platform_user',
            targetId: row.user_id,
          });
          rateLimited += 1;
        } else if (detections === 2n) {
          const revoked = await tx.query<{ id: unknown; tenant_id: unknown }>(
            `UPDATE saas_api_keys
                SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = NULL,
                    authz_version = authz_version + 1
              WHERE id = $2 AND principal_user_id = $1 AND status = 'active'
              RETURNING id::text, tenant_id::text`,
            [row.user_id, row.api_key_id],
          );
          await setMarker(tx, row.user_id, 'key_suspended', null);
          for (const key of revoked.rows) {
            if (typeof key.id !== 'string' || typeof key.tenant_id !== 'string') {
              throw new TypeError('Malformed revoked key row');
            }
            await audit(tx, {
              tenantId: key.tenant_id,
              action: 'api_key.revoked',
              targetType: 'api_key',
              targetId: key.id,
            });
            keysSuspended += 1;
          }
        } else if (detections >= 3n) {
          const disabled = await tx.query<{ id: unknown }>(
            `UPDATE saas_users
                SET disabled_at = COALESCE(disabled_at, clock_timestamp()), updated_at = clock_timestamp()
              WHERE id = $1
                AND NOT EXISTS (SELECT 1 FROM saas_platform_role_assignments WHERE user_id = $1)
              RETURNING id::text`,
            [row.user_id],
          );
          if (disabled.rows.length === 1) {
            await tx.query(
              'UPDATE saas_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL',
              [row.user_id],
            );
            await tx.query(
              'UPDATE saas_platform_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL',
              [row.user_id],
            );
            const revoked = await tx.query<{ id: unknown; tenant_id: unknown }>(
              `UPDATE saas_api_keys
                  SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = NULL,
                      authz_version = authz_version + 1
                WHERE principal_user_id = $1 AND status = 'active'
                RETURNING id::text, tenant_id::text`,
              [row.user_id],
            );
            for (const key of revoked.rows) {
              if (typeof key.id !== 'string' || typeof key.tenant_id !== 'string') {
                throw new TypeError('Malformed revoked key row');
              }
              await audit(tx, {
                tenantId: key.tenant_id,
                action: 'api_key.revoked',
                targetType: 'api_key',
                targetId: key.id,
              });
            }
            await setMarker(tx, row.user_id, 'account_suspended', null);
            await audit(tx, {
              tenantId: null,
              action: 'platform_user.disabled',
              targetType: 'platform_user',
              targetId: row.user_id,
            });
            accountsSuspended += 1;
          }
        }
      }
      return { detected: inserted.rows.length, rateLimited, keysSuspended, accountsSuspended };
    });
  }
}
