import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  canonicalPreparedRequestEvidencePayload,
  type PreparedRequestEvidenceInput,
  SaasPreparedRequestEvidenceError,
  SaasPreparedRequestEvidenceService,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';

const CLOCK = new Date('2026-09-28T00:00:00.000Z');
const KEY_ID = 'prepared-verifier-1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function baseInput(): PreparedRequestEvidenceInput {
  return {
    evidenceId: 'evidence-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    proxyKeyId: 'key-1',
    entitlementId: 'entitlement-1',
    entitlementVersion: '1',
    supplyProfileId: 'profile-1',
    supplyProfileVersion: '1',
    modelScopeVersion: '1',
    supplyMode: 'byok',
    principalKind: 'member',
    principalId: 'user-1',
    authzVersion: '1',
    configVersion: '1',
    projectPolicyVersion: '1',
    publicModel: 'claude-test',
    modelResolution: {
      requestedModel: 'claude-test',
      mappedModel: 'provider-model-1',
      resolvedModel: 'provider-model-1',
      mappingSource: 'alias',
      mappingVersion: 7,
    },
    protocol: 'anthropic',
    clientProtocol: 'anthropic',
    providerProtocol: 'anthropic',
    clientOperation: 'messages',
    providerOperation: 'messages',
    endpoint: '/v1/messages',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-1',
    routePublicModelVersion: '1',
    routeProtocol: 'anthropic',
    routeTargetMode: 'tenant_account',
    routeUpstreamId: 'upstream-1',
    upstreamId: 'upstream-1',
    accountOwnerKind: 'tenant',
    accountId: 'account-1',
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: 'provider-model-1',
    dispatchProfileId: 'profile-1',
    supplyProfileAuthzVersion: '1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    profileAccountAuthzVersion: '1',
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
    customerMeteringPolicyId: 'customer-policy-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-1',
    customerPriceVersion: 'price-1',
    supplierCostVersion: null,
    requestFingerprint: 'd'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    payloadSha256: 'a'.repeat(64),
    usage: {
      inputTotalUpperBound: '100',
      inputUncachedUpperBound: '100',
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '50',
      reasoningOutputUpperBound: '50',
      feasibleInputBuckets: ['input'],
    },
    maxHoldCurrency: null,
    maxHoldMinorUnits: '0',
    dispatchDeadline: '2026-09-28T00:10:00.000Z',
    expiresAt: '2026-09-28T00:15:00.000Z',
    retryBudget: 2,
    verifierKeyId: KEY_ID,
    signatureBase64: 'placeholder',
    audit: {
      actorUserId: 'system-user',
      entryPoint: 'test',
      sourceIp: null,
      userAgent: null,
      requestId: null,
    },
  };
}

function signedInput(overrides: Partial<PreparedRequestEvidenceInput> = {}): PreparedRequestEvidenceInput {
  const unsigned = { ...baseInput(), ...overrides, signatureBase64: 'placeholder' };
  const payload = canonicalPreparedRequestEvidencePayload(unsigned);
  return {
    ...unsigned,
    signatureBase64: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  };
}

