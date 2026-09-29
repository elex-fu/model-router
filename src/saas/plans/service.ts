import { createHash, randomUUID } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../db/advisory-lock-keys.js';
import type { SqlExecutor, SqlResult } from '../db/types.js';
import type { TenantContext } from '../identity/types.js';
import { isServicePlanError, ServicePlanError, type ServicePlanErrorCode } from './errors.js';
import type {
  ByokPlanEntitlementRequestContext,
  ByokPlanEntitlementResolveOptions,
  ByokPlanEntitlementResolver,
  ByokSubscriptionRecord,
  CreateServicePlanOrderInput,
  EffectiveByokEntitlement,
  FulfilledServicePlanResult,
  ServicePlanDatabase,
  ServicePlanListInput,
  ServicePlanOperation,
  ServicePlanOrderRecord,
  ServicePlanOrderState,
  ServicePlanRecord,
  ServicePlanServiceOptions,
  ServicePlanSnapshotRecord,
  ServicePlanStatus,
  ServicePlanVersionRecord,
  VerifiedServicePlanFulfillmentInput,
} from './types.js';

const MAX_TEXT_LENGTH = 512;
const MAX_SCOPE_COUNT = 256;
const MAX_SCOPE_LENGTH = 200;
const MAX_PLAN_NAME_LENGTH = 200;
const MAX_CLIENT_REQUEST_LENGTH = 512;
const MAX_TERM_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANAGEMENT_ROLES = new Set(['owner', 'admin', 'billing']);

type StoredTimestamp = string | Date;
type StoredInteger = string | number | bigint;

interface ServicePlanRow {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
}

interface PlanVersionRow {
  id: string;
  plan_id: string;
  version: StoredInteger;
  supply_mode: string;
  supply_profile_id: string;
  allowed_provider_ids: unknown;
  allowed_models: unknown;
  price_version: string;
  price_minor_units: StoredInteger;
  currency: string;
  term_days: StoredInteger;
  policy_version: string;
  status: string;
  created_at: StoredTimestamp;
  published_at: StoredTimestamp | null;
  retired_at: StoredTimestamp | null;
}

interface SnapshotRow {
  id: string;
  tenant_id: string;
  order_id: string;
  plan_version_id: string;
  plan_id: string;
  plan_version: StoredInteger;
  allowed_provider_ids: unknown;
  allowed_models: unknown;
  supply_mode: string;
  supply_profile_id: string;
  price_version: string;
  price_minor_units: StoredInteger;
  currency: string;
  term_days: StoredInteger;
  policy_version: string;
  snapshot_digest: string;
  created_at: StoredTimestamp;
}

interface OrderRow {
  id: string;
  tenant_id: string;
  project_id: string;
  plan_version_id: string;
  operation: string;
  renewal_of_subscription_id: string | null;
  client_request_id: string;
  state: string;
  subscription_id: string | null;
  verified_settlement_id: string | null;
  verified_provider_key: string | null;
  verified_merchant_id: string | null;
  verified_amount_minor_units: StoredInteger | null;
  verified_currency: string | null;
  fulfillment_reference: string | null;
  fulfillment_evidence_sha256: string | null;
  verified_at: StoredTimestamp | null;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  paid_at: StoredTimestamp | null;
  fulfilled_at: StoredTimestamp | null;
}

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  project_id: string;
  order_id: string;
  snapshot_id: string;
  entitlement_id: string;
  previous_subscription_id: string | null;
  operation: string;
  status: string;
  effective_at: StoredTimestamp;
  expires_at: StoredTimestamp;
  activated_at: StoredTimestamp | null;
  superseded_at: StoredTimestamp | null;
  expired_at: StoredTimestamp | null;
  cancelled_at: StoredTimestamp | null;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
}

interface ProfileRow {
  id: string;
  status: string;
  supply_mode: string;
  model_scopes: unknown;
  authz_version: StoredInteger;
}

interface EntitlementRow {
  id: string;
  tenant_id: string;
  project_id: string;
  supply_profile_id: string;
  supply_mode: string;
  status: string;
  model_scopes: unknown;
  authz_version: StoredInteger;
  effective_at: StoredTimestamp;
  expires_at: StoredTimestamp | null;
  superseded_at: StoredTimestamp | null;
  disabled_at: StoredTimestamp | null;
}

export interface ApplyApprovedServicePlanRefundEffectInput {
  readonly tenantId: string;
  readonly orderId: string;
  readonly projectId: string;
  readonly subscriptionId: string;
  readonly refundId: string;
  readonly effectRef: string;
  readonly refundPolicyVersion: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly cutoffAt: string;
  readonly actorId: string;
  readonly reasonCode: string;
}

export interface FinalizeServicePlanRefundEffectInput {
  readonly tenantId: string;
  readonly refundId: string;
  readonly effectRef: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly occurredAt: string;
}

export interface ServicePlanRefundEffectSource {
  readonly projectId: string;
  readonly subscriptionId: string;
  readonly snapshotId: string;
  readonly entitlementId: string;
  readonly servicePlanPolicyVersion: string;
}

interface RefundEffectOrderRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly state: string;
  readonly subscription_id: string | null;
  readonly snapshot_id: string;
  readonly snapshot_order_id: string;
  readonly snapshot_supply_mode: string;
  readonly snapshot_policy_version: string;
  readonly snapshot_price_minor_units: StoredInteger;
  readonly snapshot_currency: string;
}

interface RefundEffectSubscriptionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly order_id: string;
  readonly snapshot_id: string;
  readonly entitlement_id: string;
  readonly status: string;
  readonly effective_at: StoredTimestamp;
  readonly expires_at: StoredTimestamp;
}

interface RefundEffectEntitlementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly supply_mode: string;
  readonly status: string;
  readonly authz_version: StoredInteger;
  readonly effective_at: StoredTimestamp;
  readonly expires_at: StoredTimestamp | null;
  readonly superseded_at: StoredTimestamp | null;
  readonly disabled_at: StoredTimestamp | null;
  readonly source_type: string | null;
  readonly source_ref: string | null;
  readonly service_plan_snapshot_id: string | null;
}

interface RefundEffectRow {
  readonly effect_ref: string;
  readonly tenant_id: string;
  readonly refund_order_id: string;
  readonly project_id: string;
  readonly source_service_plan_order_id: string;
  readonly source_subscription_id: string;
  readonly source_snapshot_id: string;
  readonly source_entitlement_id: string;
  readonly refund_policy_version: string;
  readonly service_plan_policy_version: string;
  readonly amount_minor_units: StoredInteger;
  readonly currency: string;
  readonly cutoff_at: StoredTimestamp;
  readonly requested_by_user_id: string;
  readonly reason_code: string;
  readonly state: string;
  readonly suspended_authz_version: StoredInteger | null;
  readonly suspended_at: StoredTimestamp | null;
  readonly suspension_released_at: StoredTimestamp | null;
  readonly released_authz_version: StoredInteger | null;
  readonly request_audit_event_id: string;
  readonly outcome_audit_event_id: string | null;
  readonly created_at: StoredTimestamp;
  readonly updated_at: StoredTimestamp;
  readonly completed_at: StoredTimestamp | null;
}

const PLAN_COLUMNS = `
  id, slug, display_name, status, created_at, updated_at`;
const VERSION_COLUMNS = `
  id, plan_id, version, supply_mode, supply_profile_id, allowed_provider_ids,
  allowed_models, price_version, price_minor_units, currency, term_days,
  policy_version, status, created_at, published_at, retired_at`;
const SNAPSHOT_COLUMNS = `
  id, tenant_id, order_id, plan_version_id, plan_id, plan_version,
  allowed_provider_ids, allowed_models, supply_mode, supply_profile_id,
  price_version, price_minor_units, currency, term_days, policy_version,
  snapshot_digest, created_at`;
const ORDER_COLUMNS = `
  id, tenant_id, project_id, plan_version_id, operation,
  renewal_of_subscription_id, client_request_id, state, subscription_id,
  verified_settlement_id, verified_provider_key, verified_merchant_id,
  verified_amount_minor_units, verified_currency, fulfillment_reference,
  fulfillment_evidence_sha256, verified_at, created_at, updated_at, paid_at,
  fulfilled_at`;
const SUBSCRIPTION_COLUMNS = `
  id, tenant_id, project_id, order_id, snapshot_id, entitlement_id,
  previous_subscription_id, operation, status, effective_at, expires_at,
  activated_at, superseded_at, expired_at, cancelled_at, created_at, updated_at`;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function fail(code: ServicePlanErrorCode): never {
  throw new ServicePlanError(code);
}

function text(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') fail('INVALID_INPUT');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    fail('INVALID_INPUT');
  }
  return normalized;
}

function id(value: unknown): string {
  return text(value, 255);
}

function safeInteger(value: unknown, code: ServicePlanErrorCode = 'STORAGE_ERROR'): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1) fail(code);
  return numeric;
}

function minorUnits(value: unknown, allowZero = false): bigint {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    fail('INVALID_INPUT');
  }
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    try {
      parsed = BigInt(value);
    } catch {
      fail('INVALID_INPUT');
    }
  } else {
    fail('INVALID_INPUT');
  }
  if (parsed < 0n || parsed > MAX_MINOR_UNITS || (!allowZero && parsed === 0n)) fail('INVALID_INPUT');
  return parsed;
}

