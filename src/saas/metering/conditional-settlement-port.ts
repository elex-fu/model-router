import { PlatformWalletLedgerService } from '../billing/service.js';
import type {
  BillingReservationResult,
  BillingTransactionExecutor,
  MarkReconciliationPendingInput,
  SettleBillingInput,
} from '../billing/types.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type {
  NormalSuccessTransactionInput,
  NormalSuccessTransactionPort,
  NormalSuccessTransactionResult,
  NormalSuccessUncertaintyInput,
} from '../gateway/dispatch-usage-settlement.js';
import { SaasMeteringService } from './service.js';
import type {
  AttemptRecord,
  AttemptTransitionInput,
  FinancialTransitionInput,
  MeteringOperationOptions,
  NormalizedUsageExact,
  RecordUsageEventInput,
  RecordUsageSettlementInput,
  RequestRecord,
  RequestTransitionInput,
  UsageEventRecord,
  UsageSettlementRecord,
  UsageValues,
} from './types.js';
import type {
  ConditionalSettlementInput,
  ConditionalSettlementPort,
  ConditionalSettlementResult,
  CustomerCharge,
} from './unknown-outcome-reconciliation-service.js';

export type {
  ConditionalSettlementInput,
  ConditionalSettlementPort,
  ConditionalSettlementResult,
  CustomerCharge,
} from './unknown-outcome-reconciliation-service.js';

const RESERVATION_NAMESPACE = 'saas.billing.reservation';
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

/**
 * The adapter depends on the narrow service surfaces it composes.  The
 * production defaults below are the real services; the seam also makes the
 * transaction boundary testable without a PostgreSQL connection.
 */
export interface ConditionalSettlementMetering {
  recordUsageEvent(input: RecordUsageEventInput, options?: MeteringOperationOptions): Promise<UsageEventRecord>;
  createUsageSettlement(
    input: RecordUsageSettlementInput,
    options?: MeteringOperationOptions,
  ): Promise<UsageSettlementRecord>;
  transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord>;
  transitionRequest(input: RequestTransitionInput): Promise<RequestRecord>;
  transitionFinancialStatus(input: FinancialTransitionInput): Promise<RequestRecord>;
}

export interface ConditionalSettlementBilling {
  settle(executor: BillingTransactionExecutor, input: SettleBillingInput): Promise<BillingReservationResult>;
  markReconciliationPending(
    executor: BillingTransactionExecutor,
    input: MarkReconciliationPendingInput,
  ): Promise<BillingReservationResult>;
}

export interface ConditionalSettlementPortOptions {
  readonly metering?: ConditionalSettlementMetering;
  readonly billing?: ConditionalSettlementBilling;
  /** Aliases useful to callers that name dependencies explicitly. */
  readonly meteringService?: ConditionalSettlementMetering;
  readonly billingService?: ConditionalSettlementBilling;
}

interface NormalSuccessStateRow {
  readonly attempt_id: unknown;
  readonly attempt_tenant_id: unknown;
  readonly attempt_request_id: unknown;
  readonly attempt_dispatch_state: unknown;
  readonly attempt_result_state: unknown;
  readonly attempt_response_started: unknown;
  readonly attempt_state_version: unknown;
  readonly attempt_binding_state: unknown;
  readonly attempt_dispatch_authority_state: unknown;
  readonly attempt_customer_price_version: unknown;
  readonly attempt_provider_id: unknown;
  readonly attempt_product_id: unknown;
  readonly attempt_public_model_id: unknown;
  readonly attempt_public_model_version: unknown;
  readonly request_id: unknown;
  readonly request_tenant_id: unknown;
  readonly request_supply_mode: unknown;
  readonly request_customer_price_version: unknown;
  readonly request_result_state: unknown;
  readonly request_reconciliation_state: unknown;
  readonly request_financial_status: unknown;
  readonly request_state_version: unknown;
}

interface NormalSuccessHoldRow {
  readonly id: unknown;
  readonly currency: unknown;
  readonly state: unknown;
  readonly price_snapshot_ref: unknown;
}

function stateText(value: unknown): string | null {
  return text(value);
}