function rowFromInput(input: PreparedRequestEvidenceInput, statementSha256: string): Record<string, unknown> {
  return {
    id: input.evidenceId,
    schema_version: 1,
    tenant_id: input.tenantId,
    project_id: input.projectId,
    request_id: input.requestId,
    attempt_id: input.attemptId,
    attempt_ordinal: input.attemptOrdinal,
    proxy_key_id: input.proxyKeyId,
    entitlement_id: input.entitlementId,
    entitlement_version: input.entitlementVersion,
    supply_profile_id: input.supplyProfileId,
    supply_profile_version: input.supplyProfileVersion,
    model_scope_version: input.modelScopeVersion,
    supply_mode: input.supplyMode,
    principal_kind: input.principalKind,
    principal_id: input.principalId,
    authz_version: input.authzVersion,
    config_version: input.configVersion,
    project_policy_version: input.projectPolicyVersion,
    public_model: input.publicModel,
    protocol: input.protocol,
    model_resolution_requested_model: input.modelResolution?.requestedModel,
    model_resolution_mapped_model: input.modelResolution?.mappedModel,
    model_resolution_mapping_source: input.modelResolution?.mappingSource,
    model_resolution_mapping_version: input.modelResolution?.mappingVersion,
    provider_protocol: input.providerProtocol,
    client_operation: input.clientOperation,
    provider_operation: input.providerOperation,
    request_fingerprint: input.requestFingerprint,
    request_fingerprint_version: input.requestFingerprintVersion,
    payload_compiler_version: input.payloadCompilerVersion,
    usage_estimator_version: input.usageEstimatorVersion,
    endpoint: input.endpoint,
    route_config_id: input.routeConfigId,
    route_config_version: input.routeConfigVersion,
    route_public_model_id: input.routePublicModelId,
    route_public_model_version: input.routePublicModelVersion,
    route_protocol: input.routeProtocol,
    route_target_mode: input.routeTargetMode,
    route_upstream_id: input.routeUpstreamId,
    upstream_id: input.upstreamId,
    account_owner_kind: input.accountOwnerKind,
    account_id: input.accountId,
    provider_id: input.providerId,
    product_id: input.productId,
    resolved_model: input.resolvedModel,
    dispatch_profile_id: input.dispatchProfileId,
    supply_profile_authz_version: input.supplyProfileAuthzVersion,
    credential_id: input.credentialId,
    credential_version: input.credentialVersion,
    credential_authz_version: input.credentialAuthzVersion,
    account_authz_version: input.accountAuthzVersion,
    profile_account_authz_version: input.profileAccountAuthzVersion,
    pool_id: input.poolId,
    pool_authz_version: input.poolAuthzVersion,
    pool_member_account_authz_version: input.poolMemberAccountAuthzVersion,
    pool_member_authz_version: input.poolMemberAuthzVersion,
    pool_grant_authz_version: input.poolGrantAuthzVersion,
    pool_grant_profile_authz_version: input.poolGrantProfileAuthzVersion,
    pool_grant_pool_authz_version: input.poolGrantPoolAuthzVersion,
    customer_metering_policy_id: input.customerMeteringPolicyId,
    customer_metering_policy_version: input.customerMeteringPolicyVersion,
    provider_metering_policy_id: input.providerMeteringPolicyId,
    provider_metering_policy_version: input.providerMeteringPolicyVersion,
    contract_attestation_id: input.contractAttestationId,
    customer_price_version: input.customerPriceVersion,
    supplier_cost_version: input.supplierCostVersion,
    payload_sha256: input.payloadSha256,
    usage_input_total_upper_bound: input.usage.inputTotalUpperBound,
    usage_input_uncached_upper_bound: input.usage.inputUncachedUpperBound,
    usage_cache_read_upper_bound: input.usage.cacheReadUpperBound,
    usage_cache_write_upper_bound: input.usage.cacheWriteUpperBound,
    usage_cache_write_5m_upper_bound: input.usage.cacheWrite5mUpperBound,
    usage_cache_write_1h_upper_bound: input.usage.cacheWrite1hUpperBound,
    usage_output_total_upper_bound: input.usage.outputTotalUpperBound,
    usage_reasoning_output_upper_bound: input.usage.reasoningOutputUpperBound,
    usage_feasible_input_buckets: [...input.usage.feasibleInputBuckets],
    max_hold_currency: input.maxHoldCurrency,
    max_hold_minor_units: input.maxHoldMinorUnits,
    dispatch_deadline: input.dispatchDeadline,
    expires_at: input.expiresAt,
    retry_budget: input.retryBudget,
    verifier_key_id: input.verifierKeyId,
    signature_base64: input.signatureBase64,
    statement_sha256: statementSha256,
    status: 'registered',
    claimed_at: null,
    claimed_attempt_id: null,
  };
}

class FakeExecutor implements SqlExecutor {
  readonly stages: string[] = [];
  readonly statements: string[] = [];
  readonly fenceKeys: string[] = [];
  transactionCalls = 0;
  readonly rows: Record<string, unknown>;
  evidence: Record<string, unknown>;
  lockHintOverride: Record<string, unknown> | null = null;
  attemptEvidenceId: string | null = null;
  failAudit = false;
  lastEvidenceInsertValues: readonly unknown[] | null = null;
  readonly auditActorIds: unknown[] = [];

