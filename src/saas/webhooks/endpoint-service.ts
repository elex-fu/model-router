import { randomBytes, randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { assertWebhookUuid, CUSTOMER_WEBHOOK_EVENT_TYPES, type CustomerWebhookEventType } from './events.js';
import {
  assertProtectedWebhookEnvelope,
  type WebhookSigningSecretProtector,
  webhookSigningSecretAad,
} from './signing-secret-protector.js';
import { normalizeCustomerWebhookTargetUrl } from './target-policy.js';

export const CUSTOMER_WEBHOOK_MAX_SECRET_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface CustomerWebhookActorContext {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

export interface CustomerWebhookEndpointMetadata {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly currentVersion: number;
  readonly state: 'active' | 'suspended' | 'revoked';
  readonly targetUrl: string;
  readonly eventTypes: readonly CustomerWebhookEventType[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerWebhookSigningSecretMetadata {
  readonly endpointId: string;
  readonly version: number;
  readonly state: 'current' | 'overlap' | 'revoked';
  readonly overlapExpiresAt: string | null;
  readonly createdAt: string;
}

export interface CreatedCustomerWebhookEndpoint {
  readonly endpoint: CustomerWebhookEndpointMetadata;
  /** Returned only by create/rotate. Never persisted or returned by read APIs. */
  readonly signingSecret: string;
  readonly signingSecretVersion: number;
}

export interface CustomerWebhookEndpointUpdate {
  readonly targetUrl: string;
  readonly eventTypes: readonly CustomerWebhookEventType[];
}

interface EndpointRow {
  tenant_id: unknown;
  endpoint_id: unknown;
  current_version: unknown;
  state: unknown;
  target_url: unknown;
  event_types: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface SecretVersionRow {
  secret_version: unknown;
  state: unknown;
}

function asVersion(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 999_999_999) {
    throw new Error(`Stored webhook ${field} is invalid`);
  }
  return result;
}

function validRequestId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError('requestId is invalid');
  }
  return value;
}

function validateActor(input: CustomerWebhookActorContext): void {
  assertWebhookUuid(input.tenantId, 'tenantId');
  assertWebhookUuid(input.actorUserId, 'actorUserId');
  validRequestId(input.requestId);
}

function validateEventTypes(value: readonly CustomerWebhookEventType[]): CustomerWebhookEventType[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CUSTOMER_WEBHOOK_EVENT_TYPES.length) {
    throw new TypeError('eventTypes must contain one or more supported events');
  }
  const selected = [...value];
  if (
    selected.some((event) => !CUSTOMER_WEBHOOK_EVENT_TYPES.includes(event)) ||
    new Set(selected).size !== selected.length
  ) {
    throw new TypeError('eventTypes contains unsupported or duplicate event names');
  }
  return selected.sort();
}

function metadata(row: EndpointRow): CustomerWebhookEndpointMetadata {
  assertWebhookUuid(row.tenant_id, 'stored tenant_id');
  assertWebhookUuid(row.endpoint_id, 'stored endpoint_id');
  if (row.state !== 'active' && row.state !== 'suspended' && row.state !== 'revoked') {
    throw new Error('Stored webhook endpoint state is invalid');
  }
  if (typeof row.target_url !== 'string') throw new Error('Stored webhook target is invalid');
  const eventTypes = Array.isArray(row.event_types) ? row.event_types : [];
  const validatedEvents = validateEventTypes(eventTypes as CustomerWebhookEventType[]);
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return Object.freeze({
    tenantId: row.tenant_id,
    endpointId: row.endpoint_id,
    currentVersion: asVersion(row.current_version, 'endpoint version'),
    state: row.state,
    targetUrl: row.target_url,
    eventTypes: Object.freeze(validatedEvents),
    createdAt,
    updatedAt,
  });
}

async function assertEndpointManager(tx: SqlExecutor, actor: CustomerWebhookActorContext): Promise<void> {
  const result = await tx.query(
    `SELECT 1
     FROM saas_memberships
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role IN ('owner', 'admin')
     LIMIT 1`,
    [actor.tenantId, actor.actorUserId],
  );
  if (result.rowCount !== 1) throw new Error('WEBHOOK_FORBIDDEN');
}

async function assertTenantWebhookReader(executor: SqlExecutor, actor: CustomerWebhookActorContext): Promise<void> {
  const result = await executor.query(
    `SELECT 1 FROM saas_memberships
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [actor.tenantId, actor.actorUserId],
  );
  if (result.rowCount !== 1) throw new Error('WEBHOOK_FORBIDDEN');
}

async function lockTenantPolicy(
  tx: SqlExecutor,
  tenantId: string,
  requireEnabled: boolean,
): Promise<{ maxActiveEndpoints: number }> {
  const result = await tx.query<{ enabled: unknown; max_active_endpoints: unknown }>(
    `SELECT enabled, max_active_endpoints
     FROM saas_customer_webhook_tenant_policies WHERE tenant_id = $1 FOR UPDATE`,
    [tenantId],
  );
  if (result.rowCount !== 1 || typeof result.rows[0]?.enabled !== 'boolean') {
    throw new Error('WEBHOOK_TENANT_POLICY_REQUIRED');
  }
  if (requireEnabled && result.rows[0].enabled !== true) throw new Error('WEBHOOK_TENANT_POLICY_DISABLED');
  const maxActiveEndpoints = Number(result.rows[0].max_active_endpoints);
  if (!Number.isSafeInteger(maxActiveEndpoints) || maxActiveEndpoints < 1 || maxActiveEndpoints > 100) {
    throw new Error('WEBHOOK_TENANT_POLICY_INVALID');
  }
  return { maxActiveEndpoints };
}

async function assertEndpointCapacity(tx: SqlExecutor, tenantId: string, maximum: number): Promise<void> {
  const result = await tx.query<{ endpoint_count: unknown }>(
    `SELECT count(*) AS endpoint_count FROM saas_customer_webhook_endpoints
     WHERE tenant_id = $1 AND state <> 'revoked'`,
    [tenantId],
  );
  const count = Number(result.rows[0]?.endpoint_count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count >= maximum) throw new Error('WEBHOOK_ENDPOINT_QUOTA_EXCEEDED');
}

async function audit(
  tx: SqlExecutor,
  actor: CustomerWebhookActorContext,
  action: string,
  endpointId: string,
): Promise<string> {
  const id = randomUUID();
  const result = await tx.query(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id, entry_point, request_id)
     VALUES ($1, $2, $3, $4, 'customer_webhook_endpoint', $5, 'customer_webhook', $6)`,
    [id, actor.tenantId, actor.actorUserId, action, endpointId, actor.requestId],
  );
  if (result.rowCount !== 1) throw new Error('WEBHOOK_AUDIT_WRITE_FAILED');
  return id;
}

function validateOverlap(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > CUSTOMER_WEBHOOK_MAX_SECRET_OVERLAP_MS) {
    throw new RangeError(`overlapMs must be between 0 and ${CUSTOMER_WEBHOOK_MAX_SECRET_OVERLAP_MS}`);
  }
}