function stateVersion(value: unknown): number | null {
  const normalized = version(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalSuccessRequestIsTerminal(row: NormalSuccessStateRow, supplyMode: string): boolean {
  const executionIsTerminal =
    stateText(row.attempt_dispatch_state) === 'sent' &&
    stateText(row.attempt_result_state) === 'succeeded' &&
    stateText(row.request_result_state) === 'succeeded' &&
    stateText(row.request_reconciliation_state) === 'resolved';
  const financialStatus = stateText(row.request_financial_status);
  return (
    executionIsTerminal &&
    (supplyMode === 'platform'
      ? financialStatus === 'settled' || financialStatus === 'reconciliation_pending'
      : financialStatus === 'not_applicable')
  );
}

interface LockedStateRow {
  readonly attempt_id: unknown;
  readonly attempt_tenant_id: unknown;
  readonly attempt_request_id: unknown;
  readonly attempt_project_policy_version: unknown;
  readonly attempt_customer_price_version: unknown;
  readonly attempt_customer_metering_policy_id: unknown;
  readonly attempt_customer_metering_policy_version: unknown;
  readonly attempt_provider_metering_policy_id: unknown;
  readonly attempt_provider_metering_policy_version: unknown;
  readonly attempt_contract_attestation_id: unknown;
  readonly attempt_route_config_id: unknown;
  readonly attempt_route_config_version: unknown;
  readonly attempt_route_public_model_id: unknown;
  readonly attempt_route_public_model_version: unknown;
  readonly attempt_route_protocol: unknown;
  readonly attempt_route_target_mode: unknown;
  readonly upstream_id: unknown;
  readonly binding_state: unknown;
  readonly dispatch_authority_state: unknown;
  readonly account_owner_kind: unknown;
  readonly account_id: unknown;
  readonly provider_id: unknown;
  readonly product_id: unknown;
  readonly resolved_model: unknown;
  readonly attempt_protocol: unknown;
  readonly supplier_cost_version: unknown;
  readonly dispatch_profile_id: unknown;
  readonly supply_profile_authz_version: unknown;
  readonly credential_id: unknown;
  readonly credential_version: unknown;
  readonly credential_authz_version: unknown;
  readonly account_authz_version: unknown;
  readonly pool_id: unknown;
  readonly pool_authz_version: unknown;
  readonly pool_member_account_authz_version: unknown;
  readonly pool_member_authz_version: unknown;
  readonly pool_grant_authz_version: unknown;
  readonly pool_grant_profile_authz_version: unknown;
  readonly pool_grant_pool_authz_version: unknown;
  readonly profile_account_authz_version: unknown;
  readonly attempt_dispatch_state: unknown;
  readonly attempt_result_state: unknown;
  readonly response_started: unknown;
  readonly attempt_state_version: unknown;
  readonly request_id: unknown;
  readonly request_tenant_id: unknown;
  readonly request_project_policy_version: unknown;
  readonly supply_profile_id: unknown;
  readonly supply_profile_version: unknown;
  readonly supply_mode: unknown;
  readonly request_customer_price_version: unknown;
  readonly request_customer_metering_policy_id: unknown;
  readonly request_customer_metering_policy_version: unknown;
  readonly request_provider_metering_policy_id: unknown;
  readonly request_provider_metering_policy_version: unknown;
  readonly request_contract_attestation_id: unknown;
  readonly request_route_config_id: unknown;
  readonly request_route_config_version: unknown;
  readonly request_route_public_model_id: unknown;
  readonly request_route_public_model_version: unknown;
  readonly request_route_protocol: unknown;
  readonly request_route_target_mode: unknown;
  readonly route_upstream_id: unknown;
  readonly request_protocol: unknown;
  readonly request_result_state: unknown;
  readonly financial_status: unknown;
  readonly reconciliation_state: unknown;
  readonly request_state_version: unknown;
}

interface HoldRow {
  readonly id: unknown;
  readonly tenant_id: unknown;
  readonly request_id: unknown;
  readonly currency: unknown;
  readonly idempotency_namespace: unknown;
  readonly business_key: unknown;
  readonly amount_minor_units: unknown;
  readonly state: unknown;
  readonly price_snapshot_ref: unknown;
  readonly metadata_ref: unknown;
  readonly settlement_id: unknown;
  readonly settlement_amount_minor_units: unknown;
  readonly usage_evidence_ref: unknown;
}

interface NormalizedSettlement {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly providerOperationId: string;
  readonly usage: NormalizedUsageExact;
  readonly charge: CustomerCharge;
  readonly expected: ConditionalSettlementInput['expectedState'];
}

function text(value: unknown, maxLength = 512): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function version(value: unknown): string | null {
  if (typeof value === 'bigint') {
    return value >= 1n && value <= MAX_POSTGRES_BIGINT ? value.toString(10) : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  try {
    const parsed = BigInt(value.trim());
    return parsed >= 1n && parsed <= MAX_POSTGRES_BIGINT ? parsed.toString(10) : null;
  } catch {
    return null;
  }
}

function token(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_POSTGRES_BIGINT ? value.toString(10) : undefined;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  try {
    const parsed = BigInt(value.trim());
    return parsed <= MAX_POSTGRES_BIGINT ? parsed.toString(10) : undefined;
  } catch {
    return undefined;
  }
}

function sameVersion(left: unknown, right: unknown): boolean {
  return version(left) !== null && version(left) === version(right);
}

function normalizeUsage(value: unknown): NormalizedUsageExact | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Partial<UsageValues>;
  if (
    usage.status !== 'reported' ||
    usage.source !== 'upstream' ||
    usage.measurementKind !== 'snapshot' ||
    usage.billableBasis !== 'exact'
  ) {
    return null;
  }
  const semanticsVersion = text(usage.semanticsVersion, 64);
  if (!semanticsVersion) return null;
  const values = [
    token(usage.inputTotal),
    token(usage.inputUncached),
    token(usage.cacheRead),
    token(usage.cacheWrite),
    token(usage.cacheWrite5m),
    token(usage.cacheWrite1h),
    token(usage.outputTotal),
    token(usage.reasoningOutput),
  ];
  if (values.some((value) => value === undefined)) return null;
  return {
    inputTotal: values[0] as string | null,
    inputUncached: values[1] as string | null,
    cacheRead: values[2] as string | null,
    cacheWrite: values[3] as string | null,
    cacheWrite5m: values[4] as string | null,
    cacheWrite1h: values[5] as string | null,
    outputTotal: values[6] as string | null,
    reasoningOutput: values[7] as string | null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion,
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
}

function normalizeCharge(value: unknown): CustomerCharge | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const charge = value as Partial<CustomerCharge>;
  if (
    typeof charge.amountMinorUnits !== 'string' ||
    !/^\d+$/.test(charge.amountMinorUnits) ||
    charge.amountMinorUnits !== BigInt(charge.amountMinorUnits).toString(10)
  ) {
    return null;
  }
  const amount = BigInt(charge.amountMinorUnits);
  if (amount > MAX_POSTGRES_BIGINT) return null;
  const currency = text(charge.currency, 3);
  const rateCardId = text(charge.rateCardId);
  const rateCardVersion = text(charge.rateCardVersion);
  if (!currency || !/^[A-Z]{3}$/.test(currency) || !rateCardId || !rateCardVersion) return null;
  return { amountMinorUnits: charge.amountMinorUnits, currency, rateCardId, rateCardVersion };
}

function normalizeExpectedState(value: unknown): ConditionalSettlementInput['expectedState'] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const expected = value as ConditionalSettlementInput['expectedState'];
  if (
    !expected.attempt ||
    !expected.request ||
    !version(expected.attempt.stateVersion) ||
    !version(expected.request.stateVersion) ||
    typeof expected.attempt.responseStarted !== 'boolean'
  ) {
    return null;
  }
  return expected;
}

function normalizeInput(input: ConditionalSettlementInput): NormalizedSettlement | null {
  const tenantId = text(input?.tenantId);
  const requestId = text(input?.requestId);
  const attemptId = text(input?.attemptId);
  const idempotencyKey = text(input?.idempotencyKey);
  const providerOperationId = text(input?.providerOperationId);
  const usage = normalizeUsage(input?.usage);
  const charge = normalizeCharge(input?.charge);
  const expected = normalizeExpectedState(input?.expectedState);
  if (
    !tenantId ||
    !requestId ||
    !attemptId ||
    !idempotencyKey ||
    !providerOperationId ||
    !usage ||
    !charge ||
    !expected
  ) {
    return null;
  }
  return { tenantId, requestId, attemptId, idempotencyKey, providerOperationId, usage, charge, expected };
}

function conflict(idempotencyKey?: string): ConditionalSettlementResult {
  return { status: 'conflict', ...(idempotencyKey ? { idempotencyKey } : {}) };
}

function rowText(row: LockedStateRow, key: keyof LockedStateRow): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : text(value);
}

