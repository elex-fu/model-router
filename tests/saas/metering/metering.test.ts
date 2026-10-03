import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATEWAY_METERING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/010_gateway_metering.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type CreateRequestInput,
  type RecordUsageEventInput,
  SaasMeteringError,
  SaasMeteringService,
  sha256Hex,
} from '../../../src/saas/metering/index.js';

type Row = Record<string, unknown>;

interface MemoryState {
  requests: Row[];
  idempotency: Row[];
  attempts: Row[];
  usage: Row[];
  settlements: Row[];
}

function emptyState(): MemoryState {
  return { requests: [], idempotency: [], attempts: [], usage: [], settlements: [] };
}

function compact(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function result<RowType>(rows: RowType[]): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

class MemoryDatabase implements SaasDatabase {
  private state: MemoryState = emptyState();

  dump(): MemoryState {
    return structuredClone(this.state);
  }

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    const statement = compact(sql);
    const rows = this.execute(statement, values);
    return result(rows as RowType[]);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async migrate(): Promise<void> {}

  async verifySchema(): Promise<void> {}

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  private execute(statement: string, values: readonly unknown[]): Row[] {
    if (statement.startsWith('INSERT INTO fake_downstream_writes')) {
      throw new Error('injected downstream failure');
    }
    if (statement.startsWith('INSERT INTO saas_idempotency_records')) return this.insertIdempotency(values);
    if (statement.startsWith('SELECT id, tenant_id, proxy_key_id, key_digest')) return this.selectIdempotency(values);
    if (statement.startsWith('INSERT INTO saas_requests')) return this.insertRequest(values);
    if (statement.startsWith('INSERT INTO saas_attempts')) return this.insertAttempt(values);
    if (
      statement.startsWith(
        'SELECT id, project_policy_version, customer_price_version, customer_metering_policy_id, customer_metering_policy_version, provider_metering_policy_id, provider_metering_policy_version, contract_attestation_id, route_config_id, route_config_version, route_public_model_id, route_public_model_version, route_protocol, route_target_mode, route_upstream_id, supply_mode, supply_profile_id, public_model, request_fingerprint, request_fingerprint_version, protocol, endpoint FROM saas_requests',
      )
    ) {
      return this.selectAttemptRequest(values);
    }
    if (statement.startsWith('SELECT id FROM saas_requests')) return this.selectRequestId(values);
    if (
      statement.startsWith('SELECT id FROM saas_attempts') &&
      statement.includes('WHERE tenant_id = $1 AND id = $2')
    ) {
      return this.selectAttemptIdentity(values);
    }
    if (statement.startsWith('SELECT id FROM saas_attempts')) return this.selectAttemptOrdinal(values);
    if (statement.startsWith('UPDATE saas_attempts')) return this.updateAttempt(values);
    if (statement.startsWith('UPDATE saas_requests') && statement.includes('execution_state = $3')) {
      return this.updateRequestExecution(values);
    }
    if (statement.startsWith('UPDATE saas_requests')) return this.updateRequestFinancial(values);
    if (statement.startsWith('SELECT a.id AS attempt_id')) return this.selectKnownHttpResponse(values);
    if (statement.startsWith('SELECT a.id, r.supply_mode')) return this.selectAttemptUsageScope(values);
    if (statement.startsWith('INSERT INTO saas_usage_events')) return this.insertUsage(values);
    if (statement.startsWith('SELECT id, tenant_id, request_id, attempt_id, event_digest')) {
      return this.selectUsageIdentity(values);
    }
    if (statement.startsWith('SELECT id, tenant_id, request_id, attempt_id, supply_mode')) {
      return this.selectUsage(statement, values);
    }
    if (statement.startsWith('INSERT INTO saas_usage_settlements')) return this.insertSettlement(values);
    if (statement.startsWith('SELECT id, tenant_id, usage_event_id')) return this.selectSettlement(values);
    if (statement.startsWith('SELECT r.id, r.tenant_id')) return this.selectRequest(statement, values);
    if (
      statement.startsWith(
        'SELECT id, tenant_id, request_id, project_policy_version, customer_price_version, customer_metering_policy_id',
      )
    ) {
      return this.selectAttempt(statement, values);
    }
    throw new Error(`Unexpected SQL in memory database: ${statement}`);
  }

  private insertIdempotency(values: readonly unknown[]): Row[] {
    const [id, tenantId, proxyKeyId, keyDigest, requestFingerprint, fingerprintVersion, requestId, createdAt] = values;
    if (
      this.state.idempotency.some(
        (row) => row.tenant_id === tenantId && row.proxy_key_id === proxyKeyId && row.key_digest === keyDigest,
      )
    ) {
      return [];
    }
    const row = {
      id,
      tenant_id: tenantId,
      proxy_key_id: proxyKeyId,
      key_digest: keyDigest,
      request_fingerprint: requestFingerprint,
      request_fingerprint_version: fingerprintVersion,
      request_id: requestId,
      kind: 'active',
      created_at: createdAt,
    };
    this.state.idempotency.push(row);
    return [row];
  }

  private selectIdempotency(values: readonly unknown[]): Row[] {
    const [tenantId, proxyKeyId, keyDigest] = values;
    return this.state.idempotency.filter(
      (row) => row.tenant_id === tenantId && row.proxy_key_id === proxyKeyId && row.key_digest === keyDigest,
    );
  }

  private insertRequest(values: readonly unknown[]): Row[] {
    const row = {
      id: values[0],
      tenant_id: values[1],
      project_id: values[2],
      project_policy_version: values[3],
      proxy_key_id: values[4],
      entitlement_id: values[5],
      supply_profile_id: values[6],
      supply_profile_version: values[7],
      model_scope_version: values[8],
      supply_mode: values[9],
      principal_kind: values[10],
      principal_id: values[11],
      authz_version: values[12],
      entitlement_version: values[13],
      config_version: values[14],
      customer_metering_policy_id: values[15],
      customer_metering_policy_version: values[16],
      provider_metering_policy_id: values[17],
      provider_metering_policy_version: values[18],
      contract_attestation_id: values[19],
      route_config_id: values[20],
      route_config_version: values[21],
      route_public_model_id: values[22],
      route_public_model_version: values[23],
      route_protocol: values[24],
      route_target_mode: values[25],
      route_upstream_id: values[26],
      public_model: values[27],
      protocol: values[28],
      endpoint: values[29],
      request_fingerprint: values[30],
      request_fingerprint_version: values[31],
      customer_price_version: values[32],
      execution_state: 'pending',
      financial_status: values[33],
      reconciliation_state: 'none',
      created_at: values[34],
      updated_at: values[34],
      state_version: 1,
    };
    this.state.requests.push(row);
    return [row];
  }

  private selectRequestId(values: readonly unknown[]): Row[] {
    const [tenantId, requestId] = values;
    return this.state.requests
      .filter((row) => row.tenant_id === tenantId && row.id === requestId)
      .map(({ id }) => ({ id }));
  }

  private selectAttemptRequest(values: readonly unknown[]): Row[] {
    const [tenantId, requestId] = values;
    return this.state.requests
      .filter((row) => row.tenant_id === tenantId && row.id === requestId)
      .map(
        ({
          id,
          project_policy_version,
          customer_price_version,
          customer_metering_policy_id,
          customer_metering_policy_version,
          provider_metering_policy_id,
          provider_metering_policy_version,
          contract_attestation_id,
          route_config_id,
          route_config_version,
          route_public_model_id,
          route_public_model_version,
          route_protocol,
          route_target_mode,
          route_upstream_id,
          supply_mode,
          supply_profile_id,
          public_model,
          request_fingerprint,
          request_fingerprint_version,
          protocol,
          endpoint,
        }) => ({
          id,
          project_policy_version,
          customer_price_version,
          customer_metering_policy_id,
          customer_metering_policy_version,
          provider_metering_policy_id,
          provider_metering_policy_version,
          contract_attestation_id,
          route_config_id,
          route_config_version,
          route_public_model_id,
          route_public_model_version,
          route_protocol,
          route_target_mode,
          route_upstream_id,
          supply_mode,
          supply_profile_id,
          public_model,
          request_fingerprint,
          request_fingerprint_version,
          protocol,
          endpoint,
        }),
      );
  }

  private insertAttempt(values: readonly unknown[]): Row[] {
    const row = {
      id: values[0],
      tenant_id: values[1],
      request_id: values[2],
      project_policy_version: values[3],
      customer_price_version: values[4],
      customer_metering_policy_id: values[5],
      customer_metering_policy_version: values[6],
      provider_metering_policy_id: values[7],
      provider_metering_policy_version: values[8],
      contract_attestation_id: values[9],
      route_config_id: values[10],
      route_config_version: values[11],
      route_public_model_id: values[12],
      route_public_model_version: values[13],
      route_protocol: values[14],
      route_target_mode: values[15],
      ordinal: values[16],
      upstream_id: values[17],
      binding_state: 'bound',
      dispatch_authority_state: 'bound',
      account_owner_kind: values[18],
      tenant_account_id: values[19],
      platform_account_id: values[20],
      account_id: values[19] ?? values[20],
      provider_id: values[21],
      product_id: values[22],
      resolved_model: values[23],
      protocol: values[24],
      endpoint: values[25],
      supplier_cost_version: values[26],
      dispatch_profile_id: values[27],
      supply_profile_authz_version: values[28],
      credential_id: values[29],
      credential_version: values[30],
      credential_authz_version: values[31],
      account_authz_version: values[32],
      pool_id: values[33],
      pool_authz_version: values[34],
      pool_member_account_authz_version: values[35],
      pool_member_authz_version: values[36],
      pool_grant_authz_version: values[37],
      pool_grant_profile_authz_version: values[38],
      pool_grant_pool_authz_version: values[39],
      profile_account_authz_version: values[40],
      model_resolution_requested_model: values[41],
      model_resolution_mapped_model: values[42],
      model_resolution_mapping_source: values[43],
      model_resolution_mapping_version: values[44],
      provider_protocol: values[45],
      client_operation: values[46],
      provider_operation: values[47],
      request_fingerprint: values[48],
      request_fingerprint_version: values[49],
      payload_compiler_version: values[50],
      usage_estimator_version: values[51],
      payload_sha256: values[52],
      dispatch_state: 'not_sent',
      result_state: 'pending',
      response_started: false,
      response_started_at: null,
      result_http_status: null,
      unknown_reason: null,
      created_at: values[53],
      updated_at: values[53],
      state_version: 1,
    };
    this.state.attempts.push(row);
    return [row];
  }

  private selectAttemptOrdinal(values: readonly unknown[]): Row[] {
    const [tenantId, requestId, ordinal] = values;
    return this.state.attempts
      .filter((row) => row.tenant_id === tenantId && row.request_id === requestId && row.ordinal === ordinal)
      .map(({ id }) => ({ id }));
  }

  private selectAttemptIdentity(values: readonly unknown[]): Row[] {
    const [tenantId, attemptId] = values;
    return this.state.attempts
      .filter((row) => row.tenant_id === tenantId && row.id === attemptId)
      .map(({ id }) => ({ id }));
  }

  private selectAttempt(statement: string, values: readonly unknown[]): Row[] {
    if (statement.includes('ORDER BY ordinal ASC')) {
      const [tenantId, requestId] = values;
      return this.state.attempts
        .filter((row) => row.tenant_id === tenantId && row.request_id === requestId)
        .sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
    }
    const [tenantId, requestId, attemptId] = values;
    return this.state.attempts.filter(
      (row) => row.tenant_id === tenantId && row.request_id === requestId && row.id === attemptId,
    );
  }

  private updateAttempt(values: readonly unknown[]): Row[] {
    const [
      tenantId,
      requestId,
      attemptId,
      dispatchState,
      resultState,
      responseStarted,
      updatedAt,
      hasHttpStatus,
      httpStatus,
      unknownReason,
      expectedDispatchState,
      expectedResultState,
      expectedResponseStarted,
      expectedVersion,
    ] = values;
    const row = this.state.attempts.find(
      (candidate) =>
        candidate.tenant_id === tenantId &&
        candidate.request_id === requestId &&
        candidate.id === attemptId &&
        candidate.dispatch_state === expectedDispatchState &&
        candidate.result_state === expectedResultState &&
        candidate.response_started === expectedResponseStarted &&
        (expectedVersion === null || candidate.state_version === expectedVersion),
    );
    if (!row) return [];
    row.dispatch_state = dispatchState;
    row.result_state = resultState;
    row.response_started = Boolean(row.response_started) || Boolean(responseStarted);
    if (!row.response_started_at && responseStarted) row.response_started_at = updatedAt;
    if (hasHttpStatus) row.result_http_status = httpStatus;
    row.unknown_reason = unknownReason;
    row.updated_at = updatedAt;
    row.state_version = Number(row.state_version) + 1;
    return [row];
  }

  private updateRequestExecution(values: readonly unknown[]): Row[] {
    const [
      tenantId,
      requestId,
      executionState,
      reconciliationState,
      updatedAt,
      expectedExecution,
      expectedRecon,
      expectedVersion,
    ] = values;
    const row = this.state.requests.find(
      (candidate) =>
        candidate.tenant_id === tenantId &&
        candidate.id === requestId &&
        candidate.execution_state === expectedExecution &&
        candidate.reconciliation_state === expectedRecon &&
        (expectedVersion === null || candidate.state_version === expectedVersion),
    );
    if (!row) return [];
    row.execution_state = executionState;
    row.reconciliation_state = reconciliationState;
    row.updated_at = updatedAt;
    row.state_version = Number(row.state_version) + 1;
    return [row];
  }

  private updateRequestFinancial(values: readonly unknown[]): Row[] {
    const [tenantId, requestId, financialStatus, updatedAt, expectedFinancial, expectedVersion] = values;
    const row = this.state.requests.find(
      (candidate) =>
        candidate.tenant_id === tenantId &&
        candidate.id === requestId &&
        candidate.financial_status === expectedFinancial &&
        (expectedVersion === null || candidate.state_version === expectedVersion),
    );
    if (!row) return [];
    row.financial_status = financialStatus;
    row.updated_at = updatedAt;
    row.state_version = Number(row.state_version) + 1;
    return [row];
  }

  private selectAttemptUsageScope(values: readonly unknown[]): Row[] {
    const [tenantId, requestId, attemptId] = values;
    const attempt = this.state.attempts.find(
      (row) => row.tenant_id === tenantId && row.request_id === requestId && row.id === attemptId,
    );
    const request = this.state.requests.find((row) => row.tenant_id === tenantId && row.id === requestId);
    return attempt && request ? [{ id: attempt.id, supply_mode: request.supply_mode }] : [];
  }

  private selectKnownHttpResponse(values: readonly unknown[]): Row[] {
    const [tenantId, requestId, attemptId] = values;
    const attempt = this.state.attempts.find(
      (row) => row.tenant_id === tenantId && row.request_id === requestId && row.id === attemptId,
    );
    const request = this.state.requests.find((row) => row.tenant_id === tenantId && row.id === requestId);
    if (!attempt || !request) return [];
    return [
      {
        attempt_id: attempt.id,
        attempt_tenant_id: attempt.tenant_id,
        attempt_request_id: attempt.request_id,
        attempt_dispatch_state: attempt.dispatch_state,
        attempt_result_state: attempt.result_state,
        attempt_result_http_status: attempt.result_http_status,
        attempt_response_started: attempt.response_started,
        attempt_state_version: attempt.state_version,
        request_id: request.id,
        request_tenant_id: request.tenant_id,
        request_supply_mode: request.supply_mode,
        request_result_state: request.execution_state,
        request_reconciliation_state: request.reconciliation_state,
        request_financial_status: request.financial_status,
        request_state_version: request.state_version,
      },
    ];
  }

  private insertUsage(values: readonly unknown[]): Row[] {
    const [, tenantId, , attemptId, , dedupeKeyDigest] = values;
    if (
      this.state.usage.some(
        (row) =>
          row.tenant_id === tenantId && row.attempt_id === attemptId && row.dedupe_key_digest === dedupeKeyDigest,
      )
    ) {
      return [];
    }
    const row = {
      id: values[0],
      tenant_id: values[1],
      request_id: values[2],
      attempt_id: values[3],
      supply_mode: values[4],
      dedupe_key_digest: values[5],
      event_digest: values[6],
      input_total: values[7],
      input_uncached: values[8],
      cache_read: values[9],
      cache_write: values[10],
      cache_write_5m: values[11],
      cache_write_1h: values[12],
      output_total: values[13],
      reasoning_output: values[14],
      status: values[15],
      source: values[16],
      semantics_version: values[17],
      measurement_kind: values[18],
      billable_basis: values[19],
      created_at: values[20],
    };
    this.state.usage.push(row);
    return [row];
  }

  private selectUsage(statement: string, values: readonly unknown[]): Row[] {
    if (statement.includes('attempt_id = $2 AND dedupe_key_digest = $3')) {
      const [tenantId, attemptId, dedupeKeyDigest] = values;
      return this.state.usage.filter(
        (row) =>
          row.tenant_id === tenantId && row.attempt_id === attemptId && row.dedupe_key_digest === dedupeKeyDigest,
      );
    }
    if (statement.includes('WHERE tenant_id = $1 AND id = $2')) {
      const [tenantId, usageEventId] = values;
      return this.state.usage.filter((row) => row.tenant_id === tenantId && row.id === usageEventId);
    }
    const [tenantId, requestId] = values;
    return this.state.usage
      .filter((row) => row.tenant_id === tenantId && row.request_id === requestId)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  }

  private selectUsageIdentity(values: readonly unknown[]): Row[] {
    const [tenantId, usageEventId] = values;
    return this.state.usage
      .filter((row) => row.tenant_id === tenantId && row.id === usageEventId)
      .map((row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        request_id: row.request_id,
        attempt_id: row.attempt_id,
        event_digest: row.event_digest,
      }));
  }

  private insertSettlement(values: readonly unknown[]): Row[] {
    const usageEventId = values[2];
    const tenantId = values[1];
    const settlementKeyDigest = values[5];
    if (
      this.state.settlements.some(
        (row) =>
          (row.tenant_id === tenantId && row.usage_event_id === usageEventId) ||
          (row.tenant_id === tenantId && row.settlement_key_digest === settlementKeyDigest),
      )
    ) {
      return [];
    }
    const row = {
      id: values[0],
      tenant_id: values[1],
      usage_event_id: values[2],
      request_id: values[3],
      attempt_id: values[4],
      settlement_key_digest: values[5],
      settlement_digest: values[6],
      kind: values[7],
      created_at: values[8],
      normal_success_evidence_ref: values[9],
    };
    this.state.settlements.push(row);
    return [row];
  }

  private selectSettlement(values: readonly unknown[]): Row[] {
    const [tenantId, usageEventId, settlementKeyDigest] = values;
    return this.state.settlements.filter(
      (row) =>
        row.tenant_id === tenantId &&
        (row.usage_event_id === usageEventId || row.settlement_key_digest === settlementKeyDigest),
    );
  }

  private selectRequest(statement: string, values: readonly unknown[]): Row[] {
    const [tenantId, secondValue, thirdValue] = values;
    const isList = statement.includes('ORDER BY r.created_at ASC, r.id ASC');
    const projectId = isList && statement.includes('r.project_id = $2') ? secondValue : undefined;
    const proxyKeyId =
      isList && statement.includes('r.proxy_key_id = $2')
        ? secondValue
        : isList && statement.includes('r.proxy_key_id = $3')
          ? thirdValue
          : undefined;
    const rows = this.state.requests.filter(
      (candidate) =>
        candidate.tenant_id === tenantId &&
        (projectId === undefined || candidate.project_id === projectId) &&
        (proxyKeyId === undefined || candidate.proxy_key_id === proxyKeyId),
    );
    if (isList) {
      return rows.map((row) => ({
        ...row,
        idempotency_key_digest:
          this.state.idempotency.find(
            (candidate) =>
              candidate.tenant_id === row.tenant_id && candidate.request_id === row.id && candidate.kind === 'active',
          )?.key_digest ?? null,
      }));
    }
    const row = rows.find((candidate) => candidate.id === secondValue);
    if (!row) return [];
    const idempotency = this.state.idempotency.find(
      (candidate) => candidate.tenant_id === tenantId && candidate.request_id === row.id && candidate.kind === 'active',
    );
    return [{ ...row, idempotency_key_digest: idempotency?.key_digest ?? null }];
  }
}