/** Tenant-scoped endpoint lifecycle. Secret envelopes never cross this service's metadata reads. */
export class CustomerWebhookEndpointService {
  constructor(
    private readonly database: SaasDatabase,
    private readonly protector: WebhookSigningSecretProtector,
  ) {
    if (protector?.purpose !== 'customer-webhook-signing-secret-v1') {
      throw new TypeError('a dedicated customer webhook signing-secret protector is required');
    }
  }

  async createEndpoint(
    actor: CustomerWebhookActorContext,
    input: CustomerWebhookEndpointUpdate,
  ): Promise<CreatedCustomerWebhookEndpoint> {
    validateActor(actor);
    await assertEndpointManager(this.database, actor);
    const targetUrl = normalizeCustomerWebhookTargetUrl(input.targetUrl);
    const eventTypes = validateEventTypes(input.eventTypes);
    const endpointId = randomUUID();
    const signingSecret = randomBytes(32).toString('base64url');
    const plaintext = Buffer.from(signingSecret, 'utf8');
    const version = 1;
    let envelope: Uint8Array;
    try {
      envelope = await this.protector.protect(
        plaintext,
        webhookSigningSecretAad({ tenantId: actor.tenantId, endpointId, secretVersion: version }),
      );
    } finally {
      plaintext.fill(0);
    }
    assertProtectedWebhookEnvelope(envelope);

    const endpoint = await this.database.transaction(async (tx) => {
      await assertEndpointManager(tx, actor);
      const policy = await lockTenantPolicy(tx, actor.tenantId, true);
      await assertEndpointCapacity(tx, actor.tenantId, policy.maxActiveEndpoints);
      const auditId = await audit(tx, actor, 'customer_webhook.endpoint_created', endpointId);
      const inserted = await tx.query(
        `INSERT INTO saas_customer_webhook_endpoints
           (tenant_id, id, current_version, state, created_by_user_id)
         VALUES ($1, $2, 1, 'active', $3)`,
        [actor.tenantId, endpointId, actor.actorUserId],
      );
      if (inserted.rowCount !== 1) throw new Error('WEBHOOK_ENDPOINT_WRITE_FAILED');
      await tx.query(
        `INSERT INTO saas_customer_webhook_endpoint_versions
           (tenant_id, endpoint_id, version, target_url, event_types, created_by_user_id, audit_event_id)
         VALUES ($1, $2, 1, $3, $4::text[], $5, $6)`,
        [actor.tenantId, endpointId, targetUrl, eventTypes, actor.actorUserId, auditId],
      );
      await tx.query(
        `INSERT INTO saas_customer_webhook_signing_secrets
           (tenant_id, endpoint_id, secret_version, state, encrypted_envelope, audit_event_id)
         VALUES ($1, $2, 1, 'current', $3, $4)`,
        [actor.tenantId, endpointId, Buffer.from(envelope), auditId],
      );
      return await this.readEndpointInTransaction(tx, actor.tenantId, endpointId);
    });
    return { endpoint, signingSecret, signingSecretVersion: version };
  }

