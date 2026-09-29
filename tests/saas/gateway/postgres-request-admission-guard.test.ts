import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresRequestAdmissionGuard,
  PostgresRequestAdmissionGuardError,
} from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import type { AttemptRecord, RequestRecord } from '../../../src/saas/metering/types.js';

type Row = Record<string, unknown>;
const NOW = new Date('2026-09-28T00:00:00.000Z');
const EXPIRY = '2026-09-28T00:10:00.000Z';
const HASH = 'a'.repeat(64);

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface Fixture {
  rows: Record<string, Row | Row[]>;
  request: RequestRecord;
  attempt: AttemptRecord;
  customerPrice: Row;
  supplierCost: Row;
  snapshot: Row | null;
  statements: string[];
  fenceKeys: string[];
  providerCalls: number;
}

function priceRow(kind: 'customer' | 'supplier'): Row {
  return {
    id: kind === 'customer' ? 'price-v1' : 'supplier-v1',
    version: 1,
    public_model_id: 'public-model-a',
    public_model_version: 1,
    provider_id: 'provider-a',
    product_id: 'product-a',
    ...(kind === 'supplier' ? { resolved_model: 'model-a' } : {}),
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    currency: 'USD',
    commercial_policy_version: 'commercial-v1',
    calculator_version: 'calculator-v1',
    rounding_version: 'rounding-v1',
    rounding_mode: 'half_up',
    rounding_boundary: 'total',
    input_rate_numerator_minor_units: 1,
    input_rate_denominator_units: 1,
    cache_read_rate_numerator_minor_units: 1,
    cache_read_rate_denominator_units: 1,
    cache_write_rate_numerator_minor_units: 1,
    cache_write_rate_denominator_units: 1,
    cache_write_5m_rate_numerator_minor_units: 1,
    cache_write_5m_rate_denominator_units: 1,
    cache_write_1h_rate_numerator_minor_units: 1,
    cache_write_1h_rate_denominator_units: 1,
    output_rate_numerator_minor_units: 1,
    output_rate_denominator_units: 1,
    effective_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    idempotency_key: `${kind}-idempotency`,
    definition_digest: HASH,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeFixture(supplyMode: 'byok' | 'platform'): Fixture {
  const platform = supplyMode === 'platform';
  const accountId = platform ? 'platform-account-a' : 'tenant-account-a';
  const credentialId = platform ? 'platform-credential-a' : 'tenant-credential-a';
  const request: RequestRecord = {
    id: 'request-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: '1',
    modelScopeVersion: '1',
    supplyMode,
    principalKind: 'member',
    principalId: 'user-a',
    authzVersion: '1',
    entitlementVersion: '1',
    configVersion: '1',
    projectPolicyVersion: '1',
    customerMeteringPolicyId: 'customer-policy-a',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-a',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-a',
    routeConfigId: 'route-a',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-a',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: platform ? 'platform_pool' : 'tenant_account',
    routeUpstreamId: 'upstream-a',
    publicModel: 'model-a',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    requestFingerprint: HASH,
    requestFingerprintVersion: 'canonical-v1',
    idempotencyKeyDigest: null,
    customerPriceVersion: platform ? 'price-v1' : null,
    financialStatus: platform ? 'pending' : 'not_applicable',
    resultState: 'pending',
    reconciliationState: 'none',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    stateVersion: 1,
  };
  const attempt: AttemptRecord = {
    id: 'attempt-a',
    tenantId: 'tenant-a',
    requestId: request.id,
    projectPolicyVersion: '1',
    customerPriceVersion: request.customerPriceVersion,
    customerMeteringPolicyId: request.customerMeteringPolicyId,
    customerMeteringPolicyVersion: request.customerMeteringPolicyVersion,
    providerMeteringPolicyId: request.providerMeteringPolicyId,
    providerMeteringPolicyVersion: request.providerMeteringPolicyVersion,
    contractAttestationId: request.contractAttestationId,
    routeConfigId: request.routeConfigId,
    routeConfigVersion: request.routeConfigVersion,
    routePublicModelId: request.routePublicModelId,
    routePublicModelVersion: request.routePublicModelVersion,
    routeProtocol: request.routeProtocol,
    routeTargetMode: request.routeTargetMode,
    ordinal: 1,
    upstreamId: 'upstream-a',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: platform ? 'platform' : 'tenant',
    accountId,
    providerId: 'provider-a',
    productId: 'product-a',
    resolvedModel: 'model-a',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    supplierCostVersion: platform ? 'supplier-v1' : null,
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: '1',
    credentialId,
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: platform ? 'pool-a' : null,
    poolAuthzVersion: platform ? '1' : null,
    poolMemberAccountAuthzVersion: platform ? '1' : null,
    poolMemberAuthzVersion: platform ? '1' : null,
    poolGrantAuthzVersion: platform ? '1' : null,
    poolGrantProfileAuthzVersion: platform ? '1' : null,
    poolGrantPoolAuthzVersion: platform ? '1' : null,
    profileAccountAuthzVersion: platform ? null : '1',
    preparedEvidenceId: null,
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    stateVersion: 1,
  };

  const requestRow: Row = {
    id: request.id,
    tenant_id: request.tenantId,
    project_id: request.projectId,
    proxy_key_id: request.proxyKeyId,
    entitlement_id: request.entitlementId,
    entitlement_version: request.entitlementVersion,
    supply_profile_id: request.supplyProfileId,
    supply_profile_version: request.supplyProfileVersion,
    model_scope_version: request.modelScopeVersion,
    supply_mode: request.supplyMode,
    principal_kind: request.principalKind,
    principal_id: request.principalId,
    authz_version: request.authzVersion,
    config_version: request.configVersion,
    project_policy_version: request.projectPolicyVersion,
    public_model: request.publicModel,
    protocol: request.protocol,
    endpoint: request.endpoint,
    route_config_id: request.routeConfigId,
    route_config_version: request.routeConfigVersion,
    route_public_model_id: request.routePublicModelId,
    route_public_model_version: request.routePublicModelVersion,
    route_protocol: request.routeProtocol,
    route_target_mode: request.routeTargetMode,
    route_upstream_id: request.routeUpstreamId,
    customer_metering_policy_id: request.customerMeteringPolicyId,
    customer_metering_policy_version: request.customerMeteringPolicyVersion,
    provider_metering_policy_id: request.providerMeteringPolicyId,
    provider_metering_policy_version: request.providerMeteringPolicyVersion,
    contract_attestation_id: request.contractAttestationId,
    customer_price_version: request.customerPriceVersion,
  };
  const attemptRow: Row = {
    id: attempt.id,
    tenant_id: attempt.tenantId,
    request_id: attempt.requestId,
    project_policy_version: attempt.projectPolicyVersion,
    customer_price_version: attempt.customerPriceVersion,
    customer_metering_policy_id: attempt.customerMeteringPolicyId,
    customer_metering_policy_version: attempt.customerMeteringPolicyVersion,
    provider_metering_policy_id: attempt.providerMeteringPolicyId,
    provider_metering_policy_version: attempt.providerMeteringPolicyVersion,
    contract_attestation_id: attempt.contractAttestationId,
    route_config_id: attempt.routeConfigId,
    route_config_version: attempt.routeConfigVersion,
    route_public_model_id: attempt.routePublicModelId,
    route_public_model_version: attempt.routePublicModelVersion,
    route_protocol: attempt.routeProtocol,
    route_target_mode: attempt.routeTargetMode,
    ordinal: attempt.ordinal,
    upstream_id: attempt.upstreamId,
    account_owner_kind: attempt.accountOwnerKind,
    account_id: attempt.accountId,
    provider_id: attempt.providerId,
    product_id: attempt.productId,
    resolved_model: attempt.resolvedModel,
    protocol: attempt.protocol,
    endpoint: attempt.endpoint,
    supplier_cost_version: attempt.supplierCostVersion,
    dispatch_profile_id: attempt.dispatchProfileId,
    supply_profile_authz_version: attempt.supplyProfileAuthzVersion,
    credential_id: attempt.credentialId,
    credential_version: attempt.credentialVersion,
    credential_authz_version: attempt.credentialAuthzVersion,
    account_authz_version: attempt.accountAuthzVersion,
    pool_id: attempt.poolId,
    pool_authz_version: attempt.poolAuthzVersion,
    pool_member_account_authz_version: attempt.poolMemberAccountAuthzVersion,
    pool_member_authz_version: attempt.poolMemberAuthzVersion,
    pool_grant_authz_version: attempt.poolGrantAuthzVersion,
    pool_grant_profile_authz_version: attempt.poolGrantProfileAuthzVersion,
    pool_grant_pool_authz_version: attempt.poolGrantPoolAuthzVersion,
    profile_account_authz_version: attempt.profileAccountAuthzVersion,
    binding_state: attempt.bindingState,
    dispatch_authority_state: attempt.dispatchAuthorityState,
    dispatch_state: attempt.dispatchState,
  };
  const rights: Row = {
    rights_id: 'rights-a',
    version: 1,
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    supply_mode: supplyMode,
    region: 'us-east-1',
    purpose: 'inference',
    model_scope: ['model-a'],
    endpoint_scope: ['/v1/chat/completions'],
    effective_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    approval_ref: 'approval-a',
    status: 'active',
    evidence_ref: 'evidence-a',
    evidence_sha256: HASH,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const account: Row = {
    tenant_id: 'tenant-a',
    id: accountId,
    owner_kind: platform ? 'platform' : 'tenant',
    supply_mode: supplyMode,
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    region: 'us-east-1',
    purpose: 'inference',
    rights_id: 'rights-a',
    rights_version: 1,
    status: 'active',
    validation_state: 'verified',
    authz_version: 1,
    expires_at: null,
  };
  const credential: Row = {
    tenant_id: platform ? undefined : 'tenant-a',
    id: credentialId,
    owner_kind: platform ? 'platform' : 'tenant',
    supply_mode: supplyMode,
    account_id: accountId,
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    status: 'active',
    validation_state: 'verified',
    current_version: 1,
    authz_version: 1,
    expires_at: null,
  };
  const credentialVersion: Row = {
    tenant_id: platform ? undefined : 'tenant-a',
    account_id: accountId,
    credential_id: credentialId,
    version: 1,
    owner_kind: platform ? 'platform' : 'tenant',
    supply_mode: supplyMode,
    status: 'active',
    expires_at: null,
  };
  const customerPrice = priceRow('customer');
  const supplierCost = priceRow('supplier');
  const rows: Record<string, Row | Row[]> = {
    tenant: { id: 'tenant-a', status: 'active' },
    project: { tenant_id: 'tenant-a', id: 'project-a', inference_policy_version: 1, inference_policy_status: 'active' },
    'project-policy': { tenant_id: 'tenant-a', project_id: 'project-a', version: 1, status: 'active' },
    principal: { id: 'user-a', disabled_at: null, anonymized_at: null },
    'tenant-membership': [
      { tenant_id: 'tenant-a', user_id: 'user-a', role: 'developer', status: 'active', revoked_at: null },
    ],
    'project-membership': [
      {
        tenant_id: 'tenant-a',
        project_id: 'project-a',
        user_id: 'user-a',
        role: 'developer',
        status: 'active',
        revoked_at: null,
      },
    ],
    key: {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      id: 'key-a',
      principal_user_id: 'user-a',
      execution_principal_type: 'member',
      execution_principal_id: 'user-a',
      entitlement_id: 'entitlement-a',
      supply_profile_id: 'profile-a',
      supply_mode: supplyMode,
      authz_version: 1,
      entitlement_authz_version: 1,
      supply_profile_authz_version: 1,
      model_scope_version: 1,
      model_scopes: ['model-a'],
      status: 'active',
      revoked_at: null,
      expires_at: null,
    },
    request: requestRow,
    attempt: attemptRow,
    entitlement: {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      id: 'entitlement-a',
      supply_profile_id: 'profile-a',
      supply_mode: supplyMode,
      authz_version: 1,
      status: 'active',
      model_scopes: ['model-a'],
      effective_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      superseded_at: null,
    },
    profile: {
      tenant_id: 'tenant-a',
      id: 'profile-a',
      supply_mode: supplyMode,
      authz_version: 1,
      status: 'active',
      model_scopes: ['model-a'],
    },
    route: {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      route_id: 'route-a',
      version: 1,
      status: 'active',
      public_model_id: 'public-model-a',
      public_model_version: 1,
      protocol: 'openai',
      supply_mode: supplyMode,
      target_mode: platform ? 'platform_pool' : 'tenant_account',
      upstream_id: 'upstream-a',
      endpoint: '/v1/chat/completions',
      head_version: 1,
      head_status: 'active',
      public_model_alias: 'model-a',
      public_model_status: 'active',
      public_model_version_status: 'active',
      model_provider_id: 'provider-a',
      model_product_id: 'product-a',
      public_model_name: 'model-a',
      endpoint_scope: ['/v1/chat/completions'],
    },
    commercial: {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      route_id: 'route-a',
      route_version: 1,
      customer_policy_id: 'customer-policy-a',
      customer_policy_version: 1,
      provider_policy_id: 'provider-policy-a',
      provider_policy_version: 1,
      contract_attestation_id: 'attestation-a',
      customer_price_version: platform ? 'price-v1' : null,
      supplier_cost_version: platform ? 'supplier-v1' : null,
    },
    'customer-policy': {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      policy_id: 'customer-policy-a',
      version: 1,
      status: 'active',
      head_version: 1,
      head_status: 'active',
      public_model_id: 'public-model-a',
      public_model_version: 1,
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      supply_mode: supplyMode,
      target_mode: platform ? 'platform_pool' : 'tenant_account',
      customer_price_version: platform ? 'price-v1' : null,
      commercial_policy_version: 'commercial-v1',
      rounding_version: 'rounding-v1',
      rounding_mode: 'half_up',
      rounding_boundary: 'total',
    },
    'provider-policy': {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      policy_id: 'provider-policy-a',
      version: 1,
      status: 'active',
      head_version: 1,
      head_status: 'active',
      public_model_id: 'public-model-a',
      public_model_version: 1,
      provider_id: 'provider-a',
      product_id: 'product-a',
      resolved_model: 'model-a',
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      supply_mode: supplyMode,
      target_mode: platform ? 'platform_pool' : 'tenant_account',
      supplier_cost_version: platform ? 'supplier-v1' : null,
      commercial_policy_version: 'commercial-v1',
      rounding_version: 'rounding-v1',
      rounding_mode: 'half_up',
      rounding_boundary: 'total',
    },
    attestation: {
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      id: 'attestation-a',
      provider_policy_id: 'provider-policy-a',
      provider_policy_version: 1,
      public_model_id: 'public-model-a',
      public_model_version: 1,
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      supply_mode: supplyMode,
      target_mode: platform ? 'platform_pool' : 'tenant_account',
      verification_result: 'verified',
    },
    account,
    'account-rights': rights,
    credential,
    'credential-version': credentialVersion,
    mapping: {
      tenant_id: 'tenant-a',
      supply_profile_id: 'profile-a',
      supply_mode: 'byok',
      account_id: accountId,
      provider_id: 'provider-a',
      product_id: 'product-a',
      account_authz_version: 1,
      authz_version: 1,
      status: 'active',
      effective_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      evidence_ref: 'mapping-evidence',
      evidence_sha256: HASH,
    },
    pool: {
      id: 'pool-a',
      owner_kind: 'platform',
      supply_mode: 'platform',
      provider_id: 'provider-a',
      product_id: 'product-a',
      credential_type: 'api-key',
      region: 'us-east-1',
      purpose: 'inference',
      rights_id: 'rights-a',
      rights_version: 1,
      status: 'active',
      validation_state: 'verified',
      authz_version: 1,
    },
    'pool-rights': rights,
    'pool-member': {
      pool_id: 'pool-a',
      account_id: accountId,
      provider_id: 'provider-a',
      product_id: 'product-a',
      account_authz_version: 1,
      authz_version: 1,
      status: 'active',
    },
    'pool-grant': {
      pool_id: 'pool-a',
      tenant_id: 'tenant-a',
      supply_profile_id: 'profile-a',
      supply_mode: 'platform',
      profile_authz_version: 1,
      pool_authz_version: 1,
      authz_version: 1,
      status: 'active',
      effective_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      evidence_ref: 'grant-evidence',
      evidence_sha256: HASH,
    },
    capability: {
      provider_id: 'provider-a',
      product_id: 'product-a',
      model: 'model-a',
      endpoint: '/v1/chat/completions',
      protocol: 'openai',
      version: 1,
      support_level: 'supported',
      validation_state: 'verified',
      evidence_version: 'evidence-v1',
      evidence_ref: 'capability-evidence',
      evidence_sha256: HASH,
    },
    'account-capability': {
      provider_id: 'provider-a',
      product_id: 'product-a',
      model: 'model-a',
      endpoint: '/v1/chat/completions',
      capability_version: 1,
    },
    product: { provider_id: 'provider-a', product_id: 'product-a', display_name: 'Provider A', status: 'active' },
  };
  return {
    rows,
    request,
    attempt,
    customerPrice,
    supplierCost,
    snapshot: null,
    statements: [],
    fenceKeys: [],
    providerCalls: 0,
  };
}

class FakeExecutor implements SqlExecutor {
  constructor(readonly fixture: Fixture) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.fixture.statements.push(sql.trim());
    const lower = sql.toLowerCase();
    const stage = /postgres-request-admission:([a-z-]+)/.exec(sql)?.[1];
    if (lower.includes('select clock_timestamp')) return { rows: [{ locked_at: NOW }] as RowType[], rowCount: 1 };
    if (lower.includes('pg_advisory_xact_lock')) {
      this.fixture.fenceKeys.push(String(values[0]));
      return { rows: [], rowCount: 0 };
    }
    if (lower.startsWith('insert into saas_request_customer_price_snapshots')) {
      const row: Row = {
        id: values[0],
        tenant_id: values[1],
        request_id: values[2],
        customer_price_version: values[3],
        public_model_id: values[4],
        public_model_version: values[5],
        provider_id: values[6],
        product_id: values[7],
        protocol: values[8],
        endpoint: values[9],
        currency: values[10],
        commercial_policy_version: values[11],
        calculator_version: values[12],
        rounding_version: values[13],
        rounding_mode: values[14],
        rounding_boundary: values[15],
        hold_input_total: values[16],
        hold_input_uncached: values[17],
        hold_input_cache_read: values[18],
        hold_input_cache_write: values[19],
        hold_input_cache_write_5m: values[20],
        hold_input_cache_write_1h: values[21],
        hold_input_output_total: values[22],
        hold_input_reasoning_output: values[23],
        hold_amount_minor_units: values[24],
        wallet_hold_required: values[25],
        admission_expires_at: values[26],
        idempotency_key: values[27],
        snapshot_digest: values[28],
        created_at: values[29],
      };
      this.fixture.snapshot = row;
      return { rows: [row] as RowType[], rowCount: 1 };
    }
    if (lower.includes('saas_request_customer_price_snapshots'))
      return {
        rows: this.fixture.snapshot ? [this.fixture.snapshot as RowType] : [],
        rowCount: this.fixture.snapshot ? 1 : 0,
      };
    if (lower.includes('select supply_mode, protocol, endpoint') && lower.includes('from saas_requests'))
      return { rows: [this.fixture.rows.request as RowType], rowCount: 1 };
    if (lower.includes('from saas_customer_price_versions'))
      return { rows: [this.fixture.customerPrice as RowType], rowCount: 1 };
    if (lower.includes('from saas_supplier_cost_versions'))
      return { rows: [this.fixture.supplierCost as RowType], rowCount: 1 };
    if (stage === 'tenant-membership' || stage === 'project-membership')
      return {
        rows: (this.fixture.rows[stage] as Row[]).map(clone) as RowType[],
        rowCount: (this.fixture.rows[stage] as Row[]).length,
      };
    if (
      stage === 'route' ||
      stage === 'commercial' ||
      stage === 'customer-policy' ||
      stage === 'provider-policy' ||
      stage === 'attestation' ||
      stage === 'customer-price-identity' ||
      stage === 'supplier-cost-identity'
    )
      return { rows: [clone(this.fixture.rows[stage] as Row) as RowType], rowCount: 1 };
    if (stage === 'capability') return { rows: [clone(this.fixture.rows.capability as Row) as RowType], rowCount: 1 };
    if (stage === 'account-capability')
      return { rows: [clone(this.fixture.rows['account-capability'] as Row) as RowType], rowCount: 1 };
    if (stage) {
      const row = this.fixture.rows[stage];
      if (Array.isArray(row)) return { rows: row.map(clone) as RowType[], rowCount: row.length };
      return row ? { rows: [clone(row) as RowType], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (lower.includes('from saas_provider_products'))
      return { rows: [clone(this.fixture.rows.product as Row) as RowType], rowCount: 1 };
    if (lower.includes('from saas_provider_capabilities'))
      return { rows: [clone(this.fixture.rows.capability as Row) as RowType], rowCount: 1 };
    if (lower.includes('from saas_provider_rights'))
      return { rows: [clone(this.fixture.rows['account-rights'] as Row) as RowType], rowCount: 1 };
    throw new Error(`unhandled fake SQL: ${sql}`);
  }
}

class FakeDatabase implements SaasDatabase {
  constructor(
    readonly fixture: Fixture,
    readonly executor = new FakeExecutor(fixture),
  ) {}
  async query<RowType>(sql: string, values?: readonly unknown[]): Promise<SqlResult<RowType>> {
    return this.executor.query(sql, values);
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.executor);
  }
  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function evidence() {
  return {
    inputTotal: '10',
    inputUncached: '10',
    cacheRead: '0',
    cacheWrite: '0',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    outputTotal: '2',
    reasoningOutput: '0',
    admissionExpiresAt: EXPIRY,
  };
}

async function run(fixture: Fixture, mode: 'byok' | 'platform' = 'platform') {
  const database = new FakeDatabase(fixture);
  const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW, idFactory: () => 'snapshot-a' });
  return guard.revalidate({
    executor: database.executor,
    request: fixture.request,
    candidate: fixture.attempt,
    holdEvidence: mode === 'platform' ? evidence() : null,
  });
}

test('platform admission revalidates authorities and writes only the customer price snapshot', async () => {
  const fixture = makeFixture('platform');
  const result = await run(fixture);
  assert.equal(result.platformPriceHold?.customerPriceVersion, 'price-v1');
  assert.equal(result.platformPriceHold?.supplierCostVersion, 'supplier-v1');
  assert.equal(result.platformPriceHold?.currency, 'USD');
  assert.equal(result.platformPriceHold?.amountMinorUnits, 12n);
  assert.equal(fixture.snapshot?.wallet_hold_required, true);
  assert.equal(fixture.providerCalls, 0);
  const writes = fixture.statements.filter((statement) => statement.toLowerCase().includes('insert into'));
  assert.equal(writes.length, 1);
  const [write] = writes;
  assert.ok(write);
  assert.match(write.toLowerCase(), /^insert into saas_request_customer_price_snapshots/);
});

test('fake-SQL admission takes ordered shared fences before authority reads', async () => {
  const fixture = makeFixture('platform');
  await run(fixture);
  const sql = fixture.statements;
  const indexOf = (pattern: RegExp): number => sql.findIndex((statement) => pattern.test(statement));
  const fenceKeyIndex = (pattern: RegExp): number => fixture.fenceKeys.findIndex((key) => pattern.test(key));

  const tenantFence = fenceKeyIndex(/^saas-authz:tenant:/i);
  const projectFence = fenceKeyIndex(/^saas-authz:project:/i);
  const userFence = fixture.fenceKeys.indexOf('user-a');
  const poolFence = fenceKeyIndex(/^saas_platform_pool:/i);
  const profileFence = fenceKeyIndex(/^saas_supply_profile:/i);
  const accountFence = fenceKeyIndex(/^(?:saas-authz:tenant|saas-authz:platform)-provider-account:/i);
  const credentialFence = fenceKeyIndex(/^(?:saas-authz:tenant|saas-authz:platform)-provider-credential:/i);
  const versionFence = fenceKeyIndex(/^saas-authz:credential-version:/i);
  const firstAuthorityRead = Math.min(
    ...[
      /FROM saas_tenants/i,
      /FROM saas_projects/i,
      /FROM saas_api_keys/i,
      /FROM saas_platform_provider_pools/i,
      /FROM saas_supply_profiles/i,
      /FROM saas_platform_provider_accounts/i,
    ]
      .map(indexOf)
      .filter((index) => index >= 0),
  );
  assert.ok(tenantFence >= 0 && projectFence >= 0 && userFence >= 0);
  assert.ok(tenantFence < projectFence);
  assert.ok(projectFence < userFence);
  assert.ok(userFence < poolFence);
  assert.ok(poolFence < profileFence);
  assert.ok(profileFence < accountFence);
  assert.ok(accountFence < credentialFence);
  assert.ok(credentialFence < versionFence);
  const lastFenceStatement = Math.max(
    ...sql.map((statement, index) => (statement.includes('postgres-request-admission:fence-') ? index : -1)),
  );
  assert.ok(lastFenceStatement < firstAuthorityRead);
  assert.ok(fixture.fenceKeys.every((key) => typeof key === 'string' && key.length > 0));
  assert.equal(
    sql
      .filter((statement) => statement.includes('postgres-request-admission:fence-'))
      .some((statement) => /FOR SHARE/i.test(statement)),
    false,
  );

  for (const table of [
    'saas_tenants',
    'saas_projects',
    'saas_users',
    'saas_memberships',
    'saas_project_memberships',
    'saas_project_entitlements',
    'saas_supply_profiles',
    'saas_route_config_versions',
    'saas_route_config_commercial_authorities',
    'saas_contract_test_attestations',
    'saas_provider_rights',
    'saas_provider_capabilities',
    'saas_platform_provider_pools',
    'saas_platform_provider_account_capabilities',
    'saas_customer_price_versions',
    'saas_supplier_cost_versions',
  ]) {
    const statement = sql.find((candidate) => candidate.toLowerCase().includes(`from ${table}`)) ?? '';
    assert.doesNotMatch(statement, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i, table);
  }

  for (const table of ['saas_requests', 'saas_attempts']) {
    const statement = sql.find((candidate) => candidate.toLowerCase().includes(`from ${table}`)) ?? '';
    assert.match(statement, /FOR UPDATE/i, table);
    assert.doesNotMatch(statement, /FOR SHARE/i, table);
  }
  assert.doesNotMatch(
    sql.find((statement) => /postgres-request-admission:customer-policy/i.test(statement)) ?? '',
    /FOR SHARE/i,
  );
  assert.doesNotMatch(
    sql.find((statement) => /postgres-request-admission:provider-policy/i.test(statement)) ?? '',
    /FOR SHARE/i,
  );
});

test('BYOK admission has no platform price or snapshot path', async () => {
  const fixture = makeFixture('byok');
  const result = await run(fixture, 'byok');
  assert.equal(result.platformPriceHold, null);
  assert.equal(fixture.snapshot, null);
  assert.equal(
    fixture.statements.some((statement) => statement.toLowerCase().includes('price_versions')),
    false,
  );
});

test('project-service admission ignores creator membership and rechecks the project policy', async () => {
  const fixture = makeFixture('byok');
  fixture.request = { ...fixture.request, principalKind: 'project_service', principalId: 'project-a' };
  Object.assign(fixture.rows.request as Row, { principal_kind: 'project_service', principal_id: 'project-a' });
  Object.assign(fixture.rows.key as Row, {
    principal_user_id: null,
    execution_principal_type: 'project_service',
    execution_principal_id: 'project-a',
  });
  const database = new FakeDatabase(fixture);
  const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW });
  const admitted = await guard.revalidate({
    executor: database.executor,
    request: fixture.request,
    candidate: fixture.attempt,
    holdEvidence: null,
  });
  assert.equal(admitted.platformPriceHold, null);
  assert.equal(
    fixture.statements.some((sql) => /saas_users|saas_memberships/i.test(sql)),
    false,
  );
  const projectHeadSql = fixture.statements.find((sql) => /from saas_projects/i.test(sql)) ?? '';
  const policyVersionSql =
    fixture.statements.find((sql) => /from saas_project_inference_policy_versions/i.test(sql)) ?? '';
  assert.match(projectHeadSql, /tenant_id = \$1 AND id = \$2/i);
  assert.doesNotMatch(projectHeadSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  assert.match(policyVersionSql, /tenant_id = \$1 AND project_id = \$2 AND version = \$3/i);
  assert.doesNotMatch(policyVersionSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);

  const suspended = makeFixture('byok');
  suspended.request = { ...suspended.request, principalKind: 'project_service', principalId: 'project-a' };
  Object.assign(suspended.rows.request as Row, { principal_kind: 'project_service', principal_id: 'project-a' });
  Object.assign(suspended.rows.key as Row, {
    principal_user_id: null,
    execution_principal_type: 'project_service',
    execution_principal_id: 'project-a',
  });
  (suspended.rows.project as Row).inference_policy_status = 'suspended';
  await assert.rejects(() => run(suspended, 'byok'), PostgresRequestAdmissionGuardError);
});

test('stale, revoked, and mismatched authorities deny safely', async () => {
  const cases: Array<[string, 'platform' | 'byok', (fixture: Fixture) => void]> = [
    [
      'tenant',
      'platform',
      (fixture) => {
        (fixture.rows.tenant as Row).status = 'suspended';
      },
    ],
    [
      'project policy',
      'platform',
      (fixture) => {
        (fixture.rows['project-policy'] as Row).status = 'suspended';
      },
    ],
    [
      'key epoch',
      'platform',
      (fixture) => {
        (fixture.rows.key as Row).authz_version = 2;
      },
    ],
    [
      'entitlement',
      'platform',
      (fixture) => {
        (fixture.rows.entitlement as Row).status = 'disabled';
      },
    ],
    [
      'profile',
      'platform',
      (fixture) => {
        (fixture.rows.profile as Row).authz_version = 2;
      },
    ],
    [
      'route head',
      'platform',
      (fixture) => {
        (fixture.rows.route as Row).head_version = 2;
      },
    ],
    [
      'capability evidence',
      'platform',
      (fixture) => {
        (fixture.rows.capability as Row).validation_state = 'failed';
      },
    ],
    [
      'provider rights',
      'platform',
      (fixture) => {
        (fixture.rows['account-rights'] as Row).status = 'revoked';
      },
    ],
    [
      'account lifecycle',
      'platform',
      (fixture) => {
        (fixture.rows.account as Row).status = 'revoked';
      },
    ],
    [
      'credential epoch',
      'platform',
      (fixture) => {
        (fixture.rows.credential as Row).authz_version = 2;
      },
    ],
    [
      'credential version lifecycle',
      'platform',
      (fixture) => {
        (fixture.rows['credential-version'] as Row).status = 'retired';
      },
    ],
    [
      'pool member epoch',
      'platform',
      (fixture) => {
        (fixture.rows['pool-member'] as Row).authz_version = 2;
      },
    ],
    [
      'pool grant',
      'platform',
      (fixture) => {
        (fixture.rows['pool-grant'] as Row).status = 'disabled';
      },
    ],
    [
      'customer policy head',
      'platform',
      (fixture) => {
        (fixture.rows['customer-policy'] as Row).head_status = 'disabled';
      },
    ],
    [
      'attestation',
      'platform',
      (fixture) => {
        (fixture.rows.attestation as Row).verification_result = 'failed';
      },
    ],
    [
      'customer price window',
      'platform',
      (fixture) => {
        fixture.customerPrice.expires_at = '2026-01-01T00:00:00.000Z';
      },
    ],
    [
      'BYOK mapping epoch',
      'byok',
      (fixture) => {
        (fixture.rows.mapping as Row).authz_version = 2;
      },
    ],
  ];
  for (const [label, mode, mutate] of cases) {
    const fixture = makeFixture(mode);
    mutate(fixture);
    await assert.rejects(
      () => run(fixture, mode),
      (error: unknown) => {
        assert.equal(error instanceof PostgresRequestAdmissionGuardError, true, label);
        return true;
      },
    );
  }
});

test('platform and BYOK separation is fail-closed before any price write', async () => {
  const byok = makeFixture('byok');
  byok.request = { ...byok.request, customerPriceVersion: 'price-v1' };
  (byok.rows.request as Row).customer_price_version = 'price-v1';
  (byok.rows.commercial as Row).customer_price_version = 'price-v1';
  await assert.rejects(
    () => run(byok, 'byok'),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError,
  );
  assert.equal(byok.snapshot, null);

  const platform = makeFixture('platform');
  await assert.rejects(
    () =>
      new PostgresRequestAdmissionGuard(new FakeDatabase(platform), { now: () => NOW }).revalidate({
        executor: new FakeDatabase(platform).executor,
        request: platform.request,
        candidate: platform.attempt,
        holdEvidence: null,
      }),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError,
  );
  assert.equal(platform.snapshot, null);
});