function permissionAndIdentityMatch(row: LockedStateRow, input: NormalizedSettlement): boolean {
  const requiredText = [
    row.attempt_id,
    row.attempt_tenant_id,
    row.attempt_request_id,
    row.request_id,
    row.request_tenant_id,
    row.attempt_project_policy_version,
    row.request_project_policy_version,
    row.account_id,
    row.provider_id,
    row.product_id,
    row.upstream_id,
    row.resolved_model,
    row.attempt_protocol,
    row.request_protocol,
    row.dispatch_profile_id,
    row.supply_profile_authz_version,
    row.supply_profile_id,
    row.supply_profile_version,
    row.credential_id,
    row.credential_version,
    row.credential_authz_version,
    row.account_authz_version,
    row.attempt_customer_price_version,
    row.request_customer_price_version,
    row.request_route_config_id,
    row.request_route_config_version,
    row.request_route_public_model_id,
    row.request_route_public_model_version,
    row.request_route_protocol,
    row.request_route_target_mode,
    row.route_upstream_id,
    row.attempt_route_config_id,
    row.attempt_route_config_version,
    row.attempt_route_public_model_id,
    row.attempt_route_public_model_version,
    row.attempt_route_protocol,
    row.attempt_route_target_mode,
    row.attempt_customer_metering_policy_id,
    row.request_customer_metering_policy_id,
    row.attempt_customer_metering_policy_version,
    row.request_customer_metering_policy_version,
    row.attempt_provider_metering_policy_id,
    row.request_provider_metering_policy_id,
    row.attempt_provider_metering_policy_version,
    row.request_provider_metering_policy_version,
    row.attempt_contract_attestation_id,
    row.request_contract_attestation_id,
    row.supplier_cost_version,
  ];
  if (requiredText.some((value) => text(value) === null)) return false;

  if (
    rowText(row, 'attempt_tenant_id') !== input.tenantId ||
    rowText(row, 'request_tenant_id') !== input.tenantId ||
    rowText(row, 'attempt_request_id') !== input.requestId ||
    rowText(row, 'request_id') !== input.requestId ||
    rowText(row, 'attempt_id') !== input.attemptId ||
    rowText(row, 'supply_mode') !== 'platform' ||
    rowText(row, 'binding_state') !== 'bound' ||
    rowText(row, 'dispatch_authority_state') !== 'bound' ||
    rowText(row, 'account_owner_kind') !== 'platform' ||
    rowText(row, 'request_route_target_mode') !== 'platform_pool' ||
    rowText(row, 'attempt_route_target_mode') !== 'platform_pool' ||
    rowText(row, 'attempt_protocol') !== rowText(row, 'request_protocol') ||
    rowText(row, 'attempt_route_protocol') !== rowText(row, 'request_route_protocol') ||
    rowText(row, 'route_upstream_id') !== rowText(row, 'upstream_id') ||
    rowText(row, 'supply_profile_id') !== rowText(row, 'dispatch_profile_id') ||
    rowText(row, 'request_project_policy_version') !== rowText(row, 'attempt_project_policy_version') ||
    rowText(row, 'request_customer_price_version') !== rowText(row, 'attempt_customer_price_version') ||
    rowText(row, 'request_customer_metering_policy_id') !== rowText(row, 'attempt_customer_metering_policy_id') ||
    rowText(row, 'request_customer_metering_policy_version') !==
      rowText(row, 'attempt_customer_metering_policy_version') ||
    rowText(row, 'request_provider_metering_policy_id') !== rowText(row, 'attempt_provider_metering_policy_id') ||
    rowText(row, 'request_provider_metering_policy_version') !==
      rowText(row, 'attempt_provider_metering_policy_version') ||
    rowText(row, 'request_contract_attestation_id') !== rowText(row, 'attempt_contract_attestation_id') ||
    !sameVersion(row.supply_profile_version, row.supply_profile_authz_version)
  ) {
    return false;
  }

  const platformAuthorityVersions = [
    row.pool_id,
    row.pool_authz_version,
    row.pool_member_account_authz_version,
    row.pool_member_authz_version,
    row.pool_grant_authz_version,
    row.pool_grant_profile_authz_version,
    row.pool_grant_pool_authz_version,
  ];
  return platformAuthorityVersions.every((value) => text(value) !== null) && row.profile_account_authz_version === null;
}