  async updateEndpoint(
    actor: CustomerWebhookActorContext,
    endpointId: string,
    input: CustomerWebhookEndpointUpdate,
  ): Promise<CustomerWebhookEndpointMetadata> {
    validateActor(actor);
    assertWebhookUuid(endpointId, 'endpointId');
    const targetUrl = normalizeCustomerWebhookTargetUrl(input.targetUrl);
    const eventTypes = validateEventTypes(input.eventTypes);
    return this.database.transaction(async (tx) => {
      await assertEndpointManager(tx, actor);
      await lockTenantPolicy(tx, actor.tenantId, false);
      const current = await this.readHeadForUpdate(tx, actor.tenantId, endpointId);
      if (current.state === 'revoked') throw new Error('WEBHOOK_ENDPOINT_REVOKED');
      const nextVersion = current.currentVersion + 1;
      const auditId = await audit(tx, actor, 'customer_webhook.endpoint_updated', endpointId);
      await tx.query(
        `INSERT INTO saas_customer_webhook_endpoint_versions
           (tenant_id, endpoint_id, version, target_url, event_types, created_by_user_id, audit_event_id)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7)`,
        [actor.tenantId, endpointId, nextVersion, targetUrl, eventTypes, actor.actorUserId, auditId],
      );
      const result = await tx.query(
        `UPDATE saas_customer_webhook_endpoints
         SET current_version = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND current_version = $4 AND state <> 'revoked'`,
        [actor.tenantId, endpointId, nextVersion, current.currentVersion],
      );
      if (result.rowCount !== 1) throw new Error('WEBHOOK_ENDPOINT_CONFLICT');
      return await this.readEndpointInTransaction(tx, actor.tenantId, endpointId);
    });
  }