const fixedNow = () => new Date('2026-09-28T00:00:00.000Z');

function createService(database = new MemoryDatabase()): { service: SaasMeteringService; database: MemoryDatabase } {
  return { service: new SaasMeteringService(database, { now: fixedNow }), database };
}

function operationForProtocol(protocol: CreateRequestInput['protocol']): string {
  switch (protocol) {
    case 'anthropic':
      return 'messages';
    case 'openai':
      return 'chat.completions';
    case 'gemini':
      return 'generateContent';
    case 'responses':
      return 'responses';
  }
}

function requestInput(overrides: Partial<CreateRequestInput> = {}): CreateRequestInput {
  const value: CreateRequestInput = {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 3,
    modelScopeVersion: 4,
    supplyMode: 'byok',
    principalKind: 'member',
    principalId: 'member-a',
    authzVersion: 5,
    entitlementVersion: 6,
    configVersion: 7,
    projectPolicyVersion: 1,
    customerMeteringPolicyId: 'customer-policy-a',
    customerMeteringPolicyVersion: 1,
    providerMeteringPolicyId: 'provider-policy-a',
    providerMeteringPolicyVersion: 1,
    contractAttestationId: 'attestation-a',
    routeConfigId: 'route-a',
    routeConfigVersion: 7,
    routePublicModelId: 'route-public-model-a',
    routePublicModelVersion: 1,
    routeProtocol: 'openai',
    routeTargetMode: (overrides.supplyMode ?? 'byok') === 'byok' ? 'tenant_account' : 'platform_pool',
    routeUpstreamId: 'upstream-a',
    publicModel: 'public-model',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    requestFingerprint: 'canonical-request',
    requestFingerprintVersion: 'v1',
    ...overrides,
  };
  if (value.initialAttempt === undefined) return value;
  const attempt = value.initialAttempt;
  const attemptProtocol = attempt.protocol;
  const resolvedModel = attempt.resolvedModel;
  return {
    ...value,
    initialAttempt: {
      ...attempt,
      modelResolution:
        attempt.modelResolution ??
        ({
          requestedModel: value.publicModel,
          mappedModel: resolvedModel,
          resolvedModel,
          mappingSource: value.publicModel === resolvedModel ? 'none' : 'alias',
          mappingVersion: value.publicModel === resolvedModel ? null : 1,
        } as const),
      clientProtocol: attempt.clientProtocol ?? attemptProtocol,
      providerProtocol: attempt.providerProtocol ?? attemptProtocol,
      clientOperation: attempt.clientOperation ?? operationForProtocol(attemptProtocol),
      providerOperation: attempt.providerOperation ?? operationForProtocol(attemptProtocol),
      requestFingerprint: attempt.requestFingerprint ?? value.requestFingerprint,
      requestFingerprintVersion: attempt.requestFingerprintVersion ?? value.requestFingerprintVersion,
      payloadCompilerVersion: attempt.payloadCompilerVersion ?? 'compiler-v1',
      usageEstimatorVersion: attempt.usageEstimatorVersion ?? 'estimator-v1',
      payloadSha256: attempt.payloadSha256 ?? 'a'.repeat(64),
    },
  };
}