function expectedStateMatches(row: LockedStateRow, input: NormalizedSettlement): boolean {
  const expected = input.expected;
  return (
    rowText(row, 'attempt_dispatch_state') === expected.attempt.dispatchState &&
    rowText(row, 'attempt_result_state') === expected.attempt.resultState &&
    row.response_started === expected.attempt.responseStarted &&
    sameVersion(row.attempt_state_version, expected.attempt.stateVersion) &&
    rowText(row, 'request_result_state') === expected.request.resultState &&
    rowText(row, 'reconciliation_state') === expected.request.reconciliationState &&
    rowText(row, 'financial_status') === expected.request.financialStatus &&
    sameVersion(row.request_state_version, expected.request.stateVersion)
  );
}

function isTerminal(row: LockedStateRow): boolean {
  return (
    rowText(row, 'attempt_dispatch_state') === 'sent' &&
    rowText(row, 'attempt_result_state') === 'succeeded' &&
    rowText(row, 'request_result_state') === 'succeeded' &&
    rowText(row, 'reconciliation_state') === 'resolved' &&
    rowText(row, 'financial_status') === 'settled'
  );
}

function isReconcilableUnknown(row: LockedStateRow): boolean {
  return (
    rowText(row, 'attempt_dispatch_state') === 'unknown' &&
    rowText(row, 'attempt_result_state') === 'unknown' &&
    rowText(row, 'request_result_state') === 'unknown' &&
    rowText(row, 'reconciliation_state') === 'pending' &&
    (rowText(row, 'financial_status') === 'pending' || rowText(row, 'financial_status') === 'reconciliation_pending')
  );
}

function asRow<Row>(result: { rows: Row[] }): Row | null {
  return result.rows[0] ?? null;
}