  async setEndpointState(
    actor: CustomerWebhookActorContext,
    endpointId: string,
    state: 'active' | 'suspended' | 'revoked',
  ): Promise<CustomerWebhookEndpointMetadata> {
    validateActor(actor);
    assertWebhookUuid(endpointId, 'endpointId');
    return this.database.transaction(async (tx) => {
      await assertEndpointManager(tx, actor);
      await lockTenantPolicy(tx, actor.tenantId, state === 'active');
      const current = await this.readHeadForUpdate(tx, actor.tenantId, endpointId);
      if (current.state === 'revoked' && state !== 'revoked') throw new Error('WEBHOOK_ENDPOINT_REVOKED');
      if (state === 'active') {
        const secret = await tx.query<SecretVersionRow>(
          `SELECT secret_version, state FROM saas_customer_webhook_signing_secrets
           WHERE tenant_id = $1 AND endpoint_id = $2 AND state = 'current' FOR UPDATE`,
          [actor.tenantId, endpointId],
        );
        if (secret.rowCount !== 1 || secret.rows[0]?.state !== 'current') throw new Error('WEBHOOK_SECRET_UNAVAILABLE');
      }
      if (current.state !== state) {
        const action =
          state === 'active'
            ? 'customer_webhook.endpoint_activated'
            : state === 'suspended'
              ? 'customer_webhook.endpoint_suspended'
              : 'customer_webhook.endpoint_revoked';
        await audit(tx, actor, action, endpointId);
        const result = await tx.query(
          `UPDATE saas_customer_webhook_endpoints
           SET state = $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2 AND state = $4`,
          [actor.tenantId, endpointId, state, current.state],
        );
        if (result.rowCount !== 1) throw new Error('WEBHOOK_ENDPOINT_CONFLICT');
      }
      return await this.readEndpointInTransaction(tx, actor.tenantId, endpointId);
    });
  }

