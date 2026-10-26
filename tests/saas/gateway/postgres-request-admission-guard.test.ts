import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import type { PreparedSqlStatement, SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PLATFORM_REQUEST_ADMISSION_UPPER_BOUNDS_KIND,
  type PlatformRequestAdmissionHoldEvidence,
} from '../../../src/saas/gateway/admission.js';
import type { ClientAddressResolution } from '../../../src/saas/gateway/client-address.js';
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
    per_unit_rate_numerator_minor_units: null,
    per_unit_rate_denominator_units: null,
    per_unit_tier_rates: null,
    token_multipliers: null,
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
    // R1 (105): neutral seeded default billing group (1/1 multipliers).
    'billing-group': {
      id: 'default',
      display_name: 'Default',
      rate_multiplier_num: '1',
      rate_multiplier_den: '1',
      topup_multiplier_num: '1',
      topup_multiplier_den: '1',
      peak_enabled: false,
      peak_start: null,
      peak_end: null,
      peak_multiplier_num: null,
      peak_multiplier_den: null,
      model_pricing: null,
      rpm_limit: null,
      daily_limit_minor_units: null,
      weekly_limit_minor_units: null,
      monthly_limit_minor_units: null,
      profit_min_margin_num: null,
      profit_min_margin_den: null,
      profit_safety_buffer_num: null,
      profit_safety_buffer_den: null,
      claude_code_only: false,
      fallback_group_id: null,
      supported_model_scopes: null,
      composite: false,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
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
    if (stage === 'authority-batch') {
      const stages = [...sql.matchAll(/\/\* postgres-request-admission:([a-z-]+) \*\//g)]
        .map((match) => match[1])
        .filter((name) => name !== 'authority-batch');
      const facts = stages.map((name) => {
        const value =
          name === 'customer-price-identity'
            ? this.fixture.customerPrice
            : name === 'supplier-cost-identity'
              ? this.fixture.supplierCost
              : this.fixture.rows[name];
        return { stage: name, facts: clone(Array.isArray(value) ? value : value ? [value] : []) };
      });
      return { rows: facts as RowType[], rowCount: facts.length };
    }
    if (lower.includes('select clock_timestamp')) return { rows: [{ locked_at: NOW }] as RowType[], rowCount: 1 };
    if (lower.includes('pg_advisory_xact_lock')) {
      // The fence batch passes the ordered key list as one text-array
      // parameter; record the keys in array (acquisition) order.
      const keys = values[0];
      if (Array.isArray(keys)) {
        for (const key of keys) this.fixture.fenceKeys.push(String(key));
      } else {
        this.fixture.fenceKeys.push(String(values[0]));
      }
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
        hold_input_per_unit_units: values[24],
        hold_input_size_tier: values[25],
        hold_amount_minor_units: values[26],
        wallet_hold_required: values[27],
        admission_expires_at: values[28],
        idempotency_key: values[29],
        snapshot_digest: values[30],
        created_at: values[31],
        billing_group_id: values[32],
        rate_multiplier_num: values[33],
        rate_multiplier_den: values[34],
        peak_applied: values[35],
        model_pricing_override_digest: values[36],
        model_pricing_override: values[37],
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

async function run(
  fixture: Fixture,
  mode: 'byok' | 'platform' = 'platform',
  clientAddress?: ClientAddressResolution | null,
) {
  const database = new FakeDatabase(fixture);
  const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW, idFactory: () => 'snapshot-a' });
  return guard.revalidate({
    executor: database.executor,
    request: fixture.request,
    candidate: fixture.attempt,
    holdEvidence: mode === 'platform' ? evidence() : null,
    clientAddress: clientAddress ?? null,
  });
}

function ipPolicyHead(mode: string, rules: readonly string[]): Row {
  return {
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    key_id: 'key-a',
    version: '1',
    mode,
    rules: [...rules],
    created_at: NOW,
    updated_at: NOW,
  };
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

test('independent bounds preserve the full envelope and freeze one maximizing TTL allocation', async () => {
  for (const multiplier of [1n, 2n]) {
    const fixture = makeFixture('platform');
    fixture.customerPrice.cache_read_rate_numerator_minor_units = 2;
    fixture.customerPrice.cache_write_rate_numerator_minor_units = 3;
    fixture.customerPrice.cache_write_5m_rate_numerator_minor_units = 4;
    fixture.customerPrice.cache_write_1h_rate_numerator_minor_units = 5;
    (fixture.rows['billing-group'] as Row).rate_multiplier_num = multiplier;
    const database = new FakeDatabase(fixture);
    const holdEvidence: PlatformRequestAdmissionHoldEvidence = {
      ...evidence(),
      evidenceKind: PLATFORM_REQUEST_ADMISSION_UPPER_BOUNDS_KIND,
      inputUncached: '10',
      cacheRead: '10',
      cacheWrite: '10',
      cacheWrite5m: '10',
      cacheWrite1h: '10',
      reasoningOutput: '2',
    };
    const result = await new PostgresRequestAdmissionGuard(database, { now: () => NOW }).revalidate({
      executor: database.executor,
      request: fixture.request,
      candidate: fixture.attempt,
      holdEvidence,
    });
    assert.equal(result.platformPriceHold?.amountMinorUnits, 52n * multiplier);
    assert.equal(holdEvidence.inputUncached, '10', 'source bounds must remain intact');
    assert.equal(holdEvidence.cacheWrite, '10');
    assert.equal(holdEvidence.cacheWrite1h, '10');
    assert.equal(fixture.snapshot?.hold_input_total, 10n);
    assert.equal(fixture.snapshot?.hold_input_uncached, 0n);
    assert.equal(fixture.snapshot?.hold_input_cache_read, 0n);
    assert.equal(fixture.snapshot?.hold_input_cache_write, 0n);
    assert.equal(fixture.snapshot?.hold_input_cache_write_5m, 0n);
    assert.equal(fixture.snapshot?.hold_input_cache_write_1h, 10n);
    assert.equal(fixture.snapshot?.hold_input_output_total, 2n);
    assert.equal(fixture.snapshot?.hold_input_reasoning_output, 0n);
  }
});

test('untagged allocation evidence retains sum and generic-versus-TTL disjointness invariants', async () => {
  for (const damaged of [
    { ...evidence(), cacheRead: '10' },
    { ...evidence(), inputTotal: '30', inputUncached: '0', cacheWrite: '10', cacheWrite5m: '10' },
  ]) {
    const fixture = makeFixture('platform');
    const database = new FakeDatabase(fixture);
    await assert.rejects(
      new PostgresRequestAdmissionGuard(database, { now: () => NOW }).revalidate({
        executor: database.executor,
        request: fixture.request,
        candidate: fixture.attempt,
        holdEvidence: damaged,
      }),
      (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'AUTHORITY_MISMATCH',
    );
    assert.equal(fixture.snapshot, null);
  }
});

test('tagged bounds reject any overbound, reasoning overflow, or invalid tag before price writes', async () => {
  const base = { ...evidence(), evidenceKind: PLATFORM_REQUEST_ADMISSION_UPPER_BOUNDS_KIND };
  const damaged: unknown[] = [
    ...['inputUncached', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'].map((field) => ({
      ...base,
      [field]: '11',
    })),
    { ...base, reasoningOutput: '3' },
    { ...base, evidenceKind: 'future-kind' },
    { ...base, evidenceKind: undefined },
    { ...base, evidenceKind: null },
    Object.assign(Object.create({ evidenceKind: PLATFORM_REQUEST_ADMISSION_UPPER_BOUNDS_KIND }), evidence()),
  ];
  for (const holdEvidence of damaged) {
    const fixture = makeFixture('platform');
    const database = new FakeDatabase(fixture);
    await assert.rejects(
      new PostgresRequestAdmissionGuard(database, { now: () => NOW }).revalidate({
        executor: database.executor,
        request: fixture.request,
        candidate: fixture.attempt,
        holdEvidence: holdEvidence as PlatformRequestAdmissionHoldEvidence,
      }),
      (error: unknown) =>
        error instanceof PostgresRequestAdmissionGuardError &&
        ['AUTHORITY_MISMATCH', 'INVALID_INPUT'].includes(error.code),
    );
    assert.equal(fixture.snapshot, null);
  }
});

test('platform admission multiplies the hold by the key billing group and freezes it on the snapshot', async () => {
  const fixture = makeFixture('platform');
  fixture.rows.key = { ...fixture.rows.key, billing_group_id: 'vip' };
  fixture.rows['billing-group'] = {
    ...(fixture.rows['billing-group'] as Row),
    id: 'vip',
    display_name: 'VIP',
    rate_multiplier_num: '3',
    rate_multiplier_den: '2',
  };
  const result = await run(fixture);
  assert.equal(result.platformPriceHold?.customerPriceVersion, 'price-v1');
  // Conservative hold for 10 input + 2 output at rate 1 is 12; × 3/2 ceil = 18.
  assert.equal(result.platformPriceHold?.amountMinorUnits, 18n);
  assert.equal(fixture.snapshot?.billing_group_id, 'vip');
  assert.equal(fixture.snapshot?.rate_multiplier_num, 3n);
  assert.equal(fixture.snapshot?.rate_multiplier_den, 2n);
  assert.equal(fixture.snapshot?.peak_applied, false);
  assert.equal(fixture.snapshot?.model_pricing_override_digest, null);
  assert.equal(fixture.snapshot?.model_pricing_override, null);
  assert.equal(fixture.snapshot?.hold_amount_minor_units, 18n);
  // The group row is read after every admission fence, without row locks.
  const groupStatement = fixture.statements.find((statement) =>
    statement.includes('postgres-request-admission:billing-group'),
  );
  assert.ok(groupStatement);
  assert.doesNotMatch(groupStatement, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

test('platform admission applies the group model pricing override with the highest priority', async () => {
  const fixture = makeFixture('platform');
  fixture.rows.key = { ...fixture.rows.key, billing_group_id: 'vip' };
  fixture.rows['billing-group'] = {
    ...(fixture.rows['billing-group'] as Row),
    id: 'vip',
    display_name: 'VIP',
    rate_multiplier_num: '1',
    rate_multiplier_den: '1',
    model_pricing: {
      'public-model-a': {
        input: { num: '10', den: '1' },
        cache_read: { num: '10', den: '1' },
        cache_write: { num: '10', den: '1' },
        cache_write_5m: { num: '10', den: '1' },
        cache_write_1h: { num: '10', den: '1' },
        output: { num: '10', den: '1' },
      },
    },
  };
  const result = await run(fixture);
  // The override replaces the price-row rates before the hold calculation:
  // 10 input + 2 output at rate 10 = 120, × 1/1 = 120.
  assert.equal(result.platformPriceHold?.amountMinorUnits, 120n);
  assert.match(String(fixture.snapshot?.model_pricing_override_digest), /^[0-9a-f]{64}$/);
  assert.ok(fixture.snapshot?.model_pricing_override);
});

test('platform admission denies when the billing group is missing or inactive', async () => {
  const missing = makeFixture('platform');
  missing.rows.key = { ...missing.rows.key, billing_group_id: 'ghost' };
  missing.rows['billing-group'] = [];
  await assert.rejects(run(missing), /price could not be proven current/);

  const inactive = makeFixture('platform');
  inactive.rows.key = { ...inactive.rows.key, billing_group_id: 'vip' };
  inactive.rows['billing-group'] = { ...(inactive.rows['billing-group'] as Row), id: 'vip', status: 'disabled' };
  await assert.rejects(run(inactive), /price could not be proven current/);
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
  const batch = sql.filter((statement) => statement.includes('postgres-request-admission:fence-batch'));
  assert.equal(batch.length, 1);
  assert.match(
    batch[0] ?? '',
    /WITH ORDINALITY AS fence\(fence_key, input_ordinal\)\s+ORDER BY fence\.input_ordinal\s*$/,
  );
  assert.doesNotMatch(batch[0] ?? '', /\bLIMIT\b|\bDISTINCT\b|\bGROUP BY\b|ORDER BY\s+(?:1|fence\.fence_key)/i);
  const { request, attempt } = fixture;
  assert.ok(
    attempt.providerId &&
      request.customerMeteringPolicyId &&
      attempt.providerMeteringPolicyId &&
      attempt.poolId &&
      request.supplyProfileId &&
      attempt.dispatchProfileId &&
      attempt.accountId &&
      attempt.credentialId,
  );
  const expected = [
    ...new Set([
      saasAdvisoryKey.tenant(request.tenantId),
      saasAdvisoryKey.project(request.tenantId, request.projectId),
      ...[
        request.principalId,
        saasAdvisoryKey.apiKey(request.tenantId, request.projectId, request.proxyKeyId),
        saasAdvisoryKey.commercialCustomer(request.tenantId, request.customerMeteringPolicyId),
        saasAdvisoryKey.commercialProvider(attempt.providerId, attempt.providerMeteringPolicyId),
        'saas-authz:provider-rights',
      ].sort(),
      saasAdvisoryKey.platformPool(attempt.poolId),
      ...[
        ...new Set([
          saasAdvisoryKey.supplyProfile(request.tenantId, request.supplyProfileId),
          saasAdvisoryKey.supplyProfile(request.tenantId, attempt.dispatchProfileId),
        ]),
      ].sort(),
      saasAdvisoryKey.platformProviderAccount(attempt.accountId),
      saasAdvisoryKey.platformProviderCredential(attempt.credentialId),
      saasAdvisoryKey.credentialVersion(
        'platform',
        'platform',
        attempt.credentialId,
        Number(attempt.credentialVersion),
      ),
    ]),
  ];
  assert.deepEqual(
    fixture.fenceKeys.slice(0, expected.length),
    expected,
    'guard keeps its existing global first-occurrence dedupe',
  );
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

test('authority batches remain request-local and re-read revocation on the next admission', async () => {
  const fixture = makeFixture('byok');
  const database = new FakeDatabase(fixture);
  const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW });
  const input = {
    executor: database.executor,
    request: fixture.request,
    candidate: fixture.attempt,
    holdEvidence: null,
  };
  await guard.revalidate(input);
  (fixture.rows.key as Row).status = 'revoked';
  await assert.rejects(
    guard.revalidate(input),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'AUTHORITY_MISMATCH',
  );
  assert.equal(
    fixture.statements.filter((sql) => sql.startsWith('/* postgres-request-admission:authority-batch */')).length,
    2,
  );
});

test('missing, duplicate and malformed batch stages fail closed before price writes', async () => {
  for (const damage of ['missing', 'duplicate', 'malformed'] as const) {
    const fixture = makeFixture('platform');
    const database = new FakeDatabase(fixture);
    const executor: SqlExecutor = {
      async query<RowType>(sql: string, values?: readonly unknown[]) {
        const result = await database.executor.query<Row>(sql, values);
        if (sql.startsWith('/* postgres-request-admission:authority-batch */')) {
          if (damage === 'missing') result.rows.pop();
          if (damage === 'duplicate') result.rows[1] = result.rows[0] as Row;
          if (damage === 'malformed') result.rows[0] = { stage: 'tenant', facts: [null] };
        }
        return result as SqlResult<RowType>;
      },
    };
    await assert.rejects(
      new PostgresRequestAdmissionGuard(database, { now: () => NOW }).revalidate({
        executor,
        request: fixture.request,
        candidate: fixture.attempt,
        holdEvidence: evidence(),
      }),
      (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'STORAGE_ERROR',
    );
    assert.equal(fixture.snapshot, null);
  }
});

test('the final database clock still rejects an authority that expires after the batch read', async () => {
  const fixture = makeFixture('byok');
  (fixture.rows['credential-version'] as Row).expires_at = new Date(NOW.getTime() + 500).toISOString();
  const database = new FakeDatabase(fixture);
  let clocks = 0;
  const executor: SqlExecutor = {
    async query<RowType>(sql: string, values?: readonly unknown[]) {
      if (sql.includes('SELECT clock_timestamp()')) {
        clocks += 1;
        return { rows: [{ locked_at: new Date(NOW.getTime() + (clocks === 1 ? 0 : 1000)) }] as RowType[], rowCount: 1 };
      }
      return database.executor.query<RowType>(sql, values);
    },
  };
  await assert.rejects(
    new PostgresRequestAdmissionGuard(database, { now: () => NOW }).revalidate({
      executor,
      request: fixture.request,
      candidate: fixture.attempt,
      holdEvidence: null,
    }),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'EXPIRED',
  );
  assert.equal(clocks, 2);
});

test('native capability checks require the exact persisted provider protocol', async () => {
  const fixture = makeFixture('byok');
  fixture.attempt = {
    ...fixture.attempt,
    providerProtocol: 'anthropic',
    clientOperation: 'chat.completions',
    providerOperation: 'messages',
  };
  Object.assign(fixture.rows.attempt as Row, {
    provider_protocol: 'anthropic',
    client_operation: 'chat.completions',
    provider_operation: 'messages',
  });
  (fixture.rows.capability as Row).protocol = 'anthropic';
  assert.equal((await run(fixture, 'byok')).platformPriceHold, null);
  (fixture.rows.attempt as Row).provider_protocol = 'openai';
  await assert.rejects(
    run(fixture, 'byok'),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'AUTHORITY_MISMATCH',
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
  assert.match(projectHeadSql, /tenant_id = \$\d+ AND id = \$\d+/i);
  assert.doesNotMatch(projectHeadSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  assert.match(policyVersionSql, /tenant_id = \$\d+ AND project_id = \$\d+ AND version = \$\d+/i);
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

test('a missing key IP policy head stays disabled and admits without address evidence', async () => {
  const fixture = makeFixture('platform');
  const result = await run(fixture);
  assert.equal(result.platformPriceHold?.customerPriceVersion, 'price-v1');
  assert.equal(
    fixture.statements.some((statement) => statement.includes('postgres-request-admission:key-ip-policy')),
    true,
  );
});

test('an allowlist admits a resolved in-policy client address', async () => {
  const fixture = makeFixture('platform');
  fixture.rows['key-ip-policy'] = ipPolicyHead('allowlist', ['203.0.113.0/24', '2001:db8::/32']);
  const allowed = await run(fixture, 'platform', {
    status: 'resolved',
    address: '203.0.113.7',
    source: 'socket-peer',
  });
  assert.equal(allowed.platformPriceHold?.customerPriceVersion, 'price-v1');
  const v6 = await run(makeFixture('platform'), 'platform');
  assert.equal(v6.platformPriceHold?.customerPriceVersion, 'price-v1');
  const fixture6 = makeFixture('platform');
  fixture6.rows['key-ip-policy'] = ipPolicyHead('allowlist', ['2001:db8::/32']);
  const allowed6 = await run(fixture6, 'platform', {
    status: 'resolved',
    address: '2001:db8::42',
    source: 'socket-peer',
  });
  assert.equal(allowed6.platformPriceHold?.customerPriceVersion, 'price-v1');
});

test('an allowlist denies out-of-policy, unresolved and absent client address evidence', async () => {
  for (const clientAddress of [
    { status: 'resolved', address: '198.51.100.9', source: 'socket-peer' } as ClientAddressResolution,
    { status: 'unresolved', reason: 'missing-forwarded-address' } as ClientAddressResolution,
    null,
    undefined,
  ]) {
    const fixture = makeFixture('platform');
    fixture.rows['key-ip-policy'] = ipPolicyHead('allowlist', ['203.0.113.0/24']);
    await assert.rejects(
      () => run(fixture, 'platform', clientAddress ?? null),
      (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'CALLER_DENIED',
    );
    assert.equal(fixture.snapshot, null);
  }
});

test('denyall rejects even a resolved in-range address and a disabled head never evaluates the address', async () => {
  const denied = makeFixture('byok');
  denied.rows['key-ip-policy'] = ipPolicyHead('denyall', []);
  await assert.rejects(
    () => run(denied, 'byok', { status: 'resolved', address: '203.0.113.7', source: 'socket-peer' }),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'CALLER_DENIED',
  );

  const disabled = makeFixture('byok');
  disabled.rows['key-ip-policy'] = ipPolicyHead('disabled', []);
  const admitted = await run(disabled, 'byok');
  assert.equal(admitted.platformPriceHold, null);
});

test('a malformed stored policy head fails closed instead of failing open', async () => {
  const fixture = makeFixture('platform');
  fixture.rows['key-ip-policy'] = ipPolicyHead('allowlist', ['not-an-address']);
  await assert.rejects(
    () => run(fixture, 'platform', { status: 'resolved', address: '203.0.113.7', source: 'socket-peer' }),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'CALLER_DENIED',
  );
  assert.equal(fixture.snapshot, null);
});

/*
 * R3 §8.1: composite dispatches — the customer price identity stays on the
 * route's nominal pin while the supplier cost identity is the RESOLVED
 * target-platform identity the attempt froze.
 */

function compositeFixture(): Fixture {
  const fixture = makeFixture('platform');
  const target = {
    providerId: 'google-gemini',
    productId: 'gemini-subscription',
    model: 'gemini-2.5-pro',
    endpoint: 'gemini-generate-content',
  };
  fixture.request = {
    ...fixture.request,
    endpoint: target.endpoint,
    compositeRoute: {
      billingGroupId: 'default',
      source: 'route',
      routeId: 'route-a',
      targetPlatform: target.providerId,
      productId: target.productId,
      upstreamModel: target.model,
      endpoint: target.endpoint,
    },
  };
  fixture.attempt = {
    ...fixture.attempt,
    providerId: target.providerId,
    productId: target.productId,
    resolvedModel: target.model,
    endpoint: target.endpoint,
    supplierCostVersion: 'supplier-gemini',
  };
  // The persisted rows must mirror the in-memory request/candidate exactly.
  fixture.rows.request = { ...fixture.rows.request, endpoint: target.endpoint };
  fixture.rows.attempt = {
    ...fixture.rows.attempt,
    provider_id: target.providerId,
    product_id: target.productId,
    resolved_model: target.model,
    endpoint: target.endpoint,
    supplier_cost_version: 'supplier-gemini',
  };
  // Serving-side authority rows carry the RESOLVED identity.
  for (const stage of [
    'account',
    'account-rights',
    'credential',
    'pool',
    'pool-rights',
    'pool-member',
    'capability',
    'account-capability',
    'product',
  ]) {
    const row = fixture.rows[stage];
    if (row && !Array.isArray(row)) {
      fixture.rows[stage] = {
        ...row,
        ...(row.provider_id !== undefined ? { provider_id: target.providerId } : {}),
        ...(row.product_id !== undefined ? { product_id: target.productId } : {}),
        ...(row.model !== undefined ? { model: target.model } : {}),
        ...(row.endpoint !== undefined ? { endpoint: target.endpoint } : {}),
        ...(row.model_scope !== undefined ? { model_scope: [target.model] } : {}),
        ...(row.endpoint_scope !== undefined ? { endpoint_scope: [target.endpoint] } : {}),
      };
    }
  }
  // The supplier cost version is the RESOLVED target-platform identity row;
  // the customer price version stays the nominal route registration.
  fixture.supplierCost = {
    ...priceRow('supplier'),
    id: 'supplier-gemini',
    provider_id: target.providerId,
    product_id: target.productId,
    resolved_model: target.model,
    endpoint: target.endpoint,
  };
  return fixture;
}

test('composite admission verifies the resolved supply identity and the nominal customer identity separately', async () => {
  const fixture = compositeFixture();
  const result = await run(fixture);
  assert.equal(result.platformPriceHold?.customerPriceVersion, 'price-v1');
  assert.equal(result.platformPriceHold?.supplierCostVersion, 'supplier-gemini');
  // The customer price snapshot keeps the NOMINAL identity (no customer drift).
  assert.equal(fixture.snapshot?.provider_id, 'provider-a');
  assert.equal(fixture.snapshot?.product_id, 'product-a');
  assert.equal(fixture.snapshot?.endpoint, '/v1/chat/completions');
});

test('a composite candidate whose supplier cost row is the nominal version fails closed', async () => {
  const fixture = compositeFixture();
  // The attempt carries the NOMINAL cost version instead of the resolved one.
  fixture.attempt = { ...fixture.attempt, supplierCostVersion: 'supplier-v1' };
  fixture.rows.attempt = { ...fixture.rows.attempt, supplier_cost_version: 'supplier-v1' };
  // The supplier cost row is now the nominal registration; the resolved
  // candidate identity (gemini) no longer matches it.
  fixture.supplierCost = priceRow('supplier');
  await assert.rejects(run(fixture), (error: unknown) => {
    assert.ok(error instanceof PostgresRequestAdmissionGuardError);
    assert.equal(error.code, 'AUTHORITY_MISMATCH');
    return true;
  });
});

const nativeAdmissionNames = new Set<string>();
for (const { mode, principal } of (['byok', 'platform'] as const).flatMap((mode) =>
  (['member', 'project_service'] as const).map((principal) => ({ mode, principal })),
)) {
  test(`${mode}/${principal} authority batch native preparation preserves SQL/fences and rereads revocation`, async () => {
    const anonymous = makeFixture(mode);
    const fixture = makeFixture(mode);
    if (principal === 'project_service')
      for (const item of [anonymous, fixture]) {
        item.request = { ...item.request, principalKind: 'project_service', principalId: 'project-a' };
        Object.assign(item.rows.request as Row, { principal_kind: 'project_service', principal_id: 'project-a' });
        Object.assign(item.rows.key as Row, {
          principal_user_id: null,
          execution_principal_type: 'project_service',
          execution_principal_id: 'project-a',
        });
      }
    await run(anonymous, mode);
    const database = new FakeDatabase(fixture);
    const descriptors: PreparedSqlStatement[] = [];
    const valuesSeen: readonly unknown[][] = [];
    const executor: SqlExecutor = {
      query: database.executor.query.bind(database.executor),
      async queryPrepared<RowType>(statement: PreparedSqlStatement, values?: readonly unknown[]) {
        descriptors.push(statement);
        (valuesSeen as unknown[][]).push([...(values ?? [])]);
        assert.match(statement.name, /^mr_auth-admit_[A-Za-z0-9_-]{43}$/u);
        assert.ok(Object.isFrozen(statement));
        return database.executor.query<RowType>(statement.text, values);
      },
    };
    const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW, idFactory: () => 'snapshot-a' });
    const input = {
      executor,
      request: fixture.request,
      candidate: fixture.attempt,
      holdEvidence: mode === 'platform' ? evidence() : null,
      clientAddress: null,
    };
    await guard.revalidate(input);
    assert.deepEqual(fixture.statements, anonymous.statements, 'off/native preserve every SQL byte and ordering');
    assert.equal(descriptors.length, 1);
    assert.equal(
      nativeAdmissionNames.has(descriptors[0]!.name),
      false,
      'principal/owner SQL shapes require distinct names',
    );
    nativeAdmissionNames.add(descriptors[0]!.name);
    assert.equal(valuesSeen[0]?.[0], fixture.request.tenantId);
    (fixture.rows.key as Row).status = 'revoked';
    await assert.rejects(
      guard.revalidate(input),
      (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'AUTHORITY_MISMATCH',
    );
    assert.equal(descriptors.length, 2, 'cached statement must execute a fresh authority read');
    assert.equal(descriptors[0], descriptors[1]);
  });
}

test('admission native authority failure is not replayed anonymously', async () => {
  const fixture = makeFixture('byok');
  const database = new FakeDatabase(fixture);
  let preparedCalls = 0;
  const executor: SqlExecutor = {
    query: database.executor.query.bind(database.executor),
    async queryPrepared() {
      preparedCalls++;
      throw new Error('synthetic prepared failure');
    },
  };
  const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW });
  await assert.rejects(
    guard.revalidate({ executor, request: fixture.request, candidate: fixture.attempt, holdEvidence: null }),
    (error: unknown) => error instanceof PostgresRequestAdmissionGuardError && error.code === 'STORAGE_ERROR',
  );
  assert.equal(preparedCalls, 1);
  assert.equal(fixture.statements.filter((sql) => sql.includes('authority-batch')).length, 0);
  assert.equal(fixture.snapshot, null);
});

test('fenced reservation staging requires issued guard facts and is one-shot, invalidation-safe and scope-bound', async () => {
  const { prepareFencedReservation } = await import('../../../src/saas/gateway/fenced-reservation-plan.js');
  const { withPreparationTransactionFacts } = await import(
    '../../../src/saas/gateway/preparation-transaction-facts.js'
  );
  const { hasPreparationTransactionAuthority } = await import(
    '../../../src/saas/gateway/postgres-request-admission-guard.js'
  );
  const fixture = makeFixture('byok');
  fixture.attempt = {
    ...fixture.attempt,
    payloadSha256: HASH,
    requestFingerprint: HASH,
    requestFingerprintVersion: 'canonical-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
  };
  for (const [name, record] of [
    ['request', fixture.request],
    ['attempt', fixture.attempt],
  ] as const) {
    Object.assign(
      fixture.rows[name],
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          value,
        ]),
      ),
    );
  }
  Object.assign(fixture.rows.request, { execution_state: fixture.request.resultState });
  Object.assign(fixture.rows.attempt, {
    model_resolution_requested_model: 'model-a',
    model_resolution_mapped_model: 'model-a',
    model_resolution_mapping_source: 'none',
    model_resolution_mapping_version: null,
    provider_protocol: 'openai',
    client_operation: 'chat_completions',
    provider_operation: 'chat_completions',
  });
  const mappers = await import('../../../src/saas/metering/service.js');
  mappers.mapStoredRequestRecord(fixture.rows.request as Row);
  mappers.mapStoredAttemptRecord(fixture.rows.attempt as Row);
  const database = new FakeDatabase(fixture);
  const identity = {
    tenantId: fixture.request.tenantId,
    requestId: fixture.request.id,
    attemptId: fixture.attempt.id,
    payloadSha256: HASH,
  };
  const guard = new PostgresRequestAdmissionGuard(database, { now: () => NOW });
  let reads = 0,
    applies = 0,
    fallbacks = 0;
  const plan = (tx: SqlExecutor) =>
    prepareFencedReservation(
      tx,
      identity,
      async () => ++reads,
      async (read) => {
        applies++;
        return read;
      },
      async () => {
        fallbacks++;
        return -1;
      },
    );
  await withPreparationTransactionFacts(database.executor, identity, async (tx) => {
    assert.equal(hasPreparationTransactionAuthority(tx, identity), false);
    const unguarded = await plan(tx);
    assert.equal(reads, 0, 'a caller-created scope cannot stand in for held authority fences');
    assert.equal(await unguarded(), -1);
  });
  await withPreparationTransactionFacts(database.executor, identity, async (tx) => {
    await guard.revalidate({ executor: tx, request: fixture.request, candidate: fixture.attempt, holdEvidence: null });
    assert.equal(hasPreparationTransactionAuthority(tx, identity), true);
    for (const wrong of [
      { projectId: 'wrong' },
      { keyId: 'wrong' },
      { proxyKeyId: 'wrong' },
      { attemptId: 'wrong' },
      { supplyMode: 'platform' },
    ]) {
      assert.equal(hasPreparationTransactionAuthority(tx, { ...identity, ...wrong }), false);
      const wrongPlan = await prepareFencedReservation(
        tx,
        { ...identity, ...wrong },
        async () => {
          throw new Error('wrong identity must not stage reads');
        },
        async () => 0,
        async () => -2,
      );
      assert.equal(await wrongPlan(), -2);
    }
    const prepared = await plan(tx);
    assert.equal(reads, 1);
    assert.equal(applies, 0, 'read planning must not execute any reservation');
    assert.equal(await prepared(), 1);
    await assert.rejects(prepared(), /already been consumed/);
  });
  const mutating: SqlExecutor = {
    query: (sql, values) =>
      sql === 'UPDATE staged_authority'
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : database.executor.query(sql, values),
  };
  await withPreparationTransactionFacts(mutating, identity, async (tx) => {
    await guard.revalidate({ executor: tx, request: fixture.request, candidate: fixture.attempt, holdEvidence: null });
    const prepared = await plan(tx);
    await tx.query('UPDATE staged_authority');
    assert.equal(await prepared(), -1, 'unknown writes force the original fresh reserve in the live scope');
  });
  await withPreparationTransactionFacts(mutating, identity, async (tx) => {
    await guard.revalidate({ executor: tx, request: fixture.request, candidate: fixture.attempt, holdEvidence: null });
    const duringApply = await prepareFencedReservation(
      tx,
      identity,
      async () => 1,
      async () => {
        await tx.query('UPDATE staged_authority');
        return 1;
      },
      async () => {
        throw new Error('must not retry after a mutation');
      },
    );
    await assert.rejects(duringApply(), /authority changed during apply/);
  });
  let escaped: (() => Promise<number>) | undefined;
  await withPreparationTransactionFacts(database.executor, identity, async (tx) => {
    await guard.revalidate({ executor: tx, request: fixture.request, candidate: fixture.attempt, holdEvidence: null });
    escaped = await plan(tx);
  });
  assert.ok(escaped);
  await assert.rejects(escaped(), /scope has ended/);
  assert.equal(applies, 1);
  assert.equal(fallbacks, 2, 'an ended scope must not fall back to the pooled executor');
});