function preparedByokAttempt(): NonNullable<CreateRequestInput['initialAttempt']> {
  return {
    ordinal: 1,
    upstreamId: 'upstream-a',
    accountOwnerKind: 'tenant',
    accountId: 'account-a',
    providerId: 'provider-a',
    productId: 'product-a',
    resolvedModel: 'actual-a',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: 3,
    credentialId: 'credential-a',
    credentialVersion: 1,
    credentialAuthzVersion: 2,
    accountAuthzVersion: 1,
    projectPolicyVersion: 1,
    routeConfigId: 'route-a',
    routeConfigVersion: 7,
    routePublicModelId: 'route-public-model-a',
    routePublicModelVersion: 1,
    routeProtocol: 'openai',
    routeTargetMode: 'tenant_account',
    profileAccountAuthzVersion: 1,
  };
}

function usageInput(overrides: Partial<RecordUsageEventInput['usage']> = {}): RecordUsageEventInput['usage'] {
  return {
    inputTotal: '9223372036854775807',
    inputUncached: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: '9',
    reasoningOutput: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'usage-v1',
    measurementKind: 'snapshot',
    billableBasis: 'exact',
    ...overrides,
  };
}

function assertMeteringError(code: string, error: unknown): void {
  assert.ok(error instanceof SaasMeteringError);
  assert.equal(error.code, code);
}