  async rotateSigningSecret(
    actor: CustomerWebhookActorContext,
    endpointId: string,
    overlapMs: number,
  ): Promise<{ signingSecret: string; signingSecretVersion: number }> {
    validateActor(actor);
    assertWebhookUuid(endpointId, 'endpointId');
    validateOverlap(overlapMs);
    await assertEndpointManager(this.database, actor);
    const secretHead = await this.database.query<{ secret_version: unknown; state: unknown }>(
      `SELECT secret_version, state FROM saas_customer_webhook_signing_secrets
       WHERE tenant_id = $1 AND endpoint_id = $2 ORDER BY secret_version DESC`,
      [actor.tenantId, endpointId],
    );
    if ((secretHead.rowCount ?? 0) < 1) throw new Error('WEBHOOK_SECRET_UNAVAILABLE');
    const latestVersion = asVersion(secretHead.rows[0]?.secret_version, 'secret version');
    const currentVersions = secretHead.rows.filter((row) => row.state === 'current');
    if (currentVersions.length > 1) throw new Error('WEBHOOK_SECRET_STATE_INVALID');
    const expectedCurrentVersion = currentVersions[0]
      ? asVersion(currentVersions[0].secret_version, 'current secret version')
      : null;
    const newVersion = latestVersion + 1;
    if (newVersion > 999_999_999) throw new RangeError('webhook signing-secret version limit reached');

    const signingSecret = randomBytes(32).toString('base64url');
    const plaintext = Buffer.from(signingSecret, 'utf8');
    let envelope: Uint8Array;
    try {
      envelope = await this.protector.protect(
        plaintext,
        webhookSigningSecretAad({ tenantId: actor.tenantId, endpointId, secretVersion: newVersion }),
      );
    } finally {
      plaintext.fill(0);
    }
    assertProtectedWebhookEnvelope(envelope);

    await this.database.transaction(async (tx) => {
      await assertEndpointManager(tx, actor);
      await lockTenantPolicy(tx, actor.tenantId, false);
      const head = await this.readHeadForUpdate(tx, actor.tenantId, endpointId);
      if (head.state === 'revoked') throw new Error('WEBHOOK_ENDPOINT_REVOKED');
      const lockedSecrets = await tx.query<SecretVersionRow>(
        `SELECT secret_version, state FROM saas_customer_webhook_signing_secrets
         WHERE tenant_id = $1 AND endpoint_id = $2 ORDER BY secret_version DESC FOR UPDATE`,
        [actor.tenantId, endpointId],
      );
      const lockedLatestVersion = asVersion(lockedSecrets.rows[0]?.secret_version, 'latest secret version');
      const lockedCurrentVersions = lockedSecrets.rows.filter((row) => row.state === 'current');
      if (lockedCurrentVersions.length > 1) throw new Error('WEBHOOK_SECRET_STATE_INVALID');
      const lockedCurrentVersion = lockedCurrentVersions[0]
        ? asVersion(lockedCurrentVersions[0].secret_version, 'current secret version')
        : null;
      if (lockedLatestVersion !== latestVersion || lockedCurrentVersion !== expectedCurrentVersion) {
        throw new Error('WEBHOOK_SECRET_ROTATION_CONFLICT');
      }
      const auditId = await audit(tx, actor, 'customer_webhook.signing_secret_rotated', endpointId);
      await tx.query(
        `UPDATE saas_customer_webhook_signing_secrets
         SET state = 'revoked', overlap_expires_at = NULL
         WHERE tenant_id = $1 AND endpoint_id = $2 AND state = 'overlap'`,
        [actor.tenantId, endpointId],
      );
      if (expectedCurrentVersion !== null) {
        const currentUpdate = await tx.query(
          `UPDATE saas_customer_webhook_signing_secrets
           SET state = CASE WHEN $3::bigint > 0 THEN 'overlap' ELSE 'revoked' END,
               overlap_expires_at = CASE WHEN $3::bigint > 0
                 THEN clock_timestamp() + ($3::bigint * interval '1 millisecond') ELSE NULL END
           WHERE tenant_id = $1 AND endpoint_id = $2 AND secret_version = $4 AND state = 'current'`,
          [actor.tenantId, endpointId, overlapMs, expectedCurrentVersion],
        );
        if (currentUpdate.rowCount !== 1) throw new Error('WEBHOOK_SECRET_ROTATION_CONFLICT');
      }
      const inserted = await tx.query(
        `INSERT INTO saas_customer_webhook_signing_secrets
           (tenant_id, endpoint_id, secret_version, state, encrypted_envelope, audit_event_id)
         VALUES ($1, $2, $3, 'current', $4, $5)`,
        [actor.tenantId, endpointId, newVersion, Buffer.from(envelope), auditId],
      );
      if (inserted.rowCount !== 1) throw new Error('WEBHOOK_SECRET_ROTATION_FAILED');
    });
    return { signingSecret, signingSecretVersion: newVersion };
  }