  constructor(readonly input: PreparedRequestEvidenceInput) {
    const statementSha256 = 'b'.repeat(64);
    this.evidence = { ...rowFromInput(input, statementSha256), status: 'pending' };
    this.rows = {
      tenant: { id: input.tenantId, status: 'active' },
      project: {
        tenant_id: input.tenantId,
        id: input.projectId,
        inference_policy_version: input.projectPolicyVersion,
        inference_policy_status: 'active',
      },
      'project-policy': {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        version: input.projectPolicyVersion,
        status: 'active',
      },
      principal: { id: input.principalId, disabled_at: null, anonymized_at: null },
      'tenant-membership': [{ status: 'active', revoked_at: null, role: 'developer' }],
      'project-membership': [{ status: 'active', revoked_at: null, role: 'developer' }],
      key: {
        principal_user_id: input.principalKind === 'member' ? input.principalId : null,
        execution_principal_type: input.principalKind,
        execution_principal_id: input.principalId,
        entitlement_id: input.entitlementId,
        supply_profile_id: input.supplyProfileId,
        supply_mode: input.supplyMode,
        authz_version: input.authzVersion,
        entitlement_authz_version: input.entitlementVersion,
        supply_profile_authz_version: input.supplyProfileVersion,
        model_scope_version: input.modelScopeVersion,
        model_scopes: [input.publicModel],
        status: 'active',
        revoked_at: null,
        expires_at: null,
      },
      request: this.requestRow(input),
      attempt: this.attemptRow(input),
      entitlement: {
        authz_version: input.entitlementVersion,
        supply_profile_id: input.supplyProfileId,
        supply_mode: input.supplyMode,
        status: 'active',
        effective_at: '2026-01-01T00:00:00.000Z',
        expires_at: null,
        superseded_at: null,
      },
      profile: { status: 'active', authz_version: input.supplyProfileVersion },
      route: {
        route_id: input.routeConfigId,
        version: input.routeConfigVersion,
        status: 'active',
        public_model_id: input.routePublicModelId,
        public_model_version: input.routePublicModelVersion,
        protocol: input.routeProtocol,
        target_mode: input.routeTargetMode,
        upstream_id: input.routeUpstreamId,
        endpoint: input.endpoint,
      },
      commercial: {
        customer_policy_id: input.customerMeteringPolicyId,
        customer_policy_version: input.customerMeteringPolicyVersion,
        provider_policy_id: input.providerMeteringPolicyId,
        provider_policy_version: input.providerMeteringPolicyVersion,
        contract_attestation_id: input.contractAttestationId,
        customer_price_version: input.customerPriceVersion,
        supplier_cost_version: input.supplierCostVersion,
      },
      attestation: { id: input.contractAttestationId, verification_result: 'verified' },
      account: {
        status: 'active',
        validation_state: 'verified',
        authz_version: input.accountAuthzVersion,
        provider_id: input.providerId,
        product_id: input.productId,
      },
      credential: {
        status: 'active',
        validation_state: 'verified',
        authz_version: input.credentialAuthzVersion,
        current_version: input.credentialVersion,
        expires_at: null,
      },
      mapping: {
        status: 'active',
        authz_version: input.profileAccountAuthzVersion,
        account_authz_version: input.accountAuthzVersion,
      },
      'customer-price': { id: input.customerPriceVersion },
    };
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(sql);
    const match = sql.match(/\/\* prepared-evidence:([^ ]+) \*\//);
    const stage = match?.[1] ?? '';
    if (stage) this.stages.push(stage);
    if (sql.includes('pg_advisory_xact_lock_shared')) this.fenceKeys.push(String(values[0]));
    if (sql.includes('SELECT clock_timestamp()')) {
      return { rows: [{ locked_at: CLOCK }] as Row[], rowCount: 1 };
    }
    if (stage === 'evidence-lock-hint') {
      return {
        rows: [this.lockHintOverride ?? this.evidence] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT * FROM saas_prepared_request_evidence')) {
      return { rows: [this.evidence] as Row[], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO saas_prepared_request_evidence')) {
      this.lastEvidenceInsertValues = [...values];
      this.evidence = { ...this.evidence, status: 'registered' };
      return {
        rows: [
          {
            id: this.input.evidenceId,
            status: 'registered',
            claimed_at: null,
            claimed_attempt_id: null,
            expires_at: this.input.expiresAt,
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO saas_audit_events')) {
      if (this.failAudit) throw new Error('audit unavailable');
      this.auditActorIds.push(values[2] ?? null);
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes('SET prepared_evidence_id')) {
      this.attemptEvidenceId = String(values[2]);
      return { rows: [{ id: this.input.attemptId }] as Row[], rowCount: 1 };
    }
    if (sql.includes("SET status = 'claimed'")) {
      this.evidence = {
        ...this.evidence,
        status: 'claimed',
        claimed_at: CLOCK.toISOString(),
        claimed_attempt_id: this.input.attemptId,
      };
      return {
        rows: [
          {
            id: this.input.evidenceId,
            status: 'claimed',
            claimed_at: CLOCK.toISOString(),
            claimed_attempt_id: this.input.attemptId,
            expires_at: this.input.expiresAt,
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (stage === 'tenant-membership' || stage === 'project-membership') {
      return { rows: this.rows[stage] as Row[], rowCount: 1 };
    }
    if (stage === 'evidence') return { rows: [this.evidence] as Row[], rowCount: 1 };
    if (stage === 'attempt-claim') {
      return { rows: [this.attemptRow(this.input)] as Row[], rowCount: 1 };
    }
    const row = this.rows[stage];
    if (Array.isArray(row)) return { rows: row as Row[], rowCount: row.length };
    return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
  }

  private requestRow(input: PreparedRequestEvidenceInput): Record<string, unknown> {
    return {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      proxy_key_id: input.proxyKeyId,
      entitlement_id: input.entitlementId,
      entitlement_version: input.entitlementVersion,
      supply_profile_id: input.supplyProfileId,
      supply_profile_version: input.supplyProfileVersion,
      model_scope_version: input.modelScopeVersion,
      supply_mode: input.supplyMode,
      principal_kind: input.principalKind,
      principal_id: input.principalId,
      authz_version: input.authzVersion,
      config_version: input.configVersion,
      project_policy_version: input.projectPolicyVersion,
      public_model: input.publicModel,
      protocol: input.protocol,
      request_fingerprint: input.requestFingerprint,
      request_fingerprint_version: input.requestFingerprintVersion,
      endpoint: input.endpoint,
      route_config_id: input.routeConfigId,
      route_config_version: input.routeConfigVersion,
      route_public_model_id: input.routePublicModelId,
      route_public_model_version: input.routePublicModelVersion,
      route_protocol: input.routeProtocol,
      route_target_mode: input.routeTargetMode,
      route_upstream_id: input.routeUpstreamId,
      customer_metering_policy_id: input.customerMeteringPolicyId,
      customer_metering_policy_version: input.customerMeteringPolicyVersion,
      provider_metering_policy_id: input.providerMeteringPolicyId,
      provider_metering_policy_version: input.providerMeteringPolicyVersion,
      contract_attestation_id: input.contractAttestationId,
      customer_price_version: input.customerPriceVersion,
    };
  }

  private attemptRow(input: PreparedRequestEvidenceInput): Record<string, unknown> {
    return {
      request_id: input.requestId,
      ordinal: input.attemptOrdinal,
      upstream_id: input.upstreamId,
      account_id: input.accountId,
      provider_id: input.providerId,
      product_id: input.productId,
      resolved_model: input.resolvedModel,
      protocol: input.protocol,
      model_resolution_requested_model: input.modelResolution?.requestedModel,
      model_resolution_mapped_model: input.modelResolution?.mappedModel,
      model_resolution_mapping_source: input.modelResolution?.mappingSource,
      model_resolution_mapping_version: input.modelResolution?.mappingVersion,
      provider_protocol: input.providerProtocol,
      client_operation: input.clientOperation,
      provider_operation: input.providerOperation,
      request_fingerprint: input.requestFingerprint,
      request_fingerprint_version: input.requestFingerprintVersion,
      payload_compiler_version: input.payloadCompilerVersion,
      usage_estimator_version: input.usageEstimatorVersion,
      payload_sha256: input.payloadSha256,
      endpoint: input.endpoint,
      supplier_cost_version: input.supplierCostVersion,
      dispatch_profile_id: input.dispatchProfileId,
      supply_profile_authz_version: input.supplyProfileAuthzVersion,
      credential_id: input.credentialId,
      credential_version: input.credentialVersion,
      credential_authz_version: input.credentialAuthzVersion,
      account_authz_version: input.accountAuthzVersion,
      pool_id: input.poolId,
      pool_authz_version: input.poolAuthzVersion,
      pool_member_account_authz_version: input.poolMemberAccountAuthzVersion,
      pool_member_authz_version: input.poolMemberAuthzVersion,
      pool_grant_authz_version: input.poolGrantAuthzVersion,
      pool_grant_profile_authz_version: input.poolGrantProfileAuthzVersion,
      pool_grant_pool_authz_version: input.poolGrantPoolAuthzVersion,
      profile_account_authz_version: input.profileAccountAuthzVersion,
      route_config_id: input.routeConfigId,
      route_config_version: input.routeConfigVersion,
      route_public_model_id: input.routePublicModelId,
      route_public_model_version: input.routePublicModelVersion,
      route_protocol: input.routeProtocol,
      route_target_mode: input.routeTargetMode,
      project_policy_version: input.projectPolicyVersion,
      customer_metering_policy_id: input.customerMeteringPolicyId,
      customer_metering_policy_version: input.customerMeteringPolicyVersion,
      provider_metering_policy_id: input.providerMeteringPolicyId,
      provider_metering_policy_version: input.providerMeteringPolicyVersion,
      contract_attestation_id: input.contractAttestationId,
      customer_price_version: input.customerPriceVersion,
      dispatch_state: 'not_sent',
      dispatch_authority_state: 'bound',
      prepared_evidence_id: this.attemptEvidenceId,
    };
  }
}

class LockOrderFakeExecutor extends FakeExecutor {
  private lastLockRank = 0;

  override async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const stage = sql.match(/\/\* prepared-evidence:([^ ]+) \*\//)?.[1] ?? '';
    const rank =
      stage === 'attempt'
        ? 1
        : stage === 'evidence-preflight' || stage === 'evidence-claim'
          ? 2
          : stage === 'pool'
            ? 3
            : 0;
    if (rank > 0) {
      assert.ok(rank >= this.lastLockRank, `lock order regressed at ${stage}`);
      this.lastLockRank = rank;
      await Promise.resolve();
    }
    return super.query<Row>(sql, values);
  }
}

function makeDatabase(fake: FakeExecutor): SaasDatabase {
  return {
    query: fake.query.bind(fake),
    transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      fake.transactionCalls += 1;
      const evidence = { ...fake.evidence };
      const attemptEvidenceId = fake.attemptEvidenceId;
      try {
        return await work(fake);
      } catch (error) {
        fake.evidence = evidence;
        fake.attemptEvidenceId = attemptEvidenceId;
        throw error;
      }
    },
  } as unknown as SaasDatabase;
}

function service(fake: FakeExecutor, keys: ReadonlyMap<string, typeof publicKey> = new Map([[KEY_ID, publicKey]])) {
  return new SaasPreparedRequestEvidenceService(makeDatabase(fake), {
    trustedVerifierPublicKeys: keys,
  });
}

async function expectCode(action: Promise<unknown>, code: SaasPreparedRequestEvidenceError['code']): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === code,
  );
}

test('register verifies a real Ed25519 statement and locks authorities before insert', async () => {
  const input = signedInput();
  const fake = new FakeExecutor(input);
  const result = await service(fake).register(input);
  assert.equal(result.status, 'registered');
  assert.deepEqual(result.modelResolution, input.modelResolution);
  assert.equal(result.providerProtocol, input.providerProtocol);
  assert.equal(result.clientOperation, input.clientOperation);
  assert.equal(result.providerOperation, input.providerOperation);
  assert.equal(result.requestFingerprint, input.requestFingerprint);
  assert.equal(result.requestFingerprintVersion, input.requestFingerprintVersion);
  assert.equal(result.payloadCompilerVersion, input.payloadCompilerVersion);
  assert.equal(result.usageEstimatorVersion, input.usageEstimatorVersion);
  assert.deepEqual(fake.lastEvidenceInsertValues?.slice(21, 32), [
    input.modelResolution?.requestedModel,
    input.modelResolution?.mappedModel,
    input.modelResolution?.mappingSource,
    input.modelResolution?.mappingVersion,
    input.providerProtocol,
    input.clientOperation,
    input.providerOperation,
    input.requestFingerprint,
    input.requestFingerprintVersion,
    input.payloadCompilerVersion,
    input.usageEstimatorVersion,
  ]);
  assert.ok(fake.stages.indexOf('clock') > fake.stages.indexOf('customer-price'));
  const authorityStages = fake.stages.filter((stage) => !stage.startsWith('fence-'));
  assert.deepEqual(authorityStages.slice(0, 8), [
    'tenant',
    'project',
    'project-policy',
    'principal',
    'tenant-membership',
    'project-membership',
    'key',
    'request',
  ]);
  const firstAuthorityRead = fake.statements.findIndex((sql) => /FROM saas_tenants/i.test(sql));
  const lastFence = Math.max(...fake.statements.map((sql, index) => (sql.includes('pg_advisory') ? index : -1)));
  assert.ok(lastFence >= 0 && lastFence < firstAuthorityRead);
  const projectHeadSql = fake.statements.find((sql) => /FROM saas_projects/i.test(sql)) ?? '';
  const policyVersionSql =
    fake.statements.find((sql) => /FROM saas_project_inference_policy_versions/i.test(sql)) ?? '';
  assert.doesNotMatch(projectHeadSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  assert.match(policyVersionSql, /tenant_id = \$1 AND project_id = \$2 AND version = \$3/i);
  assert.doesNotMatch(policyVersionSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

test('register joins a supplied outer executor without opening a nested transaction', async () => {
  const input = signedInput();
  const fake = new FakeExecutor(input);
  const result = await service(fake).register(input, { executor: fake });

  assert.equal(result.status, 'registered');
  assert.equal(fake.transactionCalls, 0);
});

test('unknown key, bad signature, payload tamper and authority mismatch fail closed', async () => {
  const input = signedInput();
  await expectCode(service(new FakeExecutor(input), new Map()).register(input), 'UNKNOWN_VERIFIER_KEY');
  await expectCode(
    service(new FakeExecutor(input)).register({ ...input, signatureBase64: `${input.signatureBase64.slice(0, -2)}AA` }),
    'SIGNATURE_INVALID',
  );
  await expectCode(
    service(new FakeExecutor(input)).register({ ...input, payloadSha256: 'b'.repeat(64) }),
    'SIGNATURE_INVALID',
  );
  const mismatch = new FakeExecutor(input);
  (mismatch.rows.key as Record<string, unknown>).authz_version = '2';
  await expectCode(service(mismatch).register(input), 'AUTHORITY_MISMATCH');
});

test('029 provenance is required and remains bound across stored reads and revalidation', async () => {
  const input = signedInput();
  const missingEstimator = signedInput({ usageEstimatorVersion: undefined });
  await expectCode(service(new FakeExecutor(missingEstimator)).register(missingEstimator), 'AUTHORITY_MISMATCH');

  assert.throws(
    () => signedInput({ modelResolution: undefined }),
    (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'AUTHORITY_MISMATCH',
  );

  const fake = new FakeExecutor(input);
  const evidenceService = service(fake);
  const registered = await evidenceService.register(input);
  fake.evidence.statement_sha256 = registered.statementSha256;
  (fake.rows.attempt as Record<string, unknown>).model_resolution_mapping_version = 8;
  await expectCode(
    evidenceService.preflightForDispatch(input.evidenceId ?? '', input.audit, { payloadSha256: input.payloadSha256 }),
    'AUTHORITY_MISMATCH',
  );

  const missingStoredField = new FakeExecutor(input);
  const missingStoredService = service(missingStoredField);
  const stored = await missingStoredService.register(input);
  missingStoredField.evidence.statement_sha256 = stored.statementSha256;
  missingStoredField.evidence.usage_estimator_version = null;
  await expectCode(missingStoredService.preflightForDispatch(input.evidenceId ?? '', input.audit), 'STORAGE_ERROR');
});

test('member authority remains membership-bound while project-service evidence ignores creator membership', async () => {
  const input = signedInput();
  const anonymized = new FakeExecutor(input);
  (anonymized.rows.principal as Record<string, unknown>).anonymized_at = CLOCK.toISOString();
  await expectCode(service(anonymized).register(input), 'AUTHORITY_MISMATCH');

  const viewer = new FakeExecutor(input);
  viewer.rows['tenant-membership'] = [{ status: 'active', revoked_at: null, role: 'viewer' }];
  await expectCode(service(viewer).register(input), 'AUTHORITY_MISMATCH');

  const projectService = signedInput({
    principalKind: 'project_service',
    principalId: input.projectId,
    audit: { ...input.audit, actorUserId: null },
  });
  const projectServiceFake = new FakeExecutor(projectService);
  projectServiceFake.rows['tenant-membership'] = [];
  projectServiceFake.rows['project-membership'] = [];
  const projectServiceEvidence = service(projectServiceFake);
  const registered = await projectServiceEvidence.register(projectService);
  projectServiceFake.evidence.statement_sha256 = registered.statementSha256;
  assert.equal(
    (await projectServiceEvidence.claimForDispatch(projectService.evidenceId ?? '', projectService.audit)).status,
    'claimed',
  );
  assert.equal(projectServiceFake.stages.includes('principal'), false);
  assert.equal(projectServiceFake.stages.includes('tenant-membership'), false);
  assert.equal(projectServiceFake.stages.includes('project-membership'), false);
  assert.ok(projectServiceFake.auditActorIds.length > 0);
  assert.ok(projectServiceFake.auditActorIds.every((actorUserId) => actorUserId === null));

  const suspendedFake = new FakeExecutor(projectService);
  const suspendedEvidenceService = service(suspendedFake);
  const suspendedRegistration = await suspendedEvidenceService.register(projectService);
  suspendedFake.evidence.statement_sha256 = suspendedRegistration.statementSha256;
  (suspendedFake.rows.project as Record<string, unknown>).inference_policy_status = 'suspended';
  (suspendedFake.rows['project-policy'] as Record<string, unknown>).status = 'suspended';
  await expectCode(
    suspendedEvidenceService.claimForDispatch(projectService.evidenceId ?? '', projectService.audit),
    'AUTHORITY_MISMATCH',
  );

  const overBound = {
    ...input,
    usage: { ...input.usage, reasoningOutputUpperBound: '51' },
  };
  await expectCode(service(new FakeExecutor(overBound)).register(overBound), 'INVALID_INPUT');
});

test('database clock rejects expired proof after all authority locks', async () => {
  const input = signedInput({
    dispatchDeadline: '2026-09-27T23:59:00.000Z',
    expiresAt: '2026-09-27T23:59:30.000Z',
  });
  const fake = new FakeExecutor(input);
  await expectCode(service(fake).register(input), 'EXPIRED');
  assert.equal(fake.stages.at(-1), 'clock');
});

test('claim is atomic, audited and cannot be repeated; audit failure rolls back', async () => {
  const input = signedInput();
  const fake = new FakeExecutor(input);
  const registered = await service(fake).register(input);
  assert.equal(registered.status, 'registered');
  fake.evidence.statement_sha256 = registered.statementSha256;
  await expectCode(
    service(fake).claimForDispatch(input.evidenceId ?? '', input.audit, {
      payloadSha256: 'b'.repeat(64),
    }),
    'AUTHORITY_MISMATCH',
  );
  assert.equal(fake.evidence.status, 'registered');
  const claimed = await service(fake).claimForDispatch(input.evidenceId ?? '', input.audit);
  assert.equal(claimed.status, 'claimed');
  const claimEvidenceIndex = fake.stages.lastIndexOf('evidence-claim');
  assert.ok(claimEvidenceIndex > fake.stages.lastIndexOf('attempt'));
  assert.equal(fake.attemptEvidenceId, input.evidenceId);
  await expectCode(service(fake).claimForDispatch(input.evidenceId ?? '', input.audit), 'ALREADY_CLAIMED');

  const rollbackFake = new FakeExecutor(input);
  rollbackFake.failAudit = true;
  await expectCode(service(rollbackFake).register(input), 'AUDIT_FAILED');
  assert.equal(rollbackFake.evidence.status, 'pending');
  assert.equal(rollbackFake.attemptEvidenceId, null);
});

test('legacy identity evidence is readable only when all 029 provenance is absent', async () => {
  const input = signedInput({
    publicModel: 'identity-model',
    modelResolution: undefined,
    clientProtocol: undefined,
    providerProtocol: undefined,
    clientOperation: undefined,
    providerOperation: undefined,
    requestFingerprint: undefined,
    requestFingerprintVersion: undefined,
    payloadCompilerVersion: undefined,
    usageEstimatorVersion: undefined,
    resolvedModel: 'identity-model',
  });
  const fake = new FakeExecutor(input);
  fake.evidence.status = 'registered';
  fake.evidence.statement_sha256 = createHash('sha256')
    .update(canonicalPreparedRequestEvidencePayload(input), 'utf8')
    .digest('hex');
  (fake.rows.attempt as Record<string, unknown>).payload_sha256 = null;

  const result = await service(fake).preflightForDispatch(input.evidenceId ?? '', input.audit);
  assert.equal(result.status, 'registered');
  assert.equal(result.modelResolution, undefined);
  assert.equal(result.protocol, input.protocol);
});

test('read-only preflight leaves evidence registered and claim revalidates current authority', async () => {
  const input = signedInput();
  const fake = new FakeExecutor(input);
  const evidenceService = service(fake);
  const registered = await evidenceService.register(input);
  fake.evidence.statement_sha256 = registered.statementSha256;

  const preflight = await evidenceService.preflightForDispatch(input.evidenceId ?? '', input.audit, {
    payloadSha256: input.payloadSha256,
  });
  assert.equal(preflight.status, 'registered');
  assert.equal(fake.evidence.status, 'registered');
  assert.equal(fake.attemptEvidenceId, null);
  assert.ok(fake.stages.lastIndexOf('evidence-preflight') > fake.stages.lastIndexOf('attempt'));

  (fake.rows.key as Record<string, unknown>).status = 'revoked';
  await expectCode(
    evidenceService.claimForDispatch(input.evidenceId ?? '', input.audit, { payloadSha256: input.payloadSha256 }),
    'AUTHORITY_MISMATCH',
  );
  assert.equal(fake.evidence.status, 'registered');
  assert.equal(fake.attemptEvidenceId, null);
});

test('evidence-id preflight fences before row reread and rejects stale digest context', async () => {
  const input = signedInput();
  const fake = new FakeExecutor(input);
  const evidenceService = service(fake);
  const registered = await evidenceService.register(input);
  fake.evidence.statement_sha256 = registered.statementSha256;
  const dispatchStart = fake.statements.length;
  fake.lockHintOverride = {
    ...fake.evidence,
    payload_sha256: 'c'.repeat(64),
  };

  await expectCode(
    evidenceService.preflightForDispatch(input.evidenceId ?? '', input.audit, {
      payloadSha256: input.payloadSha256,
    }),
    'AUTHORITY_MISMATCH',
  );

  const dispatchStatements = fake.statements.slice(dispatchStart);
  const indexOf = (pattern: RegExp): number => dispatchStatements.findIndex((sql) => pattern.test(sql));
  const hintIndex = indexOf(/prepared-evidence:evidence-lock-hint/);
  const firstFenceIndex = indexOf(/pg_advisory_xact_lock_shared/);
  const requestIndex = indexOf(/FROM saas_requests/);
  const attemptIndex = indexOf(/FROM saas_attempts/);
  const evidenceIndex = indexOf(/prepared-evidence:evidence-preflight/);
  assert.ok(hintIndex >= 0 && hintIndex < firstFenceIndex);
  assert.ok(firstFenceIndex < requestIndex);
  assert.ok(firstFenceIndex < attemptIndex);
  assert.ok(firstFenceIndex < evidenceIndex);
  assert.equal(
    dispatchStatements.some((sql) => /FOR SHARE/i.test(sql)),
    false,
  );
});

test('concurrent fake claims preserve attempt-before-evidence lock order', async () => {
  const input = signedInput();
  const first = new LockOrderFakeExecutor(input);
  const second = new LockOrderFakeExecutor(input);
  const firstService = service(first);
  const secondService = service(second);
  const firstRegistered = await firstService.register(input);
  const secondRegistered = await secondService.register(input);
  first.evidence.statement_sha256 = firstRegistered.statementSha256;
  second.evidence.statement_sha256 = secondRegistered.statementSha256;

  const [firstClaim, secondClaim] = await Promise.all([
    firstService.claimForDispatch(input.evidenceId ?? '', input.audit),
    secondService.claimForDispatch(input.evidenceId ?? '', input.audit),
  ]);
  assert.equal(firstClaim.status, 'claimed');
  assert.equal(secondClaim.status, 'claimed');
  assert.ok(first.stages.lastIndexOf('evidence-claim') > first.stages.lastIndexOf('attempt'));
  assert.ok(second.stages.lastIndexOf('evidence-claim') > second.stages.lastIndexOf('attempt'));
});

test('PostgreSQL concurrent claim integration is skipped without a live test harness', {
  skip: process.env.SAAS_TEST_DATABASE_URL
    ? 'live PostgreSQL is intentionally not connected by this focused suite'
    : 'SAAS_TEST_DATABASE_URL is not configured; fake concurrency coverage is active',
}, () => {});

test('claim rechecks the current signed payload digest after read-only preflight', async () => {
  const input = signedInput();
  const fake = new FakeExecutor(input);
  const evidenceService = service(fake);
  const registered = await evidenceService.register(input);
  fake.evidence.statement_sha256 = registered.statementSha256;
  await evidenceService.preflightForDispatch(input.evidenceId ?? '', input.audit, {
    payloadSha256: input.payloadSha256,
  });

  const changed = signedInput({ payloadSha256: 'c'.repeat(64) });
  fake.evidence.payload_sha256 = changed.payloadSha256;
  fake.evidence.signature_base64 = changed.signatureBase64;
  fake.evidence.statement_sha256 = createHash('sha256')
    .update(canonicalPreparedRequestEvidencePayload(changed), 'utf8')
    .digest('hex');
  await expectCode(
    evidenceService.claimForDispatch(input.evidenceId ?? '', input.audit, { payloadSha256: input.payloadSha256 }),
    'AUTHORITY_MISMATCH',
  );
  assert.equal(fake.evidence.status, 'registered');
  assert.equal(fake.attemptEvidenceId, null);
});