test('prepared admission persists the caller-issued request and attempt IDs', async () => {
  const { service, database } = createService();
  const requestId = '11111111-1111-4111-8111-111111111111';
  const attemptId = '22222222-2222-4222-8222-222222222222';

  const admission = await service.admitPreparedRequest({
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId,
    attemptId,
  });

  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected prepared admission');
  assert.equal(admission.request.id, requestId);
  assert.equal(admission.initialAttempt.id, attemptId);
  assert.equal(database.dump().requests[0]?.id, requestId);
  assert.equal(database.dump().attempts[0]?.id, attemptId);
  const attemptRow = database.dump().attempts[0];
  assert.equal(attemptRow?.model_resolution_requested_model, 'public-model');
  assert.equal(attemptRow?.model_resolution_mapped_model, 'actual-a');
  assert.equal(attemptRow?.model_resolution_mapping_source, 'alias');
  assert.equal(attemptRow?.model_resolution_mapping_version, 1);
  assert.equal(attemptRow?.provider_protocol, 'openai');
  assert.equal(attemptRow?.client_operation, 'chat.completions');
  assert.equal(attemptRow?.provider_operation, 'chat.completions');
  assert.equal(attemptRow?.request_fingerprint_version, 'v1');
  assert.equal(attemptRow?.payload_compiler_version, 'compiler-v1');
  assert.equal(attemptRow?.usage_estimator_version, 'estimator-v1');
  assert.equal(attemptRow?.payload_sha256, 'a'.repeat(64));
  assert.notEqual(attemptRow?.request_fingerprint, attemptRow?.payload_sha256);
});

test('prepared admission rejects missing provenance and request-fingerprint tampering before persistence', async () => {
  const missing = createService();
  const missingInput = {
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId: '12121212-1212-4121-8121-121212121212',
    attemptId: '13131313-1313-4131-8131-131313131313',
  };
  (missingInput.initialAttempt as Record<string, unknown>).usageEstimatorVersion = undefined;
  await assert.rejects(missing.service.admitPreparedRequest(missingInput), (error: unknown) => {
    assertMeteringError('METERING_INVALID_INPUT', error);
    return true;
  });
  assert.equal(missing.database.dump().requests.length, 0);
  assert.equal(missing.database.dump().attempts.length, 0);

  const tampered = createService();
  const tamperedInput = {
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId: '14141414-1414-4141-8141-141414141414',
    attemptId: '15151515-1515-4151-8151-151515151515',
  };
  (tamperedInput.initialAttempt as Record<string, unknown>).requestFingerprint = 'f'.repeat(64);
  await assert.rejects(tampered.service.admitPreparedRequest(tamperedInput), (error: unknown) => {
    assertMeteringError('METERING_INVALID_INPUT', error);
    return true;
  });
  assert.equal(tampered.database.dump().requests.length, 0);
  assert.equal(tampered.database.dump().attempts.length, 0);
});