  async revokeSigningSecret(actor: CustomerWebhookActorContext, endpointId: string, version: number): Promise<void> {
    validateActor(actor);
    assertWebhookUuid(endpointId, 'endpointId');
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('version must be positive');
    await this.database.transaction(async (tx) => {
      await assertEndpointManager(tx, actor);
      await lockTenantPolicy(tx, actor.tenantId, false);
      await this.readHeadForUpdate(tx, actor.tenantId, endpointId);
      const secret = await tx.query<SecretVersionRow>(
        `SELECT secret_version, state FROM saas_customer_webhook_signing_secrets
         WHERE tenant_id = $1 AND endpoint_id = $2 AND secret_version = $3 FOR UPDATE`,
        [actor.tenantId, endpointId, version],
      );
      if (secret.rowCount !== 1) throw new Error('WEBHOOK_SECRET_NOT_FOUND');
      if (secret.rows[0]?.state === 'revoked') return;
      await audit(tx, actor, 'customer_webhook.signing_secret_revoked', endpointId);
      await tx.query(
        `UPDATE saas_customer_webhook_signing_secrets
         SET state = 'revoked', overlap_expires_at = NULL
         WHERE tenant_id = $1 AND endpoint_id = $2 AND secret_version = $3`,
        [actor.tenantId, endpointId, version],
      );
      if (secret.rows[0]?.state === 'current') {
        await tx.query(
          `UPDATE saas_customer_webhook_endpoints
           SET state = CASE WHEN state = 'active' THEN 'suspended' ELSE state END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [actor.tenantId, endpointId],
        );
      }
    });
  }

  async readEndpoint(actor: CustomerWebhookActorContext, endpointId: string): Promise<CustomerWebhookEndpointMetadata> {
    validateActor(actor);
    assertWebhookUuid(endpointId, 'endpointId');
    await assertTenantWebhookReader(this.database, actor);
    const result = await this.database.query<EndpointRow>(
      `SELECT e.tenant_id, e.id AS endpoint_id, e.current_version, e.state,
              v.target_url, v.event_types, e.created_at, e.updated_at
       FROM saas_customer_webhook_endpoints e
       JOIN saas_customer_webhook_endpoint_versions v
         ON v.tenant_id = e.tenant_id AND v.endpoint_id = e.id AND v.version = e.current_version
       WHERE e.tenant_id = $1 AND e.id = $2`,
      [actor.tenantId, endpointId],
    );
    if (result.rowCount !== 1) throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');
    return metadata(result.rows[0]);
  }

  async listSigningSecretMetadata(
    actor: CustomerWebhookActorContext,
    endpointId: string,
  ): Promise<readonly CustomerWebhookSigningSecretMetadata[]> {
    validateActor(actor);
    assertWebhookUuid(endpointId, 'endpointId');
    await assertTenantWebhookReader(this.database, actor);
    const result = await this.database.query<{
      secret_version: unknown;
      state: unknown;
      overlap_expires_at: unknown;
      created_at: unknown;
    }>(
      `SELECT secret_version, state, overlap_expires_at, created_at
       FROM saas_customer_webhook_signing_secrets
       WHERE tenant_id = $1 AND endpoint_id = $2
       ORDER BY secret_version DESC`,
      [actor.tenantId, endpointId],
    );
    return Object.freeze(
      result.rows.map((row) => {
        if (row.state !== 'current' && row.state !== 'overlap' && row.state !== 'revoked') {
          throw new Error('Stored webhook secret state is invalid');
        }
        return Object.freeze({
          endpointId,
          version: asVersion(row.secret_version, 'secret version'),
          state: row.state,
          overlapExpiresAt:
            row.overlap_expires_at === null
              ? null
              : row.overlap_expires_at instanceof Date
                ? row.overlap_expires_at.toISOString()
                : String(row.overlap_expires_at),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        });
      }),
    );
  }

  private async readHeadForUpdate(
    tx: SqlExecutor,
    tenantId: string,
    endpointId: string,
  ): Promise<{ currentVersion: number; state: 'active' | 'suspended' | 'revoked' }> {
    const result = await tx.query<{ current_version: unknown; state: unknown }>(
      `SELECT current_version, state FROM saas_customer_webhook_endpoints
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, endpointId],
    );
    if (result.rowCount !== 1) throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');
    const row = result.rows[0];
    if (row?.state !== 'active' && row?.state !== 'suspended' && row?.state !== 'revoked') {
      throw new Error('Stored webhook endpoint state is invalid');
    }
    return { currentVersion: asVersion(row.current_version, 'endpoint version'), state: row.state };
  }

  private async readEndpointInTransaction(
    tx: SqlExecutor,
    tenantId: string,
    endpointId: string,
  ): Promise<CustomerWebhookEndpointMetadata> {
    const result = await tx.query<EndpointRow>(
      `SELECT e.tenant_id, e.id AS endpoint_id, e.current_version, e.state,
              v.target_url, v.event_types, e.created_at, e.updated_at
       FROM saas_customer_webhook_endpoints e
       JOIN saas_customer_webhook_endpoint_versions v
         ON v.tenant_id = e.tenant_id AND v.endpoint_id = e.id AND v.version = e.current_version
       WHERE e.tenant_id = $1 AND e.id = $2`,
      [tenantId, endpointId],
    );
    if (result.rowCount !== 1) throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');
    return metadata(result.rows[0]);
  }
}