function storedMinorUnits(value: unknown): bigint {
  try {
    return minorUnits(value, true);
  } catch (error) {
    if (isServicePlanError(error)) fail('STORAGE_ERROR');
    fail('STORAGE_ERROR');
  }
}

function currency(value: unknown): string {
  const normalized = text(value, 3);
  if (!/^[A-Z]{3}$/.test(normalized)) fail('INVALID_INPUT');
  return normalized;
}

function storedCurrency(value: unknown): string {
  try {
    return currency(value);
  } catch (error) {
    if (isServicePlanError(error)) fail('STORAGE_ERROR');
    fail('STORAGE_ERROR');
  }
}

function timestamp(value: unknown, code: ServicePlanErrorCode = 'INVALID_INPUT'): string {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) fail(code);
  return parsed.toISOString();
}

function optionalTimestamp(value: unknown, code: ServicePlanErrorCode = 'STORAGE_ERROR'): string | null {
  return value === null || value === undefined ? null : timestamp(value, code);
}

function currentDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('STORAGE_ERROR');
  return new Date(value.getTime());
}

function addTermDays(start: Date, days: number): Date {
  const expiry = new Date(start.getTime() + days * DAY_MS);
  if (!Number.isFinite(expiry.getTime())) fail('STORAGE_ERROR');
  return expiry;
}

function scopeValues(value: unknown, code: ServicePlanErrorCode): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_COUNT) fail(code);
  const values = value.map((candidate) => text(candidate, MAX_SCOPE_LENGTH));
  if (new Set(values).size !== values.length) fail(code);
  return values;
}

function intersectScopes(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  const result = left.filter((value) => rightSet.has(value));
  if (result.length === 0) fail('ENTITLEMENT_UNAVAILABLE');
  return result;
}

function digestSnapshot(input: {
  readonly planVersionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly allowedProviderIds: readonly string[];
  readonly allowedModels: readonly string[];
  readonly supplyMode: 'byok';
  readonly supplyProfileId: string;
  readonly priceVersion: string;
  readonly priceMinorUnits: string;
  readonly currency: string;
  readonly termDays: number;
  readonly policyVersion: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.planVersionId,
        input.planId,
        input.planVersion,
        [...input.allowedProviderIds],
        [...input.allowedModels],
        input.supplyMode,
        input.supplyProfileId,
        input.priceVersion,
        input.priceMinorUnits,
        input.currency,
        input.termDays,
        input.policyVersion,
      ]),
    )
    .digest('hex');
}

function planStatus(value: unknown): ServicePlanStatus {
  if (value === 'draft' || value === 'published' || value === 'retired') return value;
  fail('STORAGE_ERROR');
}

function orderState(value: unknown): ServicePlanOrderState {
  if (
    value === 'pending' ||
    value === 'paid' ||
    value === 'fulfilling' ||
    value === 'fulfilled' ||
    value === 'cancelled' ||
    value === 'reconciliation_pending'
  ) {
    return value;
  }
  fail('STORAGE_ERROR');
}

function operation(value: unknown): ServicePlanOperation {
  if (value === 'activation' || value === 'renewal') return value;
  fail('STORAGE_ERROR');
}

function subscriptionStatus(value: unknown): ByokSubscriptionRecord['status'] {
  if (
    value === 'pending' ||
    value === 'active' ||
    value === 'superseded' ||
    value === 'expired' ||
    value === 'cancelled'
  ) {
    return value;
  }
  fail('STORAGE_ERROR');
}