test('prepared admission replays identical fixed identities without duplicating metering rows', async () => {
  const { service, database } = createService();
  const input = {
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
  };

  const first = await service.admitPreparedRequest(input);
  const replay = await service.admitPreparedRequest(input);

  assert.equal(first.kind, 'created');
  assert.equal(replay.kind, 'replayed');
  if (replay.kind !== 'replayed' || !('initialAttempt' in replay) || !replay.initialAttempt) {
    throw new Error('expected prepared replay with its initial attempt');
  }
  assert.equal(replay.request.id, input.requestId);
  assert.equal(replay.initialAttempt.id, input.attemptId);
  assert.equal(replay.idempotency, null);
  const state = database.dump();
  assert.equal(state.requests.length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.idempotency.length, 0);

  const keyed = createService();
  const keyedInput = {
    ...requestInput({ initialAttempt: preparedByokAttempt(), idempotencyKey: 'prepared-key' }),
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  await keyed.service.admitPreparedRequest(keyedInput);
  const keyedReplay = await keyed.service.admitPreparedRequest(keyedInput);
  assert.equal(keyedReplay.kind, 'replayed');
  if (keyedReplay.kind !== 'replayed') throw new Error('expected keyed prepared replay');
  assert.equal(keyedReplay.idempotency?.requestId, keyedInput.requestId);
  assert.equal(keyed.database.dump().requests.length, 1);
  assert.equal(keyed.database.dump().attempts.length, 1);
  assert.equal(keyed.database.dump().idempotency.length, 1);
});

test('prepared admission rejects a fixed identity reused for different facts', async () => {
  const { service, database } = createService();
  const input = {
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId: '55555555-5555-4555-8555-555555555555',
    attemptId: '66666666-6666-4666-8666-666666666666',
  };
  await service.admitPreparedRequest(input);

  await assert.rejects(
    service.admitPreparedRequest({ ...input, requestFingerprint: 'different-request-fingerprint' }),
    (error: unknown) => {
      assertMeteringError('IDEMPOTENCY_CONFLICT', error);
      return true;
    },
  );
  await assert.rejects(
    service.admitPreparedRequest({
      ...input,
      attemptId: '77777777-7777-4777-8777-777777777777',
    }),
    (error: unknown) => {
      assertMeteringError('IDEMPOTENCY_CONFLICT', error);
      return true;
    },
  );
  await assert.rejects(
    service.admitPreparedRequest({
      ...input,
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
    (error: unknown) => {
      assertMeteringError('IDEMPOTENCY_CONFLICT', error);
      return true;
    },
  );

  const state = database.dump();
  assert.equal(state.requests.length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.requests[0]?.id, input.requestId);
  assert.equal(state.attempts[0]?.id, input.attemptId);
});

test('prepared admission rolls back metering rows when a downstream write fails in the outer transaction', async () => {
  const { service, database } = createService();
  const input = {
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId: '88888888-8888-4888-8888-888888888888',
    attemptId: '99999999-9999-4999-8999-999999999999',
  };

  await assert.rejects(
    database.transaction(async (tx) => {
      const admission = await service.admitPreparedRequest(input, { executor: tx });
      assert.equal(admission.kind, 'created');
      await tx.query('INSERT INTO fake_downstream_writes (request_id) VALUES ($1)', [input.requestId]);
    }),
    /injected downstream failure/,
  );

  assert.deepEqual(database.dump(), emptyState());
});

test('idempotency replays the same request, conflicts on fingerprint, and unkeyed requests stay distinct', async () => {
  const { service, database } = createService();
  const first = await service.admitRequest(
    requestInput({ idempotencyKey: 'client-secret-key', requestFingerprint: 'canonical-A' }),
  );
  assert.equal(first.kind, 'created');
  if (first.kind !== 'created' || !first.idempotency) throw new Error('expected a created keyed request');
  assert.equal(first.idempotency.keyDigest, sha256Hex('client-secret-key'));
  assert.notEqual(first.idempotency.keyDigest, 'client-secret-key');

  const replay = await service.admitRequest(
    requestInput({ idempotencyKey: 'client-secret-key', requestFingerprint: 'canonical-A' }),
  );
  assert.equal(replay.kind, 'replayed');
  if (replay.kind !== 'replayed') throw new Error('expected a replay');
  assert.equal(replay.request.id, first.request.id);

  await assert.rejects(
    service.admitRequest(requestInput({ idempotencyKey: 'client-secret-key', requestFingerprint: 'canonical-B' })),
    (error: unknown) => {
      assertMeteringError('IDEMPOTENCY_CONFLICT', error);
      return true;
    },
  );

  const unkeyedA = await service.admitRequest(requestInput({ idempotencyKey: null }));
  const unkeyedB = await service.admitRequest(requestInput({ idempotencyKey: null }));
  assert.equal(unkeyedA.kind, 'created');
  assert.equal(unkeyedB.kind, 'created');
  if (unkeyedA.kind !== 'created' || unkeyedB.kind !== 'created') throw new Error('expected unkeyed requests');
  assert.notEqual(unkeyedA.request.id, unkeyedB.request.id);
  const serialized = JSON.stringify(database.dump());
  assert.equal(serialized.includes('client-secret-key'), false);
  assert.equal(serialized.includes('canonical-A'), false);
});

test('tenant-scoped idempotency and reads cannot cross tenant boundaries', async () => {
  const { service } = createService();
  const tenantA = await service.admitRequest(requestInput({ idempotencyKey: 'same-key' }));
  const tenantB = await service.admitRequest(
    requestInput({ tenantId: 'tenant-b', projectId: 'project-b', proxyKeyId: 'key-b', idempotencyKey: 'same-key' }),
  );
  assert.equal(tenantA.kind, 'created');
  assert.equal(tenantB.kind, 'created');
  if (tenantA.kind !== 'created' || tenantB.kind !== 'created') throw new Error('expected independent requests');
  assert.notEqual(tenantA.request.id, tenantB.request.id);
  assert.equal(await service.getRequest('tenant-b', tenantA.request.id), null);
  assert.equal((await service.listRequests('tenant-b')).length, 1);
});

test('attempt dispatch and result transitions are conditioned, independent, and retain unknown results', async () => {
  const { service } = createService();
  const admission = await service.admitRequest(
    requestInput({
      initialAttempt: {
        ordinal: 1,
        upstreamId: 'upstream-a',
        accountOwnerKind: 'tenant',
        accountId: 'account-a',
        providerId: 'provider-a',
        productId: 'product-a',
        resolvedModel: 'actual-a',
        protocol: 'openai',
        endpoint: '/v1/chat/completions',
        dispatchProfileId: 'profile-a',
        supplyProfileAuthzVersion: 3,
        credentialId: 'credential-a',
        credentialVersion: 1,
        credentialAuthzVersion: 2,
        accountAuthzVersion: 1,
        projectPolicyVersion: 1,
        routeConfigId: 'route-a',
        routeConfigVersion: 7,
        routePublicModelId: 'route-public-model-a',
        routePublicModelVersion: 1,
        routeProtocol: 'openai',
        routeTargetMode: 'tenant_account',
        profileAccountAuthzVersion: 1,
      },
    }),
  );
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected initial attempt');
  const attempt = admission.initialAttempt;
  assert.equal(attempt.bindingState, 'bound');
  assert.equal(attempt.dispatchAuthorityState, 'bound');
  assert.equal(attempt.accountOwnerKind, 'tenant');
  assert.equal(attempt.accountId, 'account-a');
  assert.equal(attempt.providerId, 'provider-a');
  assert.equal(attempt.productId, 'product-a');
  assert.equal(attempt.resolvedModel, 'actual-a');
  assert.equal(attempt.endpoint, '/v1/chat/completions');
  assert.equal(attempt.dispatchProfileId, 'profile-a');
  assert.equal(attempt.supplyProfileAuthzVersion, '3');
  assert.equal(attempt.credentialId, 'credential-a');
  assert.equal(attempt.credentialVersion, '1');
  assert.equal(attempt.credentialAuthzVersion, '2');
  assert.equal(attempt.accountAuthzVersion, '1');
  assert.equal(attempt.profileAccountAuthzVersion, '1');
  assert.equal(attempt.poolId, null);
  assert.equal(attempt.customerPriceVersion, null);
  assert.equal(attempt.customerMeteringPolicyId, 'customer-policy-a');
  assert.equal(attempt.customerMeteringPolicyVersion, '1');
  assert.equal(attempt.providerMeteringPolicyId, 'provider-policy-a');
  assert.equal(attempt.providerMeteringPolicyVersion, '1');
  assert.equal(attempt.contractAttestationId, 'attestation-a');

  const dispatching = await service.transitionAttempt({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: attempt.id,
    expectedDispatchState: 'not_sent',
    expectedResultState: 'pending',
    expectedResponseStarted: false,
    dispatchState: 'dispatching',
  });
  assert.equal(dispatching.dispatchState, 'dispatching');
  assert.equal(dispatching.resultState, 'pending');

  await assert.rejects(
    service.transitionAttempt({
      tenantId: 'tenant-a',
      requestId: admission.request.id,
      attemptId: attempt.id,
      expectedDispatchState: 'not_sent',
      expectedResultState: 'pending',
      expectedResponseStarted: false,
      dispatchState: 'sent',
    }),
    (error: unknown) => {
      assertMeteringError('ATTEMPT_TRANSITION_INVALID', error);
      return true;
    },
  );

  const sent = await service.transitionAttempt({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: attempt.id,
    expectedDispatchState: 'dispatching',
    expectedResultState: 'pending',
    expectedResponseStarted: false,
    dispatchState: 'sent',
    responseStarted: true,
  });
  assert.equal(sent.dispatchState, 'sent');
  assert.equal(sent.resultState, 'pending');
  assert.equal(sent.responseStarted, true);

  const unknown = await service.transitionAttempt({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: attempt.id,
    expectedDispatchState: 'sent',
    expectedResultState: 'pending',
    expectedResponseStarted: true,
    dispatchState: 'unknown',
    resultState: 'unknown',
    unknownReason: 'connection lost after request write',
  });
  assert.equal(unknown.dispatchState, 'unknown');
  assert.equal(unknown.resultState, 'unknown');
  assert.equal(unknown.responseStarted, true);

  const retained = await service.getAttempt('tenant-a', admission.request.id, attempt.id);
  assert.equal(retained?.resultState, 'unknown');
  assert.notEqual(retained?.resultState, 'failed');
});

test('initial attempt binding matches request supply mode before persistence', async () => {
  const byok = createService();
  await assert.rejects(
    byok.service.admitRequest(
      requestInput({
        initialAttempt: {
          ordinal: 1,
          upstreamId: 'upstream-a',
          accountOwnerKind: 'platform',
          accountId: 'platform-account-a',
          providerId: 'provider-a',
          productId: 'product-a',
          resolvedModel: 'actual-a',
          protocol: 'openai',
          endpoint: '/v1/chat/completions',
          dispatchProfileId: 'profile-a',
          supplyProfileAuthzVersion: 3,
          credentialId: 'credential-platform-a',
          credentialVersion: 1,
          credentialAuthzVersion: 2,
          accountAuthzVersion: 1,
          projectPolicyVersion: 1,
          routeConfigId: 'route-a',
          routeConfigVersion: 7,
          routePublicModelId: 'route-public-model-a',
          routePublicModelVersion: 1,
          routeProtocol: 'openai',
          routeTargetMode: 'platform_pool',
          poolId: 'pool-a',
          poolAuthzVersion: 1,
          poolMemberAccountAuthzVersion: 1,
          poolMemberAuthzVersion: 1,
          poolGrantAuthzVersion: 1,
          poolGrantProfileAuthzVersion: 3,
          poolGrantPoolAuthzVersion: 1,
        },
      }),
    ),
    (error: unknown) => {
      assertMeteringError('METERING_INVALID_INPUT', error);
      return true;
    },
  );
  assert.deepEqual(byok.database.dump(), emptyState());

  const validPlatform = createService();
  const validPlatformAdmission = await validPlatform.service.admitRequest(
    requestInput({
      supplyMode: 'platform',
      customerPriceVersion: 'price-v1',
      initialAttempt: {
        ordinal: 1,
        upstreamId: 'upstream-a',
        accountOwnerKind: 'platform',
        accountId: 'platform-account-a',
        providerId: 'provider-a',
        productId: 'product-a',
        resolvedModel: 'actual-a',
        protocol: 'openai',
        endpoint: '/v1/chat/completions',
        supplierCostVersion: 'supplier-v1',
        dispatchProfileId: 'profile-a',
        supplyProfileAuthzVersion: 3,
        credentialId: 'credential-platform-a',
        credentialVersion: 1,
        credentialAuthzVersion: 2,
        accountAuthzVersion: 1,
        projectPolicyVersion: 1,
        routeConfigId: 'route-a',
        routeConfigVersion: 7,
        routePublicModelId: 'route-public-model-a',
        routePublicModelVersion: 1,
        routeProtocol: 'openai',
        routeTargetMode: 'platform_pool',
        poolId: 'pool-a',
        poolAuthzVersion: 1,
        poolMemberAccountAuthzVersion: 1,
        poolMemberAuthzVersion: 1,
        poolGrantAuthzVersion: 1,
        poolGrantProfileAuthzVersion: 3,
        poolGrantPoolAuthzVersion: 1,
      },
    }),
  );
  assert.equal(validPlatformAdmission.kind, 'created');
  if (validPlatformAdmission.kind !== 'created' || !validPlatformAdmission.initialAttempt) {
    throw new Error('expected a valid platform attempt');
  }
  assert.equal(validPlatformAdmission.initialAttempt.dispatchAuthorityState, 'bound');
  assert.equal(validPlatformAdmission.initialAttempt.poolId, 'pool-a');
  assert.equal(validPlatformAdmission.initialAttempt.poolMemberAuthzVersion, '1');
  assert.equal(validPlatformAdmission.initialAttempt.poolGrantAuthzVersion, '1');
  assert.equal(validPlatformAdmission.initialAttempt.profileAccountAuthzVersion, null);

  const platform = createService();
  await assert.rejects(
    platform.service.admitRequest(
      requestInput({
        supplyMode: 'platform',
        customerPriceVersion: 'price-v1',
        initialAttempt: {
          ordinal: 1,
          upstreamId: 'upstream-a',
          accountOwnerKind: 'platform',
          accountId: 'platform-account-a',
          providerId: 'provider-a',
          productId: 'product-a',
          resolvedModel: 'actual-a',
          protocol: 'openai',
          endpoint: '/v1/chat/completions',
          supplierCostVersion: null,
          dispatchProfileId: 'profile-a',
          supplyProfileAuthzVersion: 3,
          credentialId: 'credential-platform-a',
          credentialVersion: 1,
          credentialAuthzVersion: 2,
          accountAuthzVersion: 1,
          projectPolicyVersion: 1,
          routeConfigId: 'route-a',
          routeConfigVersion: 7,
          routePublicModelId: 'route-public-model-a',
          routePublicModelVersion: 1,
          routeProtocol: 'openai',
          routeTargetMode: 'platform_pool',
          poolId: 'pool-a',
          poolAuthzVersion: 1,
          poolMemberAccountAuthzVersion: 1,
          poolMemberAuthzVersion: 1,
          poolGrantAuthzVersion: 1,
          poolGrantProfileAuthzVersion: 3,
          poolGrantPoolAuthzVersion: 1,
        },
      }),
    ),
    (error: unknown) => {
      assertMeteringError('METERING_INVALID_INPUT', error);
      return true;
    },
  );
  assert.deepEqual(platform.database.dump(), emptyState());
});

test('logical request execution and financial statuses are separate', async () => {
  const { service } = createService();
  const admission = await service.admitRequest(
    requestInput({ supplyMode: 'platform', customerPriceVersion: 'price-v1' }),
  );
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created') throw new Error('expected request');
  assert.equal(admission.request.resultState, 'pending');
  assert.equal(admission.request.financialStatus, 'pending');

  const unknown = await service.transitionRequest({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    expectedResultState: 'pending',
    expectedReconciliationState: 'none',
    resultState: 'unknown',
    reconciliationState: 'pending',
  });
  assert.equal(unknown.resultState, 'unknown');
  assert.equal(unknown.financialStatus, 'pending');

  const financial = await service.transitionFinancialStatus({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    expectedFinancialStatus: 'pending',
    financialStatus: 'reconciliation_pending',
  });
  assert.equal(financial.resultState, 'unknown');
  assert.equal(financial.financialStatus, 'reconciliation_pending');
});

test('normal success follows the real none to pending to resolved reconciliation guards', async () => {
  const { service } = createService();
  const admission = await service.admitRequest(requestInput({ initialAttempt: preparedByokAttempt() }));
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created') throw new Error('expected request');

  await assert.rejects(
    service.transitionRequest({
      tenantId: 'tenant-a',
      requestId: admission.request.id,
      expectedResultState: 'pending',
      expectedReconciliationState: 'none',
      resultState: 'succeeded',
      reconciliationState: 'resolved',
    }),
    (error: unknown) => {
      assertMeteringError('REQUEST_TRANSITION_INVALID', error);
      return true;
    },
  );

  const reconciliationStarted = await service.transitionRequest({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    expectedResultState: 'pending',
    expectedReconciliationState: 'none',
    resultState: 'pending',
    reconciliationState: 'pending',
  });
  const succeeded = await service.transitionRequest({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    expectedResultState: 'pending',
    expectedReconciliationState: 'pending',
    expectedStateVersion: reconciliationStarted.stateVersion,
    resultState: 'succeeded',
    reconciliationState: 'resolved',
  });

  assert.equal(succeeded.resultState, 'succeeded');
  assert.equal(succeeded.reconciliationState, 'resolved');
  assert.equal(succeeded.financialStatus, 'not_applicable');
});

test('complete BYOK non-2xx response is failed idempotently without wallet calls', async () => {
  const { service, database } = createService();
  const admission = await service.admitRequest(requestInput({ initialAttempt: preparedByokAttempt() }));
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected attempt');
  await service.transitionAttempt({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: admission.initialAttempt.id,
    expectedDispatchState: 'not_sent',
    expectedResultState: 'pending',
    expectedResponseStarted: false,
    dispatchState: 'dispatching',
  });

  const input = {
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: admission.initialAttempt.id,
    resultHttpStatus: 401,
    responseStarted: false,
  } as const;
  const failed = await service.recordKnownNonSuccessHttpResponse(input);
  const replay = await service.recordKnownNonSuccessHttpResponse(input);
  const state = database.dump();

  assert.equal(failed.dispatchState, 'sent');
  assert.equal(failed.resultState, 'failed');
  assert.equal(failed.responseStarted, true);
  assert.equal(failed.resultHttpStatus, 401);
  assert.equal(replay.stateVersion, failed.stateVersion);
  assert.equal(state.requests[0]?.execution_state, 'failed');
  assert.equal(state.requests[0]?.reconciliation_state, 'none');
  assert.equal(state.requests[0]?.financial_status, 'not_applicable');
  assert.equal(state.attempts[0]?.response_started, true);
});

test('complete platform non-2xx response fails execution and retains finance and hold reconciliation', async () => {
  const database = new MemoryDatabase();
  const { profileAccountAuthzVersion: byokMappingVersion, ...platformAttemptBase } = preparedByokAttempt();
  assert.equal(byokMappingVersion, 1);
  const billingCalls: Array<{ executor: SqlExecutor; evidenceRef: string | undefined }> = [];
  const service = new SaasMeteringService(database, {
    now: fixedNow,
    knownResponseBilling: {
      async markReconciliationPending(executor, input) {
        billingCalls.push({ executor, evidenceRef: input.evidenceRef });
        return { state: 'reconciliation_pending' } as never;
      },
    },
  });
  const admission = await service.admitRequest(
    requestInput({
      supplyMode: 'platform',
      customerPriceVersion: 'price-v1',
      initialAttempt: {
        ...platformAttemptBase,
        accountOwnerKind: 'platform',
        supplierCostVersion: 'supplier-v1',
        routeTargetMode: 'platform_pool',
        poolId: 'pool-a',
        poolAuthzVersion: 1,
        poolMemberAccountAuthzVersion: 1,
        poolMemberAuthzVersion: 1,
        poolGrantAuthzVersion: 1,
        poolGrantProfileAuthzVersion: 3,
        poolGrantPoolAuthzVersion: 1,
      },
    }),
  );
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected attempt');
  await service.transitionAttempt({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: admission.initialAttempt.id,
    expectedDispatchState: 'not_sent',
    expectedResultState: 'pending',
    expectedResponseStarted: false,
    dispatchState: 'dispatching',
  });

  await service.recordKnownNonSuccessHttpResponse({
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: admission.initialAttempt.id,
    resultHttpStatus: 503,
    responseStarted: false,
  });
  const state = database.dump();

  assert.equal(state.attempts[0]?.result_state, 'failed');
  assert.equal(state.attempts[0]?.result_http_status, 503);
  assert.equal(state.attempts[0]?.response_started, true);
  assert.equal(state.attempts[0]?.profile_account_authz_version, null);
  assert.equal(state.requests[0]?.execution_state, 'failed');
  assert.equal(state.requests[0]?.financial_status, 'reconciliation_pending');
  assert.equal(billingCalls.length, 1);
  assert.equal(billingCalls[0]?.evidenceRef, `gateway-http-non-success:${admission.initialAttempt.id}:503`);
});

test('usage preserves exact integers, compares canonical duplicates, and deduplicates settlement effects', async () => {
  const { service, database } = createService();
  const admission = await service.admitRequest(
    requestInput({
      initialAttempt: {
        ordinal: 1,
        upstreamId: 'upstream-a',
        accountOwnerKind: 'tenant',
        accountId: 'account-a',
        providerId: 'provider-a',
        productId: 'product-a',
        resolvedModel: 'actual-a',
        protocol: 'openai',
        endpoint: '/v1/chat/completions',
        dispatchProfileId: 'profile-a',
        supplyProfileAuthzVersion: 3,
        credentialId: 'credential-a',
        credentialVersion: 1,
        credentialAuthzVersion: 2,
        accountAuthzVersion: 1,
        projectPolicyVersion: 1,
        routeConfigId: 'route-a',
        routeConfigVersion: 7,
        routePublicModelId: 'route-public-model-a',
        routePublicModelVersion: 1,
        routeProtocol: 'openai',
        routeTargetMode: 'tenant_account',
        profileAccountAuthzVersion: 1,
      },
    }),
  );
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected initial attempt');
  const input = {
    tenantId: 'tenant-a',
    requestId: admission.request.id,
    attemptId: admission.initialAttempt.id,
    supplyMode: 'byok' as const,
    eventKey: 'provider-event-1',
    usage: usageInput(),
  };
  const first = await service.recordUsageEvent(input);
  assert.equal(first.inputTotal, '9223372036854775807');
  assert.equal(first.measurementKind, 'snapshot');
  assert.equal(first.billableBasis, 'exact');
  const duplicate = await service.recordUsageEvent(input);
  assert.equal(duplicate.id, first.id);

  await assert.rejects(
    service.recordUsageEvent({ ...input, usage: usageInput({ outputTotal: '10' }) }),
    (error: unknown) => {
      assertMeteringError('USAGE_DUPLICATE_CONFLICT', error);
      return true;
    },
  );

  const settlement = await service.createUsageSettlement({
    tenantId: 'tenant-a',
    usageEventId: first.id,
    settlementKey: 'settlement-1',
    normalSuccessEvidenceRef: 'e'.repeat(64),
  });
  const settlementReplay = await service.createUsageSettlement({
    tenantId: 'tenant-a',
    usageEventId: first.id,
    settlementKey: 'settlement-1',
    normalSuccessEvidenceRef: 'e'.repeat(64),
  });
  assert.equal(settlementReplay.id, settlement.id);

  const beforeReplay = database.dump();
  await database.transaction((executor) => service.assertUsageSettlementReplay(
    { ...input, settlementKey: 'settlement-1', usageEvidenceRef: 'e'.repeat(64) }, { executor },
  ));
  for (const changed of [
    { ...input, eventKey: 'new-provider-event', settlementKey: 'new-settlement' },
    { ...input, settlementKey: 'new-settlement' },
    { ...input, settlementKey: 'settlement-1', usage: usageInput({ outputTotal: '10' }) },
  ]) {
    await assert.rejects(database.transaction((executor) => service.assertUsageSettlementReplay(
      { ...changed, usageEvidenceRef: 'e'.repeat(64) }, { executor },
    )));
  }
  assert.deepEqual(database.dump(), beforeReplay, 'read-only replay must preserve the actual unit writer facts');

  await assert.rejects(
    service.createUsageSettlement({ tenantId: 'tenant-a', usageEventId: first.id, settlementKey: 'settlement-2' }),
    (error: unknown) => {
      assertMeteringError('USAGE_SETTLEMENT_CONFLICT', error);
      return true;
    },
  );
});

test('read-only usage replay uses the same private HMAC as the actual unit writers', async () => {
  const database = new MemoryDatabase();
  const syntheticSecret = new Uint8Array([7, 3, 1, 9, 2, 6]);
  const service = new SaasMeteringService(database, { now: fixedNow, idempotencyHmacSecret: syntheticSecret });
  const admission = await service.admitPreparedRequest({
    ...requestInput({ initialAttempt: preparedByokAttempt() }),
    requestId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected prepared admission');
  const original: RecordUsageEventInput & { eventKey: string; settlementKey: string; usageEvidenceRef: string } = {
    tenantId: 'tenant-a', requestId: admission.request.id, attemptId: admission.initialAttempt.id,
    supplyMode: 'byok', eventKey: 'synthetic-provider-event', settlementKey: 'synthetic-settlement', usage: usageInput(),
    usageEvidenceRef: 'e'.repeat(64),
  };
  const event = await service.recordUsageEvent(original);
  await service.createUsageSettlement({
    tenantId: original.tenantId, usageEventId: event.id, settlementKey: original.settlementKey,
    normalSuccessEvidenceRef: original.usageEvidenceRef,
  });
  const before = database.dump();
  await database.transaction((executor) => service.assertUsageSettlementReplay(original, { executor }));
  const wrongHmacService = new SaasMeteringService(database, { now: fixedNow, idempotencyHmacSecret: 'different-synthetic-key' });
  await assert.rejects(database.transaction((executor) => wrongHmacService.assertUsageSettlementReplay(original, { executor })));
  await assert.rejects(database.transaction((executor) => service.assertUsageSettlementReplay({
    ...original, eventKey: 'another-event', settlementKey: 'another-settlement',
  }, { executor })));
  assert.deepEqual(database.dump(), before);
});

test('normal-success writer persists bound ref, preserves idempotency and rejects downgrade or upgrade', async () => {
  const { service, database } = createService();
  const admission = await service.admitRequest(requestInput({ initialAttempt: preparedByokAttempt() }));
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected prepared attempt');
  const usageInputValue = { tenantId: 'tenant-a', requestId: admission.request.id,
    attemptId: admission.initialAttempt.id, supplyMode: 'byok' as const, eventKey: 'bound-event', usage: usageInput() };
  const event = await service.recordUsageEvent(usageInputValue);
  const boundInput = { tenantId: 'tenant-a', usageEventId: event.id, settlementKey: 'bound-key',
    normalSuccessEvidenceRef: 'e'.repeat(64) };
  const first = await service.createUsageSettlement(boundInput);
  assert.equal(first.normalSuccessEvidenceRef, boundInput.normalSuccessEvidenceRef);
  assert.equal((await service.createUsageSettlement(boundInput)).id, first.id);
  const before = database.dump();
  for (const changed of [
    { normalSuccessEvidenceRef: undefined }, { normalSuccessEvidenceRef: 'f'.repeat(64) },
    { settlementKey: 'other-key' }, { settlementKind: 'platform_cost_observed' as const },
  ]) await assert.rejects(service.createUsageSettlement({ ...boundInput, ...changed }));
  assert.deepEqual(database.dump(), before);

  const legacyEvent = await service.recordUsageEvent({ ...usageInputValue, eventKey: 'legacy-event' });
  const legacyInput = { tenantId: 'tenant-a', usageEventId: legacyEvent.id, settlementKey: 'legacy-key' };
  const legacy = await service.createUsageSettlement(legacyInput);
  assert.equal(legacy.normalSuccessEvidenceRef, null, 'non-normal writer remains legacy by default');
  const beforeUpgrade = database.dump();
  await assert.rejects(service.createUsageSettlement({ ...legacyInput, normalSuccessEvidenceRef: 'e'.repeat(64) }));
  await assert.rejects(service.assertUsageSettlementReplay({ ...usageInputValue, eventKey: 'legacy-event',
    settlementKey: 'legacy-key', usageEvidenceRef: 'e'.repeat(64) }));
  assert.deepEqual(database.dump(), beforeUpgrade, 'legacy history must not be rewritten or backfilled');
});

test('never-dispatched failure is terminal and still requires the original version/CAS', async () => {
  const { service, database } = createService();
  const admission = await service.admitRequest(requestInput({ initialAttempt: preparedByokAttempt() }));
  assert.equal(admission.kind, 'created');
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected initial attempt');
  const original = admission.initialAttempt;
  const transition = { tenantId: 'tenant-a', requestId: admission.request.id, attemptId: original.id,
    expectedDispatchState: 'not_sent' as const, expectedResultState: 'pending' as const,
    expectedResponseStarted: false, expectedStateVersion: original.stateVersion,
    dispatchState: 'not_sent' as const, resultState: 'failed' as const, responseStarted: false };
  const before = database.dump();
  await assert.rejects(service.transitionAttempt({ ...transition, expectedStateVersion: original.stateVersion + 1 }));
  for (const changed of [
    { resultState: 'succeeded' as const }, { resultState: 'unknown' as const, unknownReason: 'synthetic' },
    { responseStarted: true },
  ]) await assert.rejects(service.transitionAttempt({ ...transition, ...changed }));
  assert.deepEqual(database.dump(), before);
  const failed = await service.transitionAttempt(transition);
  assert.equal(failed.dispatchState, 'not_sent');
  assert.equal(failed.resultState, 'failed');
  assert.equal(failed.responseStarted, false);
  assert.equal(failed.responseStartedAt, null);
  assert.equal(failed.stateVersion, original.stateVersion + 1);
  const terminal = database.dump();
  await assert.rejects(service.transitionAttempt(transition), (error: unknown) => {
    assertMeteringError('ATTEMPT_TRANSITION_INVALID', error); return true;
  });
  for (const changed of [
    { dispatchState: 'dispatching' as const }, { resultState: 'pending' as const }, { responseStarted: true },
  ]) await assert.rejects(service.transitionAttempt({ ...transition, expectedResultState: 'failed',
    expectedStateVersion: failed.stateVersion, ...changed }));
  assert.deepEqual(database.dump(), terminal, 'failure may not be redispatched or have its response flag fabricated');
});

test('pre-dispatch failure exception cannot move dispatching work to a never-sent terminal', async () => {
  const { service, database } = createService();
  const admission = await service.admitRequest(requestInput({ initialAttempt: preparedByokAttempt() }));
  if (admission.kind !== 'created' || !admission.initialAttempt) throw new Error('expected initial attempt');
  const identity = { tenantId: 'tenant-a', requestId: admission.request.id, attemptId: admission.initialAttempt.id };
  const dispatching = await service.transitionAttempt({ ...identity, expectedDispatchState: 'not_sent',
    expectedResultState: 'pending', expectedResponseStarted: false, dispatchState: 'dispatching' });
  const before = database.dump();
  await assert.rejects(service.transitionAttempt({ ...identity, expectedDispatchState: 'dispatching',
    expectedResultState: 'pending', expectedResponseStarted: false, expectedStateVersion: dispatching.stateVersion,
    dispatchState: 'not_sent', resultState: 'failed', responseStarted: false }));
  assert.deepEqual(database.dump(), before);
});

test('migration is version 10, additive, unregistered, and keeps reconciliation delivery out of this module', () => {
  assert.equal(GATEWAY_METERING_SAAS_MIGRATION.version, 10);
  assert.equal(GATEWAY_METERING_SAAS_MIGRATION.name, 'gateway_request_attempt_usage_idempotency_metering');
  assert.match(GATEWAY_METERING_SAAS_MIGRATION.sql, /UNIQUE \(tenant_id, project_id, id\)/);
  assert.match(GATEWAY_METERING_SAAS_MIGRATION.sql, /request_fingerprint_version/);
  assert.match(GATEWAY_METERING_SAAS_MIGRATION.sql, /measurement_kind/);
  assert.match(GATEWAY_METERING_SAAS_MIGRATION.sql, /billable_basis/);
  assert.match(GATEWAY_METERING_SAAS_MIGRATION.sql, /saas_metering_guard_attempt_update/);
  assert.doesNotMatch(GATEWAY_METERING_SAAS_MIGRATION.sql, /request_body|response_body|raw_api_key/i);
  assert.doesNotMatch(GATEWAY_METERING_SAAS_MIGRATION.sql, /REFERENCES saas_(?:project_entitlements|supply_profiles)/);
});

test('new metering admission requires an exact route authority snapshot and never synthesizes one', async () => {
  const { service, database } = createService();

  await assert.rejects(service.admitRequest(requestInput({ routeConfigId: null })), (error: unknown) => {
    assertMeteringError('METERING_INVALID_INPUT', error);
    return true;
  });
  await assert.rejects(service.admitRequest(requestInput({ configVersion: 8 })), (error: unknown) => {
    assertMeteringError('METERING_INVALID_INPUT', error);
    return true;
  });
  assert.deepEqual(database.dump(), emptyState());
});