async function one<Row>(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row | null> {
  return asRow(await executor.query<Row>(sql, values));
}

function admissionBusinessKey(tenantId: string, requestId: string): string {
  return `saas-request-admission:${tenantId}:${requestId}`;
}

export class DurableConditionalSettlementPort implements ConditionalSettlementPort {
  private readonly metering: ConditionalSettlementMetering;
  private readonly billing: ConditionalSettlementBilling;

  constructor(
    private readonly database: SaasDatabase,
    options: ConditionalSettlementPortOptions = {},
  ) {
    this.metering = options.metering ?? options.meteringService ?? new SaasMeteringService(database);
    this.billing = options.billing ?? options.billingService ?? new PlatformWalletLedgerService();
  }

  async submit(input: ConditionalSettlementInput): Promise<ConditionalSettlementResult> {
    const normalized = normalizeInput(input);
    if (!normalized) return conflict(text(input?.idempotencyKey) ?? undefined);

    try {
      return await this.database.transaction(async (tx) => {
        const locked = await one<LockedStateRow>(
          tx,
          `SELECT
             a.id AS attempt_id, a.tenant_id AS attempt_tenant_id, a.request_id AS attempt_request_id,
             a.project_policy_version AS attempt_project_policy_version,
             a.customer_price_version AS attempt_customer_price_version,
             a.customer_metering_policy_id AS attempt_customer_metering_policy_id,
             a.customer_metering_policy_version AS attempt_customer_metering_policy_version,
             a.provider_metering_policy_id AS attempt_provider_metering_policy_id,
             a.provider_metering_policy_version AS attempt_provider_metering_policy_version,
             a.contract_attestation_id AS attempt_contract_attestation_id,
             a.route_config_id AS attempt_route_config_id, a.route_config_version AS attempt_route_config_version,
             a.route_public_model_id AS attempt_route_public_model_id,
             a.route_public_model_version AS attempt_route_public_model_version,
             a.route_protocol AS attempt_route_protocol, a.route_target_mode AS attempt_route_target_mode,
             a.upstream_id, a.binding_state, a.dispatch_authority_state, a.account_owner_kind,
             a.account_id, a.provider_id, a.product_id, a.resolved_model, a.protocol AS attempt_protocol,
             a.supplier_cost_version, a.dispatch_profile_id, a.supply_profile_authz_version,
             a.credential_id, a.credential_version, a.credential_authz_version, a.account_authz_version,
             a.pool_id, a.pool_authz_version, a.pool_member_account_authz_version,
             a.pool_member_authz_version, a.pool_grant_authz_version, a.pool_grant_profile_authz_version,
             a.pool_grant_pool_authz_version, a.profile_account_authz_version,
             a.dispatch_state AS attempt_dispatch_state, a.result_state AS attempt_result_state,
             a.response_started, a.state_version AS attempt_state_version,
             r.id AS request_id, r.tenant_id AS request_tenant_id,
             r.project_policy_version AS request_project_policy_version, r.supply_profile_id,
             r.supply_profile_version, r.supply_mode, r.customer_price_version AS request_customer_price_version,
             r.customer_metering_policy_id AS request_customer_metering_policy_id,
             r.customer_metering_policy_version AS request_customer_metering_policy_version,
             r.provider_metering_policy_id AS request_provider_metering_policy_id,
             r.provider_metering_policy_version AS request_provider_metering_policy_version,
             r.contract_attestation_id AS request_contract_attestation_id,
             r.route_config_id AS request_route_config_id, r.route_config_version AS request_route_config_version,
             r.route_public_model_id AS request_route_public_model_id,
             r.route_public_model_version AS request_route_public_model_version,
             r.route_protocol AS request_route_protocol, r.route_target_mode AS request_route_target_mode,
             r.route_upstream_id, r.protocol AS request_protocol, r.execution_state AS request_result_state,
             r.financial_status, r.reconciliation_state, r.state_version AS request_state_version
           FROM saas_attempts a
           JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
           WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3
           FOR UPDATE OF a, r`,
          [normalized.tenantId, normalized.requestId, normalized.attemptId],
        );
        if (!locked || !permissionAndIdentityMatch(locked, normalized)) return conflict(normalized.idempotencyKey);
        if (rowText(locked, 'supply_mode') !== 'platform') return conflict(normalized.idempotencyKey);
        const terminal = isTerminal(locked);
        if (!terminal && (!isReconcilableUnknown(locked) || !expectedStateMatches(locked, normalized))) {
          return conflict(normalized.idempotencyKey);
        }

        const hold = await one<HoldRow>(
          tx,
          `SELECT id, tenant_id, request_id, currency, idempotency_namespace, business_key,
                  amount_minor_units, state, price_snapshot_ref, metadata_ref, settlement_id,
                  settlement_amount_minor_units, usage_evidence_ref
           FROM saas_billing_reservations
           WHERE tenant_id = $1 AND request_id = $2 AND idempotency_namespace = $3 AND business_key = $4
           `,
          [
            normalized.tenantId,
            normalized.requestId,
            RESERVATION_NAMESPACE,
            admissionBusinessKey(normalized.tenantId, normalized.requestId),
          ],
        );
        if (
          !hold ||
          text(hold.tenant_id) !== normalized.tenantId ||
          text(hold.request_id) !== normalized.requestId ||
          text(hold.idempotency_namespace) !== RESERVATION_NAMESPACE ||
          text(hold.business_key) !== admissionBusinessKey(normalized.tenantId, normalized.requestId) ||
          (hold.state !== 'reserved' && hold.state !== 'reconciliation_pending' && hold.state !== 'settled') ||
          text(hold.price_snapshot_ref) !== normalized.charge.rateCardId ||
          text(hold.currency) !== normalized.charge.currency
        ) {
          return conflict(normalized.idempotencyKey);
        }

        if (terminal && hold.state !== 'settled') return conflict(normalized.idempotencyKey);

        const usageEvent = await this.metering.recordUsageEvent(
          {
            tenantId: normalized.tenantId,
            requestId: normalized.requestId,
            attemptId: normalized.attemptId,
            supplyMode: 'platform',
            eventKey: normalized.idempotencyKey,
            usage: normalized.usage,
          },
          { executor: tx },
        );
        await this.metering.createUsageSettlement(
          {
            tenantId: normalized.tenantId,
            usageEventId: usageEvent.id,
            settlementKey: normalized.idempotencyKey,
            settlementKind: 'usage_recorded',
          },
          { executor: tx },
        );

        const settlement = await this.billing.settle(tx, {
          supplyMode: 'platform',
          tenantId: normalized.tenantId,
          requestId: normalized.requestId,
          currency: normalized.charge.currency,
          priceSnapshotRef: normalized.charge.rateCardId,
          settlementId: normalized.idempotencyKey,
          usageEvidenceRef: normalized.providerOperationId,
          reconciliationEvidenceRef: normalized.providerOperationId,
          businessKey: admissionBusinessKey(normalized.tenantId, normalized.requestId),
          idempotencyNamespace: RESERVATION_NAMESPACE,
          actualAmountMinorUnits: normalized.charge.amountMinorUnits,
        });

        if (settlement.state === 'reconciliation_pending') {
          await this.metering.transitionAttempt({
            tenantId: normalized.tenantId,
            requestId: normalized.requestId,
            attemptId: normalized.attemptId,
            expectedDispatchState: 'unknown',
            expectedResultState: 'unknown',
            expectedResponseStarted: normalized.expected.attempt.responseStarted,
            expectedStateVersion: Number(version(locked.attempt_state_version)),
            dispatchState: 'sent',
            resultState: 'succeeded',
            responseStarted: normalized.expected.attempt.responseStarted,
            unknownReason: null,
            executor: tx,
          });
          const request = await this.metering.transitionRequest({
            tenantId: normalized.tenantId,
            requestId: normalized.requestId,
            expectedResultState: 'unknown',
            expectedReconciliationState: 'pending',
            expectedStateVersion: Number(version(locked.request_state_version)),
            resultState: 'succeeded',
            reconciliationState: 'resolved',
            executor: tx,
          });
          if (rowText(locked, 'financial_status') === 'pending') {
            await this.metering.transitionFinancialStatus({
              tenantId: normalized.tenantId,
              requestId: normalized.requestId,
              expectedFinancialStatus: 'pending',
              financialStatus: 'reconciliation_pending',
              expectedStateVersion: request.stateVersion,
              executor: tx,
            });
          } else if (rowText(locked, 'financial_status') !== 'reconciliation_pending') {
            throw new Error('billing reconciliation state does not match the request financial state');
          }
          return conflict(normalized.idempotencyKey);
        }
        if (settlement.state !== 'settled') return conflict(normalized.idempotencyKey);
        if (terminal) {
          return {
            status: 'replayed',
            settlementId: normalized.idempotencyKey,
            idempotencyKey: normalized.idempotencyKey,
          };
        }

        await this.metering.transitionAttempt({
          tenantId: normalized.tenantId,
          requestId: normalized.requestId,
          attemptId: normalized.attemptId,
          expectedDispatchState: 'unknown',
          expectedResultState: 'unknown',
          expectedResponseStarted: normalized.expected.attempt.responseStarted,
          expectedStateVersion: Number(version(locked.attempt_state_version)),
          dispatchState: 'sent',
          resultState: 'succeeded',
          responseStarted: normalized.expected.attempt.responseStarted,
          unknownReason: null,
          executor: tx,
        });
        const request = await this.metering.transitionRequest({
          tenantId: normalized.tenantId,
          requestId: normalized.requestId,
          expectedResultState: 'unknown',
          expectedReconciliationState: 'pending',
          expectedStateVersion: Number(version(locked.request_state_version)),
          resultState: 'succeeded',
          reconciliationState: 'resolved',
          executor: tx,
        });
        await this.metering.transitionFinancialStatus({
          tenantId: normalized.tenantId,
          requestId: normalized.requestId,
          expectedFinancialStatus: normalized.expected.request.financialStatus,
          financialStatus: 'settled',
          expectedStateVersion: request.stateVersion,
          executor: tx,
        });
        return {
          status: 'settled',
          settlementId: normalized.idempotencyKey,
          idempotencyKey: normalized.idempotencyKey,
        };
      });
    } catch {
      return conflict(normalized.idempotencyKey);
    }
  }
}

/**
 * Normal dispatched success uses its own state contract. The legacy conditional
 * port above remains limited to reconciliable unknown attempts.
 */
export class DurableNormalSuccessSettlementPort implements NormalSuccessTransactionPort {
  private readonly metering: ConditionalSettlementMetering;
  private readonly billing: ConditionalSettlementBilling;

  constructor(
    private readonly database: SaasDatabase,
    options: ConditionalSettlementPortOptions = {},
  ) {
    this.metering = options.metering ?? options.meteringService ?? new SaasMeteringService(database);
    this.billing = options.billing ?? options.billingService ?? new PlatformWalletLedgerService();
  }

  async complete(input: NormalSuccessTransactionInput): Promise<NormalSuccessTransactionResult> {
    if (
      !input ||
      !text(input.tenantId) ||
      !text(input.requestId) ||
      !text(input.attemptId) ||
      !text(input.usageEventKey) ||
      !text(input.settlementKey) ||
      !/^[0-9a-f]{64}$/.test(input.usageEvidenceRef) ||
      input.responseStarted !== true ||
      input.usage.status !== 'reported' ||
      input.usage.source !== 'upstream' ||
      input.usage.measurementKind !== 'snapshot' ||
      input.usage.billableBasis !== 'exact'
    ) {
      throw new Error('normal-success settlement input is invalid');
    }
    if (input.supplyMode === 'platform') {
      if (
        !text(input.reservationId) ||
        !text(input.priceSnapshotRef) ||
        !/^[A-Z]{3}$/.test(input.currency ?? '') ||
        !/^(0|[1-9][0-9]*)$/.test(input.chargeAmountMinorUnits ?? '') ||
        !text(input.customerPriceVersion)
      ) {
        throw new Error('normal-success platform quote is incomplete');
      }
    } else if (
      input.supplyMode !== 'byok' ||
      input.reservationId !== null ||
      input.priceSnapshotRef !== null ||
      input.currency !== null ||
      input.chargeAmountMinorUnits !== null ||
      input.customerPriceVersion !== null
    ) {
      throw new Error('normal-success BYOK input contains wallet authority');
    }

    let replayed = false;
    const result = await this.database.transaction(async (tx): Promise<NormalSuccessTransactionResult | null> => {
      const state = await one<NormalSuccessStateRow>(
        tx,
        `SELECT a.id AS attempt_id, a.tenant_id AS attempt_tenant_id,
                a.request_id AS attempt_request_id, a.dispatch_state AS attempt_dispatch_state,
                a.result_state AS attempt_result_state, a.response_started AS attempt_response_started,
                a.state_version AS attempt_state_version, a.binding_state AS attempt_binding_state,
                a.dispatch_authority_state AS attempt_dispatch_authority_state,
                a.customer_price_version AS attempt_customer_price_version, a.provider_id AS attempt_provider_id,
                a.product_id AS attempt_product_id, a.route_public_model_id AS attempt_public_model_id,
                a.route_public_model_version AS attempt_public_model_version,
                r.id AS request_id, r.tenant_id AS request_tenant_id, r.supply_mode AS request_supply_mode,
                r.customer_price_version AS request_customer_price_version,
                r.execution_state AS request_result_state, r.reconciliation_state AS request_reconciliation_state,
                r.financial_status AS request_financial_status, r.state_version AS request_state_version
           FROM saas_attempts a
           JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
          WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3
          FOR UPDATE OF a, r`,
        [input.tenantId, input.requestId, input.attemptId],
      );
      if (
        !state ||
        stateText(state.attempt_tenant_id) !== input.tenantId ||
        stateText(state.attempt_request_id) !== input.requestId ||
        stateText(state.request_tenant_id) !== input.tenantId ||
        stateText(state.request_id) !== input.requestId ||
        stateText(state.request_supply_mode) !== input.supplyMode ||
        stateText(state.attempt_binding_state) !== 'bound' ||
        stateText(state.attempt_dispatch_authority_state) !== 'bound' ||
        stateText(state.attempt_customer_price_version) !== input.customerPriceVersion ||
        stateText(state.request_customer_price_version) !== input.customerPriceVersion
      ) {
        throw new Error('normal-success settlement identity does not match stored authority');
      }

      if (normalSuccessRequestIsTerminal(state, input.supplyMode)) {
        if (input.supplyMode === 'platform') {
          const settledHold = await one<NormalSuccessHoldRow>(
            tx,
            `SELECT id, currency, state, price_snapshot_ref
               FROM saas_billing_reservations
              WHERE tenant_id = $1 AND request_id = $2 AND idempotency_namespace = $3 AND business_key = $4
              `,
            [
              input.tenantId,
              input.requestId,
              RESERVATION_NAMESPACE,
              admissionBusinessKey(input.tenantId, input.requestId),
            ],
          );
          if (
            !settledHold ||
            stateText(settledHold.id) !== input.reservationId ||
            stateText(settledHold.state) !==
              (stateText(state.request_financial_status) === 'settled' ? 'settled' : 'reconciliation_pending') ||
            stateText(settledHold.price_snapshot_ref) !== input.priceSnapshotRef ||
            stateText(settledHold.currency) !== input.currency
          ) {
            throw new Error('normal-success replay does not match its settled hold');
          }
        }
        replayed = true;
        return null;
      }

      if (
        stateText(state.attempt_dispatch_state) !== 'sent' ||
        stateText(state.attempt_result_state) !== 'pending' ||
        state.attempt_response_started !== true ||
        stateText(state.request_result_state) !== 'pending' ||
        stateText(state.request_reconciliation_state) !== 'none' ||
        stateText(state.request_financial_status) !== (input.supplyMode === 'platform' ? 'pending' : 'not_applicable')
      ) {
        throw new Error('normal-success settlement requires a sent pending attempt');
      }

      if (input.supplyMode === 'platform') {
        if (
          stateText(state.attempt_provider_id) === null ||
          stateText(state.attempt_product_id) === null ||
          stateText(state.attempt_public_model_id) === null ||
          stateVersion(state.attempt_public_model_version) === null
        ) {
          throw new Error('normal-success price identity is not bound to the attempt');
        }
        const hold = await one<NormalSuccessHoldRow>(
          tx,
          `SELECT id, currency, state, price_snapshot_ref
             FROM saas_billing_reservations
            WHERE tenant_id = $1 AND request_id = $2 AND idempotency_namespace = $3 AND business_key = $4
            `,
          [
            input.tenantId,
            input.requestId,
            RESERVATION_NAMESPACE,
            admissionBusinessKey(input.tenantId, input.requestId),
          ],
        );
        if (
          !hold ||
          stateText(hold.id) !== input.reservationId ||
          stateText(hold.state) !== 'reserved' ||
          stateText(hold.currency) !== input.currency ||
          stateText(hold.price_snapshot_ref) !== input.priceSnapshotRef
        ) {
          throw new Error('normal-success charge does not match the reserved quote');
        }
      }

      const usageEvent = await this.metering.recordUsageEvent(
        {
          tenantId: input.tenantId,
          requestId: input.requestId,
          attemptId: input.attemptId,
          supplyMode: input.supplyMode,
          eventKey: input.usageEventKey,
          usage: input.usage,
        },
        { executor: tx },
      );
      await this.metering.createUsageSettlement(
        {
          tenantId: input.tenantId,
          usageEventId: usageEvent.id,
          settlementKey: input.settlementKey,
          settlementKind: 'usage_recorded',
        },
        { executor: tx },
      );

      let billingState: 'settled' | 'reconciliation_pending' | null = null;
      if (input.supplyMode === 'platform') {
        const billingResult = await this.billing.settle(tx, {
          supplyMode: 'platform',
          tenantId: input.tenantId,
          requestId: input.requestId,
          currency: input.currency as string,
          priceSnapshotRef: input.priceSnapshotRef as string,
          settlementId: input.settlementKey,
          usageEvidenceRef: input.usageEvidenceRef,
          businessKey: admissionBusinessKey(input.tenantId, input.requestId),
          idempotencyNamespace: RESERVATION_NAMESPACE,
          actualAmountMinorUnits: input.chargeAmountMinorUnits as string,
        });
        if (billingResult.state !== 'settled' && billingResult.state !== 'reconciliation_pending') {
          throw new Error('wallet settlement did not complete');
        }
        billingState = billingResult.state;
      }

      const stateVersionAttempt = stateVersion(state.attempt_state_version);
      const stateVersionRequest = stateVersion(state.request_state_version);
      if (stateVersionAttempt === null || stateVersionRequest === null) {
        throw new Error('normal-success state version is invalid');
      }
      const attempt = await this.metering.transitionAttempt({
        executor: tx,
        tenantId: input.tenantId,
        requestId: input.requestId,
        attemptId: input.attemptId,
        expectedDispatchState: 'sent',
        expectedResultState: 'pending',
        expectedResponseStarted: true,
        expectedStateVersion: stateVersionAttempt,
        dispatchState: 'sent',
        resultState: 'succeeded',
        responseStarted: true,
        unknownReason: null,
      });
      const reconciliationStarted = await this.metering.transitionRequest({
        executor: tx,
        tenantId: input.tenantId,
        requestId: input.requestId,
        expectedResultState: 'pending',
        expectedReconciliationState: 'none',
        expectedStateVersion: stateVersionRequest,
        resultState: 'pending',
        reconciliationState: 'pending',
      });
      const request = await this.metering.transitionRequest({
        executor: tx,
        tenantId: input.tenantId,
        requestId: input.requestId,
        expectedResultState: 'pending',
        expectedReconciliationState: 'pending',
        expectedStateVersion: reconciliationStarted.stateVersion,
        resultState: 'succeeded',
        reconciliationState: 'resolved',
      });
      if (input.supplyMode === 'platform') {
        await this.metering.transitionFinancialStatus({
          executor: tx,
          tenantId: input.tenantId,
          requestId: input.requestId,
          expectedFinancialStatus: 'pending',
          financialStatus: billingState as 'settled' | 'reconciliation_pending',
          expectedStateVersion: request.stateVersion,
        });
      }
      return {
        kind: billingState === 'reconciliation_pending' ? 'reconciliation_pending' : 'settled',
        attempt,
      };
    });

    if (result) return result;
    if (!replayed) throw new Error('normal-success settlement transaction returned no result');
    const getAttempt = (
      this.metering as ConditionalSettlementMetering & {
        getAttempt?: (tenantId: string, requestId: string, attemptId: string) => Promise<AttemptRecord | null>;
      }
    ).getAttempt;
    const attempt = await getAttempt?.call(this.metering, input.tenantId, input.requestId, input.attemptId);
    if (!attempt) throw new Error('normal-success replay attempt could not be read');
    return { kind: 'replayed', attempt };
  }

  async retainUnknown(input: NormalSuccessUncertaintyInput): Promise<AttemptRecord> {
    return this.database.transaction(async (tx) => {
      const state = await one<NormalSuccessStateRow>(
        tx,
        `SELECT a.id AS attempt_id, a.tenant_id AS attempt_tenant_id,
                a.request_id AS attempt_request_id, a.dispatch_state AS attempt_dispatch_state,
                a.result_state AS attempt_result_state, a.response_started AS attempt_response_started,
                a.state_version AS attempt_state_version, a.binding_state AS attempt_binding_state,
                a.dispatch_authority_state AS attempt_dispatch_authority_state,
                a.customer_price_version AS attempt_customer_price_version,
                a.provider_id AS attempt_provider_id, a.product_id AS attempt_product_id,
                a.route_public_model_id AS attempt_public_model_id,
                a.route_public_model_version AS attempt_public_model_version,
                r.id AS request_id, r.tenant_id AS request_tenant_id, r.supply_mode AS request_supply_mode,
                r.customer_price_version AS request_customer_price_version,
                r.execution_state AS request_result_state, r.reconciliation_state AS request_reconciliation_state,
                r.financial_status AS request_financial_status, r.state_version AS request_state_version
           FROM saas_attempts a
           JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
          WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3
          FOR UPDATE OF a, r`,
        [input.tenantId, input.requestId, input.attemptId],
      );
      if (
        !state ||
        stateText(state.attempt_tenant_id) !== input.tenantId ||
        stateText(state.attempt_request_id) !== input.requestId ||
        stateText(state.request_tenant_id) !== input.tenantId ||
        stateText(state.request_id) !== input.requestId ||
        stateText(state.request_supply_mode) !== input.supplyMode ||
        stateText(state.attempt_binding_state) !== 'bound' ||
        stateText(state.attempt_dispatch_authority_state) !== 'bound'
      ) {
        throw new Error('normal-success uncertainty identity does not match stored authority');
      }
      return this.markUnknownInTransaction(tx, state, input, input.reason).then((result) => result.attempt);
    });
  }

  private async markUnknownInTransaction(
    tx: SqlExecutor,
    state: NormalSuccessStateRow,
    input:
      | Pick<NormalSuccessTransactionInput, 'tenantId' | 'requestId' | 'attemptId' | 'supplyMode' | 'responseStarted'>
      | NormalSuccessUncertaintyInput,
    reason: string,
  ): Promise<Extract<NormalSuccessTransactionResult, { kind: 'reconciliation_pending' }>> {
    const attemptVersion = stateVersion(state.attempt_state_version);
    const requestVersion = stateVersion(state.request_state_version);
    if (attemptVersion === null || requestVersion === null) throw new Error('normal-success state version is invalid');
    const expectedDispatchState = stateText(state.attempt_dispatch_state);
    const expectedResultState = stateText(state.attempt_result_state);
    const expectedResponseStarted = state.attempt_response_started === true;
    if (
      !['dispatching', 'sent', 'unknown'].includes(expectedDispatchState ?? '') ||
      !['pending', 'unknown'].includes(expectedResultState ?? '') ||
      !['pending', 'unknown'].includes(stateText(state.request_result_state) ?? '')
    ) {
      throw new Error('normal-success uncertainty cannot replace a terminal attempt');
    }
    const attempt =
      expectedDispatchState === 'unknown' && expectedResultState === 'unknown'
        ? await this.readAttempt(input.tenantId, input.requestId, input.attemptId, tx)
        : await this.metering.transitionAttempt({
            executor: tx,
            tenantId: input.tenantId,
            requestId: input.requestId,
            attemptId: input.attemptId,
            expectedDispatchState: expectedDispatchState as 'dispatching' | 'sent' | 'unknown',
            expectedResultState: expectedResultState as 'pending' | 'unknown',
            expectedResponseStarted,
            expectedStateVersion: attemptVersion,
            dispatchState: 'unknown',
            resultState: 'unknown',
            responseStarted: expectedResponseStarted || input.responseStarted,
            unknownReason: reason,
          });
    let financialStateVersion = requestVersion;
    if (stateText(state.request_result_state) !== 'unknown') {
      const request = await this.metering.transitionRequest({
        executor: tx,
        tenantId: input.tenantId,
        requestId: input.requestId,
        expectedResultState: stateText(state.request_result_state) as 'pending' | 'unknown',
        expectedReconciliationState: stateText(state.request_reconciliation_state) as 'none' | 'pending',
        expectedStateVersion: requestVersion,
        resultState: 'unknown',
        reconciliationState: 'pending',
      });
      financialStateVersion = request.stateVersion;
    }
    if (input.supplyMode === 'platform' && stateText(state.request_financial_status) === 'pending') {
      await this.metering.transitionFinancialStatus({
        executor: tx,
        tenantId: input.tenantId,
        requestId: input.requestId,
        expectedFinancialStatus: 'pending',
        financialStatus: 'reconciliation_pending',
        expectedStateVersion: financialStateVersion,
      });
    }
    if (input.supplyMode === 'platform') {
      if (
        stateText(state.request_financial_status) !== 'pending' &&
        stateText(state.request_financial_status) !== 'reconciliation_pending'
      ) {
        throw new Error('unknown platform execution has an incompatible financial state');
      }
      const reservation = await this.billing.markReconciliationPending(tx, {
        supplyMode: 'platform',
        tenantId: input.tenantId,
        requestId: input.requestId,
        evidenceRef: `normal-success-unknown:${input.tenantId}:${input.requestId}:${input.attemptId}`,
        businessKey: admissionBusinessKey(input.tenantId, input.requestId),
        idempotencyNamespace: RESERVATION_NAMESPACE,
      });
      if (reservation.state !== 'reconciliation_pending') {
        throw new Error('unknown platform execution did not retain its billing hold');
      }
    }
    return { kind: 'reconciliation_pending', attempt };
  }

  private async readAttempt(
    tenantId: string,
    requestId: string,
    attemptId: string,
    executor?: SqlExecutor,
  ): Promise<AttemptRecord> {
    const getAttempt = (
      this.metering as ConditionalSettlementMetering & {
        getAttempt?: (
          tenantId: string,
          requestId: string,
          attemptId: string,
          options?: MeteringOperationOptions,
        ) => Promise<AttemptRecord | null>;
      }
    ).getAttempt;
    const attempt = await getAttempt?.call(this.metering, tenantId, requestId, attemptId, { executor });
    if (!attempt) throw new Error('normal-success attempt could not be read');
    return attempt;
  }
}

export const ConditionalSettlementPortAdapter = DurableConditionalSettlementPort;
export const SaasConditionalSettlementPort = DurableConditionalSettlementPort;
export const DurableConditionalSettlementAdapter = DurableConditionalSettlementPort;

export default DurableConditionalSettlementPort;