function mapPlan(row: ServicePlanRow): ServicePlanRecord {
  const status = planStatus(row.status);
  return {
    id: id(row.id),
    slug: text(row.slug, 255),
    displayName: text(row.display_name, MAX_PLAN_NAME_LENGTH),
    status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapVersion(row: PlanVersionRow): ServicePlanVersionRecord {
  if (row.supply_mode !== 'byok') fail('STORAGE_ERROR');
  const version = safeInteger(row.version);
  const termDays = safeInteger(row.term_days);
  if (termDays > MAX_TERM_DAYS) fail('STORAGE_ERROR');
  return {
    id: id(row.id),
    planId: id(row.plan_id),
    version,
    supplyMode: 'byok',
    supplyProfileId: text(row.supply_profile_id, 255),
    allowedProviderIds: scopeValues(row.allowed_provider_ids, 'STORAGE_ERROR'),
    allowedModels: scopeValues(row.allowed_models, 'STORAGE_ERROR'),
    priceVersion: text(row.price_version, 255),
    priceMinorUnits: storedMinorUnits(row.price_minor_units).toString(),
    currency: storedCurrency(row.currency),
    termDays,
    policyVersion: text(row.policy_version, 255),
    status: planStatus(row.status),
    createdAt: timestamp(row.created_at),
    publishedAt: optionalTimestamp(row.published_at),
    retiredAt: optionalTimestamp(row.retired_at),
  };
}

function mapSnapshot(row: SnapshotRow): ServicePlanSnapshotRecord {
  if (
    row.supply_mode !== 'byok' ||
    typeof row.snapshot_digest !== 'string' ||
    !SHA256_PATTERN.test(row.snapshot_digest)
  ) {
    fail('STORAGE_ERROR');
  }
  const termDays = safeInteger(row.term_days);
  if (termDays > MAX_TERM_DAYS) fail('STORAGE_ERROR');
  const snapshot: ServicePlanSnapshotRecord = {
    id: id(row.id),
    tenantId: id(row.tenant_id),
    orderId: id(row.order_id),
    planVersionId: id(row.plan_version_id),
    planId: id(row.plan_id),
    planVersion: safeInteger(row.plan_version),
    allowedProviderIds: scopeValues(row.allowed_provider_ids, 'STORAGE_ERROR'),
    allowedModels: scopeValues(row.allowed_models, 'STORAGE_ERROR'),
    supplyMode: 'byok',
    supplyProfileId: text(row.supply_profile_id, 255),
    priceVersion: text(row.price_version, 255),
    priceMinorUnits: storedMinorUnits(row.price_minor_units).toString(),
    currency: storedCurrency(row.currency),
    termDays,
    policyVersion: text(row.policy_version, 255),
    snapshotDigest: row.snapshot_digest,
    createdAt: timestamp(row.created_at),
  };
  if (
    snapshot.snapshotDigest !==
    digestSnapshot({
      planVersionId: snapshot.planVersionId,
      planId: snapshot.planId,
      planVersion: snapshot.planVersion,
      allowedProviderIds: snapshot.allowedProviderIds,
      allowedModels: snapshot.allowedModels,
      supplyMode: snapshot.supplyMode,
      supplyProfileId: snapshot.supplyProfileId,
      priceVersion: snapshot.priceVersion,
      priceMinorUnits: snapshot.priceMinorUnits,
      currency: snapshot.currency,
      termDays: snapshot.termDays,
      policyVersion: snapshot.policyVersion,
    })
  ) {
    fail('STORAGE_ERROR');
  }
  return snapshot;
}

function mapOrder(row: OrderRow, snapshot: ServicePlanSnapshotRecord): ServicePlanOrderRecord {
  return {
    id: id(row.id),
    tenantId: id(row.tenant_id),
    projectId: id(row.project_id),
    planVersionId: id(row.plan_version_id),
    operation: operation(row.operation),
    renewalOfSubscriptionId: row.renewal_of_subscription_id === null ? null : id(row.renewal_of_subscription_id),
    clientRequestId: text(row.client_request_id, MAX_CLIENT_REQUEST_LENGTH),
    state: orderState(row.state),
    subscriptionId: row.subscription_id === null ? null : id(row.subscription_id),
    snapshot,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    paidAt: optionalTimestamp(row.paid_at),
    fulfilledAt: optionalTimestamp(row.fulfilled_at),
  };
}

function mapSubscription(row: SubscriptionRow, snapshot: ServicePlanSnapshotRecord): ByokSubscriptionRecord {
  if (row.tenant_id !== snapshot.tenantId || row.snapshot_id !== snapshot.id) fail('STORAGE_ERROR');
  return {
    id: id(row.id),
    tenantId: id(row.tenant_id),
    projectId: id(row.project_id),
    orderId: id(row.order_id),
    snapshotId: id(row.snapshot_id),
    entitlementId: id(row.entitlement_id),
    previousSubscriptionId: row.previous_subscription_id === null ? null : id(row.previous_subscription_id),
    operation: operation(row.operation),
    status: subscriptionStatus(row.status),
    effectiveAt: timestamp(row.effective_at),
    expiresAt: timestamp(row.expires_at),
    activatedAt: optionalTimestamp(row.activated_at),
    supersededAt: optionalTimestamp(row.superseded_at),
    expiredAt: optionalTimestamp(row.expired_at),
    cancelledAt: optionalTimestamp(row.cancelled_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    snapshot,
  };
}

function assertContext(context: TenantContext, manage: boolean): void {
  if (
    !context ||
    typeof context.userId !== 'string' ||
    context.userId.trim() === '' ||
    typeof context.tenantId !== 'string' ||
    context.tenantId.trim() === '' ||
    typeof context.projectId !== 'string' ||
    context.projectId.trim() === ''
  ) {
    fail('ACCESS_DENIED');
  }
  if (manage && (!MANAGEMENT_ROLES.has(context.tenantRole) || !MANAGEMENT_ROLES.has(context.projectRole))) {
    fail('ACCESS_DENIED');
  }
}

function assertRequestContext(context: ByokPlanEntitlementRequestContext): void {
  if (
    !context ||
    typeof context.tenantId !== 'string' ||
    context.tenantId.trim() === '' ||
    typeof context.projectId !== 'string' ||
    context.projectId.trim() === ''
  ) {
    fail('ACCESS_DENIED');
  }
}

function assertNoClientPaymentBoolean(input: unknown): void {
  if (
    input &&
    typeof input === 'object' &&
    (Object.hasOwn(input, 'paid') || Object.hasOwn(input, 'paymentSucceeded'))
  ) {
    fail('FULFILLMENT_REQUIRED');
  }
}

function normalizeFulfillment(input: VerifiedServicePlanFulfillmentInput): VerifiedServicePlanFulfillmentInput & {
  readonly amount: bigint;
  readonly normalizedCurrency: string;
  readonly verifiedAtIso: string;
} {
  if (!input || typeof input !== 'object') fail('FULFILLMENT_REQUIRED');
  assertNoClientPaymentBoolean(input);
  if (input.kind !== 'server_verified_service_plan_fulfillment') fail('FULFILLMENT_REQUIRED');
  const normalizedCurrency = currency(input.currency);
  const amount = minorUnits(input.amountMinorUnits);
  const evidence = text(input.fulfillmentEvidenceSha256, 64);
  if (!SHA256_PATTERN.test(evidence)) fail('FULFILLMENT_REQUIRED');
  const verifiedAtIso = timestamp(input.verifiedAt);
  return {
    ...input,
    orderId: id(input.orderId),
    tenantId: id(input.tenantId),
    projectId: id(input.projectId),
    settlementId: text(input.settlementId),
    providerKey: text(input.providerKey),
    merchantId: text(input.merchantId),
    amountMinorUnits: amount.toString(),
    currency: normalizedCurrency,
    fulfillmentReference: text(input.fulfillmentReference),
    fulfillmentEvidenceSha256: evidence,
    verifiedAt: verifiedAtIso,
    amount,
    normalizedCurrency,
    verifiedAtIso,
  };
}

export class ByokServicePlanService implements ByokPlanEntitlementResolver {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: ServicePlanDatabase,
    options: ServicePlanServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private async query<Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
    duplicateCode?: ServicePlanErrorCode,
  ): Promise<SqlResult<Row>> {
    try {
      return await executor.query<Row>(sql, values);
    } catch (error) {
      if (duplicateCode !== undefined && isUniqueViolation(error)) fail(duplicateCode);
      if (isServicePlanError(error)) throw error;
      fail('STORAGE_ERROR');
    }
  }

  private async fenceAuthorizationWriters(executor: SqlExecutor): Promise<void> {
    await this.query(executor, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
    await this.query(executor, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
  }

  private async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (isServicePlanError(error)) throw error;
      if (isUniqueViolation(error)) fail('ORDER_CONFLICT');
      fail('STORAGE_ERROR');
    }
  }

  private async audit(
    executor: SqlExecutor,
    tenantId: string,
    actorUserId: string | null,
    action: string,
    targetId: string,
    occurredAt: string,
  ): Promise<void> {
    await this.query(
      executor,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [this.idFactory(), tenantId, actorUserId, action, 'service_plan', targetId, occurredAt, 'saas_plans'],
    );
  }

  private async refundEffectAudit(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly actorId: string | null;
      readonly action: string;
      readonly effectRef: string;
      readonly occurredAt: string;
    },
  ): Promise<string> {
    const auditEventId = id(this.idFactory());
    await this.query(
      executor,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, $2, $3, $4, 'service_plan_refund_effect', $5, $6, 'saas_plans')`,
      [auditEventId, input.tenantId, input.actorId, input.action, input.effectRef, input.occurredAt],
    );
    return auditEventId;
  }

  private async lockRefundEffectOrder(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
  ): Promise<RefundEffectOrderRow> {
    const result = await this.query<RefundEffectOrderRow>(
      executor,
      `SELECT o.id, o.tenant_id, o.project_id, o.state, o.subscription_id,
              s.id AS snapshot_id, s.order_id AS snapshot_order_id,
              s.supply_mode AS snapshot_supply_mode, s.policy_version AS snapshot_policy_version,
              s.price_minor_units AS snapshot_price_minor_units, s.currency AS snapshot_currency
       FROM saas_service_plan_orders o
       JOIN saas_service_plan_snapshots s ON s.tenant_id = o.tenant_id AND s.order_id = o.id
       WHERE o.tenant_id = $1 AND o.id = $2
       FOR UPDATE OF o`,
      [tenantId, orderId],
    );
    if (result.rows.length !== 1) fail('ORDER_NOT_FOUND');
    const row = result.rows[0];
    if (row?.state !== 'fulfilled' || row.snapshot_order_id !== row.id || row.snapshot_supply_mode !== 'byok') {
      fail('ENTITLEMENT_UNAVAILABLE');
    }
    return row;
  }

  private async lockRefundEffectContext(
    executor: SqlExecutor,
    source: {
      readonly tenantId: string;
      readonly projectId: string;
      readonly orderId: string;
      readonly subscriptionId: string;
      readonly snapshotId: string;
      readonly entitlementId?: string;
    },
  ): Promise<{
    readonly subscription: RefundEffectSubscriptionRow;
    readonly entitlement: RefundEffectEntitlementRow;
    readonly servicePlanPolicyVersion: string;
  }> {
    const project = await this.query<{ readonly id: string }>(
      executor,
      `SELECT id FROM saas_projects WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [source.tenantId, source.projectId],
    );
    if (project.rows.length !== 1) fail('ENTITLEMENT_UNAVAILABLE');

    const subscriptions = await this.query<RefundEffectSubscriptionRow>(
      executor,
      `SELECT id, tenant_id, project_id, order_id, snapshot_id, entitlement_id,
              status, effective_at, expires_at
       FROM saas_service_plan_subscriptions
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND order_id = $4
       FOR UPDATE`,
      [source.tenantId, source.projectId, source.subscriptionId, source.orderId],
    );
    const subscription = subscriptions.rows[0];
    if (
      subscriptions.rows.length !== 1 ||
      !subscription ||
      subscription.snapshot_id !== source.snapshotId ||
      (source.entitlementId !== undefined && subscription.entitlement_id !== source.entitlementId) ||
      !['active', 'superseded', 'expired', 'cancelled'].includes(subscription.status)
    ) {
      fail('ENTITLEMENT_UNAVAILABLE');
    }

    const snapshots = await this.query<{
      readonly id: string;
      readonly tenant_id: string;
      readonly order_id: string;
      readonly supply_mode: string;
      readonly policy_version: string;
      readonly price_minor_units: StoredInteger;
      readonly currency: string;
    }>(
      executor,
      `SELECT id, tenant_id, order_id, supply_mode, policy_version, price_minor_units, currency
       FROM saas_service_plan_snapshots
       WHERE tenant_id = $1 AND id = $2 AND order_id = $3`,
      [source.tenantId, source.snapshotId, source.orderId],
    );
    const snapshot = snapshots.rows[0];
    if (snapshots.rows.length !== 1 || !snapshot || snapshot.supply_mode !== 'byok') {
      fail('ENTITLEMENT_UNAVAILABLE');
    }

    const entitlements = await this.query<RefundEffectEntitlementRow>(
      executor,
      `SELECT id, tenant_id, project_id, supply_mode, status, authz_version,
              effective_at, expires_at, superseded_at, disabled_at,
              source_type, source_ref, service_plan_snapshot_id
       FROM saas_project_entitlements
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3
       FOR UPDATE`,
      [source.tenantId, source.projectId, subscription.entitlement_id],
    );
    const entitlement = entitlements.rows[0];
    if (
      entitlements.rows.length !== 1 ||
      !entitlement ||
      entitlement.supply_mode !== 'byok' ||
      entitlement.source_type !== 'service_plan' ||
      entitlement.source_ref !== source.orderId ||
      entitlement.service_plan_snapshot_id !== source.snapshotId ||
      (entitlement.status !== 'active' && entitlement.status !== 'disabled' && entitlement.status !== 'superseded')
    ) {
      fail('ENTITLEMENT_UNAVAILABLE');
    }

    return {
      subscription,
      entitlement,
      servicePlanPolicyVersion: text(snapshot.policy_version),
    };
  }

  /**
   * Apply the approved refund's provisional access effect in the caller's
   * refund-creation transaction. The PSP is called only after that transaction
   * commits. Order is service-plan order -> project -> subscription -> immutable
   * snapshot read -> exact entitlement, matching plan lifecycle/admission order.
   */
  async applyApprovedRefundEntitlementEffect(
    executor: SqlExecutor,
    input: ApplyApprovedServicePlanRefundEffectInput,
  ): Promise<ServicePlanRefundEffectSource> {
    const tenantId = id(input.tenantId);
    const orderId = id(input.orderId);
    const expectedProjectId = id(input.projectId);
    const expectedSubscriptionId = id(input.subscriptionId);
    const refundId = id(input.refundId);
    const effectRef = id(input.effectRef);
    const policyVersion = text(input.refundPolicyVersion, 96);
    const amountMinorUnits = minorUnits(input.amountMinorUnits).toString();
    const currency = text(input.currency, 3);
    const cutoffAt = timestamp(input.cutoffAt);
    const actorId = id(input.actorId);
    const reasonCode = text(input.reasonCode, 96);
    if (!/^byok_cancel_only_v[1-9][0-9]*$/.test(policyVersion)) fail('INVALID_INPUT');
    if (!/^[A-Z]{3}$/.test(currency) || !/^[A-Z0-9][A-Z0-9._:-]{0,95}$/.test(reasonCode)) {
      fail('INVALID_INPUT');
    }

    await this.fenceAuthorizationWriters(executor);
    const order = await this.lockRefundEffectOrder(executor, tenantId, orderId);
    if (order.project_id !== expectedProjectId || order.subscription_id !== expectedSubscriptionId) {
      fail('ENTITLEMENT_UNAVAILABLE');
    }
    const context = await this.lockRefundEffectContext(executor, {
      tenantId,
      projectId: order.project_id,
      orderId,
      subscriptionId: expectedSubscriptionId,
      snapshotId: order.snapshot_id,
    });
    if (
      context.servicePlanPolicyVersion !== order.snapshot_policy_version ||
      currency !== order.snapshot_currency ||
      minorUnits(order.snapshot_price_minor_units, false) < BigInt(amountMinorUnits)
    ) {
      fail('ENTITLEMENT_UNAVAILABLE');
    }

    const sourceCanBecomeEffective =
      context.subscription.status === 'active' && context.entitlement.status === 'active';

    let state: 'provisionally_suspended' | 'not_suspended' = 'not_suspended';
    let suspendedAuthzVersion: StoredInteger | null = null;
    let suspendedAt: string | null = null;
    if (sourceCanBecomeEffective) {
      const entitlementVersion = safeInteger(context.entitlement.authz_version);
      if (entitlementVersion >= Number.MAX_SAFE_INTEGER) fail('STORAGE_ERROR');
      const suspended = await this.query<{ readonly authz_version: StoredInteger }>(
        executor,
        `UPDATE saas_project_entitlements
         SET status = 'disabled', disabled_at = $4,
             authz_version = authz_version + 1, updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           AND status = 'active' AND authz_version = $5
         RETURNING authz_version`,
        [tenantId, order.project_id, context.entitlement.id, cutoffAt, entitlementVersion],
      );
      if (suspended.rows.length !== 1 || !suspended.rows[0]) fail('ENTITLEMENT_UNAVAILABLE');
      state = 'provisionally_suspended';
      suspendedAuthzVersion = suspended.rows[0].authz_version;
      suspendedAt = cutoffAt;
    }

    const requestAuditEventId = await this.refundEffectAudit(executor, {
      tenantId,
      actorId,
      action:
        state === 'provisionally_suspended'
          ? 'service_plan.refund_effect.provisionally_suspended'
          : 'service_plan.refund_effect.no_active_access',
      effectRef,
      occurredAt: cutoffAt,
    });
    await this.query(
      executor,
      `INSERT INTO saas_refund_service_plan_effects
         (effect_ref, tenant_id, refund_order_id, project_id,
          source_service_plan_order_id, source_subscription_id, source_snapshot_id,
          source_entitlement_id, refund_policy_version, service_plan_policy_version,
          amount_minor_units, currency, cutoff_at, requested_by_user_id, reason_code,
          state, suspended_authz_version, suspended_at, request_audit_event_id,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $13, $13)`,
      [
        effectRef,
        tenantId,
        refundId,
        order.project_id,
        orderId,
        expectedSubscriptionId,
        order.snapshot_id,
        context.entitlement.id,
        policyVersion,
        context.servicePlanPolicyVersion,
        amountMinorUnits,
        currency,
        cutoffAt,
        actorId,
        reasonCode,
        state,
        suspendedAuthzVersion,
        suspendedAt,
        requestAuditEventId,
      ],
    );
    return {
      projectId: order.project_id,
      subscriptionId: expectedSubscriptionId,
      snapshotId: order.snapshot_id,
      entitlementId: context.entitlement.id,
      servicePlanPolicyVersion: context.servicePlanPolicyVersion,
    };
  }

  /**
   * Finalize an already verified PSP outcome in the caller's refund-state
   * transaction. Unknown and pending outcomes deliberately do not call this.
   */
  async finalizeRefundEntitlementEffect(
    executor: SqlExecutor,
    input: FinalizeServicePlanRefundEffectInput,
  ): Promise<void> {
    const tenantId = id(input.tenantId);
    const refundId = id(input.refundId);
    const effectRef = id(input.effectRef);
    const occurredAt = timestamp(input.occurredAt);
    await this.fenceAuthorizationWriters(executor);
    const initial = await this.query<RefundEffectRow>(
      executor,
      `SELECT * FROM saas_refund_service_plan_effects
       WHERE tenant_id = $1 AND refund_order_id = $2 AND effect_ref = $3`,
      [tenantId, refundId, effectRef],
    );
    const identity = initial.rows[0];
    if (initial.rows.length !== 1 || !identity) fail('ENTITLEMENT_UNAVAILABLE');

    const order = await this.lockRefundEffectOrder(executor, tenantId, identity.source_service_plan_order_id);
    if (
      order.project_id !== identity.project_id ||
      order.subscription_id !== identity.source_subscription_id ||
      order.snapshot_id !== identity.source_snapshot_id
    ) {
      fail('ENTITLEMENT_UNAVAILABLE');
    }
    const context = await this.lockRefundEffectContext(executor, {
      tenantId,
      projectId: identity.project_id,
      orderId: identity.source_service_plan_order_id,
      subscriptionId: identity.source_subscription_id,
      snapshotId: identity.source_snapshot_id,
      entitlementId: identity.source_entitlement_id,
    });
    if (context.servicePlanPolicyVersion !== identity.service_plan_policy_version) {
      fail('ENTITLEMENT_UNAVAILABLE');
    }

    const effects = await this.query<RefundEffectRow>(
      executor,
      `SELECT * FROM saas_refund_service_plan_effects
       WHERE tenant_id = $1 AND refund_order_id = $2 AND effect_ref = $3
       FOR UPDATE`,
      [tenantId, refundId, effectRef],
    );
    const effect = effects.rows[0];
    if (effects.rows.length !== 1 || !effect) fail('ENTITLEMENT_UNAVAILABLE');
    if (effect.state === 'succeeded' || effect.state === 'failed') {
      if (effect.state !== input.outcome) fail('ORDER_STATE_CONFLICT');
      return;
    }
    if (effect.state !== 'provisionally_suspended' && effect.state !== 'not_suspended') {
      fail('STORAGE_ERROR');
    }

    let releasedAt: string | null = null;
    let releasedAuthzVersion: StoredInteger | null = null;
    const nowMs = Date.parse(occurredAt);
    if (input.outcome === 'succeeded') {
      if (context.entitlement.status === 'active') {
        const entitlementVersion = safeInteger(context.entitlement.authz_version);
        if (entitlementVersion >= Number.MAX_SAFE_INTEGER) fail('STORAGE_ERROR');
        const disabled = await this.query(
          executor,
          `UPDATE saas_project_entitlements
           SET status = 'disabled', disabled_at = $4,
               authz_version = authz_version + 1, updated_at = $5
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3
             AND status = 'active' AND authz_version = $6
           RETURNING id, authz_version`,
          [
            tenantId,
            identity.project_id,
            identity.source_entitlement_id,
            timestamp(effect.cutoff_at, 'STORAGE_ERROR'),
            occurredAt,
            entitlementVersion,
          ],
        );
        if (disabled.rows.length !== 1) fail('ENTITLEMENT_UNAVAILABLE');
      } else if (context.entitlement.status !== 'disabled' && context.entitlement.status !== 'superseded') {
        fail('ENTITLEMENT_UNAVAILABLE');
      }
      if (context.subscription.status === 'active') {
        const cancelled = await this.query(
          executor,
          `UPDATE saas_service_plan_subscriptions
           SET status = 'cancelled', cancelled_at = $4, updated_at = $5
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
           RETURNING id`,
          [tenantId, identity.project_id, identity.source_subscription_id, effect.cutoff_at, occurredAt],
        );
        if (cancelled.rows.length !== 1) fail('SUBSCRIPTION_STATE_CONFLICT');
      }
    } else if (
      effect.state === 'provisionally_suspended' &&
      context.subscription.status === 'active' &&
      context.entitlement.status === 'disabled' &&
      effect.suspended_at !== null &&
      effect.suspended_authz_version !== null &&
      context.entitlement.disabled_at !== null &&
      timestamp(context.entitlement.disabled_at, 'STORAGE_ERROR') === timestamp(effect.suspended_at, 'STORAGE_ERROR') &&
      safeInteger(context.entitlement.authz_version) === safeInteger(effect.suspended_authz_version) &&
      Date.parse(timestamp(context.subscription.expires_at, 'STORAGE_ERROR')) > nowMs &&
      (context.entitlement.expires_at === null ||
        Date.parse(timestamp(context.entitlement.expires_at, 'STORAGE_ERROR')) > nowMs)
    ) {
      const otherSubscriptions = await this.query<{ readonly id: string }>(
        executor,
        `SELECT id FROM saas_service_plan_subscriptions
         WHERE tenant_id = $1 AND project_id = $2 AND status = 'active' AND id <> $3
         ORDER BY id LIMIT 1 FOR SHARE`,
        [tenantId, identity.project_id, identity.source_subscription_id],
      );
      const otherEntitlements = await this.query<{ readonly id: string }>(
        executor,
        `SELECT id FROM saas_project_entitlements
         WHERE tenant_id = $1 AND project_id = $2 AND supply_mode = 'byok'
           AND status = 'active' AND id <> $3
         ORDER BY id LIMIT 1 FOR SHARE`,
        [tenantId, identity.project_id, identity.source_entitlement_id],
      );
      if (otherSubscriptions.rows.length === 0 && otherEntitlements.rows.length === 0) {
        const restored = await this.query<{ readonly authz_version: StoredInteger }>(
          executor,
          `UPDATE saas_project_entitlements
           SET status = 'active', disabled_at = NULL,
               authz_version = authz_version + 1, updated_at = $4
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3
             AND status = 'disabled' AND disabled_at = $5 AND authz_version = $6
           RETURNING authz_version`,
          [
            tenantId,
            identity.project_id,
            identity.source_entitlement_id,
            occurredAt,
            timestamp(effect.suspended_at, 'STORAGE_ERROR'),
            safeInteger(effect.suspended_authz_version),
          ],
        );
        if (restored.rows.length === 1 && restored.rows[0]) {
          releasedAt = occurredAt;
          releasedAuthzVersion = restored.rows[0].authz_version;
        }
      }
    }

    const outcomeAuditEventId = await this.refundEffectAudit(executor, {
      tenantId,
      actorId: null,
      action: `service_plan.refund_effect.${input.outcome}`,
      effectRef,
      occurredAt,
    });
    const updated = await this.query(
      executor,
      `UPDATE saas_refund_service_plan_effects
       SET state = $4, suspension_released_at = $5, released_authz_version = $6,
           outcome_audit_event_id = $7, updated_at = $8, completed_at = $8
       WHERE tenant_id = $1 AND refund_order_id = $2 AND effect_ref = $3
         AND state IN ('provisionally_suspended', 'not_suspended')
       RETURNING effect_ref`,
      [tenantId, refundId, effectRef, input.outcome, releasedAt, releasedAuthzVersion, outcomeAuditEventId, occurredAt],
    );
    if (updated.rows.length !== 1) fail('ENTITLEMENT_UNAVAILABLE');
  }

  async listCatalog(input: ServicePlanListInput = {}): Promise<ServicePlanVersionRecord[]> {
    const includeRetired = input.includeRetired === true;
    const result = await this.query<PlanVersionRow>(
      this.database,
      `SELECT ${VERSION_COLUMNS}
       FROM saas_service_plan_versions
       WHERE status = 'published'${includeRetired ? " OR status = 'retired'" : ''}
       ORDER BY plan_id, version DESC, id`,
    );
    return result.rows.map(mapVersion);
  }

  async listPlans(): Promise<ServicePlanRecord[]> {
    const result = await this.query<ServicePlanRow>(
      this.database,
      `SELECT ${PLAN_COLUMNS}
       FROM saas_service_plans
       WHERE status = 'published'
       ORDER BY display_name, id`,
    );
    return result.rows.map(mapPlan);
  }

  private async findPlanVersion(
    executor: SqlExecutor,
    planVersionId: string,
    fenceForPurchase = false,
  ): Promise<ServicePlanVersionRecord | null> {
    if (fenceForPurchase) {
      // Version and plan rows have SELECT-only grants. Discover the immutable plan identity,
      // acquire its shared fence, then re-read both published states under that fence.
      const identity = await this.query<{ readonly plan_id: string }>(
        executor,
        `SELECT plan_id
         FROM saas_service_plan_versions
         WHERE id = $1
         LIMIT 1`,
        [planVersionId],
      );
      const planId = identity.rows[0]?.plan_id;
      if (!planId) return null;
      await this.query(
        executor,
        `SELECT pg_advisory_xact_lock_shared(
           hashtextextended(
             'saas_service_plan:' || encode(convert_to($1::text, 'UTF8'), 'hex'),
             0
           )
         )`,
        [planId],
      );
    }

    const result = await this.query<PlanVersionRow>(
      executor,
      `SELECT ${VERSION_COLUMNS}
       FROM saas_service_plan_versions
       WHERE id = $1
         AND status = 'published'
         AND EXISTS (
           SELECT 1 FROM saas_service_plans p
           WHERE p.id = saas_service_plan_versions.plan_id AND p.status = 'published'
         )
       LIMIT 1`,
      [planVersionId],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  private async findSnapshot(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
  ): Promise<ServicePlanSnapshotRecord | null> {
    // Snapshots are immutable history; transactional mutations lock the mutable order/subscription head.
    const result = await this.query<SnapshotRow>(
      executor,
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM saas_service_plan_snapshots
       WHERE tenant_id = $1 AND order_id = $2
       LIMIT 1`,
      [tenantId, orderId],
    );
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
  }

  private async findOrder(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
    forUpdate = false,
  ): Promise<{ readonly order: OrderRow; readonly snapshot: ServicePlanSnapshotRecord } | null> {
    const orderResult = await this.query<OrderRow>(
      executor,
      `SELECT ${ORDER_COLUMNS}
       FROM saas_service_plan_orders
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, orderId],
    );
    const order = orderResult.rows[0];
    if (!order) return null;
    const snapshot = await this.findSnapshot(executor, tenantId, order.id);
    if (!snapshot || snapshot.planVersionId !== order.plan_version_id) fail('STORAGE_ERROR');
    return { order, snapshot };
  }

  private async findOrderByClientRequest(
    executor: SqlExecutor,
    tenantId: string,
    clientRequestId: string,
    forUpdate = false,
  ): Promise<{ readonly order: OrderRow; readonly snapshot: ServicePlanSnapshotRecord } | null> {
    const result = await this.query<OrderRow>(
      executor,
      `SELECT ${ORDER_COLUMNS}
       FROM saas_service_plan_orders
       WHERE tenant_id = $1 AND client_request_id = $2
       LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, clientRequestId],
    );
    const order = result.rows[0];
    if (!order) return null;
    const snapshot = await this.findSnapshot(executor, tenantId, order.id);
    if (!snapshot || snapshot.planVersionId !== order.plan_version_id) fail('STORAGE_ERROR');
    return { order, snapshot };
  }

  private assertOrderReplay(
    order: ServicePlanOrderRecord,
    input: {
      readonly planVersionId: string;
      readonly operation: ServicePlanOperation;
      readonly previousId: string | null;
    },
  ): void {
    if (
      order.planVersionId !== input.planVersionId ||
      order.operation !== input.operation ||
      order.renewalOfSubscriptionId !== input.previousId
    ) {
      fail('ORDER_CONFLICT');
    }
  }

  async createOrder(context: TenantContext, input: CreateServicePlanOrderInput): Promise<ServicePlanOrderRecord> {
    assertContext(context, true);
    const planVersionId = id(input?.planVersionId);
    const clientRequestId = text(input?.clientRequestId, MAX_CLIENT_REQUEST_LENGTH);
    const requestedOperation = input?.operation ?? 'activation';
    if (requestedOperation !== 'activation' && requestedOperation !== 'renewal') fail('INVALID_INPUT');
    const previousId = input?.renewalOfSubscriptionId === undefined ? null : id(input.renewalOfSubscriptionId);
    if (requestedOperation === 'renewal' && previousId === null) fail('INVALID_INPUT');
    if (requestedOperation === 'activation' && previousId !== null) fail('INVALID_INPUT');

    return this.transaction(async (executor) => {
      const existing = await this.findOrderByClientRequest(executor, context.tenantId, clientRequestId, true);
      if (existing) {
        const mapped = mapOrder(existing.order, existing.snapshot);
        this.assertOrderReplay(mapped, {
          planVersionId,
          operation: requestedOperation,
          previousId,
        });
        if (mapped.projectId !== context.projectId) fail('ORDER_CONFLICT');
        return mapped;
      }

      const planVersion = await this.findPlanVersion(executor, planVersionId, true);
      if (!planVersion) fail('PLAN_VERSION_UNAVAILABLE');

      if (requestedOperation === 'renewal' && previousId !== null) {
        const previous = await this.findSubscriptionRow(executor, context, previousId, true);
        if (!previous || (previous.status !== 'active' && previous.status !== 'expired')) {
          fail('SUBSCRIPTION_STATE_CONFLICT');
        }
      }

      const active = await this.findActiveSubscription(executor, context, true);
      if (active && requestedOperation === 'activation') fail('ACTIVE_SUBSCRIPTION_EXISTS');
      if (active && requestedOperation === 'renewal' && active.id !== previousId) {
        fail('ACTIVE_SUBSCRIPTION_EXISTS');
      }

      const now = currentDate(this.now);
      const orderId = id(this.idFactory());
      const snapshotId = id(this.idFactory());
      const createdAt = now.toISOString();
      const snapshotDigest = digestSnapshot({
        planVersionId: planVersion.id,
        planId: planVersion.planId,
        planVersion: planVersion.version,
        allowedProviderIds: planVersion.allowedProviderIds,
        allowedModels: planVersion.allowedModels,
        supplyMode: planVersion.supplyMode,
        supplyProfileId: planVersion.supplyProfileId,
        priceVersion: planVersion.priceVersion,
        priceMinorUnits: planVersion.priceMinorUnits,
        currency: planVersion.currency,
        termDays: planVersion.termDays,
        policyVersion: planVersion.policyVersion,
      });
      const orderResult = await this.query<OrderRow>(
        executor,
        `INSERT INTO saas_service_plan_orders
           (id, tenant_id, project_id, plan_version_id, operation,
            renewal_of_subscription_id, client_request_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8)
         RETURNING ${ORDER_COLUMNS}`,
        [
          orderId,
          context.tenantId,
          context.projectId,
          planVersion.id,
          requestedOperation,
          previousId,
          clientRequestId,
          createdAt,
        ],
        'ORDER_CONFLICT',
      );
      const order = orderResult.rows[0];
      if (!order) fail('STORAGE_ERROR');

      const snapshotResult = await this.query<SnapshotRow>(
        executor,
        `INSERT INTO saas_service_plan_snapshots
           (id, tenant_id, order_id, plan_version_id, plan_id, plan_version,
            allowed_provider_ids, allowed_models, supply_mode, supply_profile_id,
            price_version, price_minor_units, currency, term_days, policy_version,
            snapshot_digest, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING ${SNAPSHOT_COLUMNS}`,
        [
          snapshotId,
          context.tenantId,
          orderId,
          planVersion.id,
          planVersion.planId,
          planVersion.version,
          planVersion.allowedProviderIds,
          planVersion.allowedModels,
          planVersion.supplyMode,
          planVersion.supplyProfileId,
          planVersion.priceVersion,
          planVersion.priceMinorUnits,
          planVersion.currency,
          planVersion.termDays,
          planVersion.policyVersion,
          snapshotDigest,
          createdAt,
        ],
      );
      const snapshotRow = snapshotResult.rows[0];
      if (!snapshotRow) fail('STORAGE_ERROR');
      const snapshot = mapSnapshot(snapshotRow);
      await this.audit(executor, context.tenantId, context.userId, 'service_plan.order_created', orderId, createdAt);
      return mapOrder(order, snapshot);
    });
  }

  async getOrder(context: TenantContext, orderId: string): Promise<ServicePlanOrderRecord | null> {
    assertContext(context, false);
    const found = await this.findOrder(this.database, context.tenantId, id(orderId));
    if (!found) return null;
    if (found.order.project_id !== context.projectId) return null;
    return mapOrder(found.order, found.snapshot);
  }

  async listOrders(context: TenantContext): Promise<ServicePlanOrderRecord[]> {
    assertContext(context, false);
    const result = await this.query<OrderRow>(
      this.database,
      `SELECT ${ORDER_COLUMNS}
       FROM saas_service_plan_orders
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC, id DESC`,
      [context.tenantId, context.projectId],
    );
    const records: ServicePlanOrderRecord[] = [];
    for (const row of result.rows) {
      const snapshot = await this.findSnapshot(this.database, context.tenantId, row.id);
      if (!snapshot || snapshot.planVersionId !== row.plan_version_id) fail('STORAGE_ERROR');
      records.push(mapOrder(row, snapshot));
    }
    return records;
  }

  private async findSubscriptionRow(
    executor: SqlExecutor,
    context: Pick<TenantContext, 'tenantId' | 'projectId'>,
    subscriptionId: string,
    forUpdate = false,
  ): Promise<SubscriptionRow | null> {
    const result = await this.query<SubscriptionRow>(
      executor,
      `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM saas_service_plan_subscriptions
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3
       LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [context.tenantId, context.projectId, subscriptionId],
    );
    return result.rows[0] ?? null;
  }

  private async findActiveSubscription(
    executor: SqlExecutor,
    context: Pick<TenantContext, 'tenantId' | 'projectId'>,
    forUpdate = false,
  ): Promise<SubscriptionRow | null> {
    const result = await this.query<SubscriptionRow>(
      executor,
      `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM saas_service_plan_subscriptions
       WHERE tenant_id = $1 AND project_id = $2 AND status = 'active'
         AND effective_at <= $3 AND expires_at > $3
       ORDER BY effective_at DESC, id DESC
       LIMIT 2${forUpdate ? ' FOR UPDATE' : ''}`,
      [context.tenantId, context.projectId, currentDate(this.now).toISOString()],
    );
    if (result.rows.length > 1) fail('STORAGE_ERROR');
    return result.rows[0] ?? null;
  }

  private async findSubscriptionWithSnapshot(
    executor: SqlExecutor,
    context: Pick<TenantContext, 'tenantId' | 'projectId'>,
    subscriptionId: string,
    forUpdate = false,
  ): Promise<{ readonly subscription: SubscriptionRow; readonly snapshot: ServicePlanSnapshotRecord } | null> {
    const subscription = await this.findSubscriptionRow(executor, context, subscriptionId, forUpdate);
    if (!subscription) return null;
    const snapshotResult = await this.query<SnapshotRow>(
      executor,
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM saas_service_plan_snapshots
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [context.tenantId, subscription.snapshot_id],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) fail('STORAGE_ERROR');
    return { subscription, snapshot: mapSnapshot(snapshot) };
  }

  async getSubscription(context: TenantContext, subscriptionId: string): Promise<ByokSubscriptionRecord | null> {
    assertContext(context, false);
    const found = await this.findSubscriptionWithSnapshot(this.database, context, id(subscriptionId));
    return found ? mapSubscription(found.subscription, found.snapshot) : null;
  }

  async listSubscriptions(context: TenantContext): Promise<ByokSubscriptionRecord[]> {
    assertContext(context, false);
    const result = await this.query<SubscriptionRow>(
      this.database,
      `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM saas_service_plan_subscriptions
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY effective_at DESC, id DESC`,
      [context.tenantId, context.projectId],
    );
    const records: ByokSubscriptionRecord[] = [];
    for (const row of result.rows) {
      const snapshotResult = await this.query<SnapshotRow>(
        this.database,
        `SELECT ${SNAPSHOT_COLUMNS}
         FROM saas_service_plan_snapshots
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [context.tenantId, row.snapshot_id],
      );
      const snapshot = snapshotResult.rows[0];
      if (!snapshot) fail('STORAGE_ERROR');
      records.push(mapSubscription(row, mapSnapshot(snapshot)));
    }
    return records;
  }

  /**
   * Fulfill only from a server-verified settlement.  This method is not
   * called by the customer HTTP handler and has no boolean payment shortcut.
   */
  async fulfillVerified(input: VerifiedServicePlanFulfillmentInput): Promise<FulfilledServicePlanResult> {
    const proof = normalizeFulfillment(input);
    return this.transaction(async (executor) => {
      await this.fenceAuthorizationWriters(executor);
      const found = await this.findOrder(executor, proof.tenantId, proof.orderId, true);
      if (!found) fail('ORDER_NOT_FOUND');
      if (found.order.project_id !== proof.projectId) fail('FULFILLMENT_CONFLICT');
      const snapshot = found.snapshot;
      if (
        proof.amount !== storedMinorUnits(snapshot.priceMinorUnits) ||
        proof.normalizedCurrency !== snapshot.currency
      ) {
        fail('FULFILLMENT_CONFLICT');
      }

      if (found.order.state === 'fulfilled') {
        if (
          found.order.verified_settlement_id !== proof.settlementId ||
          found.order.fulfillment_reference !== proof.fulfillmentReference ||
          storedMinorUnits(found.order.verified_amount_minor_units) !== proof.amount ||
          found.order.verified_currency !== proof.normalizedCurrency
        ) {
          fail('FULFILLMENT_CONFLICT');
        }
        const subscription = await this.findSubscriptionWithSnapshot(
          executor,
          { tenantId: proof.tenantId, projectId: proof.projectId },
          id(found.order.subscription_id),
        );
        if (!subscription) fail('STORAGE_ERROR');
        return {
          order: mapOrder(found.order, snapshot),
          subscription: mapSubscription(subscription.subscription, subscription.snapshot),
          entitlementId: subscription.subscription.entitlement_id,
          replayed: true,
        };
      }
      if (found.order.state === 'cancelled' || found.order.state === 'reconciliation_pending') {
        fail('ORDER_STATE_CONFLICT');
      }
      if (found.order.state !== 'pending' && found.order.state !== 'paid') {
        fail('ORDER_STATE_CONFLICT');
      }
      if (
        found.order.state !== 'pending' &&
        (found.order.verified_settlement_id !== proof.settlementId ||
          found.order.fulfillment_reference !== proof.fulfillmentReference)
      ) {
        fail('FULFILLMENT_CONFLICT');
      }

      const now = currentDate(this.now);
      const nowIso = now.toISOString();
      const previousId = found.order.renewal_of_subscription_id;
      const previous =
        previousId === null
          ? null
          : await this.findSubscriptionRow(
              executor,
              { tenantId: proof.tenantId, projectId: proof.projectId },
              previousId,
              true,
            );
      if (
        found.order.operation === 'renewal' &&
        (!previous || (previous.status !== 'active' && previous.status !== 'expired'))
      ) {
        fail('SUBSCRIPTION_STATE_CONFLICT');
      }
      if (found.order.operation === 'activation' && previousId !== null) fail('FULFILLMENT_CONFLICT');

      const active = await this.findActiveSubscription(
        executor,
        { tenantId: proof.tenantId, projectId: proof.projectId },
        true,
      );
      if (active && (found.order.operation === 'activation' || active.id !== previousId)) {
        fail('ACTIVE_SUBSCRIPTION_EXISTS');
      }

      // Profile rows are mutable policy facts with SELECT-only grants. Migration 048's profile
      // UPDATE trigger takes the matching exclusive fence; this read never tuple-locks the profile.
      await this.query(
        executor,
        `SELECT pg_advisory_xact_lock_shared(
           hashtextextended(
             'saas_supply_profile:' || encode(convert_to(($1::uuid)::text, 'UTF8'), 'hex') || ':' ||
               encode(convert_to($2::text, 'UTF8'), 'hex'),
             0
           )
         )`,
        [proof.tenantId, snapshot.supplyProfileId],
      );
      const profileResult = await this.query<ProfileRow>(
        executor,
        `SELECT id, status, supply_mode, model_scopes, authz_version
         FROM saas_supply_profiles
         WHERE tenant_id = $1 AND id = $2 AND supply_mode = 'byok'
         LIMIT 1`,
        [proof.tenantId, snapshot.supplyProfileId],
      );
      const profile = profileResult.rows[0];
      if (profile?.status !== 'active' || profile.supply_mode !== 'byok') {
        fail('ENTITLEMENT_UNAVAILABLE');
      }
      const profileScopes = scopeValues(profile.model_scopes, 'ENTITLEMENT_UNAVAILABLE');
      const modelScopes = intersectScopes(snapshot.allowedModels, profileScopes);

      if (found.order.state === 'pending') {
        const paid = await this.query<OrderRow>(
          executor,
          `UPDATE saas_service_plan_orders
           SET state = 'paid',
               verified_settlement_id = $3,
               verified_provider_key = $4,
               verified_merchant_id = $5,
               verified_amount_minor_units = $6,
               verified_currency = $7,
               fulfillment_reference = $8,
               fulfillment_evidence_sha256 = $9,
               verified_at = $10,
               paid_at = $10,
               updated_at = $10
           WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
           RETURNING ${ORDER_COLUMNS}`,
          [
            proof.tenantId,
            proof.orderId,
            proof.settlementId,
            proof.providerKey,
            proof.merchantId,
            proof.amount.toString(),
            proof.normalizedCurrency,
            proof.fulfillmentReference,
            proof.fulfillmentEvidenceSha256,
            proof.verifiedAtIso,
          ],
        );
        if (!paid.rows[0]) fail('ORDER_STATE_CONFLICT');
      }

      const fulfilling = await this.query<OrderRow>(
        executor,
        `UPDATE saas_service_plan_orders
         SET state = 'fulfilling', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND state = 'paid'
         RETURNING ${ORDER_COLUMNS}`,
        [proof.tenantId, proof.orderId, nowIso],
      );
      if (!fulfilling.rows[0]) fail('ORDER_STATE_CONFLICT');

      if (previous && previous.status === 'active') {
        const supersededEntitlement = await this.query<EntitlementRow>(
          executor,
          `UPDATE saas_project_entitlements
           SET status = 'superseded', superseded_at = $4,
               authz_version = authz_version + 1, updated_at = $4
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
           RETURNING id, tenant_id, project_id, supply_profile_id, supply_mode,
                     status, model_scopes, authz_version, effective_at, expires_at,
                     superseded_at, disabled_at`,
          [proof.tenantId, proof.projectId, previous.entitlement_id, nowIso],
        );
        if (!supersededEntitlement.rows[0]) fail('ENTITLEMENT_UNAVAILABLE');
        const supersededSubscription = await this.query<SubscriptionRow>(
          executor,
          `UPDATE saas_service_plan_subscriptions
           SET status = 'superseded', superseded_at = $4, updated_at = $4
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [proof.tenantId, proof.projectId, previous.id, nowIso],
        );
        if (!supersededSubscription.rows[0]) fail('SUBSCRIPTION_STATE_CONFLICT');
      }

      const entitlementId = id(this.idFactory());
      const subscriptionId = id(this.idFactory());
      const expiresAt = addTermDays(now, snapshot.termDays).toISOString();
      const entitlement = await this.query<EntitlementRow>(
        executor,
        `INSERT INTO saas_project_entitlements
           (id, tenant_id, project_id, supply_profile_id, supply_mode, status,
            model_scopes, authz_version, created_at, updated_at, last_audited_at,
            disabled_at, effective_at, expires_at, superseded_at, source_type,
            source_ref, service_plan_snapshot_id)
         VALUES ($1, $2, $3, $4, 'byok', 'active', $5, 1, $6, $6, $6,
                 NULL, $6, $7, NULL, 'service_plan', $8, $9)
         RETURNING id, tenant_id, project_id, supply_profile_id, supply_mode,
                   status, model_scopes, authz_version, effective_at, expires_at,
                   superseded_at, disabled_at`,
        [
          entitlementId,
          proof.tenantId,
          proof.projectId,
          snapshot.supplyProfileId,
          modelScopes,
          nowIso,
          expiresAt,
          proof.orderId,
          snapshot.id,
        ],
        'ACTIVE_SUBSCRIPTION_EXISTS',
      );
      if (!entitlement.rows[0]) fail('STORAGE_ERROR');

      const subscriptionResult = await this.query<SubscriptionRow>(
        executor,
        `INSERT INTO saas_service_plan_subscriptions
           (id, tenant_id, project_id, order_id, snapshot_id, entitlement_id,
            previous_subscription_id, operation, status, effective_at, expires_at,
            activated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $9, $9, $9)
         RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [
          subscriptionId,
          proof.tenantId,
          proof.projectId,
          proof.orderId,
          snapshot.id,
          entitlementId,
          previousId,
          found.order.operation,
          nowIso,
          expiresAt,
        ],
      );
      const subscription = subscriptionResult.rows[0];
      if (!subscription) fail('STORAGE_ERROR');

      const fulfilled = await this.query<OrderRow>(
        executor,
        `UPDATE saas_service_plan_orders
         SET state = 'fulfilled', subscription_id = $3, fulfilled_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND state = 'fulfilling'
         RETURNING ${ORDER_COLUMNS}`,
        [proof.tenantId, proof.orderId, subscriptionId, nowIso],
      );
      const fulfilledOrder = fulfilled.rows[0];
      if (!fulfilledOrder) fail('ORDER_STATE_CONFLICT');
      await this.audit(
        executor,
        proof.tenantId,
        null,
        found.order.operation === 'renewal' ? 'service_plan.renewed' : 'service_plan.activated',
        subscriptionId,
        nowIso,
      );
      return {
        order: mapOrder(fulfilledOrder, snapshot),
        subscription: mapSubscription(subscription, snapshot),
        entitlementId,
        replayed: false,
      };
    });
  }

  async cancelSubscription(context: TenantContext, subscriptionId: string): Promise<ByokSubscriptionRecord> {
    assertContext(context, true);
    const normalizedSubscriptionId = id(subscriptionId);
    return this.transaction(async (executor) => {
      await this.fenceAuthorizationWriters(executor);
      const found = await this.findSubscriptionWithSnapshot(executor, context, normalizedSubscriptionId, true);
      if (!found) fail('SUBSCRIPTION_NOT_FOUND');
      const subscription = found.subscription;
      if (subscription.status === 'cancelled' || subscription.status === 'expired') {
        return mapSubscription(subscription, found.snapshot);
      }
      if (subscription.status !== 'active') fail('SUBSCRIPTION_STATE_CONFLICT');

      const nowIso = currentDate(this.now).toISOString();
      const entitlement = await this.query<EntitlementRow>(
        executor,
        `UPDATE saas_project_entitlements
         SET status = 'disabled', disabled_at = $4,
             authz_version = authz_version + 1, updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           AND status = 'active' AND source_type = 'service_plan'
         RETURNING id, tenant_id, project_id, supply_profile_id, supply_mode,
                   status, model_scopes, authz_version, effective_at, expires_at,
                   superseded_at, disabled_at`,
        [context.tenantId, context.projectId, subscription.entitlement_id, nowIso],
      );
      if (!entitlement.rows[0]) fail('ENTITLEMENT_UNAVAILABLE');

      const cancelled = await this.query<SubscriptionRow>(
        executor,
        `UPDATE saas_service_plan_subscriptions
         SET status = 'cancelled', cancelled_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
         RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [context.tenantId, context.projectId, normalizedSubscriptionId, nowIso],
      );
      const row = cancelled.rows[0];
      if (!row) fail('SUBSCRIPTION_STATE_CONFLICT');
      await this.audit(
        executor,
        context.tenantId,
        context.userId,
        'service_plan.cancelled',
        normalizedSubscriptionId,
        nowIso,
      );
      return mapSubscription(row, found.snapshot);
    });
  }

  async expireSubscription(
    tenantId: string,
    projectId: string,
    subscriptionId: string,
  ): Promise<ByokSubscriptionRecord> {
    const context = {
      tenantId: id(tenantId),
      projectId: id(projectId),
    };
    const normalizedSubscriptionId = id(subscriptionId);
    return this.transaction(async (executor) => {
      await this.fenceAuthorizationWriters(executor);
      const found = await this.findSubscriptionWithSnapshot(executor, context, normalizedSubscriptionId, true);
      if (!found) fail('SUBSCRIPTION_NOT_FOUND');
      const subscription = found.subscription;
      if (
        subscription.status === 'expired' ||
        subscription.status === 'cancelled' ||
        subscription.status === 'superseded'
      ) {
        return mapSubscription(subscription, found.snapshot);
      }
      if (subscription.status !== 'active') fail('SUBSCRIPTION_STATE_CONFLICT');
      const now = currentDate(this.now);
      if (new Date(timestamp(subscription.expires_at)).getTime() > now.getTime()) fail('SUBSCRIPTION_NOT_DUE');
      const nowIso = now.toISOString();
      const entitlement = await this.query<EntitlementRow>(
        executor,
        `UPDATE saas_project_entitlements
         SET status = 'disabled', disabled_at = $4,
             authz_version = authz_version + 1, updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           AND status = 'active' AND source_type = 'service_plan'
         RETURNING id, tenant_id, project_id, supply_profile_id, supply_mode,
                   status, model_scopes, authz_version, effective_at, expires_at,
                   superseded_at, disabled_at`,
        [context.tenantId, context.projectId, subscription.entitlement_id, nowIso],
      );
      if (!entitlement.rows[0]) fail('ENTITLEMENT_UNAVAILABLE');
      const expired = await this.query<SubscriptionRow>(
        executor,
        `UPDATE saas_service_plan_subscriptions
         SET status = 'expired', expired_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
         RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [context.tenantId, context.projectId, normalizedSubscriptionId, nowIso],
      );
      const row = expired.rows[0];
      if (!row) fail('SUBSCRIPTION_STATE_CONFLICT');
      await this.audit(executor, context.tenantId, null, 'service_plan.expired', normalizedSubscriptionId, nowIso);
      return mapSubscription(row, found.snapshot);
    });
  }

  async resolveCurrent(context: TenantContext): Promise<EffectiveByokEntitlement | null> {
    assertContext(context, false);
    return this.resolveEffective(context, undefined);
  }

  async resolveBound(context: TenantContext, entitlementId: string): Promise<EffectiveByokEntitlement | null> {
    assertContext(context, false);
    return this.resolveEffective(context, id(entitlementId));
  }

  async resolveBoundForRequest(
    context: ByokPlanEntitlementRequestContext,
    entitlementId: string,
    options: ByokPlanEntitlementResolveOptions = {},
  ): Promise<EffectiveByokEntitlement | null> {
    assertRequestContext(context);
    return this.resolveEffective(context, id(entitlementId), options);
  }

  private async resolveEffective(
    context: ByokPlanEntitlementRequestContext,
    entitlementId: string | undefined,
    options: ByokPlanEntitlementResolveOptions = {},
  ): Promise<EffectiveByokEntitlement | null> {
    const authorityNow = options.now === undefined ? currentDate(this.now) : new Date(options.now.getTime());
    if (!Number.isFinite(authorityNow.getTime())) fail('STORAGE_ERROR');
    const nowIso = authorityNow.toISOString();
    const executor = options.executor ?? this.database;
    const result = await this.query<
      EntitlementRow & {
        subscription_id: string;
        snapshot: SnapshotRow;
        profile_authz_version: StoredInteger;
      }
    >(
      executor,
      `SELECT e.id, e.tenant_id, e.project_id, e.supply_profile_id, e.supply_mode,
              e.status, e.model_scopes, e.authz_version, e.effective_at, e.expires_at,
              e.superseded_at, e.disabled_at, e.source_type, e.source_ref,
              e.service_plan_snapshot_id, s.id AS subscription_id,
              s.project_id AS subscription_project_id, s.order_id AS subscription_order_id,
              s.snapshot_id AS subscription_snapshot_id,
              s.status AS subscription_status, s.effective_at AS subscription_effective_at,
              s.expires_at AS subscription_expires_at, p.authz_version AS profile_authz_version,
              snap.id AS snapshot_id, snap.tenant_id AS snapshot_tenant_id,
              snap.order_id AS snapshot_order_id, snap.plan_version_id AS snapshot_plan_version_id,
              snap.plan_id AS snapshot_plan_id, snap.plan_version AS snapshot_plan_version,
              snap.allowed_provider_ids AS snapshot_allowed_provider_ids,
              snap.allowed_models AS snapshot_allowed_models, snap.supply_mode AS snapshot_supply_mode,
              snap.supply_profile_id AS snapshot_supply_profile_id,
              snap.price_version AS snapshot_price_version,
              snap.price_minor_units AS snapshot_price_minor_units,
              snap.currency AS snapshot_currency, snap.term_days AS snapshot_term_days,
              snap.policy_version AS snapshot_policy_version,
              snap.snapshot_digest AS snapshot_digest, snap.created_at AS snapshot_created_at
       FROM saas_project_entitlements e
       JOIN saas_service_plan_subscriptions s
         ON s.tenant_id = e.tenant_id AND s.project_id = e.project_id AND s.entitlement_id = e.id
       JOIN saas_service_plan_snapshots snap
         ON snap.tenant_id = s.tenant_id AND snap.id = s.snapshot_id
        AND snap.order_id = s.order_id
       JOIN saas_supply_profiles p
         ON p.tenant_id = e.tenant_id AND p.id = e.supply_profile_id AND p.supply_mode = e.supply_mode
       WHERE e.tenant_id = $1 AND e.project_id = $2 AND e.supply_mode = 'byok'
         AND e.source_type = 'service_plan'
         AND e.source_ref = snap.order_id::text
         AND e.service_plan_snapshot_id = snap.id
         AND snap.supply_mode = 'byok'
         AND snap.supply_profile_id = e.supply_profile_id
         AND e.status = 'active' AND s.status = 'active' AND p.status = 'active'
         AND e.effective_at <= $3 AND e.expires_at > $3
         AND s.effective_at <= $3 AND s.expires_at > $3
         ${entitlementId === undefined ? '' : 'AND e.id = $4'}
       LIMIT 2`,
      entitlementId === undefined
        ? [context.tenantId, context.projectId, nowIso]
        : [context.tenantId, context.projectId, nowIso, entitlementId],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length > 1) fail('STORAGE_ERROR');
    const row = result.rows[0];
    if (!row) fail('STORAGE_ERROR');
    const raw = row as unknown as Record<string, unknown>;
    if (
      raw.source_type !== 'service_plan' ||
      raw.source_ref !== raw.snapshot_order_id ||
      raw.service_plan_snapshot_id !== raw.snapshot_id ||
      raw.subscription_project_id !== row.project_id ||
      raw.subscription_order_id !== raw.snapshot_order_id ||
      raw.subscription_snapshot_id !== raw.snapshot_id ||
      raw.snapshot_tenant_id !== row.tenant_id ||
      raw.snapshot_supply_mode !== 'byok' ||
      raw.snapshot_supply_profile_id !== row.supply_profile_id
    ) {
      fail('STORAGE_ERROR');
    }
    const snapshot = mapSnapshot({
      id: String(raw.snapshot_id),
      tenant_id: String(raw.snapshot_tenant_id),
      order_id: String(raw.snapshot_order_id),
      plan_version_id: String(raw.snapshot_plan_version_id),
      plan_id: String(raw.snapshot_plan_id),
      plan_version: raw.snapshot_plan_version as StoredInteger,
      allowed_provider_ids: raw.snapshot_allowed_provider_ids,
      allowed_models: raw.snapshot_allowed_models,
      supply_mode: String(raw.snapshot_supply_mode),
      supply_profile_id: String(raw.snapshot_supply_profile_id),
      price_version: String(raw.snapshot_price_version),
      price_minor_units: raw.snapshot_price_minor_units as StoredInteger,
      currency: String(raw.snapshot_currency),
      term_days: raw.snapshot_term_days as StoredInteger,
      policy_version: String(raw.snapshot_policy_version),
      snapshot_digest: String(raw.snapshot_digest),
      created_at: raw.snapshot_created_at as StoredTimestamp,
    });
    const modelScopes = scopeValues(row.model_scopes, 'STORAGE_ERROR');
    const entitlementVersion = safeInteger(row.authz_version);
    const profileVersion = safeInteger(row.profile_authz_version);
    return {
      tenantId: id(row.tenant_id),
      projectId: id(row.project_id),
      entitlementId: id(row.id),
      subscriptionId: id(row.subscription_id),
      snapshot,
      allowedProviderIds: snapshot.allowedProviderIds,
      modelScopes,
      entitlementAuthzVersion: entitlementVersion,
      supplyProfileAuthzVersion: profileVersion,
      modelScopeVersion: Math.max(entitlementVersion, profileVersion),
    };
  }

  createServicePlanOrder(context: TenantContext, input: CreateServicePlanOrderInput): Promise<ServicePlanOrderRecord> {
    return this.createOrder(context, input);
  }

  fulfillServicePlanOrder(input: VerifiedServicePlanFulfillmentInput): Promise<FulfilledServicePlanResult> {
    return this.fulfillVerified(input);
  }

  cancelByokSubscription(context: TenantContext, subscriptionId: string): Promise<ByokSubscriptionRecord> {
    return this.cancelSubscription(context, subscriptionId);
  }
}

export { ByokServicePlanService as ServicePlanService };
